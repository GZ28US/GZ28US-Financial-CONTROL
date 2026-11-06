/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — THE NOTIFICATION SWITCHBOARD of the quote portal (QUOTE PORTAL M4, 06/11/2026; blueprint §8.1, constraint 10, C-68).
// Every ROBOT message of the portal goes through notify(): it reads its app_settings key and decides. OFF (the default of EVERY key)
// → one invoice_events row NOTIFY_SKIPPED {key, reason:'off'} and NOTHING leaves the building. ON → the sender for that channel:
//   • client e-mails — lib/quoteMail.server.ts builds (recipient, link, PDF from the DB) and Graph sends; the test document only to
//     notify.test_targets (the builder enforces it);
//   • WhatsApp client messages, REPORTS pings and OWNER alerts — NOT WIRED in M4: an ON key writes NOTIFY_SKIPPED {reason:'sender not
//     wired'} so flipping it never sends by surprise. They get a sender (through /api/whatsapp's lib, C-67) only with the owner's go.
// Every decision is an event (NOTIFIED / NOTIFY_SKIPPED) on the document's ACTIVITY. Never throws into the caller.
import type { SupabaseClient } from '@supabase/supabase-js'
import { settingOn } from './appSettings.server'
import { buildPortalMail, type PortalMailKind } from './quoteMail.server'
import { maskEmail } from './quotePublic.server'

export type NotifyGroup = 'MONEY' | 'QUOTE FLOW (not money)' | 'OWNER ALERTS' | 'CLIENT'
export type NotifyKey = { key: string; group: NotifyGroup; label: string; channel: 'email' | 'whatsapp' | 'reports' | 'owner'; mailKind?: PortalMailKind; note?: string }

// The registry (§8.1) — the /adm/notifications page lists exactly this.
export const NOTIFY_KEYS: NotifyKey[] = [
  { key: 'notify.client.quote_sent.email', group: 'CLIENT', label: 'Robot re-send of the quote link by e-mail (SEND BY APP is a human tap, never keyed)', channel: 'email', mailKind: 'quote-link' },
  { key: 'notify.client.quote_sent.whatsapp', group: 'CLIENT', label: 'Robot re-send of the quote link by WhatsApp', channel: 'whatsapp' },
  { key: 'notify.client.signed_copy', group: 'CLIENT', label: 'Signed copy to the client after the e-signature', channel: 'email', mailKind: 'quote-signed' },
  { key: 'notify.client.deposit_received', group: 'CLIENT', label: 'Receipt to the client when the deposit / an installment lands', channel: 'email', mailKind: 'deposit-receipt' },
  { key: 'notify.client.installment_due', group: 'CLIENT', label: 'Next installment is ready to pay', channel: 'email', mailKind: 'installment-due' },
  { key: 'notify.client.quote_expiring', group: 'CLIENT', label: 'Quote expires soon', channel: 'email', mailKind: 'quote-expiring' },
  { key: 'notify.client.change_order', group: 'CLIENT', label: 'A change order waits for the client', channel: 'email', mailKind: 'change-order' },
  { key: 'notify.client.deposit_clearing', group: 'CLIENT', label: 'Bank payment is clearing (with the ACH mandate sentence)', channel: 'email', note: 'template pending' },
  { key: 'notify.client.deposit_failed', group: 'CLIENT', label: 'Bank payment failed', channel: 'email', note: 'template pending' },
  { key: 'notify.client.stripe_receipt', group: 'CLIENT', label: 'Ask Stripe to e-mail its own receipt (receipt_email)', channel: 'email', note: 'Stripe-side' },
  { key: 'notify.reports.deposit_received', group: 'MONEY', label: '💰 DEPOSIT RECEIVED in REPORTS (claims income + fee)', channel: 'reports' },
  { key: 'notify.reports.deposit_clearing', group: 'MONEY', label: 'Deposit clearing in REPORTS', channel: 'reports' },
  { key: 'notify.reports.installment_delayed', group: 'MONEY', label: 'DELAYED robot also covers PLAN rows', channel: 'reports', note: 'read by recurring-expense-reports' },
  { key: 'notify.reports.quote_sent', group: 'QUOTE FLOW (not money)', label: '📤 QUOTE SENT', channel: 'reports' },
  { key: 'notify.reports.quote_viewed', group: 'QUOTE FLOW (not money)', label: '👁 quote viewed', channel: 'reports' },
  { key: 'notify.reports.changes_requested', group: 'QUOTE FLOW (not money)', label: '✏️ CHANGES REQUESTED', channel: 'reports' },
  { key: 'notify.reports.quote_declined', group: 'QUOTE FLOW (not money)', label: 'quote declined', channel: 'reports' },
  { key: 'notify.reports.renewal_requested', group: 'QUOTE FLOW (not money)', label: 'renewal requested', channel: 'reports' },
  { key: 'notify.reports.quote_signed', group: 'QUOTE FLOW (not money)', label: '✍ QUOTE SIGNED', channel: 'reports' },
  { key: 'notify.reports.quote_expiring', group: 'QUOTE FLOW (not money)', label: 'quote expiring', channel: 'reports' },
  { key: 'notify.reports.quote_unopened_48h', group: 'QUOTE FLOW (not money)', label: 'quote unopened 48 h', channel: 'reports' },
  { key: 'notify.owner.payment_failed', group: 'OWNER ALERTS', label: 'payment failed (live-switch precondition)', channel: 'owner' },
  { key: 'notify.owner.dispute', group: 'OWNER ALERTS', label: 'dispute opened (live-switch precondition)', channel: 'owner' },
  { key: 'notify.owner.refund', group: 'OWNER ALERTS', label: 'refund', channel: 'owner' },
  { key: 'notify.owner.payment_anomaly', group: 'OWNER ALERTS', label: 'payment anomaly', channel: 'owner' },
  { key: 'notify.owner.payout_unmatched', group: 'OWNER ALERTS', label: 'Stripe payout not matched in the bank', channel: 'owner' },
  { key: 'notify.owner.gate_cap', group: 'OWNER ALERTS', label: 'identity-gate lock hit', channel: 'owner' },
]
const BY_KEY = new Map(NOTIFY_KEYS.map(k => [k.key, k]))
export const wired = (k: NotifyKey) => k.channel === 'email' && !!k.mailKind

