'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD } from '@/lib/utils'

// One app's payment history — every charge since the subscription, grouped by
// month, always showing the NEXT upcoming month too (the scheduled charge).
// Rows are auto-captured from the Gmail receipts by the APPS watcher; 📧 opens
// the receipt email straight in Gmail.

type AppSupplier = {
  id: string
  description: string | null
  company: string | null
  email: string | null
  date_entry: string | null
  date_conclusion: string | null
  periodicity: string | null
  cost_type: string | null
  payment_day_1: number | null
  amount_1: number | null
}
type AppExpense = { id: string; description: string | null; amount: number; source: string | null; expense_date: string | null; payment_date: string | null; receipt_url: string | null }

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }
function fmtMonthYear(mk: string) { const dt = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1); return `${dt.toLocaleDateString('en-US', { month: 'short' })}, ${dt.getFullYear()}` }
function dayOf(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').getDate() : '' }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function AppViewPage() {
  const params = useParams()
  const id = String(params.id)
  const [s, setS] = useState<AppSupplier | null>(null)
  const [rows, setRows] = useState<AppExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [paying, setPaying] = useState<AppExpense | null>(null)
  const [payDate, setPayDate] = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [paySource, setPaySource] = useState(DEFAULT_SOURCE)
  const [savingPay, setSavingPay] = useState(false)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sendStatus, setSendStatus] = useState('')

  useEffect(() => { load() }, [id])

  async function load() {
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
    setS((sup || null) as AppSupplier | null)
    await ensureDuePayments(sup)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('supplier_id', id)
      .order('expense_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    setRows((data || []) as AppExpense[])
    setLoading(false)
  }

  // Keeps the NEXT months' scheduled rows generated (6 months ahead) — same
  // generator as fixed costs, but apps NEVER get past-dated scheduled rows:
  // history comes exclusively from the real Gmail receipts.
  async function ensureDuePayments(sup: any) {
    if (!sup || sup.periodicity !== 'MONTHLY' || !sup.date_entry) return
    if (sup.payment_day_1 == null || sup.amount_1 == null) return
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const clampDay = (y: number, m: number, day: number) => { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)) }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const end = sup.date_conclusion ? new Date(sup.date_conclusion + 'T00:00:00') : null
    const targetEnd = new Date(today.getFullYear(), today.getMonth() + 7, 0)
    const { data: existing } = await supabase.from('fixed_cost_expenses').select('expense_date, payment_date').eq('supplier_id', id)
    const existingMonths = new Set((existing || []).map((e: any) => (e.expense_date || '').slice(0, 7)).filter(Boolean))
    const toInsert: any[] = []
    let cursor = new Date(today.getFullYear(), today.getMonth(), 1)
    while (cursor <= targetEnd) {
      const pd = clampDay(cursor.getFullYear(), cursor.getMonth(), Number(sup.payment_day_1))
      const key = ymd(pd)
      // One row per month is enough for an app; months that already have a real
      // (paid) receipt row or a scheduled one are left alone.
      if (pd >= today && !(end && pd > end) && !existingMonths.has(key.slice(0, 7))) {
        toInsert.push({ supplier_id: id, type: 'SINGLE', description: sup.description || sup.company || 'App', amount: Number(sup.amount_1) || 0, source: DEFAULT_SOURCE, expense_date: key })
        existingMonths.add(key.slice(0, 7))
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

  function openAddPayment(r: AppExpense) {
    setPaying(r)
    setPayDate(isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd())
    setPayAmount(String(r.amount ?? ''))
    setPaySource(r.source || DEFAULT_SOURCE)
  }

  async function savePayment() {
    if (!paying) return
    setSavingPay(true)
    const { error } = await supabase.from('fixed_cost_expenses').update({
      payment_date: isValidDate(payDate) ? payDate : null,
      amount: parseFloat(payAmount) || 0,
      source: paySource || DEFAULT_SOURCE,
    }).eq('id', paying.id)
    setSavingPay(false)
    if (error) { alert(error.message); return }
    setPaying(null); load()
  }

  async function sendRowReport(r: AppExpense) {
    if (!s) return
    setSendingId(r.id); setSendStatus('')
    const body = [
      `💵 *APP EXPENSE — ${s.description || s.company || '—'}*`,
      s.company && s.company !== s.description ? s.company : null,
      r.description && r.description !== (s.description || '') ? r.description : null,
      `Amount: *${formatUSD(Number(r.amount) || 0)}*`,
      isValidDate(r.payment_date) ? `Paid: ${fmtDate(r.payment_date)}` : (isValidDate(r.expense_date) ? `Due: ${fmtDate(r.expense_date)}` : null),
      r.receipt_url ? `📧 Receipt: ${r.receipt_url}` : null,
    ].filter(Boolean).join('\n')
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })
      const d = await res.json().catch(() => ({}))
      setSendStatus(d.ok ? '✓ Sent to the report group.' : 'Could not send.')
    } catch { setSendStatus('Could not send.') } finally { setSendingId(null) }
  }

  const td = todayYmd()
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  const byMonth = new Map<string, AppExpense[]>()
  for (const r of rows) { const k = (r.expense_date || '').slice(0, 7); if (!k) continue; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k)!.push(r) }
  const allMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))
  // All the paid history + the NEXT upcoming month (later scheduled months stay
  // generated for the reports but aren't shown here).
  let nextMonthKey: string | null = null
  for (const r of rows) { if (isValidDate(r.expense_date) && (r.expense_date as string) > td && !isValidDate(r.payment_date)) { const mk = (r.expense_date as string).slice(0, 7); if (!nextMonthKey || mk < nextMonthKey) nextMonthKey = mk } }
  const months = nextMonthKey ? allMonths.filter(mk => mk <= (nextMonthKey as string)) : allMonths
  const visibleCount = months.reduce((n, mk) => n + (byMonth.get(mk) || []).length, 0)
  const paidTotal = rows.filter(r => isValidDate(r.payment_date)).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!s) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Not found.</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Payment</h2>
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
            <p className="text-gray-400">{paying.description || '—'}{paying.expense_date ? ` · day ${dayOf(paying.expense_date)}` : ''}</p>
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
            <button onClick={savePayment} disabled={savingPay} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingPay ? 'Saving…' : 'SAVE PAYMENT'}</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <Link href="/costs/apps" className="text-gray-400 text-lg hover:text-white">← APPS</Link>
        <div className="flex gap-3 flex-wrap items-center">
          {sendStatus && <span className="text-sm text-gray-400">{sendStatus}</span>}
          <Link href={`/costs/fixed/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-3 rounded-2xl text-lg font-bold">EDIT</Link>
        </div>
      </div>

      <h1 className="text-4xl font-bold">{s.description || s.company || '—'}</h1>
      <p className="text-gray-400 mt-1 mb-4">
        {[s.company && s.company !== s.description ? s.company : null, s.email].filter(Boolean).join('  ·  ') || '—'}
      </p>
      <div className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3 max-w-3xl mb-8">
        <p className="text-sm font-bold text-gray-300">
          {formatUSD(Number(s.amount_1) || 0)} / month{s.payment_day_1 != null ? ` · charge day ${s.payment_day_1}` : ''}
        </p>
        {isValidDate(s.date_entry) && <p className="text-xs text-gray-500 mt-1">Subscribed {fmtDate(s.date_entry)} → {isValidDate(s.date_conclusion) ? fmtDate(s.date_conclusion) : 'Active'}</p>}
      </div>

      <div className="flex items-baseline gap-4 mb-6 flex-wrap">
        <h2 className="text-3xl font-bold">PAYMENTS ({visibleCount})</h2>
        <span className="text-xl font-bold text-green-400">Total spent: {formatUSD(paidTotal)}</span>
      </div>

      {months.length === 0 ? (
        <p className="text-2xl text-gray-400">No payments yet.</p>
      ) : (
        <div className="space-y-5">
          {months.map((mk) => {
            const pays = byMonth.get(mk)!
            const monthTotal = pays.reduce((sum, p) => sum + (isValidDate(p.payment_date) ? Number(p.amount) || 0 : 0), 0)
            return (
              <div key={mk} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
                <div className="min-w-[10rem]">
                  <h3 className="text-2xl font-bold">{fmtMonthYear(mk)}</h3>
                  <p className="text-lg text-gray-400">{monthTotal > 0 ? formatUSD(monthTotal) : mk > td.slice(0, 7) ? 'upcoming' : '—'}</p>
                </div>
                <div className="flex-1 min-w-[20rem] bg-gray-800 border border-gray-700 rounded-2xl p-4 space-y-3">
                  {pays.map((p) => {
                    const paid = isValidDate(p.payment_date)
                    const upcoming = !paid && isValidDate(p.expense_date) && (p.expense_date as string) >= td
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 flex-wrap border-b border-gray-700/60 pb-3 last:border-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-lg font-bold">{formatUSD(Number(p.amount) || 0)}</span>
                            <span className="text-gray-400 text-sm">{p.description || ''}</span>
                            {paid ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-800 text-green-300">PAID</span>
                              : upcoming ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-900 text-blue-300">NEXT — day {dayOf(p.expense_date)}</span>
                              : <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900 text-red-300">UNPAID</span>}
                          </div>
                          <p className="text-xs text-gray-500">
                            {paid ? `Paid: ${fmtDate(p.payment_date)}` : `Due: ${fmtDate(p.expense_date)}`}
                            {p.receipt_url ? <> · <a href={p.receipt_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">📧 receipt</a></> : null}
                          </p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => openAddPayment(p)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1.5 rounded-xl font-bold text-xs">{paid ? 'FIX' : '+ PAY'}</button>
                          <button onClick={() => sendRowReport(p)} disabled={sendingId === p.id} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 px-3 py-1.5 rounded-xl font-bold text-xs">{sendingId === p.id ? '…' : '📤 SEND'}</button>
                          <button onClick={() => setConfirmId(p.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1.5 rounded-xl font-bold text-xs">✕</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
