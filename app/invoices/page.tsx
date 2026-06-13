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

function getStatusBadge(inv: any) {
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)
  if (inv.is_quote) return { label: 'QUOTE', cls: 'bg-amber-600 text-black' }
  if (!valid(inv.entry_date)) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  if (!valid(inv.conclusion_date)) return { label: 'ON DUTY', cls: 'bg-blue-800 text-blue-200' }
  if (!valid(inv.delivery_date)) return { label: 'DONE', cls: 'bg-green-800 text-green-300' }
  return { label: 'DELIVERED', cls: 'bg-white text-black' }
}
function getLiveBadge(s: string | null) {
  if (s === 'CLOSED') return { label: 'CLOSED', cls: 'bg-green-700 text-white' }
  if (s === 'REALTIME') return { label: 'REALTIME', cls: 'bg-blue-800 text-blue-200' }
  return { label: 'INCOMPLETE', cls: 'bg-gray-700 text-gray-300' }
}
function getFeedBadge(live: string | null, feed: string | null) {
  const ready = live === 'CLOSED' || (live === 'REALTIME' && feed === 'REAL_TIME')
  return ready ? { label: 'REPORT READY', cls: 'bg-green-800 text-green-300' } : null
}

// Global list of every PROJECT (real, non-quote) ride invoice, newest saved first.
export default function InvoicesPage() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [liveFilter, setLiveFilter] = useState<'ALL' | 'INCOMPLETE' | 'REALTIME' | 'CLOSED'>('ALL')
  const [reportFilter, setReportFilter] = useState<'ALL' | 'READY' | 'NOT'>('ALL')
  const [picker, setPicker] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_code, ride_id, is_quote, entry_date, conclusion_date, delivery_date, feed_status, live_status, created_at, updated_at, rides(project_code, project_name)')
      .eq('is_quote', false)
      .not('ride_id', 'is', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }

  async function removeInvoice(id: string) {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  // Primary filter by live_status; secondary REPORT READY filter only shows when the
  // current selection actually contains both ready and not-ready invoices.
  const liveFiltered = rows.filter(r => liveFilter === 'ALL' || (r.live_status || 'INCOMPLETE') === liveFilter)
  const hasReady = liveFiltered.some(r => r.feed_status === 'REAL_TIME')
  const hasNotReady = liveFiltered.some(r => r.feed_status !== 'REAL_TIME')
  const showReportFilter = liveFilter !== 'INCOMPLETE' && hasReady && hasNotReady
  const filtered = liveFiltered.filter(r => !showReportFilter || reportFilter === 'ALL'
    || (reportFilter === 'READY' ? r.feed_status === 'REAL_TIME' : r.feed_status !== 'REAL_TIME'))

  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

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
      <div className="flex items-center justify-between gap-4 mb-8 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">INVOICES ({filtered.length})</h1>
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
        <button onClick={() => setPicker(true)} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW INVOICE</button>
      </div>
      {picker && <DocPicker type="invoice" onClose={() => setPicker(false)} />}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No invoices yet.</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((inv) => {
            const statusBadge = getStatusBadge(inv)
            const liveBadge = getLiveBadge(inv.live_status)
            const feedBadge = getFeedBadge(inv.live_status, inv.feed_status)
            const ride = Array.isArray(inv.rides) ? inv.rides[0] : inv.rides
            return (
              <div key={inv.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{inv.invoice_code}</h2>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${statusBadge.cls}`}>{statusBadge.label}</span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${liveBadge.cls}`}>{liveBadge.label}</span>
                    {feedBadge && <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>}
                  </div>
                  <p className="text-lg text-gray-400">{[ride?.project_code, ride?.project_name].filter(Boolean).join(' — ') || '—'}</p>
                  <p className="text-lg text-gray-400">Entry: {fmtDate(inv.entry_date)}{inv.delivery_date ? ` — Delivery: ${fmtDate(inv.delivery_date)}` : ''}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/rides/${inv.ride_id}/invoices/${inv.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/rides/${inv.ride_id}/invoices/edit/${inv.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(inv.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
