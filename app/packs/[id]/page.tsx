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
  const parts = pack.parts || []
  const services = pack.services || []
  const expenses = pack.expenses || []
  const notes = pack.notes || []

  // Profit dash — same math as the invoice: revenue (parts + FL tax + services −
  // global discount) minus cost (supplier expenses + the FL tax we owe).
  const num = (v: any) => Number(v) || 0
  const partsSubTotal = parts.reduce((s: number, p: any) => s + num(p.unit_price) * num(p.quantity), 0)
  const floridaTaxesAmount = partsSubTotal * (num(pack.florida_taxes) / 100)
  const servicesTotal = services.reduce((s: number, sv: any) => s + num(sv.price), 0)
  const partsAndServicesTotal = partsSubTotal + floridaTaxesAmount + servicesTotal
  const grandTotal = partsAndServicesTotal - partsAndServicesTotal * (num(pack.global_discount) / 100)
  const expensesTotalGlobal = floridaTaxesAmount + expenses.reduce((s: number, e: any) => s + num(e.amount) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra), 0)
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
              {parts.map((p: any, i: number) => (
                <p key={i}>{p.quantity}× {p.description} — {money(p.unit_price)}{p.base_cost != null ? ` (cost ${money(p.base_cost)})` : ''}</p>
              ))}
            </div>
          </div>
        )}

        {services.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">SERVICES ({services.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {services.map((s: any, i: number) => <p key={i}>{s.description} — {money(s.price)}</p>)}
            </div>
          </div>
        )}

        {expenses.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">EXPENSES ({expenses.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {expenses.map((e: any, i: number) => <p key={i}>{e.quantity}× {e.item}{e.supplier ? ` @ ${e.supplier}` : ''} — {money(e.amount)}</p>)}
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
        <div className="flex items-baseline gap-2"><span className="text-sm font-bold text-gray-200">PROFIT</span><span className={`text-2xl font-bold ${profitColor}`}>{money(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
      </div>
    </main>
  )
}
