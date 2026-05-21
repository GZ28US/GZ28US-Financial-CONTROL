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
  updated_at: string | null
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

    // For each ride, find the most recent activity timestamp across all related tables
    const ridesWithActivity = await Promise.all(ridesData.map(async (ride) => {
      // Get all invoices for this ride
      const { data: invoices } = await supabase
        .from('invoices')
        .select('id, updated_at, created_at')
        .eq('ride_id', ride.id)

      const invoiceIds = (invoices || []).map(i => i.id)

      let latestTimestamp = ride.updated_at || ride.created_at || ''

      // Check invoice timestamps
      for (const inv of invoices || []) {
        const t = inv.updated_at || inv.created_at || ''
        if (t > latestTimestamp) latestTimestamp = t
      }

      if (invoiceIds.length > 0) {
        // Check payments
        const { data: payments } = await supabase
          .from('invoice_payments')
          .select('created_at')
          .in('invoice_id', invoiceIds)
          .order('created_at', { ascending: false })
          .limit(1)
        if (payments?.[0]?.created_at > latestTimestamp) latestTimestamp = payments[0].created_at

        // Check expenses
        const { data: expenses } = await supabase
          .from('invoice_expenses')
          .select('created_at')
          .in('invoice_id', invoiceIds)
          .order('created_at', { ascending: false })
          .limit(1)
        if (expenses?.[0]?.created_at > latestTimestamp) latestTimestamp = expenses[0].created_at

        // Check parts
        const { data: parts } = await supabase
          .from('invoice_parts')
          .select('created_at')
          .in('invoice_id', invoiceIds)
          .order('created_at', { ascending: false })
          .limit(1)
        if (parts?.[0]?.created_at > latestTimestamp) latestTimestamp = parts[0].created_at

        // Check services
        const { data: services } = await supabase
          .from('invoice_services')
          .select('created_at')
          .in('invoice_id', invoiceIds)
          .order('created_at', { ascending: false })
          .limit(1)
        if (services?.[0]?.created_at > latestTimestamp) latestTimestamp = services[0].created_at

        // Check notes
        const { data: notes } = await supabase
          .from('invoice_notes')
          .select('created_at')
          .in('invoice_id', invoiceIds)
          .order('created_at', { ascending: false })
          .limit(1)
        if (notes?.[0]?.created_at > latestTimestamp) latestTimestamp = notes[0].created_at
      }

      return { ...ride, _latestActivity: latestTimestamp }
    }))

    // Sort by most recent activity
    ridesWithActivity.sort((a, b) => {
      if (a._latestActivity > b._latestActivity) return -1
      if (a._latestActivity < b._latestActivity) return 1
      return 0
    })

    setRides(ridesWithActivity)
    setLoading(false)
  }

  async function removeRide(id: string) {
    const { error } = await supabase.from('rides').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadRides()
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
          {rides.map((ride) => (
            <div key={ride.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">{ride.project_code} — {ride.project_name}</h2>
                <p className="text-lg text-gray-400">{ride.year} {ride.version}</p>
                {ride.special_edition && <p className="text-lg text-gray-400">{ride.special_edition}</p>}
                <p className="text-lg text-gray-400">{ride.color}</p>
              </div>
              <div className="flex gap-3 flex-wrap">
                <Link href={`/rides/edit/${ride.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <Link href={`/rides/${ride.id}/invoices`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">INVOICES</Link>
                <button className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">GLOBAL BALANCE</button>
                <button onClick={() => setConfirmId(ride.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}