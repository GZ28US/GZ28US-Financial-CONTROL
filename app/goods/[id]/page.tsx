'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Good = {
  id: string
  description: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  receipt_url: string | null
}

type Expense = {
  id: string
  description: string
  amount: number
  expense_date: string | null
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

export default function ViewGoodPage() {
  const params = useParams()
  const goodId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [good, setGood] = useState<Good | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [openGoodReceipts, setOpenGoodReceipts] = useState(false)
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const { data } = await supabase.from('goods').select('*').eq('id', goodId).single()
    if (data) setGood(data)
    const { data: expensesData } = await supabase.from('good_expenses').select('*').eq('good_id', goodId).order('created_at', { ascending: true })
    if (expensesData) setExpenses(expensesData)
    setLoading(false)
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!good) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Good not found.</p></main>
  )

  const totalCost = good.quantity * good.unit_price
  const expensesTotal = expenses.reduce((s, e) => s + e.amount, 0)
  const grandTotal = totalCost + expensesTotal
  const goodReceiptUrls = parseReceiptUrls(good.receipt_url)

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-visible'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">{good.description}</h1>
        <div className="flex gap-3">
          <Link href="/goods" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/goods/edit/${goodId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* DETAILS */}
        <div>
          <label className="block mb-3 text-lg font-bold">DETAILS</label>
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>DESCRIPTION</span><span className="font-bold">{good.description}</span></div>
            {good.supplier && <div className={rowClass}><span className={labelClass}>SUPPLIER</span><span className="font-bold">{good.supplier}</span></div>}
            <div className={rowClass}><span className={labelClass}>QUANTITY</span><span className="font-bold">{good.quantity}</span></div>
            <div className={rowClass}><span className={labelClass}>UNIT PRICE</span><span className="font-bold">{formatUSD(good.unit_price)}</span></div>
            <div className={rowClass}><span className={labelClass}>TOTAL COST</span><span className="font-bold">{formatUSD(totalCost)}</span></div>
            <div className={rowClass}><span className={labelClass}>DATE OF PURCHASE</span><span className="font-bold">{formatDate(good.purchase_date)}</span></div>
            {goodReceiptUrls.length > 0 && (
              <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-gray-700">
                <span className={labelClass}>RECEIPT</span>
                <div className="relative">
                  <button onClick={() => setOpenGoodReceipts(!openGoodReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                    RECEIPTS{goodReceiptUrls.length > 1 ? ` (${goodReceiptUrls.length})` : ''}
                  </button>
                  {openGoodReceipts && (
                    <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                      {goodReceiptUrls.map((url, ui) => (
                        <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* EXPENSES */}
        {expenses.length > 0 && (
          <div>
            <label className="block mb-3 text-lg font-bold">EXPENSES</label>
            <div className={sectionClass}>
              {expenses.map((exp, index) => {
                const expReceiptUrls = parseReceiptUrls(exp.receipt_url)
                return (
                  <div key={exp.id} className={`px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-bold truncate">{exp.description}</p>
                        {exp.supplier && <p className="text-sm text-gray-400">{exp.supplier}</p>}
                        <p className="text-sm text-gray-400">{formatDate(exp.expense_date)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-bold">{formatUSD(exp.amount)}</span>
                        {expReceiptUrls.length > 0 && (
                          <div className="relative">
                            <button onClick={() => setOpenReceiptsIndex(openReceiptsIndex === index ? null : index)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                              RECEIPTS{expReceiptUrls.length > 1 ? ` (${expReceiptUrls.length})` : ''}
                            </button>
                            {openReceiptsIndex === index && (
                              <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                                {expReceiptUrls.map((url, ui) => (
                                  <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div className="px-4 py-3 flex justify-between border-t border-gray-700">
                <span className={labelClass}>EXPENSES TOTAL</span>
                <span className="font-bold">{formatUSD(expensesTotal)}</span>
              </div>
            </div>
          </div>
        )}

        {/* GRAND TOTAL */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4">
          <div className="flex justify-between items-center">
            <span className="font-bold text-xl">GRAND TOTAL</span>
            <span className="text-3xl font-bold">{formatUSD(grandTotal)}</span>
          </div>
        </div>

      </div>
    </main>
  )
}