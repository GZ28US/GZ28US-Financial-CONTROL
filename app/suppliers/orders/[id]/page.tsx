'use client'

// SUPPLIER ORDERS — registry-only listing (Márcio, 03/ago/2026).
// Every order ever placed with this supplier lives here for record/audit:
// order number, date, US/BR (BR = shipped to PowerTrade), totals and payments
// (cash or store credit). These amounts DO NOT feed reports — the same money
// is already accounted on invoices/expenses; this page is the paper trail.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Order = {
  id: string
  order_number: string | null
  order_date: string | null
  region: string | null
  ship_to: string | null
  description: string | null
  total: number | null
  paid_total: number | null
  payment_status: string | null
  payments: { date?: string; amount?: number; method?: string; ref?: string }[] | null
  car_label: string | null
  source: string | null
  receipt_url: string | null
  notes: string | null
}

const usd = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const statusBadge = (s: string | null) => (
  s === 'PAID' ? 'bg-green-800 text-green-200'
  : s === 'CREDIT' ? 'bg-cyan-900 text-cyan-200'
  : s === 'PARTIAL' ? 'bg-amber-900 text-amber-200'
  : s === 'REFUNDED' || s === 'CANCELLED' ? 'bg-gray-700 text-gray-300'
  : 'bg-red-900 text-red-200')

