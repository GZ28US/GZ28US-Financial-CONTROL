import { NextRequest, NextResponse } from 'next/server'
import { streamDb, sendStreamWhatsApp } from '@/lib/stream.server'

// DAILY REPORT — every day at 4am Orlando (Vercel cron, runs with the PC off)
// a summary of everything the system registered in the last 24h goes to the
// REPORTS WhatsApp group: expenses, payments, fixed/app charges, stream moves,
// new invoices/rides. Ordered by the user 2026-07-25 ("report resumido de tudo
// o que foi feito naquele dia, sempre às 4am, mesmo com o PC fechado").

export const maxDuration = 60

const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export async function GET(req: NextRequest) {
  const db = streamDb()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const lines: string[] = []
  const day = new Date(Date.now() - 4 * 3600 * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  // Expenses registered on invoices
  const { data: exp } = await db.from('invoice_expenses')
    .select('item, price, created_at, invoices(invoice_code)')
    .gte('created_at', since).order('price', { ascending: false })
  if (exp?.length) {
    const total = exp.reduce((s, e: any) => s + (Number(e.price) || 0), 0)
    lines.push(`💸 *${exp.length} expenses* registered (${usd(total)})`)
    for (const e of exp.slice(0, 6) as any[]) {
      lines.push(`  • ${(e.invoices?.invoice_code || '—')} — ${(e.item || '').slice(0, 48)} — ${usd(e.price)}`)
    }
    if (exp.length > 6) lines.push(`  • …and ${exp.length - 6} more`)
  }

  // Payments received
  const { data: pay } = await db.from('invoice_payments')
    .select('amount, created_at, invoices(invoice_code)')
    .gte('created_at', since)
  if (pay?.length) {
    const total = pay.reduce((s, p: any) => s + (Number(p.amount) || 0), 0)
    lines.push(`💰 *${pay.length} payments* received (${usd(total)})`)
  }

  // Fixed costs / APPS charges
  const { data: fx } = await db.from('fixed_cost_expenses')
    .select('amount, created_at, fixed_cost_suppliers(description, cost_type)')
    .gte('created_at', since)
  if (fx?.length) {
    const apps = (fx as any[]).filter(f => f.fixed_cost_suppliers?.cost_type === 'APP')
    const other = (fx as any[]).filter(f => f.fixed_cost_suppliers?.cost_type !== 'APP')
    if (apps.length) lines.push(`📱 *APPS*: ${apps.length} charges (${usd(apps.reduce((s, f) => s + Number(f.amount || 0), 0))}) — ${[...new Set(apps.map(f => f.fixed_cost_suppliers?.description))].join(', ')}`)
    if (other.length) lines.push(`🏭 *Fixed costs*: ${other.length} entries (${usd(other.reduce((s, f) => s + Number(f.amount || 0), 0))})`)
  }

  // STREAM movement
  const { data: st } = await db.from('part_streams')
    .select('item, status, tracking_number, last_event_at, delivered_at, shipped_at')
    .or(`last_event_at.gte.${since},created_at.gte.${since}`)
  if (st?.length) {
    lines.push(`📦 *STREAM*: ${st.length} orders moved`)
    for (const s of (st as any[]).slice(0, 5)) {
      lines.push(`  • ${(s.item || '').slice(0, 44)} → ${s.status}`)
    }
  }

  // New invoices / rides
  const { data: inv } = await db.from('invoices').select('invoice_code').gte('created_at', since)
  if (inv?.length) lines.push(`🧾 *New invoices*: ${inv.map((i: any) => i.invoice_code).join(', ')}`)
  const { data: rid } = await db.from('rides').select('project_code, project_name').gte('created_at', since)
  if (rid?.length) lines.push(`🚗 *New rides*: ${rid.map((r: any) => `${r.project_code} ${r.project_name}`).join(', ')}`)

  const body = lines.length
    ? `📋 *DAILY REPORT — ${day}*\n\n${lines.join('\n')}`
    : `📋 *DAILY REPORT — ${day}*\n\nQuiet day — no new records in the last 24h.`

  await sendStreamWhatsApp(body)
  return NextResponse.json({ ok: true, lines: lines.length })
}
