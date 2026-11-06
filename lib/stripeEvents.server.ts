/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — what the Control App DOES with Stripe (06/11/2026; blueprint §5.3, §7).
//
// Contract with app/api/stripe/webhook (unchanged): return {handled:true, ref} → DONE · {handled:false} → IGNORED · throw → ERROR
// + HTTP 500 so Stripe retries. BUSINESS refusals never throw: book_payment() WRITES the attempt flip and the PAYMENT_ANOMALY event
// and RETURNS {anomaly} (a raise would roll the trace back) → DONE, 200.
//
// ONE fulfilment claim per Checkout Session: the synthetic stripe_events row `cs:<session>` is claimed by the webhook AND by the
// landing (/api/q/landing) through stripe_claim(); whoever loses sees «in flight / settled» and stops. fulfillCheckout() is a
// PURE function of the observed state (attempt.status, session.payment_status, pi.status) — event types are only triggers.
//
// No robot ever moves client money back (no refunds.create anywhere). Nothing here messages anyone.

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { stripeClient, stripeMode } from './stripe.server'
import { serviceDb, carLabel, PUBLIC_BASE } from './quoteDoc.server'
import { landingToken } from './quotePublic.server'
import { orlandoDay } from './orlando'
import { readSetting } from './appSettings.server'
import { after as nextAfter } from 'next/server'

export type StripeHandled = { handled: boolean; ref?: string | null; note?: string }

export const RAIL_TO_STRIPE: Record<string, ('card' | 'us_bank_account')[]> = { card: ['card'], us_bank_account: ['us_bank_account'] }
const cap = (s: string, n: number) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

async function event(db: SupabaseClient, invoiceId: string, revisionId: string | null, kind: string, actor: string, payload: Record<string, unknown>) {
  await db.rpc('doc_event', { p_invoice: invoiceId, p_revision: revisionId, p_kind: kind, p_actor: actor, p_actor_id: null, p_payload: payload })
}

// ── Customer per mode (clients.stripe_customer_ids {test, live}); never a test id with a live key ─────────────────────────
export async function customerForMode(db: SupabaseClient, client: Record<string, any>): Promise<string> {
  const mode = stripeMode(); if (!mode) throw new Error('stripe not configured')
  const ids = (client.stripe_customer_ids || {}) as Record<string, string>
  if (ids[mode]) return ids[mode]
  const stripe = stripeClient()
  let id: string | null = null
  try {
    const found = await stripe.customers.search({ query: `metadata['client_id']:'${client.id}'` })
    id = found.data[0]?.id || null
  } catch { /* search not available — create */ }
  if (!id) {
    const c = await stripe.customers.create({ name: cap(client.name || 'GZ28 client', 120), metadata: { app: 'control-app', client_id: String(client.id) } },
      { idempotencyKey: `cust:${client.id}:${mode}` })
    id = c.id
  }
  await db.from('clients').update({ stripe_customer_ids: { ...ids, [mode]: id } }).eq('id', client.id)
  return id
}

