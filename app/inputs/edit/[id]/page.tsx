'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

const NEW_SUPPLIER = '+ NEW SUPPLIER'
const categories = ['CONSUMPTION', 'STOCK']

function SupplierField({ suppliers, value, onChange }: { suppliers: string[], value: string, onChange: (v: string) => void }) {
  const [showNew, setShowNew] = useState(false)
  const [newValue, setNewValue] = useState('')

  useEffect(() => {
    if (suppliers.length === 0) setShowNew(true)
    else if (value && !suppliers.includes(value)) { setShowNew(true); setNewValue(value) }
  }, [suppliers])

  function handleSelect(v: string) {
    if (v === NEW_SUPPLIER) { setShowNew(true); setNewValue(''); onChange('') }
    else { setShowNew(false); onChange(v) }
  }

  function handleNewChange(v: string) { setNewValue(v); onChange(v) }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (showNew) return (
    <div className="space-y-2">
      <input type="text" placeholder="Type supplier name" value={newValue} onChange={(e) => handleNewChange(e.target.value)} className={inputClass} />
      {suppliers.length > 0 && <button onClick={() => { setShowNew(false); onChange('') }} className="text-gray-400 text-sm hover:text-white">← Back to list</button>}
    </div>
  )

  return (
    <select value={value} onChange={(e) => handleSelect(e.target.value)} className={selectClass}>
      <option value="">— Select supplier —</option>
      {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
      <option value={NEW_SUPPLIER}>{NEW_SUPPLIER}</option>
    </select>
  )
}

export default function EditInputPage() {
  const params = useParams()
  const router = useRouter()
  const inputId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('STOCK')
  const [quantity, setQuantity] = useState('1')
  const [totalPrice, setTotalPrice] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [supplier, setSupplier] = useState('')
  const [receiptUrls, setReceiptUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [openReceipts, setOpenReceipts] = useState(false)

  useEffect(() => { loadSuppliers(); loadInput() }, [])

  async function loadSuppliers() {
    const { data } = await supabase.from('suppliers').select('name').order('name')
    if (data) setSuppliers(data.map(s => s.name))
  }

  async function loadInput() {
    const { data, error } = await supabase.from('inputs').select('*').eq('id', inputId).single()
    if (error || !data) { alert('Input not found'); router.push('/inputs'); return }
    setDescription(data.description || '')
    setCategory(data.category || 'STOCK')
    setQuantity(String(data.quantity || 1))
    const computedTotal = (parseFloat(data.unit_price) || 0) * (parseFloat(data.quantity) || 1)
    setTotalPrice(computedTotal > 0 ? computedTotal.toFixed(2) : '')
    setPurchaseDate(data.purchase_date || '')
    setSupplier(data.supplier || '')
    setReceiptUrls(parseReceiptUrls(data.receipt_url))
    setLoading(false)
  }

  async function ensureSupplier(name: string) {
    if (!name.trim() || suppliers.includes(name.trim())) return
    await supabase.from('suppliers').upsert([{ name: name.trim() }], { onConflict: 'name' })
    setSuppliers(prev => [...prev, name.trim()].sort())
  }

  const qty = parseFloat(quantity) || 0
  const total = parseFloat(totalPrice) || 0
  const unitPrice = qty > 0 ? total / qty : 0

  async function uploadReceipts(files: FileList) {
    setUploading(true)
    const urls = [...receiptUrls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `inputs/${inputId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setReceiptUrls(urls)
    await supabase.from('inputs').update({ receipt_url: urls.length > 0 ? JSON.stringify(urls) : null }).eq('id', inputId)
    setUploading(false)
  }

  async function removeReceiptUrl(index: number) {
    const updated = receiptUrls.filter((_, i) => i !== index)
    setReceiptUrls(updated)
    await supabase.from('inputs').update({ receipt_url: updated.length > 0 ? JSON.stringify(updated) : null }).eq('id', inputId)
  }

  async function saveInput() {
    if (!description) { alert('Please enter a description'); return }
    await ensureSupplier(supplier)

    const { error } = await supabase.from('inputs').update({
      description, category,
      quantity: qty || 1,
      unit_price: unitPrice,
      purchase_date: isValidDate(purchaseDate) ? purchaseDate : null,
      supplier: supplier.trim() || null,
      receipt_url: receiptUrls.length > 0 ? JSON.stringify(receiptUrls) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', inputId)
    if (error) { alert(error.message); return }
    router.push('/inputs')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT INPUT</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CATEGORY</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectClass}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SUPPLIER</label>
          <SupplierField suppliers={suppliers} value={supplier} onChange={setSupplier} />
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">QUANTITY</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => { if (isNumeric(e.target.value)) setQuantity(e.target.value) }} className={inputClass} />
          </div>
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">TOTAL PRICE</label>
            <div className="relative">
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input type="text" inputMode="decimal" value={totalPrice} onChange={(e) => { if (isNumeric(e.target.value)) setTotalPrice(e.target.value) }} className={`${inputClass} pl-10`} />
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">UNIT PRICE</span>
            <span className="text-lg font-bold text-gray-300">{formatUSD(unitPrice)}</span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-700 pt-2">
            <span className="text-gray-400 font-bold">TOTAL COST</span>
            <span className="text-xl font-bold">{formatUSD(total)}</span>
          </div>
        </div>

        <DatePicker label="DATE OF PURCHASE" value={purchaseDate} onChange={setPurchaseDate} />

        <div>
          <label className="block mb-2 text-lg font-bold">RECEIPT</label>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer">
              {uploading ? '...' : '📎 ADD FILES'}
              <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadReceipts(e.target.files) }} />
            </label>
            {receiptUrls.length > 0 && (
              <div className="relative">
                <button onClick={() => setOpenReceipts(!openReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-2 rounded-xl font-bold text-sm">
                  RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}
                </button>
                {openReceipts && (
                  <div className="absolute left-0 top-10 bg-gray-800 border border-gray-600 rounded-xl p-2 z-10 min-w-48 space-y-1">
                    {receiptUrls.map((url, ui) => (
                      <div key={ui} className="flex items-center gap-2">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate">File {ui + 1}</a>
                        <button onClick={() => removeReceiptUrl(ui)} className="text-red-400 hover:text-red-300 text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <button onClick={saveInput} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        <a href={`${BASE_PATH}/inputs`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}