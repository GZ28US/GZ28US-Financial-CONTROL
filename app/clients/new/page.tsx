'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, clientCode } from '@/lib/utils'
import Header from '@/components/Header'

const usaStates = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const brazilStates = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]

const messageMethods = ['WhatsApp', 'SMS', 'E-Mail', 'Instagram']

export default function NewClientPage() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    instagram: '',
    country: 'USA',
    phone: '+1 ',
    zip: '',
    address: '',
    city: '',
    state: 'FL',
    preferred_message_method: 'WhatsApp',
  })
  const [zipLookup, setZipLookup] = useState(false)
  // Preview the auto-assigned client code (US.### / US.QT.###) for this area.
  const [nextCode, setNextCode] = useState('')
  useEffect(() => {
    const isQuote = new URLSearchParams(window.location.search).get('mode') === 'quote'
    ;(async () => {
      const { data: maxRow } = await supabase.from('clients').select('client_number').eq('is_quote', isQuote).order('client_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      setNextCode(clientCode({ is_quote: isQuote, client_number: (maxRow?.client_number ?? 0) + 1 }))
    })()
  }, [])

  function changeCountry(country: string) {
    setForm({
      ...form,
      country,
      phone: country === 'USA' ? '+1 ' : '+55 ',
      state: country === 'USA' ? 'FL' : 'SP',
      zip: '',
      address: '',
      city: '',
    })
  }

  // ZIP -> address autofill. USA uses zippopotam.us (city + state). Brazil uses
  // viacep.com.br (street + city + state). All fields stay editable; failures
  // are silently ignored so the user can just type manually.
  useEffect(() => {
    const digits = form.zip.replace(/\D/g, '')
    if (form.country === 'USA' && digits.length === 5) lookupUSA(digits)
    else if (form.country === 'BRAZIL' && digits.length === 8) lookupBrazil(digits)
  }, [form.zip, form.country])

  async function lookupUSA(zip: string) {
    setZipLookup(true)
    try {
      const res = await fetch(`https://api.zippopotam.us/us/${zip}`)
      if (!res.ok) return
      const data = await res.json()
      const place = data?.places?.[0]
      if (!place) return
      const city = place['place name'] || ''
      const stateAbbr = place['state abbreviation'] || ''
      setForm(prev => ({
        ...prev,
        city: prev.city || city,
        state: usaStates.includes(stateAbbr) ? stateAbbr : prev.state,
      }))
    } catch {}
    setZipLookup(false)
  }

  async function lookupBrazil(cep: string) {
    setZipLookup(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`)
      if (!res.ok) return
      const data = await res.json()
      if (data?.erro) return
      const street = data?.logradouro || ''
      const city = data?.localidade || ''
      const uf = data?.uf || ''
      setForm(prev => ({
        ...prev,
        address: prev.address || street,
        city: prev.city || city,
        state: brazilStates.includes(uf) ? uf : prev.state,
      }))
    } catch {}
    setZipLookup(false)
  }

  async function saveClient() {
    if (!form.name.trim()) {
      alert('NAME is required')
      return
    }

    // Quote-area clients are quote clients (US.QT.###); project-area are US.###.
    // Each kind has its own client_number sequence.
    const isQuote = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'quote'
    const { data: maxRow } = await supabase
      .from('clients')
      .select('client_number')
      .eq('is_quote', isQuote)
      .order('client_number', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    const nextNumber = (maxRow?.client_number ?? 0) + 1

    const { error } = await supabase
      .from('clients')
      .insert({
        name: form.name,
        email: form.email,
        instagram: form.instagram,
        country: form.country,
        phone: form.phone,
        address: form.address,
        city: form.city,
        state: form.state,
        zip: form.zip,
        client_number: nextNumber,
        is_quote: isQuote,
        preferred_message_method: form.preferred_message_method,
      })

    if (error) {
      alert(error.message)
      return
    }

    window.location.href = `${BASE_PATH}/clients?mode=${isQuote ? 'quote' : 'project'}`
  }

  const stateOptions = form.country === 'USA' ? usaStates : brazilStates
  const inputClass = 'bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h2 className="text-4xl font-bold mb-8">ADD A NEW CLIENT</h2>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">CLIENT CODE</label>
          <input value={nextCode} readOnly className={`${inputClass} w-full opacity-50 cursor-not-allowed`} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">NAME</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder="Full name"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">EMAIL</label>
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder="name@example.com"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">INSTAGRAM</label>
          <input
            value={form.instagram}
            onChange={(e) => setForm({ ...form, instagram: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder="@username"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">COUNTRY</label>
          <select
            value={form.country}
            onChange={(e) => changeCountry(e.target.value)}
            className={`${inputClass} w-full`}
          >
            <option value="USA">USA</option>
            <option value="BRAZIL">BRAZIL</option>
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PHONE</label>
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder={form.country === 'USA' ? '+1 (407) 123-4567' : '+55 (62) 99999-9999'}
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">
            ZIP {zipLookup && <span className="text-sm text-gray-400 font-normal">— looking up...</span>}
          </label>
          <input
            value={form.zip}
            onChange={(e) => setForm({ ...form, zip: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder={form.country === 'USA' ? '32837' : '74000-000'}
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">ADDRESS</label>
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder="Street, number, complement"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CITY</label>
          <input
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            className={`${inputClass} w-full`}
            placeholder="City"
          />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">STATE</label>
          <select
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
            className={`${inputClass} w-full`}
          >
            {stateOptions.map((state) => (
              <option key={state} value={state}>{state}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PREFERRED MESSAGE METHOD</label>
          <select
            value={form.preferred_message_method}
            onChange={(e) => setForm({ ...form, preferred_message_method: e.target.value })}
            className={`${inputClass} w-full`}
          >
            {messageMethods.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <button
          onClick={saveClient}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE CLIENT
        </button>

        <a href={`${BASE_PATH}/clients`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
