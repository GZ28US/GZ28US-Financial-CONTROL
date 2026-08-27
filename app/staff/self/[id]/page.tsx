'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatCPF, isValidCPF } from '@/lib/utils'

// PUBLIC staff self-service form (US port of the BR feature, 31/jul/2026). The
// shop sends a staff member this link (📲 SEND on the STAFF list) so they fill
// in their own details and save. Login-free (outside AuthGate) with NO app
// navigation. The crew is mostly Brazilian, so the form ships with an EN/PT
// toggle (English default — US app standard). POSITION is internal and never
// shown here. Document accepts CPF or SSN/ITIN. Reads/writes the one staff row
// via scoped RPCs only (RLS Phase 1: anon has no table access).

const BRAND = 'GZ28 V8 SpeedShop'
const LOGO = 'logo_gz28.jpg'

const usStates = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const messageMethods = ['WhatsApp', 'SMS', 'E-Mail', 'Instagram', 'Facebook']

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
const labelClass = 'block mb-2 text-sm font-bold text-gray-400'

// 'yyyy-mm-dd' -> 'MMM d, yyyy' without new Date() (avoids the UTC day-shift).
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatBirthDateUS(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return iso
  return `${MONTHS_SHORT[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`
}

const L = {
  en: {
    intro: 'Fill in your details and tap', save: 'SAVE', saving: 'SAVING…', requiredNote: 'are required.',
    name: 'FULL NAME', email: 'E-MAIL', instagram: 'INSTAGRAM', phone: 'PHONE / WHATSAPP',
    doc: 'CPF / SSN / ITIN', birth: 'BIRTH DATE', zip: 'ZIP CODE', address: 'ADDRESS', city: 'CITY', state: 'STATE',
    passport: 'PASSPORT', passportExp: 'PASSPORT EXPIRY',
    pref: 'PREFERRED WAY TO RECEIVE MESSAGES',
    missing: 'Please fill in the required fields: ', badCpf: 'Invalid CPF. Please correct it.',
    notFoundT: 'Record not found', notFoundP: `Check the link you received or contact ${BRAND}.`,
    savedT: 'Saved!', savedP: (n: string) => `Thank you${n ? `, ${n}` : ''}! We received your information.`,
    consent: `By submitting this form you authorize ${BRAND} to collect and use your personal data (including your ID number) strictly for hiring and work-management purposes. You may request access, correction or deletion at any time.`,
    loading: 'Loading…',
  },
  pt: {
    intro: 'Preencha seus dados e toque em', save: 'SALVAR', saving: 'SALVANDO…', requiredNote: 'são obrigatórios.',
    name: 'NOME COMPLETO', email: 'E-MAIL', instagram: 'INSTAGRAM', phone: 'TELEFONE / WHATSAPP',
    doc: 'CPF / SSN / ITIN', birth: 'DATA DE NASCIMENTO', zip: 'ZIP CODE (CEP americano)', address: 'ENDEREÇO', city: 'CIDADE', state: 'ESTADO',
    passport: 'PASSAPORTE', passportExp: 'VALIDADE DO PASSAPORTE',
    pref: 'COMO PREFERE RECEBER MENSAGENS',
    missing: 'Preencha os campos obrigatórios: ', badCpf: 'CPF inválido. Corrija o CPF.',
    notFoundT: 'Cadastro não encontrado', notFoundP: `Confira o link recebido ou fale com a ${BRAND}.`,
    savedT: 'Dados salvos!', savedP: (n: string) => `Obrigado${n ? `, ${n}` : ''}! Recebemos suas informações.`,
    consent: `Ao enviar este formulário, você autoriza a ${BRAND} a coletar e usar seus dados pessoais (incluindo documento) apenas para fins de contratação e gestão do seu trabalho. Você pode pedir acesso, correção ou exclusão a qualquer momento.`,
    loading: 'Carregando…',
  },
}

