'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

// APPS — every software subscription the company pays for, auto-captured from
// the Gmail receipts by the APPS watcher (lib/appsMail.server.ts). Each app is
// a fixed_cost_suppliers row with cost_type='APP', so payments flow into ALL
// financial reports like any other company expense.

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

type AppRow = {
  id: string
  description: string | null
  company: string | null
  email: string | null
  date_entry: string | null
  date_conclusion: string | null
  amount_1: number | null
  payment_day_1: number | null
  periodicity: string | null
}

export default function AppsPage() {
  const [rows, setRows] = useState<AppRow[]>([])
  // supplier_id -> lifetime paid total + next scheduled (unpaid) charge.
  const [spent, setSpent] = useState<Map<string, number>>(new Map())
  const [nextDue, setNextDue] = useState<Map<string, { date: string; amount: number }>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'ENDED'>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('fixed_cost_suppliers')
      .select('*')
      .eq('cost_type', 'APP')
      .order('description', { ascending: true })
    const apps = (data || []) as AppRow[]
    setRows(apps)
    if (apps.length) {
      const { data: exp } = await supabase
        .from('fixed_cost_expenses')
        .select('supplier_id, amount, expense_date, payment_date')
        .in('supplier_id', apps.map(a => a.id))
      const paid = new Map<string, number>()
      const due = new Map<string, { date: string; amount: number }>()
      for (const e of (exp || [])) {
        if (!e.supplier_id) continue
        if (isValidDate(e.payment_date)) {
          paid.set(e.supplier_id, (paid.get(e.supplier_id) || 0) + (Number(e.amount) || 0))
        } else if (isValidDate(e.expense_date)) {
          const cur = due.get(e.supplier_id)
          if (!cur || e.expense_date < cur.date) due.set(e.supplier_id, { date: e.expense_date, amount: Number(e.amount) || 0 })
        }
      }
      setSpent(paid)
      setNextDue(due)
    }
    setLoading(false)
  }

  async function remove(id: string) {
    const { error } = await supabase.from('fixed_cost_suppliers').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const td = todayYmd()
  const q = search.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    const ended = isValidDate(r.date_conclusion) && (r.date_conclusion as string) < td
    const statusOk = filter === 'ALL' || (filter === 'ENDED' ? ended : !ended)
    const searchOk = !q || [r.description, r.company, r.email].some((v) => (v || '').toLowerCase().includes(q))
    return statusOk && searchOk
  })
  // ANNUAL subscriptions enter the monthly chip at 1/12 of the yearly charge.
  const monthlyTotal = filtered.reduce((s, r) => s + (isValidDate(r.date_conclusion) && (r.date_conclusion as string) < td ? 0 : (Number(r.amount_1) || 0) / (r.periodicity === 'ANNUAL' ? 12 : 1)), 0)
  const spentTotal = filtered.reduce((s, r) => s + (spent.get(r.id) || 0), 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove App</h2>
            <p className="text-gray-400 text-lg mb-8">The app and its payment history rows will be gone from the reports. Are you sure?</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">APPS ({rows.length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search app, vendor, account…"
            className="w-64 sm:w-80 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <Link href="/costs/fixed/new?type=APP" className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">ADD NEW APP</Link>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {(['ALL', 'ACTIVE', 'ENDED'] as const).map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-4 py-2 rounded-full font-bold ${filter === c ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c}
          </button>
        ))}
        <span className="ml-2 text-lg font-bold text-gray-300">Monthly: {formatUSD(monthlyTotal)}</span>
        <span className="text-gray-600">·</span>
        <span className="text-lg font-bold text-gray-300">All-time spent: {formatUSD(spentTotal)}</span>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No apps yet — the Gmail watcher registers them automatically when a receipt arrives.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {filtered.map((r) => {
            const ended = isValidDate(r.date_conclusion) && (r.date_conclusion as string) < td
            const n = nextDue.get(r.id)
            return (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
                <Link href={`/costs/apps/${r.id}`} className="flex-1 min-w-0 group">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold group-hover:text-blue-400 transition">{r.description || r.company || '—'}</h2>
                    {ended && <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700 text-gray-300">ENDED</span>}
                  </div>
                  <p className="text-lg text-gray-400">
                    {[r.company && r.company !== r.description ? r.company : null, r.email].filter(Boolean).join('  ·  ') || '—'}
                  </p>
                  <p className="text-base text-gray-500">
                    {isValidDate(r.date_entry) ? `Subscribed ${fmtDate(r.date_entry as string)}` : 'Subscription date unknown'}
                    {n ? ` · next charge ${fmtDate(n.date)}${n.amount ? ` (${formatUSD(n.amount)})` : ''}` : ''}
                  </p>
                </Link>
                <div className="text-right shrink-0">
                  <p className="text-2xl font-bold text-green-400">{formatUSD(spent.get(r.id) || 0)}</p>
                  <p className="text-base text-gray-400">{formatUSD(Number(r.amount_1) || 0)} / {r.periodicity === 'ANNUAL' ? 'year' : 'month'}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/costs/apps/${r.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold">💵 PAYMENTS</Link>
                  <Link href={`/costs/fixed/edit/${r.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
