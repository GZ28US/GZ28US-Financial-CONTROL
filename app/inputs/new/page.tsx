'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

// Single report queued after a successful SAVE INPUT, drives the WhatsApp modal.
type ExpenseReportItem = { item: string; amount: string; quantity: string }
type ExpenseReport = {
  category: string // STOCK or CONSUMPTION
  supplier: string
  date: string
  receipt_url: string
  items: ExpenseReportItem[]
  report: boolean
}

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function formatDate(d: string) {
  if (!isValidDate(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const NEW_SUPPLIER = '+ NEW SUPPLIER'
const categories = ['CONSUMPTION', 'STOCK']

function SupplierField({ suppliers, value, onChange }: { suppliers: string[], value: string, onChange: (v: string) => void }) {
  const [showNew, setShowNew] = useState(suppliers.length === 0)
  const [newValue, setNewValue] = useState('')

  useEffect(() => { if (suppliers.length === 0) setShowNew(true) }, [suppliers])

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

export default function NewInputPage() {
  const router = useRouter()

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

  // WhatsApp report state — set after a successful SAVE, drives the modal.
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)

  useEffect(() => {
    loadSuppliers()
    // Default the category from the ?category= query param (set by the INPUTS vs
    // INVENTORY list pages) so each "ADD NEW" lands on the right category.
    const c = new URLSearchParams(window.location.search).get('category')
    if (c === 'STOCK' || c === 'CONSUMPTION') setCategory(c)
  }, [])

  // After saving, return to the list the item belongs to.
  const listHref = () => (category === 'STOCK' ? '/inventory' : '/inputs')

  async function loadSuppliers() {
    const { data } = await supabase.from('suppliers').select('name').order('name')
    if (data) setSuppliers(data.map(s => s.name))
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
      const path = `inputs/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setReceiptUrls(urls)
    setUploading(false)
  }

  function removeReceiptUrl(index: number) { setReceiptUrls(receiptUrls.filter((_, i) => i !== index)) }

  async function saveInput() {
    if (!description) { alert('Please enter a description'); return }
    await ensureSupplier(supplier)

    const { error } = await supabase.from('inputs').insert([{
      description, category,
      quantity: qty || 1,
      unit_price: unitPrice,
      purchase_date: isValidDate(purchaseDate) ? purchaseDate : null,
      supplier: supplier.trim() || null,
      receipt_url: receiptUrls.length > 0 ? JSON.stringify(receiptUrls) : null,
    }])
    if (error) { alert(error.message); return }

    // Queue the optional WhatsApp report for this input.
    if (total > 0) {
      const report: ExpenseReport = {
        category,
        supplier: supplier.trim(),
        date: purchaseDate,
        receipt_url: receiptUrls[0] || '',
        items: [{ item: description, amount: String(unitPrice), quantity: String(qty || 1) }],
        report: true,
      }
      setExpenseReports([report])
      return
    }

    router.push(listHref())
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const t = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
    const amountStr = formatUSD(t)
    const lines: string[] = [
      `*EXPENSE — ${exp.category}*`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())

    // Item bullets — always shown.
    lines.push('')
    exp.items.forEach(it => {
      const qtyN = parseFloat(it.quantity) || 1
      const price = parseFloat(it.amount) || 0
      const itemTotal = price * qtyN
      lines.push(`• ${it.item} — ${qtyN} × ${formatUSD(price)} = ${formatUSD(itemTotal)}`)
    })

    return lines.join('\n')
  }

  async function sendExpenseReports() {
    const chosen = (expenseReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    for (const exp of chosen) {
      const caption = buildExpenseCaption(exp)
      const payload: any = { body: caption }
      if (exp.receipt_url) {
        payload.documentUrl = exp.receipt_url
        payload.filename = `expense-${exp.supplier || 'purchase'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
      }
      try {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!data.ok) failures++
      } catch {
        failures++
      }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The input was still saved.`)
    setExpenseReports(null)
    router.push(listHref())
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* REPORT ON WHATSAPP? */}
      {expenseReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            </div>
            <p className="text-gray-400 text-base">Choose whether to report this input to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const t = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                const titleText = exp.items.map(it => it.item).filter(Boolean).join(', ')
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — {exp.category} — {formatUSD(t)}</p>
                      <p className="text-sm text-gray-400 truncate">{titleText || 'Input'}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
                      <p className="text-sm text-gray-400">{isValidDate(exp.date) ? formatDate(exp.date) : 'No date'}</p>
                      <p className="text-sm text-gray-500">{exp.receipt_url ? '📎 Receipt attached' : 'No receipt (text only)'}</p>
                    </div>
                    <button
                      onClick={() => { const a = [...expenseReports]; a[i] = { ...a[i], report: !a[i].report }; setExpenseReports(a) }}
                      className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap ${exp.report ? 'bg-green-700 hover:bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                    >
                      {exp.report ? 'REPORT: YES' : 'REPORT: NO'}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-gray-400 font-bold self-center">
                {expenseReports.filter(r => r.report).length} of {expenseReports.length} will be reported
              </div>
              <button onClick={sendExpenseReports} disabled={sendingReports} className={`px-6 py-3 rounded-2xl font-bold text-lg ${sendingReports ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sendingReports ? 'SENDING...' : 'DONE'}
              </button>
            </div>
          </div>
        </div>
      )}

      <h1 className="text-4xl font-bold mb-8">ADD A NEW INPUT</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} placeholder="e.g. Engine Oil 5W-30" />
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
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => { if (isNumeric(e.target.value)) setQuantity(e.target.value) }} className={inputClass} placeholder="1" />
          </div>
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">TOTAL PRICE</label>
            <div className="relative">
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input type="text" inputMode="decimal" value={totalPrice} onChange={(e) => { if (isNumeric(e.target.value)) setTotalPrice(e.target.value) }} className={`${inputClass} pl-10`} placeholder="0.00" />
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

        <button onClick={saveInput} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE INPUT</button>
        <a href={`${BASE_PATH}${listHref()}`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
