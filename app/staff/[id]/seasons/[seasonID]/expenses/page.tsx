'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import PaymentFields, { defaultPayment, paymentFromRow, type PaymentInfo } from '@/components/PaymentFields'
import { formatUSD, BASE_PATH } from '@/lib/utils'
import { fileForScan } from '@/lib/scanFile'
import { usdBrlSpot, usdBrlOnDate, usdOf } from '@/lib/fx'

type Expense = {
  id: string
  type: string
  description: string | null
  amount: number
  source: string | null
  origin: string | null
  expense_date: string | null
  // Preenchidos quando o dinheiro realmente saiu — previsão fica com os dois vazios.
  payment_date: string | null
  paid_via: string | null
  receipt_url: string | null
  // ÂNCORA EM REAIS: quando existe, o real é o valor fixo e o dólar é
  // consequência — vivo enquanto em aberto, congelado no dia do pagamento.
  amount_brl: number | null
  payment_method: string | null
  paid_from: string | null
  paid_to: string | null
}

type Season = {
  season_code: string
  staff_id: string
  date_entry: string | null
  date_conclusion: string | null
  // A season é o CONTRATO — o equivalente ao supplier de um custo fixo.
  pay_type: string | null
  pay_rate: number | null
  pay_currency: string | null
  pay_day: number | null
}

// One queued WhatsApp report after a scan/save. items[] feeds the bullet list.
type ExpenseReportItem = { item: string; amount: string; quantity: string }
type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  description: string
  type: string
  origin: string
  items: ExpenseReportItem[]
  report: boolean
}
type DuplicateInfo = { title: string; details: string; proceed: () => void }

