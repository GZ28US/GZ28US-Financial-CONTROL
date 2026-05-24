'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Input = {
  id: string
  description: string
  category: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
}

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function InputsPage() {
  const [inputs, setInputs] = useState<Input[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'ALL' | 'CONSUMPTION' | 'STOCK'>('ALL')

  useEffect(() => { loadInputs() }, [])

  async function loadInputs() {
    const { data, error } = await supabase.from('inputs').select('*').order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }
    setInputs(data || [])
    setLoading(false)
  }

  async function removeInput(id: string) {
    const { error } = await supabase.from('inputs').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadInputs()
  }

  const filtered = filter === 'ALL' ? inputs : inputs.filter(i => i.category === filter)
  const consumptionTotal = inputs.filter(i => i.category === 'CONSUMPTION').reduce((s, i) => s + i.quantity * i.unit_price, 0)
  const stockTotal = inputs.filter(i => i.category === 'STOCK').reduce((s, i) => s + i.quantity * i.unit_price, 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Input</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this input? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeInput(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-4xl font-bold">INPUTS ({inputs.length})</h1>
        <Link href="/inputs/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW INPUT</Link>
      </div>

      {/* TOTALS */}
      {inputs.length > 0 && (
        <div className="flex gap-4 mb-6 flex-wrap">
          <div className="bg-blue-900 rounded-2xl px-6 py-4">
            <p className="text-sm font-bold text-blue-300">CONSUMPTION TOTAL</p>
            <p className="text-2xl font-bold">{formatUSD(consumptionTotal)}</p>
          </div>
          <div className="bg-green-900 rounded-2xl px-6 py-4">
            <p className="text-sm font-bold text-green-300">STOCK TOTAL</p>
            <p className="text-2xl font-bold">{formatUSD(stockTotal)}</p>
          </div>
        </div>
      )}

      {/* FILTER */}
      <div className="flex gap-3 mb-8">
        {(['ALL', 'CONSUMPTION', 'STOCK'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`px-5 py-2 rounded-2xl font-bold text-lg ${filter === f ? 'bg-white text-black' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>{f}</button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No inputs found.</p>
      ) : (
        <div className="space-y-5">
          {filtered.map((input) => (
            <div key={input.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold">{input.description}</h2>
                  <span className={`px-3 py-1 rounded-full text-sm font-bold ${input.category === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`}>
                    {input.category}
                  </span>
                </div>
                {input.supplier && <p className="text-lg text-gray-400">Supplier: {input.supplier}</p>}
                <p className="text-lg text-gray-400">Qty: {input.quantity} × {formatUSD(input.unit_price)} = {formatUSD(input.quantity * input.unit_price)}</p>
                <p className="text-lg text-gray-400">Purchased: {formatDate(input.purchase_date)}</p>
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/inputs/${input.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                <Link href={`/inputs/edit/${input.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(input.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}