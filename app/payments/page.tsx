'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }

type PayRow = { id: string; date: string; amount: number; code: string; label2: string; href: string }

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
      // PAID by GZ28US — staff expenses (no paid flag in this app; a recorded staff
      // expense is money already spent, like inputs/goods). Use expense_date in window.
      supabase.from('expenses').select('id, season_id, type, description, amount, expense_date').not('expense_date', 'is', null).gte('expense_date', cutoffDate),
      // PAID by GZ28US — inputs & goods are always paid; use purchase_date.
      supabase.from('inputs').select('id, description, unit_price, quantity, purchase_date, supplier, purchase_group').not('purchase_date', 'is', null).gte('purchase_date', cutoffDate),
      supabase.from('goods').select('id, description, unit_price, quantity, purchase_date, supplier, purchase_group').not('purchase_date', 'is', null).gte('purchase_date', cutoffDate),
    ])
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
        href: `${BASE_PATH}${path}`,
      }
    })

    const invoiceIds = [...new Set([...(pays || []).map((p: any) => p.invoice_id), ...(exps || []).map((e: any) => e.invoice_id)])]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id, is_quote').in('id', invoiceIds)
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
      const clientName = cid ? (clientsById.get(cid) || '') : ''
      const carName = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${cid}`
      return { inv, code: inv?.invoice_code || '—', clientName, carName, ownerSeg }
    }

    // Quotes are not real money in/out — never count their payments or expenses
    // in the PAST report (they have no income, but a quote's built-up expenses can
    // carry a payment_date and would otherwise leak in).
    const notQuote = (invId: string) => !invById.get(invId)?.is_quote
    const paysReal = (pays || []).filter((p: any) => notQuote(p.invoice_id))
    const expsReal = (exps || []).filter((e: any) => notQuote(e.invoice_id))

    const cRows: PayRow[] = paysReal.map((p: any) => {
      const m = invMeta(p.invoice_id)
      return { id: `pay-${p.id}`, date: (p.paid_at || '').slice(0, 10), amount: parseFloat(p.amount) || 0, code: m.code, label2: m.clientName || m.carName || '', href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/${m.inv.id}` : '#' }
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

    const invExpRows: PayRow[] = byPurchaseGroup(expsReal).map(([k, items]) => {
      const e0 = items[0]
      const m = invMeta(e0.invoice_id)
      const amount = items.reduce((s, e) => s + (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
      const supplier = e0.supplier || ''
      return { id: `inv-${k}`, date: e0.payment_date, amount, code: m.code, label2: items.length > 1 ? `${supplier || 'Purchase'} · ${items.length} items` : (supplier || e0.item || ''), href: m.inv ? `${BASE_PATH}/${m.ownerSeg}/invoices/edit/${m.inv.id}` : '#' }
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
      return { id: `staff-${e.id}`, date: e.expense_date, amount: parseFloat(e.amount) || 0, code: season?.season_code || 'STAFF', label2: staffName || (e.description || ''), href: season ? `${BASE_PATH}/staff/${season.staff_id}/seasons/${e.season_id}/expenses` : '#' }
    })

    const gRows = [...invExpRows, ...staffRows, ...purchaseRows(inputsD || [], 'INPUT', '/inputs'), ...purchaseRows(goodsD || [], 'GOOD', '/goods')].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

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

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">PAST Payments FLOW</h1>
      <p className="text-gray-400 mb-6">Everything paid in the last 12 months.</p>
      {loading ? (
        <p className="text-gray-400 text-xl">Loading…</p>
      ) : (
        <div className="max-w-3xl">
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
          <span className="text-gray-300 truncate">
            {formatShortDate(r.date)} · <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 hover:underline">{r.code}</a>{r.label2 ? ` · ${r.label2}` : ''}
          </span>
          <span className={`font-bold shrink-0 ${color}`}>{formatUSD(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}
