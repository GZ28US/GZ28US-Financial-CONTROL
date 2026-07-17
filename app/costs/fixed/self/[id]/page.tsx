'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

// PUBLIC fixed-cost-supplier self-service form. The shop sends the supplier this
// link (SEND TO on the supplier page) so they fill in their own details and save.
// Login-free (rendered outside AuthGate — see components/AuthGate.tsx); no app
// navigation or other links. One supplier row, read/written by id via anon key.

const BRAND = 'GZ28 V8 SpeedShop'
const LOGO = 'logo_gz28_black.png'
const LANG: 'en' | 'pt' = 'en'

const T = {
  en: {
    loading: 'Loading…',
    notFoundTitle: 'Link not found', notFoundBody: 'This registration link is invalid or has expired.',
    intro: 'Please fill in your details and tap', save: 'SAVE', saving: 'SAVING…',
    company: 'COMPANY / NAME', contact: 'MAIN CONTACT NAME', phone: 'PHONE / WHATSAPP', email: 'EMAIL', preferred: 'PREFERRED CONTACT',
    companyPh: 'Company or person', contactPh: 'Contact person', phonePh: '+1 (407) 123-4567', emailPh: 'name@email.com',
    savedTitle: 'Saved!', savedThanks: 'Thank you', savedRest: ' — your details were saved.',
    consent: `By submitting this form, you authorize ${BRAND} to collect and use your data solely for our business relationship. We don't sell or share it unnecessarily, and you may request access, correction, or deletion at any time.`,
  },
  pt: {
    loading: 'Carregando…',
    notFoundTitle: 'Link não encontrado', notFoundBody: 'Este link de cadastro é inválido ou expirou.',
    intro: 'Por favor, preencha seus dados e toque em', save: 'SALVAR', saving: 'SALVANDO…',
    company: 'EMPRESA / NOME', contact: 'NOME DO CONTATO PRINCIPAL', phone: 'TELEFONE / WHATSAPP', email: 'E-MAIL', preferred: 'CONTATO PREFERIDO',
    companyPh: 'Empresa ou pessoa', contactPh: 'Pessoa de contato', phonePh: '+55 (11) 99999-9999', emailPh: 'nome@email.com',
    savedTitle: 'Salvo!', savedThanks: 'Obrigado', savedRest: ' — seus dados foram salvos.',
    consent: `Ao enviar este formulário, você autoriza a ${BRAND} a coletar e usar seus dados apenas para o relacionamento comercial, conforme a LGPD (Lei nº 13.709/2018). Não compartilhamos seus dados com terceiros sem necessidade, e você pode pedir acesso, correção ou exclusão a qualquer momento.`,
  },
}
const CONTACTS = [{ v: 'WhatsApp', en: 'WhatsApp', pt: 'WhatsApp' }, { v: 'SMS', en: 'SMS', pt: 'SMS' }, { v: 'Email', en: 'Email', pt: 'E-mail' }, { v: 'Phone', en: 'Phone', pt: 'Telefone' }]

