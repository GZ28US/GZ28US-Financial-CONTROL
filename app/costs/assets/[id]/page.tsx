'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { DEFAULT_SOURCE } from '@/components/SourceSelect'
import PaymentFields, { type PaymentInfo, defaultPayment, paymentFromRow, paymentToRow } from '@/components/PaymentFields'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatPhone, formatUSD } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'

// ASSET / MARKETING detail — every payment of one asset or one marketing deal.
//
// Unlike FIXED costs, nothing here is generated automatically: an asset is bought
// once and a marketing deal is billed on its own terms (SEMA charges 50% up front
// and 50% on a fixed date, Meta charges whatever was spent). So the payments are
// entered BY HAND with ADD EXPENSE, and each row carries its own due date.
//
// A row with no payment_date is a bill still OPEN — that is exactly what HOME and
// FUTURE FLOW read (`payment_date is null`), and PAYMENTS reads the paid ones. So
// registering the instalment here is all it takes for it to show up in the reports.

type AssetSupplier = {
  id: string
  description: string | null
  company: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
  date_entry: string | null
  cost_type: string | null
}
type AssetExpense = { id: string; description: string | null; amount: number; source: string | null; expense_date: string | null; payment_date: string | null; receipt_url: string | null; payment_method?: string | null; paid_from?: string | null; paid_to?: string | null }

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function daysBetween(fromYmd: string, toYmd: string) { return Math.max(0, Math.floor((new Date(toYmd + 'T00:00:00').getTime() - new Date(fromYmd + 'T00:00:00').getTime()) / 86400000)) }

