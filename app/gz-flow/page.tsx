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

// AS DUAS ERAS (Márcio, 17/10/2026: «Nesta página, separe o report em 2 blocos, o primeiro até 31/12/25, depois de 01/01/26 pra
// frente, 2 eras totalmente diferentes. Depois um report simplificado unificado, dos 2 momentos, em destaque.»). A era de cada
// dinheiro é a do DIA DELE — item/parte pela payment_date, renda/pagamento pelo dia da baixa. No lado US nenhuma 006.N atravessa
// a virada (medido em 17/10), então a invoice inteira vai para a era da sua 1ª linha datada; no lado BR uma 085.N pode ter
// linhas nas duas eras e aparece nas duas, cada uma com a sua parte. Linha sem data segue a 1ª linha datada da invoice (ou a
// data da invoice). A soma das duas eras é o número do motor (lib/crossingBalance — o mesmo do Balanço e do Data Checker).
const ERA_CUT = '2026-01-01'
type Era = 'E1' | 'E2'
const ERAS: { key: Era; title: string; short: string; range: string }[] = [
  { key: 'E1', title: 'ERA 1 · UP TO 12/31/2025', short: 'Era 1 · up to 12/31/2025', range: 'every money line dated up to 12/31/2025' },
  { key: 'E2', title: 'ERA 2 · FROM 01/01/2026', short: 'Era 2 · from 01/01/2026', range: 'every money line dated 01/01/2026 onward' },
]
const r2 = (v: number) => Math.round(v * 100) / 100
const eraOf = (d: string | null | undefined): Era | null => (d ? (d.slice(0, 10) < ERA_CUT ? 'E1' : 'E2') : null)
function ymdIn(ts: string | null, timeZone: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d.getTime())) return null
  const iso = d.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone })
}
const usPayDay = (p: { paymentDate: string | null; paidAt: string | null }) => (p.paymentDate ? p.paymentDate.slice(0, 10) : ymdIn(p.paidAt, 'America/New_York'))
const brPayDay = (p: { paymentDate: string | null; paidAt: string | null }) => (p.paymentDate ? p.paymentDate.slice(0, 10) : ymdIn(p.paidAt, 'America/Sao_Paulo'))
// A 006.N inteira numa era: a da 1ª linha datada que conta. `both` = tem linha nas duas (hoje nenhuma; se surgir, a tela avisa).
function usEra(inv: UsInvoice): { era: Era; both: boolean } {
  const ds = [...inv.items.filter(i => i.counted).map(i => i.day), ...inv.incomes.filter(p => p.counted).map(usPayDay)].filter(Boolean).sort() as string[]
  const eras = new Set(ds.map(eraOf))
  return { era: eraOf(ds[0] || inv.day) || 'E2', both: eras.size > 1 }
}
type BrPiece = BrInvoice & { split: boolean }
// A 085.N fatiada por era: só as linhas e os pagamentos daquela era, com os totais recalculados.
function brPieces(inv: BrInvoice): Record<Era, BrPiece | null> {
  const ds = [...inv.lines.map(l => l.day), ...inv.payments.filter(p => p.counted).map(brPayDay)].filter(Boolean).sort() as string[]
  const fb: Era = eraOf(ds[0] || inv.day) || 'E2'
  const lineEra = (l: BrInvoice['lines'][number]) => eraOf(l.day) || fb
  const payEra = (p: BrInvoice['payments'][number]) => eraOf(brPayDay(p)) || fb
  const both = new Set([...inv.lines.map(lineEra), ...inv.payments.filter(p => p.counted).map(payEra)]).size > 1
  const piece = (era: Era): BrPiece | null => {
    const lines = inv.lines.filter(l => lineEra(l) === era), payments = inv.payments.filter(p => payEra(p) === era)
    if (!lines.length && !payments.length) return null
    const totalUsd = r2(lines.reduce((s, l) => s + l.usd, 0)), receivedUsd = r2(payments.filter(p => p.counted).reduce((s, p) => s + p.usd, 0))
    return { ...inv, lines, payments, totalUsd, totalBrl: r2(lines.reduce((s, l) => s + l.brl, 0)), receivedUsd, open: r2(totalUsd - receivedUsd), split: both }
  }
  return { E1: piece('E1'), E2: piece('E2') }
}
type EraData = { us: (UsInvoice & { both: boolean })[]; br: BrPiece[]; usTotal: number; usReceived: number; usOpen: number; brTotalUsd: number; brTotalBrl: number; brPaid: number; brOpen: number; owes: number }
function splitEras(data: CrossingBalance): Record<Era, EraData> {
  const out = {} as Record<Era, EraData>
  for (const { key } of ERAS) out[key] = { us: [], br: [], usTotal: 0, usReceived: 0, usOpen: 0, brTotalUsd: 0, brTotalBrl: 0, brPaid: 0, brOpen: 0, owes: 0 }
  for (const inv of data.usSide.invoices) { const { era, both } = usEra(inv); out[era].us.push({ ...inv, both }) }
  for (const inv of data.brSide.invoices) { const p = brPieces(inv); for (const { key } of ERAS) if (p[key]) out[key].br.push(p[key]!) }
  for (const { key } of ERAS) {
    const e = out[key]
    e.usTotal = r2(e.us.reduce((s, i) => s + i.total, 0)); e.usReceived = r2(e.us.reduce((s, i) => s + i.received, 0)); e.usOpen = r2(e.usTotal - e.usReceived)
    e.brTotalUsd = r2(e.br.reduce((s, i) => s + i.totalUsd, 0)); e.brTotalBrl = r2(e.br.reduce((s, i) => s + i.totalBrl, 0)); e.brPaid = r2(e.br.reduce((s, i) => s + i.receivedUsd, 0)); e.brOpen = r2(e.brTotalUsd - e.brPaid)
    e.owes = r2(e.usOpen - e.brOpen)
  }
  return out
}

