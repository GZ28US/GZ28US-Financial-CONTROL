'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type FixedExpense = { id: string; type: string; description: string | null; amount: number; source: string | null; expense_date: string | null }

const TYPES = ['ALL', 'MONTHLY', 'WEEKLY', 'DAILY', 'SINGLE'] as const
function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }

export default function FixedCostExpensesPage() {
  const params = useParams()
  const id = String(params.id)
  const [rows, setRows] = useState<FixedExpense[]>([])
  const [supplierName, setSupplierName] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<typeof TYPES[number]>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [id])

  async function load() {
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('description, company').eq('id', id).maybeSingle()
    setSupplierName((sup?.description || sup?.company || '') as string)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('supplier_id', id).order('created_at', { ascending: false })
    setRows((data || []) as FixedExpense[])
    setLoading(false)
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  const q = search.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    const typeOk = filter === 'ALL' || r.type === filter
    const searchOk = !q || [r.description, r.source, r.type].some((v) => (v || '').toLowerCase().includes(q))
    return typeOk && searchOk
  })
  const total = filtered.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <Link href={`/costs/fixed/${id}`} className="text-gray-400 text-lg hover:text-white">← {supplierName || 'Fixed Cost Supplier'}</Link>

      <div className="flex items-center justify-between mt-3 mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">EXPENSES ({rows.length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, payer, type…"
            className="w-64 sm:w-80 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <Link href={`/costs/fixed/${id}/expenses/new`} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">+ ADD EXPENSE</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {TYPES.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-4 py-2 rounded-full font-bold ${filter === c ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No expenses yet.' : 'No matches.'}</p>
      ) : (
        <>
          <div className="space-y-5">
            {filtered.map((r) => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700">{r.type}</span>
                    <h2 className="text-2xl font-bold truncate">{r.description || '—'}</h2>
                  </div>
                  <p className="text-lg text-gray-400">{formatUSD(Number(r.amount) || 0)}{r.source ? ` · ${r.source}` : ''}{r.expense_date ? ` · ${fmtDate(r.expense_date)}` : ''}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xl font-bold text-gray-300">Total ({filter}): {formatUSD(total)}</p>
        </>
      )}
    </main>
  )
}
