/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse, after as nextAfter } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { serviceDb, loadDocState, termsSha256 } from '@/lib/quoteDoc.server'
import {
  cookieName, gateCookieName, COOKIE_PATH, linkByToken, linkFromCookie, portalAllows, publicDto, railsEnabled, payModeOk, limited,
  isCrawler, isInApp, uaClass, attribution, ipHash, gatePass, gatePassOk, verifyLandingToken, phoneDigits, normEmail,
} from '@/lib/quotePublic.server'
import { openDepositCheckout, claimAndFulfil } from '@/lib/stripeEvents.server'
import type { Lang } from '@/lib/quoteStrings'
import { clientRevisionPdf, attemptReceiptPdf, pdfResponseHeaders } from '@/lib/docFiles.server'
import { settingOn } from '@/lib/appSettings.server'
import { supabaseOtpStore, otpSignGate, otpConsume, otpIssue, otpVerify, otpChannelFor, otpPassLive } from '@/lib/quoteOtp.server'
import { toWaNumber } from '@/lib/utils'

// THE CLIENT'S QUOTE PAGE — server side (06/11/2026; blueprint §2.1, §5). /ca/api/q/<action>, all POST, all JSON.
//   open      {token}                      → sets the per-link httpOnly cookie, returns the document DTO
//   state     {link_id}                    → the DTO (cookie required)
//   view · gate · sign · checkout · landing · promised · changes · decline · decline-withdraw · renewal
// The token travels once (open); afterwards only {link_id} + the cookie. A REAL document answers {state:'inactive'} and refuses
// every mutation while app_settings quote_portal.enabled is false; a TEST document (quote_links.is_test) works. Nothing here
// messages anyone; every client act is an invoice_events row.
// M4 (08/11/2026) — SIGNING CODE, only while app_settings quote_portal.sign_otp is ON: otp-send · otp-verify, and `sign` asks for a
// verified code (lib/quoteOtp.server). OFF → those two actions do not exist (404 unknown), the DTO has no `otp` field and `sign` is the
// pre-OTP code path. The ONE message this file can cause is that code, to the client on file (lib/notify.server sendOtpMessage).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const NOSTORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }
const j = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NOSTORE })
const err = (code: string, status = 400, extra: Record<string, unknown> = {}) => j({ error: code, ...extra }, status)
const sameHash = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}
const cleanName = (s: string) => s.normalize('NFC').replace(/[^\p{L}\p{M}\s'.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80)

async function ev(db: ReturnType<typeof serviceDb>, invoiceId: string, revisionId: string | null, kind: string, payload: Record<string, unknown> = {}) {
  await db.rpc('doc_event', { p_invoice: invoiceId, p_revision: revisionId, p_kind: kind, p_actor: 'CLIENT', p_actor_id: null, p_payload: payload })
}

// The signing code's channel for this document: the client on file + the channel the live revision went on (§5.2 (5)).
const OTP_SETTING = 'quote_portal.sign_otp'
function otpTarget(s: NonNullable<Awaited<ReturnType<typeof loadDocState>>>) {
  const c = s.bundle.client
  const n = toWaNumber(c?.phone, c?.country)
  return otpChannelFor(s.live?.sent_channel, n && n.length >= 10 ? `${n}@c.us` : null, c?.email)
}
const otpHint = (t: { channel: string; to: string } | null) => !t ? null : t.channel === 'EMAIL'
  ? { channel: 'EMAIL', masked: (() => { const [u, d] = t.to.split('@'); return `${u?.[0] || ''}•••@${d || ''}` })() }
  : { channel: 'WHATSAPP', masked: '••' + t.to.replace(/\D/g, '').slice(-4) }

// GET /ca/api/q/pdf?link_id=…[&rev=n] · /ca/api/q/receipt?link_id=…&attempt=… — the CLIENT copies (masked certificate), from the private
// bucket. Cookie required; behind the CONTACT gate when the link has one (security R2-07). Same budget as the page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params
  if (action !== 'pdf' && action !== 'receipt') return err('unknown', 404)
  let db
  try { db = serviceDb() } catch { return err('unavailable', 503) }
  const linkId = req.nextUrl.searchParams.get('link_id')
  const link = await linkFromCookie(db, req, linkId)
  if (!link || link.revoked_at) return err('not_found', 404)
  if (!(await portalAllows(link))) return j({ state: 'inactive' })
  if (link.gate === 'CONTACT' && !gatePassOk(link.id, req.cookies.get(gateCookieName(link.id))?.value)) return err('err_gate', 403, { gate: true })
  if (await limited(db, 'get', req, link.id)) return err('err_rate', 429)
  const s = await loadDocState(db, link.invoice_id)
  if (!s) return err('not_found', 404)
  const p = action === 'pdf'
    ? await clientRevisionPdf(db, s, Number(req.nextUrl.searchParams.get('rev') || 0) || undefined)
    : await attemptReceiptPdf(db, s, String(req.nextUrl.searchParams.get('attempt') || ''))
  if (!p) return err('not_found', 404)
  return new NextResponse(new Uint8Array(p.buf), { headers: pdfResponseHeaders(p.name) })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params
  let db
  try { db = serviceDb() } catch { return err('unavailable', 503) }
  const body = await req.json().catch(() => ({})) as Record<string, any>
  const ua = req.headers.get('user-agent')

  // ── landing by a signed token (no cookie needed) ──────────────────────────────────────────────────────────────
  if (action === 'landing' && body.t) {
    const attemptId = verifyLandingToken(String(body.t))
    if (!attemptId) return err('return_no_session', 404)
    if (await limited(db, 'landing', req, null)) return err('err_rate', 429)
    const { data: att } = await db.from('payment_attempts').select('id, invoice_id, status, amount_cents, checkout_session_id, revision_id').eq('id', attemptId).maybeSingle()
    if (!att?.checkout_session_id) return err('return_no_session', 404)
    if (body.no_cookie) await ev(db, att.invoice_id, att.revision_id, 'LANDING_NO_COOKIE', { attempt_id: att.id })
    let state = 'landing_pending'
    try { const r = await claimAndFulfil(db, att.checkout_session_id, 'landing'); state = r.state } catch (e) { console.error('[q landing]', (e as Error).message) }
    const { data: a2 } = await db.from('payment_attempts').select('status, amount_cents').eq('id', attemptId).maybeSingle()
    const { data: terms } = await db.from('invoice_terms').select('language').eq('invoice_id', att.invoice_id).maybeSingle()
    return j({ state, attempt_status: a2?.status || att.status, amount_cents: a2?.amount_cents ?? att.amount_cents, language: terms?.language || 'en' })
  }

  // ── open: the one time the token travels ───────────────────────────────────────────────────────────────────────
  let link
  if (action === 'open') {
    if (await limited(db, 'resolve', req, null)) return err('err_rate', 429)
    link = await linkByToken(db, String(body.token || ''))
    if (!link) return err('not_found', 404)
  } else {
    link = await linkFromCookie(db, req, body.link_id)
    if (!link) return err('not_found', 404)
  }
  if (link.revoked_at) {
    const { data: live } = await db.from('quote_links').select('id').eq('invoice_id', link.invoice_id).is('revoked_at', null).limit(1)
    return j({ state: live?.length ? 'not_found' : 'void' }, 404)
  }
  if (!(await portalAllows(link))) {
    const res = j({ state: 'inactive' })
    return res
  }
  const s = await loadDocState(db, link.invoice_id)
  if (!s) return err('not_found', 404)
  const lang: Lang = (s.terms?.language || 'en') as Lang
  const gateOk = link.gate !== 'CONTACT' || gatePassOk(link.id, req.cookies.get(gateCookieName(link.id))?.value)
  const dto = async () => {
    const pay = await payModeOk(!!link.is_test)
    const base = publicDto(s, link as any, { rails: await railsEnabled(), payOk: pay.ok, inApp: isInApp(ua), gateOk })
    if (!(await settingOn(OTP_SETTING))) return base                    // OFF → the DTO is exactly the pre-OTP one
    const tg = otpTarget(s)
    const verified = s.live ? await otpPassLive(supabaseOtpStore(db), link.id, s.live.id).catch(() => false) : false
    return { ...base, otp: { needed: !!tg, verified, hint: otpHint(tg) } }
  }

  switch (action) {
    case 'open': {
      if (await limited(db, 'get', req, link.id)) return err('err_rate', 429)
      const res = j(await dto())
      res.cookies.set(cookieName(link.id), String(body.token), { httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 60 * 60 * 24 * 180 })
      return res
    }
    case 'state': {
      if (await limited(db, 'get', req, link.id)) return err('err_rate', 429)
      return j(await dto())
    }
    case 'view': {
      if (isCrawler(ua)) return j({ ok: true, counted: false })
      if (await limited(db, 'view', req, link.id)) return err('err_rate', 429)
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const recent = s.events.some(e => e.kind === 'VIEWED' && e.at >= since)
      const now = new Date().toISOString()
      await db.from('quote_links').update({ first_viewed_at: link.first_viewed_at || now, last_viewed_at: now, view_count: Number(link.view_count || 0) + 1 }).eq('id', link.id)
      if (!recent && s.live) await ev(db, link.invoice_id, s.live.id, 'VIEWED', { ua_class: uaClass(ua), country: req.headers.get('x-vercel-ip-country') || null })
      return j({ ok: true, counted: !recent })
    }
    case 'gate': {
      if (link.gate !== 'CONTACT') return j({ ok: true })
      if (await limited(db, 'gate', req, link.id)) return err('err_rate', 429)
      const ih = ipHash(req)
      const { data: row } = await db.from('quote_gate_fails').select('locked_until').eq('link_id', link.id).eq('ip_hash', ih).maybeSingle()
      if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
        return err('err_gate_locked', 429, { minutes: Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60000) })
      }
      const client = s.bundle.client
      const answer = String(body.answer || '')
      const ok = link.gate_tier === 'PHONE4'
        ? phoneDigits(answer).length >= 4 && sameHash(phoneDigits(answer).slice(-4), phoneDigits(client?.phone).slice(-4))
        : !!client?.email && sameHash(normEmail(answer), normEmail(String(client.email)))
      if (!ok) {
        const { data: f } = await db.rpc('gate_fail', { p_link: link.id, p_ip_hash: ih })
        if ((f as any)?.cap) await ev(db, link.invoice_id, s.live?.id || null, 'GATE_CAP', {})
        const lu = (f as any)?.locked_until
        if (lu && new Date(lu).getTime() > Date.now()) return err('err_gate_locked', 429, { minutes: Math.ceil((new Date(lu).getTime() - Date.now()) / 60000) })
        return err('err_gate', 403)
      }
      const res = j({ ok: true })
      res.cookies.set(gateCookieName(link.id), gatePass(link.id), { httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 15 * 60 })
      return res
    }
    case 'sign': {
      if (await limited(db, 'sign', req, link.id)) return err('err_rate', 429)
      const isCo = s.live?.kind === 'CHANGE_ORDER' && !s.bundle.invoice.is_quote   // M4: a change order is approved on the same link
      if (!s.live || (!s.bundle.invoice.is_quote && !isCo)) return err('err_stale', 409)
      if (s.approvalOnLive) return err('already_approved', 409)
      if (!gateOk) return err('err_gate', 403, { gate: true })
      if (body.revision_id !== s.live.id || body.sha256 !== s.live.sha256) return err('err_stale', 409)
      if (body.terms_sha256 !== s.live.terms_sha256 || body.terms_sha256 !== termsSha256(lang)) return err('err_stale', 409)
      const raw = String(body.signer_name || '')
      const name = cleanName(raw)
      if (name.length < 2) return err('err_name')
      const c = { ...(body.consents || {}) }
      if (c.erecords !== true || c.terms !== true) return err('err_consent')
      if (isCo) { c.estimate = c.estimate || s.terms?.disclosure_choice || 'WAIVE'; c.parts_return = c.parts_return || s.terms?.parts_return_choice || 'NONE'; c.limit_amount = c.limit_amount ?? s.terms?.disclosure_limit ?? null }   // the elections of the signed quote carry over
      if (!['REQUEST', 'LIMIT', 'WAIVE'].includes(c.estimate) || !['RETURN', 'INSPECT', 'NONE'].includes(c.parts_return)) return err('err_choice')
      const limit = Number(c.limit_amount)
      if (c.estimate === 'LIMIT' && !(limit > 0)) return err('err_limit')
      const consents = { erecords: true, terms: true, estimate: c.estimate, limit_amount: c.estimate === 'LIMIT' ? limit : null, parts_return: c.parts_return,
        signer_name_sha256: createHash('sha256').update(raw).digest('hex'), consent_text: 'consent_erecords+consent_terms', language: lang }
      const otpOn = await settingOn(OTP_SETTING)
      const otp = otpOn ? await otpSignGate({ on: true, store: supabaseOtpStore(db), linkId: link.id, revisionId: s.live.id, channelAvailable: !!otpTarget(s) }) : null
      if (otp && !otp.ok) return err(otp.error, 403, { otp: true })
      const ip = (req.headers.get('x-real-ip') || req.headers.get('x-vercel-forwarded-for') || '').trim() || null
      const { error } = await db.rpc('quote_approve', { p_invoice: link.invoice_id, p_link: link.id, p_revision: s.live.id, p_sha256: s.live.sha256,
        p_terms_sha256: s.live.terms_sha256, p_signer_name: name, p_signer_contact: null, p_consents: consents,
        p_attribution: attribution(req, { gate_tier: link.gate === 'CONTACT' ? link.gate_tier : null, gate_ok: gateOk, ...(otp?.ok ? otp.attribution : {}) }),
        p_method: 'CLIENT_ESIGN', p_recorded_by: null, p_ip: ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null, p_user_agent: (ua || '').slice(0, 400),
        p_note: null, p_evidence_url: null, p_signature_path: null })
      if (error) return /stale|not live|changed|already/i.test(error.message) ? err('err_stale', 409) : (console.error('[q sign]', error.message), err('err_generic', 500))
      if (otp?.ok) await otpConsume(supabaseOtpStore(db), link.id).catch(e => console.error('[q sign] otp consume', (e as Error).message))
      if (isCo) { const ap = await db.rpc('change_order_apply', { p_revision: s.live.id, p_actor: 'client' }); if (ap.error) console.error('[q sign] change_order_apply', ap.error.message) }
      { const inv0 = link.invoice_id, rev0 = s.live.id; nextAfter(() => import('@/lib/notify.server').then(m => m.notifyAll(serviceDb(), ['notify.client.signed_copy', 'notify.reports.quote_signed'], { invoiceId: inv0, revisionId: rev0 })).catch(e => console.error('[q sign notify]', e?.message || e))) }   // M4 switchboard (keys OFF → NOTIFY_SKIPPED)
      const s2 = await loadDocState(db, link.invoice_id)
      const pay = await payModeOk(!!link.is_test)
      return j(publicDto(s2!, link as any, { rails: await railsEnabled(), payOk: pay.ok, inApp: isInApp(ua), gateOk }))
    }
    case 'checkout': {
      if (await limited(db, 'checkout', req, link.id)) return err('err_rate', 429)
      if (!s.live || (!s.approvalOnLive && s.bundle.invoice.is_quote)) return err('not_approved', 409)
      if (s.live.kind === 'CHANGE_ORDER' && !s.approvalOnLive) return err('co_pending', 409)   // M4: payments resume after the change order is approved
      const seq = Number(body.seq || 1)
      // ONE online button (10/11/2026): Checkout offers every method of the Stripe account, so the rail is only the label the attempt
      // opens with — the first Stripe rail the terms carry and the settings allow. None of them = no online payment on this document.
      const enabled = await railsEnabled()
      const rail = (['card', 'us_bank_account'] as const).find(r => s.terms?.rails.includes(r) && enabled.includes(r))
      if (!rail) return err('err_pay_unavailable', 409, { rail_unavailable: true })
      const pay = await payModeOk(!!link.is_test)
      if (!pay.ok) {
        await ev(db, link.invoice_id, s.live.id, 'RAIL_UNAVAILABLE', { rail, reason: pay.reason })
        return err('err_pay_unavailable', 409, { rail_unavailable: true })
      }
      const plan = (s.live.document?.installments || []) as any[]
      const inst = plan.find(i => Number(i.seq) === seq)
      if (!inst) return err('bad_seq')
      if (s.stage.paidBySeq[seq]) return err('already_paid', 409)
      if (seq === plan[plan.length - 1]?.seq && plan.length > 1 && s.planDrift !== 0) return err('balance_pending_update', 409)
      if (s.attempts.some(a => a.status === 'PROCESSING')) return err('clearing_no_card', 409)
      try {
        const r = await openDepositCheckout(db, { invoiceId: link.invoice_id, linkId: link.id, seq, rail, livemode: pay.livemode, actor: 'client',
          revision: s.live, client: s.bundle.client, ride: s.bundle.ride, service: String(s.bundle.invoice.service || ''), lang })
        return j({ url: r.url })
      } catch (e) {
        const m = (e as Error).message
        console.error('[q checkout]', m)
        if (/clearing|409/.test(m)) return err('clearing_no_card', 409)
        await ev(db, link.invoice_id, s.live.id, 'RAIL_UNAVAILABLE', { rail, reason: m.slice(0, 200) })
        return err('err_pay_unavailable', 409, { rail_unavailable: true })
      }
    }
    case 'landing': {
      if (await limited(db, 'landing', req, link.id)) return err('err_rate', 429)
      const attemptId = String(body.attempt_id || '')
      const att = s.attempts.find(a => a.id === attemptId)
      if (!att || !att.checkout_session_id) return err('not_found', 404)
      let state = 'landing_pending'
      try { const r = await claimAndFulfil(db, att.checkout_session_id, 'landing'); state = r.state } catch (e) { console.error('[q landing]', (e as Error).message) }
      const s2 = await loadDocState(db, link.invoice_id)
      const pay = await payModeOk(!!link.is_test)
      return j({ landing: state, ...publicDto(s2!, link as any, { rails: await railsEnabled(), payOk: pay.ok, inApp: isInApp(ua), gateOk }) })
    }
    case 'promised': {
      if (await limited(db, 'promised', req, link.id)) return err('err_rate', 429)
      await ev(db, link.invoice_id, s.live?.id || null, 'PAYMENT_PROMISED', { seq: Number(body.seq || 1), method: String(body.method || 'ZELLE').slice(0, 20) })
      return j({ ok: true })
    }
    case 'changes': {
      if (await limited(db, 'changes', req, link.id)) return err('err_rate', 429)
      const text = String(body.text || '').trim().slice(0, 1000)
      if (text.length < 2 || !s.live) return err('err_generic')
      if (s.clientNotes.some(n => n.kind === 'CHANGES' && !n.hidden_at && n.revision_id === s.live!.id)) return j({ ok: true, already: true })
      const { data: n, error } = await db.from('invoice_client_notes').insert({ invoice_id: link.invoice_id, revision_id: s.live.id, kind: 'CHANGES', text }).select('id').single()
      if (error) return err('err_generic', 500)
      await ev(db, link.invoice_id, s.live.id, 'CHANGES_REQUESTED', { note_id: n.id })
      return j({ ok: true })
    }
    case 'decline': {
      if (await limited(db, 'decline', req, link.id)) return err('err_rate', 429)
      const reason = ['TIMING', 'SCOPE', 'OTHER'].includes(body.reason) ? body.reason : 'OTHER'
      const text = String(body.text || '').trim().slice(0, 1000)
      const { data: n } = await db.from('invoice_client_notes').insert({ invoice_id: link.invoice_id, revision_id: s.live?.id || null, kind: 'DECLINE', text: text || reason, reason })
        .select('id').single()
      await ev(db, link.invoice_id, s.live?.id || null, 'DECLINED', { note_id: n?.id || null, reason })
      return j({ ok: true })
    }
    case 'decline-withdraw': {
      if (await limited(db, 'decline', req, link.id)) return err('err_rate', 429)
      await ev(db, link.invoice_id, s.live?.id || null, 'DECLINE_WITHDRAWN', {})
      return j({ ok: true })
    }
    case 'renewal': {
      if (s.stage.stage !== 'EXPIRED') return err('not_expired', 409)
      if (await limited(db, 'renewal', req, link.id)) return j({ ok: true, already: true })
      await ev(db, link.invoice_id, s.live?.id || null, 'RENEWAL_REQUESTED', {})
      return j({ ok: true })
    }
    case 'otp-send':
    case 'otp-verify': {
      if (!(await settingOn(OTP_SETTING))) return err('unknown', 404)       // OFF → these actions do not exist
      if (await limited(db, 'otp', req, link.id)) return err('err_rate', 429)
      if (!s.live || s.approvalOnLive) return err('err_stale', 409)
      if (!gateOk) return err('err_gate', 403, { gate: true })
      const store = supabaseOtpStore(db)
      if (action === 'otp-verify') {
        const v = await otpVerify(store, { linkId: link.id, revisionId: s.live.id, code: String(body.code || '') })
        if (v.ok) return j({ ok: true, verified_at: v.verified_at })
        return err(v.error, v.error === 'err_otp_locked' ? 429 : 403, v)
      }
      const tg = otpTarget(s)
      if (!tg) return err('err_otp_no_channel', 409)
      const iss = await otpIssue(store, { linkId: link.id, revisionId: s.live.id, channel: tg.channel })
      if (!iss.ok) return err(iss.error, iss.error === 'err_generic' ? 500 : 429, iss)
      const { sendOtpMessage } = await import('@/lib/notify.server')
      const sent = await sendOtpMessage(db, { invoiceId: link.invoice_id, revisionId: s.live.id, isTest: !!link.is_test, channel: tg.channel, to: tg.to, code: iss.code,
        lang, docCode: String(s.live.document?.header?.display_code || s.bundle.invoice.invoice_code || '') })
      if (!sent.sent) return err('err_otp_send', 502)
      return j({ ok: true, hint: otpHint(tg) })
    }
    default:
      return err('unknown', 404)
  }
}
