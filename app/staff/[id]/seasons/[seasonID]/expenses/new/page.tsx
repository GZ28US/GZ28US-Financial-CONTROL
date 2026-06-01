'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

const expenseTypes = ['DAILY', 'WEEKLY', 'MONTHLY', 'SINGLE']
const expenseSources = ['Regions', 'Cash', 'GZ28BR', 'Humberto']
const expenseOrigins = ['GZ28US', 'PERSONAL']

// Single report queued after a successful SAVE, drives the WhatsApp modal.
type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  description: string
  type: string
  origin: string
  amount: string
  report: boolean
}

function getTodayString() {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

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

export default function NewExpensePage() {
  const params = useParams()
  const router = useRouter()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID ?? params.seasonId ?? '')

  const [seasonCode, setSeasonCode] = useState('')
  const [staffName, setStaffName] = useState('')
  const [type, setType] = useState('SINGLE')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [origin, setOrigin] = useState('GZ28US')
  const [source, setSource] = useState('Regions')
  const [expenseDate, setExpenseDate] = useState(getTodayString())
  const [receiptUrls, setReceiptUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [openReceipts, setOpenReceipts] = useState(false)

  // WhatsApp report state — set after a successful SAVE, drives the modal.
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)

  useEffect(() => { loadInfo() }, [])

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

  async function uploadReceipts(files: FileList) {
    setUploading(true)
    const urls = [...receiptUrls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `staff-expenses/${seasonID}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setReceiptUrls(urls)
    setUploading(false)
  }

  function removeReceiptUrl(index: number) {
    setReceiptUrls(receiptUrls.filter((_, i) => i !== index))
  }

  async function saveExpense() {
    if (!amount) { alert('Please enter an amount'); return }

    const { error } = await supabase.from('expenses').insert([{
      season_id: seasonID,
      type,
      description: description || null,
      amount: parseFloat(amount),
      origin,
      source,
      expense_date: type === 'SINGLE' ? expenseDate : null,
      receipt_url: receiptUrls.length > 0 ? JSON.stringify(receiptUrls) : null,
    }])

    if (error) { alert(error.message); return }

    // Queue the optional WhatsApp report for this expense.
    const report: ExpenseReport = {
      supplier: source,
      date: type === 'SINGLE' ? expenseDate : '',
      receipt_url: receiptUrls[0] || '',
      description,
      type,
      origin,
      amount,
      report: true,
    }
    setExpenseReports([report])
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const amt = parseFloat(exp.amount) || 0
    const amountStr = formatUSD(amt)
    const lines: string[] = [
      `*EXPENSE — STAFF*`,
      `${seasonCode}${staffName ? ` — ${staffName}` : ''}`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.description && exp.description.trim()) lines.push(exp.description.trim())
    const typeAndOrigin = [exp.type, exp.origin === 'PERSONAL' ? 'PERSONAL' : null].filter(Boolean).join(' — ')
    if (typeAndOrigin) lines.push(typeAndOrigin)
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())
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
        payload.filename = `staff-${exp.supplier || 'expense'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
      }
      try {
        const res = await fetch('/api/whatsapp', {
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
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The expense was still saved.`)
    setExpenseReports(null)
    router.push(`/staff/${staffId}/seasons/${seasonID}/expenses`)
  }

  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

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
            <p className="text-gray-400 text-base">Choose whether to report this expense to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const t = parseFloat(exp.amount) || 0
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — STAFF — {formatUSD(t)}</p>
                      <p className="text-sm text-gray-400 truncate">{exp.description || exp.supplier || 'Expense'}</p>
                      <p className="text-sm text-gray-400">{exp.type}{exp.origin === 'PERSONAL' ? ' — PERSONAL' : ''}{isValidDate(exp.date) ? ` — ${formatDate(exp.date)}` : ''}</p>
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

      <h1 className="text-4xl font-bold mb-2">ADD NEW EXPENSE</h1>
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
          <label className="block mb-2 text-lg font-bold">ORIGIN</label>
          <select value={origin} onChange={(e) => setOrigin(e.target.value)} className={selectClass}>
            {expenseOrigins.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SOURCE</label>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
            {expenseSources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
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

        <button onClick={saveExpense} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">
          SAVE EXPENSE
        </button>

        <a href={`/staff/${staffId}/seasons/${seasonID}/expenses`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
