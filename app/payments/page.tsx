'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }

type PayRow = { id: string; date: string; amount: number; code: string; label2: string; href: string }

export default function PaymentsPage() {
  const [clientRows, setClientRows] = useState<PayRow[]>([])
  const [gzRows, setGzRows] = useState<PayRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 60)
    const cutoffDate = cutoff.toISOString().slice(0, 10)
    const cutoffISO = cutoff.toISOString()

    const [{ data: pays }, { data: exps }] = await Promise.all([
      // PAID by CLIENTS — income received (paid_at in window).
      supabase.from('invoice_payments').select('id, invoice_id, amount, paid_at, source').not('paid_at', 'is', null).gte('paid_at', cutoffISO),
      // PAID by GZ28US — invoice expenses paid (payment_date in window).
      supabase.from('invoice_expenses').select('id, invoice_id, price, quantity, tax, extra, item, supplier, payment_date').not('payment_date', 'is', null).gte('payment_date', cutoffDate),
    ])

    const invoiceIds = [...new Set([...(pays || []).map((p: any) => p.invoice_id), ...(exps || []).map((e: any) => e.invoice_id)])]
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
    const invMeta = (invId: string) => {
      const inv = invById.get(invId)
      const ride = inv?.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv?.client_id || ride?.client_id || null
      const clientName = cid ? (clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      return { inv, code: inv?.invoice_code || '—', clientName, carName, ownerSeg }
    }

    const cRows: PayRow[] = (pays || []).map((p: any) => {
      const m = invMeta(p.invoice_id)
      return { id: `pay-${p.id}`, date: (p.paid_at || '').slice(0, 10), amount: parseFloat(p.amount) || 0, code: m.code, label2: m.clientName || m.carName || '', href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/${m.inv.id}` : '#' }
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

    const gRows: PayRow[] = (exps || []).map((e: any) => {
      const m = invMeta(e.invoice_id)
      const amount = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
      return { id: `inv-${e.id}`, date: e.payment_date, amount, code: m.code, label2: e.supplier || e.item || '', href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/edit/${m.inv.id}` : '#' }
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

    setClientRows(cRows)
    setGzRows(gRows)
    setLoading(false)
  }

  const clientTotal = clientRows.reduce((s, r) => s + r.amount, 0)
  const gzTotal = gzRows.reduce((s, r) => s + r.amount, 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">PAST Payments FLOW</h1>
      <p className="text-gray-400 mb-6">Everything paid in the last 60 days.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
          <PaidColumn label="PAID by CLIENTS" total={clientTotal} totalColor="text-green-400" rows={clientRows} amountColor="text-green-400" emptyMsg="No client payments in the last 60 days." />
          <PaidColumn label="PAID by GZ28US" total={gzTotal} totalColor="text-red-400" rows={gzRows} amountColor="text-red-400" emptyMsg="No payments made in the last 60 days." />
        </div>
      )}
    </main>
  )
}

function PaidColumn({ label, total, totalColor, rows, amountColor, emptyMsg }: { label: string; total: number; totalColor: string; rows: PayRow[]; amountColor: string; emptyMsg: string }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <div className="flex justify-between items-baseline mb-1">
        <p className="text-sm font-bold text-gray-400">{label}</p>
        <p className={`text-2xl font-bold ${totalColor}`}>{formatUSD(total)}</p>
      </div>
      <div className="mt-2">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-600 py-1">{emptyMsg}</p>
        ) : rows.map((r) => (
          <div key={r.id} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60 last:border-0">
            <span className="text-gray-300 truncate">
              {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.label2 ? ` · ${r.label2}` : ''}
            </span>
            <span className={`font-bold shrink-0 ${amountColor}`}>{formatUSD(r.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
