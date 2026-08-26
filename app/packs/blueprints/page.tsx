'use client'

// BLUEPRINTS — CREW CHIEF P1 (26/ago/2026). A tela de curadoria do minerador.
// Resposta à dúvida do João (26/ago): o PACK **É** o blueprint — não existem
// duas bibliotecas. blueprint_candidates é só a MESA DE TRIAGEM das propostas
// mineradas das invoices reais, esperando aprovação humana. A atualização dos
// 38 packs que Márcio+João fazem agora JÁ É a alimentação, na forma mais
// direta (blueprint autoral); o minerador então cobre as lacunas: famílias sem
// pack e packs ainda sem duties (ENRIQUECER). Mineração 100% ao vivo e
// read-only — nada é gravado até um humano clicar ADOTAR.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import CcBadge from '@/components/CcBadge'
import { supabase } from '@/lib/supabase'
import { CC_CHANGELOG } from '@/lib/ccVersion'
import { dutyPriorityBadge, withDutyOrder, stripDutyOrder } from '@/lib/utils'
import { mineFamilies, normDuty, type FamilyDraft } from '@/lib/blueprintMine'

type BlockDuty = { description: string; priority: string; estimated_seconds: number | null }
type Candidate = { id: string; name: string; family: string | null; platform: string | null; status: string; blocks: any[]; source: any; promoted_pack_id: string | null }

const PRIORITIES = ['0', '1', '2', '3', '4', 'STANDBY']
const hFmt = (s: number | null) => s == null ? '—' : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
const hToSec = (h: string) => { const n = parseFloat(String(h).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 3600) : null }

async function all(table: string, select: string, mod?: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(select).range(from, from + 999)
    if (mod) q = mod(q)
    const { data, error } = await q
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < 1000) return out
  }
}

