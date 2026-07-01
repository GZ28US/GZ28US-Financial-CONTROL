'use client'

import { useEffect, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD, clientCode } from '@/lib/utils'

type Invoice = {
  id: string
  invoice_code: string
  entry_date: string | null
  conclusion_date: string | null
  delivery_date: string | null
  hiring_date: string | null
  mileage: number | null
  service: string | null
  florida_taxes: number | null
  global_discount: number | null
  fl_tax_expense_date: string | null
  feed_status: string | null
  live_status: string | null
  is_quote: boolean | null
}

type InvoiceStats = {
  paymentsBalance: number
  expensesBalance: number
  currentProfit: number
  currentProfitPct: number
  finalProfit: number
  finalProfitPct: number
  grandTotal: number
  expensesTotalPaid: number
  expensesTotalGlobal: number
}

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// Status ladder (first match wins). PRE-DELIVERED fires when the delivery date is
// filled but the conclusion date isn't — the car was handed back before the work
// was officially closed out. The status badge is only meaningful for ride invoices
// (cars going through the shop); client GOODS invoices skip it entirely.
function getStatusBadge(inv: { entry_date: string | null; conclusion_date: string | null; delivery_date: string | null; is_quote?: boolean | null } | null) {
  if (!inv) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  // QUOTE is the first rung of the ladder (no HIRING DATE yet → still a quote).
  if (inv.is_quote) return { label: 'QUOTE', cls: 'bg-amber-600 text-black' }
  if (!isValidDate(inv.entry_date)) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  const hasConclusion = isValidDate(inv.conclusion_date)
  const hasDelivery = isValidDate(inv.delivery_date)
  if (!hasConclusion && !hasDelivery) return { label: 'ON DUTY', cls: 'bg-blue-800 text-blue-200' }
  if (!hasConclusion && hasDelivery) return { label: 'PRE-DELIVERED', cls: 'bg-purple-800 text-purple-200' }
  if (hasConclusion && !hasDelivery) return { label: 'DONE', cls: 'bg-green-800 text-green-300' }
  return { label: 'DELIVERED', cls: 'bg-white text-black' }
}

function getFeedBadge(live: string | null, _feed: string | null, isQuote?: boolean | null) {
  // REPORT READY for any ONLINE ('REALTIME') or CLOSED invoice; quotes are never ready.
  const ready = !isQuote && (live === 'REALTIME' || live === 'CLOSED')
  return ready ? { label: 'REPORT READY', cls: 'bg-green-800 text-green-300' } : null
}

function getLiveBadge(liveStatus: string | null) {
  if (liveStatus === 'CLOSED') return { label: 'CLOSED', cls: 'bg-green-700 text-white' }
  if (liveStatus === 'REALTIME') return { label: 'ONLINE', cls: 'bg-blue-800 text-blue-200' }
  return { label: 'INCOMPLETE', cls: 'bg-gray-700 text-gray-300' }
}

