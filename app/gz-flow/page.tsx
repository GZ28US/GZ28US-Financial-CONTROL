'use client'

// GZ28US vs GZ28BR Flow — A CONTA CORRENTE BR↔US, CALCULADA (23/out/2026).
//
// Márcio, 23/10/2026: «there is no PAID TO feature anymore, if it's a BR expense, it should be in BR app, if it's an US expense,
// it should be in the US app. the only difference will be the paid from thing» · «to incomes the PAID TO exists, and it's right,
// it's the opposite of the paid from in expenses» · «let's make this BR vs US flow PERFECT».
//
// Esta tela lê a rota GET /api/intercompany/ledger (lib/intercompanyLedger.server.ts): cada fato mora UMA vez, no app dele —
// despesa com PAID BY, renda com RECEIVED BY — mais as TRANSFERÊNCIAS (intercompany_transfers). O saldo é a soma, nunca uma cópia.
// As shopping invoices 006.N/085.N do modelo antigo são histórico; o bloco «LEGACY CHECK» (rota /api/intercompany/reconcile) mostra,
// linha a linha, a diferença entre a conta nova e o espelho velho enquanto ele existir.
import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import type { Ledger, LedgerEntry, Transfer, LeftOut } from '@/lib/intercompanyLedger.server'
import type { Reconcile } from '@/lib/intercompanyReconcile.server'

const usd = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
const fmtNY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const whenNY = (s: string) => fmtNY.format(new Date(s)).replace(',', '') + ' (Orlando)'
const mdy = (d: string | null | undefined) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '—')
const moneyColor = (v: number) => v > 0.004 ? 'text-emerald-400' : v < -0.004 ? 'text-red-400' : 'text-gray-400'
const SIDE: Record<LedgerEntry['side'], { label: string; cls: string }> = { BR_OWES: { label: 'BR OWES', cls: 'text-amber-300' }, US_OWES: { label: 'US OWES', cls: 'text-sky-300' } }
const KIND_LABEL: Record<string, string> = { EXPENSE: 'expenses', INCOME: 'incomes', TRANSFER: 'transfers' }
const LOOSE_LABEL: Record<string, string> = {
  SEM_DATA: 'No payment date — not counted until it has one',
  SEM_CAMBIO: 'No exchange rate for the day — counted as $0',
  CREDITO_A_DECIDIR: 'BR credit against US (FL tax charged wrongly) — decision pending, not counted',
  RENDA_NO_BR_SEM_REMESSA: 'INFO · US income received in Brazil that no transfer declares as covered (30+ days) — in 2025 the BR spent that money paying US bills directly, which is already in the account',
  TRANSFERENCIA_EM_TRANSITO: 'Transfer sent, not arrived yet',
  TRANSFERENCIA_A_REVISAR: 'Transfer missing one leg or its receipt',
  TRANSFERENCIA_SEM_REGIONS: 'Transfer arrived with no Regions line matched',
}

type State = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: Ledger }