const G = 'https://graph.microsoft.com/v1.0'
async function graphSend(m: { to: string; subject: string; html: string; attachments: { name: string; base64: string }[] }): Promise<string | null> {
  const { getMailAuth, freshAccessToken } = await import('./streamMail.server')   // lazy: loaded only when a message really goes out
  const { streamDb } = await import('./stream.server')
  const mdb = streamDb()
  const auth = await getMailAuth(mdb, 1)
  if (!auth?.refresh_token) return 'mailbox not connected'
  const token = await freshAccessToken(mdb, auth)
  if (!token) return 'mail token refresh failed'
  const r = await fetch(`${G}/me/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject: m.subject, body: { contentType: 'HTML', content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }],
      attachments: m.attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: 'application/pdf', contentBytes: a.base64 })) }, saveToSentItems: true }) })
  return r.ok ? null : `graph ${r.status}: ${(await r.text()).slice(0, 200)}`
}

export type NotifyResult = { key: string; sent: boolean; reason: string }

// One decision per key. Never throws; always leaves its event.
export async function notify(db: SupabaseClient, keyName: string, ctx: { invoiceId: string; revisionId?: string | null; attemptId?: string | null }): Promise<NotifyResult> {
  const k = BY_KEY.get(keyName)
  const log = async (kind: 'NOTIFIED' | 'NOTIFY_SKIPPED', payload: Record<string, unknown>) => {
    try { const r = await db.rpc('doc_event', { p_invoice: ctx.invoiceId, p_revision: ctx.revisionId || null, p_kind: kind, p_actor: 'SYSTEM', p_actor_id: 'notify', p_payload: { key: keyName, ...payload } }); if (r.error) console.error('[notify] event', keyName, r.error.message) }
    catch (e) { console.error('[notify] event', keyName, (e as Error).message) }
  }
  try {
    if (!k) { await log('NOTIFY_SKIPPED', { reason: 'unknown key' }); return { key: keyName, sent: false, reason: 'unknown key' } }
    if (!(await settingOn(k.key))) { await log('NOTIFY_SKIPPED', { reason: 'off' }); return { key: k.key, sent: false, reason: 'off' } }
    if (!wired(k)) { await log('NOTIFY_SKIPPED', { reason: 'sender not wired' }); return { key: k.key, sent: false, reason: 'sender not wired' } }
    const m = await buildPortalMail(db, k.mailKind!, ctx.invoiceId, { human: false, attemptId: ctx.attemptId || null })
    if ('error' in m) { await log('NOTIFY_SKIPPED', { reason: m.error }); return { key: k.key, sent: false, reason: m.error } }
    const err = await graphSend(m)
    if (err) { await log('NOTIFY_SKIPPED', { reason: err }); return { key: k.key, sent: false, reason: err } }
    await log('NOTIFIED', { channel: 'EMAIL', to: maskEmail(m.to), kind: k.mailKind, attachments: m.attachments.map(a => a.name) })
    return { key: k.key, sent: true, reason: 'sent' }
  } catch (e) {
    const reason = String((e as Error).message || e).slice(0, 200)
    await log('NOTIFY_SKIPPED', { reason })
    return { key: keyName, sent: false, reason }
  }
}
export async function notifyAll(db: SupabaseClient, keys: string[], ctx: { invoiceId: string; revisionId?: string | null; attemptId?: string | null }) {
  const out: NotifyResult[] = []
  for (const k of keys) out.push(await notify(db, k, ctx))
  return out
}
