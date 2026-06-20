'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
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
  receipt_url: string | null
}

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

export default function ViewInputPage() {
  const params = useParams()
  const inputId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState<Input | null>(null)
  const [openReceipts, setOpenReceipts] = useState(false)

  useEffect(() => { loadInput() }, [])

  async function loadInput() {
    // STOCK items live in `inventory` (?src=inventory); consumption in `inputs`.
    const t = new URLSearchParams(window.location.search).get('src') === 'inventory' ? 'inventory' : 'inputs'
    const { data } = await supabase.from(t).select('*').eq('id', inputId).single()
    if (data) setInput(data)
    setLoading(false)
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!input) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Input not found.</p></main>
  )

  const totalCost = input.quantity * input.unit_price
  const receiptUrls = parseReceiptUrls(input.receipt_url)

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-visible'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-4xl font-bold">{input.description}</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${input.category === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`}>
              {input.category}
            </span>
          </div>
        </div>
        <div className="flex gap-3">
          <Link href={input.category === 'STOCK' ? '/inventory' : '/inputs'} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/inputs/edit/${inputId}${input.category === 'STOCK' ? '?src=inventory' : ''}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <div>
          <label className="block mb-3 text-lg font-bold">DETAILS</label>
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>DESCRIPTION</span><span className="font-bold">{input.description}</span></div>
            <div className={rowClass}><span className={labelClass}>CATEGORY</span>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${input.category === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`}>{input.category}</span>
            </div>
            {input.supplier && <div className={rowClass}><span className={labelClass}>SUPPLIER</span><span className="font-bold">{input.supplier}</span></div>}
            <div className={rowClass}><span className={labelClass}>QUANTITY</span><span className="font-bold">{input.quantity}</span></div>
            <div className={rowClass}><span className={labelClass}>UNIT PRICE</span><span className="font-bold">{formatUSD(input.unit_price)}</span></div>
            <div className={rowClass}><span className={labelClass}>TOTAL COST</span><span className="font-bold text-xl">{formatUSD(totalCost)}</span></div>
            <div className={rowClass}><span className={labelClass}>DATE OF PURCHASE</span><span className="font-bold">{formatDate(input.purchase_date)}</span></div>
            {receiptUrls.length > 0 && (
              <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-gray-700">
                <span className={labelClass}>RECEIPT</span>
                <div className="relative">
                  <button onClick={() => setOpenReceipts(!openReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                    RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}
                  </button>
                  {openReceipts && (
                    <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                      {receiptUrls.map((url, ui) => (
                        <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate" title={`File ${ui + 1}`}>File {ui + 1}</a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}