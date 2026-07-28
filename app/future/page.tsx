'use client'
/* eslint-disable @typescript-eslint/no-unused-vars */

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate, flowClientLabel } from '@/lib/utils'
import { DEFAULT_SOURCE } from '@/components/SourceSelect'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtD(v: string | null) { return v ? String(v).slice(0, 10) : '' }

// Generate every fixed-cost supplier's scheduled payment rows 6 months ahead (one row per
// payment day per month, first payment the month after the start). Idempotent — only inserts
// month-dates that don't already exist. Runs here so the rows exist on HOME without first
// visiting each supplier page (which has the same generator).
async function ensureFixedCostPayments() {
  const { data: sups } = await supabase.from('fixed_cost_suppliers')
    .select('id, description, company, date_entry, date_conclusion, periodicity, payment_day_1, amount_1, payment_day_2, amount_2')
  if (!sups || sups.length === 0) return
  const { data: existing } = await supabase.from('fixed_cost_expenses').select('supplier_id, expense_date')
  const existsBySup = new Map<string, Set<string>>()
  for (const e of existing || []) { if (!e.expense_date) continue; if (!existsBySup.has(e.supplier_id)) existsBySup.set(e.supplier_id, new Set()); existsBySup.get(e.supplier_id)!.add(e.expense_date) }
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const clampDay = (y: number, m: number, day: number) => { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)) }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const targetEnd = new Date(today.getFullYear(), today.getMonth() + 7, 0)
  const toInsert: any[] = []
  for (const sup of sups as any[]) {
    if (sup.periodicity !== 'MONTHLY' || !sup.date_entry) continue
    const slots: { day: number; amount: number }[] = []
    if (sup.payment_day_1 != null && sup.amount_1 != null) slots.push({ day: Number(sup.payment_day_1), amount: Number(sup.amount_1) })
    if (sup.payment_day_2 != null && sup.amount_2 != null) slots.push({ day: Number(sup.payment_day_2), amount: Number(sup.amount_2) })
    if (slots.length === 0) continue
    const start = new Date(sup.date_entry + 'T00:00:00')
    const end = sup.date_conclusion ? new Date(sup.date_conclusion + 'T00:00:00') : null
    const supName = sup.description || sup.company || 'Payment'
    const has = existsBySup.get(sup.id) || new Set<string>()
    let cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    while (cursor <= targetEnd) {
      for (const slot of slots) {
        const pd = clampDay(cursor.getFullYear(), cursor.getMonth(), slot.day)
        const key = ymd(pd)
        if (!(end && pd > end) && pd <= targetEnd && !has.has(key)) {
          toInsert.push({ supplier_id: sup.id, type: 'SINGLE', description: supName, amount: slot.amount, source: DEFAULT_SOURCE, expense_date: key })
          has.add(key)
        }
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }
  if (toInsert.length > 0) await supabase.from('fixed_cost_expenses').insert(toInsert)
}

// FOLHA RECORRENTE DE STAFF no Future Flow (ordem do Márcio, 28/jul/2026:
// "quero abrir o Future Flow e ver TODAS AS CONTAS PREVISTAS, SEM EXCEÇÃO").
// A season carrega a taxa (pay_type / pay_rate / pay_weekday) e aqui nascem, com
// antecedência, as linhas EM ABERTO de cada período até ~3 meses à frente — do
// mesmo jeito que ensureFixedCostPayments faz com a conta fixa mensal. Sem isso o
// salário só apareceria no dia do pagamento e sumiria da previsão.
async function ensureStaffPayments() {
  const { data: seasons } = await supabase.from('seasons')
    .select('id, staff_id, date_entry, date_conclusion, pay_type, pay_rate, pay_weekday')
    .is('date_conclusion', null).not('pay_type', 'is', null)
  if (!seasons || seasons.length === 0) return
  const { data: existing } = await supabase.from('expenses').select('season_id, type, expense_date')
  const has = new Set((existing || []).map((e: any) => `${e.season_id}|${e.type}|${e.expense_date}`))
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const limit = new Date(today); limit.setMonth(limit.getMonth() + 3)
  const toInsert: any[] = []
  for (const s of seasons as any[]) {
    const rate = Number(s.pay_rate) || 0
    if (rate <= 0) continue
    const cursor = new Date(today)
    if (s.pay_type === 'WEEKLY') {
      const dia = s.pay_weekday ?? 5
      while (cursor.getDay() !== dia) cursor.setDate(cursor.getDate() + 1)
      for (; cursor <= limit; cursor.setDate(cursor.getDate() + 7)) {
        const key = ymd(cursor)
        if (has.has(`${s.id}|WEEKLY|${key}`)) continue
        toInsert.push({ season_id: s.id, type: 'WEEKLY', amount: rate, expense_date: key, payment_date: null, source: 'GZ28US', description: `Semanal (sexta ${key.slice(8, 10)}/${key.slice(5, 7)}) — previsto` })
      }
    } else if (s.pay_type === 'MONTHLY') {
      const c = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      for (; c <= limit; c.setMonth(c.getMonth() + 2, 0)) {
        const key = ymd(c)
        if (has.has(`${s.id}|MONTHLY|${key}`)) continue
        toInsert.push({ season_id: s.id, type: 'MONTHLY', amount: rate, expense_date: key, payment_date: null, source: 'GZ28US', description: `Mensal ${key.slice(5, 7)}/${key.slice(0, 4)} — previsto` })
      }
    }
  }
  if (toInsert.length > 0) await supabase.from('expenses').insert(toInsert)
}

// Collapse any stored milestone label (incl. legacy long forms like
// "Goods Arrival" / "Project Conclusion") to its canonical short code, so old
// and new rows land in the SAME group.
function canonMilestone(v: string | null | undefined): string | undefined {
  if (!v || !v.trim()) return undefined
  const s = v.trim().toLowerCase()
  if (s.includes('arrival')) return 'ARRIVAL'
  if (s.includes('conclusion')) return 'CONCLUSION'
  return v.trim()
}

// Today as YYYY-MM-DD in local time — for flagging scheduled incomes whose date has
// already arrived/passed (those are DELAYED).
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

type GlobalStats = { cashFlow: number; cashFlowPct: number; dueClients: number; markup: number; markupPct: number; dueGz: number }
type Row = { code: string; label: string; amount: number; dated: boolean; date: string | null; href: string; tip: string; labelTip?: string; milestone?: string; delayed?: boolean }
// A dated cash-flow entry for the monthly-flow box: income is +, expense is −.
type FlowItem = { date: string; code: string; label: string; href: string; signed: number; tip?: string }

export default function HomePage() {
  const [s, setS] = useState<GlobalStats>({ cashFlow: 0, cashFlowPct: 0, dueClients: 0, markup: 0, markupPct: 0, dueGz: 0 })
  const [rows, setRows] = useState<{ income: Row[]; expense: Row[]; tax: Row[]; loss: Row[] }>({ income: [], expense: [], tax: [], loss: [] })
  const [flow, setFlow] = useState<FlowItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    await ensureFixedCostPayments()
    await ensureStaffPayments()
    // EVERYTHING, all time — every REPORT-READY (non-quote, ONLINE/CLOSED) invoice and its children.
    const [{ data: invs }, { data: pays }, { data: exps }, { data: parts }] = await Promise.all([
      supabase.from('invoices').select('id, invoice_code, ride_id, client_id, service, florida_taxes, fl_tax_expense_date').eq('is_quote', false).in('live_status', ['REALTIME', 'CLOSED']),
      supabase.from('invoice_payments').select('invoice_id, amount, paid_at, payment_date, source, description, date_label'),
      supabase.from('invoice_expenses').select('invoice_id, price, quantity, expense_date, payment_date, tax, extra, item, supplier'),
      supabase.from('invoice_parts').select('invoice_id, unit_price, quantity'),
    ])

    // Stock-sale income per donor invoice (a donated part another car pulled from stock),
    // matched via the inventory note's "From <invoice code>" prefix.
    const stockByCode = new Map<string, { all: number; paid: number }>()
    const [{ data: donInv }, { data: pulls }] = await Promise.all([
      supabase.from('inventory').select('description, donor, notes').eq('category', 'STOCK').eq('source_type', 'DONATED'),
      supabase.from('invoice_expenses').select('item, stock_donor, payment_date, price, quantity').not('stock_donor', 'is', null),
    ])
    const donorCodeByKey = new Map<string, string>()
    ;(donInv || []).forEach((r: any) => { const mm = (r.notes || '').match(/^From\s+(\S+)\s+—/); if (mm) donorCodeByKey.set(`${(r.donor || '').trim().toLowerCase()}|${(r.description || '').trim().toLowerCase()}`, mm[1]) })
    ;(pulls || []).forEach((e: any) => {
      const code = donorCodeByKey.get(`${(e.stock_donor || '').trim().toLowerCase()}|${(e.item || '').trim().toLowerCase()}`)
      if (!code) return
      const amt = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1)
      const cur = stockByCode.get(code) || { all: 0, paid: 0 }
      cur.all += amt; if (isValidDate(e.payment_date)) cur.paid += amt
      stockByCode.set(code, cur)
    })

    const group = <T extends { invoice_id: string }>(rs: T[] | null) => {
      const m = new Map<string, T[]>()
      for (const r of rs || []) { const a = m.get(r.invoice_id) || []; a.push(r); m.set(r.invoice_id, a) }
      return m
    }
    const paysBy = group(pays), expsBy = group(exps), partsBy = group(parts)
    const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
    // Per-invoice FINAL MARKUP; invoices with a negative markup are LOSSES, surfaced in
    // their own group in the DUE by CLIENTS column (separate from the unpaid incomes).
    const lossByInvoice = new Map<string, { amount: number; pct: number }>()

    // Resolve each invoice's client + car for the VIEW link/tooltip.
    const [{ data: ridesD }, { data: clientsD }, { data: fixedCostExp }, { data: invSalesD }, { data: staffExp }, { data: seasonsD }, { data: staffD }] = await Promise.all([
      supabase.from('rides').select('id, project_name, model, version, client_id'),
      supabase.from('clients').select('id, name'),
      supabase.from('fixed_cost_expenses').select('id, supplier_id, description, amount, expense_date').is('payment_date', null),
      supabase.from('inventory_sales').select('kind, amount, entry_date').not('entry_date', 'is', null),
      supabase.from('expenses').select('id, season_id, type, description, amount, expense_date').is('payment_date', null),
      supabase.from('seasons').select('id, staff_id'),
      supabase.from('staff').select('id, name'),
    ])
    const ridesById = new Map<string, any>(); (ridesD || []).forEach((r: any) => ridesById.set(r.id, r))
    const clientsById = new Map<string, string>(); (clientsD || []).forEach((c: any) => clientsById.set(c.id, c.name || ''))

    const codeById = new Map<string, string>()
    const metaById = new Map<string, { href: string; tip: string; carInvTip: string; clientName: string; carName: string; invoiceName: string }>()
    const metaByCode = new Map<string, { href: string; tip: string; carInvTip: string; clientName: string; carName: string; invoiceName: string }>()
    for (const inv of invs || []) {
      const ride = inv.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv.client_id || ride?.client_id || null
      codeById.set(inv.id, inv.invoice_code)
      const clientName = cid ? flowClientLabel(clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const invoiceName = inv.service || inv.invoice_code
      const ownerSeg = inv.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      const meta = {
        href: `${BASE_PATH}/${ownerSeg}/invoices/${inv.id}`,
        tip: [clientName, carName, invoiceName].filter(Boolean).join(' — '),   // full (expenses)
        carInvTip: [carName, invoiceName].filter(Boolean).join(' — '),         // car — invoice (incomes/loss code)
        clientName, carName, invoiceName,
      }
      metaById.set(inv.id, meta); metaByCode.set(inv.invoice_code, meta)
    }
    const metaFor = (id?: string, code?: string) => (id && metaById.get(id)) || (code && metaByCode.get(code)) || { href: '#', tip: code || '', carInvTip: code || '', clientName: '', carName: '', invoiceName: '' }

    // Inventory part sales: paid (dated) incomes are money in, paid expenses money out.
    let saleIncomePaid = 0, saleExpensePaid = 0
    for (const sv of invSalesD || []) {
      const amt = parseFloat(sv.amount) || 0
      if (!amt) continue
      if (sv.kind === 'INCOME') saleIncomePaid += amt
      else if (sv.kind === 'EXPENSE') saleExpensePaid += amt
    }

    let cashFlow = 0, dueClients = 0, markup = 0, dueGz = 0, sumExpPaid = 0, sumExpGlobal = 0
    for (const inv of invs || []) {
      const ip = paysBy.get(inv.id) || []
      const ie = expsBy.get(inv.id) || []
      const ipa = partsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((x: number, p: any) => x + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
      const ss = stockByCode.get(inv.invoice_code) || { all: 0, paid: 0 }
      const paymentsSum = ip.reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0)
      const totalPaid = ip.filter((p: any) => !!p.paid_at).reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0) + ss.paid
      const totalIncomeAll = paymentsSum + ss.all
      const expensesTotalGlobal = flTaxAmount + ie.reduce((x: number, e: any) => x + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + ie.filter((e: any) => isValidDate(e.payment_date)).reduce((x: number, e: any) => x + expenseLine(e), 0)
      cashFlow += totalPaid - expensesTotalPaid
      dueClients += totalIncomeAll - totalPaid
      // FINAL MARKUP = listed income − expenses (the invoice's real result, matching its card);
      // a negative value = LOSS invoice. Pending balances are collected via the editor's
      // ADD PENDING BALANCE button, so they don't auto-mask a loss here.
      const invMarkup = totalIncomeAll - expensesTotalGlobal
      if (invMarkup < -0.005) lossByInvoice.set(inv.id, { amount: invMarkup, pct: expensesTotalGlobal > 0 ? (invMarkup / expensesTotalGlobal) * 100 : 0 })
      markup += invMarkup
      dueGz += expensesTotalPaid - expensesTotalGlobal
      sumExpPaid += expensesTotalPaid
      sumExpGlobal += expensesTotalGlobal
    }
    // Fold inventory part-sale cash into the Cash FLOW stat (money in − money out).
    cashFlow += saleIncomePaid - saleExpensePaid
    sumExpPaid += saleExpensePaid

    // Detail rows below the boxes: only DUE (unpaid) rows — already-paid ones carry no DUE.
    // Income is PAID when paid_at is set; an unpaid income is DATED if it has a scheduled
    // payment_date (e.g. an installment due-date), UNDATED if it has none.
    // Income rows show the CLIENT NAME (the description is the label's rollover); the code's
    // rollover is car — invoice.
    const income: Row[] = []
    for (const p of pays || []) {
      const code = codeById.get(p.invoice_id); if (!code) continue
      if (p.paid_at) continue
      const amount = parseFloat(p.amount) || 0; if (!amount) continue
      const dated = isValidDate(p.payment_date)
      const m = metaFor(p.invoice_id, code)
      const desc = p.description || p.source || 'Income'
      income.push({ code, label: m.clientName || desc, amount, dated, date: dated ? fmtD(p.payment_date) : null, href: m.href, tip: m.carInvTip, labelTip: desc, milestone: canonMilestone(p.date_label) })
    }
    stockByCode.forEach((v, code) => {
      if (!Array.from(codeById.values()).includes(code)) return
      const pending = v.all - v.paid
      if (pending > 0.005) { const m = metaFor(undefined, code); income.push({ code, label: m.clientName || 'Stock part sold', amount: pending, dated: false, date: null, href: m.href, tip: m.carInvTip, labelTip: 'Stock part sold' }) }
    })
    // LOSS group: invoices whose FINAL MARKUP is negative (shown last, separate from incomes).
    const loss: Row[] = []
    for (const inv of invs || []) {
      const lm = lossByInvoice.get(inv.id); if (!lm) continue
      const m = metaFor(inv.id, inv.invoice_code)
      const pctLabel = `${lm.pct.toFixed(1)}%`
      // LOSS rows label with the CAR NAME; the invoice name is the label's rollover.
      loss.push({ code: inv.invoice_code, label: m.carName || m.clientName || pctLabel, amount: lm.amount, dated: false, date: null, href: m.href, tip: m.carInvTip, labelTip: m.invoiceName || pctLabel })
    }
    loss.sort((a, b) => a.amount - b.amount)

    // DUE by GZ28 lists only UNPAID expenses (what GZ28 still owes). A paid expense
    // carries a payment_date and is excluded. Among the unpaid ones, DATED = has an
    // expense_date (the expense's own date), UNDATED = none.
    // Consolidate the same SUPPLIER within the same invoice (and same date bucket)
    // into a single row carrying the summed amount — many line items from one
    // supplier on one invoice show as one DUE row, not one per item.
    const expense: Row[] = []
    const expByKey = new Map<string, Row & { _n: number }>()
    for (const e of exps || []) {
      const code = codeById.get(e.invoice_id); if (!code) continue
      if (isValidDate(e.payment_date)) continue
      const amount = expenseLine(e); if (!amount) continue
      const m = metaFor(e.invoice_id, code)
      const dated = isValidDate(e.expense_date)
      // Show the SUPPLIER; the item description becomes the hover tooltip.
      const label = e.supplier || e.item || 'Expense'
      const date = dated ? fmtD(e.expense_date) : null
      const key = `${e.invoice_id}|${label}|${date || 'UNDATED'}`
      const prev = expByKey.get(key)
      if (prev) { prev.amount += amount; prev._n += 1; prev.labelTip = `${prev._n} items` }
      else expByKey.set(key, { code, label, amount, dated, date, href: m.href, tip: m.tip, labelTip: e.item || '', _n: 1 })
    }
    for (const r of expByKey.values()) { const { _n, ...row } = r; expense.push(row) }
    // Florida sales tax GZ28 owes — consolidated into its own group, shown last.
    const tax: Row[] = []
    for (const inv of invs || []) {
      const ipa = partsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((x: number, p: any) => x + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      if (flTaxAmount > 0.005 && !isValidDate(inv.fl_tax_expense_date)) {
        const m = metaFor(inv.id, inv.invoice_code)
        tax.push({ code: inv.invoice_code, label: 'Florida Taxes', amount: flTaxAmount, dated: false, date: null, href: m.href, tip: m.tip })
      }
    }
    // Sort by date (ascending); for the same date — or undated rows — bigger amount first.
    const byDateThenAmount = (a: Row, b: Row) =>
      (a.date && b.date) ? (a.date.localeCompare(b.date) || b.amount - a.amount) : a.date ? -1 : b.date ? 1 : (b.amount - a.amount)
    income.sort(byDateThenAmount); expense.sort(byDateThenAmount); tax.sort(byDateThenAmount)

    // Fixed-cost supplier bills that are still UNPAID — money GZ28 owes. Each is dated on
    // its scheduled day, so a past-due one becomes DELAYED in the DUE by GZ28 box and an
    // upcoming one flows into the monthly box below (same treatment as invoice bills).
    // Both unpaid payments of the same month + supplier show as ONE combined row (summed,
    // dated on the later day). Once one is paid it leaves this list, so the other shows alone.
    const fcByGroup = new Map<string, { amount: number; date: string; label: string; supplierId: string }>()
    for (const e of fixedCostExp || []) {
      const fcAmount = parseFloat(e.amount) || 0
      if (!fcAmount || !isValidDate(e.expense_date)) continue
      dueGz -= fcAmount
      const key = `${e.supplier_id}|${(e.expense_date as string).slice(0, 7)}`
      const g = fcByGroup.get(key)
      if (g) { g.amount += fcAmount; if ((e.expense_date as string) > g.date) g.date = e.expense_date }
      else fcByGroup.set(key, { amount: fcAmount, date: e.expense_date, label: e.description || 'Fixed cost', supplierId: e.supplier_id })
    }
    for (const g of fcByGroup.values()) {
      expense.push({ code: 'FIXED', label: g.label, amount: g.amount, dated: true, date: g.date, href: `${BASE_PATH}/costs/fixed/${g.supplierId}`, tip: g.label, labelTip: 'Fixed cost' })
    }

    // FOLHA DE STAFF — pagamento recorrente ainda EM ABERTO é conta que a GZ28
    // deve, igual à conta fixa: entra no DUE by GZ28 se já venceu e no fluxo do
    // mês se está por vir. Sem isso o salário sumia da previsão inteira.
    const staffById = new Map<string, string>(); (staffD || []).forEach((x: any) => staffById.set(x.id, x.name || ''))
    const seasonStaff = new Map<string, string>(); (seasonsD || []).forEach((x: any) => seasonStaff.set(x.id, x.staff_id))
    for (const e of staffExp || []) {
      const amount = parseFloat(e.amount) || 0
      if (!amount || !isValidDate(e.expense_date)) continue
      dueGz -= amount
      const staffId = seasonStaff.get(e.season_id) || ''
      const nome = staffById.get(staffId) || 'Staff'
      const periodo = e.type === 'WEEKLY' ? `semana ${String(e.expense_date).slice(8, 10)}/${String(e.expense_date).slice(5, 7)}` : String(e.type).toLowerCase()
      expense.push({
        code: 'STAFF', label: `${nome} — ${periodo}`, amount, dated: true, date: e.expense_date,
        href: `${BASE_PATH}/staff/${staffId}/seasons`, tip: e.description || nome, labelTip: 'Staff payment',
      })
    }
    expense.sort(byDateThenAmount)

    // Pull DATED income & expenses OUT of the DUE boxes into the monthly-flow box
    // below: income is money in (+), expense is money out (−). Adjust the box
    // headlines so they reflect only what stays (undated + milestones + loss/tax).
    // A scheduled (dated) client income whose date is today or already past, and still
    // unpaid, is DELAYED: it stays in the DUE by CLIENTS box (under its own DELAYED group)
    // and keeps counting toward what clients owe. Only UPCOMING dated income (date in the
    // future) is pulled out into the monthly flow below.
    const today = todayYmd()
    const allDatedIncome = income.filter(r => r.dated && !r.milestone && r.date)
    allDatedIncome.forEach(r => { if ((r.date as string) <= today) r.delayed = true })
    const datedIncome = allDatedIncome.filter(r => !r.delayed)
    // Mirror the income side: a dated bill whose date is today or past, still unpaid, is
    // DELAYED — it stays in the DUE by GZ28 box (under its own DELAYED group, before
    // UNDATED) and keeps counting. Only UPCOMING (future) dated bills go to the flow below.
    const allDatedExpense = expense.filter(r => r.dated && r.date)
    allDatedExpense.forEach(r => { if ((r.date as string) <= today) r.delayed = true })
    const datedExpense = allDatedExpense.filter(r => !r.delayed)
    dueClients -= datedIncome.reduce((x, r) => x + r.amount, 0)
    dueGz += datedExpense.reduce((x, r) => x + r.amount, 0)
    // FLORIDA TAXES move to their own box below — drop them from the DUE by GZ28US total too.
    dueGz += tax.reduce((x, r) => x + r.amount, 0)
    const flowItems: FlowItem[] = [
      ...datedIncome.map(r => ({ date: r.date as string, code: r.code, label: r.label, href: r.href, signed: r.amount, tip: r.tip })),
      ...datedExpense.map(r => ({ date: r.date as string, code: r.code, label: r.label, href: r.href, signed: -r.amount, tip: r.tip })),
    ].sort((a, b) => a.date.localeCompare(b.date))
    setFlow(flowItems)

    setS({
      cashFlow, cashFlowPct: sumExpPaid > 0 ? (cashFlow / sumExpPaid) * 100 : 0,
      dueClients,
      markup, markupPct: sumExpGlobal > 0 ? (markup / sumExpGlobal) * 100 : 0,
      dueGz,
    })
    setRows({ income, expense, tax, loss })
    setLoading(false)
  }

  // Next-6-months series for the chart (current month + 5 ahead): incomes, expenses, balance.
  const flowSeries = (() => {
    const byM = new Map<string, { inc: number; exp: number }>()
    for (const it of flow) { const k = it.date.slice(0, 7); const g = byM.get(k) || { inc: 0, exp: 0 }; if (it.signed >= 0) g.inc += it.signed; else g.exp += -it.signed; byM.set(k, g) }
    const base = new Date()
    const out: { mk: string; inc: number; exp: number; bal: number }[] = []
    for (let i = 0; i < 6; i++) { const d = new Date(base.getFullYear(), base.getMonth() + i, 1); const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; const g = byM.get(mk) || { inc: 0, exp: 0 }; out.push({ mk, inc: g.inc, exp: g.exp, bal: g.inc - g.exp }) }
    return out
  })()

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">FUTURE Flow</h1>
      <p className="text-gray-400 mb-6">Scheduled income &amp; expenses ahead — next months.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <>
          {flow.length > 0 ? (
            <>
              <div className="max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5 mb-4">
                <p className="text-sm font-bold text-gray-400 mb-2">NEXT 6 MONTHS</p>
                <CashFlowChart series={flowSeries} />
              </div>
              <MonthlyFlow flow={flow} />
            </>
          ) : (
            <p className="text-gray-400 text-xl">No scheduled income or expenses ahead.</p>
          )}
        </>
      )}
    </main>
  )
}

function DashCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

function DetailColumn({ label, value, valueColor, rows, undatedColor, taxRows, taxLabel, taxColor }: { label: string; value: string; valueColor: string; rows: Row[]; undatedColor: string; taxRows?: Row[]; taxLabel?: string; taxColor?: string }) {
  const milestoneRows = rows.filter(r => r.milestone)
  const delayed = rows.filter(r => r.delayed)
  const undated = rows.filter(r => !r.dated && !r.milestone)
  // One group per distinct milestone label present, shown just before LOSS with friendly names.
  const milestoneNames: Record<string, string> = { ARRIVAL: 'Goods Arrival', CONCLUSION: 'Project Conclusion' }
  // Chronological: goods arrive before the project is concluded.
  const milestoneOrder = ['ARRIVAL', 'CONCLUSION']
  const milestoneLabels = [...new Set(milestoneRows.map(r => r.milestone!))]
    .sort((a, b) => (milestoneOrder.indexOf(a) + 1 || 99) - (milestoneOrder.indexOf(b) + 1 || 99))
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      {delayed.length > 0 && <RowGroup label="DELAYED" rows={delayed} color="text-red-400" />}
      {undated.length > 0 && <RowGroup label="UNDATED" rows={undated} color={undatedColor} />}
      {milestoneLabels.map(ml => <RowGroup key={ml} label={milestoneNames[ml] || ml} rows={milestoneRows.filter(r => r.milestone === ml)} color="text-cyan-400" />)}
      {taxRows && taxRows.length > 0 && <RowGroup label={taxLabel || 'TAXES'} rows={taxRows} color={taxColor || undatedColor} />}
    </div>
  )
}

