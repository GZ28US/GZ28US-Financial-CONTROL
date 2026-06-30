'use client'
/* eslint-disable @typescript-eslint/no-unused-vars */

// GZ28US vs GZ28BR Flow — the inter-company ledger. Reads GZ28US data (USD):
//   GZ28BR GOT  = incomes PAID TO GZ28BR   (invoice_payments.paid_to = 'GZ28BR')  → money GZ28BR holds for us
//   GZ28BR PAID = expenses PAID FROM GZ28BR (invoice_expenses.source = 'GZ28BR')   → money GZ28BR paid us
// This page is identical in both apps; BR reads the same GZ28US project via supabaseUS.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatShortDate } from '@/lib/utils'

const US_BASE = 'https://www.gz28us.com/ca'
function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
type Row = { id: string; date: string; amount: number; code: string; label: string; href: string; tip?: string }

export default function GzFlowPage() {
  const [gotRows, setGotRows] = useState<Row[]>([])
  const [paidRows, setPaidRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    const [{ data: pays }, { data: exps }] = await Promise.all([
      supabase.from('invoice_payments').select('id, invoice_id, amount, payment_date, paid_at, description').eq('paid_to', 'GZ28BR'),
      supabase.from('invoice_expenses').select('id, invoice_id, price, quantity, tax, extra, payment_date, expense_date, item').eq('source', 'GZ28BR'),
    ])
    const invoiceIds = [...new Set([...(pays || []).map((p: any) => p.invoice_id), ...(exps || []).map((e: any) => e.invoice_id)])].filter(Boolean)
    let invs: any[] = []
    if (invoiceIds.length) { const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id').in('id', invoiceIds); invs = data || [] }
    const invById = new Map<string, any>(); invs.forEach((i: any) => invById.set(i.id, i))
    const rideIds = [...new Set(invs.map((i: any) => i.ride_id).filter(Boolean))]
    let rides: any[] = []
    if (rideIds.length) { const { data } = await supabase.from('rides').select('id, project_name, model, version').in('id', rideIds); rides = data || [] }
    const rideById = new Map<string, any>(); rides.forEach((r: any) => rideById.set(r.id, r))
    const meta = (invId: string) => {
      const inv = invById.get(invId)
      const ride = inv?.ride_id ? rideById.get(inv.ride_id) : null
      const car = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const code = inv?.invoice_code || '—'
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${inv?.client_id}`
      const href = inv ? `${US_BASE}/${ownerSeg}/invoices/${inv.id}` : '#'
      return { code, car, href }
    }
    const got: Row[] = (pays || []).map((p: any) => {
      const m = meta(p.invoice_id)
      const date = p.payment_date || (p.paid_at || '').slice(0, 10) || ''
      return { id: `got-${p.id}`, date, amount: parseFloat(p.amount) || 0, code: m.code, label: m.car || p.description || '', href: m.href, tip: [m.car, p.description].filter(Boolean).join(' — ') }
    }).filter((r: Row) => r.date)
    const paid: Row[] = (exps || []).map((e: any) => {
      const m = meta(e.invoice_id)
      const date = e.payment_date || e.expense_date || ''
      const amt = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
      return { id: `paid-${e.id}`, date, amount: amt, code: m.code, label: m.car ? `${m.car} · ${e.item}` : (e.item || ''), href: m.href, tip: [m.car, e.item].filter(Boolean).join(' — ') }
    }).filter((r: Row) => r.date)
    setGotRows(got.sort((a, b) => b.date.localeCompare(a.date)))
    setPaidRows(paid.sort((a, b) => b.date.localeCompare(a.date)))
    setLoading(false)
  }

  const gotTotal = gotRows.reduce((s, r) => s + r.amount, 0)
  const paidTotal = paidRows.reduce((s, r) => s + r.amount, 0)
  const balance = gotTotal - paidTotal
  const byMonth = (rows: Row[]) => { const m = new Map<string, Row[]>(); rows.forEach(r => { const k = (r.date || '').slice(0, 7); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r) }); return m }
  const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.amount, 0)
  const gByM = byMonth(gotRows), pByM = byMonth(paidRows)
  const allKeys = [...new Set([...gByM.keys(), ...pByM.keys()])].sort()
  const months = [...allKeys].sort((a, b) => b.localeCompare(a))
  // Chart: every month from first to last (filling gaps), oldest -> newest.
  const chartSeries = (() => {
    if (allKeys.length === 0) return [] as { mk: string; inc: number; exp: number; bal: number }[]
    const [y0, m0] = allKeys[0].split('-').map(Number)
    const [y1, m1] = allKeys[allKeys.length - 1].split('-').map(Number)
    const out: { mk: string; inc: number; exp: number; bal: number }[] = []
    for (let d = new Date(y0, m0 - 1, 1); d <= new Date(y1, m1 - 1, 1); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const inc = sum(gByM.get(mk) || []); const exp = sum(pByM.get(mk) || [])
      out.push({ mk, inc, exp, bal: inc - exp })
    }
    return out
  })()

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">GZ28US vs GZ28BR Flow</h1>
      <p className="text-gray-400 mb-6">All history of money GZ28BR holds for us (GOT) vs money GZ28BR paid us (PAID).</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <div className="max-w-3xl">
          {chartSeries.length > 0 && (
            <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 mb-3">
              <p className="text-sm font-bold text-gray-400 mb-2">ALL HISTORY</p>
              <CashFlowChart series={chartSeries} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-4 mb-3">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3">
              <p className="text-xs font-bold text-gray-400">GZ28BR GOT</p>
              <p className="text-xl font-bold text-blue-400">{formatUSD(gotTotal)}</p>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3">
              <p className="text-xs font-bold text-gray-400">GZ28BR PAID</p>
              <p className="text-xl font-bold text-red-400">{formatUSD(paidTotal)}</p>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3">
              <p className="text-xs font-bold text-gray-400">BALANCE (BR owes us)</p>
              <p className={`text-xl font-bold ${balance >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatUSD(balance)}</p>
            </div>
          </div>
          {months.length === 0 ? (
            <p className="text-gray-400 text-xl">No GZ28BR money movement yet.</p>
          ) : months.map((mk) => {
            const gM = gByM.get(mk) || []
            const pM = pByM.get(mk) || []
            const gSub = sum(gM); const pSub = sum(pM); const bal = gSub - pSub
            const balColor = bal > 0.005 ? 'text-green-400' : bal < -0.005 ? 'text-red-400' : 'text-gray-400'
            return (
              <div key={mk} className="bg-gray-900 border border-gray-700 rounded-2xl p-4 mb-3">
                <div className="flex justify-between items-baseline border-b border-gray-700 pb-1 mb-2 gap-3">
                  <p className="text-sm font-bold text-gray-300 uppercase">{monthLabel(mk)}</p>
                  <p className="text-sm font-bold whitespace-nowrap"><span className="text-blue-400">{formatUSD(gSub)}</span><span className="text-gray-600"> · </span><span className="text-red-400">{formatUSD(pSub)}</span><span className="text-gray-600"> &nbsp;·&nbsp; </span><span className={balColor}>{formatUSD(bal)}</span></p>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-1">
                  <Side rows={gM} color="text-blue-400" />
                  <Side rows={pM} color="text-red-400" />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}

function Side({ rows, color }: { rows: Row[]; color: string }) {
  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600 py-1">—</p>
      ) : rows.map((r) => (
        <div key={r.id} className="flex justify-between gap-2 py-1 text-sm border-b border-gray-800/60 last:border-0">
          <span className="text-gray-300 truncate" title={r.tip || undefined}>
            {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.label ? ` · ${r.label}` : ''}
          </span>
          <span className={`font-bold shrink-0 ${color}`}>{formatUSD(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}

function monthLabel(mk: string): string {
  return new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// Compact USD for axis labels: $254k, $1.5k, $300, -$2k.
function compactUSD(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return `${v < 0 ? '-' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`
  return `${v < 0 ? '-' : ''}$${a.toFixed(0)}`
}
function niceStep(x: number): number {
  if (x <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const f = x / p
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return n * p
}

// 3-line cashflow chart: RED expenses (PAID), BLUE incomes (GOT), GREEN balance.
function CashFlowChart({ series }: { series: { mk: string; inc: number; exp: number; bal: number }[] }) {
  const W = 760, H = 300, padR = 14, padT = 30, padB = 56
  const vals = series.flatMap(s => [s.inc, s.exp, s.bal])
  const rawMax = Math.max(1, ...vals), rawMin = Math.min(0, ...vals)
  const step = niceStep((rawMax - rawMin) / 4 || 1)
  const maxV = Math.ceil(rawMax / step) * step
  const minV = Math.floor(rawMin / step) * step
  const padL = 16 + Math.max(compactUSD(maxV).length, compactUSD(minV).length) * 7
  const x0 = padL, x1 = W - padR, yTop = padT, yBot = H - padB
  const xFor = (i: number) => series.length <= 1 ? (x0 + x1) / 2 : x0 + (i / (series.length - 1)) * (x1 - x0)
  const yFor = (v: number) => yBot - ((v - minV) / (maxV - minV || 1)) * (yBot - yTop)
  const line = (k: 'inc' | 'exp' | 'bal') => series.map((s, i) => `${i ? 'L' : 'M'}${xFor(i).toFixed(1)},${yFor(s[k]).toFixed(1)}`).join(' ')
  const ticks: number[] = []
  for (let v = minV; v <= maxV + 0.001; v += step) ticks.push(v)
  const mLabel = (mk: string) => new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <g fontSize="12" fontWeight="bold">
        <rect x={x0} y={4} width="14" height="4" fill="#f87171" /><text x={x0 + 18} y={12} fill="#f87171">PAID</text>
        <rect x={x0 + 70} y={4} width="14" height="4" fill="#60a5fa" /><text x={x0 + 88} y={12} fill="#60a5fa">GOT</text>
        <rect x={x0 + 134} y={4} width="14" height="4" fill="#4ade80" /><text x={x0 + 152} y={12} fill="#4ade80">BALANCE</text>
      </g>
      {ticks.map((t, i) => (
        <g key={`t${i}`}>
          <line x1={x0} y1={yFor(t)} x2={x1} y2={yFor(t)} stroke={Math.abs(t) < 0.001 ? '#4b5563' : '#1f2937'} strokeWidth="1" />
          <text x={x0 - 6} y={yFor(t) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{compactUSD(t)}</text>
        </g>
      ))}
      {series.map((s, i) => (
        <g key={`x${i}`}>
          <text x={xFor(i)} y={yBot + 18} textAnchor="middle" fontSize="11" fill="#6b7280">{mLabel(s.mk)}</text>
          <text x={xFor(i)} y={yBot + 33} textAnchor="middle" fontSize="10.5" fontWeight="bold" fill={s.bal >= 0 ? '#60a5fa' : '#f87171'}>{compactUSD(s.bal)}</text>
        </g>
      ))}
      <path d={line('exp')} fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinejoin="round" />
      <path d={line('inc')} fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinejoin="round" />
      <path d={line('bal')} fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinejoin="round" />
      {series.map((s, i) => (
        <g key={`d${i}`}>
          <circle cx={xFor(i)} cy={yFor(s.exp)} r="2.4" fill="#f87171" />
          <circle cx={xFor(i)} cy={yFor(s.inc)} r="2.4" fill="#60a5fa" />
          <circle cx={xFor(i)} cy={yFor(s.bal)} r="2.4" fill="#4ade80" />
        </g>
      ))}
    </svg>
  )
}
