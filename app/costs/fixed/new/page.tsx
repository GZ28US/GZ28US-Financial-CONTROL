'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const CONTACTS = ['WhatsApp', 'Email', 'Phone']

export default function NewFixedCostSupplierPage() {
  const router = useRouter()
  const [description, setDescription] = useState('')
  const [company, setCompany] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [preferred, setPreferred] = useState('WhatsApp')
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  async function save() {
    if (!description.trim() && !company.trim()) { alert('Enter at least a description or company'); return }
    setSaving(true)
    const { error } = await supabase.from('fixed_cost_suppliers').insert({
      description: description.trim() || null,
      company: company.trim() || null,
      contact_name: contactName.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      preferred_contact: preferred,
      updated_at: new Date().toISOString(),
    })
    if (error) { alert(error.message); setSaving(false); return }
    router.push('/costs/fixed')
  }

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />
      <h1 className="text-4xl font-bold mb-8">NEW FIXED COST SUPPLIER</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <Field label="DESCRIPTION" value={description} onChange={setDescription} placeholder="e.g. Internet, Rent, Accounting…" />
        <Field label="COMPANY" value={company} onChange={setCompany} placeholder="Company name" />
        <Field label="MAIN CONTACT NAME" value={contactName} onChange={setContactName} placeholder="Contact person" />
        <Field label="PHONE" value={phone} onChange={setPhone} placeholder="+1 555 000 0000" />
        <Field label="EMAIL" value={email} onChange={setEmail} placeholder="contact@company.com" type="email" />
        <div>
          <label className="block mb-2 text-lg font-bold">PREFERRED CONTACT</label>
          <select value={preferred} onChange={(e) => setPreferred(e.target.value)} className={inputClass}>
            {CONTACTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-6">
          <a href={`${BASE_PATH}/costs/fixed`} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? 'SAVING...' : 'ADD FIXED COST SUPPLIER'}
          </button>
        </div>
      </div>
    </main>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="block mb-2 text-lg font-bold">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl" placeholder={placeholder} />
    </div>
  )
}