// ── PAY: one attempt row per Checkout Session (blueprint §5.3) ─────────────────────────────────────────────────────────
export async function openDepositCheckout(db: SupabaseClient, o: {
  invoiceId: string; linkId: string | null; seq: number; rail: 'card' | 'us_bank_account'; livemode: boolean; actor: string
  revision: Record<string, any>; client: Record<string, any> | null; ride: Record<string, any> | null; service: string; lang: 'en' | 'pt'
}): Promise<{ url: string; attemptId: string }> {
  const { data: att, error } = await db.rpc('attempt_open', { p_invoice: o.invoiceId, p_link: o.linkId, p_seq: o.seq, p_rail: o.rail,
    p_provider: 'STRIPE', p_livemode: o.livemode, p_actor: o.actor, p_amount_cents: null })
  if (error) throw new Error(error.message)
  const attempt = att as Record<string, any>
  if (attempt.checkout_session_id) {
    const { data: row } = await db.from('payment_attempts').select('url').eq('id', attempt.id).maybeSingle()
    if (row?.url) return { url: row.url, attemptId: attempt.id }
  }
  const inst = (o.revision.document?.installments || []).find((i: any) => Number(i.seq) === o.seq)
  if (!inst || Number(inst.amount_cents) !== Number(attempt.amount_cents)) throw new Error('installment amount mismatch')
  const n = (o.revision.document?.installments || []).length
  const shortId = String(o.revision.document?.header?.display_code || o.revision.document?.header?.code || '')
  const customer = o.client ? await customerForMode(db, o.client) : undefined
  const word = o.seq === 1 ? 'DEPOSIT' : o.seq === n ? 'BAL' : `INST ${o.seq}`
  const flTaxCents = Math.round(Number(o.revision.fl_tax || 0) * 100)
  const achVerify = (await readSetting<string>('payments.ach_verification')) || 'automatic'
  const stripe = stripeClient()
  const t = landingToken(attempt.id)
  const s = await stripe.checkout.sessions.create({
    mode: 'payment', locale: o.lang === 'pt' ? 'pt-BR' : 'en', ...(customer ? { customer } : {}),
    payment_method_types: RAIL_TO_STRIPE[o.rail],
    payment_method_options: o.rail === 'us_bank_account'
      ? { us_bank_account: { verification_method: achVerify as 'automatic' | 'instant', financial_connections: { permissions: ['payment_method'] } } }
      : { card: { request_three_d_secure: 'automatic' } },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Number(inst.amount_cents),
      product_data: { name: cap(`GZ28 — ${inst.label_text || word} · ${o.service || 'Project'}`, 120),
        description: cap(`${carLabel(o.ride) || 'Parts'} · doc ${shortId} · rev ${o.revision.seq}`, 300) } } }],
    client_reference_id: attempt.id,
    metadata: { app: 'control-app', invoice_id: o.invoiceId, attempt_id: attempt.id, installment_id: String(inst.id), revision_id: String(o.revision.id),
      fl_tax_cents: String(flTaxCents) },
    payment_intent_data: {
      metadata: { app: 'control-app', invoice_id: o.invoiceId, attempt_id: attempt.id, installment_id: String(inst.id) },
      description: cap(`${o.service || 'Project'} — installment ${o.seq}/${n}`, 300),
      ...(o.rail === 'card' ? { statement_descriptor_suffix: word.slice(0, 10) } : {}),
    },
    success_url: `${PUBLIC_BASE}/q/return?t=${encodeURIComponent(t)}`,
    cancel_url: `${PUBLIC_BASE}/q/return?t=${encodeURIComponent(t)}&c=1`,
    expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
    submit_type: 'pay',
    custom_text: { submit: { message: cap(o.lang === 'pt' ? `Sinal do orçamento ${shortId}` : `Deposit on quote ${shortId}`, 1000) } },
  }, { idempotencyKey: `att:${attempt.id}` })
  await db.from('payment_attempts').update({ checkout_session_id: s.id, url: s.url, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null })
    .eq('id', attempt.id)
  await event(db, o.invoiceId, String(o.revision.id), 'CHECKOUT_OPENED', 'CLIENT', { attempt_id: attempt.id, rail: o.rail, seq: o.seq, amount_cents: attempt.amount_cents })
  return { url: s.url!, attemptId: attempt.id }
}

// ── FULFIL: the single choke point (webhook + landing), observed state only ────────────────────────────────────────────
export type FulfilResult = { state: 'booked' | 'repeat' | 'anomaly' | 'processing' | 'failed' | 'noop' | 'in_flight'; detail?: Record<string, unknown> }

export async function claimAndFulfil(db: SupabaseClient, sessionId: string, actor: 'webhook' | 'landing', eventCreatedSec?: number): Promise<FulfilResult> {
  const { data: claimed, error } = await db.rpc('stripe_claim', { p_id: `cs:${sessionId}`, p_type: 'fulfilment', p_livemode: stripeMode() === 'live', p_payload: { session: sessionId, by: actor } })
  if (error) throw new Error('claim: ' + error.message)
  if (!claimed) return { state: 'in_flight' }
  try {
    const r = await fulfillCheckout(db, sessionId, actor, eventCreatedSec)
    await db.from('stripe_events').update({ status: 'DONE', ref: sessionId, error: r.state === 'anomaly' ? JSON.stringify(r.detail).slice(0, 500) : null,
      processed_at: new Date().toISOString() }).eq('id', `cs:${sessionId}`)
    return r
  } catch (e) {
    await db.from('stripe_events').update({ status: 'ERROR', error: String((e as Error)?.message || e).slice(0, 500), processed_at: new Date().toISOString() })
      .eq('id', `cs:${sessionId}`)
    throw e
  }
}

