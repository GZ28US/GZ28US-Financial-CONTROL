'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

export default function NewStaffPage() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [position, setPosition] = useState('')

  async function saveStaff() {
    if (!name || !position) {
      alert('Please fill in all fields')
      return
    }

    const { error } = await supabase
      .from('staff')
      .insert([{ name, position }])

    if (error) {
      alert(error.message)
      return
    }

    router.push('/staff')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-8">ADD A NEW STAFF MEMBER</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <div>
          <label className="block mb-2 text-lg font-bold">NAME</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Full name"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">POSITION</label>
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className={inputClass}
            placeholder="Job title or role"
          />
        </div>

        <button
          onClick={saveStaff}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE STAFF MEMBER
        </button>

        <a href={`${BASE_PATH}/staff`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}