'use client'

// GZ28US vs GZ28BR Flow — QUANTO O BR DEVE AO US (14/set/2026).
//
// LEI (Márcio, 13/set/2026): «TODA E QUALQUER movimentação financeira entre o US e o BR tem que estar nas shopping
// invoices» · «EU PRECISO SABER QUANTO O BR DEVE PRO US, é o foco do momento!». Esta tela lê SÓ as shopping invoices
// dos dois apps, pela rota GET /api/crossing/balance (lib/crossingBalance.ts — a mesma régua da manchete do motor
// lib/crossing.server.ts):
//   BR deve ao US = aberto nas invoices do cliente GZ28BR no app US (006.N)  −  aberto nas invoices do cliente
//                   GZ28US no app BR (085.N), em US$.
// O mesmo número aparece no Balanço («Conta corrente GZ28BR») e no card do Data Checker — uma função, uma rota.
//
// O QUE SAIU DAQUI (14/set): o gráfico ALL HISTORY, os cartões GZ28BR GOT / GZ28BR PAID / BALANCE e a lista por mês.
// Todos somavam paid_from / paid_to / source SOLTOS nas sete tabelas de gasto e na renda — o número deles
// contradizia o das shopping invoices, e a lei manda ler só as shopping invoices. A cópia desta tela no app BR ainda
// roda a régua velha até o porte de lá.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import type { CrossingBalance, CrossingWarning, NotCountedReason, PendingDecision, UsInvoice, BrInvoice } from '@/lib/crossingBalance'

const formatUSD = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
const formatBRL = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
// O relógio: a rota devolve UTC; a tela mostra Orlando, com o fuso escrito.
const fmtNY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const whenNY = (s: string) => fmtNY.format(new Date(s)).replace(',', '') + ' (Orlando)'
// O DIA da baixa, no fuso do assunto (renda do US → Orlando; pagamento do BR → Brasília). Meia-noite UTC EXATA é data de
// calendário gravada crua, não instante (a régua de lib/paidNoBank.ts orlandoDay): o dia é o que está escrito.
function paidDay(ts: string, timeZone: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const iso = d.toISOString()
  const ymd = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone })
  return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`
}
const moneyColor = (v: number) => v > 0.004 ? 'text-emerald-400' : v < -0.004 ? 'text-red-400' : 'text-gray-400'

const REASON: Record<NotCountedReason, string> = {
  QUOTE: 'quote — not money yet',
  CAR_INVOICE: 'car invoice on the GZ28BR client — the balance counts only the invoices without a car (006.N)',
}
function warningText(w: CrossingWarning): string {
  switch (w.kind) {
    case 'not_counted_with_money': return `${w.code} (${w.side} app) is out of the balance — ${REASON[w.reason]} — but carries ${formatUSD(w.total)} billed and ${formatUSD(w.received)} received. Check whether it is a US ⇄ BR crossing.`
    case 'br_outside_engine_rule': return `${w.code}: services ${formatBRL(w.servicesBrl)}, FL tax ${w.flTaxPct}%, discount ${w.discountPct}% — the balance sums only line × quantity on the BR side, so these are NOT in the number.`
    case 'br_no_usd': return `${w.code}: ${w.lines} line(s) with no recorded US$ and no usd_rate on the invoice — they count as $0.00.`
    case 'br_converted_by_invoice_rate': return `${w.lines} BR line(s)/payment(s) have no recorded US$ and were converted by the invoice's own usd_rate (marked on each 085.N).`
  }
}

type State = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: CrossingBalance }