export default function AssetSupplierViewPage() {
  const params = useParams()
  const id = String(params.id)
  const [s, setS] = useState<AssetSupplier | null>(null)
  const [rows, setRows] = useState<AssetExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [scanningId, setScanningId] = useState<string | null>(null)

  // RECORD PAYMENT modal
  const [paying, setPaying] = useState<AssetExpense | null>(null)
  const [payDate, setPayDate] = useState('')
  const [payAmount, setPayAmount] = useState('')
  // Universal payment block — PAID FROM also feeds the legacy `source` column.
  const [payPayment, setPayPayment] = useState<PaymentInfo>(defaultPayment())
  const [payReceipt, setPayReceipt] = useState('')
  const [savingPay, setSavingPay] = useState(false)

  // ADD EXPENSE modal
  const [adding, setAdding] = useState(false)
  const [addDesc, setAddDesc] = useState('')
  const [addAmount, setAddAmount] = useState('')
  const [addDate, setAddDate] = useState('')
  const [addPayment, setAddPayment] = useState<PaymentInfo>(defaultPayment())
  const [savingAdd, setSavingAdd] = useState(false)

  useEffect(() => { load() }, [id])

  async function load() {
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
    setS((sup || null) as AssetSupplier | null)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('supplier_id', id)
      .order('expense_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    setRows((data || []) as AssetExpense[])
    setLoading(false)
  }

  function openAdd() {
    setAddDesc(s?.description || s?.company || '')
    setAddAmount(''); setAddDate(todayYmd()); setAddPayment(defaultPayment())
    setAdding(true)
  }

  // An instalment defaults to already PAID ("when I add an expense, it means it's
  // paid") with payment date = expense date; toggle NOT PAID to keep the bill
  // OPEN — open is what reaches HOME and FUTURE FLOW.
  async function saveAdd() {
    setSavingAdd(true)
    const { error } = await supabase.from('fixed_cost_expenses').insert({
      supplier_id: id,
      type: 'SINGLE',
      description: addDesc || (s?.description || s?.company || 'Expense'),
      amount: parseFloat(addAmount) || 0,
      source: addPayment.paidFrom || DEFAULT_SOURCE, // legacy write-through
      expense_date: isValidDate(addDate) ? addDate : null,
      ...paymentToRow(addPayment, addDate),
    })
    setSavingAdd(false)
    if (error) { alert(error.message); return }
    setAdding(false); load()
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  function openAddPayment(r: AssetExpense) {
    setPaying(r)
    setPayDate(isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd())
    setPayAmount(String(r.amount ?? ''))
    setPayPayment(paymentFromRow({ ...r, paid_from: r.paid_from || r.source }))
    setPayReceipt(r.receipt_url || '')
  }

  async function handleScanForRow(r: AssetExpense, file: File) {
    setScanningId(r.id)
    try {
      const ext = file.name.split('.').pop()
      const path = `fixed-cost/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      let receiptUrl = ''
      const { error: upErr } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (!upErr) receiptUrl = supabase.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
      const { base64, mediaType } = await fileForScan(file)
      const res = await fetch(`${BASE_PATH}/api/scan-receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mediaType }) })
      const data = await res.json()
      let amt = String(r.amount ?? ''); let dt = isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd()
      if (!data.error) {
        const text = data.content?.map((c: any) => c.text || '').join('') || ''
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        // BRL-as-USD guard: skip the amount prefill when the document is foreign-currency.
        const fx = await scanCurrencyFx(parsed.currency)
        const t = fx == null ? 0 : (parsed.items || []).reduce((sum: number, i: any) => sum + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0) * fx
        if (t > 0) amt = t.toFixed(2)
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || ''))) dt = String(parsed.date)
      }
      setPaying(r); setPayDate(dt); setPayAmount(amt); setPayPayment(paymentFromRow({ ...r, paid_from: r.paid_from || r.source })); setPayReceipt(receiptUrl)
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
      source: payPayment.paidFrom || DEFAULT_SOURCE, // legacy write-through
      payment_method: payPayment.method || null,
      paid_from: payPayment.paidFrom || null,
      paid_to: payPayment.paidTo || null,
      receipt_url: payReceipt || null,
    }).eq('id', paying.id)
    setSavingPay(false)
    if (error) { alert(error.message); return }
    setPaying(null); load()
  }

  const td = todayYmd()
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  // PAID is money that actually left the account; PENDING is what is still owed.
  // Never merge the two: a scheduled instalment is a forecast, not spend.
  const paidTotal = rows.filter(r => isValidDate(r.payment_date)).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  const pendingTotal = rows.filter(r => !isValidDate(r.payment_date)).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!s) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Not found.</p></main>

  const isAsset = s.cost_type === 'ASSET'

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

      {adding && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">ADD EXPENSE</h2>
              <button onClick={() => setAdding(false)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-xs text-gray-400">DESCRIPTION</label>
              <input type="text" value={addDesc} onChange={(e) => setAddDesc(e.target.value)} className={modalInput} placeholder="e.g. Booth deposit (50%)" />
            </div>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-40">
                <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="text" inputMode="decimal" value={addAmount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setAddAmount(e.target.value) }} className={`${modalInput} pl-9`} placeholder="0.00" />
                </div>
              </div>
            </div>
            <DatePicker label="EXPENSE DATE (due date)" value={addDate} onChange={setAddDate} compact />
            {/* UNIVERSAL PAYMENT BLOCK — PAID defaults ON; payment date = expense date */}
            <PaymentFields value={addPayment} onChange={setAddPayment} />
            <p className="text-xs text-gray-500">Toggle NOT PAID and the bill stays OPEN — it shows up on HOME and in the Future Flow until you record the payment.</p>
            <button onClick={saveAdd} disabled={savingAdd} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingAdd ? 'Saving…' : 'SAVE EXPENSE'}</button>
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
            <p className="text-gray-400">{paying.description || '—'}{isValidDate(paying.expense_date) ? ` · due ${fmtDate(paying.expense_date)}` : ''}</p>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-40">
                <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="text" inputMode="decimal" value={payAmount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setPayAmount(e.target.value) }} className={`${modalInput} pl-9`} placeholder="0.00" />
                </div>
              </div>
            </div>
            {/* UNIVERSAL PAYMENT BLOCK — recording a payment is PAID by definition */}
            <PaymentFields value={payPayment} onChange={setPayPayment} hidePaidToggle />
            <DatePicker label="PAYMENT DATE" value={payDate} onChange={setPayDate} compact />
            {payReceipt && <a href={payReceipt} target="_blank" rel="noopener noreferrer" className="inline-block text-blue-400 hover:text-blue-300 text-sm">📎 Receipt attached</a>}
            <button onClick={savePayment} disabled={savingPay} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingPay ? 'Saving…' : 'SAVE PAYMENT'}</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <Link href="/costs/assets" className="text-gray-400 text-lg hover:text-white">← Marketing</Link>
        <div className="flex gap-3 flex-wrap">
          <button onClick={openAdd} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold">+ ADD EXPENSE</button>
          <Link href={`/costs/fixed/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-3 rounded-2xl text-lg font-bold">EDIT</Link>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-4xl font-bold">{s.description || s.company || '—'}</h1>
        <span className={`px-3 py-1 rounded-full text-sm font-bold ${isAsset ? 'bg-purple-800 text-purple-100' : 'bg-amber-800 text-amber-100'}`}>
          {isAsset ? 'EVENTS' : 'MARKETING'}
        </span>
      </div>
      <p className="text-gray-400 mt-1 mb-2">
        {[s.company, s.contact_name, formatPhone(s.phone), s.email].filter(Boolean).join('  ·  ') || '—'}
      </p>
      {isValidDate(s.date_entry) && <p className="text-sm text-gray-500 mb-8">Bought {fmtDate(s.date_entry)}</p>}

      <div className="flex items-baseline gap-4 mb-6 flex-wrap">
        <h2 className="text-3xl font-bold">EXPENSES ({rows.length})</h2>
        <span className="text-xl font-bold flex gap-2 flex-wrap items-baseline">
          <span className="text-green-400">Total PAID: {formatUSD(paidTotal)}</span>
          {pendingTotal > 0.005 && (
            <>
              <span className="text-gray-600">-</span>
              <span className="text-orange-400">PENDING: {formatUSD(pendingTotal)}</span>
              <span className="text-gray-600">-</span>
              <span className="text-gray-300">TOTAL: {formatUSD(paidTotal + pendingTotal)}</span>
            </>
          )}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-2xl text-gray-400">No expenses yet — tap ADD EXPENSE to register what was paid and what is still due.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((p) => {
            const paid = isValidDate(p.payment_date)
            const overdue = !paid && isValidDate(p.expense_date) && (p.expense_date as string) < td
            const late = overdue ? daysBetween(p.expense_date as string, td) : 0
            const soon = !paid && !overdue && isValidDate(p.expense_date) ? daysBetween(td, p.expense_date as string) : null
            return (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="text-2xl font-bold">{formatUSD(Number(p.amount) || 0)}</span>
                    {paid ? <span className="px-3 py-1 rounded-full text-xs font-bold bg-green-800 text-green-300">PAID</span>
                      : overdue ? <span className="px-3 py-1 rounded-full text-xs font-bold bg-red-900 text-red-300">OVERDUE ({late} {late === 1 ? 'day' : 'days'})</span>
                      : <span className="px-3 py-1 rounded-full text-xs font-bold bg-orange-900 text-orange-300">PENDING{soon != null ? ` (in ${soon} ${soon === 1 ? 'day' : 'days'})` : ''}</span>}
                  </div>
                  <p className="text-lg text-gray-300 truncate">{p.description || '—'}</p>
                  <p className="text-sm text-gray-500">
                    {paid
                      ? `Paid ${fmtDate(p.payment_date)}${p.source ? ` · from ${p.source}` : ''}`
                      : isValidDate(p.expense_date) ? `Due ${fmtDate(p.expense_date)}` : 'No date'}
                    {p.receipt_url ? ' · ' : ''}
                  </p>
                  {p.receipt_url && <a href={p.receipt_url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-400 hover:text-blue-300">📎 receipt</a>}
                </div>
                <div className="flex gap-2 shrink-0 flex-wrap">
                  <label className={`bg-purple-700 hover:bg-purple-600 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer ${scanningId === p.id ? 'opacity-60 pointer-events-none' : ''}`}>
                    {scanningId === p.id ? '…' : '📸 SCAN'}
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanForRow(p, e.target.files[0]) }} />
                  </label>
                  <button onClick={() => openAddPayment(p)} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-xl font-bold text-sm">{paid ? 'EDIT PAY' : '+ PAY'}</button>
                  <button onClick={() => setConfirmId(p.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-xl font-bold text-sm">✕</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