function Body({ data, openRow, toggle }: { data: CrossingBalance; openRow: string | null; toggle: (id: string) => void }) {
  const us = data.usSide, br = data.brSide
  const owes = data.brOwesUs
  const eras = splitEras(data)
  const sumEras = r2(eras.E1.owes + eras.E2.owes)
  return (
    <div className="max-w-6xl">
      {/* O RESUMO UNIFICADO, EM DESTAQUE — as duas eras numa conta só (Márcio, 17/10/2026) */}
      <div className="bg-gray-900 border-2 border-blue-700 rounded-2xl p-5 mb-4">
        <p className="text-sm font-bold text-blue-300">SUMMARY · BOTH ERAS · HOW MUCH GZ28BR OWES GZ28US</p>
        <p className={`text-5xl font-bold tabular-nums mt-1 ${moneyColor(owes)}`}>{formatUSD(owes)}</p>
        <p className="text-sm text-gray-400 mt-2">
          {owes < -0.004 ? <>Negative: today <span className="font-bold text-red-300">GZ28US owes GZ28BR {formatUSD(-owes)}</span>.</> : owes > 0.004 ? <>GZ28BR owes GZ28US {formatUSD(owes)}.</> : <>Even.</>}
        </p>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-gray-400 text-xs">
              <tr><th className="text-left py-1 pr-3">ERA</th><th className="text-right py-1 px-3">OPEN ON 006.N (US app)</th><th className="text-right py-1 px-3">OPEN ON 085.N (BR app)</th><th className="text-right py-1 pl-3">GZ28BR OWES GZ28US</th></tr>
            </thead>
            <tbody>
              {ERAS.map(({ key, short }) => (
                <tr key={key} className="border-t border-gray-800">
                  <td className="py-1.5 pr-3 font-bold text-gray-200">{short}</td>
                  <td className="py-1.5 px-3 text-right text-blue-300">{formatUSD(eras[key].usOpen)}</td>
                  <td className="py-1.5 px-3 text-right text-amber-300">{formatUSD(eras[key].brOpen)}</td>
                  <td className={`py-1.5 pl-3 text-right font-bold ${moneyColor(eras[key].owes)}`}>{formatUSD(eras[key].owes)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-600 font-bold">
                <td className="py-1.5 pr-3">TOTAL</td>
                <td className="py-1.5 px-3 text-right text-blue-300">{formatUSD(us.totals.open)}</td>
                <td className="py-1.5 px-3 text-right text-amber-300">{formatUSD(br.totals.open)}</td>
                <td className={`py-1.5 pl-3 text-right ${moneyColor(owes)}`}>{formatUSD(owes)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {Math.abs(sumEras - owes) > 0.05 && <p className="text-xs text-amber-400 mt-2">The two eras add up to {formatUSD(sumEras)} (line-by-line rounding) — the total above is the engine&apos;s number.</p>}
        <p className="text-xs text-gray-500 mt-2">Read {whenNY(data.generatedAt)} · the same total as the Balance sheet («Conta corrente GZ28BR») and the Data Checker card. Each line goes to the era of its own date (item: payment date; income/payment: the day it was paid).</p>
      </div>

      {/* DECISÕES PENDENTES — à parte da manchete: nada daqui entra ou sai do número até o Márcio decidir */}
      {data.pending.decisions.length > 0 && <PendingBlock pending={data.pending} />}

      {data.warnings.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-900 rounded-2xl p-4 mb-6 text-sm text-amber-200">
          <p className="font-bold mb-1">CHECK</p>
          <ul className="list-disc pl-5 space-y-1">{data.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
        </div>
      )}

      {ERAS.map(({ key, title, range }) => <EraBlock key={key} title={title} range={range} e={eras[key]} openRow={openRow} toggle={toggle} />)}

      {/* FORA DO SALDO — o mesmo cliente, fora da conta (vale para as duas eras) */}
      <section className="mb-8">
        {us.notCounted.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-bold text-gray-500 mb-1">US APP · SAME CLIENT, NOT IN THE BALANCE</p>
            {us.notCounted.map(inv => (
              <p key={inv.id} className="text-gray-400">
                <a href={`${BASE_PATH}${inv.path}`} className="text-gray-300 hover:text-blue-400 hover:underline font-bold">{inv.code}</a>
                {inv.label ? ` · ${inv.label}` : ''} · billed {formatUSD(inv.total)} · received {formatUSD(inv.received)} — <span className="text-gray-500">{inv.reason ? REASON[inv.reason] : ''}</span>
              </p>
            ))}
          </div>
        )}
        {br.notCounted.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-bold text-gray-500 mb-1">BR APP · SAME CLIENT, NOT IN THE BALANCE</p>
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

// UMA ERA: os dois lados daquela era, com o saldo dela.
function EraBlock({ title, range, e, openRow, toggle }: { title: string; range: string; e: EraData; openRow: string | null; toggle: (id: string) => void }) {
  return (
    <section className="mb-10 border border-gray-800 rounded-2xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="text-2xl font-bold">{title}</h2>
          <p className="text-xs text-gray-500">{range}</p>
        </div>
        <p className="text-sm text-gray-300 tabular-nums">
          <span className="text-blue-300">{formatUSD(e.usOpen)}</span><span className="text-gray-500"> − </span><span className="text-amber-300">{formatUSD(e.brOpen)}</span><span className="text-gray-500"> = </span>
          <span className={`text-xl font-bold ${moneyColor(e.owes)}`}>{formatUSD(e.owes)}</span> <span className="text-xs text-gray-500">GZ28BR owes GZ28US in this era</span>
        </p>
      </div>

      <h3 className="text-lg font-bold mb-1">GZ28BR owes on its invoices in the US app <span className="text-gray-500 text-base">(006.N)</span></h3>
      <p className="text-xs text-gray-500 mb-2">Total = items × qty + FL tax + services − discount (the BR US$ with the +10% is already inside the items). Received = incomes with a PAID date. A «Pending balance» row without a paid date is not money and is not counted.</p>
      <div className="overflow-x-auto border border-gray-800 rounded-2xl mb-5">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400 text-xs">
            <tr><th className="text-left px-3 py-2">INVOICE</th><th className="text-left px-3 py-2">DESCRIPTION</th><th className="text-right px-3 py-2">TOTAL</th><th className="text-right px-3 py-2">RECEIVED</th><th className="text-right px-3 py-2">OPEN</th></tr>
          </thead>
          <tbody>
            {e.us.map(inv => <UsRow key={inv.id} inv={inv} both={inv.both} open={openRow === inv.id} toggle={() => toggle(inv.id)} />)}
            {!e.us.length && <tr><td colSpan={5} className="px-3 py-2 text-gray-500">none in this era</td></tr>}
            <tr className="bg-gray-900 font-bold border-t border-gray-700 tabular-nums">
              <td className="px-3 py-2" colSpan={2}>TOTAL · {e.us.length} invoices</td>
              <td className="px-3 py-2 text-right">{formatUSD(e.usTotal)}</td>
              <td className="px-3 py-2 text-right">{formatUSD(e.usReceived)}</td>
              <td className="px-3 py-2 text-right text-blue-300">{formatUSD(e.usOpen)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 className="text-lg font-bold mb-1">GZ28US owes on its invoices in the BR app <span className="text-gray-500 text-base">(085.N)</span></h3>
      <p className="text-xs text-gray-500 mb-2">No markup. US$ = the US$ recorded on each BR line and payment; only where none is recorded, R$ ÷ the invoice&apos;s usd_rate (marked). Paid = BR payments with a PAID date. An invoice with lines in both eras shows here only its part of this era.</p>
      <div className="overflow-x-auto border border-gray-800 rounded-2xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400 text-xs">
            <tr><th className="text-left px-3 py-2">INVOICE</th><th className="text-left px-3 py-2">DESCRIPTION</th><th className="text-right px-3 py-2">TOTAL R$</th><th className="text-right px-3 py-2">TOTAL US$</th><th className="text-right px-3 py-2">PAID US$</th><th className="text-right px-3 py-2">OPEN US$</th></tr>
          </thead>
          <tbody>
            {e.br.map(inv => <BrRow key={inv.id} inv={inv} split={inv.split} open={openRow === title + inv.id} toggle={() => toggle(title + inv.id)} />)}
            {!e.br.length && <tr><td colSpan={6} className="px-3 py-2 text-gray-500">none in this era</td></tr>}
            <tr className="bg-gray-900 font-bold border-t border-gray-700 tabular-nums">
              <td className="px-3 py-2" colSpan={2}>TOTAL · {e.br.length} invoices</td>
              <td className="px-3 py-2 text-right">{formatBRL(e.brTotalBrl)}</td>
              <td className="px-3 py-2 text-right">{formatUSD(e.brTotalUsd)}</td>
              <td className="px-3 py-2 text-right">{formatUSD(e.brPaid)}</td>
              <td className="px-3 py-2 text-right text-amber-300">{formatUSD(e.brOpen)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
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

function UsRow({ inv, both, open, toggle }: { inv: UsInvoice; both?: boolean; open: boolean; toggle: () => void }) {
  // «Pending balance» que não bate com o aberto: aviso visual (o motor da travessia é quem acerta a linha).
  const pendingOff = inv.pendingN > 0 && Math.abs(inv.pending - Math.max(inv.open, 0)) > 0.02
  return (
    <>
      <tr className="border-t border-gray-800 tabular-nums hover:bg-gray-900/60">
        <td className="px-3 py-2 whitespace-nowrap">
          <button onClick={toggle} className="text-gray-500 hover:text-white mr-1" aria-label="lines">{open ? '▾' : '▸'}</button>
          <a href={`${BASE_PATH}${inv.path}`} className="font-bold text-gray-200 hover:text-blue-400 hover:underline">{inv.code}</a>
        </td>
        <td className="px-3 py-2 text-gray-400 max-w-md truncate" title={inv.label}>{inv.label || '—'}{inv.status === 'CLOSED' ? <span className="ml-2 text-xs text-gray-600">CLOSED</span> : null}{both ? <span className="ml-2 text-xs text-amber-400" title="this 006.N has money lines in both eras — it is shown whole in the era of its first dated line">BOTH ERAS</span> : null}</td>
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
            {/* Item estornado/cancelado (lib/estorno.ts): fica na lista, apagado e riscado, fora do total. */}
            {inv.items.map(l => <Line key={l.id} dim={!l.counted} left={`item · ${l.counted ? '' : `${l.cancelStatus || 'CANCELLED'} (not counted) · `}${l.description || '—'}${l.quantity !== 1 ? ` · ${l.quantity} × ${formatUSD(l.unitPrice)}` : ''}`} right={formatUSD(l.usd)} strike={!l.counted} />)}
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

function BrRow({ inv, split, open, toggle }: { inv: BrInvoice; split?: boolean; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr className="border-t border-gray-800 tabular-nums hover:bg-gray-900/60">
        <td className="px-3 py-2 whitespace-nowrap">
          <button onClick={toggle} className="text-gray-500 hover:text-white mr-1" aria-label="lines">{open ? '▾' : '▸'}</button>
          <a href={inv.url} target="_blank" rel="noopener noreferrer" className="font-bold text-gray-200 hover:text-blue-400 hover:underline">{inv.code} ↗</a>
        </td>
        <td className="px-3 py-2 text-gray-400 max-w-md truncate" title={inv.label}>{inv.label || '—'}{split ? <span className="ml-2 text-xs text-amber-400" title="this 085.N has lines in both eras — only this era's part is here">PART OF THIS ERA</span> : null}</td>
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

function Line({ left, right, dim, strike }: { left: string; right: string; dim?: boolean; strike?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-0.5 border-b border-gray-900 last:border-0 ${dim ? 'text-gray-600' : ''}`}>
      <span className="truncate" title={left}>{left}</span>
      <span className={`tabular-nums shrink-0 ${strike ? 'line-through' : ''}`}>{right}</span>
    </div>
  )
}
