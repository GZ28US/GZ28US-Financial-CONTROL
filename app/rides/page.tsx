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
        .select('id, updated_at, created_at')
        .eq('ride_id', ride.id)

      const invoiceIds = (invoices || []).map(i => i.id)

      for (const inv of invoices || []) {
        if (inv.updated_at) timestamps.push(inv.updated_at)
        if (inv.created_at) timestamps.push(inv.created_at)
      }

      // Fetch financial stats
      let currentIncome = 0
      let currentDebt = 0

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

        const today = new Date(); today.setHours(0, 0, 0, 0)
        const isTodayOrPast = (d: string | null) => !!d && new Date(d + 'T00:00:00') <= today

        // Payments
        const { data: payments } = await supabase
          .from('invoice_payments')
          .select('amount, payment_date')
          .in('invoice_id', invoiceIds)
        const totalPaid = (payments || [])
          .filter(p => isTodayOrPast(p.payment_date))
          .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)

        // Expenses
        const { data: expenses } = await supabase
          .from('invoice_expenses')
          .select('price, payment_date')
          .in('invoice_id', invoiceIds)
        const expensesTotalPaid = (expenses || [])
          .filter(e => e.payment_date)
          .reduce((s, e) => s + (parseFloat(e.price) || 0), 0)
        const expensesUnpaid = (expenses || [])
          .filter(e => !e.payment_date)
          .reduce((s, e) => s + (parseFloat(e.price) || 0), 0)

        currentIncome = totalPaid - expensesTotalPaid
        currentDebt = expensesUnpaid
      }

      const latest = timestamps.filter(Boolean).sort().reverse()[0] || ''
      return { ...ride, _latestActivity: latest, _currentIncome: currentIncome, _currentDebt: currentDebt }
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
          {(rides as any[]).map((ride) => (
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
                  <h2 className="text-2xl font-bold">{ride.project_code} — {ride.project_name}</h2>
                  <p className="text-lg text-gray-400">{ride.year} {ride.version}</p>
                  {ride.special_edition && <p className="text-lg text-gray-400">{ride.special_edition}</p>}
                  <p className="text-lg text-gray-400">{ride.color}</p>
                  <div className="flex gap-3 mt-3 flex-wrap">
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._currentIncome >= 0 ? 'bg-blue-900 text-blue-300' : 'bg-red-900 text-red-300'}`}>
                      CURRENT INCOME: {formatUSD(ride._currentIncome)}
                    </span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${ride._currentDebt <= 0 ? 'bg-gray-700 text-gray-300' : 'bg-red-900 text-red-300'}`}>
                      CURRENT DEBT: {formatUSD(ride._currentDebt)}
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
          ))}
        </div>
      )}
    </main>
  )
}