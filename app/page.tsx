'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

type GlobalStats = { cashFlow: number; cashFlowPct: number; dueClients: number; markup: number; markupPct: number; dueGz: number }

export default function HomePage() {
  const [s, setS] = useState<GlobalStats>({ cashFlow: 0, cashFlowPct: 0, dueClients: 0, markup: 0, markupPct: 0, dueGz: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    // EVERYTHING, all time — every real (non-quote) invoice and its children.
    const [{ data: invs }, { data: pays }, { data: exps }, { data: parts }] = await Promise.all([
      supabase.from('invoices').select('id, invoice_code, florida_taxes, fl_tax_expense_date').eq('is_quote', false).in('live_status', ['REALTIME', 'CLOSED']),
      supabase.from('invoice_payments').select('invoice_id, amount, paid_at'),
      supabase.from('invoice_expenses').select('invoice_id, price, quantity, payment_date, tax, extra'),
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

    const group = <T extends { invoice_id: string }>(rows: T[] | null) => {
      const m = new Map<string, T[]>()
      for (const r of rows || []) { const a = m.get(r.invoice_id) || []; a.push(r); m.set(r.invoice_id, a) }
      return m
    }
    const paysBy = group(pays), expsBy = group(exps), partsBy = group(parts)
    const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)

    let cashFlow = 0, dueClients = 0, markup = 0, dueGz = 0, sumExpPaid = 0, sumExpGlobal = 0
    for (const inv of invs || []) {
      const ip = paysBy.get(inv.id) || []
      const ie = expsBy.get(inv.id) || []
      const ipa = partsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((x: number, p: any) => x + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
      const ss = stockByCode.get(inv.invoice_code) || { all: 0, paid: 0 }
      const totalPaid = ip.filter((p: any) => !!p.paid_at).reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0) + ss.paid
      const totalIncomeAll = ip.reduce((x: number, p: any) => x + (parseFloat(p.amount) || 0), 0) + ss.all
      const expensesTotalGlobal = flTaxAmount + ie.reduce((x: number, e: any) => x + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + ie.filter((e: any) => isValidDate(e.payment_date)).reduce((x: number, e: any) => x + expenseLine(e), 0)
      cashFlow += totalPaid - expensesTotalPaid
      dueClients += totalIncomeAll - totalPaid
      markup += totalIncomeAll - expensesTotalGlobal
      dueGz += expensesTotalPaid - expensesTotalGlobal
      sumExpPaid += expensesTotalPaid
      sumExpGlobal += expensesTotalGlobal
    }

    setS({
      cashFlow, cashFlowPct: sumExpPaid > 0 ? (cashFlow / sumExpPaid) * 100 : 0,
      dueClients,
      markup, markupPct: sumExpGlobal > 0 ? (markup / sumExpGlobal) * 100 : 0,
      dueGz,
    })
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">ALL HISTORY — GLOBAL</h1>
      <p className="text-gray-400 mb-6">Everything, all time — no filters.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
          <DashCard label="CURRENT CASH FLOW" value={`${formatUSD(s.cashFlow)} / ${s.cashFlowPct.toFixed(1)}%`} color={s.cashFlow < 0 ? 'text-red-500' : 'text-blue-400'} />
          <DashCard label="DUE by CLIENTS" value={formatUSD(s.dueClients)} color={s.dueClients > 0 ? 'text-red-400' : 'text-gray-300'} />
          <DashCard label="FINAL MARKUP" value={`${formatUSD(s.markup)} / ${s.markupPct.toFixed(1)}%`} color={s.markup < 0 ? 'text-red-500' : 'text-blue-400'} />
          <DashCard label="DUE by GZ28US" value={formatUSD(s.dueGz)} color={s.dueGz < 0 ? 'text-red-400' : 'text-gray-300'} />
        </div>
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
