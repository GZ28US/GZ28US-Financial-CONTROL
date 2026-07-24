'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { carLabel } from '@/lib/carData'

const money = (n: any) => (n == null || n === '' ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

export default function ViewPackPage() {
  const params = useParams()
  const id = String(params.id || '')
  const [pack, setPack] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (id) load(id) }, [id])

  async function load(packId: string) {
    const { data } = await supabase.from('packs').select('*').eq('id', packId).maybeSingle()
    setPack(data || null)
    setLoading(false)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading...</p></main>
  if (!pack) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Pack not found.</p></main>

  const closed = (pack.status || 'DRAFT') === 'CLOSED'
  const cars = Array.isArray(pack.cars) ? pack.cars : []
  // "Importação — ..." lines are the BR freight (PowerTrade) — a BR-only concept.
  // RULE (2026-07-23): the US version of a pack NEVER shows or counts them.
  const IMPORT_RE = /^\s*importa[cç][aã]o\s*[—–-]/i
  const parts = (pack.parts || []).filter((p: any) => !IMPORT_RE.test(p.description || ''))
  const services = pack.services || []
  const expenses = (pack.expenses || []).filter((e: any) => !IMPORT_RE.test(e.item || ''))
  const notes = pack.notes || []

  // Profit dash — same math as the invoice: revenue (parts + FL tax + services −
  // global discount) minus cost (supplier expenses + the FL tax we owe).
  const num = (v: any) => Number(v) || 0
  // CURRENCY RULE: packs authored on the BR app store BRL in amount/unit_price/price
  // and the USD original in *_usd. This app shows USD ONLY — always prefer the _usd
  // field; BRL-only companions (tax/extra/base_cost) scale by the line's own rate.
  const partSell = (p: any) => (p.unit_price_usd != null ? num(p.unit_price_usd) : num(p.unit_price))
  const partRatio = (p: any) => (p.unit_price_usd != null && num(p.unit_price) > 0 ? num(p.unit_price_usd) / num(p.unit_price) : 1)
  const partCost = (p: any) => (p.base_cost != null ? num(p.base_cost) * partRatio(p) : null)
  const expRatio = (e: any) => (e.amount_usd != null && num(e.amount) > 0 ? num(e.amount_usd) / num(e.amount) : 1)
  const expAmount = (e: any) => (e.amount_usd != null ? num(e.amount_usd) : num(e.amount))
  const svcPrice = (sv: any) => (sv.price_usd != null ? num(sv.price_usd) : num(sv.price))
  const partsSubTotal = parts.reduce((s: number, p: any) => s + partSell(p) * num(p.quantity), 0)
  const floridaTaxesAmount = partsSubTotal * (num(pack.florida_taxes) / 100)
  const servicesTotal = services.reduce((s: number, sv: any) => s + svcPrice(sv), 0)
  const partsAndServicesTotal = partsSubTotal + floridaTaxesAmount + servicesTotal
  const grandTotal = partsAndServicesTotal - partsAndServicesTotal * (num(pack.global_discount) / 100)
  const expensesTotalGlobal = floridaTaxesAmount + expenses.reduce((s: number, e: any) => s + expAmount(e) * (num(e.quantity) || 1) + (num(e.tax) + num(e.extra)) * expRatio(e), 0)
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = finalProfit < 0 ? 'text-red-500' : 'text-blue-400'

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-28">
      <Header />

      <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-4xl font-bold">{pack.name || '—'}</h1>
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${closed ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{closed ? 'CLOSED' : 'DRAFT'}</span>
        </div>
        <Link href={`/packs/edit/${pack.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
      </div>
      <p className="text-lg text-gray-400 mb-8">{cars.length ? cars.map(carLabel).filter(Boolean).join('  ·  ') : 'No cars selected'}</p>

      <div className="grid grid-cols-1 gap-6 max-w-4xl">
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
          <h2 className="text-lg font-bold mb-3">TOTALS CONFIG</h2>
          <div className="grid grid-cols-2 gap-3 text-lg text-gray-300">
            <p>Target grand total: <span className="text-white">{money(pack.target_grand_total)}</span></p>
            <p>Florida taxes: <span className="text-white">{pack.florida_taxes ?? '—'}%</span></p>
            <p>Global discount: <span className="text-white">{pack.global_discount ?? '—'}%</span></p>
            <p>Import margin: <span className="text-white">{pack.import_margin ?? 0}%</span></p>
          </div>
        </div>

        {parts.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">PARTS ({parts.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {(() => { const seen = new Set<string>(); return parts.map((p: any, i: number) => {
                if (p.kit_group) {
                  if (seen.has(p.kit_group)) return null
                  seen.add(p.kit_group)
                  const members = parts.filter((x: any) => x.kit_group === p.kit_group)
                  const total = members.reduce((s: number, x: any) => s + partSell(x) * num(x.quantity), 0)
                  return (
                    <div key={i} className="border border-teal-800 rounded-2xl overflow-hidden my-2">
                      <div className="bg-teal-900/40 px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-base font-bold">📦 {p.kit_name || 'Kit'}</span>
                        <span className="font-bold text-white">{money(total)}</span>
                      </div>
                      <div className="pl-5 border-l-2 border-teal-800 ml-3 py-1 space-y-1">
                        {members.map((m: any, j: number) => <p key={j}>{m.quantity}× {m.description} — {money(partSell(m))}{m.base_cost != null ? ` (cost ${money(partCost(m))})` : ''}</p>)}
                      </div>
                    </div>
                  )
                }
                return <p key={i}>{p.quantity}× {p.description} — {money(partSell(p))}{p.base_cost != null ? ` (cost ${money(partCost(p))})` : ''}</p>
              }) })()}
            </div>
          </div>
        )}

        {services.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">SERVICES ({services.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {services.map((s: any, i: number) => <p key={i}>{s.description} — {money(svcPrice(s))}</p>)}
            </div>
          </div>
        )}

        {expenses.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">EXPENSES ({expenses.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {(() => { const seen = new Set<string>(); return expenses.map((e: any, i: number) => {
                if (e.kit_group) {
                  if (seen.has(e.kit_group)) return null
                  seen.add(e.kit_group)
                  const members = expenses.filter((x: any) => x.kit_group === e.kit_group)
                  const total = members.reduce((s: number, x: any) => s + expAmount(x) * (num(x.quantity) || 1) + (num(x.tax) + num(x.extra)) * expRatio(x), 0)
                  return (
                    <div key={i} className="border border-teal-800 rounded-2xl overflow-hidden my-2">
                      <div className="bg-teal-900/40 px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-base font-bold">📦 {e.kit_name || 'Kit'}</span>
                        <span className="font-bold text-white">{money(total)}</span>
                      </div>
                      <div className="pl-5 border-l-2 border-teal-800 ml-3 py-1 space-y-1">
                        {members.map((m: any, j: number) => <p key={j}>{m.quantity}× {m.item}{m.supplier ? ` @ ${m.supplier}` : ''} — {money(expAmount(m))}</p>)}
                      </div>
                    </div>
                  )
                }
                return <p key={i}>{e.quantity}× {e.item}{e.supplier ? ` @ ${e.supplier}` : ''} — {money(expAmount(e))}</p>
              }) })()}
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">NOTES ({notes.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {notes.map((n: any, i: number) => <p key={i}>{n.note}</p>)}
            </div>
          </div>
        )}
      </div>

      {/* PROFIT DASH — fixed footer, always visible */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900 border-t-2 border-gray-700 px-6 py-3 flex items-center justify-between gap-x-8 gap-y-2 flex-wrap">
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">GRAND TOTAL</span><span className="text-xl font-bold">{money(grandTotal)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">COST</span><span className="text-xl font-bold">{money(expensesTotalGlobal)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-sm font-bold text-gray-200">MARKUP</span><span className={`text-2xl font-bold ${profitColor}`}>{money(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
      </div>
    </main>
  )
}
