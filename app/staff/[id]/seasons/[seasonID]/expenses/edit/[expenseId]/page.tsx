'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const expenseTypes = ['DAILY', 'WEEKLY', 'MONTHLY', 'SINGLE']
const expenseOrigins = ['GZ28US', 'PERSONAL']

function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

export default function EditExpensePage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID)
  const expenseId = String(params.expenseId)

  const [loading, setLoading] = useState(true)
  const [seasonCode, setSeasonCode] = useState('')
  const [staffName, setStaffName] = useState('')
  const [type, setType] = useState('SINGLE')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [origin, setOrigin] = useState('GZ28US')
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [expenseDate, setExpenseDate] = useState('')
  const [receiptUrls, setReceiptUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [openReceipts, setOpenReceipts] = useState(false)

  useEffect(() => { loadInfo(); loadExpense() }, [])

  async function loadInfo() {
    const { data: season } = await supabase
      .from('seasons')
      .select('season_code, staff_id')
      .eq('id', seasonID)
      .single()

    if (season) {
      setSeasonCode(season.season_code)
      const { data: staff } = await supabase
        .from('staff')
        .select('name')
        .eq('id', season.staff_id)
        .single()
      setStaffName(staff?.name || '')
    }
  }

  async function loadExpense() {
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .eq('id', expenseId)
      .single()

    if (error || !data) {
      alert('Expense not found')
      router.push(`/staff/${staffId}/seasons/${seasonID}/expenses`)
      return
    }

    setType(data.type || 'SINGLE')
    setDescription(data.description || '')
    setAmount(String(data.amount || ''))
    setOrigin(data.origin || 'GZ28US')
    setSource(data.source || DEFAULT_SOURCE)
    setExpenseDate(data.expense_date || '')
    setReceiptUrls(parseReceiptUrls(data.receipt_url))
    setLoading(false)
  }

  async function uploadReceipts(files: FileList) {
    setUploading(true)
    const urls = [...receiptUrls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `staff-expenses/${seasonID}/${expenseId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setReceiptUrls(urls)
    await supabase.from('expenses').update({ receipt_url: urls.length > 0 ? JSON.stringify(urls) : null }).eq('id', expenseId)
    setUploading(false)
  }

  async function removeReceiptUrl(index: number) {
    const updated = receiptUrls.filter((_, i) => i !== index)
    setReceiptUrls(updated)
    await supabase.from('expenses').update({ receipt_url: updated.length > 0 ? JSON.stringify(updated) : null }).eq('id', expenseId)
  }

  async function saveExpense() {
    if (!amount) { alert('Please enter an amount'); return }

    const { error } = await supabase.from('expenses').update({
      type,
      description: description || null,
      amount: parseFloat(amount),
      origin,
      source,
      expense_date: type === 'SINGLE' ? expenseDate : null,
      receipt_url: receiptUrls.length > 0 ? JSON.stringify(receiptUrls) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', expenseId)

    if (error) { alert(error.message); return }
    router.push(`/staff/${staffId}/seasons/${seasonID}/expenses`)
  }

  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">EDIT EXPENSE</h1>
      <p className="text-gray-400 text-xl mb-8">{staffName} — {seasonCode}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">TYPE</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className={selectClass}>
            {expenseTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {type === 'SINGLE' && (
          <DatePicker label="DATE" value={expenseDate} onChange={setExpenseDate} />
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} placeholder="Optional description" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">AMOUNT (USD)</label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-xl text-gray-400">$</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass} pl-10`} placeholder="0.00" />
          </div>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">RESPONSIBLE</label>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)} className={selectClass}>
            {expenseOrigins.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SOURCE</label>
          <SourceSelect value={source} onChange={setSource} className={selectClass} />
        </div>

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
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate" title={`File ${ui + 1}`}>File {ui + 1}</a>
                        <button onClick={() => removeReceiptUrl(ui)} className="text-red-400 hover:text-red-300 text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <button onClick={saveExpense} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">
          SAVE CHANGES
        </button>

        <a href={`${BASE_PATH}/staff/${staffId}/seasons/${seasonID}/expenses`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}