export default function InvoicesPage() {
  const params = useParams()
  const pathname = usePathname()
  const ownerId = String(params.id)
  // Context: client invoices when the URL is /clients/..., otherwise ride invoices.
  const isClient = (pathname || '').includes('/clients/')
  const basePath = isClient ? `/clients/${ownerId}/invoices` : `/rides/${ownerId}/invoices`
  const backPath = isClient ? '/clients' : '/rides'

  const [headerTitle, setHeaderTitle] = useState('')
  const [headerSubtitle, setHeaderSubtitle] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [stats, setStats] = useState<Record<string, InvoiceStats>>({})
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Whether this owner (client or ride) is a quote entity — drives label + create button.
  const [ownerIsQuote, setOwnerIsQuote] = useState(false)

  useEffect(() => {
    loadOwner()
    loadInvoices()
  }, [])

  async function loadOwner() {
    if (isClient) {
      const { data } = await supabase
        .from('clients')
        .select('name, client_number, is_quote')
        .eq('id', ownerId)
        .single()
      if (data) {
        setHeaderTitle(clientCode(data))
        setHeaderSubtitle(data.name || null)
        setOwnerIsQuote(!!data.is_quote)
      }
    } else {
      const { data } = await supabase
        .from('rides')
        .select('project_code, project_name, is_quote')
        .eq('id', ownerId)
        .single()
      if (data) {
        setHeaderTitle(data.project_code || '')
        setHeaderSubtitle(data.project_name || null)
        setOwnerIsQuote(!!data.is_quote)
      }
    }
  }

  async function loadInvoices() {
    const column = isClient ? 'client_id' : 'ride_id'
    const { data } = await supabase
      .from('invoices')
      .select('*')
      .eq(column, ownerId)
      .order('created_at', { ascending: false })

    const invoiceList = data || []
    setInvoices(invoiceList)

    // Stock-sale income per donor invoice (a donated part another car pulled from stock).
    const stockByCode = new Map<string, { all: number; paid: number }>()
    {
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
    }

    const statsMap: Record<string, InvoiceStats> = {}
    await Promise.all(invoiceList.map(async (invoice) => {
      const [paymentsRes, expensesRes, partsRes, servicesRes] = await Promise.all([
        supabase.from('invoice_payments').select('amount, payment_date, paid_at').eq('invoice_id', invoice.id),
        supabase.from('invoice_expenses').select('price, quantity, payment_date, tax, extra').eq('invoice_id', invoice.id),
        supabase.from('invoice_parts').select('unit_price, quantity').eq('invoice_id', invoice.id),
        supabase.from('invoice_services').select('price').eq('invoice_id', invoice.id),
      ])

      const partsSubTotal = (partsRes.data || []).reduce((s, p) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const floridaTaxesAmount = partsSubTotal * ((invoice.florida_taxes || 0) / 100)
      const partsTotal = partsSubTotal + floridaTaxesAmount
      const servicesTotal = (servicesRes.data || []).reduce((s, sv) => s + (parseFloat(sv.price) || 0), 0)
      const partsAndServicesTotal = partsTotal + servicesTotal
      const discountAmount = partsAndServicesTotal * ((invoice.global_discount || 0) / 100)
      const grandTotal = partsAndServicesTotal - discountAmount

      // Income counts only payments explicitly marked PAID (paid_at) — same as the
      // edit page. Expenses include each item's Tax and Extra Costs plus the
      // Florida parts tax that GZ28 owes.
      const ss = stockByCode.get((invoice as any).invoice_code) || { all: 0, paid: 0 }
      const totalPaid = (paymentsRes.data || []).filter(p => !!p.paid_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) + ss.paid
      const totalIncomeAll = (paymentsRes.data || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) + ss.all

      const flTaxAmount = floridaTaxesAmount
      const flTaxPaid = isValidDate(invoice.fl_tax_expense_date)
      const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
      const expensesTotalGlobal = flTaxAmount + (expensesRes.data || []).reduce((s, e) => s + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + (expensesRes.data || []).filter(e => isValidDate(e.payment_date)).reduce((s, e) => s + expenseLine(e), 0)

      const paymentsBalance = totalIncomeAll - totalPaid
      const expensesBalance = expensesTotalPaid - expensesTotalGlobal
      const currentProfit = totalPaid - expensesTotalPaid
      const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
      // No income recorded yet (every quote, and not-yet-paid invoices): the client
      // still owes the grand total, so use it as the income basis for the markup.
      const markupIncome = totalIncomeAll > 0.005 ? totalIncomeAll : grandTotal
      const finalProfit = markupIncome - expensesTotalGlobal
      const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0

      statsMap[invoice.id] = { paymentsBalance, expensesBalance, currentProfit, currentProfitPct, finalProfit, finalProfitPct, grandTotal, expensesTotalPaid, expensesTotalGlobal }
    }))

    setStats(statsMap)
    setLoading(false)
  }

  async function removeInvoice(id: string) {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadInvoices()
  }

  function formatDate(date: string | null) {
    if (!date) return '—'
    return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const invoicesLabel = isClient
    ? (ownerIsQuote ? 'SHOPPING QUOTES' : 'SHOPPING INVOICES')
    : (ownerIsQuote ? 'QUOTES' : 'INVOICES')

  // Consolidated dash for this project — REPORT-READY (ONLINE/CLOSED) invoices only.
  const isRdy = (r: any) => r.live_status === 'REALTIME' || r.live_status === 'CLOSED'
  const readyInvoices = invoices.filter(isRdy)
  const agg = readyInvoices.reduce((a, inv) => {
    const s = stats[inv.id]; if (!s) return a
    return {
      currentProfit: a.currentProfit + s.currentProfit,
      finalProfit: a.finalProfit + s.finalProfit,
      paymentsBalance: a.paymentsBalance + s.paymentsBalance,
      expensesBalance: a.expensesBalance + s.expensesBalance,
      sumExpPaid: a.sumExpPaid + s.expensesTotalPaid,
      sumExpGlobal: a.sumExpGlobal + s.expensesTotalGlobal,
    }
  }, { currentProfit: 0, finalProfit: 0, paymentsBalance: 0, expensesBalance: 0, sumExpPaid: 0, sumExpGlobal: 0 })
  const aggCurrentPct = agg.sumExpPaid > 0 ? (agg.currentProfit / agg.sumExpPaid) * 100 : 0
  const aggFinalPct = agg.sumExpGlobal > 0 ? (agg.finalProfit / agg.sumExpGlobal) * 100 : 0
  const readyCount = readyInvoices.length

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Invoice</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this invoice? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeInvoice(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold">{[headerTitle, headerSubtitle].filter(Boolean).join(' — ')}</h1>
          <p className="text-xl text-gray-400 mt-1">{invoicesLabel} ({invoices.length})</p>
        </div>
        <div className="flex gap-4">
          <Link href={backPath} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          {ownerIsQuote ? (
            <Link href={`${basePath}/new?mode=quote`} className="bg-amber-600 hover:bg-amber-500 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW QUOTE</Link>
          ) : (
            <>
              <Link href={`${basePath}/new`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW INVOICE</Link>
              {/* A PROJECT car can also be quoted for additional/future work — the quote
                  gets a .QT. code and converts to an invoice when given a HIRING DATE. */}
              {!isClient && <Link href={`${basePath}/new?mode=quote`} className="bg-amber-600 hover:bg-amber-500 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW QUOTE</Link>}
            </>
          )}
        </div>
      </div>

      {!loading && readyCount > 0 && (
        <div className="bg-gray-900 border border-gray-700 rounded-3xl p-5 mb-6">
          <p className="text-sm font-bold text-gray-400 mb-2">CONSOLIDATED — REPORT-READY ONLY ({readyCount})</p>
          <div className="flex gap-3 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>CURRENT CASH FLOW: {formatUSD(agg.currentProfit)} / {aggCurrentPct.toFixed(1)}%</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by CLIENTS: {formatUSD(agg.paymentsBalance)}</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>FINAL MARKUP: {formatUSD(agg.finalProfit)} / {aggFinalPct.toFixed(1)}%</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by GZ28US: {formatUSD(agg.expensesBalance)}</span>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : invoices.length === 0 ? (
        <p className="text-2xl text-gray-400">No invoices yet.</p>
      ) : (
        <div className="space-y-5">
          {invoices.map((invoice) => {
            const s = stats[invoice.id]
            const statusBadge = getStatusBadge(invoice)
            const feedBadge = getFeedBadge(invoice.live_status, invoice.feed_status, invoice.is_quote)
            const liveBadge = getLiveBadge(invoice.live_status)

            return (
              <div key={invoice.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{invoice.invoice_code}</h2>
                    {(!isClient || invoice.is_quote) && <span className={`px-3 py-1 rounded-full text-sm font-bold ${statusBadge.cls}`}>{statusBadge.label}</span>}
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${liveBadge.cls}`}>{liveBadge.label}</span>
                    {feedBadge && <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>}
                  </div>
                  {invoice.service && <p className="text-lg text-gray-400">{invoice.service}</p>}
                  <p className="text-lg font-bold text-gray-200">{s ? formatUSD(s.grandTotal) : '—'}</p>
                  <p className="text-lg text-gray-400">{formatDate(invoice.hiring_date)}{invoice.delivery_date ? ` — Delivery: ${formatDate(invoice.delivery_date)}` : ''}</p>
                  {invoice.mileage && <p className="text-lg text-gray-400">{Number(invoice.mileage).toLocaleString('en-US')} mi</p>}

                  {s && (
                    <div className="flex gap-3 mt-3 flex-wrap">
                      {!invoice.is_quote && (
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                          CURRENT CASH FLOW: {formatUSD(s.currentProfit)} / {s.currentProfitPct.toFixed(1)}%
                        </span>
                      )}
                      {!invoice.is_quote && (
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                          DUE by CLIENTS: {formatUSD(s.paymentsBalance)}
                        </span>
                      )}
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                        FINAL MARKUP: {formatUSD(s.finalProfit)} / {s.finalProfitPct.toFixed(1)}%
                      </span>
                      {!invoice.is_quote && (
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                          DUE by GZ28US: {formatUSD(s.expensesBalance)}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`${basePath}/${invoice.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`${basePath}/edit/${invoice.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  {!isClient && <Link href={`${basePath}/new?mode=quote&duplicateFrom=${invoice.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold">⧉ DUPLICATE</Link>}
                  <button onClick={() => setConfirmId(invoice.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
