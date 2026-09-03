'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'
import { lateFeeFor } from '@/lib/lateFee'

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

type FixedCostSupplier = {
  id: string
  description: string | null
  company: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
  periodicity: string | null
  amount_1: number | null
  amount_2: number | null
  date_entry: string | null
  date_conclusion: string | null
  // MULTA POR ATRASO — cláusula do contrato deste fornecedor (lib/lateFee.ts).
  late_grace_days: number | null
  late_fee_fixed: number | null
  late_fee_percent: number | null
  late_fee_daily: number | null
  late_fee_daily_cap_days: number | null
}

// True monthly cost of one supplier: the full period charge (both payment slots)
// normalized to a month. SINGLE is a one-off — it has no monthly weight; ended
// suppliers are excluded by the caller. DAILY/WEEKLY use the yearly average
// (×365/12, ×52/12), not "30 days" — that's the number that survives a year.
//
// CONTRATO ENCERRADO (Márcio, 01/ago/2026): a média deixa de ser a contratual e
// vira o retrato final — TODOS os pagamentos registrados (mesmo os feitos depois
// do cancelamento; refunds entram como pagamento negativo e corrigem sozinhos)
// divididos pelo período de vigência (date_entry → date_conclusion).
function monthlyOf(r: FixedCostSupplier, paidTotal?: number): number {
  if (isValidDate(r.date_conclusion) && isValidDate(r.date_entry) && paidTotal !== undefined) {
    const days = (new Date(r.date_conclusion + 'T00:00:00').getTime() - new Date(r.date_entry + 'T00:00:00').getTime()) / 86400e3
    const months = Math.max(days / 30.4375, 1 / 30.4375)
    return paidTotal / months
  }
  const perPeriod = (Number(r.amount_1) || 0) + (Number(r.amount_2) || 0)
  // Old rows carry lowercase periodicity ("monthly") — normalize before matching.
  switch ((r.periodicity || '').toUpperCase()) {
    case 'MONTHLY': return perPeriod
    // SEMIANNUAL (01/ago/2026, apólice Progressive Commercial): prêmio do
    // semestre inteiro em amount_1 — a média mensal é /6.
    case 'SEMIANNUAL': return perPeriod / 6
    case 'ANNUAL': return perPeriod / 12
    case 'WEEKLY': return (perPeriod * 52) / 12
    case 'DAILY': return (perPeriod * 365) / 12
    default: return 0 // SINGLE / unknown: no recurring monthly weight
  }
}

const CONTACTS = ['WhatsApp', 'SMS', 'Email', 'Phone'] as const