export default function SupplierOrdersPage() {
  const params = useParams()
  const supplierId = String(params.id)
  const [supplierName, setSupplierName] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [region, setRegion] = useState<'ALL' | 'US' | 'BR'>('ALL')
  const [search, setSearch] = useState('')

  useEffect(() => {
    void (async () => {
      const { data: sup } = await supabase.from('suppliers').select('name').eq('id', supplierId).maybeSingle()
      const name = sup?.name || ''
      setSupplierName(name)
      // Rows are keyed by supplier_id when known, with a name fallback so
      // registry rows inserted before the link still show up.
      const { data } = await supabase
        .from('supplier_orders')
        .select('*')
        .or(`supplier_id.eq.${supplierId}${name ? `,supplier_name.ilike.${name}` : ''}`)
        .order('order_date', { ascending: false, nullsFirst: false })
      setOrders((data || []) as Order[])
      setLoading(false)
    })()
  }, [supplierId])

  // Store-credit account: payment entries with method CREDIT+ add to the credit
  // balance, CREDIT- consume it. Running balance accumulates chronologically over
  // ALL orders — region/search filters never change the account.
  const creditOf = (o: Order) => {
    let gen = 0, used = 0
    for (const p of o.payments || []) {
      if (p.method === 'CREDIT+') gen += Number(p.amount) || 0
      else if (p.method === 'CREDIT-') used += Number(p.amount) || 0
    }
    return { gen, used }
  }
  // Effective date: the CREDIT event's own date (a credit can be applied long
  // after the order was placed), falling back to the order date.
  const creditDate = (o: Order) => {
    let d: string | null = null
    for (const p of o.payments || []) {
      if ((p.method === 'CREDIT+' || p.method === 'CREDIT-') && p.date && (!d || p.date < d)) d = p.date
    }
    return d || o.order_date || ''
  }

  // ── "PAGOU?" NESTE REGISTRO (cascata de 29/ago/2026) ──────────────────────
  // A lei do dono começa a cascata no pagamento: "PAGOU? Bought / TEM RASTREIO?
  // Shipped / ENTREGOU? Delivered". Só que aqui a linha não é um ITEM de compra
  // com payment_date — é o PEDIDO inteiro, e supplier_orders não tem essa
  // coluna. O que esta tela já sabe sobre pagamento é o que ela mesma mostra no
  // topo e no badge: paid_total (TOTAL PAID), payment_status e o registro de
  // `payments` — onde CREDIT- é o pedido abatido do crédito de loja, que é
  // pagamento tanto quanto dinheiro. Nada de campo novo: só o que já existe.
  const paidOf = (o: Order) =>
    (Number(o.paid_total) || 0) > 0 ||
    /^(PAID|CREDIT|PARTIAL)/.test(String(o.payment_status || '').toUpperCase()) ||
    (o.payments || []).some(p => (Number(p.amount) || 0) > 0 || p.method === 'CREDIT-')

  // Listing date rule (Márcio): an order enters the list on its order date;
  // once paid (money or credit), its date becomes the payment date.
  const effectiveDate = (o: Order) => {
    let d: string | null = null
    for (const p of o.payments || []) {
      if (p.date && (!d || p.date > d)) d = p.date
    }
    return d || o.order_date || ''
  }

  const q = search.trim().toLowerCase()
  // Newest → oldest by effective date; dateless rows sink to the end.
  const visible = orders.filter(o =>
    (region === 'ALL' || o.region === region) &&
    (!q || [o.order_number, o.description, o.car_label, o.notes, o.ship_to].some(v => String(v || '').toLowerCase().includes(q))))
    .sort((a, b) => effectiveDate(b).localeCompare(effectiveDate(a)))
  const creditBal: Record<string, number> = {}
  let creditNow = 0
  for (const o of [...orders].sort((a, b) =>
      creditDate(a).localeCompare(creditDate(b)) ||
      (creditOf(b).gen - creditOf(a).gen))) {
    const c = creditOf(o)
    creditNow += c.gen - c.used
    creditBal[o.id] = Math.round(creditNow * 100) / 100
  }

  const sum = (rows: Order[], f: (o: Order) => number) => rows.reduce((s, o) => s + f(o), 0)
  const active = visible.filter(o => o.payment_status !== 'CANCELLED' && o.payment_status !== 'REFUNDED')
  const totalOrdered = sum(active, o => Number(o.total) || 0)
  const totalPaid = sum(active, o => Number(o.paid_total) || 0)
  const chip = (on: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${on ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center gap-4 mb-2 flex-wrap">
        <h1 className="text-4xl font-bold">📦 ORDERS — {supplierName || '...'}</h1>
        <input type="text" placeholder="Search order, item, car..." value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[16rem] max-w-xl bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg" />
        <Link href="/suppliers" className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">← SUPPLIERS</Link>
      </div>
      <div className="flex gap-2 flex-wrap mb-4 items-center">
        {(['ALL', 'US', 'BR'] as const).map(r => (
          <button key={r} onClick={() => setRegion(r)} className={chip(region === r)}>{r === 'ALL' ? 'ALL' : r === 'US' ? '🇺🇸 US' : '🇧🇷 BR (PowerTrade)'}</button>
        ))}
        <span className="text-gray-500 text-sm ml-2">Registry only — amounts here never feed reports (already accounted on invoices).</span>
      </div>

      <div className="flex gap-4 mb-6 flex-wrap">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-6 py-3"><p className="text-xs font-bold text-gray-400">ORDERS</p><p className="text-2xl font-bold">{active.length}</p></div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-6 py-3"><p className="text-xs font-bold text-gray-400">TOTAL ORDERED</p><p className="text-2xl font-bold">{usd(totalOrdered)}</p></div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-6 py-3"><p className="text-xs font-bold text-gray-400">TOTAL PAID</p><p className="text-2xl font-bold text-green-400">{usd(totalPaid)}</p></div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-6 py-3"><p className="text-xs font-bold text-gray-400">OPEN BALANCE</p><p className={`text-2xl font-bold ${totalOrdered - totalPaid > 0.005 ? 'text-red-400' : 'text-green-400'}`}>{usd(totalOrdered - totalPaid)}</p></div>
        <div className="bg-gray-900 border border-cyan-800 rounded-2xl px-6 py-3"><p className="text-xs font-bold text-cyan-400">CREDIT BALANCE</p><p className="text-2xl font-bold text-cyan-300">{usd(creditNow)}</p></div>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="text-2xl text-gray-400">No orders registered{region !== 'ALL' ? ' in this region' : ''}.</p>
      ) : (
        <div className="space-y-3 max-w-6xl">
          {visible.map(o => (
            <div key={o.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono font-bold text-lg">{o.order_number || '—'}</span>
                {/* AQUI NÃO HÁ MAIS SEMÁFORO — de propósito. Duas leis se cruzam
                    nesta linha e as duas mandam tirá-lo:
                    1) "os badges de order number, tracking ou BOUGHT/SHIPPED/
                       DELIVERED devem ser nos ITENS, nao nos titulos das compras"
                       — e supplier_orders É a compra, não o item.
                    2) A virada de chave de 29/ago/2026 tirou o status de
                       part_streams e o pôs como COLUNA da linha do item; a tabela
                       supplier_orders não tem (nem deve ter) essas colunas, e
                       inventar campo é proibido.
                    O DELIVER STATUS deste pedido aparece nas linhas de item que o
                    carregam (invoice_expenses / inputs / inventory / goods /
                    good_expenses), que é onde ele foi comprado. */}
                <span className="text-gray-400">{o.order_date || 'no date'}</span>
                {(() => { const ed = effectiveDate(o); return ed && ed !== o.order_date ? <span className="text-green-500 text-sm">→ paid {ed}</span> : null })()}
                {o.region && <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${o.region === 'BR' ? 'bg-emerald-900 text-emerald-200' : 'bg-blue-900 text-blue-200'}`}>{o.region === 'BR' ? '🇧🇷 BR · PowerTrade' : '🇺🇸 US'}</span>}
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusBadge(o.payment_status)}`}>{o.payment_status || 'OPEN'}</span>
                {o.car_label && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-purple-900 text-purple-200">🚗 {o.car_label}</span>}
                <span className="ml-auto text-xl font-bold">{usd(o.total)}</span>
              </div>
              {o.description && <p className="text-gray-300 mt-1">{o.description}</p>}
              {(() => { const c = creditOf(o); return (
                <div className="flex gap-5 flex-wrap mt-1 text-sm text-gray-400">
                  <span>Ordered: <b className="text-white">{usd(o.total)}</b></span>
                  <span>Paid: <b className="text-green-400">{usd(o.paid_total ?? 0)}</b></span>
                  <span>Credit: {c.gen > 0 ? <b className="text-cyan-300">+{usd(c.gen)}</b> : c.used > 0 ? <b className="text-orange-400">−{usd(c.used)}</b> : <b className="text-gray-600">—</b>}</span>
                  <span>Credit balance: <b className="text-cyan-300">{usd(creditBal[o.id] ?? 0)}</b></span>
                </div>
              )})()}
              <div className="text-sm text-gray-500 mt-1 flex gap-4 flex-wrap">
                {(o.payments || []).map((p, i) => <span key={i}>• {p.date || ''} {usd(p.amount)} {p.method || ''}{p.ref ? ` (${p.ref})` : ''}</span>)}
                {o.ship_to && <span>Ship-to: {o.ship_to}</span>}
                {o.source && <span>Source: {o.source}</span>}
                {o.receipt_url && <a href={o.receipt_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">📄 document</a>}
              </div>
              {o.notes && <p className="text-sm text-amber-300/80 mt-1">{o.notes}</p>}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
