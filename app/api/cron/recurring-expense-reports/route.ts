import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Vercel cron hits this route once a day (see vercel.json). Authenticates via
// the CRON_SECRET env var; iterates active staff seasons; sends a WhatsApp
// report for each DAILY / WEEKLY / MONTHLY expense whose next period has just
// completed; records each send in expense_reports_sent so we never duplicate.

function todayStr() { return new Date().toISOString().slice(0, 10) }
function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

async function sendWhatsApp(body: string): Promise<{ ok: boolean; detail?: any }> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) {
    return { ok: false, detail: 'UltraMsg env vars not set' }
  }
  try {
    const res = await fetch(`https://api.ultramsg.com/instance${instance}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, to: groupId, body, priority: 10 }),
    })
    const data = await res.json()
    const sent = data?.sent === 'true' || data?.sent === true
    return { ok: sent, detail: data }
  } catch (err: any) {
    return { ok: false, detail: err?.message }
  }
}

export async function GET(req: NextRequest) {
  // Vercel adds Authorization: Bearer ${CRON_SECRET} to cron requests.
  const auth = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const today = todayStr()
  const todayDate = new Date(today + 'T00:00:00')

  // Active seasons: started on or before today, not concluded (or concluded today/later).
  const { data: seasons, error: seasonsErr } = await supabase
    .from('seasons')
    .select('id, season_code, staff_id, date_entry, date_conclusion')
    .lte('date_entry', today)

  if (seasonsErr) {
    return NextResponse.json({ error: 'Failed to load seasons', detail: seasonsErr.message }, { status: 500 })
  }

  const activeSeasons = (seasons || []).filter(s => {
    if (!s.date_entry) return false
    if (!s.date_conclusion) return true
    return s.date_conclusion >= today
  })

  let sent = 0
  let skipped = 0
  let failed = 0
  const log: any[] = []

  for (const season of activeSeasons) {
    const { data: expenses } = await supabase
      .from('expenses')
      .select('id, type, description, amount, source, origin')
      .eq('season_id', season.id)
      .in('type', ['DAILY', 'WEEKLY', 'MONTHLY'])

    if (!expenses || expenses.length === 0) continue

    const startDate = new Date(season.date_entry + 'T00:00:00')
    const diffMs = todayDate.getTime() - startDate.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays < 1) continue // need at least 1 full day elapsed

    const { data: staff } = await supabase.from('staff').select('name').eq('id', season.staff_id).single()
    const staffName = staff?.name || ''

    for (const exp of expenses) {
      let shouldFire = false
      let periodLabel = ''
      let multiplier = 0

      if (exp.type === 'DAILY') {
        // Fires every day. Period = day number since start.
        shouldFire = true
        periodLabel = `Day ${diffDays}`
        multiplier = diffDays
      } else if (exp.type === 'WEEKLY' && diffDays % 7 === 0) {
        // Fires when a full week completes (day 7, 14, 21...).
        const w = diffDays / 7
        shouldFire = true
        periodLabel = `Week ${w}`
        multiplier = w
      } else if (exp.type === 'MONTHLY' && diffDays % 30 === 0) {
        // Fires when a full 30-day month completes (matches the running-total calc).
        const m = diffDays / 30
        shouldFire = true
        periodLabel = `Month ${m}`
        multiplier = m
      }

      if (!shouldFire) { skipped++; continue }

      // Skip if we already sent a report for this expense today.
      const { data: existing } = await supabase
        .from('expense_reports_sent')
        .select('id')
        .eq('expense_id', exp.id)
        .eq('report_date', today)
        .maybeSingle()
      if (existing) { skipped++; continue }

      const amount = Number(exp.amount) || 0
      const runningTotal = amount * multiplier

      const lines: string[] = [
        `*EXPENSE — STAFF — ${exp.type}*`,
        `${season.season_code}${staffName ? ` — ${staffName}` : ''}`,
        `${periodLabel} — ${formatDate(today)} — *${formatUSD(amount)}*`,
      ]
      if (exp.description) lines.push(exp.description)
      if (exp.origin === 'PERSONAL') lines.push('PERSONAL')
      if (exp.source) lines.push(exp.source)
      lines.push('')
      lines.push(`Running total: ${formatUSD(runningTotal)}`)

      const caption = lines.join('\n')

      const { ok, detail } = await sendWhatsApp(caption)
      if (ok) {
        await supabase.from('expense_reports_sent').insert([{
          expense_id: exp.id,
          report_date: today,
        }])
        sent++
      } else {
        failed++
        log.push({ expense_id: exp.id, error: detail })
      }
    }
  }

  return NextResponse.json({
    today,
    activeSeasons: activeSeasons.length,
    sent,
    skipped,
    failed,
    log,
  })
}