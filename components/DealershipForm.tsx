'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { insertSupplier, updateSupplier } from '@/lib/supplierSave'
import { mirrorUpsertSupplier } from '@/lib/suppliersMirror'

// A DEALERSHIP supplier — a vendor GZ28 holds a dealer contract with. Stored on the
// same `suppliers` table (is_dealership=true) so it still feeds scan-matching and
// invoice discounts, plus dealer-specific fields. Discount is always VARIABLE
// (entered per item at purchase). Credentials are NOT stored — website URL only;
// the password lives in your password manager.

export type DealershipData = {
  name: string
  aliases: string | null
  website: string | null
  seller: string | null
  phone: string | null
  email: string | null
  ordering_method: string | null
  account_number: number | null
  discount_code: string | null
}

function pad3(n: number | null) { return n != null ? String(n).padStart(3, '0') : '—' }

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

export default function DealershipForm({ supplierId, initial }: { supplierId?: string; initial?: DealershipData }) {
  const router = useRouter()

  const [name, setName] = useState(initial?.name || '')
  const [aliases, setAliases] = useState(initial?.aliases || '')
  const [website, setWebsite] = useState(initial?.website || '')
  const [seller, setSeller] = useState(initial?.seller || '')
  const [phone, setPhone] = useState(initial?.phone || '')
  const [email, setEmail] = useState(initial?.email || '')
  const [orderingMethod, setOrderingMethod] = useState(initial?.ordering_method || '')
  const [discountCode, setDiscountCode] = useState(initial?.discount_code || '')
  const [accountNumber, setAccountNumber] = useState<number | null>(initial?.account_number ?? null)
  const [saving, setSaving] = useState(false)

  // New dealership: the system assigns the next account number (read-only).
  useEffect(() => {
    if (supplierId) return
    ;(async () => {
      const { data } = await supabase.from('suppliers').select('account_number')
        .eq('is_dealership', true).order('account_number', { ascending: false, nullsFirst: false }).limit(1)
      setAccountNumber((data?.[0]?.account_number || 0) + 1)
    })()
  }, [supplierId])

  async function save() {
    if (!name.trim()) { alert('Please enter a supplier name'); return }
    setSaving(true)
    const row: any = {
      name: name.trim(),
      aliases: aliases.trim() || null,
      is_dealership: true,
      discount_type: 'VARIABLE',
      discount: 0,
      website: website.trim() || null,
      seller: seller.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      ordering_method: orderingMethod || null,
      discount_code: discountCode.trim() || null,
      account_number: accountNumber,
      updated_at: new Date().toISOString(),
    }
    const res = supplierId
      ? await updateSupplier(supplierId, row)
      : await insertSupplier(row)
    if (res.error) { alert(res.error.message); setSaving(false); return }
    void mirrorUpsertSupplier(row, initial?.name)
    router.push('/suppliers')
  }

  return (
    <div className="grid grid-cols-1 gap-5 max-w-2xl pb-32">
      <div>
        <label className="block mb-2 text-lg font-bold">ACCOUNT #</label>
        <input value={`D-${pad3(accountNumber)}`} readOnly className={`${inputClass} opacity-60 cursor-not-allowed`} />
        <p className="text-gray-400 text-sm mt-1">Assigned automatically — not editable.</p>
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">SUPPLIER NAME</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="e.g. High Horse Performance" />
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">ALIAS</label>
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} className={inputClass} placeholder="e.g. HHP" />
        <p className="text-gray-400 text-sm mt-1">Short name also recognized as this supplier on scans (case, spaces and punctuation are ignored).</p>
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">WEBSITE</label>
        <input value={website} onChange={(e) => setWebsite(e.target.value)} className={inputClass} placeholder="https://…" />
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">DISCOUNT</label>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-lg text-gray-300">
          <span className="px-3 py-1 rounded-full text-sm font-bold bg-yellow-600 text-black mr-3">VARIABLE</span>
          Entered per item on each purchase from this dealership.
        </div>
      </div>

      <div className="border-t border-gray-800 pt-5">
        <label className="block mb-2 text-lg font-bold">SELLER (rep)</label>
        <input value={seller} onChange={(e) => setSeller(e.target.value)} className={inputClass} placeholder="Sales rep name" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div>
          <label className="block mb-2 text-lg font-bold">PHONE</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="+1 …" />
        </div>
        <div>
          <label className="block mb-2 text-lg font-bold">EMAIL</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="rep@supplier.com" />
        </div>
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">ORDERING METHOD</label>
        <select value={orderingMethod} onChange={(e) => setOrderingMethod(e.target.value)} className={inputClass}>
          <option value="">— Select —</option>
          <option value="ONLINE">Online</option>
          <option value="PHONE">Phone</option>
          <option value="EMAIL">Email</option>
        </select>
      </div>

      <div>
        <label className="block mb-2 text-lg font-bold">DISCOUNT CODE</label>
        <input value={discountCode} onChange={(e) => setDiscountCode(e.target.value)} className={inputClass} placeholder="e.g. DLR20" />
        <p className="text-gray-400 text-sm mt-1">Code to enter at checkout to get our dealer price (after logging in with our account). Leave blank if none.</p>
      </div>

      <div className="flex items-center gap-6 pt-2">
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
        <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
          {saving ? 'SAVING...' : (supplierId ? 'SAVE DEALERSHIP' : 'ADD DEALERSHIP')}
        </button>
      </div>
    </div>
  )
}
