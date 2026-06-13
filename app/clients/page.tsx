'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { clientCode } from '@/lib/utils'

type Client = {
  id: string
  name: string
  email: string | null
  country: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  client_number: number | null
  is_quote: boolean | null
}

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

// Client badges (from the latest invoice) — live status + report status. No AWAITING-CAR ladder here.
function getLiveBadge(s: string | null) {
  if (s === 'CLOSED') return { label: 'CLOSED', cls: 'bg-green-700 text-white' }
  if (s === 'REALTIME') return { label: 'REALTIME', cls: 'bg-blue-800 text-blue-200' }
  return { label: 'INCOMPLETE', cls: 'bg-gray-700 text-gray-300' }
}
function getReportBadge(live: string | null, feed: string | null) {
  // Only show REPORT READY (when REALTIME + feed on, or CLOSED). Never a NOT-READY badge.
  const ready = live === 'CLOSED' || (live === 'REALTIME' && feed === 'REAL_TIME')
  return ready ? { label: 'REPORT READY', cls: 'bg-green-800 text-green-300' } : null
}

export default function ClientsPage() {
  const [clients, setClients] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Projects area shows is_quote=false clients; Quotes area shows is_quote=true.
  const [mode] = useState<'project' | 'quote'>(() => {
    if (typeof window === 'undefined') return 'project'
    return new URLSearchParams(window.location.search).get('mode') === 'quote' ? 'quote' : 'project'
  })
  const [liveFilter, setLiveFilter] = useState<'ALL' | 'INCOMPLETE' | 'REALTIME' | 'CLOSED'>('ALL')
  const [reportFilter, setReportFilter] = useState<'ALL' | 'READY' | 'NOT'>('ALL')

  useEffect(() => { loadClients() }, [])

  async function loadClients() {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .order('name', { ascending: true })

    const clientList = (data || []).filter((c: any) => !!c.is_quote === (mode === 'quote'))

    const withStats = await Promise.all(clientList.map(async (client) => {
      // All invoices tied to this client: personal invoices (client_id) PLUS invoices on rides they own.
      const { data: ridesOwned } = await supabase.from('rides').select('id, created_at, updated_at').eq('client_id', client.id)
      const rideIds = (ridesOwned || []).map(r => r.id)

      const orParts: string[] = [`client_id.eq.${client.id}`]
      if (rideIds.length > 0) orParts.push(`ride_id.in.(${rideIds.join(',')})`)

      const { data: invoices } = await supabase
        .from('invoices')
        .select('id, florida_taxes, global_discount, fl_tax_expense_date, live_status, feed_status, created_at, updated_at')
        .or(orParts.join(','))

      const invoiceList = invoices || []
      const invoiceIds = invoiceList.map(i => i.id)

      let currentProfit = 0
      let finalProfit = 0
      let paymentsBalance = 0
      let expensesBalance = 0
      let sumExpensesPaid = 0
      let sumExpensesGlobal = 0

      if (invoiceIds.length > 0) {
        const [paymentsRes, expensesRes, partsRes, servicesRes] = await Promise.all([
          supabase.from('invoice_payments').select('invoice_id, amount, payment_date, paid_at').in('invoice_id', invoiceIds),
          supabase.from('invoice_expenses').select('invoice_id, price, quantity, payment_date, tax, extra').in('invoice_id', invoiceIds),
          supabase.from('invoice_parts').select('invoice_id, unit_price, quantity').in('invoice_id', invoiceIds),
          supabase.from('invoice_services').select('invoice_id, price').in('invoice_id', invoiceIds),
        ])

        const byInvoice = <T extends { invoice_id: string }>(rows: T[] | null) => {
          const m = new Map<string, T[]>()
          for (const r of rows || []) {
            const arr = m.get(r.invoice_id) || []
            arr.push(r); m.set(r.invoice_id, arr)
          }
          return m
        }
        const paymentsBy = byInvoice(paymentsRes.data)
        const expensesBy = byInvoice(expensesRes.data)
        const partsBy = byInvoice(partsRes.data)
        const servicesBy = byInvoice(servicesRes.data)

        // Per-item expense line including Tax + Extra Costs, matching the edit page.
        const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)

        for (const inv of invoiceList) {
          const parts = partsBy.get(inv.id) || []
          const services = servicesBy.get(inv.id) || []
          const payments = paymentsBy.get(inv.id) || []
          const expenses = expensesBy.get(inv.id) || []

          const partsSubTotal = parts.reduce((s, p) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
          const floridaTaxesAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
          const partsTotal = partsSubTotal + floridaTaxesAmount
          const servicesTotal = services.reduce((s, sv) => s + (parseFloat(sv.price) || 0), 0)
          const partsAndServicesTotal = partsTotal + servicesTotal
          const discountAmount = partsAndServicesTotal * ((inv.global_discount || 0) / 100)
          const grandTotal = partsAndServicesTotal - discountAmount

          // Income counts only payments explicitly marked PAID (paid_at).
          const totalPaid = payments.filter(p => !!p.paid_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)

          const flTaxAmount = floridaTaxesAmount
          const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
          const expensesTotalGlobal = flTaxAmount + expenses.reduce((s, e) => s + expenseLine(e), 0)
          const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + expenses.filter(e => isValidDate(e.payment_date)).reduce((s, e) => s + expenseLine(e), 0)

          currentProfit += totalPaid - expensesTotalPaid
          finalProfit += grandTotal - expensesTotalGlobal
          paymentsBalance += totalPaid - grandTotal
          expensesBalance += expensesTotalPaid - expensesTotalGlobal
          sumExpensesPaid += expensesTotalPaid
          sumExpensesGlobal += expensesTotalGlobal
        }
      }

      const currentProfitPct = sumExpensesPaid > 0 ? (currentProfit / sumExpensesPaid) * 100 : 0
      const finalProfitPct = sumExpensesGlobal > 0 ? (finalProfit / sumExpensesGlobal) * 100 : 0

      // Activity = newest of: client created, any ride created/edited, any invoice created/edited.
      const times: number[] = []
      const pushTime = (v: any) => { if (v) { const t = new Date(v).getTime(); if (!isNaN(t)) times.push(t) } }
      pushTime(client.created_at)
      for (const r of (ridesOwned || [])) { pushTime(r.created_at); pushTime(r.updated_at) }
      for (const inv of invoiceList) { pushTime((inv as any).created_at); pushTime((inv as any).updated_at) }
      const activityTime = times.length > 0 ? Math.max(...times) : 0

      // Badges reflect the most recently touched invoice across this client's rides + shopping.
      const latestInv = [...invoiceList].sort((a: any, b: any) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] as any
      return {
        ...client,
        _hasInvoices: invoiceIds.length > 0,
        _liveStatus: latestInv?.live_status ?? null,
        _feedStatus: latestInv?.feed_status ?? null,
        _activityTime: activityTime,
        _currentProfit: currentProfit,
        _currentProfitPct: currentProfitPct,
        _finalProfit: finalProfit,
        _finalProfitPct: finalProfitPct,
        _paymentsBalance: paymentsBalance,
        _expensesBalance: expensesBalance,
      }
    }))

    // Most recently active clients first.
    withStats.sort((a, b) => b._activityTime - a._activityTime)

    setClients(withStats)
    setLoading(false)
  }

  async function removeClient(id: string) {
    const { error } = await supabase.from('clients').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadClients()
  }

  // Format by country: US -> +1 (XXX) XXX-XXXX, Brazil -> +55 (XX) XXXXX.XXXX.
  function formatPhone(phone: string | null, country?: string | null) {
    if (!phone) return '-'
    const digits = phone.replace(/\D/g, '')
    const isBR = country === 'BRAZIL' || (!country && digits.startsWith('55') && digits.length > 11)
    if (isBR) {
      const local = digits.startsWith('55') ? digits.slice(2) : digits
      if (local.length === 11) return `+55 (${local.slice(0,2)})${local.slice(2,7)}.${local.slice(7)}`
      if (local.length === 10) return `+55 (${local.slice(0,2)})${local.slice(2,6)}.${local.slice(6)}`
      return phone
    }
    // US (default)
    const local = (digits.startsWith('1') && digits.length === 11) ? digits.slice(1) : digits
    if (local.length === 10) return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`
    return phone
  }

  // Filter clients by their (latest-invoice) live status; the REPORT filter only shows
  // when the current selection has both ready and not-ready clients (never on INCOMPLETE).
  const isReady = (c: any) => c._liveStatus === 'CLOSED' || (c._liveStatus === 'REALTIME' && c._feedStatus === 'REAL_TIME')
  const liveFiltered = clients.filter((c: any) => liveFilter === 'ALL' || (c._hasInvoices && (c._liveStatus || 'INCOMPLETE') === liveFilter))
  const showReportFilter = liveFilter !== 'INCOMPLETE' && liveFiltered.some(isReady) && liveFiltered.some((c: any) => !isReady(c))
  const filtered = liveFiltered.filter((c: any) => !showReportFilter || reportFilter === 'ALL' || (reportFilter === 'READY' ? isReady(c) : !isReady(c)))
  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Client</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this client? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeClient(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">{mode === 'quote' ? 'QUOTE' : 'PROJECT'} CLIENTS ({filtered.length})</h1>
          <div className="flex gap-2 flex-wrap">
            {(['ALL', 'INCOMPLETE', 'REALTIME', 'CLOSED'] as const).map((f) => (
              <button key={f} onClick={() => setLiveFilter(f)} className={chip(liveFilter === f)}>{f}</button>
            ))}
          </div>
          {showReportFilter && (
            <div className="flex gap-2 flex-wrap border-l border-gray-700 pl-4">
              {(['ALL', 'READY', 'NOT'] as const).map((f) => (
                <button key={f} onClick={() => setReportFilter(f)} className={chip(reportFilter === f)}>{f === 'READY' ? 'REPORT READY' : f === 'NOT' ? 'REPORT NOT READY' : 'ALL'}</button>
              ))}
            </div>
          )}
        </div>
        <Link href={`/clients/new?mode=${mode}`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW CLIENT</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No clients yet.</p>
      ) : (
        <div className="space-y-5">
          {filtered.map((client) => (
            <div key={client.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold">{clientCode(client)} — {client.name}</h2>
                  {client._hasInvoices && (
                    <>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${getLiveBadge(client._liveStatus).cls}`}>{getLiveBadge(client._liveStatus).label}</span>
                      {getReportBadge(client._liveStatus, client._feedStatus) && (
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${getReportBadge(client._liveStatus, client._feedStatus)!.cls}`}>{getReportBadge(client._liveStatus, client._feedStatus)!.label}</span>
                      )}
                    </>
                  )}
                </div>
                <p className="text-lg text-gray-400">{client.email || '-'}</p>
                <p className="text-lg text-gray-400">{formatPhone(client.phone, client.country)}</p>
                <p className="text-lg text-gray-400">{[client.city, client.state, client.zip].filter(Boolean).join(', ')}</p>
                {client.country && <p className="text-lg text-gray-400">{client.country}</p>}

                {client._hasInvoices && (
                  <div className="flex gap-3 mt-3 flex-wrap">
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${client._currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                      CURRENT CASH FLOW: {formatUSD(client._currentProfit)} / {client._currentProfitPct.toFixed(1)}%
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${client._finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                      FINAL MARKUP: {formatUSD(client._finalProfit)} / {client._finalProfitPct.toFixed(1)}%
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${client._paymentsBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                      DUE by CLIENT: {formatUSD(client._paymentsBalance)}
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${client._expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                      DUE by GZ28: {formatUSD(client._expensesBalance)}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/clients/${client.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                <Link href={`/clients/edit/${client.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(client.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                <Link href={`/rides?mode=${mode}&client=${client.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">RIDES</Link>
                <Link href={`/clients/${client.id}/invoices`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">{mode === 'quote' ? 'SHOPPING QUOTES' : 'SHOPPING INVOICES'}</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
