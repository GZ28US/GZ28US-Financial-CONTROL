'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

export default function NewSeasonPage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)

  const [staffName, setStaffName] = useState('')
  const [dateEntry, setDateEntry] = useState('')
  const [dateConclusion, setDateConclusion] = useState('')

  useEffect(() => {
    loadStaffName()
  }, [])

  async function loadStaffName() {
    const { data } = await supabase
      .from('staff')
      .select('name')
      .eq('id', staffId)
      .single()

    setStaffName(data?.name || '')
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

  function isValidDate(d: string) {
    return !!d && d.match(/^\d{4}-\d{2}-\d{2}$/) !== null
  }

  async function saveSeason() {
    const { error } = await supabase
      .from('seasons')
      .insert([{
        season_code: 'TMP',
        staff_id: staffId,
        date_entry: isValidDate(dateEntry) ? dateEntry : null,
        date_conclusion: isValidDate(dateConclusion) ? dateConclusion : null,
      }])

    if (error) {
      alert(error.message)
      return
    }

    await renumberSeasons()
    router.push(`/staff/${staffId}/seasons`)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">ADD NEW SEASON</h1>
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

        <button
          onClick={saveSeason}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE SEASON
        </button>

        <a href={`${BASE_PATH}/staff/${staffId}/seasons`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}