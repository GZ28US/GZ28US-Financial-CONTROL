'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Season = { id: string; season_code: string; date_entry: string | null; date_conclusion: string | null }
type Expense = { id: string; season_id: string | null; type: string; amount: number; expense_date: string | null }

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—' }

// Days the season has been running (entry → conclusion, or entry → today if open).
function seasonDays(s: Season): number {
  if (!s.date_entry) return 0
  const start = new Date(s.date_entry + 'T00:00:00')
  const end = s.date_conclusion ? new Date(s.date_conclusion + 'T00:00:00') : new Date()
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000))
}

// Recurring expenses accrue over the season's days; SINGLE is a one-off face value.
function seasonTotal(expenses: Expense[], s: Season): number {
  const days = seasonDays(s)
  return expenses.filter(e => e.season_id === s.id).reduce((sum, e) => {
    const amount = Number(e.amount) || 0
    if (e.type === 'DAILY') return sum + amount * days
    if (e.type === 'WEEKLY') return sum + amount * (days / 7)
    if (e.type === 'MONTHLY') return sum + amount * (days / 30)
    return sum + amount // SINGLE (and any one-off)
  }, 0)
}

export default function FixedCostSeasonsPage() {
  const params = useParams()
  const id = String(params.id)
  const [supplierName, setSupplierName] = useState('')
  const [seasons, setSeasons] = useState<Season[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [id])

  async function renumber() {
    const { data } = await supabase.from('fixed_cost_seasons').select('id, date_entry').eq('supplier_id', id).order('date_entry', { ascending: true, nullsFirst: true })
    if (!data) return
    for (let i = 0; i < data.length; i++) {
      await supabase.from('fixed_cost_seasons').update({ season_code: `BR.${String(i + 1).padStart(3, '0')}` }).eq('id', data[i].id)
    }
  }

  async function load() {
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('description, company').eq('id', id).maybeSingle()
    setSupplierName((sup?.description || sup?.company || '') as string)
    const { data: seasonData } = await supabase.from('fixed_cost_seasons').select('*').eq('supplier_id', id).order('date_entry', { ascending: false, nullsFirst: false })
    setSeasons((seasonData || []) as Season[])
    if (seasonData && seasonData.length > 0) {
      const ids = seasonData.map(s => s.id)
      const { data: exp } = await supabase.from('fixed_cost_expenses').select('id, season_id, type, amount, expense_date').in('season_id', ids)
      setExpenses((exp || []) as Expense[])
    } else setExpenses([])
    setLoading(false)
  }

  async function removeSeason(sid: string) {
    const { error } = await supabase.from('fixed_cost_seasons').delete().eq('id', sid)
    if (error) { alert(error.message); return }
    setConfirmId(null); await renumber(); load()
  }

  const globalTotal = seasons.reduce((sum, s) => sum + seasonTotal(expenses, s), 0)
  const hasActive = seasons.some(s => !s.date_conclusion)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Season</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This removes the season and its expenses. This cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeSeason(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">{supplierName ? `${supplierName} — ` : ''}SEASONS ({seasons.length})</h1>
        <div className="flex gap-4 flex-wrap">
          <Link href={`/costs/fixed/${id}`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/costs/fixed/${id}/seasons/create`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD NEW SEASON</Link>
        </div>
      </div>

      {seasons.length > 0 && (
        <div className="bg-red-700 rounded-3xl p-6 mb-8 max-w-sm">
          <p className="text-xl font-bold">GLOBAL EXPENSES TOTAL</p>
          <p className="text-5xl font-bold">{formatUSD(globalTotal)}</p>
          {hasActive && <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : seasons.length === 0 ? (
        <p className="text-2xl text-gray-400">No seasons yet.</p>
      ) : (
        <div className="space-y-5">
          {seasons.map((s) => (
            <div key={s.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
              <div>
                <h2 className="text-2xl font-bold">Season {s.season_code}</h2>
                <p className="text-lg text-gray-400">{fmtDate(s.date_entry)} → {s.date_conclusion ? fmtDate(s.date_conclusion) : 'Active'}</p>
                <p className="text-lg text-gray-400">Days Counting: {seasonDays(s)}</p>
              </div>
              <div className="bg-gray-800 rounded-2xl px-6 py-4 text-center min-w-[200px]">
                <p className="text-sm font-bold">EXPENSES TOTAL</p>
                <p className="text-3xl font-bold">{formatUSD(seasonTotal(expenses, s))}</p>
              </div>
              <div className="flex gap-3 flex-wrap">
                <Link href={`/costs/fixed/${id}/seasons/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(s.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                <Link href={`/costs/fixed/${id}/seasons/${s.id}/expenses`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">EXPENSES</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
