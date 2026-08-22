'use client'

// Card "Banco sem casamento" do Data Checker (21/ago): cada linha NEW do
// banco com os candidatos do app. MATCH casa (e backfilla a data do app),
// TRANSFER/IGNORE tiram da fila, EXPLAIN guarda "o que foi" (QUEUED). Lê e
// escreve por /api/bank/reconcile com o JWT da sessão (tabelas do banco são
// só-service-key). Depois de um MATCH recarrega a lista: o servidor é quem
// sabe quais candidatos ainda valem (revisão de 21/ago).
//
// v0.3.0 (22/ago): MOTORES — PLANEJAR mostra a seco o que FEE (tarifas da
// Regions) e EXACT (centavos + único dos dois lados + ≤3d + nome) casariam;
// APLICAR casa tudo numa rodada (match_batch). O que o motor casou fica em
// A CONFERIR: OK / DESFAZER por linha, DESFAZER LOTE por rodada, OK TODAS só
// pras tarifas. Enter no seletor de candidato = MATCH.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; score: number; dd: number | null }
type Line = { id: string; date: string; amount: number; name: string; raw_name: string; pending: boolean; source: string; fee: boolean; candidates: Cand[] }
type AutoLine = { id: string; date: string; amount: number; name: string; engine: string; batch: string; note: string; source: string }
type Batch = { batch: string; n: number; pending: number; fee: number; exact: number; from: string; to: string }
type Auto = { pending: AutoLine[]; reviewed: number; batches: Batch[] }
type Plan = { fee_create: number; fee_match: number; exact: number; total: number; skipped: Record<string, number>; samples: { fee: string[]; exact: string[] } }

export async function sessionHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }
}

const ENGINE_CHIP: Record<string, string> = { FEE: 'bg-teal-950 text-teal-300 border-teal-800', EXACT: 'bg-emerald-950 text-emerald-300 border-emerald-800' }

