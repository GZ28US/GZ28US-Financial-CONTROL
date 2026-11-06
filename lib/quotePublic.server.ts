/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the public quote page's server side (06/11/2026; blueprint §2.1, §5).
//
// Custody of the capability token (security S-07 / P-20 / R2-14): the token appears in a URL ONCE — the link itself
// (/ca/q/<token>). The page handler sets an httpOnly cookie `gz28_q_<link_id>` (Path=/ca, one per document) and every
// /api/q/* call sends only `{link_id}` (a public UUID); the handler reads the matching cookie server-side. Stripe's return URL
// carries a short HMAC landing token that resolves the ATTEMPT only, never the document.
//
// Secrets: QUOTE_GATE_SECRET when set; otherwise a key DERIVED from the service key (HMAC with a fixed label) — never stored,
// never printed, rotates with the service key. Nothing here messages anyone.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { settingOn, readSetting } from './appSettings.server'
import { stripeMode } from './stripe.server'
import { termsSha256, type DocState } from './quoteDoc.server'
import { TERMS_TEXT, FL_ESTIMATE_TEXT, type Lang } from './quoteStrings'
import { orlandoDay } from './orlando'

export const cookieName = (linkId: string) => `gz28_q_${linkId.replace(/-/g, '')}`
export const gateCookieName = (linkId: string) => `gz28_qg_${linkId.replace(/-/g, '')}`
export const COOKIE_PATH = '/ca'

function secret(): Buffer {
  const own = process.env.QUOTE_GATE_SECRET
  if (own && own.length >= 32) return Buffer.from(own)
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base) throw new Error('no secret available for the quote portal (QUOTE_GATE_SECRET / SUPABASE_SERVICE_ROLE_KEY)')
  return createHmac('sha256', base).update('gz28-quote-portal-v1').digest()
}
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const mac = (s: string) => b64u(createHmac('sha256', secret()).update(s).digest())
function eq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Landing token: <attempt_id>.<exp>.<hmac>  (2 h) — resolves the attempt only.
export function landingToken(attemptId: string, ttlSec = 2 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  return `${attemptId}.${exp}.${mac(`landing|${attemptId}|${exp}`)}`
}
export function verifyLandingToken(tok: string | null | undefined): string | null {
  const [id, exp, sig] = String(tok || '').split('.')
  if (!id || !exp || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null
  if (Number(exp) < Date.now() / 1000) return null
  return eq(sig, mac(`landing|${id}|${exp}`)) ? id : null
}

// Gate pass cookie: <link_id>.<exp>.<hmac> (15 min).
export function gatePass(linkId: string, ttlSec = 15 * 60): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  return `${linkId}.${exp}.${mac(`gate|${linkId}|${exp}`)}`
}
export function gatePassOk(linkId: string, v: string | null | undefined): boolean {
  const [id, exp, sig] = String(v || '').split('.')
  if (id !== linkId || !exp || !sig || Number(exp) < Date.now() / 1000) return false
  return eq(sig, mac(`gate|${id}|${exp}`))
}

