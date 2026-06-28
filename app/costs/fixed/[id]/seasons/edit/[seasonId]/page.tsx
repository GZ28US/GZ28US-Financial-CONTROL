'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

export default function EditFixedCostSeasonPage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params.id)
  const seasonId = String(params.seasonId)
  const [code, setCode] = useState('')
  const [dateEntry, setDateEntry] = useState('')
  const [dateConclusion, setDateConclusion] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_seasons').select('*').eq('id', seasonId).maybeSingle()
      if (data) { setCode(data.season_code || ''); setDateEntry(data.date_entry || ''); setDateConclusion(data.date_conclusion || '') }
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
      date_entry: isValidDate(dateEntry) ? dateEntry : null,
      date_conclusion: isValidDate(dateConclusion) ? dateConclusion : null,
    }).eq('id', seasonId)
    if (error) { alert(error.message); return }
    await renumber()
    router.push(`/costs/fixed/${id}/seasons`)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT SEASON {code}</h1>
      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <DatePicker label="DATE OF ENTRY" value={dateEntry} onChange={setDateEntry} />
        <DatePicker label="DATE OF CONCLUSION" value={dateConclusion} onChange={setDateConclusion} />
        <button onClick={save} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE</button>
        <a href={`${BASE_PATH}/costs/fixed/${id}/seasons`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