export default function BlueprintsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [noTables, setNoTables] = useState(false)
  const [busy, setBusy] = useState(false)
  const [raw, setRaw] = useState<any>(null)
  const [cands, setCands] = useState<Candidate[]>([])
  const [showDone, setShowDone] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [invoices, invParts, invServices, invDuties, dutyEvents, packs] = await Promise.all([
        all('invoices', 'id, invoice_code, status, ride_id'),
        all('invoice_parts', 'invoice_id, description, quantity, base_cost, kit_group, kit_name'),
        all('invoice_services', 'invoice_id, description'),
        all('invoice_duties', 'id, invoice_id, description, priority, done, time_seconds'),
        all('duty_events', 'duty_id, action, at'),
        all('packs', 'id, name, status, zone, platform, duties', q => q.eq('zone', 'US')),
      ])
      setRaw({ invoices, invParts, invServices, invDuties, dutyEvents, packs })
      const { data, error } = await supabase.from('blueprint_candidates').select('*').order('created_at', { ascending: false })
      if (error) setNoTables(true)
      else setCands((data || []) as Candidate[])
    } catch (e: any) { alert('Erro carregando: ' + e.message) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const mined: FamilyDraft[] = useMemo(() => raw ? mineFamilies(raw) : [], [raw])
  const codeOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of (raw?.invoices || [])) m.set(i.id, i.invoice_code || i.id.slice(0, 8))
    return m
  }, [raw])
  const vocabAll = useMemo(() => {
    const s = new Set<string>()
    for (const f of mined) for (const v of f.vocabulary) s.add(v.canonical)
    return [...s].sort()
  }, [mined])
  const emptyPacks = useMemo(() => (raw?.packs || []).filter((p: any) => !Array.isArray(p.duties) || p.duties.length === 0), [raw])

  const logEvent = (candidate_id: string | null, action: string, detail: any) =>
    supabase.from('blueprint_events').insert({ candidate_id, action, detail })

  // ADOTAR: espinha primária + backlog viram o bloco de duties do candidato;
  // estimativa pré-carregada da mediana do vocabulário (regra do stint já aplicada).
  const adopt = async (f: FamilyDraft) => {
    if (noTables) { alert('Rode MIGRATION_crew_chief_p1.sql no SQL Editor primeiro.'); return }
    setBusy(true)
    const medians = new Map(f.vocabulary.map(v => [normDuty(v.canonical), v.medianSeconds]))
    const duties: BlockDuty[] = [
      ...(f.primarySpine?.steps || []).map((s, i) => ({
        description: withDutyOrder(String(i + 1).padStart(2, '0'), stripDutyOrder(s.description)),
        priority: s.priority, estimated_seconds: medians.get(normDuty(s.description)) ?? null,
      })),
      ...(f.primarySpine?.backlog || []).map(s => ({
        description: stripDutyOrder(s.description).trim(),
        priority: s.priority, estimated_seconds: medians.get(normDuty(s.description)) ?? null,
      })),
    ]
    const blocks = [
      { kind: 'duties', name: 'ESPINHA', duties },
      ...f.kitBlocks.map(k => ({ kind: 'kit', name: k.kitName, members: k.members })),
      ...(f.services.length ? [{ kind: 'services', name: 'SERVIÇOS RECORRENTES', services: f.services }] : []),
    ]
    const source = {
      family: f.family, invoiceCodes: f.invoiceIds.map(id => codeOf.get(id)),
      exemplar: f.primarySpine ? codeOf.get(f.primarySpine.invoiceId) : null,
      minedAt: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('blueprint_candidates')
      .insert({ name: `${f.family} (minerado)`, family: f.family, platform: f.platform, blocks, source })
      .select('*').single()
    if (error) alert('Erro: ' + error.message)
    else { await logEvent(data.id, 'ADOPTED', { from: source }); setCands(p => [data as Candidate, ...p]) }
    setBusy(false)
  }

  const patchCand = (id: string, fn: (c: Candidate) => Candidate) => setCands(p => p.map(c => c.id === id ? fn(c) : c))
  const dutiesOf = (c: Candidate): BlockDuty[] => (c.blocks.find((b: any) => b.kind === 'duties')?.duties || [])
  const setDuties = (c: Candidate, duties: BlockDuty[]) =>
    patchCand(c.id, x => ({ ...x, blocks: x.blocks.some((b: any) => b.kind === 'duties') ? x.blocks.map((b: any) => b.kind === 'duties' ? { ...b, duties } : b) : [{ kind: 'duties', name: 'ESPINHA', duties }, ...x.blocks] }))

  const saveCand = async (c: Candidate) => {
    setBusy(true)
    const { error } = await supabase.from('blueprint_candidates').update({ name: c.name, platform: c.platform, blocks: c.blocks, updated_at: new Date().toISOString() }).eq('id', c.id)
    if (error) alert('Erro: ' + error.message); else await logEvent(c.id, 'CURATED', { duties: dutiesOf(c).length })
    setBusy(false)
  }

  // PROMOVER → PACK NOVO: nasce DRAFT · zone US, na forma exata do editor do
  // Márcio; preços ficam pro humano no editor (unit_price 0, base_cost minerado).
  const promoteNew = async (c: Candidate) => {
    if (!confirm(`Criar PACK DRAFT "${c.name}" com ${dutiesOf(c).length} duties?`)) return
    setBusy(true)
    const parts = c.blocks.filter((b: any) => b.kind === 'kit').flatMap((b: any) => {
      const kg = crypto.randomUUID()
      return (b.members || []).map((m: any) => ({ description: m.description, unit_price: 0, quantity: m.quantity || 1, base_cost: m.cost ?? null, kit_group: kg, kit_name: b.name, source_item: null }))
    })
    const { data, error } = await supabase.from('packs').insert({
      name: c.name, cars: [], status: 'DRAFT', zone: 'US', platform: c.platform,
      import_margin: 0, parts, services: [], expenses: [], duties: dutiesOf(c),
    }).select('id').single()
    if (error) { alert('Erro: ' + error.message); setBusy(false); return }
    await supabase.from('blueprint_candidates').update({ status: 'PROMOTED', promoted_pack_id: data.id, updated_at: new Date().toISOString() }).eq('id', c.id)
    await logEvent(c.id, 'PROMOTED_NEW_PACK', { pack_id: data.id })
    setBusy(false)
    router.push(`/packs/edit/${data.id}`)
  }

  // ENRIQUECER: só grava o campo duties de um pack que está VAZIO de duties —
  // nunca sobrescreve trabalho humano (aprovado pelo João, depois do refresh).
  const enrich = async (c: Candidate, packId: string) => {
    const pk = emptyPacks.find((p: any) => p.id === packId)
    if (!pk) return
    if (!confirm(`Escrever ${dutiesOf(c).length} duties no pack "${pk.name}"? (ele está sem nenhuma)`)) return
    setBusy(true)
    const { error } = await supabase.from('packs').update({ duties: dutiesOf(c) }).eq('id', packId)
    if (error) { alert('Erro: ' + error.message); setBusy(false); return }
    await supabase.from('blueprint_candidates').update({ status: 'PROMOTED', promoted_pack_id: packId, updated_at: new Date().toISOString() }).eq('id', c.id)
    await logEvent(c.id, 'ENRICHED_PACK', { pack_id: packId })
    patchCand(c.id, x => ({ ...x, status: 'PROMOTED', promoted_pack_id: packId }))
    setBusy(false)
    await load()
  }

  const dismiss = async (c: Candidate) => {
    const reason = prompt('Por que descartar? (fica no histórico)') || ''
    setBusy(true)
    await supabase.from('blueprint_candidates').update({ status: 'DISMISSED', dismiss_reason: reason, updated_at: new Date().toISOString() }).eq('id', c.id)
    await logEvent(c.id, 'DISMISSED', { reason })
    patchCand(c.id, x => ({ ...x, status: 'DISMISSED' }))
    setBusy(false)
  }

  const proposed = cands.filter(c => c.status === 'PROPOSED')
  const done = cands.filter(c => c.status !== 'PROPOSED')

  return (
    <div className="min-h-screen bg-neutral-100">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">BLUEPRINTS · CREW CHIEF</h1>
          <CcBadge />
        </div>
        <details className="bg-white rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-semibold">O que é isto · changelog</summary>
          <div className="mt-2 space-y-2 text-neutral-700">
            <p><b>O pack é o blueprint.</b> Esta tela minera as invoices reais (ao vivo, sem gravar nada) e propõe candidatos; ADOTAR abre a triagem humana; PROMOVER vira um pack DRAFT de verdade ou ENRIQUECE um pack existente ainda sem duties. Sequência combinada: Márcio+João atualizam os packs primeiro — a mineração lê o dado vivo e melhora junto.</p>
            {CC_CHANGELOG.map(c => <p key={c.version}><b>CC {c.version}</b> · {c.date} — {c.notes}</p>)}
          </div>
        </details>
        {noTables && (
          <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-sm">
            ⚠ Tabelas do CREW CHIEF ainda não existem — rode <b>MIGRATION_crew_chief_p1.sql</b> no SQL Editor do Supabase (US). A mineração abaixo já funciona (read-only); ADOTAR precisa da migration.
          </div>
        )}
        {loading ? <div className="text-neutral-500">Minerando ao vivo…</div> : (
          <>
            <section className="space-y-3">
              <h2 className="text-lg font-bold">MESA DE TRIAGEM — {proposed.length} candidato{proposed.length === 1 ? '' : 's'}</h2>
              {!proposed.length && <div className="text-sm text-neutral-500">Nenhum candidato adotado ainda — adote um na mineração abaixo.</div>}
              {proposed.map(c => (
                <div key={c.id} className="bg-white rounded-xl border p-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <input className="border rounded px-2 py-1 font-semibold flex-1 min-w-[220px]" value={c.name} onChange={e => patchCand(c.id, x => ({ ...x, name: e.target.value }))} />
                    <input className="border rounded px-2 py-1 w-28" placeholder="plataforma" value={c.platform || ''} onChange={e => patchCand(c.id, x => ({ ...x, platform: e.target.value.toUpperCase() || null }))} />
                    <span className="text-xs text-neutral-500">família: {c.family} · fonte: {(c.source?.invoiceCodes || []).join(', ') || '—'}</span>
                  </div>
                  <div className="space-y-1">
                    {dutiesOf(c).map((d, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input className="border rounded px-2 py-1 flex-1 text-sm" list="cc-vocab" value={d.description}
                          onChange={e => setDuties(c, dutiesOf(c).map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                        <select className="border rounded px-1 py-1 text-sm" value={d.priority}
                          onChange={e => setDuties(c, dutiesOf(c).map((x, j) => j === i ? { ...x, priority: e.target.value } : x))}>
                          {PRIORITIES.map(p => <option key={p} value={p}>{p === 'STANDBY' ? 'STANDBY' : 'P' + p}</option>)}
                        </select>
                        <input className="border rounded px-2 py-1 w-20 text-sm text-right" placeholder="horas"
                          defaultValue={d.estimated_seconds ? (d.estimated_seconds / 3600).toFixed(1) : ''}
                          onBlur={e => setDuties(c, dutiesOf(c).map((x, j) => j === i ? { ...x, estimated_seconds: hToSec(e.target.value) } : x))} />
                        <button className="text-red-600 text-sm px-1" onClick={() => setDuties(c, dutiesOf(c).filter((_, j) => j !== i))}>×</button>
                      </div>
                    ))}
                    <button className="text-sm text-blue-700" onClick={() => setDuties(c, [...dutiesOf(c), { description: '', priority: '1', estimated_seconds: null }])}>+ duty</button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <button disabled={busy} className="px-3 py-1.5 rounded bg-neutral-800 text-white" onClick={() => saveCand(c)}>SALVAR</button>
                    <button disabled={busy} className="px-3 py-1.5 rounded bg-emerald-700 text-white" onClick={() => promoteNew(c)}>PROMOVER → PACK NOVO</button>
                    {emptyPacks.length > 0 && (
                      <select disabled={busy} className="border rounded px-2 py-1.5" value="" onChange={e => e.target.value && enrich(c, e.target.value)}>
                        <option value="">ENRIQUECER pack sem duties…</option>
                        {emptyPacks.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    <button disabled={busy} className="px-3 py-1.5 rounded border text-red-700" onClick={() => dismiss(c)}>DESCARTAR</button>
                  </div>
                </div>
              ))}
              {done.length > 0 && (
                <button className="text-sm text-neutral-500 underline" onClick={() => setShowDone(v => !v)}>
                  {showDone ? 'esconder' : 'mostrar'} {done.length} resolvido{done.length === 1 ? '' : 's'}
                </button>
              )}
              {showDone && done.map(c => (
                <div key={c.id} className="bg-white rounded-xl border p-3 text-sm text-neutral-600 flex items-center gap-2 flex-wrap">
                  <b>{c.name}</b>
                  <span className={c.status === 'PROMOTED' ? 'text-emerald-700' : 'text-red-700'}>{c.status}</span>
                  {c.promoted_pack_id && <Link className="text-blue-700 underline" href={`/packs/edit/${c.promoted_pack_id}`}>abrir pack</Link>}
                </div>
              ))}
            </section>

            <section className="space-y-3">
              <h2 className="text-lg font-bold">MINERAÇÃO AO VIVO — {mined.length} família{mined.length === 1 ? '' : 's'}</h2>
              {mined.map(f => (
                <div key={f.family} className="bg-white rounded-xl border p-4 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold uppercase">{f.family}</span>
                    {f.platform && <span className="text-xs bg-neutral-200 rounded px-1.5 py-0.5">{f.platform}</span>}
                    <span className="text-xs text-neutral-500">{f.invoiceIds.length} invoices</span>
                    <button disabled={busy} className="ml-auto px-3 py-1 rounded bg-blue-700 text-white text-sm" onClick={() => adopt(f)}>ADOTAR</button>
                  </div>
                  {f.matchingPacks.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap text-xs">
                      {f.matchingPacks.map(p => (
                        <span key={p.id} className={`rounded px-1.5 py-0.5 border ${p.dutiesCount === 0 ? 'border-red-300 text-red-700' : 'border-emerald-300 text-emerald-700'}`}>
                          {p.name} · {p.dutiesCount === 0 ? 'SEM DUTIES' : p.dutiesCount + ' duties'}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-neutral-600">
                    exemplares: {f.exemplars.map(e => `${codeOf.get(e.invoiceId)} (${e.dutyCount}d/${e.kitCount}k)`).join(' · ') || '—'}
                  </div>
                  {f.kitBlocks.length > 0 && (
                    <div className="text-xs text-neutral-600">
                      kits: {f.kitBlocks.map(k => `${k.kitName} ×${k.invoiceIds.length} (${k.members.length} itens)`).join(' · ')}
                    </div>
                  )}
                  {f.primarySpine && f.primarySpine.steps.length > 0 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-neutral-700">espinha do exemplar {codeOf.get(f.primarySpine.invoiceId)} — {f.primarySpine.steps.length} passos{f.primarySpine.backlog.length ? ` + ${f.primarySpine.backlog.length} backlog` : ''}</summary>
                      <ol className="mt-1 space-y-0.5">
                        {f.primarySpine.steps.map((s, i) => {
                          const v = f.vocabulary.find(x => normDuty(x.canonical) === normDuty(s.description))
                          return (
                            <li key={i} className="flex items-center gap-2">
                              <span className={`text-[10px] rounded px-1 py-0.5 ${dutyPriorityBadge(s.priority).cls}`}>{dutyPriorityBadge(s.priority).label}</span>
                              <span>{s.description}</span>
                              <span className="text-xs text-neutral-500">{v?.medianSeconds != null ? '~' + hFmt(v.medianSeconds) : ''}{v && v.suspectStints > 0 ? ` · ⚠${v.suspectStints} stint>10h fora` : ''}</span>
                            </li>
                          )
                        })}
                      </ol>
                    </details>
                  )}
                  {f.vocabulary.length > 0 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-neutral-700">vocabulário — {f.vocabulary.length} descrições</summary>
                      <div className="mt-1 space-y-0.5 text-xs">
                        {f.vocabulary.slice(0, 12).map(v => (
                          <div key={v.canonical} className="flex gap-2">
                            <span className="flex-1">{v.canonical}</span>
                            <span className="text-neutral-500">×{v.invoiceIds.length} inv · {v.timed.length} cronos · mediana {hFmt(v.medianSeconds)}{v.suspectStints ? ` · ⚠${v.suspectStints}` : ''}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </section>
            <datalist id="cc-vocab">{vocabAll.map(v => <option key={v} value={v} />)}</datalist>
          </>
        )}
      </main>
    </div>
  )
}
