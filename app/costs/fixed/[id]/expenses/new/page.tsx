'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'

const EXPENSE_TYPES = ['MONTHLY', 'WEEKLY', 'DAILY', 'SINGLE']
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

export default function NewFixedCostExpensePage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params.id)
  const [type, setType] = useState('MONTHLY')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [date, setDate] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!amount) { alert('Please enter an amount'); return }
    setSaving(true)
    const { error } = await supabase.from('fixed_cost_expenses').insert([{
      supplier_id: id,
      type,
      description: description || null,
      amount: parseFloat(amount) || 0,
      source: source || DEFAULT_SOURCE,
      expense_date: (type === 'SINGLE' && isValidDate(date)) ? date : null,
    }])
    setSaving(false)
    if (error) { alert(error.message); return }
    router.push(`/costs/fixed/${id}/expenses`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <Link href={`/costs/fixed/${id}/expenses`} className="text-gray-400 text-lg hover:text-white">← Expenses</Link>
      <h1 className="text-4xl font-bold mt-3 mb-8">ADD EXPENSE</h1>

      <div className="max-w-2xl space-y-5">
        <div>
          <label className="block mb-2 text-lg font-bold">TYPE</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
            {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} placeholder="e.g. Rent, Internet…" />
        </div>
        <div>
          <label className="block mb-2 text-lg font-bold">AMOUNT</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
          </div>
        </div>
        <div>
          <label className="block mb-2 text-lg font-bold">PAID FROM</label>
          <SourceSelect value={source} onChange={setSource} className={inputClass} />
        </div>
        {type === 'SINGLE' && <DatePicker label="DATE" value={date} onChange={setDate} />}
        <button onClick={save} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-60 px-8 py-4 rounded-2xl font-bold text-xl">{saving ? 'Saving…' : 'SAVE EXPENSE'}</button>
      </div>
    </main>
  )
}
