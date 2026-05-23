'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Good = {
  id: string
  description: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  created_at: string
}

type GoodWithStats = Good & {
  expensesTotal: number
}

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function GoodsPage() {
  const [goods, setGoods] = useState<GoodWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { loadGoods() }, [])

  async function loadGoods() {
    const { data, error } = await supabase.from('goods').select('*').order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }

    const goodsWithStats = await Promise.all((data || []).map(async (good) => {
      const { data: expenses } = await supabase.from('good_expenses').select('amount').eq('good_id', good.id)
      const expensesTotal = (expenses || []).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
      return { ...good, expensesTotal }
    }))

    setGoods(goodsWithStats)
    setLoading(false)
  }

  async function removeGood(id: string) {
    const { error } = await supabase.from('goods').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadGoods()
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Good</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this good? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeGood(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">GOODS ({goods.length})</h1>
        <Link href="/goods/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW GOOD</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : goods.length === 0 ? (
        <p className="text-2xl text-gray-400">No goods found.</p>
      ) : (
        <div className="space-y-5">
          {goods.map((good) => (
            <div key={good.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-bold mb-1">{good.description}</h2>
                <p className="text-lg text-gray-400">Qty: {good.quantity} × {formatUSD(good.unit_price)} = {formatUSD(good.quantity * good.unit_price)}</p>
                <p className="text-lg text-gray-400">Purchased: {formatDate(good.purchase_date)}</p>
                {good.expensesTotal > 0 && (
                  <p className="text-lg text-gray-400">Expenses: {formatUSD(good.expensesTotal)}</p>
                )}
                <p className="text-lg font-bold mt-1">Total Cost: {formatUSD(good.quantity * good.unit_price + good.expensesTotal)}</p>
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/goods/${good.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                <Link href={`/goods/edit/${good.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(good.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}