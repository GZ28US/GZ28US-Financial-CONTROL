'use client'

import { useEffect, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Invoice = {
  id: string
  invoice_code: string
  entry_date: string | null
  conclusion_date: string | null
  delivery_date: string | null
  mileage: number | null
  service: string | null
  florida_taxes: number | null
  global_discount: number | null
  fl_tax_expense_date: string | null
  feed_status: string | null
}

type InvoiceStats = {
  paymentsBalance: number
  expensesBalance: number
  currentProfit: number
  currentProfitPct: number
  finalProfit: number
  finalProfitPct: number
}

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

function getFeedBadge(feedStatus: string | null) {
  return feedStatus === 'REAL_TIME'
    ? { label: 'REAL-TIME FEED', cls: 'bg-green-800 text-green-300' }
    : { label: 'INCOMPLETE', cls: 'bg-red-800 text-red-200' }
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

  useEffect(() => {
    loadOwner()
    loadInvoices()
  }, [])

  async function loadOwner() {
    if (isClient) {
      const { data } = await supabase
        .from('clients')
        .select('name, client_number')
        .eq('id', ownerId)
        .single()
      if (data) {
        setHeaderTitle(data.client_number != null ? `${data.client_number}` : (data.name || ''))
        setHeaderSubtitle(data.name || null)
      }
    } else {
      const { data } = await supabase
        .from('rides')
        .select('project_code, project_name')
        .eq('id', ownerId)
        .single()
      if (data) {
        setHeaderTitle(data.project_code || '')
        setHeaderSubtitle(data.project_name || null)
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

    const statsMap: Record<string, InvoiceStats> = {}
    await Promise.all(invoiceList.map(async (invoice) => {
      const [paymentsRes, expensesRes, partsRes, servicesRes] = await Promise.all([
        supabase.from('invoice_payments').select('amount, payment_date').eq('invoice_id', invoice.id),
        supabase.from('invoice_expenses').select('price, quantity, payment_date').eq('invoice_id', invoice.id),
        supabase.from('invoice_parts').select('unit_price, quantity').eq('invoice_id', invoice.id),
        supabase.from('invoice_services').select('price').eq('invoice_id', invoice.id),
      ])

      const today = new Date(); today.setHours(0, 0, 0, 0)
      const isTodayOrPast = (d: string | null) => !!d && new Date(d + 'T00:00:00') <= today

      const partsSubTotal = (partsRes.data || []).reduce((s, p) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const floridaTaxesAmount = partsSubTotal * ((invoice.florida_taxes || 0) / 100)
      const partsTotal = partsSubTotal + floridaTaxesAmount
      const servicesTotal = (servicesRes.data || []).reduce((s, sv) => s + (parseFloat(sv.price) || 0), 0)
      const partsAndServicesTotal = partsTotal + servicesTotal
      const discountAmount = partsAndServicesTotal * ((invoice.global_discount || 0) / 100)
      const grandTotal = partsAndServicesTotal - discountAmount

      const totalPaid = (paymentsRes.data || []).filter(p => isTodayOrPast(p.payment_date)).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)

      const flTaxAmount = floridaTaxesAmount
      const flTaxPaid = isValidDate(invoice.fl_tax_expense_date)
      const expensesTotalGlobal = flTaxAmount + (expensesRes.data || []).reduce((s, e) => s + (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + (expensesRes.data || []).filter(e => e.payment_date).reduce((s, e) => s + (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1), 0)

      const paymentsBalance = totalPaid - grandTotal
      const expensesBalance = expensesTotalPaid - expensesTotalGlobal
      const currentProfit = totalPaid - expensesTotalPaid
      const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
      const finalProfit = grandTotal - expensesTotalGlobal
      const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0

      statsMap[invoice.id] = { paymentsBalance, expensesBalance, currentProfit, currentProfitPct, finalProfit, finalProfitPct }
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

  const invoicesLabel = isClient ? 'PERSONAL INVOICES' : 'INVOICES'

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
          <h1 className="text-4xl font-bold">{headerTitle} — {invoicesLabel} ({invoices.length})</h1>
          {headerSubtitle && <p className="text-xl text-gray-400 mt-1">{headerSubtitle}</p>}
        </div>
        <div className="flex gap-4">
          <Link href={backPath} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`${basePath}/new`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW INVOICE</Link>
        </div>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : invoices.length === 0 ? (
        <p className="text-2xl text-gray-400">No invoices yet.</p>
      ) : (
        <div className="space-y-5">
          {invoices.map((invoice) => {
            const s = stats[invoice.id]
            const feedBadge = getFeedBadge(invoice.feed_status)

            return (
              <div key={invoice.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{invoice.invoice_code}</h2>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>
                  </div>
                  <p className="text-lg text-gray-400">Entry: {formatDate(invoice.entry_date)}{invoice.delivery_date ? ` — Delivery: ${formatDate(invoice.delivery_date)}` : ''}</p>
                  {invoice.service && <p className="text-lg text-gray-400">{invoice.service}</p>}
                  {invoice.mileage && <p className="text-lg text-gray-400">{Number(invoice.mileage).toLocaleString('en-US')} mi</p>}

                  {s && (
                    <div className="flex gap-3 mt-3 flex-wrap">
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                        CURRENT PROFIT: {formatUSD(s.currentProfit)} / {s.currentProfitPct.toFixed(1)}%
                      </span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                        FINAL PROFIT: {formatUSD(s.finalProfit)} / {s.finalProfitPct.toFixed(1)}%
                      </span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.paymentsBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                        PENDING PAYMENTS: {formatUSD(s.paymentsBalance)}
                      </span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                        CURRENT DEBTS: {formatUSD(s.expensesBalance)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`${basePath}/${invoice.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`${basePath}/edit/${invoice.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
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
