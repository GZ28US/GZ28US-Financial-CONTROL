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
  const [discountCode, setDiscountCode] = useState('')
  const [aliases, setAliases] = useState('')
  const [isCarDealer, setIsCarDealer] = useState(false)
  const [seller, setSeller] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  useEffect(() => { loadSupplier() }, [])

  async function loadSupplier() {
    const { data, error } = await supabase.from('suppliers').select('*').eq('id', supplierId).single()
    if (error || !data) { alert('Supplier not found'); router.push('/suppliers'); return }
    setName(data.name || '')
    setOrigName(data.name || '')
    setDiscountCode(data.discount_code || '')
    setAliases(data.aliases || '')
    setIsCarDealer(!!data.is_car_dealer)
    setSeller(data.seller || '')
    setPhone(data.phone || '')
    setEmail(data.email || '')
    setWebsite(data.website || '')
    setAddress(data.ordering_method || '')
    setLoading(false)
  }

  async function save() {
    if (!name.trim()) { alert('Please enter a supplier name'); return }
    setSaving(true)
    // No typed discount: the real discount computes per item in the Parts DB
    // (OUR PRICE vs open-market MAP). Only the checkout discount CODE is stored.
    const row = {
      name: name.trim(),
      discount_code: discountCode.trim() || null,
      aliases: aliases.trim() || null,
      is_car_dealer: isCarDealer,
      seller: seller.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      website: website.trim() || null,
      ordering_method: address.trim() || null,
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
          <p className="text-gray-400 text-base">No typed discount — the real discount is computed per item from validated purchases (OUR PRICE vs open-market MAP) and shown on the suppliers list.</p>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">DISCOUNT CODE</label>
          <input type="text" value={discountCode} onChange={(e) => setDiscountCode(e.target.value)} className={inputClass} placeholder="e.g. DLR20" />
          <p className="text-gray-400 text-sm mt-1">Code to enter at checkout to get our dealer price (after logging in with our account). Leave blank if none.</p>
        </div>

        <button type="button" onClick={() => setIsCarDealer(v => !v)} className={`w-full px-5 py-4 rounded-2xl text-xl font-bold text-left ${isCarDealer ? 'bg-gradient-to-r from-slate-300 to-slate-100 text-black' : 'bg-gray-900 border border-gray-700 text-gray-400'}`}>
          🏆 CAR DEALER {isCarDealer ? '— ON' : '— OFF'}
        </button>
        {isCarDealer && (
          <>
            <p className="text-gray-400 text-sm -mt-2">A car store we have real prestige with. Contacts below show on the suppliers list.</p>
            <div>
              <label className="block mb-2 text-lg font-bold">CONTACT PERSON(S)</label>
              <input type="text" value={seller} onChange={(e) => setSeller(e.target.value)} className={inputClass} placeholder="e.g. Chris Norris (sales) + Kyle Kent (Finance)" />
            </div>
            <div>
              <label className="block mb-2 text-lg font-bold">PHONE</label>
              <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="(555) 555-5555" />
            </div>
            <div>
              <label className="block mb-2 text-lg font-bold">EMAIL</label>
              <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="contact@dealer.com" />
            </div>
            <div>
              <label className="block mb-2 text-lg font-bold">WEBSITE</label>
              <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} className={inputClass} placeholder="https://dealer.com" />
            </div>
            <div>
              <label className="block mb-2 text-lg font-bold">ADDRESS</label>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className={inputClass} placeholder="Street, City, ST ZIP" />
            </div>
          </>
        )}
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