export default function BankReconcileCard({ onCount }: { onCount?: (n: number) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [totalNew, setTotalNew] = useState(0)
  const [auto, setAuto] = useState<Auto | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [onlyCand, setOnlyCand] = useState(false)
  const [hideFee, setHideFee] = useState(true)
  const [shown, setShown] = useState(80)
  const [pick, setPick] = useState<Record<string, string>>({})     // line id → "table:id"
  const [explain, setExplain] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [applied, setApplied] = useState<{ fee_create: number; fee_match: number; exact: number; errors: string[] } | null>(null)
  const [engineFilter, setEngineFilter] = useState<'ALL' | 'FEE' | 'EXACT'>('ALL')

  async function load() {
    setError('')
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLines(d.lines); setTotalNew(d.total_new); onCount?.(d.total_new)
      setAuto(d.auto || null); setNeedsMigration(!!d.needs_migration)
      setPick(prev => {
        const p: Record<string, string> = {}
        for (const l of d.lines as Line[]) {
          const keep = prev[l.id] && l.candidates.some(c => c.table + ':' + c.id === prev[l.id]) ? prev[l.id] : null
          if (keep) p[l.id] = keep; else if (l.candidates[0]) p[l.id] = l.candidates[0].table + ':' + l.candidates[0].id
        }
        return p
      })
    } catch (e) {
      setError(String((e as Error).message || e)); setLines([])
    }
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(d.error || `Falhou (${r.status})`), { status: r.status })
    return d
  }

  async function act(l: Line, action: string, extra: Record<string, unknown> = {}) {
    setBusy(l.id)
    try {
      await post({ action, bank_id: l.id, ...extra })
      // MATCH tira um candidato do jogo pra TODAS as outras linhas — só o servidor sabe
      // quais ainda valem, então recarrega. Demais ações só somem com a linha.
      if (action === 'match') await load()
      else { setLines(prev => (prev || []).filter(x => x.id !== l.id)); setTotalNew(n => n - 1); onCount?.(totalNew - 1) }
    } catch (e) {
      const err = e as Error & { status?: number }
      alert(err.status ? err.message : 'Sem resposta do servidor — confira a linha antes de repetir. ' + err.message)
      if (err.status === 409) await load()
    } finally { setBusy(null) }
  }

  // ── motores ──
  async function planRun() {
    setBusy('plan'); setApplied(null)
    try { const d = await post({ action: 'auto', plan: true }); setPlan(d.plan); setPlanOpen(true) }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }
  async function applyRun() {
    if (!plan || !confirm(`Aplicar agora? ${plan.total} linhas: ${plan.fee_create} tarifas criadas, ${plan.fee_match} tarifas casadas, ${plan.exact} casamentos exatos. Tudo fica em A CONFERIR e pode ser desfeito.`)) return
    setBusy('apply')
    try { const d = await post({ action: 'auto' }); setApplied(d.applied); setPlan(null); await load() }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }
  async function review(a: AutoLine) {
    setBusy(a.id)
    try { await post({ action: 'review', bank_id: a.id }); setAuto(prev => prev ? { ...prev, reviewed: prev.reviewed + 1, pending: prev.pending.filter(x => x.id !== a.id) } : prev) }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }
  async function undoLine(a: AutoLine) {
    setBusy(a.id)
    try { await post({ action: 'unmatch', bank_id: a.id }); await load() }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }
  async function reviewAllFees() {
    if (!confirm('Marcar TODAS as tarifas casadas pelo motor como conferidas?')) return
    setBusy('review_all')
    try { await post({ action: 'review_all' }); await load() }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }
  async function undoBatch(b: Batch) {
    if (!confirm(`Desfazer a rodada inteira (${b.n} linhas voltam pra sem casamento; tarifas criadas são apagadas)?`)) return
    setBusy('undo_' + b.batch)
    try { const d = await post({ action: 'undo_batch', batch: b.batch }); if (d.errors?.length) alert('Desfeitas ' + d.undone + ', com erro: ' + d.errors.join(' | ')); await load() }
    catch (e) { alert(String((e as Error).message || e)) } finally { setBusy(null) }
  }

  const visible = useMemo(() => {
    if (!lines) return []
    const needle = q.trim().toLowerCase()
    return lines.filter(l => (!onlyCand || l.candidates.length > 0) && (!hideFee || !l.fee) && (!needle || l.name.toLowerCase().includes(needle) || l.raw_name.toLowerCase().includes(needle) || Math.abs(l.amount).toFixed(2).includes(needle) || l.date.includes(needle)))
  }, [lines, q, onlyCand, hideFee])
  const withCand = lines ? lines.filter(l => l.candidates.length > 0).length : 0
  const feeLines = lines ? lines.filter(l => l.fee).length : 0
  const pendingReview = auto ? auto.pending.filter(a => engineFilter === 'ALL' || a.engine === engineFilter) : []
  const clean = !!lines && !error && totalNew === 0 && !(auto && auto.pending.length)

  return (
    <div className={`border rounded-2xl overflow-hidden ${clean ? 'border-emerald-900/60' : error ? 'border-red-900' : 'border-gray-700'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
        <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${error ? 'text-red-400' : clean ? 'text-emerald-400' : 'text-amber-300'}`}>{error ? '!' : lines ? (totalNew === 0 ? '✓' : totalNew) : '…'}</span>
        <span className="flex-1">
          <span className="font-bold block">Banco sem casamento — linhas da Regions sem par no app</span>
          <span className="text-xs text-gray-500">{error ? `erro: ${error}` : lines ? `trava: conciliação do DFC com o extrato · ${withCand} com candidato · ${feeLines} tarifas (motor)${auto && auto.pending.length ? ` · ${auto.pending.length} a conferir` : ''}` : 'carregando o banco…'}</span>
        </span>
        <span className="text-gray-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-5 py-4 border-t border-gray-800 space-y-5">
          {error && <p className="text-red-400">{error} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}

          {/* ── MOTORES ── */}
          <div className="bg-gray-950/60 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[16rem]">
                <p className="font-bold">MOTORES AUTOMÁTICOS <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold border border-teal-800 bg-teal-950 text-teal-300">FEE</span> <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-800 bg-emerald-950 text-emerald-300">EXACT</span></p>
                <p className="text-xs text-gray-500 mt-1">FEE: tarifa da Regions (wire fee, analysis charge, assessment) vira custo fixo "Regions Bank" e casa. EXACT: centavos iguais + único no app e no banco (±30d) + ≤3 dias + nome batendo. Só o certo; o resto fica como sugestão abaixo.</p>
              </div>
              {needsMigration ? (
                <p className="text-sm text-amber-300">Rode <b>MIGRATION_bank_reconcile_v030.sql</b> (raiz do projeto) no SQL Editor — os motores precisam das colunas match_engine / match_batch / reviewed_at.</p>
              ) : (
                <div className="flex gap-2">
                  <button disabled={busy !== null} onClick={planRun} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">{busy === 'plan' ? 'CALCULANDO…' : 'PLANEJAR'}</button>
                  {plan && plan.total > 0 && <button disabled={busy !== null} onClick={applyRun} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">{busy === 'apply' ? 'APLICANDO…' : `APLICAR ${plan.total}`}</button>}
                </div>
              )}
            </div>
            {plan && (
              <div className="mt-3 text-sm">
                <p><b>{plan.total}</b> linhas casariam agora: <span className="text-teal-300">FEE {plan.fee_create + plan.fee_match}</span> ({plan.fee_create} tarifas a criar, {plan.fee_match} já lançadas) · <span className="text-emerald-300">EXACT {plan.exact}</span>{plan.total === 0 ? ' — nada certo o bastante; siga pelas sugestões.' : ''}</p>
                <button onClick={() => setPlanOpen(o => !o)} className="text-xs text-gray-400 underline mt-1">{planOpen ? 'esconder' : 'ver'} amostra e motivos de recusa</button>
                {planOpen && (
                  <div className="mt-2 grid md:grid-cols-2 gap-3 text-xs text-gray-400">
                    <div>
                      <p className="font-bold text-gray-300 mb-1">Amostra EXACT</p>
                      {plan.samples.exact.length ? plan.samples.exact.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>) : <p>—</p>}
                      <p className="font-bold text-gray-300 mt-2 mb-1">Amostra FEE</p>
                      {plan.samples.fee.length ? plan.samples.fee.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>) : <p>—</p>}
                    </div>
                    <div>
                      <p className="font-bold text-gray-300 mb-1">Por que o resto NÃO casa sozinho</p>
                      {Object.entries(plan.skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => <p key={k}>{k}: <b>{v}</b></p>)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {applied && <p className="mt-3 text-sm text-emerald-300">Aplicado: {applied.fee_create} tarifas criadas · {applied.fee_match} tarifas casadas · {applied.exact} exatos.{applied.errors.length ? <span className="text-red-400"> Erros: {applied.errors.join(' | ')}</span> : ''} Confira abaixo.</p>}
          </div>

          {/* ── A CONFERIR ── */}
          {auto && (auto.pending.length > 0 || auto.batches.length > 0) && (
            <div className="border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-3 flex-wrap mb-3">
                <p className="font-bold flex-1">A CONFERIR <span className="text-amber-300">{auto.pending.length}</span> <span className="text-xs text-gray-500 font-normal">· {auto.reviewed} já conferidas</span></p>
                <div className="flex gap-1">
                  {(['ALL', 'FEE', 'EXACT'] as const).map(k => <button key={k} onClick={() => setEngineFilter(k)} className={`px-3 py-1 rounded-xl text-xs font-bold border ${engineFilter === k ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{k === 'ALL' ? 'TODAS' : k}</button>)}
                </div>
                {auto.pending.some(a => a.engine === 'FEE') && <button disabled={busy !== null} onClick={reviewAllFees} className="bg-teal-800 hover:bg-teal-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">OK TODAS AS TARIFAS</button>}
              </div>
              {auto.batches.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-3 text-xs text-gray-400">
                  {auto.batches.map(b => (
                    <span key={b.batch} className="inline-flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-1">
                      rodada {formatShortDate(b.from)}–{formatShortDate(b.to)} · {b.n} ({b.fee} FEE · {b.exact} EXACT){b.pending ? ` · ${b.pending} a conferir` : ' · conferida'}
                      <button disabled={busy !== null} onClick={() => undoBatch(b)} className="text-red-300 hover:text-red-200 font-bold disabled:opacity-40">{busy === 'undo_' + b.batch ? '…' : 'DESFAZER LOTE'}</button>
                    </span>
                  ))}
                </div>
              )}
              {pendingReview.length === 0 ? <p className="text-emerald-400 text-sm font-bold">Tudo conferido.</p> : (
                <div className="divide-y divide-gray-800">
                  {pendingReview.slice(0, 150).map(a => (
                    <div key={a.id} className="py-2 flex items-center gap-3 flex-wrap">
                      <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(a.date)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${ENGINE_CHIP[a.engine] || 'border-gray-700 text-gray-400'}`}>{a.engine}</span>
                      <span className="text-sm truncate max-w-[18rem]" title={a.name}>{a.name}</span>
                      <span className={`tabular-nums font-bold text-sm shrink-0 ${a.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{a.amount > 0 ? '−' : '+'}{usd(a.amount)}</span>
                      <span className="text-xs text-gray-400 flex-1 truncate min-w-[12rem]" title={a.note}>⇄ {a.note}</span>
                      <button disabled={busy === a.id} onClick={() => review(a)} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">OK</button>
                      <button disabled={busy === a.id} onClick={() => undoLine(a)} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">DESFAZER</button>
                    </div>
                  ))}
                  {pendingReview.length > 150 && <p className="text-xs text-gray-500 pt-2">mostrando 150 de {pendingReview.length} — confira e recarregue</p>}
                </div>
              )}
            </div>
          )}

          {/* ── SEM CASAMENTO (humano) ── */}
          <div>
            <p className="text-sm text-gray-400 mb-3 max-w-3xl">Cada linha do banco ou já existe no app (MATCH — Enter no seletor também casa; a data de pagamento do app é preenchida com a do banco se faltava), ou é transferência/ignorável, ou falta no app: EXPLAIN guarda o que foi pra lançar depois.</p>
            <div className="flex gap-3 flex-wrap items-center mb-3">
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar por nome, valor ou data" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-72" />
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer"><input type="checkbox" checked={onlyCand} onChange={e => setOnlyCand(e.target.checked)} className="w-4 h-4" /> só com candidato</label>
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer"><input type="checkbox" checked={hideFee} onChange={e => setHideFee(e.target.checked)} className="w-4 h-4" /> esconder tarifas ({feeLines} — o motor FEE cuida)</label>
              <button onClick={load} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-3 py-1.5 rounded-xl font-bold text-xs">↻</button>
              <span className="text-xs text-gray-500 ml-auto">{visible.length} linhas{visible.length > shown ? ` · mostrando ${shown}` : ''}</span>
            </div>
            {!lines ? <p className="text-gray-500">Carregando o banco…</p> : visible.length === 0 ? <p className={error ? 'text-gray-500' : 'text-emerald-400 font-bold'}>{error ? 'Sem dados.' : 'Nada pendente aqui.'}</p> : (
              <div className="divide-y divide-gray-800">
                {visible.slice(0, shown).map(l => {
                  const sel = pick[l.id] || ''
                  const cand = l.candidates.find(c => c.table + ':' + c.id === sel)
                  return (
                    <div key={l.id} className="py-3 px-2">
                      <div className="flex items-baseline gap-3">
                        <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(l.date)}</span>
                        <span className="flex-1 truncate text-sm" title={l.raw_name}>{l.name}{l.pending && <span className="ml-2 text-xs text-amber-400">PENDING</span>}{l.fee && <span className="ml-2 text-[10px] font-bold text-teal-300">TARIFA</span>}{l.source === 'STATEMENT' && <span className="ml-2 text-xs text-gray-600">extrato</span>}</span>
                        <span className={`tabular-nums font-bold text-sm shrink-0 ${l.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{l.amount > 0 ? '−' : '+'}{usd(l.amount)}</span>
                      </div>
                      <div className="mt-2 flex gap-2 flex-wrap items-center">
                        {l.candidates.length > 0 ? (
                          <select value={sel} onChange={e => setPick({ ...pick, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && cand && busy !== l.id) { e.preventDefault(); act(l, 'match', { table: cand.table, row_id: cand.id }) } }} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs max-w-xl">
                            {l.candidates.map(c => <option key={c.table + c.id} value={c.table + ':' + c.id}>{c.label} — {c.date ? formatShortDate(c.date) : 'sem data'}{c.dd != null ? ` (${c.dd}d)` : ''}{c.undated ? ' · sem payment date' : ''}</option>)}
                          </select>
                        ) : <span className="text-xs text-gray-600">sem candidato no app</span>}
                        <button disabled={!cand || busy === l.id} onClick={() => cand && act(l, 'match', { table: cand.table, row_id: cand.id })} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">MATCH</button>
                        <button disabled={busy === l.id} onClick={() => act(l, 'transfer')} className="bg-blue-800 hover:bg-blue-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">TRANSFER</button>
                        <button disabled={busy === l.id} onClick={() => { if (confirm('Ignorar esta linha do banco?')) act(l, 'ignore') }} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">IGNORE</button>
                        <input value={explain[l.id] || ''} onChange={e => setExplain({ ...explain, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && (explain[l.id] || '').trim() && busy !== l.id) { e.preventDefault(); act(l, 'explain', { note: explain[l.id] }) } }} placeholder="o que foi? (EXPLAIN)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-56" />
                        <button disabled={!(explain[l.id] || '').trim() || busy === l.id} onClick={() => act(l, 'explain', { note: explain[l.id] })} className="bg-fuchsia-800 hover:bg-fuchsia-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">EXPLAIN</button>
                      </div>
                    </div>
                  )
                })}
                {visible.length > shown && <button onClick={() => setShown(s => s + 100)} className="mt-3 w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">MOSTRAR MAIS ({visible.length - shown} restantes)</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