export async function fulfillCheckout(db: SupabaseClient, sessionId: string, actor: string, eventCreatedSec?: number): Promise<FulfilResult> {
  const stripe = stripeClient()
  const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge.balance_transaction'] })
  if (s.metadata?.app !== 'control-app') return { state: 'noop', detail: { reason: 'not a Control App session' } }
  if (s.livemode !== (stripeMode() === 'live')) return { state: 'noop', detail: { reason: 'livemode mismatch' } }
  const attemptId = s.metadata?.attempt_id
  const { data: att } = await db.from('payment_attempts').select('*').eq('id', attemptId).maybeSingle()
  if (!att) return { state: 'noop', detail: { reason: 'attempt not found', attemptId } }
  const pi = (typeof s.payment_intent === 'object' ? s.payment_intent : null) as Stripe.PaymentIntent | null
  const charge = (pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null) as Stripe.Charge | null
  const txn = (charge && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null) as Stripe.BalanceTransaction | null
  const piStatus = pi?.status || null

  if (s.payment_status === 'paid') {
    const isBank = charge?.payment_method_details?.type === 'us_bank_account'
    const paidSec = isBank ? (eventCreatedSec || Math.floor(Date.now() / 1000)) : (charge?.created || Math.floor(Date.now() / 1000))
    const { data: rev } = await db.from('invoice_revisions').select('document').eq('id', att.revision_id).maybeSingle()
    const inst = ((rev?.document?.installments || []) as any[]).find(i => Number(i.seq) === Number(att.seq))
    const money = {
      amount_cents: s.amount_total, currency: s.currency, source: 'STRIPE', paid_on: orlandoDay(paidSec * 1000), payment_status: 'paid',
      fee: txn ? txn.fee / 100 : undefined, net: txn ? txn.net / 100 : undefined, balance_transaction_id: txn?.id,
      charge_id: charge?.id, payment_intent_id: pi?.id, checkout_session_id: s.id, livemode: s.livemode,
      method_type: charge?.payment_method_details?.type, method_last4: charge?.payment_method_details?.card?.last4 || charge?.payment_method_details?.us_bank_account?.last4 || undefined,
      account_holder_type: charge?.payment_method_details?.us_bank_account?.account_holder_type || undefined,
      payment_reference: charge?.id ? `stripe:${charge.id}` : undefined, paid_to: inst?.paid_to,
    }
    const { data, error } = await db.rpc('book_payment', { p_attempt: att.id, p_money: money, p_actor: `stripe:${actor}` })
    if (error) throw new Error('book_payment: ' + error.message)
    const r = data as Record<string, any>
    if (r?.repeat) return { state: 'repeat', detail: r }
    if (r?.unbooked || (r?.anomaly && !r?.income_id)) return { state: 'anomaly', detail: r }
    if (r?.hired) { after(r, att.invoice_id) }
    return { state: 'booked', detail: r }
  }
  if (s.payment_status === 'unpaid' && att.status === 'OPEN' && (piStatus === 'processing' || piStatus === 'requires_action')) {
    const micro = piStatus === 'requires_action'
    await db.from('payment_attempts').update({ status: 'PROCESSING', authorized_at: new Date().toISOString(), payment_intent_id: pi?.id,
      checkout_session_id: s.id, verification: micro ? 'microdeposits' : 'instant' }).eq('id', att.id).eq('status', 'OPEN')
    await event(db, att.invoice_id, att.revision_id, 'DEPOSIT_AUTHORIZED', 'STRIPE', { attempt_id: att.id, verification: micro ? 'microdeposits' : 'instant' })
    return { state: 'processing' }
  }
  if (s.payment_status === 'unpaid' && att.status === 'PROCESSING' && (piStatus === 'requires_payment_method' || piStatus === 'canceled')) {
    const code = pi?.last_payment_error?.code || (piStatus === 'canceled' ? 'canceled' : 'failed')
    await db.from('payment_attempts').update({ status: 'FAILED', failed_at: new Date().toISOString(), failure_code: code }).eq('id', att.id).eq('status', 'PROCESSING')
    await event(db, att.invoice_id, att.revision_id, 'DEPOSIT_FAILED', 'STRIPE', { attempt_id: att.id, failure_code: code })
    return { state: 'failed' }
  }
  return { state: 'noop', detail: { attempt: att.status, payment_status: s.payment_status, pi: piStatus } }
}

