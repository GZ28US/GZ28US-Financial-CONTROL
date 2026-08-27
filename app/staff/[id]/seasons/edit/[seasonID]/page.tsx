'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, seasonHourlyRate, formatMoney } from '@/lib/utils'

const inputClass = 'w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-4 text-xl'

export default function EditSeasonPage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID)

  const [loading, setLoading] = useState(true)
  const [staffName, setStaffName] = useState('')
  const [dateEntry, setDateEntry] = useState('')
  const [dateConclusion, setDateConclusion] = useState('')
  // A TAXA (Márcio, 26/ago/2026). Ela sempre viveu na season, mas em nenhuma
  // tela — só dava para mexer no banco. Sem isso ninguém sabe, pelo app,
  // quanto uma pessoa ganha por mês.
  const [payType, setPayType] = useState('')
  const [payRate, setPayRate] = useState('')
  const [payCurrency, setPayCurrency] = useState('USD')
  const [payDay, setPayDay] = useState('')
  // JORNADA — é o que transforma a taxa em custo/hora nas duties dos packs.
  const [hoursPerDay, setHoursPerDay] = useState('')
  const [daysPerWeek, setDaysPerWeek] = useState('')

  useEffect(() => {
    loadStaffName()
    loadSeason()
  }, [])

  async function loadStaffName() {
    const { data } = await supabase
      .from('staff')
      .select('name')
      .eq('id', staffId)
      .single()

    setStaffName(data?.name || '')
  }

  async function loadSeason() {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .eq('id', seasonID)
      .single()

    if (error || !data) {
      alert('Season not found')
      router.push(`/staff/${staffId}/seasons`)
      return
    }

    setDateEntry(data.date_entry || '')
    setDateConclusion(data.date_conclusion || '')
    setPayType(data.pay_type || '')
    setPayRate(data.pay_rate != null ? String(data.pay_rate) : '')
    setPayCurrency(data.pay_currency || 'USD')
    setPayDay(data.pay_day != null ? String(data.pay_day) : '')
    setHoursPerDay(data.hours_per_day != null ? String(data.hours_per_day) : '')
    setDaysPerWeek(data.days_per_week != null ? String(data.days_per_week) : '')
    setLoading(false)
  }

  async function renumberSeasons() {
    const { data } = await supabase
      .from('seasons')
      .select('id, date_entry, date_conclusion')
      .eq('staff_id', staffId)

    if (!data) return

    // Unknown-entry seasons number by their conclusion date (chronological slot).
    data.sort((a, b) => ((a.date_entry || a.date_conclusion || '9999') as string).localeCompare(b.date_entry || b.date_conclusion || '9999'))

    for (let i = 0; i < data.length; i++) {
      const code = `US.${String(i + 1).padStart(3, '0')}`
      await supabase
        .from('seasons')
        .update({ season_code: code })
        .eq('id', data[i].id)
    }
  }

  function isValidDate(d: string) {
    return !!d && d.match(/^\d{4}-\d{2}-\d{2}$/) !== null
  }

  async function saveSeason() {
    const { error } = await supabase
      .from('seasons')
      .update({
        date_entry: isValidDate(dateEntry) ? dateEntry : null,
        date_conclusion: isValidDate(dateConclusion) ? dateConclusion : null,
        pay_type: payType || null,
        pay_rate: payType && payRate !== '' ? (parseFloat(payRate) || null) : null,
        pay_currency: payCurrency || 'USD',
        // pay_day é UM campo e o pay_type diz o que ele significa: dia da
        // semana no WEEKLY, dia do mês no MONTHLY. No DAILY não existe dia.
        pay_day: payType === 'WEEKLY' || payType === 'MONTHLY' ? (payDay !== '' ? parseInt(payDay, 10) : null) : null,
        hours_per_day: hoursPerDay !== '' ? (parseFloat(hoursPerDay) || null) : null,
        days_per_week: daysPerWeek !== '' ? (parseInt(daysPerWeek, 10) || null) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', seasonID)

    if (error) {
      alert(error.message)
      return
    }

    await renumberSeasons()
    router.push(`/staff/${staffId}/seasons`)
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white p-8">
        <Header />
        <p className="text-2xl text-gray-400">Loading...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">EDIT SEASON</h1>
      <p className="text-gray-400 text-xl mb-8">{staffName}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <DatePicker
          label="DATE OF ENTRY"
          value={dateEntry}
          onChange={setDateEntry}
        />

        <DatePicker
          label="DATE OF CONCLUSION"
          value={dateConclusion}
          onChange={setDateConclusion}
        />

        {/* PAY RATE — o que a pessoa ganha nesta season. O app gera a linha em
            aberto no dia certo e ela fica pendente até alguém dar baixa. */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 space-y-4">
          <label className="block text-lg font-bold">PAY RATE</label>

          <div>
            <label className="block mb-2 text-sm text-gray-400">HOW OFTEN</label>
            <select value={payType} onChange={(e) => setPayType(e.target.value)} className={inputClass}>
              <option value="">— no recurring pay —</option>
              <option value="DAILY">DAILY</option>
              <option value="WEEKLY">WEEKLY</option>
              <option value="MONTHLY">MONTHLY</option>
            </select>
          </div>

          {payType && (
            <>
              <div>
                <label className="block mb-2 text-sm text-gray-400">AMOUNT</label>
                <div className="flex gap-3">
                  <select value={payCurrency} onChange={(e) => setPayCurrency(e.target.value)} className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-4 text-xl">
                    <option value="USD">US$</option>
                    <option value="BRL">R$</option>
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={payRate}
                    onChange={(e) => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setPayRate(e.target.value) }}
                    className={inputClass + ' flex-1'}
                  />
                </div>
                {payCurrency === 'BRL' && (
                  <p className="mt-2 text-sm text-gray-400">
                    The rate is in reais. Each payment stores the real amount in R$ and the dollar of the day it was issued — the app never re-converts an old line. Who pays is not this field: it is chosen at PAID FROM, on the payment itself.
                  </p>
                )}
              </div>

              {/* JORNADA — sem ela a taxa nao vira custo/hora e as duties de
                  um pack ficam sem preco (Márcio, 26/ago/2026). */}
              <div>
                <label className="block mb-2 text-sm text-gray-400">WORK SCHEDULE</label>
                <div className="flex gap-3">
                  <input type="text" inputMode="decimal" placeholder="Hours per day" value={hoursPerDay} onChange={(e) => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setHoursPerDay(e.target.value) }} className={inputClass + ' flex-1'} />
                  <select value={daysPerWeek} onChange={(e) => setDaysPerWeek(e.target.value)} className={inputClass + ' flex-1'}>
                    <option value="">Days per week</option>
                    {[1, 2, 3, 4, 5, 6, 7].map(d => <option key={d} value={String(d)}>{d} {d === 1 ? 'day' : 'days'} a week</option>)}
                  </select>
                </div>
                {(() => {
                  const h = seasonHourlyRate({ pay_type: payType, pay_rate: parseFloat(payRate) || 0, hours_per_day: parseFloat(hoursPerDay) || 0, days_per_week: parseInt(daysPerWeek, 10) || 0 })
                  return h
                    ? <p className="mt-2 text-sm font-bold text-gray-200">Costs {formatMoney(h, payCurrency)} per hour — this is what puts a price on a pack&apos;s duties.</p>
                    : <p className="mt-2 text-sm text-gray-400">Fill both and the app learns this person&apos;s cost per hour, which is what puts a price on a pack&apos;s duties.</p>
                })()}
              </div>

              {payType !== 'DAILY' && (
                <div>
                  <label className="block mb-2 text-sm text-gray-400">{payType === 'WEEKLY' ? 'PAYS EVERY' : 'PAYS ON DAY'}</label>
                  {payType === 'WEEKLY' ? (
                    <select value={payDay} onChange={(e) => setPayDay(e.target.value)} className={inputClass}>
                      <option value="">Friday (default)</option>
                      {["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
                    </select>
                  ) : (
                    <select value={payDay} onChange={(e) => setPayDay(e.target.value)} className={inputClass}>
                      <option value="">Last day of the month (default)</option>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={String(d)}>{d}</option>)}
                    </select>
                  )}
                  {payType === 'MONTHLY' && Number(payDay) > 28 && (
                    <p className="mt-2 text-sm text-amber-400">A short month can't hold day {payDay} — it pays on the last day instead.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <button
          onClick={saveSeason}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE CHANGES
        </button>

        <a href={`${BASE_PATH}/staff/${staffId}/seasons`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}