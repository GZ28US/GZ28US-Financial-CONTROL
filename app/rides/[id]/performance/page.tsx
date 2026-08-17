'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { packTargetBhp, isBaselineName, BASE_PATH } from '@/lib/utils'

// BUILDS — every ride's performance data is grouped into builds (Build.01, Build.02…),
// and a build IS a pack: it carries the pack name ("Z1250sc Alpha170 Pack"), which states
// the power goal. This page lists them as rows; each opens the full performance page
// (BUILD SHEET / DYNO) scoped to that build in the shared bank, keyed by ride_code + build_no.
type Build = { id: string; build_no: number; created_at: string; name?: string | null }
const buildLabel = (n: number) => `Build.${String(n).padStart(2, '0')}`
// "BoneStock" e "Stock" NÃO são packs — são a linha de base do carro (Stock = a base
// DESTE carro; nunca é oferecida aos outros). Linha roxa (padrão dos duties permanentes),
// fixada SEMPRE no topo, sem o selo Build.0X — e SEMPRE Build.01 (o addBuild/saveEdit
// renumeram o resto quando preciso).
const isBoneStockBuild = (b: { name?: string | null }) => isBaselineName(b.name)

export default function RideBuildsPage() {
  const params = useParams()
  const rideId = String(params.id)
  const [ride, setRide] = useState<{ project_code: string | null; project_name: string | null } | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  // O que existe pendurado em cada build (chaveado por build_no) — mostrado na linha e
  // repetido no aviso de exclusão, porque apagar um pack apaga tudo dele junto.
  const [pullsByBuild, setPullsByBuild] = useState<Record<number, number>>({})
  const [sheetByBuild, setSheetByBuild] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  // Rename inline (padrão das telas novas): o EDIT troca a linha por um input + SAVE/CANCEL.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('rides').select('project_code, project_name').eq('id', rideId).single().then(({ data }) => setRide(data))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (ride) void load() }, [ride]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const code = ride?.project_code || ''
    const [{ data }, { data: pulls }, { data: sheets }] = await Promise.all([
      supabase.from('ride_builds').select('*').eq('ride_code', code).order('build_no'),
      supabase.from('dyno_pulls').select('build_no').eq('ride_code', code),
      supabase.from('ride_build_sheets').select('build_no').eq('ride_code', code),
    ])
    // BoneStock fixado no topo, sempre; o resto segue por build_no (a query já ordena).
    const rows = (data || []) as Build[]
    rows.sort((a, b) => (isBoneStockBuild(b) ? 1 : 0) - (isBoneStockBuild(a) ? 1 : 0))
    setBuilds(rows)
    // Conta pelo build_no EXATO — a mesma chave que o delete usa. Linha sem build_no não
    // é contada em build nenhum: seria contada aqui e NÃO apagada lá, virando órfã calada.
    // (Hoje não existe nenhuma assim; a regra é pra continuar assim.)
    const pc: Record<number, number> = {}
    for (const p of (pulls || []) as { build_no: number | null }[]) {
      if (p.build_no == null) continue
      pc[p.build_no] = (pc[p.build_no] || 0) + 1
    }
    setPullsByBuild(pc)
    const sc: Record<number, boolean> = {}
    for (const s of (sheets || []) as { build_no: number | null }[]) if (s.build_no != null) sc[s.build_no] = true
    setSheetByBuild(sc)
    setLoading(false)
  }

  // Muda o build_no de UM build nas três tabelas que o usam como chave — a ordem de quem
  // chama garante que nunca há colisão no meio do caminho.
  async function shiftBuildNo(code: string, from: number, to: number) {
    for (const t of ['ride_builds', 'dyno_pulls', 'ride_build_sheets'] as const) {
      const { error } = await supabase.from(t).update({ build_no: to }).eq('ride_code', code).eq('build_no', from)
      if (error) throw new Error(`${t}: ${error.message}`)
    }
  }

  // BASELINE É SEMPRE Build.01 (ordem do usuário, 17/ago/2026): abre espaço empurrando os
  // builds existentes uma casa pra cima, do maior pro menor (sem colisão), até `upTo`.
  async function makeRoomForBuild1(code: string, upTo: number) {
    const nums = builds.map((b) => b.build_no).filter((n) => n < upTo).sort((a, b) => b - a)
    for (const n of nums) await shiftBuildNo(code, n, n + 1)
  }

  async function addBuild() {
    if (!ride?.project_code) return
    setAdding(true)
    try {
      const next = builds.length ? Math.max(...builds.map((b) => b.build_no)) + 1 : 1
      const buildName = (prompt(`Pack name for ${buildLabel(next)} (e.g. Z1250sc Alpha170 Pack):`) || '').trim()
      // Baseline (BoneStock/Stock): só UMA por carro, e nasce como Build.01 — os outros
      // builds sobem uma casa (junto com as puxadas e build sheets deles).
      let insertNo = next
      if (isBaselineName(buildName)) {
        if (builds.some((b) => isBaselineName(b.name))) { alert('This car already has a baseline build (BoneStock/Stock). There can be only one.'); return }
        try { await makeRoomForBuild1(ride.project_code, next) } catch (e) { alert('Renumbering failed: ' + String(e)); await load(); return }
        insertNo = 1
      }
      const { error } = await supabase.from('ride_builds').insert([{ ride_code: ride.project_code, build_no: insertNo, name: buildName || null }])
      if (error) { alert(error.message); return }
      await load()
    } finally {
      setAdding(false)
    }
  }

  function startEdit(b: Build) { setEditingId(b.id); setEditName(b.name || '') }
  function cancelEdit() { setEditingId(null); setEditName('') }

  // O BuildSheet PDF no Dropbox carrega o NOME DO PACK — então renomear o pack renomeia o
  // arquivo junto. Tenta primeiro o arquivo com o nome antigo do pack; se não existir,
  // tenta o formato legado Build.NN (arquivos de antes da mudança de nomenclatura).
  // Não-fatal: sem arquivo (sheet nunca gerada) não é erro.
  async function renameSheetFile(b: Build, oldName: string, newName: string) {
    if (!ride?.project_code) return
    const fileTag = (s: string) => s.replace(/[\\/:*?"<>|]/g, '')
    const base = `${ride.project_code}${ride.project_name ? ' - ' + ride.project_name : ''}`
    const to = `${base} ${fileTag(newName.trim() || buildLabel(b.build_no))} BuildSheet.pdf`
    const candidates = [
      ...(oldName.trim() ? [`${base} ${fileTag(oldName.trim())} BuildSheet.pdf`] : []),
      `${base} ${buildLabel(b.build_no)} BuildSheet.pdf`,
    ]
    for (const from of candidates) {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename-file', zone: 'US', code: ride.project_code, name: ride.project_name, from, to }),
        })
        const d = await res.json().catch(() => ({}))
        if (d.ok && (d.result === 'renamed' || d.result === 'same-name')) return
        if (d.result === 'conflict') { alert(`The Dropbox file "${to}" already exists — the old sheet was left as "${from}".`); return }
      } catch { /* não-fatal: o PDF re-sincroniza com o nome novo no próximo save da sheet */ }
    }
  }

  async function saveEdit(b: Build) {
    const newName = editName.trim()
    // Renomear PARA baseline: só uma por carro, e ela vira Build.01 — este build vai pra
    // primeira posição e os que estavam abaixo dele sobem uma casa (dados juntos).
    if (isBaselineName(newName) && builds.some((x) => x.id !== b.id && isBaselineName(x.name))) {
      alert('This car already has a baseline build (BoneStock/Stock). There can be only one.')
      return
    }
    setSavingEdit(true)
    try {
      const { error } = await supabase.from('ride_builds').update({ name: newName || null }).eq('id', b.id)
      if (error) { alert(error.message); return }
      // O arquivo no Dropbox acompanha o nome do pack — renomeou aqui, renomeia lá.
      if (newName !== (b.name || '').trim()) await renameSheetFile(b, b.name || '', newName)
      if (isBaselineName(newName) && b.build_no !== 1 && ride?.project_code) {
        const code = ride.project_code
        try {
          const TEMP = 9001 // fora do alcance de qualquer build real — evita colisão
          await shiftBuildNo(code, b.build_no, TEMP)
          await makeRoomForBuild1(code, b.build_no)
          await shiftBuildNo(code, TEMP, 1)
        } catch (e) { alert('Renumbering failed: ' + String(e)) }
      }
      cancelEdit()
      await load()
    } finally {
      setSavingEdit(false)
    }
  }

  // APAGAR O PACK APAGA TUDO DELE (ordem do usuário, 17/ago/2026): as puxadas de dinamômetro
  // e a build sheet daquele build vão junto — senão ficariam órfãs, presas a um build_no que
  // não existe mais e invisíveis no app. O aviso diz exatamente o que vai embora ANTES.
  async function removeBuild(b: Build) {
    const code = ride?.project_code || ''
    const pulls = pullsByBuild[b.build_no] || 0
    const sheet = sheetByBuild[b.build_no] ? 1 : 0
    const what = [pulls ? `${pulls} dyno pull(s)` : '', sheet ? 'the build sheet' : ''].filter(Boolean).join(' and ')
    const msg = what
      ? `DELETE ${buildLabel(b.build_no)} — ${b.name || 'Unnamed'}\n\nThis will ALSO delete ${what}.\nThis cannot be undone.\n\nDelete everything?`
      : `DELETE ${buildLabel(b.build_no)} — ${b.name || 'Unnamed'}\n\nIt has no dyno pulls and no build sheet.\n\nDelete?`
    if (!window.confirm(msg)) return
    setRemovingId(b.id)
    try {
      // Filhos primeiro: se algo falhar no meio, o build continua lá e nada fica órfão.
      const del = await Promise.all([
        supabase.from('dyno_pulls').delete().eq('ride_code', code).eq('build_no', b.build_no),
        supabase.from('ride_build_sheets').delete().eq('ride_code', code).eq('build_no', b.build_no),
      ])
      const bad = del.find(r => r.error)
      if (bad?.error) { alert(bad.error.message); return }
      const { error } = await supabase.from('ride_builds').delete().eq('id', b.id)
      if (error) { alert(error.message); return }
      await load()
    } finally {
      setRemovingId(null)
    }
  }

  const title = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">BUILDS</h1>
        <div className="flex gap-3">
          <Link href={`/rides/${rideId}`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <button onClick={addBuild} disabled={adding || !ride} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
            {adding ? 'ADDING…' : '+ ADD BUILD'}
          </button>
        </div>
      </div>
      {title && <p className="text-xl text-gray-400 mb-6">{title}</p>}

      {loading || !ride ? (
        <p className="text-xl text-gray-400">Loading…</p>
      ) : builds.length === 0 ? (
        <p className="text-xl text-gray-400">No builds yet — press ADD BUILD to start Build.01.</p>
      ) : (
        <div className="space-y-4">
          {builds.map((b) => {
            const target = packTargetBhp(b.name)
            const pulls = pullsByBuild[b.build_no] || 0
            const sheet = !!sheetByBuild[b.build_no]
            const bone = isBoneStockBuild(b)
            return (
              <div key={b.id} className={`rounded-3xl p-5 flex items-center justify-between gap-6 flex-wrap ${bone ? 'bg-purple-950/40 border-2 border-purple-600' : 'bg-gray-900 border border-gray-800'}`}>
                {editingId === b.id ? (
                  <>
                    <div className="flex-1 min-w-[16rem]">
                      <label className="block mb-1 text-xs text-gray-400 font-bold">PACK NAME</label>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(b); if (e.key === 'Escape') cancelEdit() }}
                        className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg w-full"
                        placeholder="e.g. Z1250sc Alpha170 Pack"
                        autoFocus
                      />
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <button onClick={() => saveEdit(b)} disabled={savingEdit} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-2xl font-bold text-sm">{savingEdit ? 'SAVING…' : 'SAVE'}</button>
                      <button onClick={cancelEdit} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-2xl font-bold text-sm">CANCEL</button>
                    </div>
                  </>
                ) : (
                  <>
                    <Link href={`/rides/${rideId}/performance/${b.build_no}`} className="flex-1 min-w-0 group">
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h2 className={`text-2xl font-bold group-hover:underline ${bone ? 'text-purple-300' : b.name ? '' : 'text-gray-600 italic'}`}>{b.name || 'Unnamed'}</h2>
                        {/* BoneStock não é build nem pack: sem selo Build.0X, com o selo
                            roxo de fixado (mesmo padrão do duty permanente do staff). */}
                        {bone
                          ? <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-900 text-purple-300">{(b.name || '').trim().toLowerCase() === 'stock' ? '📌 THIS CAR’S BASELINE' : '📌 FACTORY BASELINE'}</span>
                          : <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-200">🏁 {buildLabel(b.build_no)}</span>}
                        {/* A meta sai do próprio nome do pack (Z1250sc = 1250 bhp). */}
                        {target != null && <span className="px-3 py-1 rounded-full text-xs font-bold bg-fuchsia-900 text-fuchsia-200">🎯 {target} BHP</span>}
                      </div>
                      <p className="text-sm text-gray-400">
                        {new Date(b.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                        {' · '}{pulls > 0 ? `${pulls} dyno pull${pulls > 1 ? 's' : ''}` : 'no dyno pulls'}
                        {sheet ? ' · build sheet' : ''}
                      </p>
                    </Link>
                    <div className="flex items-center gap-3 shrink-0">
                      <button onClick={() => startEdit(b)} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</button>
                      <button onClick={() => removeBuild(b)} disabled={removingId === b.id} className="bg-red-700 hover:bg-red-600 disabled:opacity-50 px-4 py-2 rounded-2xl font-bold text-sm">{removingId === b.id ? 'REMOVING…' : 'REMOVE'}</button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
