'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { updateSupplier } from '@/lib/supplierSave'
import { mirrorUpsertSupplier } from '@/lib/suppliersMirror'
import { BASE_PATH } from '@/lib/utils'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }

export default function EditSupplierPage() {
  const router = useRouter()
  const params = useParams()
  const supplierId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [origName, setOrigName] = useState('')
  const [discountType, setDiscountType] = useState<'FIXED' | 'VARIABLE'>('FIXED')
  const [discount, setDiscount] = useState('')
  const [discountCode, setDiscountCode] = useState('')
  const [aliases, setAliases] = useState('')
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  useEffect(() => { loadSupplier() }, [])

  async function loadSupplier() {
    const { data, error } = await supabase.from('suppliers').select('*').eq('id', supplierId).single()
    if (error || !data) { alert('Supplier not found'); router.push('/suppliers'); return }
    setName(data.name || '')
    setOrigName(data.name || '')
    setDiscountType(data.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED')
    setDiscount(data.discount != null ? String(data.discount) : '')
    setDiscountCode(data.discount_code || '')
    setAliases(data.aliases || '')
    setLoading(false)
  }

  async function save() {
    if (!name.trim()) { alert('Please enter a supplier name'); return }
    setSaving(true)
    const row = {
      name: name.trim(),
      discount_type: discountType,
      discount: discountType === 'VARIABLE' ? 0 : (discount ? parseFloat(discount) : 0),
      discount_code: discountCode.trim() || null,
      aliases: aliases.trim() || null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await updateSupplier(supplierId, row)
    if (error) { alert(error.message); setSaving(false); return }
    void mirrorUpsertSupplier(row, origName)
    router.push('/suppliers')
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />

      <h1 className="text-4xl font-bold mb-8">EDIT SUPPLIER</h1>

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

        <div>
          <label className="block mb-2 text-lg font-bold">DISCOUNT CODE</label>
          <input type="text" value={discountCode} onChange={(e) => setDiscountCode(e.target.value)} className={inputClass} placeholder="e.g. DLR20" />
          <p className="text-gray-400 text-sm mt-1">Code to enter at checkout to get our dealer price (after logging in with our account). Leave blank if none.</p>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-6">
          <a href={`${BASE_PATH}/suppliers`} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </main>
  )
}
