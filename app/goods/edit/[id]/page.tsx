'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

type Expense = {
  id?: string
  description: string
  amount: string
  expense_date: string
  supplier: string
  receipt_urls: string[]
}

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function formatDate(d: string) {
  if (!isValidDate(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

const NEW_SUPPLIER = '+ NEW SUPPLIER'

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

export default function EditGoodPage() {
  const params = useParams()
  const router = useRouter()
  const goodId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [totalPrice, setTotalPrice] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [supplier, setSupplier] = useState('')
  const [goodReceiptUrls, setGoodReceiptUrls] = useState<string[]>([])
  const [uploadingGood, setUploadingGood] = useState(false)
  const [openGoodReceipts, setOpenGoodReceipts] = useState(false)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ description: '', amount: '', expense_date: '', supplier: '', receipt_urls: [] })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ description: '', amount: '', expense_date: '', supplier: '', receipt_urls: [] })
  const [uploadingExpenseIndex, setUploadingExpenseIndex] = useState<number | null>(null)
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)

  useEffect(() => { loadSuppliers(); loadGood() }, [])

  async function loadSuppliers() {
    const { data } = await supabase.from('suppliers').select('name').order('name')
    if (data) setSuppliers(data.map(s => s.name))
  }

  async function loadGood() {
    const { data, error } = await supabase.from('goods').select('*').eq('id', goodId).single()
    if (error || !data) { alert('Good not found'); router.push('/goods'); return }
    setDescription(data.description || '')
    setQuantity(String(data.quantity || 1))
    // Reconstruct total price from unit_price * quantity
    const computedTotal = (parseFloat(data.unit_price) || 0) * (parseFloat(data.quantity) || 1)
    setTotalPrice(computedTotal > 0 ? computedTotal.toFixed(2) : '')
    setPurchaseDate(data.purchase_date || '')
    setSupplier(data.supplier || '')
    setGoodReceiptUrls(parseReceiptUrls(data.receipt_url))

    const { data: expensesData } = await supabase.from('good_expenses').select('*').eq('good_id', goodId).order('created_at', { ascending: true })
    if (expensesData) setExpenses(expensesData.map(e => ({
      id: e.id, description: e.description, amount: String(e.amount),
      expense_date: e.expense_date || '', supplier: e.supplier || '',
      receipt_urls: parseReceiptUrls(e.receipt_url),
    })))

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
  const expensesTotal = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
  const grandTotal = total + expensesTotal

  async function uploadGoodReceipts(files: FileList) {
    setUploadingGood(true)
    const urls = [...goodReceiptUrls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `goods/${goodId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setGoodReceiptUrls(urls)
    await supabase.from('goods').update({ receipt_url: urls.length > 0 ? JSON.stringify(urls) : null }).eq('id', goodId)
    setUploadingGood(false)
  }

  async function removeGoodReceiptUrl(index: number) {
    const updated = goodReceiptUrls.filter((_, i) => i !== index)
    setGoodReceiptUrls(updated)
    await supabase.from('goods').update({ receipt_url: updated.length > 0 ? JSON.stringify(updated) : null }).eq('id', goodId)
  }

  async function uploadExpenseReceipts(files: FileList, index: number) {
    setUploadingExpenseIndex(index)
    const urls = [...expenses[index].receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `expenses/${goodId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    const updated = [...expenses]; updated[index] = { ...updated[index], receipt_urls: urls }; setExpenses(updated)
    const exp = updated[index]
    if (exp.id) await supabase.from('good_expenses').update({ receipt_url: JSON.stringify(urls) }).eq('id', exp.id)
    setUploadingExpenseIndex(null)
  }

  async function uploadEditingExpenseReceipts(files: FileList) {
    const urls = [...editingExpense.receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `expenses/${goodId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setEditingExpense({ ...editingExpense, receipt_urls: urls })
  }

  function addExpense() {
    if (!newExpense.description || !newExpense.amount) { alert('Please enter description and amount'); return }
    setExpenses([...expenses, newExpense])
    setNewExpense({ description: '', amount: '', expense_date: '', supplier: '', receipt_urls: [] })
  }

  async function removeExpense(index: number) {
    const exp = expenses[index]
    if (exp.id) await supabase.from('good_expenses').delete().eq('id', exp.id)
    setExpenses(expenses.filter((_, i) => i !== index))
  }

  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }); setOpenReceiptsIndex(null) }

  async function saveEditExpense() {
    if (!editingExpense.description || !editingExpense.amount) { alert('Please enter description and amount'); return }
    await ensureSupplier(editingExpense.supplier)
    const exp = expenses[editingExpenseIndex!]
    if (exp.id) {
      const { error } = await supabase.from('good_expenses').update({
        description: editingExpense.description, amount: parseFloat(editingExpense.amount),
        expense_date: isValidDate(editingExpense.expense_date) ? editingExpense.expense_date : null,
        supplier: editingExpense.supplier.trim() || null,
        receipt_url: editingExpense.receipt_urls.length > 0 ? JSON.stringify(editingExpense.receipt_urls) : null,
      }).eq('id', exp.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...expenses]; updated[editingExpenseIndex!] = { ...editingExpense, id: exp.id }; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ description: '', amount: '', expense_date: '', supplier: '', receipt_urls: [] })
  }

  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ description: '', amount: '', expense_date: '', supplier: '', receipt_urls: [] }) }

  async function saveGood() {
    if (!description) { alert('Please enter a description'); return }
    await ensureSupplier(supplier)
    for (const exp of expenses) { await ensureSupplier(exp.supplier) }

    const { error } = await supabase.from('goods').update({
      description, quantity: qty || 1, unit_price: unitPrice,
      purchase_date: isValidDate(purchaseDate) ? purchaseDate : null,
      supplier: supplier.trim() || null,
      receipt_url: goodReceiptUrls.length > 0 ? JSON.stringify(goodReceiptUrls) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', goodId)
    if (error) { alert(error.message); return }

    const newExpenses = expenses.filter(e => !e.id)
    if (newExpenses.length > 0) {
      const { error: e } = await supabase.from('good_expenses').insert(newExpenses.map(ex => ({
        good_id: goodId, description: ex.description, amount: parseFloat(ex.amount) || 0,
        expense_date: isValidDate(ex.expense_date) ? ex.expense_date : null,
        supplier: ex.supplier.trim() || null,
        receipt_url: ex.receipt_urls.length > 0 ? JSON.stringify(ex.receipt_urls) : null,
      })))
      if (e) { alert(e.message); return }
    }

    router.push('/goods')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT GOOD</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
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

        {/* GOOD RECEIPT */}
        <div>
          <label className="block mb-2 text-lg font-bold">RECEIPT</label>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer">
              {uploadingGood ? '...' : '📎 ADD FILES'}
              <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadGoodReceipts(e.target.files) }} />
            </label>
            {goodReceiptUrls.length > 0 && (
              <div className="relative">
                <button onClick={() => setOpenGoodReceipts(!openGoodReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-2 rounded-xl font-bold text-sm">
                  RECEIPTS{goodReceiptUrls.length > 1 ? ` (${goodReceiptUrls.length})` : ''}
                </button>
                {openGoodReceipts && (
                  <div className="absolute left-0 top-10 bg-gray-800 border border-gray-600 rounded-xl p-2 z-10 min-w-48 space-y-1">
                    {goodReceiptUrls.map((url, ui) => (
                      <div key={ui} className="flex items-center gap-2">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate">File {ui + 1}</a>
                        <button onClick={() => removeGoodReceiptUrl(ui)} className="text-red-400 hover:text-red-300 text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* EXPENSES */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <div>
              <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
              <input type="text" placeholder="Expense description" value={newExpense.description} onChange={(e) => setNewExpense({ ...newExpense, description: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
              <SupplierField suppliers={suppliers} value={newExpense.supplier} onChange={(v) => setNewExpense({ ...newExpense, supplier: v })} />
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
              <div className="relative">
                <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
              </div>
            </div>
            <DatePicker label="DATE" value={newExpense.expense_date} onChange={(v) => setNewExpense({ ...newExpense, expense_date: v })} />
            <button onClick={addExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>

            {expenses.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-visible mt-2">
                {expenses.map((exp, index) => (
                  <div key={index} className={index < expenses.length - 1 ? 'border-b border-gray-700' : ''}>
                    {editingExpenseIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600 rounded-2xl">
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
                          <input type="text" value={editingExpense.description} onChange={(e) => setEditingExpense({ ...editingExpense, description: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                          <SupplierField suppliers={suppliers} value={editingExpense.supplier} onChange={(v) => setEditingExpense({ ...editingExpense, supplier: v })} />
                        </div>
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                          <div className="relative">
                            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                            <input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
                          </div>
                        </div>
                        <DatePicker label="DATE" value={editingExpense.expense_date} onChange={(v) => setEditingExpense({ ...editingExpense, expense_date: v })} />
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">RECEIPTS</label>
                          <label className="inline-flex items-center gap-2 bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer">
                            📎 ADD FILES
                            <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadEditingExpenseReceipts(e.target.files) }} />
                          </label>
                          {editingExpense.receipt_urls.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {editingExpense.receipt_urls.map((url, ui) => (
                                <div key={ui} className="flex items-center gap-2">
                                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate">File {ui + 1}</a>
                                  <button onClick={() => setEditingExpense({ ...editingExpense, receipt_urls: editingExpense.receipt_urls.filter((_, i) => i !== ui) })} className="text-red-400 hover:text-red-300 text-xs font-bold px-2">✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-3">
                          <button onClick={saveEditExpense} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={cancelEditExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className="px-4 py-3">
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-base font-bold truncate">{exp.description}</p>
                            {exp.supplier && <p className="text-sm text-gray-400">{exp.supplier}</p>}
                            <p className="text-sm text-gray-400">{formatUSD(parseFloat(exp.amount))}{exp.expense_date ? ` — ${formatDate(exp.expense_date)}` : ''}</p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            {exp.receipt_urls.length > 0 && (
                              <div className="relative">
                                <button onClick={() => setOpenReceiptsIndex(openReceiptsIndex === index ? null : index)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                                  RECEIPTS{exp.receipt_urls.length > 1 ? ` (${exp.receipt_urls.length})` : ''}
                                </button>
                                {openReceiptsIndex === index && (
                                  <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                                    {exp.receipt_urls.map((url, ui) => (
                                      <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            <label className="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-xl font-bold text-sm cursor-pointer">
                              {uploadingExpenseIndex === index ? '...' : '📎'}
                              <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadExpenseReceipts(e.target.files, index) }} />
                            </label>
                            <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {expenses.length > 0 && (
              <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
                <span className="text-gray-400 font-bold">EXPENSES TOTAL</span>
                <span className="text-xl font-bold">{formatUSD(expensesTotal)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4">
          <div className="flex justify-between items-center">
            <span className="font-bold text-xl">GRAND TOTAL</span>
            <span className="text-3xl font-bold">{formatUSD(grandTotal)}</span>
          </div>
        </div>

        <button onClick={saveGood} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        <a href="/goods" className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}