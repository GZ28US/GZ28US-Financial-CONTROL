'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

export default function EditStaffPage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [position, setPosition] = useState('')

  useEffect(() => {
    loadStaff()
  }, [])

  async function loadStaff() {
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('id', staffId)
      .single()

    if (error || !data) {
      alert('Staff member not found')
      router.push('/staff')
      return
    }

    setName(data.name || '')
    setPosition(data.position || '')
    setLoading(false)
  }

  async function saveStaff() {
    if (!name || !position) {
      alert('Please fill in all fields')
      return
    }

    const { error } = await supabase
      .from('staff')
      .update({
        name,
        position,
        updated_at: new Date().toISOString(),
      })
      .eq('id', staffId)

    if (error) {
      alert(error.message)
      return
    }

    router.push('/staff')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

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

      <h1 className="text-4xl font-bold mb-8">EDIT STAFF MEMBER</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <div>
          <label className="block mb-2 text-lg font-bold">NAME</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">POSITION</label>
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className={inputClass}
          />
        </div>

        <button
          onClick={saveStaff}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE CHANGES
        </button>

        <a href={`${BASE_PATH}/staff`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}