export default function FixedCostSupplierSelfForm() {
  const L = T[LANG]
  const params = useParams()
  const id = String(params.id)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [description, setDescription] = useState('')
  const [form, setForm] = useState({ company: '', contact_name: '', phone: '', email: '', preferred_contact: 'WhatsApp' })

  const labelClass = 'block mb-2 text-sm font-bold text-gray-300'
  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  useEffect(() => {
    ;(async () => {
      // Scoped SECURITY DEFINER RPC — anon has no direct table access.
      const { data } = await supabase.rpc('fixed_supplier_self_get', { p_id: id })
      if (!data) { setNotFound(true); setLoading(false); return }
      setDescription(data.description || '')
      setForm({
        company: data.company || '', contact_name: data.contact_name || '', phone: data.phone || (LANG === 'pt' ? '+55 ' : ''),
        email: data.email || '', preferred_contact: data.preferred_contact || 'WhatsApp',
      })
      setLoading(false)
    })()
  }, [id])

  async function save() {
    setError('')
    if (!form.company.trim() && !form.contact_name.trim()) { setError(LANG === 'pt' ? 'Informe ao menos a empresa ou o contato.' : 'Enter at least a company or a contact.'); return }
    setSaving(true)
    const { error: e } = await supabase.rpc('fixed_supplier_self_update', {
      p_id: id,
      p_company: form.company.trim() || null,
      p_contact_name: form.contact_name.trim() || null,
      p_phone: form.phone.trim() || null,
      p_email: form.email.trim() || null,
      p_preferred_contact: form.preferred_contact,
    })
    setSaving(false)
    if (e) { setError(String(e.message || e)); return }
    setSaved(true)
    // Confirm to the internal REPORTS group (team language: English).
    const rows: string[] = []
    if (form.company.trim()) rows.push(`Company: ${form.company.trim()}`)
    if (form.contact_name.trim()) rows.push(`Contact: ${form.contact_name.trim()}`)
    if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
    if (form.email.trim()) rows.push(`Email: ${form.email.trim()}`)
    rows.push(`Preferred: ${form.preferred_contact}`)
    const body = `✅ *FIXED COST SUPPLIER — FORM FILLED*\n${description || form.company || '—'}\nThe supplier filled in and saved their own details:\n\n${rows.join('\n')}`
    fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).catch(() => {})
  }

  if (loading) return <main className="min-h-screen bg-black text-white flex items-center justify-center p-6"><p className="text-xl text-gray-400">{L.loading}</p></main>
  if (notFound) return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
        <h1 className="text-2xl font-bold mb-2">{L.notFoundTitle}</h1>
        <p className="text-gray-400">{L.notFoundBody}</p>
      </div>
    </main>
  )
  if (saved) return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center flex flex-col gap-3">
        <div className="text-5xl">✅</div>
        <h1 className="text-2xl font-bold">{L.savedTitle}</h1>
        <p className="text-gray-400">{L.savedThanks}{form.contact_name ? `, ${form.contact_name.split(' ')[0]}` : ''}{L.savedRest}</p>
        <p className="text-gray-500 text-sm">{BRAND}</p>
      </div>
    </main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-6 flex justify-center">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/${LOGO}`} alt={BRAND} className="mx-auto mb-5 w-60 max-w-full" />
          <h1 className="text-3xl font-bold italic">{BRAND}</h1>
          {description && <p className="text-gray-300 mt-2 text-lg font-bold">{description}</p>}
          <p className="text-gray-400 mt-2 text-lg">{L.intro} <span className="font-bold text-white">{L.save}</span>.</p>
        </div>

        <div className="grid grid-cols-1 gap-5">
          <div>
            <label className={labelClass}>{L.company}</label>
            <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className={inputClass} placeholder={L.companyPh} />
          </div>
          <div>
            <label className={labelClass}>{L.contact}</label>
            <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className={inputClass} placeholder={L.contactPh} />
          </div>
          <div>
            <label className={labelClass}>{L.phone}</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} placeholder={L.phonePh} />
          </div>
          <div>
            <label className={labelClass}>{L.email}</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} placeholder={L.emailPh} />
          </div>
          <div>
            <label className={labelClass}>{L.preferred}</label>
            <select value={form.preferred_contact} onChange={(e) => setForm({ ...form, preferred_contact: e.target.value })} className={inputClass}>
              {CONTACTS.map((c) => <option key={c.v} value={c.v}>{LANG === 'pt' ? c.pt : c.en}</option>)}
            </select>
          </div>

          {error && <p className="text-red-400 font-bold">{error}</p>}

          <p className="text-xs text-gray-500 leading-relaxed">{L.consent}</p>

          <button onClick={save} disabled={saving} className={`px-6 py-5 rounded-2xl text-2xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? L.saving : L.save}
          </button>
        </div>
      </div>
    </main>
  )
}
