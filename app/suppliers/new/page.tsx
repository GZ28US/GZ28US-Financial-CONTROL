'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }

export default function NewSupplierPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [discountType, setDiscountType] = useState<'FIXED' | 'VARIABLE'>('FIXED')
  const [discount, setDiscount] = useState('')
  const [aliases, setAliases] = useState('')
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  async function save() {
    if (!name.trim()) { alert('Please enter a supplier name'); return }
    setSaving(true)
    const { error } = await supabase.from('suppliers').insert([{
      name: name.trim(),
      discount_type: discountType,
      discount: discountType === 'VARIABLE' ? 0 : (discount ? parseFloat(discount) : 0),
      aliases: aliases.trim() || null,
      updated_at: new Date().toISOString(),
    }])
    if (error) { alert(error.message); setSaving(false); return }
    router.push('/suppliers')
  }

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />

      <h1 className="text-4xl font-bold mb-8">NEW SUPPLIER</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <div>
          <label className="block mb-2 text-lg font-bold">SUPPLIER NAME</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Supplier name" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">ALSO KNOWN AS</label>
          <textarea value={aliases} onChange={(e) => setAliases(e.target.value)} className={`${inputClass} h-28`} placeholder="Alternate names / acronyms — one per line (e.g. HHP Racing)" />
          <p className="text-gray-400 text-sm mt-1">Any of these will be recognized as this supplier on scans (case, spaces and punctuation are ignored automatically).</p>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">DISCOUNT</label>
          <div className="flex gap-3 mb-3">
            <button type="button" onClick={() => setDiscountType('FIXED')} className={`flex-1 px-5 py-3 rounded-2xl font-bold text-lg ${discountType === 'FIXED' ? 'bg-yellow-600' : 'bg-gray-800 text-gray-400'}`}>FIXED %</button>
            <button type="button" onClick={() => setDiscountType('VARIABLE')} className={`flex-1 px-5 py-3 rounded-2xl font-bold text-lg ${discountType === 'VARIABLE' ? 'bg-yellow-600' : 'bg-gray-800 text-gray-400'}`}>VARIABLE</button>
          </div>
          {discountType === 'FIXED' ? (
            <div className="relative">
              <input type="text" inputMode="decimal" value={discount} onChange={(e) => { if (isNumeric(e.target.value)) setDiscount(e.target.value) }} className={`${inputClass} pr-10`} placeholder="0" />
              <span className="absolute right-5 top-1/2 -translate-y-1/2 text-gray-400">%</span>
            </div>
          ) : (
            <p className="text-gray-400 text-base">Discount is entered per item on each purchase from this supplier.</p>
          )}
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-6">
          <a href={`${BASE_PATH}/suppliers`} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? 'SAVING...' : 'ADD SUPPLIER'}
          </button>
        </div>
      </div>
    </main>
  )
}
