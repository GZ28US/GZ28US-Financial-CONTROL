'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { packTargetBhp } from '@/lib/utils'

// BUILDS — every ride's performance data is grouped into builds (Build.01, Build.02…),
// and a build IS a pack: it carries the pack name ("Z1250sc Alpha170 Pack"), which states
// the power goal. This page lists them as rows; each opens the full performance page
// (BUILD SHEET / DYNO) scoped to that build in the shared bank, keyed by ride_code + build_no.
type Build = { id: string; build_no: number; created_at: string; name?: string | null }
const buildLabel = (n: number) => `Build.${String(n).padStart(2, '0')}`

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
    setBuilds((data || []) as Build[])
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

  async function addBuild() {
    if (!ride?.project_code) return
    setAdding(true)
    try {
      const next = builds.length ? Math.max(...builds.map((b) => b.build_no)) + 1 : 1
      const buildName = (prompt(`Pack name for ${buildLabel(next)} (e.g. Z1250sc Alpha170 Pack):`) || '').trim()
      const { error } = await supabase.from('ride_builds').insert([{ ride_code: ride.project_code, build_no: next, name: buildName || null }])
      if (error) { alert(error.message); return }
      await load()
    } finally {
      setAdding(false)
    }
  }

  function startEdit(b: Build) { setEditingId(b.id); setEditName(b.name || '') }
  function cancelEdit() { setEditingId(null); setEditName('') }

  async function saveEdit(b: Build) {
    setSavingEdit(true)
    const { error } = await supabase.from('ride_builds').update({ name: editName.trim() || null }).eq('id', b.id)
    setSavingEdit(false)
    if (error) { alert(error.message); return }
    cancelEdit()
    await load()
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
            return (
              <div key={b.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-center justify-between gap-6 flex-wrap">
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
                        <h2 className={`text-2xl font-bold group-hover:underline ${b.name ? '' : 'text-gray-600 italic'}`}>{b.name || 'Unnamed'}</h2>
                        <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-200">🏁 {buildLabel(b.build_no)}</span>
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
