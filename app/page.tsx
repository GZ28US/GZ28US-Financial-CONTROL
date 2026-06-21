'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtD(v: string | null) { return v ? String(v).slice(0, 10) : '' }

type GlobalStats = { cashFlow: number; cashFlowPct: number; dueClients: number; markup: number; markupPct: number; dueGz: number }
type Row = { code: string; label: string; amount: number; dated: boolean; date: string | null; href: string; tip: string; labelTip?: string }

export default function HomePage() {
  const [s, setS] = useState<GlobalStats>({ cashFlow: 0, cashFlowPct: 0, dueClients: 0, markup: 0, markupPct: 0, dueGz: 0 })
  const [rows, setRows] = useState<{ income: Row[]; expense: Row[]; tax: Row[] }>({ income: [], expense: [], tax: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    // EVERYTHING, all time — every REPORT-READY (non-quote, ONLINE/CLOSED) invoice and its children.
    const [{ data: invs }, { data: pays }, { data: exps }, { data: parts }, { data: svcs }] = await Promise.all([
      supabase.from('invoices').select('id, invoice_code, ride_id, client_id, service, florida_taxes, global_discount, fl_tax_expense_date').eq('is_quote', false).in('live_status', ['REALTIME', 'CLOSED']),
      supabase.from('invoice_payments').select('invoice_id, amount, paid_at, payment_date, source, description'),
      supabase.from('invoice_expenses').select('invoice_id, price, quantity, expense_date, payment_date, tax, extra, item, supplier'),
      supabase.from('invoice_parts').select('invoice_id, unit_price, quantity'),
      supabase.from('invoice_services').select('invoice_id, price'),
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
    const paysBy = group(pays), expsBy = group(exps), partsBy = group(parts), svcsBy = group(svcs)
    const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
    // A PENDING BALANCE (grand total not covered by the listed payments) is income the
    // client still owes with no scheduled date — surfaced as an UNDATED income row.
    const pendingByInvoice = new Map<string, number>()

    // Resolve each invoice's client + car (for the VIEW link/tooltip), and DROP the
    // company's OWN cars: a GZ28US car billed to GZ28US is internal, not real income.
    // (BR cars billed to the US unit are ordinary clients — they stay.)
    const [{ data: ridesD }, { data: clientsD }] = await Promise.all([
      supabase.from('rides').select('id, project_name, model, version, client_id'),
      supabase.from('clients').select('id, name'),
    ])
    const ridesById = new Map<string, any>(); (ridesD || []).forEach((r: any) => ridesById.set(r.id, r))
    const clientsById = new Map<string, string>(); (clientsD || []).forEach((c: any) => clientsById.set(c.id, c.name || ''))
    const companyClientId = (clientsD || []).find((c: any) => /speedshop\s*usa/i.test(c.name || ''))?.id || null
    // The company's OWN cars stay in every total (cashflow / markup / DUE by GZ28), but
    // their PENDING BALANCE is NOT listed as income — there's no real client owing it.
    const companyInvoiceIds = new Set<string>()

    const codeById = new Map<string, string>()
    const metaById = new Map<string, { href: string; tip: string }>()
    const metaByCode = new Map<string, { href: string; tip: string }>()
    for (const inv of invs || []) {
      const ride = inv.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv.client_id || ride?.client_id || null
      if (companyClientId && cid === companyClientId) companyInvoiceIds.add(inv.id)
      codeById.set(inv.id, inv.invoice_code)
      const clientName = cid ? (clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const invoiceName = inv.service || inv.invoice_code
      const ownerSeg = inv.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      const meta = { href: `${BASE_PATH}/${ownerSeg}/invoices/${inv.id}`, tip: [clientName, carName, invoiceName].filter(Boolean).join(' — ') }
      metaById.set(inv.id, meta); metaByCode.set(inv.invoice_code, meta)
    }
    const metaFor = (id?: string, code?: string) => (id && metaById.get(id)) || (code && metaByCode.get(code)) || { href: '#', tip: code || '' }

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
      // Pending balance the client still owes = grand total − the listed payments.
      const servicesTotal = (svcsBy.get(inv.id) || []).reduce((x: number, sv: any) => x + (parseFloat(sv.price) || 0), 0)
      const grandTotal = (partsSubTotal + flTaxAmount + servicesTotal) * (1 - (inv.global_discount || 0) / 100)
      const pendingBalance = grandTotal - paymentsSum
      // Suppress the pending-balance income for the company's own cars (no client owes it).
      const hasPending = pendingBalance > 0.005 && !companyInvoiceIds.has(inv.id)
      if (hasPending) pendingByInvoice.set(inv.id, pendingBalance)
      const expensesTotalGlobal = flTaxAmount + ie.reduce((x: number, e: any) => x + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + ie.filter((e: any) => isValidDate(e.payment_date)).reduce((x: number, e: any) => x + expenseLine(e), 0)
      const pendingPos = hasPending ? pendingBalance : 0
      cashFlow += totalPaid - expensesTotalPaid
      dueClients += (totalIncomeAll - totalPaid) + pendingPos
      // FINAL MARKUP income = all listed income (dated + undated) + the pending balance.
      markup += (totalIncomeAll + pendingPos) - expensesTotalGlobal
      dueGz += expensesTotalPaid - expensesTotalGlobal
      sumExpPaid += expensesTotalPaid
      sumExpGlobal += expensesTotalGlobal
    }

    // Detail rows below the boxes: only DUE (unpaid) rows — already-paid ones carry no DUE.
    // Income is PAID when paid_at is set; an unpaid income is DATED if it has a scheduled
    // payment_date (e.g. an installment due-date), UNDATED if it has none.
    const income: Row[] = []
    for (const p of pays || []) {
      const code = codeById.get(p.invoice_id); if (!code) continue
      if (p.paid_at) continue
      const amount = parseFloat(p.amount) || 0; if (!amount) continue
      const dated = isValidDate(p.payment_date)
      const m = metaFor(p.invoice_id, code)
      income.push({ code, label: p.description || p.source || 'Income', amount, dated, date: dated ? fmtD(p.payment_date) : null, href: m.href, tip: m.tip })
    }
    stockByCode.forEach((v, code) => {
      if (!Array.from(codeById.values()).includes(code)) return
      const pending = v.all - v.paid
      if (pending > 0.005) { const m = metaFor(undefined, code); income.push({ code, label: 'Stock part sold', amount: pending, dated: false, date: null, href: m.href, tip: m.tip }) }
    })
    // Each invoice's PENDING BALANCE is an UNDATED income (owed, no date to be paid).
    for (const inv of invs || []) {
      const pb = pendingByInvoice.get(inv.id); if (!pb) continue
      const m = metaFor(inv.id, inv.invoice_code)
      income.push({ code: inv.invoice_code, label: 'Pending balance', amount: pb, dated: false, date: null, href: m.href, tip: m.tip })
    }

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

    setS({
      cashFlow, cashFlowPct: sumExpPaid > 0 ? (cashFlow / sumExpPaid) * 100 : 0,
      dueClients,
      markup, markupPct: sumExpGlobal > 0 ? (markup / sumExpGlobal) * 100 : 0,
      dueGz,
    })
    setRows({ income, expense, tax })
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">ALL HISTORY — GLOBAL</h1>
      <p className="text-gray-400 mb-6">Everything, all time — no filters.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
            <DashCard label="CURRENT CASH FLOW" value={`${formatUSD(s.cashFlow)} / ${s.cashFlowPct.toFixed(1)}%`} color={s.cashFlow < 0 ? 'text-red-500' : 'text-blue-400'} />
            <DashCard label="FINAL MARKUP" value={`${formatUSD(s.markup)} / ${s.markupPct.toFixed(1)}%`} color={s.markup < 0 ? 'text-red-500' : 'text-blue-400'} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mt-4">
            <DetailColumn label="DUE by CLIENTS" value={formatUSD(s.dueClients)} valueColor={s.dueClients > 0 ? 'text-red-400' : 'text-gray-300'} rows={rows.income} undatedColor="text-amber-400" />
            <DetailColumn label="DUE by GZ28US" value={formatUSD(s.dueGz)} valueColor={s.dueGz < 0 ? 'text-red-400' : 'text-gray-300'} rows={rows.expense} undatedColor="text-red-400" taxRows={rows.tax} taxLabel="FLORIDA TAXES" />
          </div>
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

function DetailColumn({ label, value, valueColor, rows, undatedColor, taxRows, taxLabel }: { label: string; value: string; valueColor: string; rows: Row[]; undatedColor: string; taxRows?: Row[]; taxLabel?: string }) {
  const undated = rows.filter(r => !r.dated)
  const dated = rows.filter(r => r.dated)
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      {undated.length > 0 && <RowGroup label="UNDATED" rows={undated} color={undatedColor} />}
      {dated.length > 0 && <RowGroup label="DATED" rows={dated} color="text-gray-300" />}
      {taxRows && taxRows.length > 0 && <RowGroup label={taxLabel || 'TAXES'} rows={taxRows} color={undatedColor} />}
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
