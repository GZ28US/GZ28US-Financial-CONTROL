'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatCPF, isValidCPF } from '@/lib/utils'

// PUBLIC client self-service form. The shop sends a client this link (SEND CLIENT
// on the client page) so the client fills in their own details and saves. It is
// login-free (rendered outside AuthGate — see components/AuthGate.tsx) and has NO
// app navigation or other links: only this page. Both apps serve clients from both
// countries, so a CEP (Brazil) or ZIP (USA) autofills the address accordingly, and
// CPF only shows for BRAZIL. Reads/writes the one client row by id via the anon key.

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

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
const labelClass = 'block mb-2 text-sm font-bold text-gray-400'

export default function ClientSelfFormPage() {
  const params = useParams()
  const id = String(params.id || '')

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [zipLookup, setZipLookup] = useState(false)

  const [form, setForm] = useState({
    name: '',
    email: '',
    instagram: '',
    country: 'USA',
    phone: '+1 ',
    cpf: '',
    address: '',
    city: '',
    state: 'FL',
    zip: '',
    preferred_message_method: 'WhatsApp',
  })

  useEffect(() => { if (id) load(id) }, [id])

  async function load(clientId: string) {
    setLoading(true)
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .maybeSingle()

    if (error) { setError(error.message); setLoading(false); return }
    if (!data) { setNotFound(true); setLoading(false); return }

    setForm({
      name: data.name || '',
      email: data.email || '',
      instagram: data.instagram || '',
      country: data.country || 'USA',
      phone: data.phone || '',
      cpf: data.cpf || '',
      address: data.address || '',
      city: data.city || '',
      state: data.state || '',
      zip: data.zip || '',
      preferred_message_method: data.preferred_message_method || 'WhatsApp',
    })
    setLoading(false)
  }

  function changeCountry(country: string) {
    setForm({
      ...form,
      country,
      phone: country === 'USA' ? '+1 ' : '+55 ',
      state: country === 'USA' ? 'FL' : 'SP',
    })
  }

  // ZIP/CEP -> address autofill. USA uses zippopotam.us (city + state); Brazil uses
  // viacep.com.br (street + city + state). Called from the field's onChange (only on
  // the client's own typing — never on load, so a saved address is never clobbered).
  // Failures are silently ignored so the client can just type manually.
  async function lookupZip(country: string, rawZip: string) {
    const digits = rawZip.replace(/\D/g, '')
    if (country === 'BRAZIL' && digits.length === 8) {
      setZipLookup(true)
      try {
        const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`)
        if (res.ok) {
          const data = await res.json()
          if (!data?.erro) {
            setForm(prev => ({
              ...prev,
              address: data?.logradouro || prev.address,
              city: data?.localidade || prev.city,
              state: brazilStates.includes(data?.uf) ? data.uf : prev.state,
            }))
          }
        }
      } catch {}
      setZipLookup(false)
    } else if (country === 'USA' && digits.length === 5) {
      setZipLookup(true)
      try {
        const res = await fetch(`https://api.zippopotam.us/us/${digits}`)
        if (res.ok) {
          const data = await res.json()
          const place = data?.places?.[0]
          if (place) {
            setForm(prev => ({
              ...prev,
              city: place['place name'] || prev.city,
              state: usaStates.includes(place['state abbreviation']) ? place['state abbreviation'] : prev.state,
            }))
          }
        }
      } catch {}
      setZipLookup(false)
    }
  }

  async function save() {
    // CPF is optional, but if a Brazilian client fills it, it must be valid.
    if (form.country === 'BRAZIL' && form.cpf.trim() && !isValidCPF(form.cpf)) {
      setError('Invalid CPF. Fix the CPF or leave the field blank.')
      return
    }
    setSaving(true)
    setError('')
    // try/finally so a thrown error (e.g. a network blip) can never leave the SAVE
    // button stuck disabled — setSaving(false) always runs.
    let saveError: string | null = null
    try {
      const { error } = await supabase
        .from('clients')
        .update({
          name: form.name,
          email: form.email,
          instagram: form.instagram,
          country: form.country,
          phone: form.phone,
          cpf: form.country === 'BRAZIL' && form.cpf.trim() ? form.cpf.trim() : null,
          address: form.address,
          city: form.city,
          state: form.state,
          zip: form.zip,
          preferred_message_method: form.preferred_message_method,
        })
        .eq('id', id)
      if (error) saveError = error.message
    } catch (e) {
      saveError = String(e)
    } finally {
      setSaving(false)
    }
    if (saveError) { setError(saveError); return }
    setSaved(true)
    // Confirm to the REPORTS group that the client filled in their own data, and
    // list every field they actually filled (blanks skipped). No `to` -> the route
    // defaults to the group. Fire-and-forget.
    const rows: string[] = []
    if (form.email.trim()) rows.push(`Email: ${form.email.trim()}`)
    if (form.instagram.trim()) rows.push(`Instagram: ${form.instagram.trim()}`)
    if (form.country.trim()) rows.push(`Country: ${form.country === 'USA' ? 'USA' : 'BRAZIL'}`)
    if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
    if (form.country === 'BRAZIL' && form.cpf.trim()) rows.push(`CPF: ${form.cpf.trim()}`)
    if (form.address.trim()) rows.push(`Address: ${form.address.trim()}`)
    if (form.city.trim()) rows.push(`City: ${form.city.trim()}`)
    if (form.state.trim()) rows.push(`State: ${form.state.trim()}`)
    if (form.zip.trim()) rows.push(`${form.country === 'USA' ? 'ZIP' : 'CEP'}: ${form.zip.trim()}`)
    if (form.preferred_message_method.trim()) rows.push(`Messages: ${form.preferred_message_method.trim()}`)
    const body = `✅ *FORM FILLED BY THE CLIENT*\n${form.name || '—'}\nThe client filled in and saved their own details:${rows.length ? '\n\n' + rows.join('\n') : ''}`
    fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).catch(() => {})
  }

  const stateOptions = form.country === 'USA' ? usaStates : brazilStates

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <p className="text-xl text-gray-400">Loading…</p>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-bold mb-2">Record not found</h1>
          <p className="text-gray-400">Check the link you received or contact GZ28 V8 SpeedShop.</p>
        </div>
      </main>
    )
  }

  if (saved) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center flex flex-col gap-3">
          <div className="text-5xl">✅</div>
          <h1 className="text-2xl font-bold">Saved!</h1>
          <p className="text-gray-400">Thank you{form.name ? `, ${form.name.split(' ')[0]}` : ''}! We received your information.</p>
          <p className="text-gray-500 text-sm">GZ28 V8 SpeedShop</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-6 flex justify-center">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/logo_gz28_black.png`} alt="GZ28 V8 SpeedShop" className="mx-auto mb-5 w-60 max-w-full" />
          <h1 className="text-3xl font-bold italic">GZ28 V8 SpeedShop</h1>
          <p className="text-gray-400 mt-2 text-lg">Fill in your details and tap <span className="font-bold text-white">SAVE</span>.</p>
        </div>

        <div className="grid grid-cols-1 gap-5">
          <div>
            <label className={labelClass}>FULL NAME</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="Your name" />
          </div>

          <div>
            <label className={labelClass}>EMAIL</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} placeholder="you@example.com" />
          </div>

          <div>
            <label className={labelClass}>INSTAGRAM</label>
            <input value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} className={inputClass} placeholder="@username" />
          </div>

          <div>
            <label className={labelClass}>COUNTRY</label>
            <select value={form.country} onChange={(e) => changeCountry(e.target.value)} className={inputClass}>
              <option value="USA">USA</option>
              <option value="BRAZIL">BRAZIL</option>
            </select>
          </div>

          <div>
            <label className={labelClass}>PHONE / WHATSAPP</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} placeholder={form.country === 'USA' ? '+1 (407) 123-4567' : '+55 (11) 99999-9999'} />
          </div>

          {form.country === 'BRAZIL' && (
            <div>
              <label className={labelClass}>CPF <span className="font-normal text-gray-500">(optional)</span></label>
              <input value={form.cpf} onChange={(e) => { setForm({ ...form, cpf: formatCPF(e.target.value) }); if (error) setError('') }} className={inputClass} inputMode="numeric" placeholder="000.000.000-00" />
            </div>
          )}

          <div>
            <label className={labelClass}>
              {form.country === 'USA' ? 'ZIP' : 'CEP'}
              {zipLookup && <span className="ml-2 font-normal text-gray-400">— looking up…</span>}
            </label>
            <input
              value={form.zip}
              onChange={(e) => { const v = e.target.value; setForm({ ...form, zip: v }); lookupZip(form.country, v) }}
              className={inputClass}
              inputMode="numeric"
              placeholder={form.country === 'USA' ? '32801' : '00000-000'}
            />
          </div>

          <div>
            <label className={labelClass}>ADDRESS</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} placeholder="Street, number, unit" />
          </div>

          <div>
            <label className={labelClass}>CITY</label>
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={inputClass} placeholder="City" />
          </div>

          <div>
            <label className={labelClass}>STATE</label>
            <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={inputClass}>
              {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className={labelClass}>PREFERRED MESSAGE METHOD</label>
            <select value={form.preferred_message_method} onChange={(e) => setForm({ ...form, preferred_message_method: e.target.value })} className={inputClass}>
              {messageMethods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-5 rounded-2xl text-2xl font-bold mt-1"
          >
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>
    </main>
  )
}