// The consequences ladder runs after the money is booked (lib/hire.server); imported lazily to keep this module light.
function after(r: Record<string, any>, invoiceId: string) {
  const run = () => import('./hire.server').then(m => m.afterHire(invoiceId, r)).catch(e => console.error('[hire ladder]', invoiceId, e?.message || e))
  try { nextAfter(run) } catch { void run() }
}

// ── refunds / disputes / payouts (money rows, M1) ───────────────────────────────────────────────────────────────────────
async function attemptByCharge(db: SupabaseClient, chargeId: string | null | undefined, piId?: string | null) {
  if (chargeId) { const { data } = await db.from('payment_attempts').select('*').eq('charge_id', chargeId).maybeSingle(); if (data) return data }
  if (piId) { const { data } = await db.from('payment_attempts').select('*').eq('payment_intent_id', piId).maybeSingle(); if (data) return data }
  return null
}
async function isTestDoc(db: SupabaseClient, invoiceId: string) {
  const { data } = await db.from('quote_links').select('id').eq('invoice_id', invoiceId).eq('is_test', true).limit(1)
  return !!data?.length
}
async function moneyRow(db: SupabaseClient, att: Record<string, any>, amount: number, refundId: string, label: string, daySec: number, chargeId: string) {
  const { data: exists } = await db.from('invoice_incomes').select('id').eq('refund_id', refundId).maybeSingle()
  if (exists) return false
  const muted = await isTestDoc(db, att.invoice_id)
  const noon = orlandoDay(daySec * 1000)
  const { error } = await db.from('invoice_incomes').insert({
    invoice_id: att.invoice_id, amount, description: label, payment_date: noon, paid_at: noonIso(noon),
    source: 'STRIPE', paid_to: 'GZ28US', installment_id: att.installment_id, attempt_id: att.id, refund_id: refundId,
    payment_reference: `stripe:${chargeId}`, reported_at: muted ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  })
  if (error && !/duplicate key/i.test(error.message)) throw new Error('money row: ' + error.message)
  return !error
}
const noonIso = (day: string) => {
  // noon in Orlando of `day`, offset computed by Intl (DST-safe)
  const probe = new Date(`${day}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(probe)
  const off = (parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5').replace('GMT', '') || '-5'
  const h = Number(off.split(':')[0]) || -5
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12 - h, 0, 0)).toISOString()
}

export async function bookRefunds(db: SupabaseClient, charge: Stripe.Charge, eventSec: number): Promise<StripeHandled> {
  const att = await attemptByCharge(db, charge.id, typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id)
  if (!att) return { handled: false, note: 'not a Control App charge' }
  if (!att.income_id) { await event(db, att.invoice_id, att.revision_id, 'REFUND_PENDING', 'STRIPE', { attempt_id: att.id, note: 'no income booked' }); return { handled: true, ref: att.id } }
  const list = await stripeClient().refunds.list({ charge: charge.id, limit: 100 })
  let n = 0
  for (const re of list.data) {
    if (re.status !== 'succeeded') continue
    const day = orlandoDay((re.created || eventSec) * 1000)
    const { data: exists } = await db.from('invoice_incomes').select('id').eq('refund_id', re.id).maybeSingle()
    if (exists) continue
    const muted = await isTestDoc(db, att.invoice_id)
    const { error } = await db.from('invoice_incomes').insert({
      invoice_id: att.invoice_id, amount: -(re.amount / 100), description: `Refund — installment ${att.seq ?? ''}`.trim(), payment_date: day, paid_at: noonIso(day),
      source: 'STRIPE', paid_to: 'GZ28US', installment_id: att.installment_id, attempt_id: att.id, refund_id: re.id, payment_reference: `stripe:${charge.id}`,
      reported_at: muted ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
    })
    if (error && !/duplicate key/i.test(error.message)) throw new Error('refund row: ' + error.message)
    if (!error) { n++; await event(db, att.invoice_id, att.revision_id, 'REFUNDED', 'STRIPE', { attempt_id: att.id, refund_id: re.id, amount_cents: re.amount }) }
  }
  const refunded = charge.amount_refunded >= charge.amount
  await db.from('payment_attempts').update({ status: refunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refund_ids: list.data.map(r => r.id) }).eq('id', att.id)
  return { handled: true, ref: att.id, note: `${n} refund row(s)` }
}

export async function bookDispute(db: SupabaseClient, d: Stripe.Dispute, type: string, eventSec: number): Promise<StripeHandled> {
  const chargeId = typeof d.charge === 'string' ? d.charge : d.charge?.id
  const att = await attemptByCharge(db, chargeId, typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id)
  if (!att) return { handled: false, note: 'not a Control App charge' }
  const day = orlandoDay(eventSec * 1000)
  const muted = await isTestDoc(db, att.invoice_id)
  const row = async (amount: number, refundId: string, label: string) => {
    const { data: exists } = await db.from('invoice_incomes').select('id').eq('refund_id', refundId).maybeSingle()
    if (exists || !att.income_id) return
    const { error } = await db.from('invoice_incomes').insert({ invoice_id: att.invoice_id, amount, description: label, payment_date: day, paid_at: noonIso(day),
      source: 'STRIPE', paid_to: 'GZ28US', installment_id: att.installment_id, attempt_id: att.id, refund_id: refundId, payment_reference: `stripe:${chargeId}`,
      reported_at: muted ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    if (error && !/duplicate key/i.test(error.message)) throw new Error('dispute row: ' + error.message)
  }
  if (type === 'charge.dispute.created') {
    await row(-(d.amount / 100), d.id, `Chargeback (dispute) — installment ${att.seq ?? ''}`.trim())
    await db.from('payment_attempts').update({ status: 'DISPUTED', dispute_id: d.id }).eq('id', att.id)
    // M4: the dispute FEE (Stripe withdraws it with the funds — US$ 15 today) is a real cash-out: one MONEY expense per balance transaction
    // that carries a fee, same shape and uniqueness as the processing-fee row (order_number = txn id). Test money writes no fee row.
    if (!muted) for (const bt of (d.balance_transactions || []) as Stripe.BalanceTransaction[]) {
      if (!(bt?.fee > 0)) continue
      const { error: fe } = await db.rpc('stripe_fee_row', { p_invoice: att.invoice_id, p_money: { fee: bt.fee / 100, balance_transaction_id: bt.id, paid_on: day, payment_reference: `stripe:${chargeId}` },
        p_label: `dispute fee (chargeback ${d.id}) — installment ${att.seq ?? ''}`.trim() })
      if (fe) throw new Error('dispute fee row: ' + fe.message)
    }
    await event(db, att.invoice_id, att.revision_id, 'DISPUTE_OPENED', 'STRIPE', { attempt_id: att.id, dispute_id: d.id, reason: d.reason, amount_cents: d.amount,
      due_by: d.evidence_details?.due_by ? orlandoDay(d.evidence_details.due_by * 1000) : null })
  } else if (type === 'charge.dispute.funds_reinstated' || (type === 'charge.dispute.closed' && d.status === 'won')) {
    await row(d.amount / 100, `${d.id}:reinstated`, `Chargeback reversed (dispute won) — installment ${att.seq ?? ''}`.trim())
    await event(db, att.invoice_id, att.revision_id, 'DISPUTE_CLOSED', 'STRIPE', { attempt_id: att.id, dispute_id: d.id, status: d.status })
  } else {
    await event(db, att.invoice_id, att.revision_id, type === 'charge.dispute.closed' ? 'DISPUTE_CLOSED' : 'DISPUTE_UPDATED', 'STRIPE', { attempt_id: att.id, dispute_id: d.id, status: d.status })
  }
  return { handled: true, ref: att.id }
}

export async function payoutPaid(db: SupabaseClient, p: Stripe.Payout): Promise<StripeHandled> {
  // M5: the whole payout is mirrored in stripe_payouts (members for the Bank Link MIXED match); M1's payout_id link stays inside it
  try {
    const { syncPayout } = await import('./stripePayouts.server')
    const r = await syncPayout(db, p)
    return r.members ? { handled: true, ref: p.id, note: `${r.members} member(s) · net ${r.net} · unresolved ${r.unresolved}` } : { handled: false, note: 'no Control App money in payout' }
  } catch (e) { console.error('[payout sync]', p.id, (e as Error).message) }
  const ids: string[] = []
  for await (const bt of stripeClient().balanceTransactions.list({ payout: p.id, type: 'charge', limit: 100 })) ids.push(bt.id)
  if (!ids.length) return { handled: false, note: 'no charges in payout' }
  const { data } = await db.from('payment_attempts').update({ payout_id: p.id }).in('balance_transaction_id', ids).select('id')
  return data?.length ? { handled: true, ref: p.id, note: `${data.length} attempt(s) linked` } : { handled: false, note: 'no Control App charge in payout' }
}

// ── the webhook dispatcher ─────────────────────────────────────────────────────────────────────────────────────────────
export async function handleStripeEvent(ev: Stripe.Event): Promise<StripeHandled> {
  if (ev.livemode !== (stripeMode() === 'live')) return { handled: false, note: 'livemode mismatch' }
  const db = serviceDb()
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const s = ev.data.object as Stripe.Checkout.Session
      if (s.metadata?.app !== 'control-app') return { handled: false, note: 'session not from the Control App' }
      const r = await claimAndFulfil(db, s.id, 'webhook', ev.created)
      return { handled: true, ref: s.id, note: r.state === 'in_flight' ? 'duplicate (claimed elsewhere)' : r.state }
    }
    case 'checkout.session.expired': {
      const s = ev.data.object as Stripe.Checkout.Session
      if (s.metadata?.app !== 'control-app') return { handled: false, note: 'session not from the Control App' }
      await db.from('payment_attempts').update({ status: 'EXPIRED' }).eq('checkout_session_id', s.id).eq('status', 'OPEN')
      return { handled: true, ref: s.id, note: 'expired' }
    }
    case 'charge.refunded': return bookRefunds(db, ev.data.object as Stripe.Charge, ev.created)
    case 'refund.updated':
    case 'refund.failed': {
      const re = ev.data.object as Stripe.Refund
      const chargeId = typeof re.charge === 'string' ? re.charge : re.charge?.id
      if (!chargeId) return { handled: false }
      const att = await attemptByCharge(db, chargeId)
      if (!att) return { handled: false, note: 'not a Control App charge' }
      if (re.status === 'succeeded') return bookRefunds(db, await stripeClient().charges.retrieve(chargeId), ev.created)
      if (re.status === 'failed' || ev.type === 'refund.failed') {
        const { data: neg } = await db.from('invoice_incomes').select('id').eq('refund_id', re.id).maybeSingle()
        if (neg) await moneyRow(db, att, re.amount / 100, `${re.id}:reversal`, `Refund failed — reversed`, ev.created, chargeId)
        await event(db, att.invoice_id, att.revision_id, 'REFUND_FAILED', 'STRIPE', { attempt_id: att.id, refund_id: re.id })
        return { handled: true, ref: att.id }
      }
      return { handled: false, note: `refund ${re.status}` }
    }
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
    case 'charge.dispute.closed':
      return bookDispute(db, ev.data.object as Stripe.Dispute, ev.type, ev.created)
    case 'payout.paid': return payoutPaid(db, ev.data.object as Stripe.Payout)
    case 'payout.failed': {   // M5: mirrored as failed; the Regions credit never comes — /adm/payments shows it
      const { syncPayout } = await import('./stripePayouts.server')
      const r = await syncPayout(db, ev.data.object as Stripe.Payout)
      return { handled: r.members > 0, ref: r.id, note: 'payout failed' }
    }
    default: return { handled: false }
  }
}
