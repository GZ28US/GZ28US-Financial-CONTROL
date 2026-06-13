'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Global list of every QUOTE (is_quote=true) ride doc — including quotes that
// belong to PROJECT clients/rides — newest saved first.
export default function QuotesPage() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_code, ride_id, is_quote, hiring_date, created_at, updated_at, rides(project_code, project_name)')
      .eq('is_quote', true)
      .not('ride_id', 'is', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">QUOTES ({rows.length})</h1>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-2xl text-gray-400">No quotes yet.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((q) => {
            const ride = Array.isArray(q.rides) ? q.rides[0] : q.rides
            return (
              <div key={q.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{q.invoice_code}</h2>
                    <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-600 text-black">QUOTE</span>
                  </div>
                  <p className="text-lg text-gray-400">{[ride?.project_code, ride?.project_name].filter(Boolean).join(' — ') || '—'}</p>
                  <p className="text-lg text-gray-400">Created {fmtDate((q.created_at || '').slice(0, 10))}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/rides/${q.ride_id}/invoices/${q.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/rides/${q.ride_id}/invoices/edit/${q.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
