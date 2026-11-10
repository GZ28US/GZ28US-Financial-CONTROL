/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — THE NOTIFICATION SWITCHBOARD of the quote portal (QUOTE PORTAL M4, 06/11/2026 → senders wired 08/11/2026;
// blueprint §8.1, §5.2(5), constraint 10, C-68).
// Every ROBOT message of the portal goes through notify(): it reads its app_settings key and decides. OFF (the default of EVERY key)
// → one invoice_events row NOTIFY_SKIPPED {key, reason:'off'} and NOTHING leaves the building. ON → the sender for that channel:
//   • client e-mails — lib/quoteMail.server.ts builds (recipient, link, PDF from the DB); the test document only to notify.test_targets;
//   • client WhatsApp — the client's phone on file (by country, lib/utils toWaNumber); real documents also need quote_portal.enabled;
//     a TEST document only to a WhatsApp entry of notify.test_targets;
//   • REPORTS pings — the GZ28US Control App REPORTS group (lib/waSelfGuard WA_REPORTS_US);
//   • OWNER alerts — ALSO the REPORTS group: the owner's own number IS the US instance, and UltraMsg drops a self-send in silence
//     (lib/waSelfGuard: «aviso que era pra ele vai pro grupo REPORTS»). They go out as a red 🔴 OWNER ALERT balloon.
//   A TEST document never pings REPORTS: its REPORTS/OWNER messages go to the first WhatsApp entry of notify.test_targets, or nowhere.
// WhatsApp messages carry the house signature (lib/waSignature — the same rule /api/whatsapp applies) and go through the app's
// existing UltraMsg path (lib/notifyTransport.server → lib/waSend.server enviaUltra: self-send guard, mentions). Outside text
// (client / signer names) passes semMarcacao() so it can never @-mention anyone in a group.
// SEND TEST TO ME (sendTest) is a human tap on /adm/notifications and goes ONLY to notify.test_targets.
// Every decision is an event (NOTIFIED / NOTIFY_SKIPPED) on the document's ACTIVITY. Never throws into the caller.
import type { SupabaseClient } from '@supabase/supabase-js'
import { settingOn, readSetting } from './appSettings.server'
import { buildPortalMail, type PortalMailKind } from './quoteMail.server'
import { maskEmail } from './quotePublic.server'
import { loadDocState, publicUrl, firstName, PUBLIC_BASE, type DocState } from './quoteDoc.server'
import { transport as realTransportPicker, type Transport } from './notifyTransport.server'
import { withSignature, normalizeTo } from './waSignature'
import { WA_REPORTS_US } from './waSelfGuard.server'
import { semMarcacao } from './waMentions'
import { toWaNumber } from './utils'
import { moneyCents, t, type Lang } from './quoteStrings'
import { fmtDay } from './orlando'

export type NotifyGroup = 'MONEY' | 'QUOTE FLOW (not money)' | 'OWNER ALERTS' | 'CLIENT' | 'SIGNING'
export type NotifyChannel = 'email' | 'whatsapp' | 'reports' | 'owner' | 'otp'
export type NotifyKey = { key: string; group: NotifyGroup; label: string; channel: NotifyChannel; mailKind?: PortalMailKind; note?: string }

export const OTP_KEY = 'quote_portal.sign_otp'

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
  { key: OTP_KEY, group: 'SIGNING', label: 'Before the e-signature the client types a 6-digit code sent on the SAME channel the quote went on (WhatsApp; e-mail when there is no phone)', channel: 'otp', note: 'behaviour key — not a message notify() sends' },
]
const BY_KEY = new Map(NOTIFY_KEYS.map(k => [k.key, k]))