function RowGroup({ label, rows, color }: { label: string; rows: Row[]; color: string }) {
  const subtotal = rows.reduce((x, r) => x + r.amount, 0)
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs font-bold text-gray-500 uppercase mb-1 border-b border-gray-700 pb-1">
        <span>{label}</span><span>{formatUSD(subtotal)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600 py-1">—</p>
      ) : rows.map((r, i) => (
        <div key={i} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60">
          <span className="text-gray-300 truncate">
            {r.date ? `${formatShortDate(r.date)} · ` : ''}<a href={r.href} target="_blank" rel="noopener noreferrer" title={r.tip} className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a> · <span title={r.labelTip || undefined}>{r.label}</span>
          </span>
          <span className={`font-bold shrink-0 ${color}`}>{formatUSD(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}

// All DATED income (+) and expenses (−) in one column, grouped by month, with a
// running ("current") balance carried through each month.
// Compact USD for axis labels: $254k, $1.5k, $300, -$2k.
function compactUSD(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return `${v < 0 ? '-' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`
  return `${v < 0 ? '-' : ''}$${a.toFixed(0)}`
}
function niceStep(x: number): number {
  if (x <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const f = x / p
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return n * p
}

// 3-line cashflow chart: RED expenses, BLUE incomes, GREEN balance.
function CashFlowChart({ series }: { series: { mk: string; inc: number; exp: number; bal: number }[] }) {
  const W = 760, H = 300, padR = 14, padT = 30, padB = 56
  const vals = series.flatMap(s => [s.inc, s.exp, s.bal])
  const rawMax = Math.max(1, ...vals), rawMin = Math.min(0, ...vals)
  const step = niceStep((rawMax - rawMin) / 4 || 1)
  const maxV = Math.ceil(rawMax / step) * step
  const minV = Math.floor(rawMin / step) * step
  const padL = 16 + Math.max(compactUSD(maxV).length, compactUSD(minV).length) * 7
  const x0 = padL, x1 = W - padR, yTop = padT, yBot = H - padB
  const xFor = (i: number) => series.length <= 1 ? (x0 + x1) / 2 : x0 + (i / (series.length - 1)) * (x1 - x0)
  const yFor = (v: number) => yBot - ((v - minV) / (maxV - minV || 1)) * (yBot - yTop)
  const line = (k: 'inc' | 'exp' | 'bal') => series.map((s, i) => `${i ? 'L' : 'M'}${xFor(i).toFixed(1)},${yFor(s[k]).toFixed(1)}`).join(' ')
  const ticks: number[] = []
  for (let v = minV; v <= maxV + 0.001; v += step) ticks.push(v)
  const mLabel = (mk: string) => new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <g fontSize="12" fontWeight="bold">
        <rect x={x0} y={4} width="14" height="4" fill="#f87171" /><text x={x0 + 18} y={12} fill="#f87171">EXPENSES</text>
        <rect x={x0 + 104} y={4} width="14" height="4" fill="#60a5fa" /><text x={x0 + 122} y={12} fill="#60a5fa">INCOMES</text>
        <rect x={x0 + 198} y={4} width="14" height="4" fill="#4ade80" /><text x={x0 + 216} y={12} fill="#4ade80">BALANCE</text>
      </g>
      {ticks.map((t, i) => (
        <g key={`t${i}`}>
          <line x1={x0} y1={yFor(t)} x2={x1} y2={yFor(t)} stroke={Math.abs(t) < 0.001 ? '#4b5563' : '#1f2937'} strokeWidth="1" />
          <text x={x0 - 6} y={yFor(t) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{compactUSD(t)}</text>
        </g>
      ))}
      {series.map((s, i) => (
        <g key={`x${i}`}>
          <text x={xFor(i)} y={yBot + 18} textAnchor="middle" fontSize="11" fill="#6b7280">{mLabel(s.mk)}</text>
          <text x={xFor(i)} y={yBot + 33} textAnchor="middle" fontSize="10.5" fontWeight="bold" fill={s.bal >= 0 ? '#60a5fa' : '#f87171'}>{compactUSD(s.bal)}</text>
        </g>
      ))}
      <path d={line('exp')} fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinejoin="round" />
      <path d={line('inc')} fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinejoin="round" />
      <path d={line('bal')} fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinejoin="round" />
      {series.map((s, i) => (
        <g key={`d${i}`}>
          <circle cx={xFor(i)} cy={yFor(s.exp)} r="2.4" fill="#f87171" />
          <circle cx={xFor(i)} cy={yFor(s.inc)} r="2.4" fill="#60a5fa" />
          <circle cx={xFor(i)} cy={yFor(s.bal)} r="2.4" fill="#4ade80" />
        </g>
      ))}
    </svg>
  )
}

function MonthlyFlow({ flow }: { flow: FlowItem[] }) {
  const byMonth = new Map<string, FlowItem[]>()
  for (const it of flow) {
    const k = it.date.slice(0, 7)
    if (!byMonth.has(k)) byMonth.set(k, [])
    byMonth.get(k)!.push(it)
  }
  const monthKeys = [...byMonth.keys()].sort()
  let running = 0
  return (
    <div className="mt-4 max-w-3xl bg-gray-900 border border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-gray-400 mb-1">MONTHLY FLOW · DATED</p>
      {monthKeys.map((k) => {
        const items = byMonth.get(k)!
        running += items.reduce((x, i) => x + i.signed, 0)
        const label = new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1)
          .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        return (
          <div key={k} className="mt-3">
            <div className="flex justify-between text-xs font-bold uppercase mb-1 border-b border-gray-700 pb-1">
              <span className="text-gray-400">{label}</span>
              <span className={running >= 0 ? 'text-green-400' : 'text-red-400'}>Balance {formatUSD(running)}</span>
            </div>
            {items.map((it, i) => (
              <div key={i} className="flex justify-between gap-3 py-1 text-sm border-b border-gray-800/60">
                <span className="text-gray-300 truncate" title={it.tip || undefined}>
                  {formatShortDate(it.date)} · <a href={it.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{it.code}</a> · {it.label}
                </span>
                <span className={`font-bold shrink-0 ${it.signed >= 0 ? 'text-green-400' : 'text-orange-400'}`}>{formatUSD(it.signed)}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
