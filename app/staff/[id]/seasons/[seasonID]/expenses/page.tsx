'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Expense = {
  id: string
  type: string
  description: string | null
  amount: number
  source: string | null
  origin: string | null
  expense_date: string | null
  receipt_url: string | null
}

type Season = {
  season_code: string
  staff_id: string
  date_entry: string | null
  date_conclusion: string | null
}

function calculateRunningTotal(expense: Expense, season: Season): number {
  const amount = Number(expense.amount)
  if (expense.type === 'SINGLE') return amount

  const start = season.date_entry ? new Date(season.date_entry + 'T00:00:00') : null
  if (!start) return 0

  const end = season.date_conclusion
    ? new Date(season.date_conclusion + 'T00:00:00')
    : new Date()

  const diffMs = end.getTime() - start.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (expense.type === 'DAILY') return amount * diffDays
  if (expense.type === 'WEEKLY') return amount * Math.floor(diffDays / 7)
  if (expense.type === 'MONTHLY') return amount * Math.floor(diffDays / 30)

  return amount
}

function formatRunningLabel(expense: Expense, season: Season): string {
  const start = season.date_entry ? new Date(season.date_entry + 'T00:00:00') : null
  const end = season.date_conclusion
    ? new Date(season.date_conclusion + 'T00:00:00')
    : new Date()

  if (!start) return ''

  const diffMs = end.getTime() - start.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (expense.type === 'DAILY') return `${diffDays} days`
  if (expense.type === 'WEEKLY') return `${Math.floor(diffDays / 7)} weeks`
  if (expense.type === 'MONTHLY') return `${Math.floor(diffDays / 30)} months`

  return ''
}

function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

export default function ExpensesPage() {
  const params = useParams()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID ?? params.seasonId ?? '')

  const [season, setSeason] = useState<Season | null>(null)
  const [staffName, setStaffName] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [openReceiptsId, setOpenReceiptsId] = useState<string | null>(null)

  useEffect(() => { loadInfo(); loadExpenses() }, [])

  async function loadInfo() {
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('season_code, staff_id, date_entry, date_conclusion')
      .eq('id', seasonID)
      .single()

    if (seasonData) {
      setSeason(seasonData)
      const { data: staff } = await supabase
        .from('staff')
        .select('name')
        .eq('id', seasonData.staff_id)
        .single()
      setStaffName(staff?.name || '')
    }
  }

  async function loadExpenses() {
    const { data } = await supabase.from('expenses').select('*').eq('season_id', seasonID)

    if (data) {
      const ongoing = data.filter(e => e.type !== 'SINGLE')
      const singles = data
        .filter(e => e.type === 'SINGLE')
        .sort((a, b) => {
          if (!a.expense_date) return 1
          if (!b.expense_date) return -1
          return b.expense_date.localeCompare(a.expense_date)
        })
      setExpenses([...ongoing, ...singles])
    } else {
      setExpenses([])
    }

    setLoading(false)
  }

  async function removeExpense(id: string) {
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadExpenses()
  }

  function formatDate(date: string | null) {
    if (!date) return '-'
    return new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    })
  }

  const gz28Total = season
    ? expenses.filter(e => !e.origin || e.origin === 'GZ28US').reduce((sum, e) => sum + calculateRunningTotal(e, season), 0)
    : 0

  const personalTotal = season
    ? expenses.filter(e => e.origin === 'PERSONAL').reduce((sum, e) => sum + calculateRunningTotal(e, season), 0)
    : 0

  const isConcluded = !!season?.date_conclusion
  const totalLabel = isConcluded ? 'FINAL GZ28US EXPENSES' : 'ACTUAL GZ28US EXPENSES'
  const personalLabel = isConcluded ? 'FINAL PERSONAL EXPENSES' : 'ACTUAL PERSONAL EXPENSES'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this expense? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeExpense(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold">{staffName} — {season?.season_code}</h1>
          <p className="text-xl text-gray-400 mt-1">EXPENSES ({expenses.length})</p>
        </div>
        <div className="flex gap-4">
          <Link href={`/staff/${staffId}/seasons`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/staff/${staffId}/seasons/${seasonID}/expenses/new`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD NEW EXPENSE</Link>
        </div>
      </div>

      {expenses.length > 0 && (
        <div className="flex gap-4 mb-8 flex-wrap">
          <div className="bg-red-700 rounded-3xl p-6 flex-1 min-w-64">
            <p className="text-xl font-bold">{totalLabel}</p>
            <p className="text-5xl font-bold">{formatUSD(gz28Total)}</p>
            {!isConcluded && <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>}
          </div>
          {personalTotal > 0 && (
            <div className="bg-orange-600 rounded-3xl p-6 flex-1 min-w-64">
              <p className="text-xl font-bold">{personalLabel}</p>
              <p className="text-5xl font-bold">{formatUSD(personalTotal)}</p>
              {!isConcluded && <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : expenses.length === 0 ? (
        <p className="text-2xl text-gray-400">No expenses yet.</p>
      ) : (
        <div className="space-y-5">
          {expenses.map((expense) => {
            const receiptUrls = parseReceiptUrls(expense.receipt_url)
            return (
              <div key={expense.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {expense.type === 'SINGLE' ? (
                    <h2 className="text-2xl font-bold">{formatUSD(Number(expense.amount))}</h2>
                  ) : (
                    <>
                      <h2 className="text-2xl font-bold">
                        {season ? formatUSD(calculateRunningTotal(expense, season)) : 'USD 0.00'}
                      </h2>
                      <p className="text-lg text-gray-400">
                        {formatUSD(Number(expense.amount))} / {expense.type.toLowerCase()} × {season ? formatRunningLabel(expense, season) : ''}
                      </p>
                    </>
                  )}
                  {expense.description && <p className="text-lg text-white">{expense.description}</p>}
                  <p className="text-lg text-gray-400">{expense.type}</p>
                  {expense.origin === 'PERSONAL' && (
                    <span className="inline-block bg-orange-600 text-white text-sm font-bold px-3 py-1 rounded-full mt-1">PERSONAL</span>
                  )}
                  {expense.source && <p className="text-lg text-gray-400">{expense.source}</p>}
                  {expense.type === 'SINGLE' && <p className="text-lg text-gray-400">{formatDate(expense.expense_date)}</p>}
                </div>

                <div className="flex gap-3 flex-wrap shrink-0 items-center">
                  {receiptUrls.length > 0 && (
                    <div className="relative">
                      <button onClick={() => setOpenReceiptsId(openReceiptsId === expense.id ? null : expense.id)} className="bg-purple-700 hover:bg-purple-600 px-3 py-2 rounded-xl font-bold text-sm">
                        RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}
                      </button>
                      {openReceiptsId === expense.id && (
                        <div className="absolute right-0 top-10 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                          {receiptUrls.map((url, ui) => (
                            <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <Link href={`/staff/${staffId}/seasons/${seasonID}/expenses/edit/${expense.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(expense.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}