import { NextRequest, NextResponse } from 'next/server'
import { streamDb, sendStreamWhatsApp } from '@/lib/stream.server'

// DAILY MEGA-REPORT — every day at 4am Orlando (Vercel cron, runs with the PC
// off) the REPORTS WhatsApp group gets the company's whole day: development
// highlights (daily_log), money in/out with the day's net, Staff Duties,
// registrations, STREAM and APPS. Ordered by the user 2026-07-25.

export const maxDuration = 60

const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export async function GET(_req: NextRequest) {
  const db = streamDb()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const sinceDay = since.slice(0, 10)
  const day = new Date(Date.now() - 4 * 3600 * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const lines: string[] = []

  // ── DEV — session highlights logged by the assistant (best-effort table).
  try {
    const { data: dev } = await db.from('daily_log').select('line').gte('created_at', since).order('created_at')
    if (dev?.length) {
      lines.push('🖥 *DEVELOPMENT / WORK DONE*')
      for (const d of dev as any[]) lines.push(`  • ${String(d.line).slice(0, 90)}`)
      lines.push('')
    }
  } catch { /* table may not exist yet */ }

  // ── MONEY IN — payments received.
  const { data: pay } = await db.from('invoice_payments')
    .select('amount, invoices(invoice_code)')
    .gte('created_at', since)
  const inTotal = (pay || []).reduce((s, p: any) => s + (Number(p.amount) || 0), 0)

  // ── MONEY OUT — everything PAID in the window (by payment date).
  const { data: paidExp } = await db.from('invoice_expenses')
    .select('item, price, invoices(invoice_code)')
    .gte('payment_date', sinceDay)
  const { data: paidFix } = await db.from('fixed_cost_expenses')
    .select('amount, fixed_cost_suppliers(description, cost_type)')
    .gte('payment_date', sinceDay)
  const { data: paidStaff } = await db.from('expenses')
    .select('amount, description')
    .gte('payment_date', sinceDay)
  const outExp = (paidExp || []).reduce((s, e: any) => s + (Number(e.price) || 0), 0)
  const outFix = (paidFix || []).reduce((s, e: any) => s + (Number(e.amount) || 0), 0)
  const outStaff = (paidStaff || []).reduce((s, e: any) => s + (Number(e.amount) || 0), 0)
  const outTotal = outExp + outFix + outStaff

  lines.push('💰 *MONEY FLOW*')
  lines.push(`  IN: ${usd(inTotal)}${pay?.length ? ` (${pay.length} payments)` : ''}`)
  lines.push(`  OUT: ${usd(outTotal)} (invoices ${usd(outExp)} · fixed/apps ${usd(outFix)} · staff ${usd(outStaff)})`)
  lines.push(`  NET: ${inTotal - outTotal >= 0 ? '🟢' : '🔴'} ${usd(inTotal - outTotal)}`)
  lines.push('')

  // ── STAFF DUTIES — completed and opened in the window.
  const { data: dutyDone } = await db.from('invoice_duties')
    .select('description, staff(name), invoices(invoice_code)')
    .eq('done', true).gte('updated_at', since)
  const { data: dutyNew } = await db.from('invoice_duties')
    .select('description, staff(name), invoices(invoice_code)')
    .gte('created_at', since)
  if (dutyDone?.length || dutyNew?.length) {
    lines.push('👷 *STAFF DUTIES*')
    for (const d of (dutyDone || []).slice(0, 6) as any[]) lines.push(`  ✅ ${(d.staff?.name || '—')} — ${(d.description || '').slice(0, 55)} (${d.invoices?.invoice_code || '—'})`)
    if ((dutyDone || []).length > 6) lines.push(`  ✅ …and ${(dutyDone || []).length - 6} more done`)
    if (dutyNew?.length) lines.push(`  🆕 ${dutyNew.length} new duties opened`)
    lines.push('')
  }

  // ── REGISTRATIONS — expenses recorded on invoices (regardless of paid).
  const { data: exp } = await db.from('invoice_expenses')
    .select('item, price, invoices(invoice_code)')
    .gte('created_at', since).order('price', { ascending: false })
  if (exp?.length) {
    const total = exp.reduce((s, e: any) => s + (Number(e.price) || 0), 0)
    lines.push(`🧾 *${exp.length} expenses registered* (${usd(total)})`)
    for (const e of (exp as any[]).slice(0, 5)) lines.push(`  • ${(e.invoices?.invoice_code || '—')} — ${(e.item || '').slice(0, 45)} — ${usd(e.price)}`)
    if (exp.length > 5) lines.push(`  • …and ${exp.length - 5} more`)
    lines.push('')
  }

  // ── APPS charges captured.
  const apps = ((paidFix || []) as any[]).filter((f) => f.fixed_cost_suppliers?.cost_type === 'APP')
  if (apps.length) {
    lines.push(`📱 *APPS*: ${apps.length} charges (${usd(apps.reduce((s, f) => s + Number(f.amount || 0), 0))}) — ${[...new Set(apps.map((f) => f.fixed_cost_suppliers?.description))].join(', ')}`)
    lines.push('')
  }

  // ── STREAM movement: MORTO (STREAM LEGADO MORTO, NÃO APAGADO (Márcio, 30/ago/2026): "quero ele) — o
  // quadro velho não recebe mais movimento; o status dos itens vive na origem.

  // ── New invoices / rides.
  const { data: inv } = await db.from('invoices').select('invoice_code').gte('created_at', since)
  if (inv?.length) lines.push(`🧾 *New invoices*: ${(inv as any[]).map((i) => i.invoice_code).join(', ')}`)
  const { data: rid } = await db.from('rides').select('project_code, project_name').gte('created_at', since)
  if (rid?.length) lines.push(`🚗 *New rides*: ${(rid as any[]).map((r) => `${r.project_code} ${r.project_name}`).join(', ')}`)

  // First-ever edition (Jul 26, 2026) opens with a presentation; self-expires.
  const isFirstRun = new Date().toISOString().slice(0, 10) === '2026-07-26'
  const intro = isFirstRun
    ? `👋 *Bom dia! Este é o novo DAILY MEGA-REPORT da GZ28US.*\nA partir de hoje, todos os dias às 4am, este grupo recebe o resumo completo do dia da empresa: desenvolvimento no sistema, entradas e saídas de dinheiro com o saldo do dia, Staff Duties, registros, pedidos em trânsito (STREAM) e cobranças de APPS. Tudo automático, direto do Control App.\n\n`
    : ''
  const body = `${intro}📋 *DAILY MEGA-REPORT — ${day}*\n\n${lines.join('\n').trim() || 'Quiet day — no activity recorded.'}`
  await sendStreamWhatsApp(body)
  return NextResponse.json({ ok: true, lines: lines.length })
}