export default function StaffSelfFormPage() {
  const params = useParams()
  const id = String(params.id || '')

  const [lang, setLang] = useState<'en' | 'pt'>('en')
  const t = L[lang]

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    name: '',
    email: '',
    instagram: '',
    phone: '+1 ',
    cpf: '',
    birth_date: '',
    passport: '',
    passport_expiry: '',
    zip: '',
    address: '',
    city: '',
    state: 'FL',
    preferred_message_method: 'WhatsApp',
  })

  useEffect(() => { if (id) load(id) }, [id])

  async function load(staffId: string) {
    setLoading(true)
    // RLS Phase 1: anon has no table access — scoped RPC only.
    const { data, error } = await supabase.rpc('staff_self_get', { p_id: staffId })
    if (error) { setError(error.message); setLoading(false); return }
    if (!data) { setNotFound(true); setLoading(false); return }

    setForm({
      name: data.name || '',
      email: data.email || '',
      instagram: data.instagram || '',
      phone: data.phone || '+1 ',
      cpf: data.cpf || '',
      birth_date: data.birth_date || '',
      passport: data.passport || '',
      passport_expiry: data.passport_expiry || '',
      zip: data.zip || '',
      address: data.address || '',
      city: data.city || '',
      state: data.state || 'FL',
      preferred_message_method: data.preferred_message_method || 'WhatsApp',
    })
    setLoading(false)
  }

  async function save() {
    const missing: string[] = []
    if (!form.name.trim()) missing.push(t.name)
    if (!form.email.trim()) missing.push(t.email)
    if (form.phone.replace(/\D/g, '').length < 10) missing.push(t.phone)
    if (!form.cpf.trim()) missing.push(t.doc)
    if (!form.birth_date) missing.push(t.birth)
    if (!form.zip.trim()) missing.push(t.zip)
    if (!form.address.trim()) missing.push(t.address)
    if (!form.city.trim()) missing.push(t.city)
    if (!form.state.trim()) missing.push(t.state)
    if (missing.length) { setError(t.missing + missing.join(', ') + '.'); return }
    // 11 digits reads as a CPF and must validate; 9 digits (SSN/ITIN) passes as-is.
    const docDigits = form.cpf.replace(/\D/g, '')
    if (docDigits.length === 11 && !isValidCPF(form.cpf)) { setError(t.badCpf); return }

    setSaving(true)
    setError('')
    let saveError: string | null = null
    try {
      const { error } = await supabase.rpc('staff_self_update', {
        p_id: id,
        p_name: form.name,
        p_email: form.email,
        p_instagram: form.instagram,
        p_phone: form.phone,
        p_cpf: form.cpf.trim(),
        p_birth_date: form.birth_date || null,
        p_passport: form.passport.trim() || null,
        p_passport_expiry: form.passport_expiry || null,
        p_zip: form.zip,
        p_address: form.address,
        p_city: form.city,
        p_state: form.state,
        p_preferred: form.preferred_message_method,
      })
      if (error) saveError = error.message
    } catch (e) {
      saveError = String(e)
    } finally {
      setSaving(false)
    }
    if (saveError) { setError(saveError); return }
    setSaved(true)

    // Confirm to the internal REPORTS group that the member filled their own data.
    const rows: string[] = []
    if (form.email.trim()) rows.push(`E-mail: ${form.email.trim()}`)
    if (form.instagram.trim()) rows.push(`Instagram: ${form.instagram.trim()}`)
    if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
    if (form.cpf.trim()) rows.push(`Document: ${form.cpf.trim()}`)
    if (form.birth_date) rows.push(`Birth date: ${formatBirthDateUS(form.birth_date)}`)
    if (form.passport.trim()) rows.push(`Passport: ${form.passport.trim()}`)
    if (form.passport_expiry) rows.push(`Passport expiry: ${formatBirthDateUS(form.passport_expiry)}`)
    if (form.zip.trim()) rows.push(`ZIP: ${form.zip.trim()}`)
    if (form.address.trim()) rows.push(`Address: ${form.address.trim()}`)
    if (form.city.trim()) rows.push(`City: ${form.city.trim()}`)
    if (form.state.trim()) rows.push(`State: ${form.state.trim()}`)
    if (form.preferred_message_method.trim()) rows.push(`Messages: ${form.preferred_message_method.trim()}`)
    const body = `✅ *STAFF FORM — FILLED BY THE MEMBER*\n${form.name || '—'}\nThe staff member filled in and saved their own details:${rows.length ? '\n\n' + rows.join('\n') : ''}`
    fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).catch(() => {})
  }

  const langToggle = (
    <div className="flex justify-center gap-2 mb-4">
      {(['en', 'pt'] as const).map(l => (
        <button key={l} onClick={() => setLang(l)} className={`px-4 py-1.5 rounded-full text-sm font-bold ${lang === l ? 'bg-white text-black' : 'bg-gray-800 text-gray-300'}`}>
          {l === 'en' ? 'English' : 'Português'}
        </button>
      ))}
    </div>
  )

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <p className="text-xl text-gray-400">{t.loading}</p>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-bold mb-2">{t.notFoundT}</h1>
          <p className="text-gray-400">{t.notFoundP}</p>
        </div>
      </main>
    )
  }

  if (saved) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center flex flex-col gap-3">
          <div className="text-5xl">✅</div>
          <h1 className="text-2xl font-bold">{t.savedT}</h1>
          <p className="text-gray-400">{t.savedP(form.name ? form.name.split(' ')[0] : '')}</p>
          <p className="text-gray-500 text-sm">{BRAND}</p>
        </div>
      </main>
    )
  }

  const req = <span className="text-red-400">*</span>

  return (
    <main className="min-h-screen bg-black text-white p-6 flex justify-center">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/${LOGO}`} alt={BRAND} className="mx-auto mb-5 w-60 max-w-full" />
          <h1 className="text-3xl font-bold italic">{BRAND}</h1>
          {langToggle}
          <p className="text-gray-400 mt-2 text-lg">{t.intro} <span className="font-bold text-white">{t.save}</span>. {req} {t.requiredNote}</p>
        </div>

        <div className="grid grid-cols-1 gap-5">
          <div>
            <label className={labelClass}>{t.name} {req}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </div>

          <div>
            <label className={labelClass}>{t.email} {req}</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} placeholder="you@example.com" />
          </div>

          <div>
            <label className={labelClass}>{t.instagram}</label>
            <input value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} className={inputClass} placeholder="@username" />
          </div>

          <div>
            <label className={labelClass}>{t.phone} {req}</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} placeholder="+1 (000) 000-0000" />
          </div>

          <div>
            <label className={labelClass}>{t.doc} {req}</label>
            <input
              value={form.cpf}
              onChange={(e) => {
                const v = e.target.value
                // 11-digit input formats as CPF; shorter (SSN/ITIN) stays free-form.
                setForm({ ...form, cpf: v.replace(/\D/g, '').length === 11 ? formatCPF(v) : v })
                if (error) setError('')
              }}
              className={inputClass}
              placeholder="000.000.000-00 / 000-00-0000"
            />
          </div>

          <div>
            <label className={labelClass}>{t.birth} {req}</label>
            <input type="date" value={form.birth_date} onChange={(e) => setForm({ ...form, birth_date: e.target.value })} className={inputClass} max={new Date().toISOString().slice(0, 10)} />
          </div>

          {/* Optional: only foreign staff carry one, so it never blocks the save. */}
          <div>
            <label className={labelClass}>{t.passport}</label>
            <input value={form.passport} onChange={(e) => setForm({ ...form, passport: e.target.value.toUpperCase() })} className={inputClass} placeholder="GN633265" />
          </div>

          <div>
            <label className={labelClass}>{t.passportExp}</label>
            <input type="date" value={form.passport_expiry} onChange={(e) => setForm({ ...form, passport_expiry: e.target.value })} className={inputClass} />
          </div>

          <div>
            <label className={labelClass}>{t.zip} {req}</label>
            <input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} className={inputClass} inputMode="numeric" placeholder="32837" />
          </div>

          <div>
            <label className={labelClass}>{t.address} {req}</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputClass} placeholder="Street, number, apt" />
          </div>

          <div>
            <label className={labelClass}>{t.city} {req}</label>
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={inputClass} placeholder="Orlando" />
          </div>

          <div>
            <label className={labelClass}>{t.state} {req}</label>
            <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={inputClass}>
              {usStates.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className={labelClass}>{t.pref}</label>
            <select value={form.preferred_message_method} onChange={(e) => setForm({ ...form, preferred_message_method: e.target.value })} className={inputClass}>
              {messageMethods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <p className="text-xs text-gray-500 leading-relaxed">{t.consent}</p>

          <button
            onClick={save}
            disabled={saving}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-5 rounded-2xl text-2xl font-bold mt-1"
          >
            {saving ? t.saving : t.save}
          </button>
        </div>
      </div>
    </main>
  )
}