// Hoje no fuso da empresa (Orlando) — o dia de vencimento e o de pagamento são
// os de lá, nunca o UTC.
const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const dayOf = (d: string | null) => (d ? Number(d.slice(8, 10)) : 0)
const fmtMonthYear = (mk: string) => new Date(mk + '-01T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
const daysLate = (due: string, today: string) =>
  Math.max(0, Math.floor((new Date(today + 'T00:00:00').getTime() - new Date(due + 'T00:00:00').getTime()) / 86400000))

// Cada linha vale o PRÓPRIO valor: DAILY/WEEKLY/MONTHLY deixaram de ser taxa
// projetada e passaram a ser um pagamento com data (ordem do Márcio, 28/jul/2026).
function calculateRunningTotal(expense: Expense): number {
  return Number(expense.amount) || 0
}

// Etiqueta do período que o pagamento cobre — o dia/semana/mês da data da despesa.
function formatRunningLabel(expense: Expense): string {
  const d = expense.expense_date ? new Date(expense.expense_date + 'T00:00:00') : null
  if (!d) return ''
  const dm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  if (expense.type === 'WEEKLY') return `week of ${dm}`
  if (expense.type === 'MONTHLY') return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  if (expense.type === 'DAILY') return `day ${dm}`
  return ''
}

function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ExpensesPage() {
  const params = useParams()
  const staffId = String(params.id)
  const seasonID = String(params.seasonID ?? params.seasonId ?? '')

  const [season, setSeason] = useState<Season | null>(null)
  const [staffName, setStaffName] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [openReceiptsId, setOpenReceiptsId] = useState<string | null>(null)

  // SCAN state
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{
    supplier: string
    date: string
    type: string
    origin: string
    description: string
    items: { description: string; amount: string }[]
    receiptUrl: string
  } | null>(null)

  // WhatsApp + duplicate-warning state
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  // RECORD PAYMENT — o mesmo fluxo do custo fixo (Márcio, 26/ago/2026: "o padrão
  // destes pagamentos tem que ser o do fixed costs, afinal, isso é um fixed cost").
  const [paying, setPaying] = useState<Expense | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payPayment, setPayPayment] = useState<PaymentInfo>(defaultPayment())
  const [payDate, setPayDate] = useState('')
  const [savingPay, setSavingPay] = useState(false)
  const [spot, setSpot] = useState<number | null>(null)

  useEffect(() => { loadInfo(); loadExpenses(); usdBrlSpot().then(setSpot) }, [])

  // ── RECORD PAYMENT ───────────────────────────────────────────────────────
  // Igual ao custo fixo: a linha nasce AGENDADA com o valor do contrato, e o
  // pagamento sobrescreve o valor com o que realmente saiu. Para uma linha
  // ancorada em reais o real é o que se digita, e o dólar CONGELA no câmbio
  // comercial do dia do pagamento — "pagou, fica o valor pago, pra sempre".
  function openAddPayment(e: Expense) {
    setPaying(e)
    setPayAmount(Number(e.amount_brl) > 0 ? String(e.amount_brl) : String(e.amount ?? ''))
    setPayPayment({ ...paymentFromRow(e), paid: true })
    setPayDate(e.payment_date || todayEt())
  }

  async function savePayment() {
    if (!paying) return
    const digitado = parseFloat(payAmount) || 0
    if (digitado <= 0) { alert('Enter the amount that was paid'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) { alert('Pick the payment date'); return }
    setSavingPay(true)
    const ancorada = Number(paying.amount_brl) > 0
    let usd = digitado
    let brl: number | null = null
    if (ancorada) {
      brl = digitado
      const taxa = await usdBrlOnDate(payDate)
      if (!taxa) {
        setSavingPay(false)
        alert('This payment is anchored in R$ and the commercial rate for ' + payDate + ' could not be fetched.\n\nNOTHING was saved — try again in a moment.')
        return
      }
      usd = Number((brl / taxa).toFixed(2))
    }
    const { error } = await supabase.from('expenses').update({
      amount: usd,
      amount_brl: brl,
      payment_date: payDate,
      payment_method: payPayment.method || null,
      paid_from: payPayment.paidFrom || null,
      paid_to: payPayment.paidTo || null,
      // Legacy write-through, como nas outras telas de despesa de staff.
      source: payPayment.paidFrom || null,
      paid_via: payPayment.method || null,
      updated_at: new Date().toISOString(),
    }).eq('id', paying.id)
    setSavingPay(false)
    if (error) { alert(error.message); return }
    setPaying(null)
    loadExpenses()
  }

  async function loadInfo() {
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('season_code, staff_id, date_entry, date_conclusion, pay_type, pay_rate, pay_currency, pay_day')
      .eq('id', seasonID)
      .single()

    if (seasonData) {
      setSeason(seasonData)
      const { data: staff } = await supabase
        .from('staff')
        .select('name')
        .eq('id', seasonData.staff_id)
        .single()
      setStaffName(staff?.name || '')
    }
  }

  async function loadExpenses() {
    const { data } = await supabase.from('expenses').select('*').eq('season_id', seasonID)

    // SEMPRE do mais recente pro mais antigo (ordem do Márcio, 28/jul/2026) —
    // recorrente e avulso na mesma lista, porque agora todos são pagamentos com
    // data. Linha sem data vai pro fim.
    if (data) {
      setExpenses([...data].sort((a, b) => {
        if (!a.expense_date) return 1
        if (!b.expense_date) return -1
        return b.expense_date.localeCompare(a.expense_date)
      }))
    } else {
      setExpenses([])
    }

    setLoading(false)
  }

  async function removeExpense(id: string) {
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadExpenses()
  }

  async function handleScanExpense(file: File) {
    setScanningPurchase(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `staff/${staffId}/${seasonID}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      const receiptUrl = urlData.publicUrl

      const { base64, mediaType } = await fileForScan(file)

      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPurchase(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      // Expenses register in USD. When the document shows USD anywhere the scan
      // returns USD amounts; if it returned a foreign currency (no USD on the
      // document at all), warn so a BRL total is never registered as dollars.
      const scanCurrency = String(parsed.currency || 'USD').toUpperCase().trim()
      if (scanCurrency && scanCurrency !== 'USD') {
        alert(`⚠ This receipt only shows amounts in ${scanCurrency} — no USD amount was found on it.\nThe values below are ${scanCurrency}, NOT dollars. Fix them to USD in the review before confirming.`)
      }
      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const items = (parsed.items || []).map((i: any) => {
        // The scan returns the per-UNIT amount + a quantity; fold them into the line
        // total (qty x unit) so the expense reflects what was actually spent, and note
        // the quantity in the description. Summing the line totals = the receipt total.
        const qty = parseFloat(i.quantity) || 1
        const lineTotal = (parseFloat(i.amount) || 0) * qty
        return {
          description: qty > 1 ? `${String(i.description || '')} (×${qty})` : String(i.description || ''),
          amount: lineTotal.toFixed(2),
        }
      })
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0), 0)
      // Pre-fill the description with the items joined; user can refine in the modal.
      const autoDescription = items.length > 0
        ? items.map((i: any) => i.description).filter(Boolean).join(', ')
        : supplier

      const openReview = () => setScannedPurchase({
        supplier,
        date,
        type: 'SINGLE',
        origin: 'GZ28US',
        description: autoDescription,
        items,
        receiptUrl,
      })

      // Duplicate check: same source + date + total amount already in expenses.
      if (supplier && date && total > 0) {
        const { data: existing } = await supabase
          .from('expenses')
          .select('id, source, expense_date, amount')
          .ilike('source', supplier)
          .eq('expense_date', date)

        const matches = (existing || []).some(e => Math.abs((parseFloat(String(e.amount)) || 0) - total) < 0.01)
        if (matches) {
          setScanningPurchase(false)
          setDuplicateWarning({
            title: 'POSSIBLE DUPLICATE EXPENSE',
            details: `An expense from "${supplier}" on ${formatDate(date)} for ${formatUSD(total)} already exists.\n\nIs this the same receipt being scanned again?`,
            proceed: openReview,
          })
          return
        }
      }

      openReview()
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again.')
    }
    setScanningPurchase(false)
  }

  async function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const total = scannedPurchase.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)

    const { error } = await supabase.from('expenses').insert([{
      season_id: seasonID,
      type: scannedPurchase.type || 'SINGLE',
      description: scannedPurchase.description || null,
      amount: total,
      source: scannedPurchase.supplier || null,
      origin: scannedPurchase.origin || 'GZ28US',
      expense_date: isValidDate(scannedPurchase.date) ? scannedPurchase.date : null,
      receipt_url: scannedPurchase.receiptUrl ? JSON.stringify([scannedPurchase.receiptUrl]) : null,
    }])
    if (error) { alert(error.message); return }

    // Queue the optional WhatsApp report.
    const report: ExpenseReport = {
      supplier: scannedPurchase.supplier,
      date: scannedPurchase.date,
      receipt_url: scannedPurchase.receiptUrl,
      description: scannedPurchase.description,
      type: scannedPurchase.type,
      origin: scannedPurchase.origin,
      items: scannedPurchase.items.map(it => ({ item: it.description, amount: it.amount, quantity: '1' })),
      report: true,
    }

    setScannedPurchase(null)
    setExpenseReports([report])
    loadExpenses()
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
    const amountStr = formatUSD(total)
    const seasonLabel = season?.season_code || ''
    const lines: string[] = [
      `*EXPENSE — STAFF*`,
      `${seasonLabel}${staffName ? ` — ${staffName}` : ''}`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.description && exp.description.trim()) lines.push(exp.description.trim())
    const typeAndOrigin = [exp.type, exp.origin === 'PERSONAL' ? 'PERSONAL' : null].filter(Boolean).join(' — ')
    if (typeAndOrigin) lines.push(typeAndOrigin)
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())

    // Item bullets — only when the scan had more than one item.
    if (exp.items.length > 1) {
      lines.push('')
      exp.items.forEach(it => {
        const price = parseFloat(it.amount) || 0
        lines.push(`• ${it.item} — ${formatUSD(price)}`)
      })
    }

    return lines.join('\n') + '\n\nSent by GZ28 Control App'
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
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The expense was still saved.`)
    setExpenseReports(null)
  }

  // GASTO REAL = só o que já foi PAGO. A semana futura, gerada pelo app, é
  // previsão e não pode entrar no total gasto (ordem do Márcio, 28/jul). E não
  // existe total de previsto: enquanto o funcionário estiver na casa a conta é
  // infinita, e ninguém sabe a data do fim — somar isso seria inventar número.
  const gz28Total = season
    ? expenses.filter(e => (!e.origin || e.origin === 'GZ28US') && e.payment_date).reduce((sum, e) => sum + calculateRunningTotal(e), 0)
    : 0

  const personalTotal = season
    ? expenses.filter(e => e.origin === 'PERSONAL' && e.payment_date).reduce((sum, e) => sum + calculateRunningTotal(e), 0)
    : 0

  // A listagem para na PRÓXIMA conta (ordem do Márcio, 28/jul): as semanas
  // seguintes existem no banco pro Future Flow, mas não poluem a season — só
  // interessa aqui o que já foi pago, o que está vencido e a próxima a vencer.
  const todayET = todayEt()
  const nextDueDate = expenses
    .filter(e => !e.payment_date && e.expense_date && e.expense_date > todayET)
    .reduce<string | null>((min, e) => (!min || e.expense_date! < min ? e.expense_date! : min), null)
  const visibleExpenses = expenses.filter(e => {
    if (e.payment_date) return true
    if (!e.expense_date) return true
    if (e.expense_date <= todayET) return true
    return e.expense_date === nextDueDate
  })

  const isConcluded = !!season?.date_conclusion
  const totalLabel = isConcluded ? 'FINAL GZ28US EXPENSES' : 'ACTUAL GZ28US EXPENSES'
  const personalLabel = isConcluded ? 'FINAL PERSONAL EXPENSES' : 'ACTUAL PERSONAL EXPENSES'

  // ── AGRUPAMENTO POR MÊS, igual ao custo fixo ─────────────────────────────
  const byMonth = new Map<string, Expense[]>()
  for (const e of visibleExpenses) {
    const k = (e.expense_date || '').slice(0, 7)
    const key = k || 'sem-data'
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)!.push(e)
  }
  const months = [...byMonth.keys()].sort((a, b) => b.localeCompare(a))

  // O AGENDADO de uma linha recorrente é a taxa do contrato (a season). Pagar
  // sobrescreve o valor com o que saiu de fato — então o que passar do agendado
  // é diferença, exatamente como a multa por atraso do custo fixo.
  const scheduledFor = (e: Expense): number | null => {
    if (!season || e.type === 'SINGLE') return null
    const rate = Number(season.pay_rate) || 0
    if (rate <= 0) return null
    if ((season.pay_currency || 'USD') === 'BRL') return spot && spot > 0 ? rate / spot : null
    return rate
  }

  // A linha do contrato, no mesmo formato do cartão de custo fixo.
  const moedaTaxa = (season?.pay_currency || 'USD') === 'BRL' ? 'R$' : 'US$'
  const scheduleLine = [season?.pay_type, 'STAFF'].filter(Boolean).join(' · ')
  const paymentsLine = Number(season?.pay_rate) > 0
    ? `${season?.pay_type === 'MONTHLY' ? `Day ${season?.pay_day ?? 'last'}` : season?.pay_type === 'WEEKLY' ? 'Weekly' : 'Daily'}: ${moedaTaxa} ${Number(season?.pay_rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : ''

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this expense? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeExpense(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* DUPLICATE WARNING */}
      {duplicateWarning && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-2xl font-bold text-yellow-400">⚠ {duplicateWarning.title}</h2>
            <p className="text-gray-300 whitespace-pre-wrap text-base">{duplicateWarning.details}</p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setDuplicateWarning(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={() => { const p = duplicateWarning.proceed; setDuplicateWarning(null); p() }} className="flex-1 bg-yellow-700 hover:bg-yellow-600 px-5 py-3 rounded-2xl font-bold text-lg">REGISTER ANYWAY</button>
            </div>
          </div>
        </div>
      )}

      {/* REVIEW EXPENSE MODAL */}
      {scannedPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW EXPENSE</h2>
              <button onClick={() => setScannedPurchase(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 space-y-3">
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                  <input type="text" value={scannedPurchase.supplier} onChange={(e) => setScannedPurchase({ ...scannedPurchase, supplier: e.target.value })} className={inputClass} />
                </div>
                <div className="flex-1">
                  <DatePicker label="DATE" value={scannedPurchase.date} onChange={(v) => setScannedPurchase({ ...scannedPurchase, date: v })} />
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block mb-1 text-sm text-gray-400">TYPE</label>
                  <select value={scannedPurchase.type} onChange={(e) => setScannedPurchase({ ...scannedPurchase, type: e.target.value })} className={selectClass}>
                    <option value="SINGLE">SINGLE</option>
                    <option value="DAILY">DAILY</option>
                    <option value="WEEKLY">WEEKLY</option>
                    <option value="MONTHLY">MONTHLY</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block mb-1 text-sm text-gray-400">RESPONSIBLE</label>
                  <select value={scannedPurchase.origin} onChange={(e) => setScannedPurchase({ ...scannedPurchase, origin: e.target.value })} className={selectClass}>
                    <option value="GZ28US">GZ28US</option>
                    <option value="PERSONAL">PERSONAL</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
                <input type="text" value={scannedPurchase.description} onChange={(e) => setScannedPurchase({ ...scannedPurchase, description: e.target.value })} className={inputClass} placeholder="Expense description" />
              </div>
              <div className="pt-2">
                <p className="text-sm text-gray-400 mb-2">ITEMS DETECTED ON RECEIPT</p>
                <div className="space-y-2">
                  {scannedPurchase.items.map((item, i) => (
                    <div key={i} className="flex gap-3 items-center">
                      <input type="text" value={item.description} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], description: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} flex-1`} placeholder="Item description" />
                      <div className="relative w-32">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input type="text" inputMode="decimal" value={item.amount} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], amount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} w-full pl-7`} placeholder="0.00" />
                      </div>
                      <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: scannedPurchase.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2">✕</button>
                    </div>
                  ))}
                  <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: [...scannedPurchase.items, { description: '', amount: '' }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
                </div>
              </div>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0))}
              </div>
              <button onClick={confirmScannedPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

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
                const t = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0)
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — STAFF — {formatUSD(t)}</p>
                      <p className="text-sm text-gray-400 truncate" title={exp.description || exp.supplier || 'Expense'}>{exp.description || exp.supplier || 'Expense'}</p>
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

      {/* SCANNING OVERLAY */}
      {scanningPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">Scanning Receipt...</p>
            <p className="text-gray-400">Claude is reading your receipt</p>
          </div>
        </div>
      )}

      {/* RECORD PAYMENT — o mesmo modal do custo fixo. Registrar um pagamento
          é PAGO por definição, então o toggle do bloco universal fica escondido. */}
      {paying && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">RECORD PAYMENT</h2>
              <button onClick={() => setPaying(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <p className="text-gray-400">{paying.description || '—'}{paying.expense_date ? ` · day ${dayOf(paying.expense_date)}` : ''}</p>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-44">
                <label className="block mb-1 text-xs text-gray-400">{Number(paying.amount_brl) > 0 ? 'AMOUNT PAID (R$)' : 'AMOUNT PAID'}</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{Number(paying.amount_brl) > 0 ? 'R$' : '$'}</span>
                  <input type="text" inputMode="decimal" value={payAmount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setPayAmount(e.target.value) }} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 pl-10" placeholder="0.00" />
                </div>
              </div>
            </div>
            {Number(paying.amount_brl) > 0 && (
              <p className="text-xs text-gray-500">
                The R$ is the anchor. On save the dollar freezes at the commercial rate of {payDate || 'the payment date'} — the dollar of the day it was paid, forever.
              </p>
            )}
            <PaymentFields value={payPayment} onChange={setPayPayment} hidePaidToggle />
            <DatePicker label="PAYMENT DATE" value={payDate} onChange={setPayDate} compact />
            <button onClick={savePayment} disabled={savingPay} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{savingPay ? 'Saving…' : 'SAVE PAYMENT'}</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-bold">{staffName} — {season?.season_code}</h1>
          <p className="text-xl text-gray-400 mt-1">EXPENSES ({visibleExpenses.length})</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Link href={`/staff/${staffId}/seasons`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <label className="bg-indigo-700 hover:bg-indigo-600 px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer">
            🧾 SCAN A NEW EXPENSE
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanExpense(e.target.files[0]) }} />
          </label>
          <Link href={`/staff/${staffId}/seasons/${seasonID}/expenses/new`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD NEW EXPENSE</Link>
        </div>
      </div>

      {/* O CONTRATO — no custo fixo é o cartão do supplier (periodicidade, dia e
          valor, vigência). Aqui é a season, que faz o mesmo papel. */}
      {(scheduleLine || paymentsLine) && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3 max-w-3xl mb-8">
          {scheduleLine && <p className="text-sm font-bold text-gray-300">{scheduleLine}</p>}
          {paymentsLine && <p className="text-sm text-gray-400 mt-0.5">{paymentsLine}</p>}
          {season?.date_entry && (
            <p className="text-xs text-gray-500 mt-1">
              {formatDate(season.date_entry)} → {season.date_conclusion ? formatDate(season.date_conclusion) : 'Active'}
            </p>
          )}
        </div>
      )}

      {expenses.length > 0 && (
        <div className="flex gap-4 mb-8 flex-wrap">
          <div className="bg-red-700 rounded-3xl p-6 flex-1 min-w-64">
            <p className="text-xl font-bold">{totalLabel}</p>
            <p className="text-5xl font-bold">{formatUSD(gz28Total)}</p>
            {!isConcluded && <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>}
          </div>
          {personalTotal > 0 && (
            <div className="bg-orange-600 rounded-3xl p-6 flex-1 min-w-64">
              <p className="text-xl font-bold">{personalLabel}</p>
              <p className="text-5xl font-bold">{formatUSD(personalTotal)}</p>
              {!isConcluded && <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : expenses.length === 0 ? (
        <p className="text-2xl text-gray-400">No expenses yet.</p>
      ) : (
        <div className="space-y-5">
          {months.map((mk) => (
          <div key={mk} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-start justify-between gap-6 flex-wrap">
            <div className="min-w-[10rem]">
              <h3 className="text-2xl font-bold truncate">{staffName}</h3>
              <p className="text-lg text-gray-400">{mk === 'sem-data' ? 'No date' : fmtMonthYear(mk)}</p>
            </div>
            <div className="flex-1 min-w-[20rem] bg-gray-800 border border-gray-700 rounded-2xl p-4 space-y-3">
          {byMonth.get(mk)!.map((expense) => {
            const receiptUrls = parseReceiptUrls(expense.receipt_url)
            const paid = !!expense.payment_date
            // O dólar de uma linha ancorada em reais só é definitivo depois de paga.
            const shown = usdOf(expense, spot)
            const atrasada = !paid && !!expense.expense_date && expense.expense_date < todayET
            const diasAtraso = atrasada ? daysLate(expense.expense_date as string, todayET) : 0
            const sched = scheduledFor(expense)
            const dif = paid && sched != null ? shown - sched : 0
            return (
              <div key={expense.id} className="flex items-start justify-between gap-3 flex-wrap border-b border-gray-700/60 pb-3 last:border-0 last:pb-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-bold">{formatUSD(shown)}</span>
                    {Number(expense.amount_brl) > 0 && (
                      <span className="text-sm text-gray-400" title={paid ? 'Frozen at the rate of the day it was paid' : 'Anchored in R$ — the dollar moves every day until it is paid'}>R$ {Number(expense.amount_brl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{paid ? '' : ' · live'}</span>
                    )}
                    {expense.expense_date && <span className="text-gray-400 text-sm">day {dayOf(expense.expense_date)}</span>}
                    {paid ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-800 text-green-300">PAID</span>
                    ) : atrasada ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900 text-red-300">DELAYED ({diasAtraso} {diasAtraso === 1 ? 'day' : 'days'})</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-700 text-yellow-100">SCHEDULED</span>
                    )}
                    {dif > 0.005 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900 text-red-300" title={`Scheduled ${formatUSD(sched || 0)} — paid ${formatUSD(shown)}`}>ABOVE SCHEDULE: {formatUSD(dif)}</span>
                    )}
                  </div>
                  {paid && (
                    <p className="text-xs text-gray-500">
                      Paid: {formatDate(expense.payment_date)}{expense.paid_via ? ' · ' + expense.paid_via : ''}{expense.paid_from ? ' · from ' + expense.paid_from : ''}
                    </p>
                  )}
                  {expense.description && <p className="text-sm text-gray-300 truncate" title={expense.description}>{expense.description}</p>}
                  <p className="text-xs text-gray-500">
                    {expense.type}{expense.type !== 'SINGLE' ? ' · ' + formatRunningLabel(expense) : expense.expense_date ? ' · ' + formatDate(expense.expense_date) : ''}
                  </p>
                  {expense.origin === 'PERSONAL' && (
                    <span className="inline-block bg-orange-600 text-white text-xs font-bold px-2 py-0.5 rounded-full mt-1">PERSONAL</span>
                  )}
                </div>

                <div className="flex gap-2 flex-wrap shrink-0 items-center">
                  {/* Baixar o pagamento é o gesto principal, como no custo fixo. */}
                  <button onClick={() => openAddPayment(expense)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1.5 rounded-xl font-bold text-xs">{paid ? '✎ PAYMENT' : '+ PAY'}</button>
                  <Link href={`/staff/${staffId}/seasons/${seasonID}/expenses/edit/${expense.id}`} className="bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-xl font-bold text-xs">EDIT</Link>
                  <button onClick={() => setConfirmId(expense.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1.5 rounded-xl font-bold text-xs">✕</button>
                  {receiptUrls.length > 0 && (
                    <div className="relative">
                      <button onClick={() => setOpenReceiptsId(openReceiptsId === expense.id ? null : expense.id)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1.5 rounded-xl font-bold text-xs">
                        📎{receiptUrls.length > 1 ? ` ${receiptUrls.length}` : ''}
                      </button>
                      {openReceiptsId === expense.id && (
                        <div className="absolute right-0 top-10 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                          {receiptUrls.map((url, ui) => (
                            <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate" title={`File ${ui + 1}`}>File {ui + 1}</a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
            </div>
          </div>
          ))}
        </div>
      )}
    </main>
  )
}
