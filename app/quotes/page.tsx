'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DocPicker from '@/components/DocPicker'
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
  const [liveFilter, setLiveFilter] = useState<'ALL' | 'INCOMPLETE' | 'CLOSED'>('ALL')
  const [picker, setPicker] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_code, ride_id, is_quote, hiring_date, live_status, created_at, updated_at, rides(project_code, project_name)')
      .eq('is_quote', true)
      .not('ride_id', 'is', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }

  async function removeQuote(id: string) {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const filtered = rows.filter(r => liveFilter === 'ALL' || (r.live_status || 'INCOMPLETE') === liveFilter)
  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Quote</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this quote? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeQuote(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">QUOTES ({filtered.length})</h1>
          <div className="flex gap-2 flex-wrap">
            {(['ALL', 'INCOMPLETE', 'CLOSED'] as const).map((f) => (
              <button key={f} onClick={() => setLiveFilter(f)} className={chip(liveFilter === f)}>{f}</button>
            ))}
          </div>
        </div>
        <button onClick={() => setPicker(true)} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW QUOTE</button>
      </div>
      {picker && <DocPicker type="quote" onClose={() => setPicker(false)} />}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No quotes yet.</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((q) => {
            const ride = Array.isArray(q.rides) ? q.rides[0] : q.rides
            return (
              <div key={q.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    {/* Quote on a project car → .QT before the number (US.033.QT.1); a quote car already carries .QT in its code. */}
                    <h2 className="text-2xl font-bold">{q.invoice_code && !q.invoice_code.includes('.QT.') ? q.invoice_code.replace(/\.(\d+)$/, '.QT.$1') : q.invoice_code}</h2>
                    <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-600 text-black">QUOTE</span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${(q.live_status || 'INCOMPLETE') === 'CLOSED' ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{(q.live_status || 'INCOMPLETE') === 'CLOSED' ? 'CLOSED' : 'INCOMPLETE'}</span>
                  </div>
                  <p className="text-lg text-gray-400">{[ride?.project_code, ride?.project_name].filter(Boolean).join(' — ') || '—'}</p>
                  <p className="text-lg text-gray-400">Created {fmtDate((q.created_at || '').slice(0, 10))}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/rides/${q.ride_id}/invoices/${q.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/rides/${q.ride_id}/invoices/edit/${q.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(q.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
