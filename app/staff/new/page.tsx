'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

function pad3(n: number) { return String(n).padStart(3, '0') }

export default function NewStaffPage() {
  const router = useRouter()

  const [staffCode, setStaffCode] = useState('')
  const [name, setName] = useState('')
  const [position, setPosition] = useState('')
  const [phone, setPhone] = useState('')

  useEffect(() => { suggestCode() }, [])

  // Auto-suggest the next staff code (PREFIX.NNN, e.g. US.001) by incrementing
  // the highest existing one — same convention as rides / seasons.
  async function suggestCode() {
    const { data } = await supabase.from('staff').select('staff_code').not('staff_code', 'is', null)
    let maxNum = 0
    let prefix = 'US'
    for (const s of data || []) {
      const m = (s.staff_code || '').match(/^(.+?)\.(\d+)$/)
      if (m) { const n = parseInt(m[2], 10); if (n > maxNum) { maxNum = n; prefix = m[1] } }
    }
    setStaffCode(maxNum > 0 ? `${prefix}.${pad3(maxNum + 1)}` : 'US.001')
  }

  async function saveStaff() {
    if (!staffCode.trim() || !name || !position) {
      alert('Please fill in all fields')
      return
    }

    const { error } = await supabase
      .from('staff')
      .insert([{ staff_code: staffCode.trim(), name, position, phone: phone.trim() || null }])

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
          <label className="block mb-2 text-lg font-bold">STAFF CODE</label>
          <input
            value={staffCode}
            onChange={(e) => setStaffCode(e.target.value)}
            className={inputClass}
            placeholder="e.g. US.001"
          />
        </div>

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

        <div>
          <label className="block mb-2 text-lg font-bold">WHATSAPP</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
            placeholder="Number with country code, e.g. 1 407 555 0100"
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