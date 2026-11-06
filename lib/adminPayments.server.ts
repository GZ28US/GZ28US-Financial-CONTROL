/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — /ca/adm/payments (QUOTE PORTAL M5, 06/11/2026; blueprint §2.2, §7.2, §7.5). What the money robots did and what waits:
//   payouts (stripe_payouts; late = no Regions line 7 calendar days after arrival) · attempts · stale PROCESSING (> 10 days) ·
//   stripe_events in ERROR / stuck PROCESSING (REPLAY = the same idempotent handlers again) · STRIPE incomes not yet in a payout ·
//   is_test artefacts. REFUND: a STAFF tap only — never automatic (§7.1 #10) — stripe.refunds.create with Idempotency-Key
//   re:<attempt>:<n>; the money row is booked by the existing charge.refunded handler (refunds.list → one negative row per re_).
//   us_bank_account: full refund only (the amount field is hidden on the page and refused here).
import type { SupabaseClient } from '@supabase/supabase-js'
import { stripeClient, stripeMode } from './stripe.server'
import { orlandoToday } from './orlando'

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

export async function paymentsOverview(db: SupabaseClient) {
  const today = orlandoToday()
  const [po, at, ev, tl] = await Promise.all([
    db.from('stripe_payouts').select('id, amount, arrival_date, status, livemode, members, members_net, unresolved_amount, bank_transaction_id, matched_at, failure_code, synced_at').order('arrival_date', { ascending: false }).limit(40),
    db.from('payment_attempts').select('id, invoice_id, seq, provider, rail, status, amount_cents, livemode, created_at, succeeded_at, failed_at, failure_code, verification, payout_id, refund_ids, dispute_id, method_type, payment_intent_id').order('created_at', { ascending: false }).limit(80),
    db.from('stripe_events').select('id, type, status, error, attempts, locked_at, received_at, processed_at').in('status', ['ERROR', 'PROCESSING', 'RECEIVED']).order('received_at', { ascending: false }).limit(60),
    db.from('quote_links').select('id, invoice_id, created_at, revoked_at').eq('is_test', true),
  ])
  for (const [n, r] of [['payouts', po], ['attempts', at], ['events', ev], ['test links', tl]] as const) if (r.error) throw new Error(`${n}: ${r.error.message}`)
  const testInv = new Set((tl.data || []).map(l => l.invoice_id))
  const invIds = [...new Set((at.data || []).map(a => a.invoice_id))]
  const { data: invs } = invIds.length ? await db.from('invoices').select('id, invoice_code').in('id', invIds) : { data: [] as any[] }
  const code = new Map((invs || []).map(i => [i.id, i.invoice_code]))
  const attempts = (at.data || []).map(a => ({ ...a, code: code.get(a.invoice_id) || null, is_test: testInv.has(a.invoice_id) }))
  const staleCut = new Date(Date.now() - 10 * 864e5).toISOString()
  const { data: unl } = await db.from('invoice_incomes').select('id, invoice_id, amount, paid_at, attempt_id, payment_reference').eq('source', 'STRIPE').not('paid_at', 'is', null).not('attempt_id', 'is', null).limit(500)
  const unAtt = (unl || []).map(i => i.attempt_id)
  const { data: unA } = unAtt.length ? await db.from('payment_attempts').select('id, payout_id, livemode').in('id', unAtt) : { data: [] as any[] }
  const attById = new Map((unA || []).map(a => [a.id, a]))
  const unlinked = (unl || []).filter(i => { const a = attById.get(i.attempt_id); return a && a.livemode && !a.payout_id && !testInv.has(i.invoice_id) })
  const stuckCut = new Date(Date.now() - 2 * 60e3).toISOString()
  return {
    mode: stripeMode(), today,
    payouts: (po.data || []).map(p => ({ ...p, members: Array.isArray(p.members) ? p.members.length : 0,
      late: !p.bank_transaction_id && p.status === 'paid' && p.arrival_date < addDays(today, -7), ours: Array.isArray(p.members) && p.members.length > 0 })),
    attempts,
    stale: attempts.filter(a => a.status === 'PROCESSING' && a.created_at < staleCut),
    events: (ev.data || []).filter(e => e.status === 'ERROR' || (e.status === 'PROCESSING' && (!e.locked_at || e.locked_at < stuckCut)) || (e.status === 'RECEIVED' && e.received_at < stuckCut)),
    unlinked,
    test: { links: (tl.data || []).filter(l => !l.revoked_at).length, documents: testInv.size },
  }
}

// REPLAY: the same idempotent path again. cs:<session> → claim + fulfil; evt_… → the event from Stripe → the dispatcher.
export async function replayEvent(db: SupabaseClient, id: string) {
  const { claimAndFulfil, handleStripeEvent } = await import('./stripeEvents.server')
  if (id.startsWith('cs:')) {
    await db.from('stripe_events').update({ status: 'ERROR' }).eq('id', id).eq('status', 'PROCESSING')   // a stuck claim becomes claimable again
    return claimAndFulfil(db, id.slice(3), 'webhook')
  }
  if (!/^evt_/.test(id)) throw new Error('unknown event id')
  const ev = await stripeClient().events.retrieve(id)
  const r = await handleStripeEvent(ev)
  await db.from('stripe_events').update({ status: r.handled ? 'DONE' : 'IGNORED', error: null, processed_at: new Date().toISOString() }).eq('id', id)
  return r
}

// REFUND — staff only, explicit amount (or the whole charge). Never called by a robot.
export async function refundAttempt(db: SupabaseClient, attemptId: string, amountCents: number | null, actor: string) {
  const { data: a } = await db.from('payment_attempts').select('*').eq('id', attemptId).maybeSingle()
  if (!a) throw new Error('attempt not found')
  if (a.provider !== 'STRIPE' || !['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(a.status) || !a.payment_intent_id) throw new Error('only a paid Stripe payment can be refunded here')
  const live = stripeMode() === 'live'
  if (!!a.livemode !== live) throw new Error(`this payment is ${a.livemode ? 'live' : 'test'} money and the server key is ${live ? 'live' : 'test'} — refused`)
  // what is still refundable = the charge minus what Stripe already refunded (read from Stripe, not guessed)
  const pi = await stripeClient().paymentIntents.retrieve(a.payment_intent_id, { expand: ['latest_charge'] })
  const ch: any = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null
  const full = Number(a.amount_cents) - Number(ch?.amount_refunded || 0)
  if (!(full > 0)) throw new Error('nothing left to refund on this payment')
  if (a.method_type === 'us_bank_account' && amountCents != null && amountCents !== full) throw new Error('bank (ACH) payments are refunded in full only (what is left: ' + (full / 100).toFixed(2) + ')')
  const amt = amountCents == null ? full : Math.round(amountCents)
  if (!(amt > 0) || amt > full) throw new Error('amount must be > 0 and ≤ the payment')
  const n = (Array.isArray(a.refund_ids) ? a.refund_ids.length : 0) + 1
  const re = await stripeClient().refunds.create({ payment_intent: a.payment_intent_id, amount: amt, metadata: { app: 'control-app', attempt_id: a.id, by: actor.slice(0, 80) } },
    { idempotencyKey: `re:${a.id}:${n}` })
  await db.rpc('doc_event', { p_invoice: a.invoice_id, p_revision: a.revision_id, p_kind: 'REFUND_PENDING', p_actor: 'STAFF', p_actor_id: actor,
    p_payload: { attempt_id: a.id, refund_id: re.id, amount_cents: amt, status: re.status } })
  return { refund_id: re.id, status: re.status, amount_cents: amt }
}
