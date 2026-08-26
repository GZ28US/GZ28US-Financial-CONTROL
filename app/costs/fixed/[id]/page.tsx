'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { DEFAULT_SOURCE } from '@/components/SourceSelect'
import PaymentFields, { type PaymentInfo, defaultPayment, paymentFromRow } from '@/components/PaymentFields'
import SendToDialog, { type SendTarget } from '@/components/SendToDialog'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatPhone, formatUSD } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'

const LANG: 'en' | 'pt' = 'en'

type FixedCostSupplier = {
  id: string
  description: string | null
  company: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
  date_entry: string | null
  date_conclusion: string | null
  periodicity: string | null
  cost_type: string | null
  payment_day_1: number | null
  amount_1: number | null
  payment_day_2: number | null
  amount_2: number | null
}
type FixedExpense = { id: string; description: string | null; amount: number; source: string | null; expense_date: string | null; payment_date: string | null; receipt_url: string | null; payment_method?: string | null; paid_from?: string | null; paid_to?: string | null }

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }
function fmtMonthYear(mk: string) { const dt = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1); return `${dt.toLocaleDateString('en-US', { month: 'short' })}, ${dt.getFullYear()}` }
function dayOf(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').getDate() : '' }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function daysLate(fromYmd: string, toYmd: string) { return Math.max(0, Math.floor((new Date(toYmd + 'T00:00:00').getTime() - new Date(fromYmd + 'T00:00:00').getTime()) / 86400000)) }

export default function FixedCostSupplierViewPage() {
  const params = useParams()
  const id = String(params.id)
  const [s, setS] = useState<FixedCostSupplier | null>(null)
  const [rows, setRows] = useState<FixedExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [paying, setPaying] = useState<FixedExpense | null>(null)
  const [payDate, setPayDate] = useState('')
  const [payAmount, setPayAmount] = useState('')
  // Universal payment block — PAID FROM also feeds the legacy `source` column.
  const [payPayment, setPayPayment] = useState<PaymentInfo>(defaultPayment())
  const [payReceipt, setPayReceipt] = useState('')
  const [savingPay, setSavingPay] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)
  // Per-row SEND TO (payment proof + receipt). justScanned drives the auto-prompt:
  // the moment a receipt is scanned + saved, the same SEND TO box pops up.
  const [sendRow, setSendRow] = useState<FixedExpense | null>(null)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendRowStatus, setSendRowStatus] = useState('')
  const [justScanned, setJustScanned] = useState(false)

  useEffect(() => { load() }, [id])

  async function load() {
    const { data: sup } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
    setS((sup || null) as FixedCostSupplier | null)
    await ensureDuePayments(sup)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('supplier_id', id)
      .order('expense_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    setRows((data || []) as FixedExpense[])
    setLoading(false)
  }

  // Auto-create the supplier's recurring payment rows — ONE row per payment day per month.
  // First payment falls the month AFTER the supplier's start date; pre-creates next month
  // once the current month's last payment day passes. Inserts only missing dates. MONTHLY.
  async function ensureDuePayments(sup: any) {
    // APP subscriptions generate on their own page (/costs/apps/[id]) — never here,
    // or a direct link to this page would backfill past-dated scheduled rows.
    if (!sup || sup.cost_type === 'APP') return
    if (sup.periodicity !== 'MONTHLY' || !sup.date_entry) return
    const slots: { day: number; amount: number }[] = []
    if (sup.payment_day_1 != null && sup.amount_1 != null) slots.push({ day: Number(sup.payment_day_1), amount: Number(sup.amount_1) })
    if (sup.payment_day_2 != null && sup.amount_2 != null) slots.push({ day: Number(sup.payment_day_2), amount: Number(sup.amount_2) })
    if (slots.length === 0) return

    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const clampDay = (y: number, m: number, day: number) => { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)) }

    const today = new Date(); today.setHours(0, 0, 0, 0)
    const start = new Date(sup.date_entry + 'T00:00:00')
    const end = sup.date_conclusion ? new Date(sup.date_conclusion + 'T00:00:00') : null

    const firstPayMonth = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    // Always keep 6 months of payments generated ahead of the current month.
    const targetEnd = new Date(today.getFullYear(), today.getMonth() + 7, 0)

    const { data: existing } = await supabase.from('fixed_cost_expenses').select('expense_date').eq('supplier_id', id)
    const existingDates = new Set((existing || []).map((e: any) => e.expense_date).filter(Boolean))
    const supName = (sup.description || sup.company || 'Payment') as string

    const toInsert: any[] = []
    let cursor = new Date(firstPayMonth)
    while (cursor <= targetEnd) {
      for (const slot of slots) {
        const pd = clampDay(cursor.getFullYear(), cursor.getMonth(), slot.day)
        if (!(end && pd > end) && pd <= targetEnd && !existingDates.has(ymd(pd))) {
          toInsert.push({ supplier_id: id, type: 'SINGLE', description: supName, amount: slot.amount, source: DEFAULT_SOURCE, expense_date: ymd(pd) })
        }
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    if (toInsert.length > 0) await supabase.from('fixed_cost_expenses').insert(toInsert)
  }

  // ENCERRAMENTO FORMAL (João, 25/ago — caso Disney+ "deixar morrer"): grava o
  // date_conclusion (o gerador já para nele) e APAGA as contas agendadas não
  // pagas depois da data — com trilha. A vencida anterior fica: pague ou apague.
  async function terminate() {
    if (!s) return
    const end = window.prompt('ENCERRAR esta assinatura/contrato — último dia de vigência (YYYY-MM-DD):', s.date_conclusion || todayYmd())
    if (!end) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) { alert('Data inválida — use YYYY-MM-DD.'); return }
    if (!confirm(`Encerrar em ${end}? As contas agendadas (não pagas) DEPOIS dessa data serão apagadas. Fica tudo na trilha.`)) return
    const { error: e1 } = await supabase.from('fixed_cost_suppliers').update({ date_conclusion: end }).eq('id', id)
    if (e1) { alert(e1.message); return }
    const { data: del, error: e2 } = await supabase.from('fixed_cost_expenses').delete().eq('supplier_id', id).is('payment_date', null).gt('expense_date', end).select('id')
    if (e2) { alert('Encerrada, mas falhou apagar as agendadas: ' + e2.message); load(); return }
    await supabase.from('data_fixes').insert({
      check_key: 'sub-ended-scheduled', table_name: 'fixed_cost_suppliers', row_id: id, field: 'date_conclusion',
      old_value: s.date_conclusion || null, new_value: end,
      label: (`ENCERRADA · ${s.description || s.company || ''} · ${(del || []).length} conta(s) agendada(s) apagada(s)`).slice(0, 200),
    }).then(() => undefined, () => undefined)
    alert(`Encerrada em ${end}. ${(del || []).length} conta(s) agendada(s) apagada(s).`)
    load()
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  function openAddPayment(r: FixedExpense) {
    setPaying(r)
    setPayDate(isValidDate(r.payment_date) ? (r.payment_date as string) : todayYmd())
    setPayAmount(String(r.amount ?? ''))
    setPayPayment(paymentFromRow({ ...r, paid_from: r.paid_from || r.source }))
    setPayReceipt(r.receipt_url || '')
    setJustScanned(false)
  }

  async function handleScanForRow(r: FixedExpense, file: File) {
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
      setJustScanned(!!receiptUrl)
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
    // The saved row, as-is, for the auto SEND TO prompt (no reload race).
    const saved: FixedExpense = {
      ...paying,
      payment_date: isValidDate(payDate) ? payDate : null,
      amount: parseFloat(payAmount) || 0,
      source: payPayment.paidFrom || DEFAULT_SOURCE,
      payment_method: payPayment.method || null,
      paid_from: payPayment.paidFrom || null,
      paid_to: payPayment.paidTo || null,
      receipt_url: payReceipt || null,
    }
    const wasScanned = justScanned
    setPaying(null); setJustScanned(false); load()
    // Whenever a receipt was just scanned, offer to send the proof — same SEND TO box.
    if (wasScanned) openRowSend(saved)
  }

  // ── Per-row SEND TO: payment proof (report text + the receipt file if any) ──────
  function openRowSend(r: FixedExpense) { setSendRowStatus(''); setSendRow(r) }

  function paymentReport(r: FixedExpense): string {
    const label = s?.company || s?.contact_name || s?.description || '—'
    const sched = scheduledAmountFor(r)
    const fine = isValidDate(r.payment_date) && sched != null ? (Number(r.amount) || 0) - sched : 0
    return [
      '🧾 *PAYMENT PROOF — FIXED COST*',
      label,
      r.description && r.description !== label ? r.description : null,
      `Amount: *${formatUSD(Number(r.amount) || 0)}*`,
      isValidDate(r.payment_date) ? `Paid: ${fmtDate(r.payment_date)}` : (isValidDate(r.expense_date) ? `Due: ${fmtDate(r.expense_date)}` : null),
      fine > 0.005 ? `Late fine: ${formatUSD(fine)}` : null,
      r.source ? `Paid from: ${r.source}` : null,
      '\nSent by GZ28 Control App',
    ].filter(Boolean).join('\n')
  }

  // Send the proof to the supplier via their preferred method. WhatsApp attaches the
  // receipt file; SMS/Email/Phone can't attach, so they carry the receipt LINK instead.
  async function sendProofToSupplier(report: string, receiptUrl: string, filename?: string): Promise<boolean> {
    if (!s) return false
    const method = s.preferred_contact || 'WhatsApp'
    const plain = report.replace(/[*_]/g, '') + (receiptUrl ? `\n\nReceipt: ${receiptUrl}` : '')
    if (method === 'Email') {
      if (!s.email) { setSendRowStatus('No email on file (EDIT).'); return false }
      window.location.href = `mailto:${s.email}?subject=${encodeURIComponent('Payment proof — GZ28 V8 SpeedShop')}&body=${encodeURIComponent(plain)}`
      return true
    }
    if (method === 'SMS' || method === 'Phone') {
      if (!s.phone) { setSendRowStatus('No phone on file (EDIT).'); return false }
      window.location.href = `sms:${s.phone}?&body=${encodeURIComponent(plain)}`
      return true
    }
    const to = (s.phone || '').replace(/\D/g, '')
    if (!to) { setSendRowStatus('No WhatsApp / phone on file (EDIT).'); return false }
    const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: report, ...(receiptUrl ? { documentUrl: receiptUrl, filename } : {}) }) })
    const d = await res.json().catch(() => ({}))
    return !!d.ok
  }

  async function handleRowSend(target: SendTarget) {
    const r = sendRow
    if (!r || target === 'skip') { setSendRow(null); return }
    const report = paymentReport(r)
    const receiptUrl = r.receipt_url || ''
    const filename = receiptUrl ? `payment-proof.${(receiptUrl.split('?')[0].split('.').pop() || 'pdf')}` : undefined
    setSendBusy(true); setSendRowStatus('Sending…')
    try {
      let okGroup = true, okSup = true
      if (target === 'group' || target === 'both') {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: report, ...(receiptUrl ? { documentUrl: receiptUrl, filename } : {}) }) })
        const d = await res.json().catch(() => ({})); okGroup = !!d.ok
      }
      if (target === 'supplier' || target === 'both') {
        okSup = await sendProofToSupplier(report, receiptUrl, filename)
      }
      setSendRowStatus(okGroup && okSup ? '✓ Sent.' : 'Some sends failed — check the group / supplier contact (EDIT).')
    } catch (e) {
      setSendRowStatus('Could not send: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setSendBusy(false) }
  }

  function openSend() { setSendStatus(''); setSendOpen(true) }

  // Page-level SEND TO (supplier onboarding): SUPPLIER = registration link, REPORT
  // GROUP = the supplier's contact card, BOTH = both. Same SEND TO box as everywhere.
  async function handlePageSend(target: SendTarget) {
    if (target === 'skip') { setSendOpen(false); return }
    if (target === 'supplier' || target === 'both') await sendToSupplier()
    if (target === 'group' || target === 'both') await sendToGroup()
  }

  async function sendToSupplier() {
    if (!s) return
    setSendStatus('')
    const method = s.preferred_contact || 'WhatsApp'
    const link = `${window.location.origin}${BASE_PATH}/costs/fixed/self/${id}`
    const firstName = (s.contact_name || '').split(' ')[0]
    const waBody = LANG === 'pt'
      ? `Olá${firstName ? ` ${firstName}` : ''}! 👋\n\nPor favor, preencha seus dados neste link e toque em *SALVAR*:\n\n${link}\n\nObrigado!`
      : `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nPlease fill in your details at this link and tap *SAVE*:\n\n${link}\n\nThank you!`
    const plain = waBody.replace(/[*_]/g, '')
    const label = s.company || s.contact_name || s.description || '—'
    const notifyGroup = () => { void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📤 *FIXED COST SUPPLIER FORM — LINK SENT*\n${label}\nThe system sent the registration link to the supplier (via ${method}). Awaiting them to fill in their details.` }),
    }).catch(() => {}) }

    if (method === 'Email') {
      if (!s.email) { setSendStatus('No email on file. Add one first (EDIT).'); return }
      const subject = LANG === 'pt' ? 'Complete seu cadastro — GZ28 V8 SpeedShop' : 'Complete your details — GZ28 V8 SpeedShop'
      window.location.href = `mailto:${s.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      notifyGroup(); setSendStatus('✓ Email composer opened.'); return
    }
    if (method === 'Phone') {
      if (!s.phone) { setSendStatus('No phone on file. Add one first (EDIT).'); return }
      window.location.href = `sms:${s.phone}?&body=${encodeURIComponent(plain)}`
      notifyGroup(); setSendStatus('✓ SMS composer opened.'); return
    }
    const to = (s.phone || '').replace(/\D/g, '')
    if (!to) { setSendStatus('No WhatsApp / phone on file. Add one first (EDIT).'); return }
    setSending(true); setSendStatus('Sending…')
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: waBody }) })
      const data = await res.json().catch(() => ({}))
      if (data.ok) { notifyGroup(); setSendStatus('✓ Link sent to the supplier on WhatsApp.') }
      else setSendStatus('Could not send: ' + (data?.error || `HTTP ${res.status}`))
    } catch (e) {
      setSendStatus('Could not send: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setSending(false) }
  }

  async function sendToGroup() {
    if (!s) return
    setSendStatus('')
    const body = `📋 *FIXED COST SUPPLIER*\n${s.description || s.company || '—'}\n\nCompany: ${s.company || '—'}\nContact: ${s.contact_name || '—'}\nPhone: ${s.phone || '—'}\nEmail: ${s.email || '—'}\nPreferred: ${s.preferred_contact || 'WhatsApp'}`
    setSending(true); setSendStatus('Sending…')
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })
      const data = await res.json().catch(() => ({}))
      setSendStatus(data.ok ? '✓ Sent to the report group.' : 'Could not send: ' + (data?.error || `HTTP ${res.status}`))
    } catch (e) {
      setSendStatus('Could not send: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setSending(false) }
  }

  const td = todayYmd()
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  // The SCHEDULED amount for a row comes from the supplier's payment-day slot
  // (amount_1/amount_2) whose clamped day matches the row's expense day. Paying
  // overwrites the row's `amount` with what was actually paid, so any amount
  // paid ABOVE the scheduled slot value is a late fine.
  const scheduledAmountFor = (r: FixedExpense): number | null => {
    if (!s) return null
    const slots: { day: number; amount: number }[] = []
    if (s.payment_day_1 != null && s.amount_1 != null) slots.push({ day: Number(s.payment_day_1), amount: Number(s.amount_1) })
    if (s.payment_day_2 != null && s.amount_2 != null) slots.push({ day: Number(s.payment_day_2), amount: Number(s.amount_2) })
    if (slots.length === 0) return null
    if (slots.length === 1 || !isValidDate(r.expense_date)) return slots[0].amount
    const d = new Date(r.expense_date + 'T00:00:00')
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    let best = slots[0], bestDist = Infinity
    for (const sl of slots) {
      const dist = Math.abs(Math.min(sl.day, lastDay) - d.getDate())
      if (dist < bestDist) { bestDist = dist; best = sl }
    }
    return best.amount
  }

  const byMonth = new Map<string, FixedExpense[]>()
  for (const r of rows) { const k = (r.expense_date || '').slice(0, 7); if (!k) continue; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k)!.push(r) }
  const allMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))
  // This page lists only the PAST months + the NEXT upcoming one. Further-out months stay
  // generated (for the HOME/reports) but aren't shown here.
  let nextMonthKey: string | null = null
  for (const r of rows) { if (isValidDate(r.expense_date) && (r.expense_date as string) > td) { const mk = (r.expense_date as string).slice(0, 7); if (!nextMonthKey || mk < nextMonthKey) nextMonthKey = mk } }
  const months = nextMonthKey ? allMonths.filter(mk => mk <= (nextMonthKey as string)) : allMonths
  const visibleCount = months.reduce((n, mk) => n + (byMonth.get(mk) || []).length, 0)

  // With a CONCLUSION date the agreement is finite: the heading splits into
  // Total PAID (actually paid, fines included), Total DUE (every remaining
  // scheduled payment through the conclusion — including months not yet
  // generated) and Total FINAL (paid + due).
  const paidTotal = rows.filter(r => isValidDate(r.payment_date)).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  let dueTotal = 0
  if (s && isValidDate(s.date_conclusion) && isValidDate(s.date_entry)) {
    const slots: { day: number; amount: number }[] = []
    if (s.payment_day_1 != null && s.amount_1 != null) slots.push({ day: Number(s.payment_day_1), amount: Number(s.amount_1) })
    if (s.payment_day_2 != null && s.amount_2 != null) slots.push({ day: Number(s.payment_day_2), amount: Number(s.amount_2) })
    const clampD = (y: number, m: number, day: number) => { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)) }
    const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const start = new Date((s.date_entry as string) + 'T00:00:00')
    const end = new Date((s.date_conclusion as string) + 'T00:00:00')
    const paidDates = new Set(rows.filter(r => isValidDate(r.payment_date)).map(r => r.expense_date))
    let cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    while (cursor <= end) {
      for (const slot of slots) {
        const pd = clampD(cursor.getFullYear(), cursor.getMonth(), slot.day)
        if (pd <= end && !paidDates.has(toYmd(pd))) dueTotal += slot.amount
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }
  const finalTotal = paidTotal + dueTotal

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!s) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Not found.</p></main>

  const scheduleLine = [s.periodicity, s.cost_type].filter(Boolean).join(' · ')
  const paymentsLine = [
    s.payment_day_1 != null ? `Day ${s.payment_day_1}: ${formatUSD(Number(s.amount_1) || 0)}` : '',
    s.payment_day_2 != null ? `Day ${s.payment_day_2}: ${formatUSD(Number(s.amount_2) || 0)}` : '',
  ].filter(Boolean).join('  +  ')

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
            </div>
            {/* UNIVERSAL PAYMENT BLOCK — recording a payment is PAID by definition */}
            <PaymentFields value={payPayment} onChange={setPayPayment} hidePaidToggle />
            <DatePicker label="PAYMENT DATE" value={payDate} onChange={setPayDate} compact />
            {payReceipt && <a href={payReceipt} target="_blank" rel="noopener noreferrer" className="inline-block text-blue-400 hover:text-blue-300 text-sm">📎 Receipt attached</a>}
            <button onClick={savePayment} disabled={savingPay} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingPay ? 'Saving…' : 'SAVE PAYMENT'}</button>
          </div>
        </div>
      )}

      <SendToDialog
        open={sendOpen}
        onChoose={handlePageSend}
        subtitle="Send this supplier to…"
        supplierLabel="SUPPLIER"
        supplierHint="A link to fill in their own details"
        groupHint="This supplier's details to the team"
        busy={sending}
        status={sendStatus}
      />

      {/* Per-row SEND TO — payment proof (report + receipt file if any). */}
      <SendToDialog
        open={!!sendRow}
        onChoose={handleRowSend}
        subtitle="Send this payment proof to…"
        busy={sendBusy}
        status={sendRowStatus}
      />

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <Link href="/costs/fixed" className="text-gray-400 text-lg hover:text-white">← Fixed Cost Suppliers</Link>
        <div className="flex gap-3 flex-wrap">
          <button onClick={openSend} className="bg-emerald-700 hover:bg-emerald-600 px-6 py-3 rounded-2xl text-lg font-bold">📤 SEND TO</button>
          <Link href={`/costs/fixed/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-3 rounded-2xl text-lg font-bold">EDIT</Link>
          {isValidDate(s.date_conclusion) ? ((s.date_conclusion as string) <= todayYmd() ? <span className="bg-red-950 border border-red-800 text-red-300 px-6 py-3 rounded-2xl text-lg font-bold" title="date_conclusion no passado — contrato morto">ENCERRADA · {fmtDate(s.date_conclusion)}</span> : <span className="bg-amber-950 border border-amber-800 text-amber-300 px-6 py-3 rounded-2xl text-lg font-bold" title="contrato ATIVO com fim marcado — o gerador de contas para nessa data">ENCERRA · {fmtDate(s.date_conclusion)}</span>) : <button onClick={terminate} className="bg-red-900 hover:bg-red-800 px-6 py-3 rounded-2xl text-lg font-bold" title="grava o END DATE e apaga as contas agendadas depois dele (com trilha)">ENCERRAR</button>}
        </div>
      </div>

      <h1 className="text-4xl font-bold">{s.description || s.company || '—'}</h1>
      <p className="text-gray-400 mt-1 mb-4">
        {[s.company, s.contact_name, formatPhone(s.phone), s.email].filter(Boolean).join('  ·  ') || '—'}
      </p>
      {(scheduleLine || paymentsLine) && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3 max-w-3xl mb-8">
          {scheduleLine && <p className="text-sm font-bold text-gray-300">{scheduleLine}</p>}
          {paymentsLine && <p className="text-sm text-gray-400 mt-0.5">{paymentsLine}</p>}
          {isValidDate(s.date_entry) && <p className="text-xs text-gray-500 mt-1">{fmtDate(s.date_entry)} → {isValidDate(s.date_conclusion) ? fmtDate(s.date_conclusion) : 'Active'}</p>}
        </div>
      )}

      <div className="flex items-baseline gap-4 mb-6 flex-wrap">
        <h2 className="text-3xl font-bold">EXPENSES ({visibleCount})</h2>
        {isValidDate(s.date_conclusion) ? (
          <span className="text-xl font-bold flex gap-2 flex-wrap items-baseline">
            <span className="text-green-400">Total PAID: {formatUSD(paidTotal)}</span>
            <span className="text-gray-600">-</span>
            <span className="text-orange-400">Total DUE: {formatUSD(dueTotal)}</span>
            <span className="text-gray-600">-</span>
            <span className="text-gray-300">Total FINAL: {formatUSD(finalTotal)}</span>
          </span>
        ) : (
          // Open-ended agreement: the total is what actually LEFT the account. A
          // generated, not-yet-due installment is a forecast and must not count
          // as real spend — same rule as the staff season page.
          <span className="text-xl font-bold text-gray-300">Total PAID: {formatUSD(paidTotal)}</span>
        )}
      </div>

      {months.length === 0 ? (
        <p className="text-2xl text-gray-400">No expenses yet. Set the payment schedule in EDIT.</p>
      ) : (
        <div className="space-y-5">
          {months.map((mk) => {
            const pays = byMonth.get(mk)!
            const supplierName = pays[0]?.description || (s.description || s.company || '—')
            return (
              <div key={mk} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
                <div className="min-w-[10rem]">
                  <h3 className="text-2xl font-bold truncate">{supplierName}</h3>
                  <p className="text-lg text-gray-400">{fmtMonthYear(mk)}</p>
                </div>
                <div className="flex-1 min-w-[20rem] bg-gray-800 border border-gray-700 rounded-2xl p-4 space-y-3">
                  {pays.map((p) => {
                    const paid = isValidDate(p.payment_date)
                    const delayed = !paid && isValidDate(p.expense_date) && (p.expense_date as string) < td
                    const daysDelayed = delayed ? daysLate(p.expense_date as string, td) : 0
                    const sched = scheduledAmountFor(p)
                    const fine = paid && sched != null ? (Number(p.amount) || 0) - sched : 0
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 flex-wrap border-b border-gray-700/60 pb-3 last:border-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-lg font-bold">{formatUSD(Number(p.amount) || 0)}</span>
                            <span className="text-gray-400 text-sm">day {dayOf(p.expense_date)}</span>
                            {paid ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-800 text-green-300">PAID</span>
                              : delayed ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900 text-red-300">DELAYED ({daysDelayed} {daysDelayed === 1 ? 'day' : 'days'})</span> : null}
                            {fine > 0.005 && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900 text-red-300" title={`Scheduled ${formatUSD(sched || 0)} — paid ${formatUSD(Number(p.amount) || 0)}`}>FINES for Late: {formatUSD(fine)}</span>}
                          </div>
                          {paid && (
                            <p className="text-xs text-gray-500">
                              Paid: {fmtDate(p.payment_date)}
                              {p.receipt_url ? <> · <a href={p.receipt_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">📎 receipt</a></> : null}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <label className={`bg-purple-700 hover:bg-purple-600 px-3 py-1.5 rounded-xl font-bold text-xs cursor-pointer ${scanningId === p.id ? 'opacity-60 pointer-events-none' : ''}`}>
                            {scanningId === p.id ? '…' : '📸 SCAN'}
                            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanForRow(p, e.target.files[0]) }} />
                          </label>
                          <button onClick={() => openAddPayment(p)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1.5 rounded-xl font-bold text-xs">+ PAY</button>
                          <button onClick={() => openRowSend(p)} className="bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 rounded-xl font-bold text-xs">📤 SEND</button>
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
