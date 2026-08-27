'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

// ATIVOS & MARKETING — o dinheiro que não é peça de carro, não é assinatura e
// não é conta que se repete (ordem do Márcio, 27/jul/2026).
//
//   ATIVO     — coisa física que FICA na oficina: painel de LED, ferramenta,
//               equipamento de dyno, móvel. Não é GOODS: GOODS é mercadoria
//               para revenda, e ativo nunca vai ser vendido — se entrasse lá,
//               inflaria o estoque e sujaria a margem para sempre.
//   MARKETING — dinheiro que vira imagem e não vira coisa: anúncio da Meta,
//               estande de SEMA, adesivo, camiseta, brinde.
//
// Modelo: mesma dupla de tabelas dos custos fixos (fixed_cost_suppliers +
// fixed_cost_expenses), só com cost_type='ASSET' / 'MARKETING' — a mesma jogada
// do módulo APPS. Motivo: TODOS os relatórios já leem essas tabelas, então o
// lançamento entra no custo do mês sozinho, sem costurar relatório nenhum.

const TYPES = { ASSET: 'EVENTS', MARKETING: 'ADVERTISEMENTS', MERCHANDISE: 'MERCHANDISE' } as const
type Kind = keyof typeof TYPES

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) }

type Row = {
  id: string
  description: string | null
  company: string | null
  email: string | null
  cost_type: string | null
  date_entry: string | null
  amount_1: number | null
}

export default function AssetsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [spent, setSpent] = useState<Map<string, number>>(new Map())
  const [owed, setOwed] = useState<Map<string, number>>(new Map())
  const [receipt, setReceipt] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<Kind | 'ALL'>('ALL')

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('fixed_cost_suppliers')
      .select('*')
      .in('cost_type', ['ASSET', 'MARKETING', 'MERCHANDISE'])
      .order('date_entry', { ascending: false })
    const list = (data || []) as Row[]
    setRows(list)
    if (list.length) {
      const { data: exp } = await supabase
        .from('fixed_cost_expenses')
        .select('supplier_id, amount, payment_date, receipt_url')
        .in('supplier_id', list.map(a => a.id))
      // PAID vs PENDING never get mixed: an instalment that has not left the
      // account yet is a bill, not spend. `payment_date` is the PAID flag.
      const paid = new Map<string, number>()
      const due = new Map<string, number>()
      const rec = new Map<string, string>()
      for (const e of exp || []) {
        if (!e.supplier_id) continue
        const bucket = e.payment_date ? paid : due
        bucket.set(e.supplier_id, (bucket.get(e.supplier_id) || 0) + (Number(e.amount) || 0))
        if (e.receipt_url && !rec.has(e.supplier_id)) rec.set(e.supplier_id, String(e.receipt_url))
      }
      setSpent(paid)
      setOwed(due)
      setReceipt(rec)
    }
    setLoading(false)
  }

  const q = search.trim().toLowerCase()
  const filtered = rows.filter(r => {
    const kindOk = kind === 'ALL' || r.cost_type === kind
    const searchOk = !q || [r.description, r.company].some(v => (v || '').toLowerCase().includes(q))
    return kindOk && searchOk
  })
  const total = filtered.reduce((s, r) => s + (spent.get(r.id) || 0), 0)
  const pending = filtered.reduce((s, r) => s + (owed.get(r.id) || 0), 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">MARKETING ({rows.length})</h1>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item, vendor..."
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg w-80"
        />
      </div>

      <div className="flex items-center gap-3 mb-8 flex-wrap">
        {(['ALL', 'ASSET', 'MARKETING', 'MERCHANDISE'] as const).map(k => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-5 py-2 rounded-full font-bold ${kind === k ? 'bg-blue-600' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {k === 'ALL' ? 'ALL' : TYPES[k]}
          </button>
        ))}
        <span className="text-xl text-gray-400 ml-2">Total invested: <b className="text-green-400">{formatUSD(total)}</b></span>
        {pending > 0.005 && <span className="text-xl text-gray-400">Still to pay: <b className="text-orange-400">{formatUSD(pending)}</b></span>}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'Nothing here yet — shop assets and marketing spend live on this page.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {filtered.map(r => (
            <Link key={r.id} href={`/costs/assets/${r.id}`} className="bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold">{r.description || r.company || '—'}</h2>
                  <span className={`px-3 py-1 rounded-full text-sm font-bold ${r.cost_type === 'ASSET' ? 'bg-purple-800 text-purple-100' : r.cost_type === 'MERCHANDISE' ? 'bg-emerald-800 text-emerald-100' : 'bg-amber-800 text-amber-100'}`}>
                    {TYPES[(r.cost_type as Kind)] || r.cost_type}
                  </span>
                </div>
                <p className="text-lg text-gray-400">{[r.company, r.email].filter(Boolean).join('  ·  ') || '—'}</p>
                <p className="text-base text-gray-500">
                  {isValidDate(r.date_entry) ? `Bought ${fmtDate(r.date_entry as string)}` : 'Date unknown'}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-bold text-green-400">{formatUSD(spent.get(r.id) || Number(r.amount_1) || 0)}</p>
                {(owed.get(r.id) || 0) > 0.005 && (
                  <p className="text-lg font-bold text-orange-400">+ {formatUSD(owed.get(r.id) || 0)} to pay</p>
                )}
                {receipt.get(r.id) && <p className="text-base text-blue-400">📎 receipt</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}
