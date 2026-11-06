// /ca/api/adm/payments — QUOTE PORTAL M5 (06/11/2026). GET: the overview (lib/adminPayments.server.ts). POST, a HUMAN staff login only:
//   {action:'replay', id}                         → the same idempotent handler again (cs:<session> or evt_…)
//   {action:'refund', attempt_id, amount_cents?, confirm}  → a Stripe refund; `confirm` must be the attempt's amount in cents typed back
//   {action:'sync'}                               → re-read the last payouts from Stripe into stripe_payouts (reads only)
// Nothing here sends a message; only REFUND moves money, and only from this explicit tap.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { paymentsOverview, replayEvent, refundAttempt } from '@/lib/adminPayments.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function GET(req: NextRequest) {
  if (!(await requireStaff(req))) return bad('staff only (a human login)', 403)
  try { return NextResponse.json({ ok: true, ...(await paymentsOverview(serviceDb())) }) } catch (e) { return bad(String((e as Error).message || e), 500) }
}

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return bad('staff only (a human login)', 403)
  const b = await req.json().catch(() => ({})) as Record<string, unknown>
  const db = serviceDb()
  try {
    if (b.action === 'replay') return NextResponse.json({ ok: true, result: await replayEvent(db, String(b.id || '')) })
    if (b.action === 'sync') { const { syncRecentPayouts } = await import('@/lib/stripePayouts.server'); return NextResponse.json({ ok: true, result: await syncRecentPayouts(db, 20) }) }
    if (b.action === 'refund') {
      const amt = b.amount_cents == null || b.amount_cents === '' ? null : Number(b.amount_cents)
      if (String(b.confirm || '') !== String(amt ?? 'FULL')) return bad('type the amount in cents (or FULL) to confirm')
      return NextResponse.json({ ok: true, result: await refundAttempt(db, String(b.attempt_id || ''), amt, staff.email) })
    }
    return bad('action = replay | refund | sync')
  } catch (e) { return bad(String((e as Error).message || e), 409) }
}