export default function GzFlowPage() {
  const [s, setS] = useState<State>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/intercompany/ledger`, { headers: await sessionHeaders(), cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!alive) return
        if (r.ok && j.ok) setS({ state: 'ok', data: j as Ledger })
        else setS({ state: 'error', error: String(j.error || `HTTP ${r.status}`) })
      } catch (e) { if (alive) setS({ state: 'error', error: String((e as Error)?.message || e) }) }
    })()
    return () => { alive = false }
  }, [tick])
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">GZ28US vs GZ28BR Flow</h1>
      <p className="text-gray-400 mb-6 max-w-4xl">One running account, computed from the facts: every expense PAID BY the other company, every income RECEIVED BY the other company (each in its own app), and every transfer of money between the two. Nothing is copied between the apps.</p>
      {s.state === 'loading' ? <p className="text-gray-400 text-xl">Loading…</p>
        : s.state === 'error' ? (
          <div className="bg-red-950/50 border border-red-900 rounded-2xl p-4 max-w-3xl">
            <p className="font-bold text-red-300">Balance NOT computed — no number is shown rather than a wrong one.</p>
            <p className="text-sm text-red-200 mt-1 break-words">{s.error}</p>
          </div>
        ) : <Body data={s.data} reload={() => { setS({ state: 'loading' }); setTick(t => t + 1) }} />}
    </main>
  )
}

function Body({ data, reload }: { data: Ledger; reload: () => void }) {
  const owes = data.brOwesUs
  const k = (kind: string) => data.totals.byKind[kind] || { brOwes: 0, usOwes: 0, n: 0 }
  return (
    <div className="max-w-7xl">
      <div className="bg-gray-900 border-2 border-blue-700 rounded-2xl p-5 mb-4">
        <p className="text-sm font-bold text-blue-300">HOW MUCH GZ28BR OWES GZ28US · TODAY</p>
        <p className={`text-5xl font-bold tabular-nums mt-1 ${moneyColor(owes)}`}>{usd(owes)}</p>
        <p className="text-sm text-gray-400 mt-2">{owes < -0.004 ? <>Negative: today <span className="font-bold text-red-300">GZ28US owes GZ28BR {usd(-owes)}</span>.</> : owes > 0.004 ? <>GZ28BR owes GZ28US {usd(owes)}.</> : <>Even.</>}</p>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-gray-400 text-xs"><tr><th className="text-left py-1 pr-3">WHAT</th><th className="text-right py-1 px-3 text-amber-300">BR OWES (+)</th><th className="text-right py-1 px-3 text-sky-300">US OWES (−)</th><th className="text-right py-1 pl-3">LINES</th></tr></thead>
            <tbody>
              <tr className="border-t border-gray-800"><td className="py-1.5 pr-3">Expenses · US bills paid by BR (US app) / BR bills paid by US (BR app)</td><td className="py-1.5 px-3 text-right">{usd(k('EXPENSE').brOwes)}</td><td className="py-1.5 px-3 text-right">{usd(k('EXPENSE').usOwes)}</td><td className="py-1.5 pl-3 text-right text-gray-500">{k('EXPENSE').n}</td></tr>
              <tr className="border-t border-gray-800"><td className="py-1.5 pr-3">Incomes · US money received in Brazil (US app) / BR money received in the US (BR app)</td><td className="py-1.5 px-3 text-right">{usd(k('INCOME').brOwes)}</td><td className="py-1.5 px-3 text-right">{usd(k('INCOME').usOwes)}</td><td className="py-1.5 pl-3 text-right text-gray-500">{k('INCOME').n}</td></tr>
              <tr className="border-t border-gray-800"><td className="py-1.5 pr-3">Transfers · money sent BR → US (−) or US → BR (+)</td><td className="py-1.5 px-3 text-right">{usd(k('TRANSFER').brOwes)}</td><td className="py-1.5 px-3 text-right">{usd(k('TRANSFER').usOwes)}</td><td className="py-1.5 pl-3 text-right text-gray-500">{k('TRANSFER').n}</td></tr>
              <tr className="border-t border-gray-600 font-bold"><td className="py-1.5 pr-3">TOTAL</td><td className="py-1.5 px-3 text-right text-amber-300">{usd(data.totals.brOwes)}</td><td className="py-1.5 px-3 text-right text-sky-300">{usd(data.totals.usOwes)}</td><td className={`py-1.5 pl-3 text-right ${moneyColor(owes)}`}>{usd(owes)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-sm tabular-nums">
          {(['E1', 'E2'] as const).map(e => (
            <div key={e} className="border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-bold text-gray-400">{e === 'E1' ? 'ERA 1 · UP TO 12/31/2025' : 'ERA 2 · FROM 01/01/2026'}</p>
              <p><span className="text-amber-300">{usd(data.eras[e].brOwes)}</span> <span className="text-gray-500">−</span> <span className="text-sky-300">{usd(data.eras[e].usOwes)}</span> <span className="text-gray-500">=</span> <span className={`font-bold ${moneyColor(data.eras[e].net)}`}>{usd(data.eras[e].net)}</span> <span className="text-xs text-gray-500">· {data.eras[e].n} lines</span></p>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">Read {whenNY(data.generatedAt)} · the same number as the Balance sheet («Conta corrente GZ28BR») and the Data Checker card. US$ is the truth in the US app and R$ in the BR app; the other currency is the recorded value or the real daily rate (fx_usd_brl_daily, no spread, no IOF) — never invented.{data.fx.failure ? ` · FX WARNING: ${data.fx.failure}` : ''}{data.fx.missingDays.length ? ` · ${data.fx.missingDays.length} day(s) without a rate` : ''}</p>
      </div>

      {data.looseEnds.length > 0 && <LooseEnds items={data.looseEnds} />}
      <Months months={data.months} />
      <Transfers transfers={data.transfers} reload={reload} />
      <Entries entries={data.entries} />
      <LeftOutBlock items={data.leftOut} />
      <LegacyCheck />
    </div>
  )
}

function LooseEnds({ items }: { items: Ledger['looseEnds'] }) {
  const groups = useMemo(() => { const g = new Map<string, Ledger['looseEnds']>(); for (const i of items) g.set(i.kind, [...(g.get(i.kind) || []), i]); return [...g.entries()] }, [items])
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="bg-amber-950/30 border border-amber-900 rounded-2xl p-4 mb-6">
      <p className="text-sm font-bold text-amber-300">LOOSE ENDS — {items.length} · the account is only perfect when this box is empty</p>
      <div className="mt-2 space-y-1 text-sm">
        {groups.map(([kind, list]) => (
          <div key={kind}>
            <button onClick={() => setOpen(o => (o === kind ? null : kind))} className="text-left text-amber-200 hover:text-white"><span className="text-gray-500 mr-1">{open === kind ? '▾' : '▸'}</span><span className="font-bold">{list.length}</span> · {LOOSE_LABEL[kind] || kind}{list.some(x => x.usd != null) ? <span className="text-gray-400"> · {usd(list.reduce((s, x) => s + (x.usd || 0), 0))}</span> : null}</button>
            {open === kind && <ul className="pl-5 mt-1 space-y-0.5 text-xs text-gray-300">{list.map(x => <li key={x.key}>{x.href ? <a href={x.external ? x.href : `${BASE_PATH}${x.href}`} target={x.external ? '_blank' : undefined} rel="noopener noreferrer" className="hover:text-blue-400 hover:underline">{x.label}</a> : x.label}{x.usd != null ? <span className="text-gray-500"> · {usd(x.usd)}</span> : null}</li>)}</ul>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Months({ months }: { months: Ledger['months'] }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="mb-8 border border-gray-800 rounded-2xl p-4">
      <button onClick={() => setOpen(o => !o)} className="text-2xl font-bold text-left">{open ? '▾' : '▸'} Statement by month</button>
      {open && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-gray-900 text-gray-400 text-xs"><tr><th className="text-left px-3 py-2">MONTH</th><th className="text-right px-3 py-2 text-amber-300">BR OWES (+)</th><th className="text-right px-3 py-2 text-sky-300">US OWES (−)</th><th className="text-right px-3 py-2">NET</th><th className="text-right px-3 py-2">RUNNING BALANCE</th><th className="text-right px-3 py-2">LINES</th></tr></thead>
            <tbody>{months.map(m => (
              <tr key={m.month} className="border-t border-gray-800 hover:bg-gray-900/60"><td className="px-3 py-1.5 font-bold text-gray-200">{m.month}</td><td className="px-3 py-1.5 text-right">{usd(m.brOwes)}</td><td className="px-3 py-1.5 text-right">{usd(m.usOwes)}</td><td className={`px-3 py-1.5 text-right ${moneyColor(m.net)}`}>{usd(m.net)}</td><td className={`px-3 py-1.5 text-right font-bold ${moneyColor(m.running)}`}>{usd(m.running)}</td><td className="px-3 py-1.5 text-right text-gray-500">{m.n}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const EMPTY_TR = { direction: 'BR_TO_US', via: 'ALLAN', sent_on: '', sent_amount: '', sent_currency: 'BRL', sent_receipts: '', arrived_on: '', arrived_amount: '', arrived_currency: 'USD', arrived_receipts: '', description: '', status: '' }
function Transfers({ transfers, reload }: { transfers: Transfer[]; reload: () => void }) {
  const [open, setOpen] = useState(true)
  const [form, setForm] = useState<Record<string, string>>(EMPTY_TR)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const startEdit = (t: Transfer) => { setEditing(t.id); setForm({ direction: t.direction, via: t.via || '', sent_on: t.sent_on || '', sent_amount: t.sent_amount == null ? '' : String(t.sent_amount), sent_currency: t.sent_currency || 'BRL', sent_receipts: t.sent_receipts.join('\n'), arrived_on: t.arrived_on || '', arrived_amount: t.arrived_amount == null ? '' : String(t.arrived_amount), arrived_currency: t.arrived_currency || 'USD', arrived_receipts: t.arrived_receipts.join('\n'), description: t.description || '', status: t.status }); setOpen(true) }
  async function save() {
    setBusy(true); setMsg(null)
    try {
      const transfer: Record<string, unknown> = { ...form, id: editing || undefined, status: form.status || undefined }
      const r = await fetch(`${BASE_PATH}/api/intercompany/transfers`, { method: 'POST', headers: { ...(await sessionHeaders()), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: editing ? 'update' : 'create', transfer }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setMsg(`Saved ${j.transfer?.code || ''}`); setForm(EMPTY_TR); setEditing(null); reload()
    } catch (e) { setMsg('NOT saved: ' + String((e as Error)?.message || e)) } finally { setBusy(false) }
  }
  const inp = 'bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-full'
  return (
    <section className="mb-8 border border-gray-800 rounded-2xl p-4">
      <button onClick={() => setOpen(o => !o)} className="text-2xl font-bold text-left">{open ? '▾' : '▸'} Transfers <span className="text-gray-500 text-base">({transfers.length})</span></button>
      <p className="text-xs text-gray-500 mt-1">Money sent from one company to the other: Allan&apos;s wires, cheques, cash withdrawals. What LEFT (date, amount, currency, receipt) and what ARRIVED (same). The real exchange rate is the ratio. BR → US lowers what BR owes; US → BR raises it. SENT = left, not arrived; ARRIVED = in the account; RECONCILED = matched to the Regions line.</p>
      {open && (
        <>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-gray-900 text-gray-400 text-xs"><tr><th className="text-left px-3 py-2">CODE</th><th className="text-left px-3 py-2">DIRECTION · VIA</th><th className="text-left px-3 py-2">SENT</th><th className="text-left px-3 py-2">ARRIVED</th><th className="text-right px-3 py-2">RATE</th><th className="text-left px-3 py-2">STATUS</th><th className="text-left px-3 py-2">DESCRIPTION</th><th className="px-3 py-2"></th></tr></thead>
              <tbody>{transfers.map(t => (
                <tr key={t.id} className="border-t border-gray-800 hover:bg-gray-900/60 align-top">
                  <td className="px-3 py-1.5 font-bold text-gray-200 whitespace-nowrap">{t.code}{t.needs_review ? <span className="block text-[10px] text-amber-400">REVIEW</span> : null}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{t.direction === 'BR_TO_US' ? 'BR → US' : 'US → BR'} · {t.via || '—'}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{t.sent_amount != null ? `${t.sent_currency === 'BRL' ? brl(t.sent_amount) : usd(t.sent_amount)} · ${mdy(t.sent_on)}` : <span className="text-gray-500">—</span>}{t.sent_receipts.length ? <a href={t.sent_receipts[0]} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs text-blue-400">📎{t.sent_receipts.length > 1 ? t.sent_receipts.length : ''}</a> : null}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{t.arrived_amount != null ? `${t.arrived_currency === 'BRL' ? brl(t.arrived_amount) : usd(t.arrived_amount)} · ${mdy(t.arrived_on)}` : <span className="text-gray-500">—</span>}{t.arrived_receipts.length ? <a href={t.arrived_receipts[0]} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs text-blue-400">📎{t.arrived_receipts.length > 1 ? t.arrived_receipts.length : ''}</a> : null}{t.bank_transaction_id ? <span className="ml-1 text-[10px] text-emerald-400" title="matched to a Regions line">REGIONS ✓</span> : null}</td>
                  <td className="px-3 py-1.5 text-right">{t.rate ?? '—'}</td>
                  <td className="px-3 py-1.5"><span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 ${t.status === 'RECONCILED' ? 'text-emerald-300 border-emerald-800' : t.status === 'ARRIVED' ? 'text-sky-300 border-sky-800' : 'text-amber-300 border-amber-800'}`}>{t.status}</span>{t.fx_diff_usd ? <span className="block text-[10px] text-gray-400">fx diff {usd(t.fx_diff_usd)}</span> : null}</td>
                  <td className="px-3 py-1.5 text-gray-400 max-w-md"><span className="line-clamp-2" title={t.description || ''}>{t.description || '—'}</span>{t.covers.length ? <span className="block text-[10px] text-gray-500">covers {t.covers.length} income(s)</span> : null}</td>
                  <td className="px-3 py-1.5"><button onClick={() => startEdit(t)} className="text-xs text-gray-400 hover:text-white">edit</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="mt-4 border border-gray-800 rounded-xl p-3 bg-gray-950">
            <p className="text-sm font-bold text-gray-300 mb-2">{editing ? 'EDIT TRANSFER' : 'NEW TRANSFER'}</p>
            <div className="grid md:grid-cols-4 gap-2">
              <select value={form.direction} onChange={e => set('direction', e.target.value)} className={inp}><option value="BR_TO_US">BR → US</option><option value="US_TO_BR">US → BR</option></select>
              <input value={form.via} onChange={e => set('via', e.target.value)} placeholder="via (ALLAN, CHEQUE, CASH, WIRE, ZELLE, PIX)" className={inp} />
              <select value={form.status} onChange={e => set('status', e.target.value)} className={inp}><option value="">status (auto)</option><option value="SENT">SENT</option><option value="ARRIVED">ARRIVED</option><option value="RECONCILED">RECONCILED</option></select>
              <input value={form.description} onChange={e => set('description', e.target.value)} placeholder="description" className={inp} />
              <div className="md:col-span-2 border border-gray-800 rounded-xl p-2"><p className="text-[10px] text-gray-500 mb-1">SENT (what left)</p><div className="grid grid-cols-3 gap-2"><input type="date" value={form.sent_on} onChange={e => set('sent_on', e.target.value)} className={inp} /><input value={form.sent_amount} onChange={e => set('sent_amount', e.target.value)} placeholder="amount" className={inp} /><select value={form.sent_currency} onChange={e => set('sent_currency', e.target.value)} className={inp}><option>BRL</option><option>USD</option></select></div><textarea value={form.sent_receipts} onChange={e => set('sent_receipts', e.target.value)} placeholder="receipt URL(s), one per line" className={inp + ' mt-2'} rows={2} /></div>
              <div className="md:col-span-2 border border-gray-800 rounded-xl p-2"><p className="text-[10px] text-gray-500 mb-1">ARRIVED (what landed)</p><div className="grid grid-cols-3 gap-2"><input type="date" value={form.arrived_on} onChange={e => set('arrived_on', e.target.value)} className={inp} /><input value={form.arrived_amount} onChange={e => set('arrived_amount', e.target.value)} placeholder="amount" className={inp} /><select value={form.arrived_currency} onChange={e => set('arrived_currency', e.target.value)} className={inp}><option>USD</option><option>BRL</option></select></div><textarea value={form.arrived_receipts} onChange={e => set('arrived_receipts', e.target.value)} placeholder="receipt URL(s), one per line" className={inp + ' mt-2'} rows={2} /></div>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button onClick={save} disabled={busy} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded-xl px-4 py-2 text-sm font-bold">{busy ? 'Saving…' : editing ? 'SAVE CHANGES' : 'ADD TRANSFER'}</button>
              {editing && <button onClick={() => { setEditing(null); setForm(EMPTY_TR) }} className="text-sm text-gray-400 hover:text-white">cancel</button>}
              {msg && <span className={`text-sm ${msg.startsWith('NOT') ? 'text-red-300' : 'text-emerald-300'}`}>{msg}</span>}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function Entries({ entries }: { entries: LedgerEntry[] }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('ALL'), [app, setApp] = useState('ALL'), [side, setSide] = useState('ALL'), [q, setQ] = useState('')
  const list = useMemo(() => entries.filter(e => (kind === 'ALL' || e.kind === kind) && (app === 'ALL' || e.app === app) && (side === 'ALL' || e.side === side) && (!q || `${e.code || ''} ${e.label} ${e.date || ''}`.toLowerCase().includes(q.toLowerCase()))), [entries, kind, app, side, q])
  const sel = 'bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-sm'
  return (
    <section className="mb-8 border border-gray-800 rounded-2xl p-4">
      <button onClick={() => setOpen(o => !o)} className="text-2xl font-bold text-left">{open ? '▾' : '▸'} Every line <span className="text-gray-500 text-base">({entries.length})</span></button>
      {open && (
        <>
          <div className="flex flex-wrap gap-2 mt-3">
            <select value={kind} onChange={e => setKind(e.target.value)} className={sel}><option value="ALL">all kinds</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select value={app} onChange={e => setApp(e.target.value)} className={sel}><option value="ALL">both apps</option><option value="US">US app</option><option value="BR">BR app</option></select>
            <select value={side} onChange={e => setSide(e.target.value)} className={sel}><option value="ALL">both sides</option><option value="BR_OWES">BR owes</option><option value="US_OWES">US owes</option></select>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="search" className={sel + ' flex-1 min-w-[12rem]'} />
            <span className="text-sm text-gray-400 self-center tabular-nums">{list.length} lines · BR owes {usd(list.filter(e => e.side === 'BR_OWES').reduce((s, e) => s + e.usd, 0))} · US owes {usd(list.filter(e => e.side === 'US_OWES').reduce((s, e) => s + e.usd, 0))}</span>
          </div>
          <div className="overflow-x-auto mt-3 max-h-[70vh] overflow-y-auto border border-gray-800 rounded-xl">
            <table className="w-full text-xs tabular-nums">
              <thead className="bg-gray-900 text-gray-400 sticky top-0"><tr><th className="text-left px-2 py-2">DATE</th><th className="text-left px-2 py-2">APP · INVOICE</th><th className="text-left px-2 py-2">LINE</th><th className="text-left px-2 py-2">PAID BY / RECEIVED BY</th><th className="text-left px-2 py-2">SIDE</th><th className="text-right px-2 py-2">US$</th><th className="text-right px-2 py-2">R$</th><th className="text-right px-2 py-2">RATE</th><th className="text-left px-2 py-2">FLAGS</th></tr></thead>
              <tbody>{list.map(e => (
                <tr key={e.key} className="border-t border-gray-900 hover:bg-gray-900/60">
                  <td className="px-2 py-1 whitespace-nowrap">{mdy(e.date)}</td>
                  <td className="px-2 py-1 whitespace-nowrap"><span className={`text-[10px] font-bold mr-1 ${e.app === 'US' ? 'text-blue-300' : 'text-green-300'}`}>{e.app}</span>{e.href ? <a href={e.external ? e.href : `${BASE_PATH}${e.href}`} target={e.external ? '_blank' : undefined} rel="noopener noreferrer" className="text-gray-200 hover:text-blue-400 hover:underline">{e.code || e.table}{e.external ? ' ↗' : ''}</a> : (e.code || e.table)}</td>
                  <td className="px-2 py-1 max-w-md truncate" title={e.label}>{e.label}{e.receipts.length ? <a href={e.receipts[0]} target="_blank" rel="noopener noreferrer" className="ml-1 text-blue-400">📎</a> : <span className="ml-1 text-amber-500" title="no receipt attached">∅</span>}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-gray-400">{e.kind === 'INCOME' ? `received by ${e.receiver || '?'}` : e.kind === 'TRANSFER' ? `${e.payer} → ${e.receiver}` : `paid by ${e.payer || '?'}`}</td>
                  <td className={`px-2 py-1 whitespace-nowrap font-bold ${SIDE[e.side].cls}`}>{SIDE[e.side].label}</td>
                  <td className="px-2 py-1 text-right">{usd(e.usd)}</td>
                  <td className="px-2 py-1 text-right text-gray-400">{e.brl != null ? brl(e.brl) : '—'}</td>
                  <td className="px-2 py-1 text-right text-gray-500" title={e.rateSource}>{e.rate ?? '—'}{e.rateSource === 'fx_daily' ? '*' : ''}</td>
                  <td className="px-2 py-1 text-amber-400">{e.flags.join(' ')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-500 mt-1">* rate from the real daily bid (fx_usd_brl_daily) where the line has no recorded value in the other currency. ∅ = no receipt attached.</p>
        </>
      )}
    </section>
  )
}

function LeftOutBlock({ items }: { items: LeftOut[] }) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => { const g = new Map<string, LeftOut[]>(); for (const i of items) g.set(i.reason, [...(g.get(i.reason) || []), i]); return [...g.entries()].sort((a, b) => b[1].length - a[1].length) }, [items])
  if (!items.length) return null
  return (
    <section className="mb-8 border border-gray-800 rounded-2xl p-4">
      <button onClick={() => setOpen(o => !o)} className="text-xl font-bold text-left text-gray-300">{open ? '▾' : '▸'} Not in the number <span className="text-gray-500 text-base">({items.length} lines that cite the other company but are not counted — and why)</span></button>
      {open && <div className="mt-3 space-y-3 text-xs">{groups.map(([reason, list]) => (
        <div key={reason}><p className="font-bold text-gray-300">{list.length} · {reason}</p><ul className="pl-4 text-gray-400 space-y-0.5">{list.slice(0, 40).map(x => <li key={x.key}><span className={`font-bold mr-1 ${x.app === 'US' ? 'text-blue-300' : 'text-green-300'}`}>{x.app}</span>{x.href ? <a href={x.external ? x.href : `${BASE_PATH}${x.href}`} target={x.external ? '_blank' : undefined} rel="noopener noreferrer" className="hover:text-blue-400 hover:underline">{x.code || x.table}</a> : (x.code || x.table)} · {x.label}{x.usd != null ? ` · ${usd(x.usd)}` : ''}{x.brl != null ? ` · ${brl(x.brl)}` : ''}</li>)}{list.length > 40 && <li>… +{list.length - 40}</li>}</ul></div>
      ))}</div>}
    </section>
  )
}

function LegacyCheck() {
  const [s, setS] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: Reconcile }>({ state: 'idle' })
  async function run() {
    setS({ state: 'loading' })
    try {
      const r = await fetch(`${BASE_PATH}/api/intercompany/reconcile`, { headers: await sessionHeaders(), cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) setS({ state: 'ok', data: j as Reconcile }); else setS({ state: 'error', error: String(j.error || `HTTP ${r.status}`) })
    } catch (e) { setS({ state: 'error', error: String((e as Error)?.message || e) }) }
  }
  return (
    <section className="mb-8 border border-gray-800 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-gray-300">Legacy check · this account × the old mirror (006.N / 085.N)</h2>
        <button onClick={run} disabled={s.state === 'loading'} className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl px-3 py-1.5 text-sm">{s.state === 'loading' ? 'Comparing…' : 'COMPARE NOW'}</button>
      </div>
      <p className="text-xs text-gray-500 mt-1">The mirror invoices are read-only history now. This compares the two numbers line by line and names every cent of difference. It is slow (reads both databases twice).</p>
      {s.state === 'error' && <p className="text-sm text-red-300 mt-2">{s.error}</p>}
      {s.state === 'ok' && (
        <div className="mt-3 text-sm tabular-nums">
          <p>This account: <span className={`font-bold ${moneyColor(s.data.ledger.brOwesUs)}`}>{usd(s.data.ledger.brOwesUs)}</span> · old mirror: <span className="font-bold">{usd(s.data.engine.brOwesUs)}</span> · difference (mirror − account): <span className="font-bold">{usd(s.data.difference)}</span></p>
          <ul className="mt-2 space-y-1 text-xs">{s.data.buckets.map(b => <li key={b.name}><span className="font-bold text-gray-200">{usd(b.usd)}</span> · {b.name} <span className="text-gray-500">— {b.note}</span></li>)}</ul>
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-gray-300">Lines with a different value in the mirror ({s.data.pairsOff.length})</summary><ul className="pl-4 mt-1 space-y-0.5 text-gray-400">{s.data.pairsOff.map(p => <li key={p.key}>{p.code || '—'} · {p.label.slice(0, 70)} · account {usd(p.ledgerUsd)} vs mirror {usd(p.mirrorUsd)} ({p.where}) → <span className="text-amber-300">{usd(p.diff)}</span></li>)}</ul></details>
          <details className="mt-2 text-xs"><summary className="cursor-pointer text-gray-300">Account lines with no mirror ({s.data.noMirror.length})</summary><ul className="pl-4 mt-1 space-y-0.5 text-gray-400">{s.data.noMirror.map(p => <li key={p.key}>{p.code || '—'} · {p.label.slice(0, 70)} · {usd(p.ledgerUsd)}</li>)}</ul></details>
          <details className="mt-2 text-xs"><summary className="cursor-pointer text-gray-300">Mirror lines with no account line ({s.data.orphans.length})</summary><ul className="pl-4 mt-1 space-y-0.5 text-gray-400">{s.data.orphans.map(o => <li key={o.table + o.id}>{o.side} {o.code} · {o.table} · {o.label.slice(0, 60)} · {usd(o.usd)} — {o.why}</li>)}</ul></details>
        </div>
      )}
    </section>
  )
}
