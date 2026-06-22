'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }

type PayRow = { id: string; date: string; amount: number; code: string; name: string; source: string; href: string }

export default function PaymentsPage() {
  const [rows, setRows] = useState<PayRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    // Payments RECEIVED in the last 60 days (paid_at within the window).
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 60)
    const { data: pays } = await supabase
      .from('invoice_payments')
      .select('id, invoice_id, amount, paid_at, source')
      .not('paid_at', 'is', null)
      .gte('paid_at', cutoff.toISOString())
      .order('paid_at', { ascending: false })

    const invoiceIds = [...new Set((pays || []).map((p: any) => p.invoice_id))]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id').in('id', invoiceIds)
      invs = data || []
    }
    const invById = new Map<string, any>(); invs.forEach((i: any) => invById.set(i.id, i))
    const [{ data: ridesD }, { data: clientsD }] = await Promise.all([
      supabase.from('rides').select('id, project_name, model, version, client_id'),
      supabase.from('clients').select('id, name'),
    ])
    const ridesById = new Map<string, any>(); (ridesD || []).forEach((r: any) => ridesById.set(r.id, r))
    const clientsById = new Map<string, string>(); (clientsD || []).forEach((c: any) => clientsById.set(c.id, c.name || ''))

    const out: PayRow[] = (pays || []).map((p: any) => {
      const inv = invById.get(p.invoice_id)
      const ride = inv?.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv?.client_id || ride?.client_id || null
      const clientName = cid ? (clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      return {
        id: p.id,
        date: (p.paid_at || '').slice(0, 10),
        amount: parseFloat(p.amount) || 0,
        code: inv?.invoice_code || '—',
        name: clientName || carName || '',
        source: p.source || '',
        href: inv ? `${BASE_PATH}/${ownerSeg}/invoices/${inv.id}` : '#',
      }
    })
    setRows(out)
    setLoading(false)
  }

  const total = rows.reduce((s, r) => s + r.amount, 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">Last PAYMENTS</h1>
      <p className="text-gray-400 mb-6">Received in the last 60 days.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-400 text-xl">No payments in the last 60 days.</p>
      ) : (
        <div className="max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5">
          <div className="flex justify-between items-baseline mb-3">
            <p className="text-sm font-bold text-gray-400">{rows.length} PAYMENT{rows.length === 1 ? '' : 'S'}</p>
            <p className="text-2xl font-bold text-green-400">{formatUSD(total)}</p>
          </div>
          {rows.map((r) => (
            <div key={r.id} className="flex justify-between gap-3 py-2 text-sm border-b border-gray-800/60 last:border-0">
              <span className="text-gray-300 truncate">
                {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.name ? ` · ${r.name}` : ''}{r.source ? ` · ${r.source}` : ''}
              </span>
              <span className="font-bold text-green-400 shrink-0">{formatUSD(r.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
