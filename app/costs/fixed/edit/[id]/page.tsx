'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const CONTACTS = ['WhatsApp', 'Email', 'Phone']

export default function EditFixedCostSupplierPage() {
  const router = useRouter()
  const params = useParams()
  const id = String(params.id)
  const [description, setDescription] = useState('')
  const [company, setCompany] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [preferred, setPreferred] = useState('WhatsApp')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
      if (data) {
        setDescription(data.description || '')
        setCompany(data.company || '')
        setContactName(data.contact_name || '')
        setPhone(data.phone || '')
        setEmail(data.email || '')
        setPreferred(data.preferred_contact || 'WhatsApp')
      }
      setLoading(false)
    })()
  }, [id])

  async function save() {
    if (!description.trim() && !company.trim()) { alert('Enter at least a description or company'); return }
    setSaving(true)
    const { error } = await supabase.from('fixed_cost_suppliers').update({
      description: description.trim() || null,
      company: company.trim() || null,
      contact_name: contactName.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      preferred_contact: preferred,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) { alert(error.message); setSaving(false); return }
    router.push(`/costs/fixed/${id}`)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT FIXED COST SUPPLIER</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <Field label="DESCRIPTION" value={description} onChange={setDescription} />
        <Field label="COMPANY" value={company} onChange={setCompany} />
        <Field label="MAIN CONTACT NAME" value={contactName} onChange={setContactName} />
        <Field label="PHONE" value={phone} onChange={setPhone} />
        <Field label="EMAIL" value={email} onChange={setEmail} type="email" />
        <div>
          <label className="block mb-2 text-lg font-bold">PREFERRED CONTACT</label>
          <select value={preferred} onChange={(e) => setPreferred(e.target.value)} className={inputClass}>
            {CONTACTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-6">
          <a href={`${BASE_PATH}/costs/fixed/${id}`} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </main>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block mb-2 text-lg font-bold">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl" />
    </div>
  )
}
