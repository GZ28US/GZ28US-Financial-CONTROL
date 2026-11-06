/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { claimAndFulfil } from '@/lib/stripeEvents.server'
import { stripeClient } from '@/lib/stripe.server'
import { readSetting } from '@/lib/appSettings.server'

// DOCS HOUSEKEEPING (06/11/2026; blueprint §2.3) — hourly. Sends NOTHING to anyone.
//   1. quotes past valid_until without approval → EXPIRED (and their OPEN Checkout sessions closed)
//   2. OPEN attempts past expires_at → EXPIRED (PROCESSING is NEVER expired by time; > 10 days → PAYMENT_ANOMALY stale_processing)
//   3. stripe_events: PROCESSING stuck > 2 min → ERROR; ERROR fulfilment rows (cs:) younger than 72 h, attempts < 5 → re-run
//   4. trims: public_hits > 48 h; stripe_events.payload > 90 days
//   5. TEST documents: links older than 24 h revoked; hired test documents older than 2 h deleted by fixture_delete() unless test.keep
// ?dry=1 lists what it would do.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const dry = req.nextUrl.searchParams.get('dry') === '1'
  const db = serviceDb()
  const out: Record<string, unknown> = { dry }
  const now = Date.now()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())

  // 1. expiry
  const { data: due } = await db.from('invoice_terms').select('invoice_id, valid_until').lt('valid_until', today)
  const expired: string[] = []
  for (const t of due || []) {
    if (dry) { expired.push(t.invoice_id); continue }
    const { data } = await db.rpc('quote_expire', { p_invoice: t.invoice_id })
    if ((data as any)?.expired) {
      expired.push(t.invoice_id)
      for (const sid of ((data as any).sessions || []) as string[]) { try { await stripeClient().checkout.sessions.expire(sid) } catch { /* already closed */ } }
    }
  }
  out.expired = expired

  // 2. attempts
  const { data: stale } = await db.from('payment_attempts').select('id').eq('status', 'OPEN').lt('expires_at', new Date(now).toISOString())
  if (!dry && stale?.length) await db.from('payment_attempts').update({ status: 'EXPIRED' }).in('id', stale.map(a => a.id)).eq('status', 'OPEN')
  out.attempts_expired = (stale || []).length
  const { data: longProc } = await db.from('payment_attempts').select('id, invoice_id, revision_id, authorized_at').eq('status', 'PROCESSING').lt('authorized_at', new Date(now - 10 * 86400e3).toISOString())
  for (const a of longProc || []) {
    const { data: seen } = await db.from('invoice_events').select('id').eq('invoice_id', a.invoice_id).eq('kind', 'PAYMENT_ANOMALY').contains('payload', { anomaly: 'stale_processing', attempt_id: a.id }).limit(1)
    if (!seen?.length && !dry) await db.rpc('doc_event', { p_invoice: a.invoice_id, p_revision: a.revision_id, p_kind: 'PAYMENT_ANOMALY', p_actor: 'SYSTEM', p_actor_id: null, p_payload: { anomaly: 'stale_processing', attempt_id: a.id } })
  }
  out.stale_processing = (longProc || []).length

  // 3. stripe_events re-queue
  const { data: stuck } = await db.from('stripe_events').select('id').eq('status', 'PROCESSING').lt('locked_at', new Date(now - 2 * 60e3).toISOString())
  if (!dry && stuck?.length) await db.from('stripe_events').update({ status: 'ERROR', error: 'stuck in PROCESSING — re-queued by housekeeping' }).in('id', stuck.map(e => e.id))
  const { data: errs } = await db.from('stripe_events').select('id, attempts').eq('status', 'ERROR').like('id', 'cs:%').lt('attempts', 5).gt('received_at', new Date(now - 72 * 3600e3).toISOString())
  const rerun: { id: string; state?: string; error?: string }[] = []
  for (const e of errs || []) {
    if (dry) { rerun.push({ id: e.id }); continue }
    try { const r = await claimAndFulfil(db, e.id.slice(3), 'webhook'); rerun.push({ id: e.id, state: r.state }) } catch (x) { rerun.push({ id: e.id, error: String((x as Error).message).slice(0, 120) }) }
  }
  out.requeued = (stuck || []).length; out.rerun = rerun

  // 4. trims
  if (!dry) {
    await db.from('public_hits').delete().lt('bucket', new Date(now - 48 * 3600e3).toISOString())
    await db.from('stripe_events').update({ payload: {} }).lt('received_at', new Date(now - 90 * 86400e3).toISOString()).neq('payload', '{}')
  }

  // 5. test documents
  const keep = (await readSetting<boolean>('test.keep')) === true
  const { data: tl } = await db.from('quote_links').select('id, invoice_id, created_at, revoked_at').eq('is_test', true)
  const testLinks = tl || []
  const old = testLinks.filter(l => !l.revoked_at && now - new Date(l.created_at).getTime() > 24 * 3600e3)
  if (!dry && old.length) await db.from('quote_links').update({ revoked_at: new Date().toISOString() }).in('id', old.map(l => l.id))
  const cleaned: string[] = []
  if (!keep) for (const invId of [...new Set(testLinks.map(l => l.invoice_id))]) {
    const { data: hired } = await db.from('invoice_events').select('at').eq('invoice_id', invId).eq('kind', 'HIRED').order('at').limit(1)
    if (hired?.length && now - new Date(hired[0].at).getTime() > 2 * 3600e3) {
      if (dry) { cleaned.push(invId); continue }
      const { error } = await db.rpc('fixture_delete', { p_invoice: invId, p_label: 'quote-portal-test-auto' })
      cleaned.push(error ? `${invId}: ${error.message.slice(0, 100)}` : invId)
    }
  }
  out.test_links = testLinks.map(l => ({ id: l.id, invoice_id: l.invoice_id, revoked: !!l.revoked_at }))
  out.test_revoked = old.length; out.test_cleaned = cleaned
  return NextResponse.json(out)
}
