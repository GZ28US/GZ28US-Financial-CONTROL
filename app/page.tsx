'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtD(v: string | null) { return v ? String(v).slice(0, 10) : '' }

// Collapse any stored milestone label (incl. legacy long forms like
// "Goods Arrival" / "Project Conclusion") to its canonical short code, so old
// and new rows land in the SAME group.
function canonMilestone(v: string | null | undefined): string | undefined {
  if (!v || !v.trim()) return undefined
  const s = v.trim().toLowerCase()
  if (s.includes('arrival')) return 'ARRIVAL'
  if (s.includes('conclusion')) return 'CONCLUSION'
  return v.trim()
}

type GlobalStats = { cashFlow: number; cashFlowPct: number; dueClients: number; markup: number; markupPct: number; dueGz: number }
type Row = { code: string; label: string; amount: number; dated: boolean; date: string | null; href: string; tip: string; labelTip?: string; milestone?: string }
// A dated cash-flow entry for the monthly-flow box: income is +, expense is −.
type FlowItem = { date: string; code: string; label: string; href: string; signed: number }

export default function HomePage() {
  const [s, setS] = useState<GlobalStats>({ cashFlow: 0, cashFlowPct: 0, dueClients: 0, markup: 0, markupPct: 0, dueGz: 0 })
  const [rows, setRows] = useState<{ income: Row[]; expense: Row[]; tax: Row[]; loss: Row[] }>({ income: [], expense: [], tax: [], loss: [] })
  const [flow, setFlow] = useState<FlowItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    // EVERYTHING, all time — every REPORT-READY (non-quote, ONLINE/CLOSED) invoice and its children.
    const [{ data: invs }, { data: pays }, { data: exps }, { data: parts }] = await Promise.all([
      supabase.from('invoices').select('id, invoice_code, ride_id, client_id, service, florida_taxes, fl_tax_expense_date').eq('is_quote', false).in('live_status', ['REALTIME', 'CLOSED']),
      supabase.from('invoice_payments').select('invoice_id, amount, paid_at, payment_date, source, description, date_label'),
      supabase.from('invoice_expenses').select('invoice_id, price, quantity, expense_date, payment_date, tax, extra, item, supplier'),
      supabase.from('invoice_parts').select('invoice_id, unit_price, quantity'),
    ])

    // Stock-sale income per donor invoice (a donated part another car pulled from stock),
    // matched via the inventory note's "From <invoice code>" prefix.
    const stockByCode = new Map<string, { all: number; paid: number }>()
    const [{ data: donInv }, { data: pulls }] = await Promise.all([
      supabase.from('inventory').select('description, donor, notes').eq('category', 'STOCK').eq('source_type', 'DONATED'),
      supabase.from('invoice_expenses').select('item, stock_donor, payment_date, price, quantity').not('stock_donor', 'is', null),
    ])
    const donorCodeByKey = new Map<string, string>()
    ;(donInv || []).forEach((r: any) => { const mm = (r.notes || '').match(/^From\s+(\S+)\s+—/); if (mm) donorCodeByKey.set(`${(r.donor || '').trim().toLowerCase()}|${(r.description || '').trim().toLowerCase()}`, mm[1]) })
    ;(pulls || []).forEach((e: any) => {
      const code = donorCodeByKey.get(`${(e.stock_donor || '').trim().toLowerCase()}|${(e.item || '').trim().toLowerCase()}`)
      if (!code) return
      const amt = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1)
      const cur = stockByCode.get(code) || { all: 0, paid: 0 }
      cur.all += amt; if (isValidDate(e.payment_date)) cur.paid += amt
      stockByCode.set(code, cur)
    })

    const group = <T extends { invoice_id: string }>(rs: T[] | null) => {
      const m = new Map<string, T[]>()
      for (const r of rs || []) { const a = m.get(r.invoice_id) || []; a.push(r); m.set(r.invoice_id, a) }
      return m
    }
    const paysBy = group(pays), expsBy = group(exps), partsBy = group(parts)
    const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
    // Per-invoice FINAL MARKUP; invoices with a negative markup are LOSSES, surfaced in
    // their own group in the DUE by CLIENTS column (separate from the unpaid incomes).
    const lossByInvoice = new Map<string, { amount: number; pct: number }>()

    // Resolve each invoice's client + car for the VIEW link/tooltip.
    const [{ data: ridesD }, { data: clientsD }] = await Promise.all([
      supabase.from('rides').select('id, project_name, model, version, client_id'),
      supabase.from('clients').select('id, name'),
    ])
    const ridesById = new Map<string, any>(); (ridesD || []).forEach((r: any) => ridesById.set(r.id, r))
    const clientsById = new Map<string, string>(); (clientsD || []).forEach((c: any) => clientsById.set(c.id, c.name || ''))

    const codeById = new Map<string, string>()
    const metaById = new Map<string, { href: string; tip: string; carInvTip: string; clientName: string; carName: string; invoiceName: string }>()
    const metaByCode = new Map<string, { href: string; tip: string; carInvTip: string; clientName: string; carName: string; invoiceName: string }>()
    for (const inv of invs || []) {
      const ride = inv.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv.client_id || ride?.client_id || null
      codeById.set(inv.id, inv.invoice_code)
      const clientName = cid ? (clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const invoiceName = inv.service || inv.invoice_code
      const ownerSeg = inv.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      const meta = {
        href: `${BASE_PATH}/${ownerSeg}/invoices/${inv.id}`,
        tip: [clientName, carName, invoiceName].filter(Boolean).join(' — '),   // full (expenses)
        carInvTip: [carName, invoiceName].filter(Boolean).join(' — '),         // car — invoice (incomes/loss code)
        clientName, carName, invoiceName,
      }
      metaById.set(inv.id, meta); metaByCode.set(inv.invoice_code, meta)
    }
    const metaFor = (id?: string, code?: string) => (id && metaById.get(id)) || (code && metaByCode.get(code)) || { href: '#', tip: code || '', carInvTip: code || '', clientName: '', carName: '', invoiceName: '' }

    let cashFlow = 0, dueClients = 0, markup = 0, dueGz = 0, sumExpPaid = 0, sumExpGlobal = 0
    for (const inv of invs || []) {
      const ip = paysBy.get(inv.id) || []
      const ie = expsBy.get(inv.id) || []
      const ipa = partsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((x: number, p: any) => x + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
      const ss = stockByCode.get(inv.invoice_code) || { all: 0, paid: 0 }
      const paymentsSum = ip.reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0)
      const totalPaid = ip.filter((p: any) => !!p.paid_at).reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0) + ss.paid
      const totalIncomeAll = paymentsSum + ss.all
      const expensesTotalGlobal = flTaxAmount + ie.reduce((x: number, e: any) => x + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + ie.filter((e: any) => isValidDate(e.payment_date)).reduce((x: number, e: any) => x + expenseLine(e), 0)
      cashFlow += totalPaid - expensesTotalPaid
      dueClients += totalIncomeAll - totalPaid
      // FINAL MARKUP = listed income − expenses (the invoice's real result, matching its card);
      // a negative value = LOSS invoice. Pending balances are collected via the editor's
      // ADD PENDING BALANCE button, so they don't auto-mask a loss here.
      const invMarkup = totalIncomeAll - expensesTotalGlobal
      if (invMarkup < -0.005) lossByInvoice.set(inv.id, { amount: invMarkup, pct: expensesTotalGlobal > 0 ? (invMarkup / expensesTotalGlobal) * 100 : 0 })
      markup += invMarkup
      dueGz += expensesTotalPaid - expensesTotalGlobal
      sumExpPaid += expensesTotalPaid
      sumExpGlobal += expensesTotalGlobal
    }

    // Detail rows below the boxes: only DUE (unpaid) rows — already-paid ones carry no DUE.
    // Income is PAID when paid_at is set; an unpaid income is DATED if it has a scheduled
    // payment_date (e.g. an installment due-date), UNDATED if it has none.
    // Income rows show the CLIENT NAME (the description is the label's rollover); the code's
    // rollover is car — invoice.
    const income: Row[] = []
    for (const p of pays || []) {
      const code = codeById.get(p.invoice_id); if (!code) continue
      if (p.paid_at) continue
      const amount = parseFloat(p.amount) || 0; if (!amount) continue
      const dated = isValidDate(p.payment_date)
      const m = metaFor(p.invoice_id, code)
      const desc = p.description || p.source || 'Income'
      income.push({ code, label: m.clientName || desc, amount, dated, date: dated ? fmtD(p.payment_date) : null, href: m.href, tip: m.carInvTip, labelTip: desc, milestone: canonMilestone(p.date_label) })
    }
    stockByCode.forEach((v, code) => {
      if (!Array.from(codeById.values()).includes(code)) return
      const pending = v.all - v.paid
      if (pending > 0.005) { const m = metaFor(undefined, code); income.push({ code, label: m.clientName || 'Stock part sold', amount: pending, dated: false, date: null, href: m.href, tip: m.carInvTip, labelTip: 'Stock part sold' }) }
    })
    // LOSS group: invoices whose FINAL MARKUP is negative (shown last, separate from incomes).
    const loss: Row[] = []
    for (const inv of invs || []) {
      const lm = lossByInvoice.get(inv.id); if (!lm) continue
      const m = metaFor(inv.id, inv.invoice_code)
      const pctLabel = `${lm.pct.toFixed(1)}%`
      // LOSS rows label with the CAR NAME; the invoice name is the label's rollover.
      loss.push({ code: inv.invoice_code, label: m.carName || m.clientName || pctLabel, amount: lm.amount, dated: false, date: null, href: m.href, tip: m.carInvTip, labelTip: m.invoiceName || pctLabel })
    }
    loss.sort((a, b) => a.amount - b.amount)

    // DUE by GZ28 lists only UNPAID expenses (what GZ28 still owes). A paid expense
    // carries a payment_date and is excluded. Among the unpaid ones, DATED = has an
    // expense_date (the expense's own date), UNDATED = none.
    const expense: Row[] = []
    for (const e of exps || []) {
      const code = codeById.get(e.invoice_id); if (!code) continue
      if (isValidDate(e.payment_date)) continue
      const amount = expenseLine(e); if (!amount) continue
      const m = metaFor(e.invoice_id, code)
      const dated = isValidDate(e.expense_date)
      // Show the SUPPLIER; the item description becomes the hover tooltip.
      expense.push({ code, label: e.supplier || e.item || 'Expense', amount, dated, date: dated ? fmtD(e.expense_date) : null, href: m.href, tip: m.tip, labelTip: e.item || '' })
    }
    // Florida sales tax GZ28 owes — consolidated into its own group, shown last.
    const tax: Row[] = []
    for (const inv of invs || []) {
      const ipa = partsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((x: number, p: any) => x + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      if (flTaxAmount > 0.005 && !isValidDate(inv.fl_tax_expense_date)) {
        const m = metaFor(inv.id, inv.invoice_code)
        tax.push({ code: inv.invoice_code, label: 'Florida Taxes', amount: flTaxAmount, dated: false, date: null, href: m.href, tip: m.tip })
      }
    }
    // Sort by date (ascending); for the same date — or undated rows — bigger amount first.
    const byDateThenAmount = (a: Row, b: Row) =>
      (a.date && b.date) ? (a.date.localeCompare(b.date) || b.amount - a.amount) : a.date ? -1 : b.date ? 1 : (b.amount - a.amount)
    income.sort(byDateThenAmount); expense.sort(byDateThenAmount); tax.sort(byDateThenAmount)

    // Pull DATED income & expenses OUT of the DUE boxes into the monthly-flow box
    // below: income is money in (+), expense is money out (−). Adjust the box
    // headlines so they reflect only what stays (undated + milestones + loss/tax).
    const datedIncome = income.filter(r => r.dated && !r.milestone && r.date)
    const datedExpense = expense.filter(r => r.dated && r.date)
    dueClients -= datedIncome.reduce((x, r) => x + r.amount, 0)
    dueGz += datedExpense.reduce((x, r) => x + r.amount, 0)
    // FLORIDA TAXES move to their own box below — drop them from the DUE by GZ28US total too.
    dueGz += tax.reduce((x, r) => x + r.amount, 0)
    const flowItems: FlowItem[] = [
      ...datedIncome.map(r => ({ date: r.date as string, code: r.code, label: r.label, href: r.href, signed: r.amount })),
      ...datedExpense.map(r => ({ date: r.date as string, code: r.code, label: r.label, href: r.href, signed: -r.amount })),
    ].sort((a, b) => a.date.localeCompare(b.date))
    setFlow(flowItems)

    setS({
      cashFlow, cashFlowPct: sumExpPaid > 0 ? (cashFlow / sumExpPaid) * 100 : 0,
      dueClients,
      markup, markupPct: sumExpGlobal > 0 ? (markup / sumExpGlobal) * 100 : 0,
      dueGz,
    })
    setRows({ income, expense, tax, loss })
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">CURRENT Payments FLOW</h1>
      <p className="text-gray-400 mb-6">Everything, all time — no filters.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
            <DetailColumn label="DUE by CLIENTS" value={formatUSD(s.dueClients)} valueColor={s.dueClients > 0 ? 'text-red-400' : 'text-gray-300'} rows={rows.income} undatedColor="text-amber-400" taxRows={rows.loss} taxLabel="LOSS" taxColor="text-red-500" />
            <DetailColumn label="DUE by GZ28US" value={formatUSD(s.dueGz)} valueColor={s.dueGz < 0 ? 'text-red-400' : 'text-gray-300'} rows={rows.expense} undatedColor="text-red-400" />
          </div>
          {flow.length > 0 && <MonthlyFlow flow={flow} />}
          {rows.tax.length > 0 && (
            <div className="mt-4 max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5">
              <p className="text-sm font-bold text-gray-400 mb-1">FLORIDA TAXES</p>
              <p className="text-2xl font-bold text-red-400">{formatUSD(rows.tax.reduce((x, r) => x + r.amount, 0))}</p>
              <div className="mt-2">
                {rows.tax.map((r, i) => (
                  <div key={i} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60 last:border-0">
                    <span className="text-gray-300 truncate">{r.date ? `${formatShortDate(r.date)} · ` : ''}<a href={r.href} target="_blank" rel="noopener noreferrer" title={r.tip} className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a> · <span title={r.labelTip || undefined}>{r.label}</span></span>
                    <span className="font-bold text-red-400 shrink-0">{formatUSD(r.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  )
}

function DashCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

function DetailColumn({ label, value, valueColor, rows, undatedColor, taxRows, taxLabel, taxColor }: { label: string; value: string; valueColor: string; rows: Row[]; undatedColor: string; taxRows?: Row[]; taxLabel?: string; taxColor?: string }) {
  const milestoneRows = rows.filter(r => r.milestone)
  const undated = rows.filter(r => !r.dated && !r.milestone)
  // One group per distinct milestone label present, shown just before LOSS with friendly names.
  const milestoneNames: Record<string, string> = { ARRIVAL: 'Goods Arrival', CONCLUSION: 'Project Conclusion' }
  const milestoneLabels = [...new Set(milestoneRows.map(r => r.milestone!))]
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      {undated.length > 0 && <RowGroup label="UNDATED" rows={undated} color={undatedColor} />}
      {milestoneLabels.map(ml => <RowGroup key={ml} label={milestoneNames[ml] || ml} rows={milestoneRows.filter(r => r.milestone === ml)} color="text-cyan-400" />)}
      {taxRows && taxRows.length > 0 && <RowGroup label={taxLabel || 'TAXES'} rows={taxRows} color={taxColor || undatedColor} />}
    </div>
  )
}

function RowGroup({ label, rows, color }: { label: string; rows: Row[]; color: string }) {
  const subtotal = rows.reduce((x, r) => x + r.amount, 0)
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs font-bold text-gray-500 uppercase mb-1 border-b border-gray-700 pb-1">
        <span>{label}</span><span>{formatUSD(subtotal)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600 py-1">—</p>
      ) : rows.map((r, i) => (
        <div key={i} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60">
          <span className="text-gray-300 truncate">
            {r.date ? `${formatShortDate(r.date)} · ` : ''}<a href={r.href} target="_blank" rel="noopener noreferrer" title={r.tip} className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a> · <span title={r.labelTip || undefined}>{r.label}</span>
          </span>
          <span className={`font-bold shrink-0 ${color}`}>{formatUSD(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}

// All DATED income (+) and expenses (−) in one column, grouped by month, with a
// running ("current") balance carried through each month.
function MonthlyFlow({ flow }: { flow: FlowItem[] }) {
  const byMonth = new Map<string, FlowItem[]>()
  for (const it of flow) {
    const k = it.date.slice(0, 7)
    if (!byMonth.has(k)) byMonth.set(k, [])
    byMonth.get(k)!.push(it)
  }
  const monthKeys = [...byMonth.keys()].sort()
  let running = 0
  return (
    <div className="mt-4 max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">MONTHLY FLOW · DATED</p>
      {monthKeys.map((k) => {
        const items = byMonth.get(k)!
        running += items.reduce((x, i) => x + i.signed, 0)
        const label = new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1)
          .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        return (
          <div key={k} className="mt-3">
            <div className="flex justify-between text-xs font-bold uppercase mb-1 border-b border-gray-700 pb-1">
              <span className="text-gray-400">{label}</span>
              <span className={running >= 0 ? 'text-green-400' : 'text-red-400'}>Balance {formatUSD(running)}</span>
            </div>
            {items.map((it, i) => (
              <div key={i} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60">
                <span className="text-gray-300 truncate">
                  {formatShortDate(it.date)} · <a href={it.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{it.code}</a> · {it.label}
                </span>
                <span className={`font-bold shrink-0 ${it.signed >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatUSD(it.signed)}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