// ── injectable seams (production never touches them; scripts/test-notify-senders.ts does) ────────────────────────────────────
type Deps = {
  settingOn: (k: string) => Promise<boolean>
  readSetting: <T = unknown>(k: string) => Promise<T | undefined>
  loadDocState: (db: SupabaseClient, id: string) => Promise<DocState | null>
  buildPortalMail: typeof buildPortalMail
  transport: () => Transport
}
const DEFAULT_DEPS: Deps = { settingOn, readSetting, loadDocState, buildPortalMail, transport: realTransportPicker }
let deps: Deps = { ...DEFAULT_DEPS }
export function setNotifyDepsForTests(o: Partial<Deps> | null) { deps = o ? { ...DEFAULT_DEPS, ...o } : { ...DEFAULT_DEPS } }

// ── test targets: e-mails and WhatsApp destinations in ONE list (notify.test_targets) ──────────────────────────────────────────
export function splitTargets(list: unknown): { emails: string[]; wa: string[] } {
  const arr = Array.isArray(list) ? list.map(x => String(x).trim()).filter(Boolean) : []
  const emails = arr.filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).map(x => x.toLowerCase())
  const wa = arr.filter(x => /@(c|g)\.us$/i.test(x) || /^\+?[\d\s().-]{10,20}$/.test(x)).map(x => normalizeTo(x.replace(/^\+/, ''))).filter(Boolean)
  return { emails, wa }
}
const maskWa = (to: string) => to.endsWith('@g.us') ? (to === WA_REPORTS_US ? 'REPORTS group' : 'group ••' + to.split('@')[0].slice(-4)) : '••' + to.replace(/\D/g, '').slice(-4)
const sameWa = (a: string, b: string) => a.replace(/\D/g, '') === b.replace(/\D/g, '') && a.endsWith('@g.us') === b.endsWith('@g.us')

// The client's WhatsApp chat id from the phone on file, by country (US default +1). null when there is no usable phone.
export function clientWaTo(client: Record<string, any> | null | undefined): string | null {
  const n = toWaNumber(client?.phone, client?.country)
  return n && n.length >= 10 ? `${n}@c.us` : null
}

// ── the WhatsApp copy (pure; exported for the harness) ────────────────────────────────────────────────────────────────────
export type WaVars = { code: string; car: string; client: string; first: string; total: string; channel: string; until: string; deposit: string;
  amount: string; method: string; signer: string; docUrl: string; link: string; test: boolean; lang: Lang }
