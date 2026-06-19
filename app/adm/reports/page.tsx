'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

const money = (n: number) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// A YYYY-MM-DD string → 'YYYY-MM' bucket key ('' when undated → sorts last).
function monthKey(d: string | null) { return d && /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : '' }
function monthLabel(key: string) { if (!key) return 'No date set'; const [y, m] = key.split('-'); return `${MONTHS[parseInt(m, 10) - 1]} ${y}` }
function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${MONTHS[parseInt(m, 10) - 1].slice(0, 3)} ${parseInt(day, 10)}, ${y}`
}

type Row = { date: string | null; code: string; who: string; detail: string; amount: number }

// Report-ready = a real (non-quote) invoice that is ONLINE ('REALTIME') or CLOSED.
function isReportReady(i: any) {
  return !i.is_quote && (i.live_status === 'REALTIME' || i.live_status === 'CLOSED')
}

export default function ReportsPage() {
  const [income, setIncome] = useState<Row[]>([])
  const [payables, setPayables] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  async function load() {
    const { data: invs } = await supabase
      .from('invoices')
      .select('id, invoice_code, ride_id, client_id, is_quote, live_status, feed_status, hiring_date, conclusion_date, delivery_date, entry_date')
    const ready = (invs || []).filter(isReportReady)
    const invMap = new Map(ready.map((i: any) => [i.id, i]))
    if (ready.length === 0) { setLoading(false); return }

    const [{ data: rides }, { data: clients }] = await Promise.all([
      supabase.from('rides').select('id, project_name, client_id'),
      supabase.from('clients').select('id, name'),
    ])
    const rideMap = new Map((rides || []).map((r: any) => [r.id, r]))
    const clientMap = new Map((clients || []).map((c: any) => [c.id, c.name]))
    const whoFor = (inv: any) => {
      const ride = inv.ride_id ? rideMap.get(inv.ride_id) : null
      const cid = inv.client_id || (ride && ride.client_id)
      return (cid && clientMap.get(cid)) || (ride && ride.project_name) || ''
    }
    // When an unpaid expense carries no date, fall back to the job's date so it still
    // lands in a month bucket (conclusion → delivery → hiring → entry).
    const jobDate = (inv: any) => inv.conclusion_date || inv.delivery_date || inv.hiring_date || inv.entry_date || null

    // TO INCOME — scheduled/pending client payments (not yet received).
    const { data: pays } = await supabase
      .from('invoice_payments')
      .select('invoice_id, amount, payment_date, source, description, paid_at')
      .is('paid_at', null)
    const inc: Row[] = (pays || []).filter((p: any) => invMap.has(p.invoice_id)).map((p: any) => {
      const inv = invMap.get(p.invoice_id)
      return { date: p.payment_date || null, code: inv.invoice_code || '', who: whoFor(inv), detail: p.source || p.description || '', amount: Number(p.amount) || 0 }
    })

    // TO PAY — unpaid supplier expenses on report-ready invoices.
    const { data: exps } = await supabase
      .from('invoice_expenses')
      .select('invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date')
      .is('payment_date', null)
    const pay: Row[] = (exps || []).filter((e: any) => invMap.has(e.invoice_id)).map((e: any) => {
      const inv = invMap.get(e.invoice_id)
      const amt = (Number(e.price) || 0) * (Number(e.quantity) || 1) + (Number(e.tax) || 0) + (Number(e.extra) || 0)
      return { date: e.expense_date || jobDate(inv), code: inv.invoice_code || '', who: e.supplier || whoFor(inv), detail: e.item || '', amount: amt }
    })

    const byDate = (a: Row, b: Row) => (a.date || '9999').localeCompare(b.date || '9999')
    inc.sort(byDate); pay.sort(byDate)
    setIncome(inc); setPayables(pay); setLoading(false)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-2">REPORTS</h1>
      <p className="text-gray-400 mb-8">Report-ready invoices only (ONLINE or CLOSED, non-quote).</p>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 max-w-7xl">
        <ReportSection title="TO INCOME" subtitle="Scheduled / pending client payments, by date due" rows={income} accent="emerald" emptyMsg="No pending income on report-ready invoices." />
        <ReportSection title="TO PAY" subtitle="Unpaid supplier expenses (undated ones use the job date)" rows={payables} accent="red" emptyMsg="No unpaid expenses on report-ready invoices." />
      </div>
    </main>
  )
}

function ReportSection({ title, subtitle, rows, accent, emptyMsg }: { title: string; subtitle: string; rows: Row[]; accent: 'emerald' | 'red'; emptyMsg: string }) {
  const total = rows.reduce((s, r) => s + r.amount, 0)
  // Group into ordered month buckets (undated '' sorts last).
  const keys: string[] = []
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const k = monthKey(r.date)
    if (!groups.has(k)) { groups.set(k, []); keys.push(k) }
    groups.get(k)!.push(r)
  }
  keys.sort((a, b) => (a || '9999').localeCompare(b || '9999'))
  const totalColor = accent === 'emerald' ? 'text-emerald-400' : 'text-red-400'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h2 className="text-2xl font-bold">{title}</h2>
        <span className={`text-3xl font-bold ${totalColor}`}>{money(total)}</span>
      </div>
      <p className="text-sm text-gray-500 mb-5">{subtitle}</p>

      {rows.length === 0 ? (
        <p className="text-gray-500">{emptyMsg}</p>
      ) : (
        <div className="space-y-5">
          {keys.map(k => {
            const list = groups.get(k)!
            const sub = list.reduce((s, r) => s + r.amount, 0)
            return (
              <div key={k || 'none'} className="border border-gray-800 rounded-2xl overflow-hidden">
                <div className="flex items-baseline justify-between gap-4 px-4 py-2 bg-gray-800/60">
                  <span className="font-bold">{monthLabel(k)}</span>
                  <span className="font-bold">{money(sub)}</span>
                </div>
                <div className="divide-y divide-gray-800">
                  {list.map((r, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2">
                      <span className="text-sm text-gray-400 w-24 shrink-0">{fmtDate(r.date)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate" title={`${r.who}${r.detail ? ' — ' + r.detail : ''}`}>{r.who || r.code}{r.detail ? <span className="text-gray-400 font-normal"> · {r.detail}</span> : ''}</p>
                        {r.code && <p className="text-xs text-gray-500">{r.code}</p>}
                      </div>
                      <span className="font-bold shrink-0">{money(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
          <div className={`flex items-baseline justify-between gap-4 px-4 py-3 border-t-2 border-gray-700`}>
            <span className="text-lg font-bold">GLOBAL TOTAL</span>
            <span className={`text-2xl font-bold ${totalColor}`}>{money(total)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