export default function FixedCostSuppliersPage() {
  const [rows, setRows] = useState<FixedCostSupplier[]>([])
  // supplier_id -> next payment still due (earliest unpaid expense: date + amount).
  const [nextDue, setNextDue] = useState<Map<string, { date: string; amount: number }>>(new Map())
  // supplier_id -> soma de TODOS os pagamentos registrados (média final dos encerrados).
  const [paidTotals, setPaidTotals] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'WhatsApp' | 'SMS' | 'Email' | 'Phone'>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    // APP subscriptions live on their own page (COSTS → APPS) — hidden here.
    const { data } = await supabase
      .from('fixed_cost_suppliers')
      .select('*')
      // FIXED lists only recurring bills: APP has its own page, and ASSET /
      // MARKETING live in ASSETS & MARKETING (same tables, different cost_type).
      .or('cost_type.is.null,and(cost_type.neq.APP,cost_type.neq.ASSET,cost_type.neq.MARKETING,cost_type.neq.MERCHANDISE,cost_type.neq.BANK)')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows((data || []) as FixedCostSupplier[])
    // Earliest UNPAID expense per supplier = the next payment due (overdue ones first).
    const { data: exp } = await supabase
      .from('fixed_cost_expenses')
      .select('supplier_id, expense_date, amount')
      .is('payment_date', null)
      .order('expense_date', { ascending: true, nullsFirst: false })
    const m = new Map<string, { date: string; amount: number }>()
    for (const e of (exp || [])) {
      if (!e.supplier_id || !isValidDate(e.expense_date)) continue
      if (!m.has(e.supplier_id)) m.set(e.supplier_id, { date: e.expense_date, amount: Number(e.amount) || 0 })
    }
    setNextDue(m)
    // Soma de todos os pagamentos por fornecedor — alimenta a média final dos
    // contratos encerrados (pagamentos ÷ vigência), incluindo refunds negativos.
    const { data: allExp } = await supabase.from('fixed_cost_expenses').select('supplier_id, amount')
    const totals = new Map<string, number>()
    for (const e of (allExp || [])) {
      if (!e.supplier_id) continue
      totals.set(e.supplier_id, (totals.get(e.supplier_id) || 0) + (Number(e.amount) || 0))
    }
    setPaidTotals(totals)
    setLoading(false)
  }

  async function remove(id: string) {
    const { error } = await supabase.from('fixed_cost_suppliers').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const td = todayYmd()
  const q = search.trim().toLowerCase()
  // VISIBILIDADE = VIGÊNCIA (Márcio, 01/ago/2026): o card nasce com o contrato e
  // SOME no primeiro mês sem vigência — mesmo que ainda existam pagamentos
  // registrados (esses seguem no banco e no Future Flow; aqui é custo fixo VIVO).
  const monthStart = td.slice(0, 7) + '-01'
  const aliveThisMonth = (r: FixedCostSupplier) =>
    !isValidDate(r.date_conclusion) || (r.date_conclusion as string) >= monthStart
  const filtered = rows.filter((r) => {
    const contactOk = filter === 'ALL' || (r.preferred_contact || 'WhatsApp') === filter
    const searchOk = !q || [r.description, r.company, r.contact_name, r.phone, r.email].some((v) => (v || '').toLowerCase().includes(q))
    return aliveThisMonth(r) && contactOk && searchOk
  })
  // Monthly Average total of the CURRENT month (Márcio, 30/jul/2026): every
  // ENROLLED cost counts at its monthly average, paid or not — a signed contract
  // is alive and its clock is counting even before the first charge. Encerrados
  // contam pela média final (pagamentos ÷ vigência) enquanto ainda visíveis.
  const avgOf = (r: FixedCostSupplier) => monthlyOf(r, isValidDate(r.date_conclusion) ? (paidTotals.get(r.id) || 0) : undefined)
  const monthlyTotal = filtered.reduce((sum, r) => sum + avgOf(r), 0)
  const monthLabel = new Date(td + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Fixed Cost Supplier</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">FIXED COST SUPPLIERS ({rows.filter(aliveThisMonth).length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, company, contact…"
            className="w-64 sm:w-80 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <Link href="/costs/fixed/new" className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">ADD NEW FIXED COST SUPPLIER</Link>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {(['ALL', ...CONTACTS] as const).map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-4 py-2 rounded-full font-bold ${filter === c ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c}
          </button>
        ))}
        <span className="ml-2 text-lg font-bold text-gray-300">Monthly Average ({monthLabel}): {formatUSD(monthlyTotal)}</span>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No fixed cost suppliers yet.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {filtered.map((r) => (
            <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <Link href={`/costs/fixed/${r.id}`} className="flex-1 min-w-0 group">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold group-hover:text-blue-400 transition">{r.description || r.company || '—'}</h2>
                  <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700">{r.preferred_contact || 'WhatsApp'}</span>
                </div>
                <p className="text-lg text-gray-400">{[r.company, r.contact_name].filter(Boolean).join(' · ') || '—'}</p>
                <p className="text-base text-gray-400">{formatUSD(avgOf(r))} avg / month</p>
                {(() => {
                  const n = nextDue.get(r.id)
                  if (!n) return <p className="text-base text-gray-500">All paid — nothing due</p>
                  const late = n.date < td
                  // A multa aparece JÁ NA LISTA (3/set/2026): "DELAYED" sozinho não
                  // diz o que o atraso custa, e é o custo que faz alguém pagar hoje.
                  // Aviso, não lançamento — ver lib/lateFee.ts.
                  const lf = lateFeeFor(r, n.amount, n.date, td)
                  return (
                    <>
                      <p className={`text-base font-bold ${late ? 'text-red-400' : 'text-gray-300'}`}>{fmtDate(n.date)} - {formatUSD(n.amount)}{late ? ' · DELAYED' : ''}</p>
                      {lf && lf.fine > 0 && <p className="text-sm font-bold text-red-400" title={lf.ruleLabel}>Late fee running: {formatUSD(lf.fine)}{lf.perDay > 0 ? ` · +${formatUSD(lf.perDay)}/day` : ' · capped'}</p>}
                      {lf && lf.fine === 0 && lf.daysToGrace <= 7 && <p className="text-sm font-bold text-amber-300" title={lf.ruleLabel}>Pay by {fmtDate(lf.graceUntil)}{lf.daysToGrace > 0 ? ` — ${lf.daysToGrace} ${lf.daysToGrace === 1 ? 'day' : 'days'} left` : ' — TODAY'}</p>}
                    </>
                  )
                })()}
              </Link>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/costs/fixed/${r.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold">💵 EXPENSES</Link>
                <Link href={`/costs/fixed/edit/${r.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
