'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { OrderChip, DeliverChip, hasDeliverChip, type DeliverRow } from '@/components/DeliverChip'

// Read-only VIEW of a whole input PURCHASE (every row sharing a purchase_group):
// supplier, category, date, all line items, grand total and receipts. Linked from
// the VIEW button on the group header in InputsManager. STOCK purchases live in the
// `inventory` table (?src=inventory); CONSUMPTION in `inputs`.
type Input = DeliverRow & {
  id: string
  description: string
  category: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  receipt_url: string | null
  notes: string | null
  // ORDER NUMBER é SAGRADO (29/ago/2026): pedido da compra. O rastreio mora na
  // MESMA linha (deliver_status/tracking_number/... via DeliverRow), não mais em
  // part_streams. Numa linha DONATED do inventory o campo order_number é a
  // invoice doadora — origem, não pedido — e fica fora do chip.
  order_number?: string | null
  source_type?: string | null
  // Já existe nas duas tabelas e já vem no select('*'): é o degrau "PAGOU?" da
  // cascata do status (29/ago/2026).
  payment_date?: string | null
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

export default function ViewInputGroupPage() {
  const params = useParams()
  const groupId = String(params.groupId)

  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<Input[]>([])
  const [openReceipts, setOpenReceipts] = useState(false)

  const isStock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('src') === 'inventory'
  const srcQ = isStock ? '?src=inventory' : ''

  useEffect(() => { load() }, [])
  async function load() {
    const t = new URLSearchParams(window.location.search).get('src') === 'inventory' ? 'inventory' : 'inputs'
    const { data } = await supabase.from(t).select('*').eq('purchase_group', groupId).order('created_at', { ascending: true })
    setItems(data || [])
    setLoading(false)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (items.length === 0) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Purchase not found.</p></main>

  const first = items[0]
  const grandTotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0)
  const receiptUrls = Array.from(new Set(items.flatMap(i => parseReceiptUrls(i.receipt_url))))
  // LEI (Márcio, 29/ago/2026): "os badges de order number, tracking ou
  // BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das compras,
  // MESMO QUE SEJA REPETIDO EM TODOS." O molde commonOf morreu: a seção PURCHASE
  // não carrega mais ORDER NUMBER/STREAM — os chips vivem na linha de CADA item.
  const catBadge = (c: string) => `px-3 py-1 rounded-full text-sm font-bold ${c === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-visible'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-bold">{first.supplier || '—'}</h1>
          <span className={catBadge(first.category)}>{first.category}</span>
        </div>
        <Link href={isStock ? '/inventory' : '/supplies'} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <div>
          <label className="block mb-3 text-lg font-bold">PURCHASE</label>
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>SUPPLIER</span><span className="font-bold">{first.supplier || '—'}</span></div>
            <div className={rowClass}><span className={labelClass}>CATEGORY</span><span className={catBadge(first.category)}>{first.category}</span></div>
            <div className={rowClass}><span className={labelClass}>DATE</span><span className="font-bold">{formatDate(first.purchase_date)}</span></div>
            <div className={rowClass}><span className={labelClass}>ITEMS</span><span className="font-bold">{items.length}</span></div>
            <div className={rowClass}><span className={labelClass}>GRAND TOTAL</span><span className="font-bold text-xl">{formatUSD(grandTotal)}</span></div>
            {receiptUrls.length > 0 && (
              <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-gray-700">
                <span className={labelClass}>RECEIPTS</span>
                <div className="relative">
                  <button onClick={() => setOpenReceipts(!openReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}</button>
                  {openReceipts && (
                    <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                      {receiptUrls.map((url, ui) => (<a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate" title={`File ${ui + 1}`}>File {ui + 1}</a>))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="block mb-3 text-lg font-bold">ITEMS ({items.length})</label>
          <div className={sectionClass}>
            {items.map(it => (
              <div key={it.id} className="px-4 py-3 border-b border-gray-700 last:border-0">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-bold truncate" title={it.description}>{it.description}</p>
                    <p className="text-sm text-gray-400">Qty: {it.quantity} × {formatUSD(it.unit_price)} = {formatUSD((Number(it.quantity) || 0) * (Number(it.unit_price) || 0))}</p>
                    {/* LEI 29/ago/2026: chip do pedido + DELIVER STATUS SEMPRE na linha
                        do item — mesmo repetidos em todos, e nunca no cabeçalho da
                        compra. Os dois vêm do select('*') desta mesma tela: acabou o
                        join. DONATED fica sem chip (não foi comprada). */}
                    {(it.source_type || '') !== 'DONATED' && (!!String(it.order_number || '').trim() || hasDeliverChip(it)) && (
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {String(it.order_number || '').trim() ? <OrderChip order={String(it.order_number || '').trim()} /> : null}
                        <DeliverChip row={it} />
                      </div>
                    )}
                    {it.notes && <p className="text-sm text-gray-500 mt-0.5">{it.notes}</p>}
                  </div>
                  <Link href={`/supplies/${it.id}${srcQ}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm shrink-0">VIEW</Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
