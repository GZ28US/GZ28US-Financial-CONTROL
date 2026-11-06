/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — STRIPE PAYOUTS → stripe_payouts (QUOTE PORTAL M5, 06/11/2026; blueprint §7.5, v1 §7.5). READS Stripe, never moves money.
// syncPayout(): balanceTransactions.list({payout, expand:['data.source']}) → for every transaction, the Control App row that is it:
//   charge / payment (ch_ / py_)  → the income (payment_attempts.charge_id → income_id) + our fee expense (order_number = txn id)
//   refund (re_)                  → the negative income (invoice_incomes.refund_id = re_)
//   adjustment (dispute, dp_)     → the negative income (refund_id = dp_ / dp_:reinstated) + the dispute-fee expense (order_number = txn id)
//   anything else, or a charge that is not ours (shop sales on the shared account) → unresolved_amount (its net)
// members_net = Σ incomes − Σ expenses of the members; a payout with unresolved_amount 0 and members_net = amount is what the Bank Link
// PAYOUT engine may match to a Regions credit. payment_attempts.payout_id is written for the charges found (the M1 link, kept).
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { stripeClient } from './stripe.server'

const r2 = (n: number) => Math.round(n * 100) / 100
const ymd = (sec: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(sec * 1000))

export type PayoutMember = { table: 'invoice_incomes' | 'invoice_expenses'; id: string }

export async function syncPayout(db: SupabaseClient, p: Stripe.Payout): Promise<{ id: string; members: number; unresolved: number; net: number }> {
  const stripe = stripeClient()
  const bts: Stripe.BalanceTransaction[] = []
  for await (const bt of stripe.balanceTransactions.list({ payout: p.id, limit: 100, expand: ['data.source'] })) bts.push(bt)
  const members: PayoutMember[] = []
  const summary: any[] = []
  let unresolved = 0, net = 0
  const chargeIds: string[] = []
  for (const bt of bts) {
    if (bt.type === 'payout') continue
    const src: any = bt.source
    const sid = typeof src === 'string' ? src : src?.id || ''
    const row = { id: bt.id, type: bt.type, source: sid, amount: bt.amount / 100, fee: bt.fee / 100, net: bt.net / 100, ours: false }
    let ours = false
    if (bt.type === 'charge' || bt.type === 'payment') {
      const { data: att } = await db.from('payment_attempts').select('id, income_id').eq('charge_id', sid).maybeSingle()
      if (att?.income_id) {
        const { data: inc } = await db.from('invoice_incomes').select('id, amount').eq('id', att.income_id).maybeSingle()
        if (inc) { members.push({ table: 'invoice_incomes', id: inc.id }); net += Number(inc.amount); ours = true; chargeIds.push(sid) }
        if (ours && bt.fee > 0) {
          const { data: fee } = await db.from('invoice_expenses').select('id, price').eq('order_number', bt.id).eq('payment_method', 'STRIPE').maybeSingle()
          if (fee) { members.push({ table: 'invoice_expenses', id: fee.id }); net -= Number(fee.price) } else { ours = false; members.pop(); net -= Number(inc!.amount) }   // fee row missing → not resolvable yet
        }
      }
    } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
      const { data: inc } = await db.from('invoice_incomes').select('id, amount').eq('refund_id', sid).maybeSingle()
      if (inc) { members.push({ table: 'invoice_incomes', id: inc.id }); net += Number(inc.amount); ours = true }
    } else if (bt.type === 'adjustment' && /^dp_/.test(sid)) {
      const { data: incs } = await db.from('invoice_incomes').select('id, amount, refund_id').in('refund_id', [sid, `${sid}:reinstated`])
      const pick = (incs || []).find(i => (bt.amount < 0 ? Number(i.amount) < 0 : Number(i.amount) > 0))
      if (pick) {
        members.push({ table: 'invoice_incomes', id: pick.id }); net += Number(pick.amount); ours = true
        if (bt.fee > 0) {
          const { data: fee } = await db.from('invoice_expenses').select('id, price').eq('order_number', bt.id).eq('payment_method', 'STRIPE').maybeSingle()
          if (fee) { members.push({ table: 'invoice_expenses', id: fee.id }); net -= Number(fee.price) } else { ours = false; members.pop(); net -= Number(pick.amount) }
        }
      }
    }
    row.ours = ours
    if (!ours) unresolved += bt.net / 100
    summary.push(row)
  }
  const rec = { id: p.id, amount: r2(p.amount / 100), currency: p.currency, arrival_date: ymd(p.arrival_date), status: p.status, livemode: p.livemode,
    balance_transactions: summary, members, members_net: r2(net), unresolved_amount: r2(unresolved), failure_code: (p as any).failure_code || null, synced_at: new Date().toISOString() }
  const { error } = await db.from('stripe_payouts').upsert(rec, { onConflict: 'id' })
  if (error) throw new Error('stripe_payouts: ' + error.message)
  if (chargeIds.length) await db.from('payment_attempts').update({ payout_id: p.id }).in('charge_id', chargeIds)
  return { id: p.id, members: members.length, unresolved: rec.unresolved_amount, net: rec.members_net }
}

// The staff SYNC: the last `limit` payouts of the account (in the key's mode), each re-read. Idempotent.
export async function syncRecentPayouts(db: SupabaseClient, limit = 20) {
  const out: any[] = []
  const list = await stripeClient().payouts.list({ limit: Math.min(100, Math.max(1, limit)) })
  for (const p of list.data) {
    try { out.push(await syncPayout(db, p)) } catch (e) { out.push({ id: p.id, error: String((e as Error).message || e).slice(0, 200) }) }
  }
  return out
}
