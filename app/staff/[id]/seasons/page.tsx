'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Season = {
  id: string
  season_code: string
  date_entry: string | null
  date_conclusion: string | null
}

type Expense = {
  id: string
  season_id: string
  type: string
  amount: number
  expense_date: string | null
}

type StaffMember = {
  id: string
  name: string
}

// Total da season = SOMA DOS PAGAMENTOS REAIS (ordem do Márcio, 28/jul/2026).
// A taxa recorrente vive na season (pay_type/pay_rate) e cada pagamento é uma
// linha com data própria — nada de projetar valor × dias.
function calculateSeasonTotal(expenses: Expense[], season: Season): number {
  return expenses
    .filter(e => e.season_id === season.id)
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
}

// Days worked in the season (entry -> conclusion, or entry -> today if still open).
function seasonDays(season: Season): number {
  if (!season.date_entry) return 0
  const start = new Date(season.date_entry + 'T00:00:00')
  const end = season.date_conclusion ? new Date(season.date_conclusion + 'T00:00:00') : new Date()
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
}

export default function SeasonsPage() {
  const params = useParams()
  const staffId = String(params.id)

  const [staff, setStaff] = useState<StaffMember | null>(null)
  const [seasons, setSeasons] = useState<Season[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    loadStaff()
    loadSeasons()
  }, [])

  async function loadStaff() {
    const { data } = await supabase
      .from('staff')
      .select('id, name')
      .eq('id', staffId)
      .single()

    setStaff(data || null)
  }

  async function renumberSeasons() {
    const { data } = await supabase
      .from('seasons')
      .select('id, date_entry')
      .eq('staff_id', staffId)
      .order('date_entry', { ascending: true })

    if (!data) return

    for (let i = 0; i < data.length; i++) {
      const code = `US.${String(i + 1).padStart(3, '0')}`
      await supabase
        .from('seasons')
        .update({ season_code: code })
        .eq('id', data[i].id)
    }
  }

  async function loadSeasons() {
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('*')
      .eq('staff_id', staffId)
      .order('date_entry', { ascending: false })

    setSeasons(seasonData || [])

    if (seasonData && seasonData.length > 0) {
      const seasonIds = seasonData.map(s => s.id)
      const { data: expenseData } = await supabase
        .from('expenses')
        .select('id, season_id, type, amount, expense_date')
        .in('season_id', seasonIds)

      setExpenses(expenseData || [])
    }

    setLoading(false)
  }

  async function removeSeason(id: string) {
    const { error } = await supabase
      .from('seasons')
      .delete()
      .eq('id', id)

    if (error) {
      alert(error.message)
      return
    }

    setConfirmId(null)
    await renumberSeasons()
    loadSeasons()
  }

  function formatDate(date: string | null) {
    if (!date) return '-'
    return new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    })
  }

  const globalTotal = seasons.reduce((sum, season) => sum + calculateSeasonTotal(expenses, season), 0)
  const hasActive = seasons.some(s => !s.date_conclusion)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Season</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this season? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button
                onClick={() => setConfirmId(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                CANCEL
              </button>
              <button
                onClick={() => removeSeason(confirmId)}
                className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                REMOVE
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold">
            {staff?.name} — SEASONS ({seasons.length})
          </h1>
        </div>

        <div className="flex gap-4">
          <Link
            href="/staff"
            className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold"
          >
            BACK
          </Link>
          <Link
            href={`/staff/${staffId}/seasons/create`}
            className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
          >
            ADD NEW SEASON
          </Link>
        </div>
      </div>

      {seasons.length > 0 && (
        <div className="bg-red-700 rounded-3xl p-6 mb-8 max-w-sm">
          <p className="text-xl font-bold">GLOBAL EXPENSES TOTAL</p>
          <p className="text-5xl font-bold">{formatUSD(globalTotal)}</p>
          {hasActive && (
            <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : seasons.length === 0 ? (
        <p className="text-2xl text-gray-400">No seasons yet.</p>
      ) : (
        <div className="space-y-5">
          {seasons.map((season) => {
            const total = calculateSeasonTotal(expenses, season)
            const isConcluded = !!season.date_conclusion
            const totalLabel = isConcluded ? 'FINAL EXPENSES TOTAL' : 'ACTUAL EXPENSES TOTAL'
            const days = seasonDays(season)
            const daily = days > 0 ? total / days : 0

            return (
              <div
                key={season.id}
                className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6"
              >
                <div>
                  <h2 className="text-2xl font-bold">{season.season_code}</h2>
                  <p className="text-lg text-gray-400">Entry: {formatDate(season.date_entry)}</p>
                  <p className="text-lg text-gray-400">Conclusion: {formatDate(season.date_conclusion)}</p>
                  <p className="text-lg text-gray-400">Days: {days}</p>
                </div>

                <div className="bg-red-700 rounded-2xl px-6 py-4 text-center">
                  <p className="text-sm font-bold">{totalLabel}</p>
                  <p className="text-3xl font-bold">{formatUSD(total)}</p>
                </div>

                <div className="bg-gray-800 rounded-2xl px-5 py-4 text-sm min-w-[200px]">
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">DAILY COST</span><span className="font-bold">{formatUSD(daily)}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">WEEKLY COST</span><span className="font-bold">{formatUSD(daily * 7)}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">MONTHLY COST</span><span className="font-bold">{formatUSD(daily * 30)}</span></div>
                </div>

                <div className="flex gap-3 flex-wrap">
                  <Link
                    href={`/staff/${staffId}/seasons/edit/${season.id}`}
                    className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    EDIT
                  </Link>

                  <button
                    onClick={() => setConfirmId(season.id)}
                    className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    REMOVE
                  </button>

                  <Link
                    href={`/staff/${staffId}/seasons/${season.id}/expenses`}
                    className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    EXPENSES
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}