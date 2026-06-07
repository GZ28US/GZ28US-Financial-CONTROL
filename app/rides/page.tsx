'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Ride = {
  id: string
  project_code: string
  project_name: string | null
  year: number | null
  version: string | null
  special_edition: string | null
  color: string | null
  photo_url: string | null
  updated_at: string | null
  created_at: string | null
}

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// Status ladder (first match wins). PRE-DELIVERED fires when the delivery date is
// filled but the conclusion date isn't — the car was handed back before the work
// was officially closed out.
function getStatusBadge(inv: { entry_date: string | null; conclusion_date: string | null; delivery_date: string | null } | null) {
  if (!inv) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  if (!isValidDate(inv.entry_date)) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  const hasConclusion = isValidDate(inv.conclusion_date)
  const hasDelivery = isValidDate(inv.delivery_date)
  if (!hasConclusion && !hasDelivery) return { label: 'ON DUTY', cls: 'bg-blue-800 text-blue-200' }
  if (!hasConclusion && hasDelivery) return { label: 'PRE-DELIVERED', cls: 'bg-purple-800 text-purple-200' }
  if (hasConclusion && !hasDelivery) return { label: 'DONE', cls: 'bg-green-800 text-green-300' }
  return { label: 'DELIVERED', cls: 'bg-white text-black' }
}

function getFeedBadge(feedStatus: string | null) {
  return feedStatus === 'REAL_TIME'
    ? { label: 'ONLINE', cls: 'bg-green-800 text-green-300' }
    : { label: 'OFF', cls: 'bg-red-800 text-red-200' }
}

export default function RidesPage() {
  const [rides, setRides] = useState<Ride[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { loadRides() }, [])

  async function loadRides() {
    const { data, error } = await supabase.from('rides').select('*')
    if (error) { console.error(error); setLoading(false); return }

    const ridesData = data || []

    const ridesWithActivity = await Promise.all(ridesData.map(async (ride) => {
      const timestamps: string[] = []
      if (ride.updated_at) timestamps.push(ride.updated_at)
      if (ride.created_at) timestamps.push(ride.created_at)

      const { data: invoices } = await supabase
        .from('invoices')
        .select('id, florida_taxes, global_discount, fl_tax_expense_date, entry_date, conclusion_date, delivery_date, feed_status, updated_at, created_at')
        .eq('ride_id', ride.id)

      const invoiceList = invoices || []
      const invoiceIds = invoiceList.map(i => i.id)

      for (const inv of invoiceList) {
        if (inv.updated_at) timestamps.push(inv.updated_at)
        if (inv.created_at) timestamps.push(inv.created_at)
      }

      // Most recent invoice (by created_at) drives the status + feed balloons
      const latestInvoice = invoiceList.slice().sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      )[0] || null

      // Aggregated financial stats (summed across ALL of the ride's invoices)
      let currentProfit = 0
      let finalProfit = 0
      let paymentsBalance = 0
      let expensesBalance = 0
      let sumExpensesPaid = 0
      let sumExpensesGlobal = 0

      if (invoiceIds.length > 0) {
        const tables = ['invoice_payments', 'invoice_expenses', 'invoice_parts', 'invoice_services', 'invoice_notes']
        for (const table of tables) {
          const { data: rows } = await supabase
            .from(table)
            .select('created_at')
            .in('invoice_id', invoiceIds)
            .order('created_at', { ascending: false })
            .limit(1)
          if (rows?.[0]?.created_at) timestamps.push(rows[0].created_at)
        }

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

      const latest = timestamps.filter(Boolean).sort().reverse()[0] || ''
      return {
        ...ride,
        _latestActivity: latest,
        _latestInvoice: latestInvoice,
        _currentProfit: currentProfit,
        _currentProfitPct: currentProfitPct,
        _finalProfit: finalProfit,
        _finalProfitPct: finalProfitPct,
        _paymentsBalance: paymentsBalance,
        _expensesBalance: expensesBalance,
      }
    }))

    ridesWithActivity.sort((a, b) => b._latestActivity.localeCompare(a._latestActivity))
    setRides(ridesWithActivity as any)
    setLoading(false)
  }

  async function removeRide(id: string) {
    const { error } = await supabase.from('rides').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadRides()
  }

  function formatUSD(v: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Ride</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this ride? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeRide(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">RIDES ({rides.length})</h1>
        <Link href="/rides/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW RIDE</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : rides.length === 0 ? (
        <p className="text-2xl text-gray-400">No rides found.</p>
      ) : (
        <div className="space-y-5">
          {(rides as any[]).map((ride) => {
            const statusBadge = getStatusBadge(ride._latestInvoice)
            const feedBadge = getFeedBadge(ride._latestInvoice?.feed_status ?? null)
            return (
            <div key={ride.id} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden flex items-stretch">
              {/* PHOTO */}
              {ride.photo_url ? (
                <div className="w-48 shrink-0">
                  <img src={ride.photo_url} alt={ride.project_name || ride.project_code} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="w-48 shrink-0 bg-gray-800 flex items-center justify-center">
                  <span className="text-gray-600 text-4xl">🚗</span>
                </div>
              )}

              {/* CONTENT */}
              <div className="flex flex-1 items-center justify-between p-6 gap-6">
                <div>
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{ride.project_code} — {ride.project_name}</h2>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${statusBadge.cls}`}>{statusBadge.label}</span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>
                  </div>
                  <p className="text-lg text-gray-400">{ride.year} {ride.version}</p>
                  {ride.special_edition && <p className="text-lg text-gray-400">{ride.special_edition}</p>}
                  <p className="text-lg text-gray-400">{ride.color}</p>
                  <div className="flex gap-3 mt-3 flex-wrap">
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                      CURRENT CASH FLOW: {formatUSD(ride._currentProfit)} / {ride._currentProfitPct.toFixed(1)}%
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                      FINAL PROFIT RESULT: {formatUSD(ride._finalProfit)} / {ride._finalProfitPct.toFixed(1)}%
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._paymentsBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                      DUE by CLIENT: {formatUSD(ride._paymentsBalance)}
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                      DUE by GZ28: {formatUSD(ride._expensesBalance)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/rides/${ride.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/rides/edit/${ride.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <Link href={`/rides/${ride.id}/invoices`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">INVOICES</Link>
                  <button onClick={() => setConfirmId(ride.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
