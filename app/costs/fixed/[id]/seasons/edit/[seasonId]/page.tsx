'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const PERIODICITY = ['SINGLE', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL']
const COST_TYPES = ['FIXED', 'VARIABLE']
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function isNumeric(v: string) { return v === '' || /^-?\d*\.?\d*$/.test(v) }

export default function EditFixedCostSeasonPage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params.id)
  const seasonId = String(params.seasonId)
  const [code, setCode] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [periodicity, setPeriodicity] = useState('MONTHLY')
  const [costType, setCostType] = useState('FIXED')
  const [day1, setDay1] = useState('')
  const [amount1, setAmount1] = useState('')
  const [show2nd, setShow2nd] = useState(false)
  const [day2, setDay2] = useState('')
  const [amount2, setAmount2] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_seasons').select('*').eq('id', seasonId).maybeSingle()
      if (data) {
        setCode(data.season_code || '')
        setStartDate(data.date_entry || '')
        setEndDate(data.date_conclusion || '')
        setPeriodicity(data.periodicity || 'MONTHLY')
        setCostType(data.cost_type || 'FIXED')
        setDay1(data.payment_day_1 != null ? String(data.payment_day_1) : '')
        setAmount1(data.amount_1 != null ? String(data.amount_1) : '')
        setDay2(data.payment_day_2 != null ? String(data.payment_day_2) : '')
        setAmount2(data.amount_2 != null ? String(data.amount_2) : '')
        if (data.payment_day_2 != null || data.amount_2 != null) setShow2nd(true)
      }
    })()
  }, [seasonId])

  async function renumber() {
    const { data } = await supabase.from('fixed_cost_seasons').select('id, date_entry').eq('supplier_id', id).order('date_entry', { ascending: true, nullsFirst: true })
    if (!data) return
    for (let i = 0; i < data.length; i++) {
      await supabase.from('fixed_cost_seasons').update({ season_code: `BR.${String(i + 1).padStart(3, '0')}` }).eq('id', data[i].id)
    }
  }

  async function save() {
    const { error } = await supabase.from('fixed_cost_seasons').update({
      date_entry: isValidDate(startDate) ? startDate : null,
      date_conclusion: isValidDate(endDate) ? endDate : null,
      periodicity,
      cost_type: costType,
      payment_day_1: day1 !== '' ? (parseInt(day1, 10) || null) : null,
      amount_1: amount1 !== '' ? (parseFloat(amount1) || 0) : null,
      payment_day_2: (show2nd && day2 !== '') ? (parseInt(day2, 10) || null) : null,
      amount_2: (show2nd && amount2 !== '') ? (parseFloat(amount2) || 0) : null,
    }).eq('id', seasonId)
    if (error) { alert(error.message); return }
    await renumber()
    router.push(`/costs/fixed/${id}/seasons`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT SEASON {code}</h1>
      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <DatePicker label="SEASON START DATE" value={startDate} onChange={setStartDate} />

        <div>
          <label className="block mb-2 text-sm text-gray-400 font-bold">PAYMENT PERIODICITY</label>
          <select value={periodicity} onChange={(e) => setPeriodicity(e.target.value)} className={inputClass}>
            {PERIODICITY.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-sm text-gray-400 font-bold">TYPE</label>
          <select value={costType} onChange={(e) => setCostType(e.target.value)} className={inputClass}>
            {COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-4">
          <div className="flex gap-3 items-end flex-wrap">
            <div className="w-28">
              <label className="block mb-2 text-sm text-gray-400 font-bold">DAY</label>
              <select value={day1} onChange={(e) => setDay1(e.target.value)} className={inputClass}>
                <option value="">—</option>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[10rem]">
              <label className="block mb-2 text-sm text-gray-400 font-bold">AMOUNT</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
                <input type="text" inputMode="decimal" value={amount1} onChange={(e) => { if (isNumeric(e.target.value)) setAmount1(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
              </div>
            </div>
            {!show2nd && (
              <button onClick={() => setShow2nd(true)} className="bg-blue-700 hover:bg-blue-600 px-5 py-4 rounded-2xl font-bold whitespace-nowrap">+ ADD 2ND</button>
            )}
          </div>

          {show2nd && (
            <div className="flex gap-3 items-end flex-wrap">
              <div className="w-28">
                <label className="block mb-2 text-sm text-gray-400 font-bold">DAY</label>
                <select value={day2} onChange={(e) => setDay2(e.target.value)} className={inputClass}>
                  <option value="">—</option>
                  {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-2 text-sm text-gray-400 font-bold">AMOUNT</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
                  <input type="text" inputMode="decimal" value={amount2} onChange={(e) => { if (isNumeric(e.target.value)) setAmount2(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
                </div>
              </div>
              <button onClick={() => { setShow2nd(false); setDay2(''); setAmount2('') }} className="bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold whitespace-nowrap">Remove</button>
            </div>
          )}
        </div>

        <DatePicker label="SEASON END DATE" value={endDate} onChange={setEndDate} />

        <button onClick={save} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE</button>
        <a href={`${BASE_PATH}/costs/fixed/${id}/seasons`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
