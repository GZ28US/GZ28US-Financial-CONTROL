import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Vercel cron hits this route once a day (see vercel.json). Authenticates via
// the CRON_SECRET env var. Two passes:
//   1) Active staff seasons → fire DAILY / WEEKLY / MONTHLY expense reports;
//      records each send in expense_reports_sent so we never duplicate.
//   2) invoice_payments rows that are past-due (payment_date <= today) AND
//      still UNPAID (paid_at IS NULL) AND not yet alerted (delayed_alert_sent_at
//      IS NULL) → fire one ⚠ DELAYED PAYMENT WhatsApp alert each, then stamp
//      delayed_alert_sent_at so the alert never repeats.

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

  // ============================================================
  // PASS 1 — DAILY / WEEKLY / MONTHLY STAFF EXPENSE REPORTS
  // ============================================================
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

  let staffSent = 0
  let staffSkipped = 0
  let staffFailed = 0
  const staffLog: any[] = []

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
        shouldFire = true
        periodLabel = `Day ${diffDays}`
        multiplier = diffDays
      } else if (exp.type === 'WEEKLY' && diffDays % 7 === 0) {
        const w = diffDays / 7
        shouldFire = true
        periodLabel = `Week ${w}`
        multiplier = w
      } else if (exp.type === 'MONTHLY' && diffDays % 30 === 0) {
        const m = diffDays / 30
        shouldFire = true
        periodLabel = `Month ${m}`
        multiplier = m
      }

      if (!shouldFire) { staffSkipped++; continue }

      // Skip if we already sent a report for this expense today.
      const { data: existing } = await supabase
        .from('expense_reports_sent')
        .select('id')
        .eq('expense_id', exp.id)
        .eq('report_date', today)
        .maybeSingle()
      if (existing) { staffSkipped++; continue }

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
        staffSent++
      } else {
        staffFailed++
        staffLog.push({ expense_id: exp.id, error: detail })
      }
    }
  }

  // ============================================================
  // PASS 2 — DELAYED INVOICE PAYMENTS
  // ============================================================
  // Find all payments that are past their scheduled payment_date, still UNPAID,
  // and haven't been alerted yet. One ⚠ alert per row, then stamp
  // delayed_alert_sent_at so it never repeats.
  const { data: delayed, error: delayedErr } = await supabase
    .from('invoice_payments')
    .select('id, invoice_id, amount, payment_date, source, description')
    .is('paid_at', null)
    .is('delayed_alert_sent_at', null)
    .not('payment_date', 'is', null)
    .lte('payment_date', today)

  let delayedSent = 0
  let delayedFailed = 0
  const delayedLog: any[] = []

  if (delayedErr) {
    delayedLog.push({ error: 'Failed to load delayed payments', detail: delayedErr.message })
  } else if (delayed && delayed.length > 0) {
    // Cache invoices, rides, and clients to avoid refetching for batches that
    // share an invoice or owner.
    const invoiceCache = new Map<string, any>()
    const rideCache = new Map<string, any>()
    const clientCache = new Map<string, any>()

    for (const p of delayed) {
      if (!p.invoice_id) continue

      let invoice = invoiceCache.get(p.invoice_id)
      if (!invoice) {
        const { data: inv } = await supabase
          .from('invoices')
          .select('id, invoice_code, ride_id, client_id')
          .eq('id', p.invoice_id)
          .single()
        if (!inv) { delayedFailed++; delayedLog.push({ payment_id: p.id, error: 'invoice not found' }); continue }
        invoice = inv
        invoiceCache.set(p.invoice_id, inv)
      }

      // Build the owner label: project name for a ride invoice, client name for
      // a personal-client invoice. Falls back to just the invoice_code if
      // neither side is set.
      let ownerLabel = ''
      if (invoice.ride_id) {
        let ride = rideCache.get(invoice.ride_id)
        if (!ride) {
          const { data: r } = await supabase
            .from('rides')
            .select('project_code, project_name')
            .eq('id', invoice.ride_id)
            .single()
          ride = r || {}
          rideCache.set(invoice.ride_id, ride)
        }
        ownerLabel = ride.project_name || ride.project_code || ''
      } else if (invoice.client_id) {
        let client = clientCache.get(invoice.client_id)
        if (!client) {
          const { data: c } = await supabase
            .from('clients')
            .select('name')
            .eq('id', invoice.client_id)
            .single()
          client = c || {}
          clientCache.set(invoice.client_id, client)
        }
        ownerLabel = client.name || ''
      }

      const amount = Number(p.amount) || 0
      const lines: string[] = [
        '*⚠ DELAYED PAYMENT*',
        `${invoice.invoice_code || '—'}${ownerLabel ? ` — ${ownerLabel}` : ''}`,
        `Due: ${formatDate(p.payment_date)} — *${formatUSD(amount)}*`,
      ]
      if (p.description) lines.push(p.description)
      if (p.source) lines.push(p.source)

      const caption = lines.join('\n')

      const { ok, detail } = await sendWhatsApp(caption)
      if (ok) {
        await supabase
          .from('invoice_payments')
          .update({ delayed_alert_sent_at: new Date().toISOString() })
          .eq('id', p.id)
        delayedSent++
      } else {
        delayedFailed++
        delayedLog.push({ payment_id: p.id, error: detail })
      }
    }
  }

  return NextResponse.json({
    today,
    staff: {
      activeSeasons: activeSeasons.length,
      sent: staffSent,
      skipped: staffSkipped,
      failed: staffFailed,
      log: staffLog,
    },
    delayedPayments: {
      candidates: delayed?.length || 0,
      sent: delayedSent,
      failed: delayedFailed,
      log: delayedLog,
    },
  })
}
