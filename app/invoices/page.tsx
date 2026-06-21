'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DocPicker from '@/components/DocPicker'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null) {
  if (!isValidDate(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

type Stats = {
  paymentsBalance: number; expensesBalance: number
  currentProfit: number; currentProfitPct: number
  finalProfit: number; finalProfitPct: number
  expensesTotalPaid: number; expensesTotalGlobal: number
}

function getStatusBadge(inv: any) {
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)
  if (inv.is_quote) return { label: 'QUOTE', cls: 'bg-amber-600 text-black' }
  if (!valid(inv.entry_date)) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  if (!valid(inv.conclusion_date)) return { label: 'ON DUTY', cls: 'bg-blue-800 text-blue-200' }
  if (!valid(inv.delivery_date)) return { label: 'DONE', cls: 'bg-green-800 text-green-300' }
  return { label: 'DELIVERED', cls: 'bg-white text-black' }
}
function getLiveBadge(s: string | null) {
  if (s === 'CLOSED') return { label: 'CLOSED', cls: 'bg-green-700 text-white' }
  if (s === 'REALTIME') return { label: 'ONLINE', cls: 'bg-blue-800 text-blue-200' }
  return { label: 'INCOMPLETE', cls: 'bg-gray-700 text-gray-300' }
}
function getFeedBadge(live: string | null) {
  const ready = live === 'REALTIME' || live === 'CLOSED'
  return ready ? { label: 'REPORT READY', cls: 'bg-green-800 text-green-300' } : null
}

// Global list of every PROJECT (real, non-quote) ride invoice, newest saved first.
export default function InvoicesPage() {
  const [rows, setRows] = useState<any[]>([])
  const [stats, setStats] = useState<Record<string, Stats>>({})
  const [loading, setLoading] = useState(true)
  const [liveFilter, setLiveFilter] = useState<'ALL' | 'INCOMPLETE' | 'REALTIME' | 'CLOSED'>('ALL')
  const [reportFilter, setReportFilter] = useState<'ALL' | 'READY' | 'NOT'>('ALL')
  const [picker, setPicker] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_code, ride_id, is_quote, hiring_date, entry_date, conclusion_date, delivery_date, mileage, service, florida_taxes, global_discount, fl_tax_expense_date, feed_status, live_status, created_at, updated_at, rides(project_code, project_name)')
      .eq('is_quote', false)
      .not('ride_id', 'is', null)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    const list = data || []
    setRows(list)

    // Stock-sale income per donor invoice (a donated part another car pulled from stock).
    const stockByCode = new Map<string, { all: number; paid: number }>()
    const [{ data: donInv }, { data: pulls }] = await Promise.all([
      supabase.from('inventory').select('description, donor, notes').eq('category', 'STOCK').eq('source_type', 'DONATED'),
      supabase.from('invoice_expenses').select('item, stock_donor, payment_date, price, quantity').not('stock_donor', 'is', null),
    ])
    const donorCodeByKey = new Map<string, string>()
    ;(donInv || []).forEach((r: any) => { const m = (r.notes || '').match(/^From\s+(\S+)\s+—/); if (m) donorCodeByKey.set(`${(r.donor || '').trim().toLowerCase()}|${(r.description || '').trim().toLowerCase()}`, m[1]) })
    ;(pulls || []).forEach((e: any) => {
      const code = donorCodeByKey.get(`${(e.stock_donor || '').trim().toLowerCase()}|${(e.item || '').trim().toLowerCase()}`)
      if (!code) return
      const amt = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1)
      const cur = stockByCode.get(code) || { all: 0, paid: 0 }
      cur.all += amt; if (isValidDate(e.payment_date)) cur.paid += amt
      stockByCode.set(code, cur)
    })

    // Bulk-load the children for every listed invoice (one query each, grouped in memory).
    const ids = list.map((i: any) => i.id)
    const group = <T extends { invoice_id: string }>(rs: T[] | null) => {
      const mm = new Map<string, T[]>()
      for (const r of rs || []) { const a = mm.get(r.invoice_id) || []; a.push(r); mm.set(r.invoice_id, a) }
      return mm
    }
    let paysBy = new Map<string, any[]>(), expsBy = new Map<string, any[]>(), partsBy = new Map<string, any[]>(), svcsBy = new Map<string, any[]>()
    if (ids.length) {
      const [pRes, eRes, prRes, sRes] = await Promise.all([
        supabase.from('invoice_payments').select('invoice_id, amount, paid_at').in('invoice_id', ids),
        supabase.from('invoice_expenses').select('invoice_id, price, quantity, payment_date, tax, extra').in('invoice_id', ids),
        supabase.from('invoice_parts').select('invoice_id, unit_price, quantity').in('invoice_id', ids),
        supabase.from('invoice_services').select('invoice_id, price').in('invoice_id', ids),
      ])
      paysBy = group(pRes.data); expsBy = group(eRes.data); partsBy = group(prRes.data); svcsBy = group(sRes.data)
    }
    const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)

    const statsMap: Record<string, Stats> = {}
    for (const inv of list) {
      const ip = paysBy.get(inv.id) || []
      const ie = expsBy.get(inv.id) || []
      const ipa = partsBy.get(inv.id) || []
      const isv = svcsBy.get(inv.id) || []
      const partsSubTotal = ipa.reduce((s: number, p: any) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
      const flTaxAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
      const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
      const ss = stockByCode.get(inv.invoice_code) || { all: 0, paid: 0 }
      const totalPaid = ip.filter((p: any) => !!p.paid_at).reduce((s: number, p: any) => s + (parseFloat(p.amount) || 0), 0) + ss.paid
      const totalIncomeAll = ip.reduce((s: number, p: any) => s + (parseFloat(p.amount) || 0), 0) + ss.all
      const expensesTotalGlobal = flTaxAmount + ie.reduce((s: number, e: any) => s + expenseLine(e), 0)
      const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + ie.filter((e: any) => isValidDate(e.payment_date)).reduce((s: number, e: any) => s + expenseLine(e), 0)
      const currentProfit = totalPaid - expensesTotalPaid
      const finalProfit = totalIncomeAll - expensesTotalGlobal
      statsMap[inv.id] = {
        paymentsBalance: totalIncomeAll - totalPaid,
        expensesBalance: expensesTotalPaid - expensesTotalGlobal,
        currentProfit,
        currentProfitPct: expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0,
        finalProfit,
        finalProfitPct: expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0,
        expensesTotalPaid, expensesTotalGlobal,
      }
    }
    setStats(statsMap)
    setLoading(false)
  }

  async function removeInvoice(id: string) {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  // Primary filter by live_status; secondary REPORT READY filter only shows when the
  // current selection actually contains both ready and not-ready invoices.
  const isRdy = (r: any) => r.live_status === 'REALTIME' || r.live_status === 'CLOSED'
  const liveFiltered = rows.filter(r => liveFilter === 'ALL' || (r.live_status || 'INCOMPLETE') === liveFilter)
  const hasReady = liveFiltered.some(isRdy)
  const hasNotReady = liveFiltered.some(r => !isRdy(r))
  const showReportFilter = liveFilter !== 'INCOMPLETE' && hasReady && hasNotReady
  const filtered = liveFiltered.filter(r => !showReportFilter || reportFilter === 'ALL'
    || (reportFilter === 'READY' ? isRdy(r) : !isRdy(r)))

  // Consolidated dash — REPORT-READY invoices only, across the current view.
  const agg = filtered.filter(isRdy).reduce((a, inv) => {
    const s = stats[inv.id]; if (!s) return a
    return {
      currentProfit: a.currentProfit + s.currentProfit,
      finalProfit: a.finalProfit + s.finalProfit,
      paymentsBalance: a.paymentsBalance + s.paymentsBalance,
      expensesBalance: a.expensesBalance + s.expensesBalance,
      sumExpPaid: a.sumExpPaid + s.expensesTotalPaid,
      sumExpGlobal: a.sumExpGlobal + s.expensesTotalGlobal,
    }
  }, { currentProfit: 0, finalProfit: 0, paymentsBalance: 0, expensesBalance: 0, sumExpPaid: 0, sumExpGlobal: 0 })
  const aggCurrentPct = agg.sumExpPaid > 0 ? (agg.currentProfit / agg.sumExpPaid) * 100 : 0
  const aggFinalPct = agg.sumExpGlobal > 0 ? (agg.finalProfit / agg.sumExpGlobal) * 100 : 0
  const readyCount = filtered.filter(isRdy).length

  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Invoice</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this invoice? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeInvoice(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-4 mb-8 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">INVOICES ({filtered.length})</h1>
          <div className="flex gap-2 flex-wrap">
            {(['ALL', 'INCOMPLETE', 'REALTIME', 'CLOSED'] as const).map((f) => (
              <button key={f} onClick={() => setLiveFilter(f)} className={chip(liveFilter === f)}>{f === 'REALTIME' ? 'ONLINE' : f}</button>
            ))}
          </div>
          {showReportFilter && (
            <div className="flex gap-2 flex-wrap border-l border-gray-700 pl-4">
              {(['ALL', 'READY', 'NOT'] as const).map((f) => (
                <button key={f} onClick={() => setReportFilter(f)} className={chip(reportFilter === f)}>{f === 'READY' ? 'REPORT READY' : f === 'NOT' ? 'REPORT NOT READY' : 'ALL'}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setPicker(true)} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW INVOICE</button>
      </div>
      {picker && <DocPicker type="invoice" onClose={() => setPicker(false)} />}

      {!loading && readyCount > 0 && (
        <div className="bg-gray-900 border border-gray-700 rounded-3xl p-5 mb-6">
          <p className="text-sm font-bold text-gray-400 mb-2">CONSOLIDATED — REPORT-READY ONLY ({readyCount})</p>
          <div className="flex gap-3 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>CURRENT CASH FLOW: {formatUSD(agg.currentProfit)} / {aggCurrentPct.toFixed(1)}%</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by CLIENTS: {formatUSD(agg.paymentsBalance)}</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>FINAL MARKUP: {formatUSD(agg.finalProfit)} / {aggFinalPct.toFixed(1)}%</span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by GZ28US: {formatUSD(agg.expensesBalance)}</span>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No invoices yet.</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((inv) => {
            const statusBadge = getStatusBadge(inv)
            const liveBadge = getLiveBadge(inv.live_status)
            const feedBadge = getFeedBadge(inv.live_status)
            const ride = Array.isArray(inv.rides) ? inv.rides[0] : inv.rides
            const s = stats[inv.id]
            return (
              <div key={inv.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{inv.invoice_code}</h2>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${statusBadge.cls}`}>{statusBadge.label}</span>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${liveBadge.cls}`}>{liveBadge.label}</span>
                    {feedBadge && <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>}
                  </div>
                  <p className="text-lg text-gray-400">{[ride?.project_code, ride?.project_name].filter(Boolean).join(' — ') || '—'}</p>
                  <p className="text-lg text-gray-400">Hiring: {fmtDate(inv.hiring_date)}{inv.delivery_date ? ` — Delivery: ${fmtDate(inv.delivery_date)}` : ''}</p>

                  {s && isRdy(inv) && (
                    <div className="flex gap-3 mt-3 flex-wrap">
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>CURRENT CASH FLOW: {formatUSD(s.currentProfit)} / {s.currentProfitPct.toFixed(1)}%</span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by CLIENTS: {formatUSD(s.paymentsBalance)}</span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>FINAL MARKUP: {formatUSD(s.finalProfit)} / {s.finalProfitPct.toFixed(1)}%</span>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${s.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>DUE by GZ28US: {formatUSD(s.expensesBalance)}</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <Link href={`/rides/${inv.ride_id}/invoices/${inv.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/rides/${inv.ride_id}/invoices/edit/${inv.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(inv.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
