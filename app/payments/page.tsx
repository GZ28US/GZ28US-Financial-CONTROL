'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }

type PayRow = { id: string; date: string; amount: number; code: string; supplier: string; item: string; href: string }

export default function PaymentsPage() {
  const [rows, setRows] = useState<PayRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    // Payments WE made (invoice expenses) PAID in the last 60 days (payment_date in window).
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 60)
    const cutoffDate = cutoff.toISOString().slice(0, 10)
    const { data: exps } = await supabase
      .from('invoice_expenses')
      .select('id, invoice_id, price, quantity, tax, extra, item, supplier, payment_date')
      .not('payment_date', 'is', null)
      .gte('payment_date', cutoffDate)
      .order('payment_date', { ascending: false })

    const invoiceIds = [...new Set((exps || []).map((e: any) => e.invoice_id))]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id').in('id', invoiceIds)
      invs = data || []
    }
    const invById = new Map<string, any>(); invs.forEach((i: any) => invById.set(i.id, i))

    const out: PayRow[] = (exps || []).map((e: any) => {
      const inv = invById.get(e.invoice_id)
      const cid = inv?.client_id || null
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      const amount = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
      return {
        id: e.id,
        date: e.payment_date,
        amount,
        code: inv?.invoice_code || '—',
        supplier: e.supplier || '',
        item: e.item || '',
        href: inv ? `${BASE_PATH}/${ownerSeg}/invoices/edit/${inv.id}` : '#',
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
      <p className="text-gray-400 mb-6">Payments we made (expenses) — last 60 days.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-400 text-xl">No payments in the last 60 days.</p>
      ) : (
        <div className="max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5">
          <div className="flex justify-between items-baseline mb-3">
            <p className="text-sm font-bold text-gray-400">{rows.length} PAYMENT{rows.length === 1 ? '' : 'S'}</p>
            <p className="text-2xl font-bold text-red-400">{formatUSD(total)}</p>
          </div>
          {rows.map((r) => (
            <div key={r.id} className="flex justify-between gap-3 py-2 text-sm border-b border-gray-800/60 last:border-0">
              <span className="text-gray-300 truncate">
                {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.supplier ? ` · ${r.supplier}` : ''}{r.item ? ` — ${r.item}` : ''}
              </span>
              <span className="font-bold text-red-400 shrink-0">{formatUSD(r.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
