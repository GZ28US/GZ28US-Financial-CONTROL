// POST /ca/api/stripe/payouts/sync — QUOTE PORTAL M5 (06/11/2026; blueprint §2.3). A HUMAN staff login re-reads the account's last payouts
// from Stripe into stripe_payouts (lib/stripePayouts.server.ts). Reads Stripe, writes only the mirror; never moves money, never sends.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { syncRecentPayouts } from '@/lib/stripePayouts.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!(await requireStaff(req))) return NextResponse.json({ error: 'staff only (a human login)' }, { status: 403 })
  const b = await req.json().catch(() => ({})) as { limit?: number }
  try { return NextResponse.json({ ok: true, result: await syncRecentPayouts(serviceDb(), Number(b.limit) || 20) }) }
  catch (e) { return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 }) }
}