export default function GzFlowPage() {
  const [s, setS] = useState<State>({ state: 'loading' })
  const [openRow, setOpenRow] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/crossing/balance`, { headers: await sessionHeaders(), cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!alive) return
        if (r.ok && j.ok) setS({ state: 'ok', data: j as CrossingBalance })
        else setS({ state: 'error', error: String(j.error || `HTTP ${r.status}`) })
      } catch (e) { if (alive) setS({ state: 'error', error: String((e as Error)?.message || e) }) }
    })()
    return () => { alive = false }
  }, [])

  const toggle = (id: string) => setOpenRow(o => (o === id ? null : id))

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">GZ28US vs GZ28BR Flow</h1>
      <p className="text-gray-400 mb-6 max-w-4xl">Shopping invoices only: every money movement between GZ28US and GZ28BR lives on a shopping invoice in the other company&apos;s app. Loose PAID FROM / PAID TO fields are not read here.</p>
      {s.state === 'loading' ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : s.state === 'error' ? (
        <div className="bg-red-950/50 border border-red-900 rounded-2xl p-4 max-w-3xl">
          <p className="font-bold text-red-300">Balance NOT computed — no number is shown rather than a wrong one.</p>
          <p className="text-sm text-red-200 mt-1 break-words">{s.error}</p>
        </div>
      ) : (
        <Body data={s.data} openRow={openRow} toggle={toggle} />
      )}
    </main>
  )
}

function Body({ data, openRow, toggle }: { data: CrossingBalance; openRow: string | null; toggle: (id: string) => void }) {
  const us = data.usSide, br = data.brSide
  const owes = data.brOwesUs
  return (
    <div className="max-w-6xl">
      {/* A MANCHETE */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 mb-4">
        <p className="text-sm font-bold text-gray-400">HOW MUCH GZ28BR OWES GZ28US</p>
        <p className={`text-5xl font-bold tabular-nums mt-1 ${moneyColor(owes)}`}>{formatUSD(owes)}</p>
        <p className="text-sm text-gray-400 mt-2">
          {owes < -0.004 ? <>Negative: today <span className="font-bold text-red-300">GZ28US owes GZ28BR {formatUSD(-owes)}</span>.</> : owes > 0.004 ? <>GZ28BR owes GZ28US {formatUSD(owes)}.</> : <>Even.</>}
        </p>
        <p className="text-sm text-gray-300 mt-3 tabular-nums">
          <span className="text-blue-300">{formatUSD(us.totals.open)}</span> open on GZ28BR&apos;s invoices in the US app
          <span className="text-gray-500"> − </span>
          <span className="text-amber-300">{formatUSD(br.totals.open)}</span> open on GZ28US&apos;s invoices in the BR app
          <span className="text-gray-500"> = </span><span className={`font-bold ${moneyColor(owes)}`}>{formatUSD(owes)}</span>
        </p>
        <p className="text-xs text-gray-500 mt-2">Read {whenNY(data.generatedAt)} · the same number as the Balance sheet («Conta corrente GZ28BR») and the Data Checker card.</p>
      </div>

      {/* DECISÕES PENDENTES — à parte da manchete: nada daqui entra ou sai do número até o Márcio decidir */}
      {data.pending.decisions.length > 0 && <PendingBlock pending={data.pending} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3">
          <p className="text-xs font-bold text-gray-400">US APP · CLIENT GZ28 V8 SPEEDSHOP BR LTDA · {us.totals.invoices} INVOICES</p>
          <p className="text-sm text-gray-300 mt-1 tabular-nums">billed {formatUSD(us.totals.total)} − received {formatUSD(us.totals.received)}</p>
          <p className="text-xl font-bold text-blue-300 tabular-nums">{formatUSD(us.totals.open)} <span className="text-xs text-gray-500 font-normal">GZ28BR owes us</span></p>
        </div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3">
          <p className="text-xs font-bold text-gray-400">BR APP · CLIENT GZ28 V8 SPEEDSHOP USA LLC · {br.totals.invoices} INVOICES</p>
          <p className="text-sm text-gray-300 mt-1 tabular-nums">billed {formatUSD(br.totals.totalUsd)} ({formatBRL(br.totals.totalBrl)}) − paid {formatUSD(br.totals.receivedUsd)}</p>
          <p className="text-xl font-bold text-amber-300 tabular-nums">{formatUSD(br.totals.open)} <span className="text-xs text-gray-500 font-normal">we owe GZ28BR</span></p>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-900 rounded-2xl p-4 mb-6 text-sm text-amber-200">
          <p className="font-bold mb-1">CHECK</p>
          <ul className="list-disc pl-5 space-y-1">{data.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
        </div>
      )}

      {/* LADO US: 006.N */}
      <section className="mb-8">
        <h2 className="text-2xl font-bold mb-1">GZ28BR owes on its invoices in the US app <span className="text-gray-500 text-lg">(006.N)</span></h2>
        <p className="text-xs text-gray-500 mb-2">Total = items × qty + FL tax + services − discount (the BR US$ with the +10% is already inside the items). Received = incomes with a PAID date. A «Pending balance» row without a paid date is not money and is not counted.</p>
        <div className="overflow-x-auto border border-gray-800 rounded-2xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs">
              <tr><th className="text-left px-3 py-2">INVOICE</th><th className="text-left px-3 py-2">DESCRIPTION</th><th className="text-right px-3 py-2">TOTAL</th><th className="text-right px-3 py-2">RECEIVED</th><th className="text-right px-3 py-2">OPEN</th></tr>
            </thead>
            <tbody>
              {us.invoices.map(inv => <UsRow key={inv.id} inv={inv} open={openRow === inv.id} toggle={() => toggle(inv.id)} />)}
              <tr className="bg-gray-900 font-bold border-t border-gray-700 tabular-nums">
                <td className="px-3 py-2" colSpan={2}>TOTAL · {us.totals.invoices} invoices</td>
                <td className="px-3 py-2 text-right">{formatUSD(us.totals.total)}</td>
                <td className="px-3 py-2 text-right">{formatUSD(us.totals.received)}</td>
                <td className="px-3 py-2 text-right text-blue-300">{formatUSD(us.totals.open)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {us.notCounted.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-bold text-gray-500 mb-1">SAME CLIENT, NOT IN THE BALANCE</p>
            {us.notCounted.map(inv => (
              <p key={inv.id} className="text-gray-400">
                <a href={`${BASE_PATH}${inv.path}`} className="text-gray-300 hover:text-blue-400 hover:underline font-bold">{inv.code}</a>
                {inv.label ? ` · ${inv.label}` : ''} · billed {formatUSD(inv.total)} · received {formatUSD(inv.received)} — <span className="text-gray-500">{inv.reason ? REASON[inv.reason] : ''}</span>
              </p>
            ))}
          </div>
        )}
      </section>

      {/* LADO BR: 085.N */}
      <section className="mb-8">
        <h2 className="text-2xl font-bold mb-1">GZ28US owes on its invoices in the BR app <span className="text-gray-500 text-lg">(085.N)</span></h2>
        <p className="text-xs text-gray-500 mb-2">No markup. US$ = the US$ recorded on each BR line and payment; only where none is recorded, R$ ÷ the invoice&apos;s usd_rate (marked). Paid = BR payments with a PAID date.</p>
        <div className="overflow-x-auto border border-gray-800 rounded-2xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs">
              <tr><th className="text-left px-3 py-2">INVOICE</th><th className="text-left px-3 py-2">DESCRIPTION</th><th className="text-right px-3 py-2">TOTAL R$</th><th className="text-right px-3 py-2">TOTAL US$</th><th className="text-right px-3 py-2">PAID US$</th><th className="text-right px-3 py-2">OPEN US$</th></tr>
            </thead>
            <tbody>
              {br.invoices.map(inv => <BrRow key={inv.id} inv={inv} open={openRow === inv.id} toggle={() => toggle(inv.id)} />)}
              <tr className="bg-gray-900 font-bold border-t border-gray-700 tabular-nums">
                <td className="px-3 py-2" colSpan={2}>TOTAL · {br.totals.invoices} invoices{br.totals.convertedByInvoiceRate ? ` · ${br.totals.convertedByInvoiceRate} converted by invoice rate` : ''}</td>
                <td className="px-3 py-2 text-right">{formatBRL(br.totals.totalBrl)}</td>
                <td className="px-3 py-2 text-right">{formatUSD(br.totals.totalUsd)}</td>
                <td className="px-3 py-2 text-right">{formatUSD(br.totals.receivedUsd)}</td>
                <td className="px-3 py-2 text-right text-amber-300">{formatUSD(br.totals.open)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {br.notCounted.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-bold text-gray-500 mb-1">SAME CLIENT, NOT IN THE BALANCE</p>
            {br.notCounted.map(inv => (
              <p key={inv.id} className="text-gray-400">
                <a href={inv.url} target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-blue-400 hover:underline font-bold">{inv.code} ↗</a>
                {inv.label ? ` · ${inv.label}` : ''} · billed {formatUSD(inv.totalUsd)} · paid {formatUSD(inv.receivedUsd)} — <span className="text-gray-500">{inv.reason ? REASON[inv.reason] : ''}</span>
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

const POSITION: Record<PendingDecision['position'], { label: string; cls: string }> = {
  inside: { label: 'INSIDE THE NUMBER', cls: 'text-amber-300 border-amber-800' },
  outside: { label: 'NOT IN THE NUMBER', cls: 'text-sky-300 border-sky-800' },
  undetermined: { label: 'NO AMOUNT TO DECIDE YET', cls: 'text-gray-400 border-gray-700' },
}
function PendingBlock({ pending }: { pending: CrossingBalance['pending'] }) {
  return (
    <div className="bg-gray-950 border border-amber-900/70 rounded-2xl p-4 mb-6">
      <p className="text-sm font-bold text-amber-300">PENDING DECISIONS — {pending.decisions.length} · not applied to the number above</p>
      <p className="text-xs text-gray-400 mt-1 tabular-nums">
        If every suspicion is confirmed, the number could go down by <span className="text-red-300 font-bold">{formatUSD(pending.couldLower)}</span> and up by <span className="text-emerald-300 font-bold">{formatUSD(pending.couldRaise)}</span>{pending.undetermined ? <> · {pending.undetermined} still without an amount</> : null}.
      </p>
      <div className="mt-3 space-y-3">
        {pending.decisions.map(p => (
          <div key={p.key} className="border-t border-gray-800 pt-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-gray-200">
                <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 mr-2 align-middle ${POSITION[p.position].cls}`}>{POSITION[p.position].label}</span>
                {p.note}
              </p>
              <p className="text-sm font-bold tabular-nums whitespace-nowrap">
                {p.atStake == null ? <span className="text-gray-500">amount not recorded</span> : <>{formatUSD(p.atStake)} at stake</>}
                {p.effectIfConfirmed != null && <span className={`ml-2 text-xs ${p.effectIfConfirmed < 0 ? 'text-red-300' : 'text-emerald-300'}`}>({p.effectIfConfirmed < 0 ? '−' : '+'}{formatUSD(Math.abs(p.effectIfConfirmed))} if confirmed)</span>}
              </p>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-400">
              {p.refs.map((r, i) => (
                <span key={i} className="tabular-nums">
                  {r.exists && r.href
                    ? <a href={r.external ? r.href : `${BASE_PATH}${r.href}`} target={r.external ? '_blank' : undefined} rel={r.external ? 'noopener noreferrer' : undefined} className="font-bold text-gray-300 hover:text-blue-400 hover:underline">{r.side} {r.code}{r.external ? ' ↗' : ''}</a>
                    : <span className="font-bold text-gray-500">{r.side} {r.code}</span>}
                  {r.label ? <span className="text-gray-500"> · {r.label.length > 60 ? r.label.slice(0, 59) + '…' : r.label}</span> : null}
                  {r.usd != null ? <span> · {formatUSD(r.usd)}</span> : null}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-gray-600 mt-0.5">open since {p.since.slice(5, 7)}/{p.since.slice(8, 10)}/{p.since.slice(0, 4)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function UsRow({ inv, open, toggle }: { inv: UsInvoice; open: boolean; toggle: () => void }) {
  // «Pending balance» que não bate com o aberto: aviso visual (o motor da travessia é quem acerta a linha).
  const pendingOff = inv.pendingN > 0 && Math.abs(inv.pending - Math.max(inv.open, 0)) > 0.02
  return (
    <>
      <tr className="border-t border-gray-800 tabular-nums hover:bg-gray-900/60">
        <td className="px-3 py-2 whitespace-nowrap">
          <button onClick={toggle} className="text-gray-500 hover:text-white mr-1" aria-label="lines">{open ? '▾' : '▸'}</button>
          <a href={`${BASE_PATH}${inv.path}`} className="font-bold text-gray-200 hover:text-blue-400 hover:underline">{inv.code}</a>
        </td>
        <td className="px-3 py-2 text-gray-400 max-w-md truncate" title={inv.label}>{inv.label || '—'}{inv.status === 'CLOSED' ? <span className="ml-2 text-xs text-gray-600">CLOSED</span> : null}</td>
        <td className="px-3 py-2 text-right">{formatUSD(inv.total)}</td>
        <td className="px-3 py-2 text-right">{formatUSD(inv.received)}</td>
        <td className={`px-3 py-2 text-right font-bold ${moneyColor(inv.open)}`}>
          {formatUSD(inv.open)}
          {pendingOff && <span className="block text-xs font-normal text-amber-400" title="the unpaid «Pending balance» row(s) on this invoice differ from the open amount — not counted either way">pending row {formatUSD(inv.pending)}</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-950">
          <td colSpan={5} className="px-6 py-2 text-xs text-gray-400">
            {inv.items.map(l => <Line key={l.id} left={`item · ${l.description || '—'}${l.quantity !== 1 ? ` · ${l.quantity} × ${formatUSD(l.unitPrice)}` : ''}`} right={formatUSD(l.usd)} />)}
            {inv.serviceLines.map(l => <Line key={l.id} left={`service · ${l.description || '—'}`} right={formatUSD(l.usd)} />)}
            {inv.flTaxPct ? <Line left={`FL tax ${inv.flTaxPct}%`} right="" /> : null}
            {inv.discountPct ? <Line left={`discount ${inv.discountPct}%`} right="" /> : null}
            {inv.incomes.map(p => <Line key={p.id} dim={!p.counted} left={`income · ${p.paidAt ? 'paid ' + paidDay(p.paidAt, 'America/New_York') : 'NOT PAID (not counted)'} · ${p.description || '—'}`} right={formatUSD(p.usd)} />)}
            {!inv.items.length && !inv.serviceLines.length && !inv.incomes.length && <p>no lines</p>}
          </td>
        </tr>
      )}
    </>
  )
}

function BrRow({ inv, open, toggle }: { inv: BrInvoice; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr className="border-t border-gray-800 tabular-nums hover:bg-gray-900/60">
        <td className="px-3 py-2 whitespace-nowrap">
          <button onClick={toggle} className="text-gray-500 hover:text-white mr-1" aria-label="lines">{open ? '▾' : '▸'}</button>
          <a href={inv.url} target="_blank" rel="noopener noreferrer" className="font-bold text-gray-200 hover:text-blue-400 hover:underline">{inv.code} ↗</a>
        </td>
        <td className="px-3 py-2 text-gray-400 max-w-md truncate" title={inv.label}>{inv.label || '—'}</td>
        <td className="px-3 py-2 text-right">{formatBRL(inv.totalBrl)}</td>
        <td className="px-3 py-2 text-right">{formatUSD(inv.totalUsd)}{inv.convertedByInvoiceRate ? <span className="block text-xs text-amber-400">{inv.convertedByInvoiceRate} by rate {inv.usdRate ?? '—'}</span> : null}</td>
        <td className="px-3 py-2 text-right">{formatUSD(inv.receivedUsd)}</td>
        <td className={`px-3 py-2 text-right font-bold ${inv.open > 0.004 ? 'text-amber-300' : moneyColor(inv.open)}`}>{formatUSD(inv.open)}</td>
      </tr>
      {open && (
        <tr className="bg-gray-950">
          <td colSpan={6} className="px-6 py-2 text-xs text-gray-400">
            {inv.lines.map(l => <Line key={l.id} left={`line · ${l.description || '—'} · ${formatBRL(l.brl)}${l.usdFrom === 'invoice_usd_rate' ? ` ÷ rate ${inv.usdRate}` : l.usdFrom === 'none' ? ' · NO US$ AND NO RATE' : ' · recorded US$'}`} right={formatUSD(l.usd)} />)}
            {inv.payments.map(p => <Line key={p.id} dim={!p.counted} left={`payment · ${p.paidAt ? 'paid ' + paidDay(p.paidAt, 'America/Sao_Paulo') : 'NOT PAID (not counted)'} · ${formatBRL(p.brl)}${p.usdFrom === 'invoice_usd_rate' ? ` ÷ rate ${inv.usdRate}` : p.usdFrom === 'none' ? ' · NO US$ AND NO RATE' : ' · recorded US$'} · ${p.description || '—'}`} right={formatUSD(p.usd)} />)}
            {!inv.lines.length && !inv.payments.length && <p>no lines</p>}
          </td>
        </tr>
      )}
    </>
  )
}

function Line({ left, right, dim }: { left: string; right: string; dim?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-0.5 border-b border-gray-900 last:border-0 ${dim ? 'text-gray-600' : ''}`}>
      <span className="truncate" title={left}>{left}</span>
      <span className="tabular-nums shrink-0">{right}</span>
    </div>
  )
}