// ── request facts ────────────────────────────────────────────────────────────
export function clientIp(req: NextRequest): string {
  return (req.headers.get('x-real-ip') || req.headers.get('x-vercel-forwarded-for') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim()
}
export function ipHash(req: NextRequest): string {
  return createHash('sha256').update(orlandoDay(new Date()) + '|' + mac('ip-salt') + '|' + clientIp(req)).digest('hex').slice(0, 32)
}
export function attribution(req: NextRequest, extra: Record<string, unknown> = {}) {
  return {
    ip_source: req.headers.get('x-real-ip') ? 'x-real-ip' : req.headers.get('x-vercel-forwarded-for') ? 'x-vercel-forwarded-for' : 'x-forwarded-for',
    xff: (req.headers.get('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5),
    country: req.headers.get('x-vercel-ip-country') || null,
    city: decodeURIComponent(req.headers.get('x-vercel-ip-city') || '') || null,
    ua_class: uaClass(req.headers.get('user-agent')),
    ...extra,
  }
}
const CRAWLER = /bot|crawl|spider|facebookexternalhit|facebot|whatsapp|telegrambot|slackbot|twitterbot|discordbot|linkedinbot|embedly|preview|skype|google-?(read|inspection)|bingpreview|headless|curl|wget|python|node-fetch|axios/i
export const isCrawler = (ua: string | null | undefined) => !ua || CRAWLER.test(ua)
export function uaClass(ua: string | null | undefined): string {
  const s = String(ua || '')
  if (isCrawler(s)) return 'bot'
  if (/FBAN|FBAV|Instagram|Messenger|FB_IAB/i.test(s)) return 'in-app'
  if (/iPhone|iPad/i.test(s)) return 'iphone'
  if (/Android/i.test(s)) return 'android'
  if (/Macintosh/i.test(s)) return 'mac'
  if (/Windows/i.test(s)) return 'windows'
  return 'other'
}
export const isInApp = (ua: string | null | undefined) => /FBAN|FBAV|Instagram|Messenger|FB_IAB|Line\//i.test(String(ua || ''))

// ── limiter on two keys (link · ip) ──────────────────────────────────────────
const BUDGET: Record<string, { link?: number; ip?: number; windowSec: number }> = {
  resolve: { ip: 30, windowSec: 3600 },
  get: { link: 120, ip: 120, windowSec: 3600 },
  view: { link: 6, ip: 30, windowSec: 3600 },
  gate: { link: 30, ip: 20, windowSec: 3600 },
  sign: { link: 30, ip: 10, windowSec: 3600 },
  checkout: { link: 12, ip: 5, windowSec: 600 },
  landing: { link: 10, ip: 30, windowSec: 3600 },
  changes: { link: 3, ip: 10, windowSec: 86400 },
  decline: { link: 6, ip: 10, windowSec: 86400 },
  promised: { link: 3, ip: 10, windowSec: 86400 },
  renewal: { link: 1, ip: 5, windowSec: 86400 },
}
export async function limited(db: SupabaseClient, route: string, req: NextRequest, linkId?: string | null): Promise<boolean> {
  const b = BUDGET[route]; if (!b) return false
  const bucket = new Date(Math.floor(Date.now() / 1000 / b.windowSec) * b.windowSec * 1000).toISOString()
  const checks: PromiseLike<boolean>[] = []
  if (b.ip) checks.push(db.rpc('public_hit', { p_scope: 'ip', p_key: ipHash(req), p_route: route, p_bucket: bucket }).then(r => Number(r.data) > b.ip!))
  if (b.link && linkId) checks.push(db.rpc('public_hit', { p_scope: 'link', p_key: linkId, p_route: route, p_bucket: bucket }).then(r => Number(r.data) > b.link!))
  return (await Promise.all(checks)).some(Boolean)
}

// ── keys ─────────────────────────────────────────────────────────────────────
export async function portalAllows(link: { is_test?: boolean | null }): Promise<boolean> {
  return !!link.is_test || await settingOn('quote_portal.enabled')
}
export async function actionsAllow(isTest: boolean): Promise<boolean> {
  return isTest || await settingOn('qi_v2.actions')
}
// The mode rule (security R2-01, rules R2-02): a real link pays only in LIVE mode with the e-mail choice recorded; a test link only in TEST.
export async function payModeOk(isTest: boolean): Promise<{ ok: boolean; reason?: string; livemode: boolean }> {
  const mode = stripeMode()
  if (!mode) return { ok: false, reason: 'stripe not configured', livemode: false }
  if (isTest) return mode === 'test' ? { ok: true, livemode: false } : { ok: false, reason: 'test document with a live key', livemode: true }
  if (mode !== 'live') return { ok: false, reason: 'test key — a real document is never paid with test money', livemode: false }
  const checked = await readSetting<{ live?: boolean }>('stripe.customer_emails_checked')
  if (!checked?.live) return { ok: false, reason: 'Stripe «Customer emails» choice not recorded (stripe.customer_emails_checked.live)', livemode: true }
  return { ok: true, livemode: true }
}
export async function railsEnabled(): Promise<string[]> {
  const v = await readSetting<string[]>('payments.rails_enabled')
  return Array.isArray(v) ? v : ['card']
}

// ── resolve ──────────────────────────────────────────────────────────────────
export async function linkByToken(db: SupabaseClient, token: string) {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null
  const { data } = await db.from('quote_links').select('id, invoice_id, token, gate, gate_tier, is_test, revoked_at, first_viewed_at, view_count').eq('token', token).maybeSingle()
  return data
}
// The link for a public API call: {link_id} in the body + the cookie gz28_q_<link_id> carrying its token.
export async function linkFromCookie(db: SupabaseClient, req: NextRequest, linkId: unknown) {
  const id = String(linkId || '')
  if (!/^[0-9a-f-]{36}$/.test(id)) return null
  const tok = req.cookies.get(cookieName(id))?.value
  if (!tok) return null
  const link = await linkByToken(db, tok)
  if (!link || link.id !== id) return null
  return link
}

// ── masking ──────────────────────────────────────────────────────────────────
export function maskEmail(e: string | null | undefined): string {
  const s = String(e || ''); const [u, d] = s.split('@'); if (!u || !d) return ''
  const [dn, ...tld] = d.split('.')
  return `${u[0]}•••${u.length > 1 ? u[u.length - 1] : ''}@${dn[0] || ''}•••.${tld.join('.') || ''}`
}
export const phoneDigits = (p: string | null | undefined) => String(p || '').replace(/\D/g, '')
export const normEmail = (e: string) => e.normalize('NFKC').trim().toLowerCase()

// ── the client DTO (never base_cost, expenses, markup, grade, phone, e-mail, other invoices) ───────────────────────────
export function publicDto(s: DocState, link: { id: string; gate: string; gate_tier: string | null; is_test: boolean }, opts: { rails: string[]; payOk: boolean; inApp: boolean; gateOk: boolean }) {
  const live = s.live
  const doc = live?.document || null
  const lang: Lang = (s.terms?.language || 'en') as Lang
  const ap = s.approvalOnLive
  const client = s.bundle.client
  const hiredEvent = [...s.events].reverse().find(e => e.kind === 'HIRED')
  const declinedAt = [...s.events].reverse().find(e => e.kind === 'DECLINED' && live && e.at >= live.created_at)?.at || null
  const changesAt = s.clientNotes.filter(n => n.kind === 'CHANGES' && live && n.created_at >= live.created_at).map(n => n.created_at).pop() || null
  const renewalAt = [...s.events].reverse().find(e => e.kind === 'RENEWAL_REQUESTED')?.at || null
  const promised = s.events.filter(e => e.kind === 'PAYMENT_PROMISED').map(e => ({ seq: e.payload?.seq, at: e.at }))
  const plan = (doc?.installments || []).map((i: any) => ({
    seq: i.seq, label: i.label_text, amount_cents: i.amount_cents, due_rule: i.due_rule, due_date: i.due_date, paid_to: i.paid_to,
    paid: !!s.stage.paidBySeq[i.seq], paid_amount: s.stage.paidAmountBySeq[i.seq] || 0,
  }))
  const lastSeq = plan.length ? plan[plan.length - 1].seq : 0
  const attempts = s.attempts.filter(a => !live || a.revision_id === live.id || !s.bundle.invoice.is_quote)
    .map(a => ({ id: a.id, seq: a.seq, status: a.status, rail: a.rail, provider: a.provider, amount_cents: a.amount_cents, verification: a.verification,
      authorized_at: a.authorized_at, succeeded_at: a.succeeded_at, failed_at: a.failed_at, failure_code: a.failure_code }))
  const contactHint = link.gate === 'CONTACT'
    ? (link.gate_tier === 'PHONE4' ? { kind: 'phone', last2: phoneDigits(client?.phone).slice(-2) } : { kind: 'email', masked: maskEmail(client?.email) })
    : null
  const refundedAt = s.bundle.incomes.filter(i => Number(i.amount) < 0 && i.paid_at).map(i => i.paid_at).pop() || null
  return {
    link_id: link.id, is_test: link.is_test, language: lang,
    stage: s.stage.stage, sub: s.stage.sub,
    document: doc ? {
      revision_id: live!.id, seq: live!.seq, sha256: live!.sha256, terms_sha256: live!.terms_sha256,
      header: doc.header, lines: doc.lines, notes: doc.notes, totals: doc.totals, company: doc.company, valid_until: s.terms?.valid_until || doc.terms?.valid_until,
      sent_valid_until: doc.terms?.valid_until || null,
    } : null,
    terms_text: TERMS_TEXT[lang], terms_sha256_now: termsSha256(lang), fl_estimate_text: FL_ESTIMATE_TEXT[lang],
    plan, last_seq: lastSeq, balance_pending_update: s.planDrift !== 0,
    rails: (s.terms?.rails || []).filter(r => r === 'ZELLE' || r === 'WIRE' || r === 'PIX_BR' || opts.rails.includes(r)),
    pay_ok: opts.payOk, in_app: opts.inApp,
    approval: ap ? { signer_name: ap.signer_name, method: ap.method, signed_at: ap.signed_at, document_sha256: ap.document_sha256,
      consent_version: ap.consent_version, estimate: ap.consents?.estimate, parts_return: ap.consents?.parts_return,
      signer_contact_masked: ap.signer_contact ? (String(ap.signer_contact).includes('@') ? maskEmail(ap.signer_contact) : '••' + phoneDigits(ap.signer_contact).slice(-4)) : null,
      city: ap.attribution?.city || null, gate_tier: ap.attribution?.gate_tier || null } : null,
    attempts,
    hired: !s.bundle.invoice.is_quote && hiredEvent ? { code: s.bundle.invoice.invoice_code, old_code: hiredEvent.payload?.invoice_code_before, at: hiredEvent.at,
      car: doc?.header?.car || '' } : null,
    declined_at: declinedAt, changes_at: changesAt, renewal_at: renewalAt, promised, refunded_at: refundedAt,
    gate: link.gate === 'CONTACT' ? { needed: true, ok: opts.gateOk, hint: contactHint } : { needed: false, ok: true, hint: null },
    signer_default: String(client?.name || ''),
    contact: { channel: String(client?.preferred_message_method || 'WhatsApp'), whatsapp: '+1 (321) 315-0973', email: 'gz28us@hotmail.com', instagram: '@gz28us', facebook: 'Dema De Maria' },
    zelle: 'gz28us@hotmail.com',
  }
}
export type PublicDto = ReturnType<typeof publicDto>
