'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

const expenseTypes = ['DAILY', 'WEEKLY', 'MONTHLY', 'SINGLE']
const expenseSources = ['Regions', 'Cash', 'GZ28BR', 'Humberto']
const expenseOrigins = ['GZ28US', 'PERSONAL']

export default function EditExpensePage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID)
  const expenseId = String(params.expenseId)

  const [loading, setLoading] = useState(true)
  const [seasonCode, setSeasonCode] = useState('')
  const [staffName, setStaffName] = useState('')
  const [type, setType] = useState('SINGLE')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [origin, setOrigin] = useState('GZ28US')
  const [source, setSource] = useState('Regions')
  const [expenseDate, setExpenseDate] = useState('')

  useEffect(() => { loadInfo(); loadExpense() }, [])

  async function loadInfo() {
    const { data: season } = await supabase
      .from('seasons')
      .select('season_code, staff_id')
      .eq('id', seasonID)
      .single()

    if (season) {
      setSeasonCode(season.season_code)
      const { data: staff } = await supabase
        .from('staff')
        .select('name')
        .eq('id', season.staff_id)
        .single()
      setStaffName(staff?.name || '')
    }
  }

  async function loadExpense() {
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .eq('id', expenseId)
      .single()

    if (error || !data) {
      alert('Expense not found')
      router.push(`/staff/${staffId}/seasons/${seasonID}/expenses`)
      return
    }

    setType(data.type || 'SINGLE')
    setDescription(data.description || '')
    setAmount(String(data.amount || ''))
    setOrigin(data.origin || 'GZ28US')
    setSource(data.source || 'Regions')
    setExpenseDate(data.expense_date || '')
    setLoading(false)
  }

  async function saveExpense() {
    if (!amount) { alert('Please enter an amount'); return }

    const { error } = await supabase
      .from('expenses')
      .update({
        type,
        description: description || null,
        amount: parseFloat(amount),
        origin,
        source,
        expense_date: type === 'SINGLE' ? expenseDate : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', expenseId)

    if (error) { alert(error.message); return }
    router.push(`/staff/${staffId}/seasons/${seasonID}/expenses`)
  }

  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">EDIT EXPENSE</h1>
      <p className="text-gray-400 text-xl mb-8">{staffName} — {seasonCode}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">TYPE</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className={selectClass}>
            {expenseTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {type === 'SINGLE' && (
          <DatePicker label="DATE" value={expenseDate} onChange={setExpenseDate} />
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} placeholder="Optional description" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">AMOUNT (USD)</label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-xl text-gray-400">$</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass} pl-10`} placeholder="0.00" />
          </div>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">ORIGIN</label>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)} className={selectClass}>
            {expenseOrigins.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SOURCE</label>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
            {expenseSources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <button onClick={saveExpense} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">
          SAVE CHANGES
        </button>

        <a href={`/staff/${staffId}/seasons/${seasonID}/expenses`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}