import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { stripeConfigured, verifyStripeEvent } from '@/lib/stripe.server'
import { handleStripeEvent } from '@/lib/stripeEvents.server'

// STRIPE → CONTROL APP (06/11/2026). Endpoint https://www.gz28us.com/ca/api/stripe/webhook (www — never the apex: it
// 308-redirects and Stripe treats 3xx as failure). Own endpoint and own signing secret; the shop keeps /shop/api/stripe-webhook.
//
// The discipline, lifted from the shop's webhook and the house laws (map C-88):
//   1. RAW body + `stripe-signature` → constructEvent. Bad signature = 400, nothing recorded.
//   2. Not configured = 503 (fail closed, Stripe retries later).
//   3. IDEMPOTENT by event id: `stripe_events.id` is the primary key. A replay of an event already DONE/IGNORED answers 200
//      without running the handler again; a replay of one that ended in ERROR runs again (that is what the retry is for).
//   4. The handler (lib/stripeEvents.server.ts) decides: DONE · IGNORED · throw → ERROR + 500 so Stripe retries.
//   5. Nothing here messages anyone. Notifications are separate steps behind app_settings keys, OFF by default.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: Request) {
  const cfg = stripeConfigured()
  const d = db()
  if (!cfg.ok || !d) return NextResponse.json({ error: 'not configured', missing: [...cfg.missing, ...(d ? [] : ['SUPABASE_SERVICE_ROLE_KEY'])] }, { status: 503 })

  const sig = req.headers.get('stripe-signature') || ''
  const raw = await req.text()
  let event
  try { event = verifyStripeEvent(raw, sig) } catch { return NextResponse.json({ error: 'bad signature' }, { status: 400 }) }

  // Claim the event id. A duplicate that is already settled is acknowledged and skipped.
  const ins = await d.from('stripe_events').insert({ id: event.id, type: event.type, livemode: event.livemode, status: 'RECEIVED', payload: event as unknown as Record<string, unknown> })
  if (ins.error) {
    if (ins.error.code !== '23505') { console.error('[stripe-webhook] insert', event.id, ins.error.message); return NextResponse.json({ error: 'record failed' }, { status: 500 }) }
    const { data: prev } = await d.from('stripe_events').select('status').eq('id', event.id).maybeSingle()
    if (prev && prev.status !== 'ERROR' && prev.status !== 'RECEIVED') return NextResponse.json({ received: true, duplicate: true, status: prev.status })
  }

  try {
    const r = await handleStripeEvent(event)
    await d.from('stripe_events').update({ status: r.handled ? 'DONE' : 'IGNORED', ref: r.ref ?? null, error: r.note ?? null, processed_at: new Date().toISOString() }).eq('id', event.id)
    return NextResponse.json({ received: true, handled: r.handled })
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 500)
    console.error('[stripe-webhook]', event.type, event.id, msg)
    await d.from('stripe_events').update({ status: 'ERROR', error: msg, processed_at: new Date().toISOString() }).eq('id', event.id)
    return NextResponse.json({ error: 'handler failed — retry' }, { status: 500 })
  }
}
