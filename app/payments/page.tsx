'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate, flowClientLabel } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }

type PayRow = { id: string; date: string; amount: number; code: string; label2: string; href: string; tip?: string }

export default function PaymentsPage() {
  const [clientRows, setClientRows] = useState<PayRow[]>([])
  const [gzRows, setGzRows] = useState<PayRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - 12)
    const cutoffDate = cutoff.toISOString().slice(0, 10)
    const cutoffISO = cutoff.toISOString()

    const [{ data: pays }, { data: exps }, { data: staffExps }, { data: inputsD }, { data: goodsD }] = await Promise.all([
      // PAID by CLIENTS — income received (paid_at in window).
      supabase.from('invoice_payments').select('id, invoice_id, amount, paid_at, source').not('paid_at', 'is', null).gte('paid_at', cutoffISO),
      // PAID by GZ28US — invoice expenses paid (payment_date in window).
      supabase.from('invoice_expenses').select('id, invoice_id, price, quantity, tax, extra, item, supplier, payment_date, purchase_group').not('payment_date', 'is', null).gte('payment_date', cutoffDate),
      // PAGO pela GZ28 — pagamento de staff. Desde 28/jul/2026 cada linha é um
      // pagamento com data própria e `payment_date` só existe quando o dinheiro
      // saiu — então o PAST lista pelo PAGAMENTO, nunca pela previsão (antes
      // qualquer linha contava como gasta, e a semana futura entraria aqui).
      supabase.from('expenses').select('id, season_id, type, description, amount, expense_date, payment_date, paid_via').not('payment_date', 'is', null).gte('payment_date', cutoffDate),
      // PAID by GZ28US — inputs & goods are always paid; use purchase_date.
      supabase.from('inputs').select('id, description, unit_price, quantity, purchase_date, supplier, purchase_group').not('purchase_date', 'is', null).gte('purchase_date', cutoffDate),
      supabase.from('goods').select('id, description, unit_price, quantity, purchase_date, supplier, purchase_group').not('purchase_date', 'is', null).gte('purchase_date', cutoffDate),
    ])
    // PAID by GZ28 — fixed-cost supplier payments (payment_date in window).
    const { data: fixedCostD } = await supabase.from('fixed_cost_expenses').select('id, supplier_id, description, amount, payment_date').not('payment_date', 'is', null).gte('payment_date', cutoffDate)
    // Inventory part sales — INCOME (money in -> PAID by CLIENTS) and EXPENSE (money out -> PAID by GZ28), by entry_date.
    const { data: invSalesD } = await supabase.from('inventory_sales').select('id, inventory_id, kind, amount, entry_date, description').not('entry_date', 'is', null).gte('entry_date', cutoffDate)
    const saleInvIds = [...new Set((invSalesD || []).map((s: any) => s.inventory_id))]
    let saleInvRows: any[] = []
    if (saleInvIds.length) { const { data } = await supabase.from('inventory').select('id, description').in('id', saleInvIds); saleInvRows = data || [] }
    const saleInvName = new Map<string, string>(); saleInvRows.forEach((i: any) => saleInvName.set(i.id, i.description || ''))
    const saleRow = (s: any): PayRow => { const name = saleInvName.get(s.inventory_id) || 'Inventory'; return { id: `invsale-${s.kind === 'INCOME' ? 'in' : 'ex'}-${s.id}`, date: s.entry_date, amount: parseFloat(s.amount) || 0, code: 'SALE', label2: name, tip: [name, s.description].filter(Boolean).join(' — '), href: `${BASE_PATH}/inventory/sell/${s.inventory_id}` } }
    const saleIncomeRows: PayRow[] = (invSalesD || []).filter((s: any) => s.kind === 'INCOME').map(saleRow)
    const saleExpenseRows: PayRow[] = (invSalesD || []).filter((s: any) => s.kind === 'EXPENSE').map(saleRow)
    // Group rows sharing a purchase_group into a single "purchase" row (scanned
    // receipts come in as many line items — show the purchase, not each item).
    const byPurchaseGroup = <T extends { purchase_group?: string | null; id: string }>(rs: T[]) => {
      const m = new Map<string, T[]>()
      for (const r of rs || []) { const k = r.purchase_group || `solo-${r.id}`; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r) }
      return [...m.entries()]
    }
    // Inputs / goods purchases (always-paid) -> one row per purchase.
    const purchaseRows = (rs: any[], kind: string, path: string): PayRow[] => byPurchaseGroup(rs || []).map(([k, items]) => {
      const r0 = items[0]
      const supplier = r0.supplier || ''
      return {
        id: `${kind.toLowerCase()}-${k}`,
        date: r0.purchase_date,
        amount: items.reduce((s, r) => s + (parseFloat(r.unit_price) || 0) * (parseFloat(r.quantity) || 1), 0),
        code: kind,
        label2: items.length > 1 ? `${supplier || 'Purchase'} · ${items.length} items` : [supplier, r0.description].filter(Boolean).join(' — '),
        tip: items.length > 1 ? `${supplier || 'Purchase'} · ${items.length} items` : [supplier, r0.description].filter(Boolean).join(' — '),
        href: `${BASE_PATH}${path}`,
      }
    })

    const invoiceIds = [...new Set([...(pays || []).map((p: any) => p.invoice_id), ...(exps || []).map((e: any) => e.invoice_id)])]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, service, ride_id, client_id, is_quote').in('id', invoiceIds)
      invs = data || []
    }
    const invById = new Map<string, any>(); invs.forEach((i: any) => invById.set(i.id, i))
    const [{ data: ridesD }, { data: clientsD }] = await Promise.all([
      supabase.from('rides').select('id, project_name, model, version, client_id'),
      supabase.from('clients').select('id, name'),
    ])
    const ridesById = new Map<string, any>(); (ridesD || []).forEach((r: any) => ridesById.set(r.id, r))
    const clientsById = new Map<string, string>(); (clientsD || []).forEach((c: any) => clientsById.set(c.id, c.name || ''))
    const invMeta = (invId: string) => {
      const inv = invById.get(invId)
      const ride = inv?.ride_id ? ridesById.get(inv.ride_id) : null
      const cid = inv?.client_id || ride?.client_id || null
      const clientName = cid ? flowClientLabel(clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const invoiceName = inv ? (inv.service || inv.invoice_code || '') : ''
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      return { inv, code: inv?.invoice_code || '—', clientName, carName, invoiceName, ownerSeg }
    }

    // Quotes are not real money in/out — never count their payments or expenses
    // in the PAST report (they have no income, but a quote's built-up expenses can
    // carry a payment_date and would otherwise leak in).
    const notQuote = (invId: string) => !invById.get(invId)?.is_quote
    const paysReal = (pays || []).filter((p: any) => notQuote(p.invoice_id))
    const expsReal = (exps || []).filter((e: any) => notQuote(e.invoice_id))

    const payRows: PayRow[] = paysReal.map((p: any) => {
      const m = invMeta(p.invoice_id)
      return { id: `pay-${p.id}`, date: (p.paid_at || '').slice(0, 10), amount: parseFloat(p.amount) || 0, code: m.code, label2: m.clientName || m.carName || '', tip: [m.clientName, m.carName, m.invoiceName].filter(Boolean).join(' — '), href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/${m.inv.id}` : '#' }
    })
    const cRows: PayRow[] = [...payRows, ...saleIncomeRows].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

    // Consolidate every expense sharing the same INVOICE + SUPPLIER + PAYMENT DATE into a
    // single row — covers scanned-receipt groups AND separately-added lines alike. Expenses
    // with no supplier stay solo so unrelated unlabeled lines never merge.
    const expByKey = new Map<string, any[]>()
    for (const e of expsReal) {
      const key = e.supplier ? `${e.invoice_id}|${e.supplier}|${e.payment_date || ''}` : `solo-${e.id}`
      if (!expByKey.has(key)) expByKey.set(key, [])
      expByKey.get(key)!.push(e)
    }
    const invExpRows: PayRow[] = [...expByKey.entries()].map(([k, items]) => {
      const e0 = items[0]
      const m = invMeta(e0.invoice_id)
      const amount = items.reduce((s, e) => s + (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
      const supplier = e0.supplier || ''
      return { id: `inv-${k}`, date: e0.payment_date, amount, code: m.code, label2: items.length > 1 ? `${supplier || 'Purchase'} · ${items.length} items` : (supplier || e0.item || ''), tip: [m.clientName, m.carName, m.invoiceName, supplier].filter(Boolean).join(' — '), href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/edit/${m.inv.id}` : '#' }
    })

    // Staff expense names + links.
    const seasonIds = [...new Set((staffExps || []).map((e: any) => e.season_id))]
    let seasons: any[] = []
    if (seasonIds.length) {
      const { data } = await supabase.from('seasons').select('id, season_code, staff_id').in('id', seasonIds)
      seasons = data || []
    }
    const seasonById = new Map<string, any>(); seasons.forEach((s: any) => seasonById.set(s.id, s))
    const staffIds = [...new Set(seasons.map((s: any) => s.staff_id))]
    let staff: any[] = []
    if (staffIds.length) {
      const { data } = await supabase.from('staff').select('id, name').in('id', staffIds)
      staff = data || []
    }
    const staffNameById = new Map<string, string>(); staff.forEach((s: any) => staffNameById.set(s.id, s.name || ''))
    const staffRows: PayRow[] = (staffExps || []).map((e: any) => {
      const season = seasonById.get(e.season_id)
      const staffName = season ? (staffNameById.get(season.staff_id) || '') : ''
      // A data do PAST é a do PAGAMENTO (quando o dinheiro saiu), não a do período.
      return { id: `staff-${e.id}`, date: e.payment_date || e.expense_date, amount: parseFloat(e.amount) || 0, code: season?.season_code || 'STAFF', label2: staffName || (e.description || ''), tip: [staffName, e.description, e.paid_via].filter(Boolean).join(' — '), href: season ? `${BASE_PATH}/staff/${season.staff_id}/seasons/${e.season_id}/expenses` : '#' }
    })

    const fixedCostRows: PayRow[] = (fixedCostD || []).map((e: any) => ({
      id: `fixed-${e.id}`, date: e.payment_date, amount: parseFloat(e.amount) || 0,
      code: 'FIXED', label2: e.description || 'Fixed cost', tip: e.description || 'Fixed cost',
      href: `${BASE_PATH}/costs/fixed/${e.supplier_id}`,
    }))

    const gRows = [...invExpRows, ...staffRows, ...purchaseRows(inputsD || [], 'INPUT', '/inputs'), ...purchaseRows(goodsD || [], 'GOOD', '/goods'), ...fixedCostRows, ...saleExpenseRows].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

    setClientRows(cRows)
    setGzRows(gRows)
    setLoading(false)
  }

  const clientTotal = clientRows.reduce((s, r) => s + r.amount, 0)
  const gzTotal = gzRows.reduce((s, r) => s + r.amount, 0)
  // Group each side by month (YYYY-MM); render a block per month so the two sides
  // line up month by month.
  const byMonth = (rows: PayRow[]) => { const m = new Map<string, PayRow[]>(); rows.forEach(r => { const k = (r.date || '').slice(0, 7); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r) }); return m }
  const byWeek = (rows: PayRow[]) => { const m = new Map<string, PayRow[]>(); rows.forEach(r => { if (!r.date) return; const k = weekKey(r.date); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r) }); return m }
  const sum = (rows: PayRow[]) => rows.reduce((s, r) => s + r.amount, 0)
  const cByM = byMonth(clientRows)
  const gByM = byMonth(gzRows)
  const months = [...new Set([...cByM.keys(), ...gByM.keys()])].sort((a, b) => b.localeCompare(a))
  const now = new Date()
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  // 12-month cashflow series for the chart (oldest -> newest): incomes, expenses, balance.
  const chartSeries = (() => {
    const out: { mk: string; inc: number; exp: number; bal: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const inc = sum(cByM.get(mk) || []); const exp = sum(gByM.get(mk) || [])
      out.push({ mk, inc, exp, bal: inc - exp })
    }
    return out
  })()

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">PAST Payments FLOW</h1>
      <p className="text-gray-400 mb-6">Everything paid in the last 12 months.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <div className="max-w-3xl">
          {months.length > 0 && (
            <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 mb-3">
              <p className="text-sm font-bold text-gray-400 mb-2">LAST 12 MONTHS</p>
              <CashFlowChart series={chartSeries} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 flex justify-between items-baseline">
              <span className="text-sm font-bold text-gray-400">PAID by CLIENTS</span>
              <span className="text-xl font-bold text-green-400">{formatUSD(clientTotal)}</span>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 flex justify-between items-baseline">
              <span className="text-sm font-bold text-gray-400">PAID by GZ28US</span>
              <span className="text-xl font-bold text-orange-400">{formatUSD(gzTotal)}</span>
            </div>
          </div>
          {months.length === 0 ? (
            <p className="text-gray-400 text-xl">No payments in the last 12 months.</p>
          ) : months.map((mk) => {
            const cM = cByM.get(mk) || []
            const gM = gByM.get(mk) || []
            const clientSub = sum(cM)
            const gzSub = sum(gM)
            const bal = clientSub - gzSub
            const balColor = bal > 0.005 ? 'text-blue-400' : bal < -0.005 ? 'text-red-400' : 'text-gray-400'
            const isCurrent = mk === nowMonth
            const cByW = byWeek(cM)
            const gByW = byWeek(gM)
            const weeks = [...new Set([...cByW.keys(), ...gByW.keys()])].sort((a, b) => b.localeCompare(a))
            return (
              <div key={mk} className="bg-gray-900 border border-gray-700 rounded-2xl p-4 mb-3">
                <div className="flex justify-between items-baseline border-b border-gray-700 pb-1 mb-2 gap-3">
                  <p className="text-sm font-bold text-gray-300 uppercase">{monthLabel(mk)}</p>
                  <p className="text-sm font-bold whitespace-nowrap"><span className="text-green-400">{formatUSD(clientSub)}</span><span className="text-gray-600"> · </span><span className="text-orange-400">{formatUSD(gzSub)}</span><span className="text-gray-600"> &nbsp;·&nbsp; </span><span className={balColor}>{formatUSD(bal)}</span></p>
                </div>
                {isCurrent ? weeks.map((wk) => (
                  <div key={wk} className="mt-3">
                    <p className="text-xs font-bold text-gray-500 uppercase border-b border-gray-700 pb-1 mb-2">{weekLabel(wk)}</p>
                    <div className="grid grid-cols-2 gap-4">
                      <MonthSide rows={cByW.get(wk) || []} color="text-green-400" />
                      <MonthSide rows={gByW.get(wk) || []} color="text-orange-400" />
                    </div>
                  </div>
                )) : (
                  <div className="grid grid-cols-2 gap-4 mt-1">
                    <MonthSide rows={cM} color="text-green-400" showSub={false} />
                    <MonthSide rows={gM} color="text-orange-400" showSub={false} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
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

// 3-line cashflow chart: RED expenses, BLUE incomes, GREEN balance, over 12 months.
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
        <rect x={x0} y={4} width="14" height="4" fill="#f87171" /><text x={x0 + 18} y={12} fill="#f87171">EXPENSES</text>
        <rect x={x0 + 104} y={4} width="14" height="4" fill="#60a5fa" /><text x={x0 + 122} y={12} fill="#60a5fa">INCOMES</text>
        <rect x={x0 + 198} y={4} width="14" height="4" fill="#4ade80" /><text x={x0 + 216} y={12} fill="#4ade80">BALANCE</text>
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

function monthLabel(mk: string): string {
  return new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// Week key = the Monday of that date's week (YYYY-MM-DD). Label = "Mon DD – Sun DD".
function weekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function weekLabel(wk: string): string {
  const start = new Date(wk + 'T00:00:00')
  const end = new Date(start); end.setDate(start.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

function MonthSide({ rows, color, showSub = true }: { rows: PayRow[]; color: string; showSub?: boolean }) {
  const subt = rows.reduce((s, r) => s + r.amount, 0)
  return (
    <div>
      {showSub && <div className="flex justify-end text-xs mb-1"><span className={`font-bold ${color}`}>{formatUSD(subt)}</span></div>}
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600 py-1">—</p>
      ) : rows.map((r) => (
        <div key={r.id} className="flex justify-between gap-2 py-1 text-sm border-b border-gray-800/60 last:border-0">
          <span className="text-gray-300 truncate" title={r.tip || undefined}>
            {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.label2 ? ` · ${r.label2}` : ''}
          </span>
          <span className={`font-bold shrink-0 ${color}`}>{formatUSD(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}
