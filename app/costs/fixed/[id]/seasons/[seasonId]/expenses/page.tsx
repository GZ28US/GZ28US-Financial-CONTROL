'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH } from '@/lib/utils'

type FixedExpense = { id: string; description: string | null; amount: number; source: string | null; expense_date: string | null; payment_date: string | null; receipt_url: string | null }

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }
function fmtMonthYear(d: string | null | undefined) { if (!isValidDate(d)) return ''; const dt = new Date(d + 'T00:00:00'); return `${dt.toLocaleDateString('en-US', { month: 'short' })}, ${dt.getFullYear()}` }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function SeasonExpensesPage() {
  const params = useParams()
  const id = String(params.id)
  const seasonId = String(params.seasonId)
  const [rows, setRows] = useState<FixedExpense[]>([])
  const [seasonCode, setSeasonCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Record-payment modal (operates on one scheduled row).
  const [paying, setPaying] = useState<FixedExpense | null>(null)
  const [payDate, setPayDate] = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [paySource, setPaySource] = useState(DEFAULT_SOURCE)
  const [payReceipt, setPayReceipt] = useState('')
  const [savingPay, setSavingPay] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)

  useEffect(() => { load() }, [seasonId])

  async function load() {
    const { data: season } = await supabase.from('fixed_cost_seasons').select('*').eq('id', seasonId).maybeSingle()
    setSeasonCode((season?.season_code || '') as string)
    await ensureDuePayments(season)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('season_id', seasonId)
      .order('expense_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    setRows((data || []) as FixedExpense[])
    setLoading(false)
  }

  // Auto-create the season's recurring payment rows. The first payment falls the month
  // AFTER the season's start month (the start month has no payment). Both payment days in
  // a month are combined into ONE row (summed amount, dated on the first day). Pre-creates
  // next month once the current month's last payment day passes. Only inserts dates that
  // don't already have a row, so it's safe to re-run. MONTHLY seasons only.
  async function ensureDuePayments(season: any) {
    if (!season || season.periodicity !== 'MONTHLY' || !season.date_entry) return
    const slots: { day: number; amount: number }[] = []
    if (season.payment_day_1 != null && season.amount_1 != null) slots.push({ day: Number(season.payment_day_1), amount: Number(season.amount_1) })
    if (season.payment_day_2 != null && season.amount_2 != null) slots.push({ day: Number(season.payment_day_2), amount: Number(season.amount_2) })
    if (slots.length === 0) return

    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const clampDay = (y: number, m: number, day: number) => { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)) }

    const today = new Date(); today.setHours(0, 0, 0, 0)
    const start = new Date(season.date_entry + 'T00:00:00')
    const end = season.date_conclusion ? new Date(season.date_conclusion + 'T00:00:00') : null
    const firstDay = Math.min(...slots.map(s => s.day))
    const lastDay = Math.max(...slots.map(s => s.day))
    const monthAmount = slots.reduce((sum, s) => sum + s.amount, 0)

    const firstPayMonth = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    const lastPayThisMonth = clampDay(today.getFullYear(), today.getMonth(), lastDay)
    const targetBase = today > lastPayThisMonth ? new Date(today.getFullYear(), today.getMonth() + 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1)
    const targetEnd = new Date(targetBase.getFullYear(), targetBase.getMonth() + 1, 0)

    const { data: existing } = await supabase.from('fixed_cost_expenses').select('expense_date').eq('season_id', seasonId)
    const existingDates = new Set((existing || []).map((e: any) => e.expense_date).filter(Boolean))
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('description, company').eq('id', id).maybeSingle()
    const supName = (sup?.description || sup?.company || 'Payment') as string

    const toInsert: any[] = []
    let cursor = new Date(firstPayMonth)
    while (cursor <= targetEnd) {
      const pd = clampDay(cursor.getFullYear(), cursor.getMonth(), firstDay)
      if (!(end && pd > end) && pd <= targetEnd && !existingDates.has(ymd(pd))) {
        toInsert.push({ supplier_id: id, season_id: seasonId, type: 'SINGLE', description: supName, amount: monthAmount, source: DEFAULT_SOURCE, expense_date: ymd(pd) })
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    if (toInsert.length > 0) await supabase.from('fixed_cost_expenses').insert(toInsert)
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  // ADD PAYMENT — open the record modal prefilled with the row's scheduled values.
  function openAddPayment(r: FixedExpense) {
    setPaying(r)
    setPayDate(isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd())
    setPayAmount(String(r.amount ?? ''))
    setPaySource(r.source || DEFAULT_SOURCE)
    setPayReceipt(r.receipt_url || '')
  }

  // SCAN RECEIPT — upload + scan the receipt, then open the record modal prefilled from it.
  async function handleScanForRow(r: FixedExpense, file: File) {
    setScanningId(r.id)
    try {
      const ext = file.name.split('.').pop()
      const path = `fixed-cost/${seasonId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      let receiptUrl = ''
      const { error: upErr } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (!upErr) receiptUrl = supabase.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
      const base64 = await new Promise<string>((resolve, reject) => { const rd = new FileReader(); rd.onload = () => resolve((rd.result as string).split(',')[1]); rd.onerror = reject; rd.readAsDataURL(file) })
      const res = await fetch(`${BASE_PATH}/api/scan-receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mediaType: file.type }) })
      const data = await res.json()
      let amt = String(r.amount ?? ''); let dt = isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd()
      if (!data.error) {
        const text = data.content?.map((c: any) => c.text || '').join('') || ''
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        const t = (parsed.items || []).reduce((s: number, i: any) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
        if (t > 0) amt = t.toFixed(2)
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || ''))) dt = String(parsed.date)
      }
      setPaying(r); setPayDate(dt); setPayAmount(amt); setPaySource(r.source || DEFAULT_SOURCE); setPayReceipt(receiptUrl)
    } catch (err) {
      console.error(err); alert('Failed to scan receipt. Please try again.')
    } finally {
      setScanningId(null)
    }
  }

  async function savePayment() {
    if (!paying) return
    setSavingPay(true)
    const { error } = await supabase.from('fixed_cost_expenses').update({
      payment_date: isValidDate(payDate) ? payDate : null,
      amount: parseFloat(payAmount) || 0,
      source: paySource || DEFAULT_SOURCE,
      receipt_url: payReceipt || null,
    }).eq('id', paying.id)
    setSavingPay(false)
    if (error) { alert(error.message); return }
    setPaying(null); load()
  }

  const td = todayYmd()
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {paying && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">RECORD PAYMENT</h2>
              <button onClick={() => setPaying(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <p className="text-gray-400">{paying.description || '—'}{paying.expense_date ? ` · ${fmtMonthYear(paying.expense_date)}` : ''}</p>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-40">
                <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="text" inputMode="decimal" value={payAmount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setPayAmount(e.target.value) }} className={`${modalInput} pl-9`} placeholder="0.00" />
                </div>
              </div>
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-xs text-gray-400">PAID FROM</label>
                <SourceSelect value={paySource} onChange={setPaySource} className={modalInput} />
              </div>
            </div>
            <DatePicker label="PAYMENT DATE" value={payDate} onChange={setPayDate} compact />
            {payReceipt && <a href={payReceipt} target="_blank" rel="noopener noreferrer" className="inline-block text-blue-400 hover:text-blue-300 text-sm">📎 Receipt attached</a>}
            <button onClick={savePayment} disabled={savingPay} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingPay ? 'Saving…' : 'SAVE PAYMENT'}</button>
          </div>
        </div>
      )}

      <Link href={`/costs/fixed/${id}/seasons`} className="text-gray-400 text-lg hover:text-white">← Seasons</Link>
      <h1 className="text-4xl font-bold mt-3">Season {seasonCode} — EXPENSES ({rows.length})</h1>
      <p className="text-xl font-bold text-gray-300 mt-1 mb-8">Total: {formatUSD(total)}</p>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-2xl text-gray-400">No expenses yet.</p>
      ) : (
        <div className="space-y-5">
          {rows.map((r) => {
            const paid = isValidDate(r.payment_date)
            const delayed = !paid && isValidDate(r.expense_date) && (r.expense_date as string) < td
            return (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    {paid ? <span className="px-3 py-1 rounded-full text-sm font-bold bg-green-800 text-green-300">PAID</span>
                      : delayed ? <span className="px-3 py-1 rounded-full text-sm font-bold bg-red-900 text-red-300">DELAYED</span> : null}
                    <h2 className="text-2xl font-bold truncate">{r.description || '—'}</h2>
                  </div>
                  <p className={`text-lg ${delayed ? 'text-red-400' : 'text-gray-400'}`}>{formatUSD(Number(r.amount) || 0)}{r.source ? ` · ${r.source}` : ''}{r.expense_date ? ` · ${fmtMonthYear(r.expense_date)}` : ''}</p>
                  {paid && <p className="text-sm text-gray-500">Paid: {fmtDate(r.payment_date)}{r.receipt_url ? ' · 📎 receipt' : ''}</p>}
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <label className={`bg-purple-700 hover:bg-purple-600 px-4 py-2 rounded-2xl font-bold text-sm cursor-pointer ${scanningId === r.id ? 'opacity-60 pointer-events-none' : ''}`}>
                    {scanningId === r.id ? 'Scanning…' : '📸 SCAN RECEIPT'}
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanForRow(r, e.target.files[0]) }} />
                  </label>
                  <button onClick={() => openAddPayment(r)} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">+ ADD PAYMENT</button>
                  <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
