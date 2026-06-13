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

  return (
    <main className="min-h-screen bg-black text-white p-8">
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
    </main>
  )
}
