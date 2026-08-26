'use client'

// TARIFAS BANCÁRIAS — a casa delas (João, 26/ago/2026: "precisamos de um lugar
// pra elas morarem" — moravam disfarçadas de custo fixo). Mesmo padrão de
// APPS / ASSETS & MKT: mesma tabela, cost_type próprio (BANK), página própria.
// As tarifas NASCEM do motor FEE do Bank Link, linkadas à linha do banco;
// tarifa de wire com wire único casado vira REPASSE na própria invoice e nem
// passa por aqui. Editar o fornecedor continua em /costs/fixed/[id].
import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Fee = { id: string; supplier_id: string; description: string | null; amount: number; expense_date: string | null; payment_date: string | null; bank_transaction_id: string | null }

const familyOf = (d: string | null) => String(d || 'Tarifa').split(' — ')[0].trim().slice(0, 48)

export default function BankFeesPage() {
  const [sups, setSups] = useState<{ id: string; company: string | null; description: string | null }[]>([])
  const [fees, setFees] = useState<Fee[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const { data: s } = await supabase.from('fixed_cost_suppliers').select('id, company, description').eq('cost_type', 'BANK')
      const ids = (s || []).map(x => x.id)
      setSups(s || [])
      if (ids.length) {
        const { data: f } = await supabase.from('fixed_cost_expenses')
          .select('id, supplier_id, description, amount, expense_date, payment_date, bank_transaction_id')
          .in('supplier_id', ids)
          .order('expense_date', { ascending: false, nullsFirst: false })
        setFees((f || []) as Fee[])
      }
      setLoading(false)
    })()
  }, [])

  const total = fees.reduce((s, f) => s + (Number(f.amount) || 0), 0)
  const month = new Date().toISOString().slice(0, 7)
  const totalMonth = fees.filter(f => String(f.expense_date || '').startsWith(month)).reduce((s, f) => s + (Number(f.amount) || 0), 0)
  const fams = new Map<string, { n: number; sum: number }>()
  for (const f of fees) { const k = familyOf(f.description); const e = fams.get(k) || { n: 0, sum: 0 }; e.n++; e.sum += Number(f.amount) || 0; fams.set(k, e) }

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <h1 className="text-4xl font-bold mb-1">TARIFAS BANCÁRIAS</h1>
      <p className="text-gray-400 mb-6 max-w-3xl">
        Nascem do motor FEE do Bank Link, cada uma linkada à linha do banco que a cobrou — não são custo fixo, têm
        linha própria no DRE e no DFC. Tarifa de wire com wire único casado vira <span className="text-gray-200 font-bold">repasse na própria invoice</span> e
        nem aparece aqui: a margem do projeto absorve.
        {sups[0] && <> Fornecedor: <Link href={`/costs/fixed/${sups[0].id}`} className="underline hover:text-white">{sups[0].company || 'Regions Bank'}</Link>.</>}
      </p>

      {loading ? <p className="text-xl text-gray-400">Loading…</p> : sups.length === 0 ? (
        <div className="bg-amber-950/40 border border-amber-700 rounded-3xl p-6 max-w-2xl">
          <p className="text-lg font-bold text-amber-300">Nenhum fornecedor com cost_type BANK ainda</p>
          <p className="text-gray-300 mt-1">Rode o script que muda o &quot;Regions Bank&quot; de FIXED → BANK (o Claude deixou pronto) — as tarifas já lançadas mudam de casa na hora.</p>
        </div>
      ) : (
        <>
          <div className="flex gap-4 flex-wrap mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3"><p className="text-xs font-bold text-gray-500">TOTAL DESDE O INÍCIO</p><p className="text-2xl font-bold tabular-nums text-red-400">{formatUSD(total)}</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3"><p className="text-xs font-bold text-gray-500">ESTE MÊS</p><p className="text-2xl font-bold tabular-nums">{formatUSD(totalMonth)}</p></div>
            {[...fams.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 4).map(([k, e]) => (
              <div key={k} className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-3"><p className="text-xs font-bold text-gray-500 truncate max-w-[14rem]" title={k}>{k}</p><p className="text-lg font-bold tabular-nums">{formatUSD(e.sum)} <span className="text-xs text-gray-500 font-normal">×{e.n}</span></p></div>
            ))}
          </div>

          <div className="border border-gray-800 rounded-2xl overflow-hidden max-w-4xl divide-y divide-gray-900">
            {fees.map(f => (
              <div key={f.id} className="px-5 py-2.5 flex items-baseline gap-3 text-sm">
                <span className="text-gray-500 text-xs w-24 shrink-0">{f.expense_date || '—'}</span>
                <span className="flex-1 truncate" title={f.description || ''}>{familyOf(f.description)}</span>
                {f.bank_transaction_id && <span className="text-[10px] font-bold text-teal-300 shrink-0" title="criada pelo motor FEE, linkada à linha do banco">⛓ BANCO</span>}
                {(() => { const m2 = String(f.description || '').match(/causada pelo wire da (\S+)/); return m2 ? <span className="text-[10px] font-bold text-sky-300 shrink-0" title="bookkeeping: o wire que causou esta tarifa (o preço cobre isso ANTES, na montagem da invoice)">→ {m2[1]}</span> : null })()}
                {!f.payment_date && <span className="text-[10px] font-bold text-amber-300 shrink-0">NÃO PAGA?</span>}
                <span className="tabular-nums font-bold shrink-0 text-red-400">{formatUSD(Number(f.amount) || 0)}</span>
              </div>
            ))}
            {fees.length === 0 && <p className="px-5 py-6 text-gray-500">Nenhuma tarifa lançada ainda.</p>}
          </div>
        </>
      )}
    </main>
  )
}
