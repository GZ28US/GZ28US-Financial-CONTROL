'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

function pad3(n: number) { return String(n).padStart(3, '0') }

// Next staff code in the PREFIX.NNN pattern (e.g. US.001), incrementing the
// highest existing one — same convention as rides / seasons.
async function suggestStaffCode(): Promise<string> {
  const { data } = await supabase.from('staff').select('staff_code').not('staff_code', 'is', null)
  let maxNum = 0
  let prefix = 'US'
  for (const s of data || []) {
    const m = (s.staff_code || '').match(/^(.+?)\.(\d+)$/)
    if (m) { const n = parseInt(m[2], 10); if (n > maxNum) { maxNum = n; prefix = m[1] } }
  }
  return maxNum > 0 ? `${prefix}.${pad3(maxNum + 1)}` : 'US.001'
}

export default function EditStaffPage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [staffCode, setStaffCode] = useState('')
  const [name, setName] = useState('')
  const [position, setPosition] = useState('')
  const [phone, setPhone] = useState('')
  // Fields the member can also fill via the self-service form (/staff/self/[id]).
  const [email, setEmail] = useState('')
  const [instagram, setInstagram] = useState('')
  const [cpf, setCpf] = useState('')
  const [birthDate, setBirthDate] = useState('')
  // For foreign staff the passport IS the ID document, not the CPF/SSN — and the
  // expiry travels with it, because an expired passport blocks boarding and visas.
  const [passport, setPassport] = useState('')
  const [passportExpiry, setPassportExpiry] = useState('')
  const [zip, setZip] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [stateUf, setStateUf] = useState('')
  const [preferred, setPreferred] = useState('WhatsApp')

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

    setStaffCode(data.staff_code || (await suggestStaffCode()))
    setName(data.name || '')
    setPosition(data.position || '')
    setPhone(data.phone || '')
    setEmail(data.email || '')
    setInstagram(data.instagram || '')
    setCpf(data.cpf || '')
    setBirthDate(data.birth_date || '')
    setPassport(data.passport || '')
    setPassportExpiry(data.passport_expiry || '')
    setZip(data.zip || '')
    setAddress(data.address || '')
    setCity(data.city || '')
    setStateUf(data.state || '')
    setPreferred(data.preferred_message_method || 'WhatsApp')
    setLoading(false)
  }

  async function saveStaff() {
    if (!staffCode.trim() || !name || !position) {
      alert('Please fill in all fields')
      return
    }

    const { error } = await supabase
      .from('staff')
      .update({
        staff_code: staffCode.trim(),
        name,
        position,
        phone: phone.trim() || null,
        email: email.trim() || null,
        instagram: instagram.trim() || null,
        cpf: cpf.trim() || null,
        birth_date: birthDate || null,
        passport: passport.trim() || null,
        passport_expiry: passportExpiry || null,
        zip: zip.trim() || null,
        address: address.trim() || null,
        city: city.trim() || null,
        state: stateUf.trim() || null,
        preferred_message_method: preferred || null,
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

        <div>
          <label className="block mb-2 text-lg font-bold">WHATSAPP</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
            placeholder="Number with country code, e.g. 1 407 555 0100"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">E-MAIL</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="member@example.com" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">INSTAGRAM</label>
          <input value={instagram} onChange={(e) => setInstagram(e.target.value)} className={inputClass} placeholder="@username" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CPF / SSN / ITIN</label>
          <input value={cpf} onChange={(e) => setCpf(e.target.value)} className={inputClass} placeholder="000.000.000-00 / 000-00-0000" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">BIRTH DATE</label>
          <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PASSPORT</label>
          <input value={passport} onChange={(e) => setPassport(e.target.value)} className={inputClass} placeholder="GN633265" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PASSPORT EXPIRY</label>
          <input type="date" value={passportExpiry} onChange={(e) => setPassportExpiry(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">ADDRESS</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} placeholder="Street, number, apt" />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block mb-2 text-lg font-bold">CITY</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} placeholder="Orlando" />
          </div>
          <div>
            <label className="block mb-2 text-lg font-bold">STATE</label>
            <input value={stateUf} onChange={(e) => setStateUf(e.target.value)} className={inputClass} placeholder="FL" />
          </div>
          <div>
            <label className="block mb-2 text-lg font-bold">ZIP</label>
            <input value={zip} onChange={(e) => setZip(e.target.value)} className={inputClass} placeholder="32837" />
          </div>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PREFERRED MESSAGE METHOD</label>
          <select value={preferred} onChange={(e) => setPreferred(e.target.value)} className={inputClass}>
            {['WhatsApp', 'SMS', 'E-Mail', 'Instagram', 'Facebook'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
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