const S = (x: unknown) => semMarcacao(String(x ?? '')).replace(/[*_~`]/g, '').trim()
const OWNER = (v: WaVars, what: string) => `🔴 *OWNER ALERT* — ${what}\n${v.code}${v.client ? ' · ' + v.client : ''}\n${v.docUrl}`
export const WA_COPY: Record<string, (v: WaVars) => string> = {
  'notify.client.quote_sent.whatsapp': v => v.lang === 'pt'
    ? `Olá${v.first ? ', ' + v.first : ''}! Aqui está o seu orçamento ${v.code}${v.car ? ' — ' + v.car : ''} (${v.total}). Você pode ler tudo, aprovar e assinar no link${v.until ? ` (válido até ${v.until})` : ''}: ${v.link}`
    : `Hi${v.first ? ' ' + v.first : ''}! Here is your quote ${v.code}${v.car ? ' — ' + v.car : ''} (${v.total}). You can read it all, approve and sign on the link${v.until ? ` (valid until ${v.until})` : ''}: ${v.link}`,
  'notify.reports.quote_sent': v => `📤 *QUOTE SENT* ${v.code}${v.car ? ' — ' + v.car : ''} · ${v.client} · ${v.total}${v.channel ? ' · via ' + v.channel : ''}${v.until ? ' · valid until ' + v.until : ''}`,
  'notify.reports.quote_viewed': v => `👁 quote viewed ${v.code} — ${v.client}`,
  'notify.reports.changes_requested': v => `✏️ *CHANGES REQUESTED* ${v.code} — ${v.client} · open ACTIVITY: ${v.docUrl}`,
  'notify.reports.quote_declined': v => `quote declined ${v.code} — ${v.client} · ${v.docUrl}`,
  'notify.reports.renewal_requested': v => `renewal requested ${v.code} — ${v.client} · ${v.docUrl}`,
  'notify.reports.quote_signed': v => `✍ *QUOTE SIGNED* ${v.code}${v.car ? ' — ' + v.car : ''} · ${v.client} · ${v.total}${v.deposit ? ' · deposit ' + v.deposit + ' pending' : ''}`,
  'notify.reports.quote_expiring': v => `⏳ quote expiring ${v.code} — ${v.client}${v.until ? ' · valid until ' + v.until : ''}`,
  'notify.reports.quote_unopened_48h': v => `📭 quote unopened 48 h ${v.code} — ${v.client}${v.channel ? ' · sent via ' + v.channel : ''}`,
  'notify.reports.deposit_received': v => `💰 *DEPOSIT RECEIVED* ${v.code}${v.car ? ' — ' + v.car : ''} · ${v.client} · ${v.amount}${v.method ? ' via ' + v.method : ''}`,
  'notify.reports.deposit_clearing': v => `⏳ deposit clearing ${v.code} — ${v.client} · ${v.amount}${v.method ? ' via ' + v.method : ''}`,
  'notify.owner.payment_failed': v => OWNER(v, 'payment failed'),
  'notify.owner.dispute': v => OWNER(v, 'dispute opened'),
  'notify.owner.refund': v => OWNER(v, 'refund'),
  'notify.owner.payment_anomaly': v => OWNER(v, 'payment anomaly'),
  'notify.owner.payout_unmatched': v => OWNER(v, 'Stripe payout not matched in the bank'),
  'notify.owner.gate_cap': v => OWNER(v, 'identity-gate lock hit'),
}

export const wired = (k: NotifyKey) => k.channel === 'otp' || (k.channel === 'email' ? !!k.mailKind : !!WA_COPY[k.key])

function waVars(s: DocState, ctx: { invoiceId: string; attemptId?: string | null }, link: string): WaVars {
  const lang = (s.terms?.language || 'en') as Lang
  const rev = s.live
  const h = rev?.document?.header || {}
  const c = s.bundle.client
  const grand = rev ? Math.round(Number(rev.grand_total || 0) * 100) : Math.round(Number(s.bundle.money?.grand || 0) * 100)
  const dep = ((rev?.document?.installments || []) as any[])[0]
  const att = ctx.attemptId ? s.attempts.find(a => a.id === ctx.attemptId) : [...s.attempts].reverse().find(a => a.status === 'SUCCEEDED' || a.status === 'PROCESSING')
  return {
    code: S(h.display_code || s.bundle.invoice.invoice_code || ''), car: S(h.car || ''), client: S(c?.name || ''), first: S(firstName(c?.name)),
    total: moneyCents(grand, lang), channel: S(rev?.sent_channel || ''), until: s.terms?.valid_until ? fmtDay(s.terms.valid_until, lang) : '',
    deposit: dep ? moneyCents(Number(dep.amount_cents), lang) : '', amount: att ? moneyCents(Number(att.amount_cents), lang) : '',
    method: S(att?.rail === 'us_bank_account' ? 'ACH' : att?.rail || ''), signer: S(s.approvalOnLive?.signer_name || ''),
    docUrl: `${PUBLIC_BASE}/doc/${ctx.invoiceId}`, link, test: !!s.liveLink?.is_test || s.isTest, lang,
  }
}

export type NotifyResult = { key: string; sent: boolean; reason: string }
type Ctx = { invoiceId: string; revisionId?: string | null; attemptId?: string | null }

// One decision per key. Never throws; always leaves its event.
export async function notify(db: SupabaseClient, keyName: string, ctx: Ctx): Promise<NotifyResult> {
  const k = BY_KEY.get(keyName)
  const log = async (kind: 'NOTIFIED' | 'NOTIFY_SKIPPED', payload: Record<string, unknown>) => {
    try { const r = await db.rpc('doc_event', { p_invoice: ctx.invoiceId, p_revision: ctx.revisionId || null, p_kind: kind, p_actor: 'SYSTEM', p_actor_id: 'notify', p_payload: { key: keyName, ...payload } }); if (r.error) console.error('[notify] event', keyName, r.error.message) }
    catch (e) { console.error('[notify] event', keyName, (e as Error).message) }
  }
  const skip = async (reason: string) => { await log('NOTIFY_SKIPPED', { reason }); return { key: keyName, sent: false, reason } }
  try {
    if (!k) return await skip('unknown key')
    if (k.channel === 'otp') return await skip('behaviour key, not a message')
    if (!(await deps.settingOn(k.key))) return await skip('off')
    if (!wired(k)) return await skip('sender not wired')

    if (k.channel === 'email') {
      const m = await deps.buildPortalMail(db, k.mailKind!, ctx.invoiceId, { human: false, attemptId: ctx.attemptId || null })
      if ('error' in m) return await skip(m.error)
      const err = await deps.transport().email(m)
      if (err) return await skip(err)
      await log('NOTIFIED', { channel: 'EMAIL', to: maskEmail(m.to), kind: k.mailKind, attachments: m.attachments.map(a => a.name) })
      return { key: k.key, sent: true, reason: 'sent' }
    }

    // WhatsApp channels: client · reports · owner
    const s = await deps.loadDocState(db, ctx.invoiceId)
    if (!s) return await skip('document not found')
    const isTest = !!s.liveLink?.is_test || s.isTest
    const targets = isTest ? splitTargets(await deps.readSetting<string[]>('notify.test_targets')).wa : []
    let to: string | null
    let link = ''
    if (k.channel === 'whatsapp') {
      if (!s.liveLink) return await skip('no live portal link — SEND in /doc first')
      if (!isTest && !(await deps.settingOn('quote_portal.enabled'))) return await skip('quote_portal.enabled is OFF')
      to = clientWaTo(s.bundle.client)
      if (!to) return await skip('client has no WhatsApp phone on file')
      if (isTest && !targets.some(x => sameWa(x, to!))) return await skip('test document: recipient not in notify.test_targets')
      const { data: tok } = await db.from('quote_links').select('token').eq('id', s.liveLink.id).maybeSingle()
      if (!tok?.token) return await skip('link token unreadable')
      link = publicUrl(tok.token)
    } else {
      to = isTest ? (targets[0] || null) : WA_REPORTS_US
      if (!to) return await skip('test document: no WhatsApp entry in notify.test_targets')
    }
    const v = waVars(s, ctx, link)
    const text = (isTest && k.channel !== 'whatsapp' ? '🧪 TEST · ' : '') + WA_COPY[k.key](v)
    const r = await deps.transport().whatsapp(to, withSignature(text))
    if (!r.ok) return await skip(r.error || 'whatsapp refused')
    await log('NOTIFIED', { channel: 'WHATSAPP', to: maskWa(to), ultra_id: r.id })
    return { key: k.key, sent: true, reason: 'sent' }
  } catch (e) {
    return await skip(String((e as Error).message || e).slice(0, 200))
  }
}
export async function notifyAll(db: SupabaseClient, keys: string[], ctx: Ctx) {
  const out: NotifyResult[] = []
  for (const k of keys) out.push(await notify(db, k, ctx))
  return out
}

// ── the signing code (OTP) message — §5.2 (5). The caller (app/api/q/[action] otp-send) already checked quote_portal.sign_otp is
// ON and the link is allowed; this only decides WHERE it may go and sends it. The code itself is never logged anywhere. ────────
export async function sendOtpMessage(db: SupabaseClient, o: { invoiceId: string; revisionId: string | null; isTest: boolean; channel: 'WHATSAPP' | 'EMAIL';
  to: string; code: string; lang: Lang; docCode: string }): Promise<{ sent: boolean; reason: string }> {
  const log = async (kind: 'NOTIFIED' | 'NOTIFY_SKIPPED', payload: Record<string, unknown>) => {
    try { await db.rpc('doc_event', { p_invoice: o.invoiceId, p_revision: o.revisionId, p_kind: kind, p_actor: 'SYSTEM', p_actor_id: 'otp', p_payload: { key: OTP_KEY, channel: o.channel, ...payload } }) }
    catch (e) { console.error('[otp] event', (e as Error).message) }
  }
  try {
    if (!(await deps.settingOn(OTP_KEY))) { await log('NOTIFY_SKIPPED', { reason: 'off' }); return { sent: false, reason: 'off' } }
    const masked = o.channel === 'EMAIL' ? maskEmail(o.to) : maskWa(o.to)
    if (o.isTest) {
      const tt = splitTargets(await deps.readSetting<string[]>('notify.test_targets'))
      const okTarget = o.channel === 'EMAIL' ? tt.emails.includes(o.to.toLowerCase()) : tt.wa.some(x => sameWa(x, o.to))
      if (!okTarget) { await log('NOTIFY_SKIPPED', { reason: 'test document: recipient not in notify.test_targets', to: masked }); return { sent: false, reason: 'test target' } }
    }
    const text = t(o.lang, 'otp_message', { otp: o.code, code: o.docCode })
    let err: string | null
    if (o.channel === 'WHATSAPP') {
      const r = await deps.transport().whatsapp(o.to, withSignature(text), { logHead: `[signing code for ${o.docCode} — hidden]` })
      err = r.ok ? null : (r.error || 'whatsapp refused')
    } else {
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5"><p>${t(o.lang, 'otp_mail_intro', { code: esc(o.docCode) })}</p>` +
        `<p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0">${esc(o.code)}</p><p style="font-size:13px;color:#555">${t(o.lang, 'otp_mail_foot')}</p>` +
        `<p style="margin-top:32px"><b>GZ28 V8 SpeedShop</b><br/>11320 Space Blvd, Orlando, FL 32837<br/>(321) 315-0973</p></div>`
      err = await deps.transport().email({ to: o.to, subject: t(o.lang, 'otp_mail_subject', { code: o.docCode }), html, attachments: [] })
    }
    if (err) { await log('NOTIFY_SKIPPED', { reason: String(err).slice(0, 200), to: masked }); return { sent: false, reason: err } }
    await log('NOTIFIED', { to: masked, kind: 'sign-otp' })
    return { sent: true, reason: 'sent' }
  } catch (e) {
    const reason = String((e as Error).message || e).slice(0, 200)
    await log('NOTIFY_SKIPPED', { reason })
    return { sent: false, reason }
  }
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// ── SEND TEST TO ME (§8.1): a human tap on /adm/notifications. Goes ONLY to notify.test_targets — never to a client, never to REPORTS.
export async function sendTest(keyName: string, by: string): Promise<{ ok: boolean; results: { to: string; sent: boolean; reason: string }[]; error?: string }> {
  const k = BY_KEY.get(keyName)
  if (!k) return { ok: false, results: [], error: 'unknown key' }
  if (k.channel === 'otp') return { ok: false, results: [], error: 'behaviour key — nothing to send' }
  const tt = splitTargets(await deps.readSetting<string[]>('notify.test_targets'))
  const list = k.channel === 'email' ? tt.emails : tt.wa
  if (!list.length) return { ok: false, results: [], error: `no ${k.channel === 'email' ? 'e-mail' : 'WhatsApp'} entry in notify.test_targets` }
  const results: { to: string; sent: boolean; reason: string }[] = []
  const line = `🧪 SEND TEST TO ME — ${k.key}\n${k.label}\n(tapped by ${S(by)} on /adm/notifications; nothing was sent to a client)`
  for (const to of list) {
    if (k.channel === 'email') {
      const err = await deps.transport().email({ to, subject: `TEST — ${k.key}`, html: `<pre style="font-family:Arial,Helvetica,sans-serif">${esc(line)}</pre>`, attachments: [] })
      results.push({ to: maskEmail(to), sent: !err, reason: err || 'sent' })
    } else {
      const r = await deps.transport().whatsapp(to, withSignature(line))
      results.push({ to: maskWa(to), sent: r.ok, reason: r.ok ? 'sent' : (r.error || 'refused') })
    }
  }
  return { ok: results.some(r => r.sent), results }
}

