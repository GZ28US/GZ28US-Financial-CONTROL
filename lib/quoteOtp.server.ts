// SERVER-ONLY — THE SIGNING CODE (OTP) of the quote portal (08/11/2026; blueprint §5.2 item (5), §16 M4). Behind app_settings
// `quote_portal.sign_otp` (born false). OFF → `otpSignGate` returns null and the sign path is untouched. ON → before the e-signature
// the client asks for a 6-digit code, sent on the SAME channel the quote went on (WhatsApp; e-mail when there is no phone), and types it.
//
// Rules (one row per link in `quote_sign_otps`, MIGRATION_quote_portal_sign_otp.sql — service_role only, RLS denies anon/authenticated):
//   • the code is stored only as HMAC-SHA256(secret, link|code) — never in clear, never in a log; 10-minute expiry;
//   • a wrong code counts a try; 5 wrong tries → 15-minute lock (tries survive a resend, so a resend never buys more guesses);
//   • a new code at most once per 60 s; a new code replaces the old one;
//   • compare = constant time (timingSafeEqual on the two HMACs);
//   • a verified code is a pass for 15 minutes, for THIS revision, used once (consumed by the signature);
//   • the approval's attribution records `otp_channel` + `otp_verified_at`.
// Every write is conditional on the row's `tries` as read (optimistic), so two parallel guesses never both escape the count.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_MAX_TRIES = 5
export const OTP_LOCK_MS = 15 * 60 * 1000
export const OTP_RESEND_MS = 60 * 1000
export const OTP_PASS_MS = 15 * 60 * 1000

export type OtpChannel = 'WHATSAPP' | 'EMAIL'
export type OtpRow = {
  link_id: string; revision_id: string; channel: OtpChannel; code_hash: string | null; expires_at: string | null; last_sent_at: string | null
  sends: number; tries: number; locked_until: string | null; verified_at: string | null; consumed_at: string | null
}
export interface OtpStore {
  get(linkId: string): Promise<OtpRow | null>
  // insert when `expectTries === null` (fails if a row exists); otherwise update only if the stored tries still equal expectTries
  put(row: OtpRow, expectTries: number | null): Promise<boolean>
}

export function supabaseOtpStore(db: SupabaseClient): OtpStore {
  return {
    async get(linkId) {
      const { data, error } = await db.from('quote_sign_otps').select('*').eq('link_id', linkId).maybeSingle()
      if (error) throw new Error('otp store: ' + error.message)
      return (data as OtpRow | null) || null
    },
    async put(row, expectTries) {
      if (expectTries === null) {
        const { error } = await db.from('quote_sign_otps').insert(row)
        return !error
      }
      const { data, error } = await db.from('quote_sign_otps').update({ ...row, updated_at: new Date().toISOString() }).eq('link_id', row.link_id).eq('tries', expectTries).select('link_id')
      return !error && (data || []).length === 1
    },
  }
}

function secret(): Buffer {
  const own = process.env.QUOTE_GATE_SECRET
  if (own && own.length >= 32) return Buffer.from(own)
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base) throw new Error('no secret available for the signing code (QUOTE_GATE_SECRET / SUPABASE_SERVICE_ROLE_KEY)')
  return createHmac('sha256', base).update('gz28-quote-otp-v1').digest()
}
export const otpHash = (linkId: string, code: string) => createHmac('sha256', secret()).update(`otp|${linkId}|${code}`).digest('hex')
export function otpEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y)
}
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

// Which channel: the one the live revision was SENT on when it is e-mail and the client has an e-mail; otherwise WhatsApp when the
// client has a phone; otherwise e-mail; otherwise none (the caller records that the code could not be asked).
export function otpChannelFor(sentChannel: string | null | undefined, waTo: string | null, email: string | null | undefined): { channel: OtpChannel; to: string } | null {
  const mail = String(email || '').trim()
  if (String(sentChannel || '').toUpperCase() === 'EMAIL' && mail) return { channel: 'EMAIL', to: mail }
  if (waTo) return { channel: 'WHATSAPP', to: waTo }
  if (mail) return { channel: 'EMAIL', to: mail }
  return null
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0)
const mins = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 60000))

export type IssueOut = { ok: true; code: string } | { ok: false; error: 'err_otp_locked'; minutes: number } | { ok: false; error: 'err_otp_wait'; seconds: number } | { ok: false; error: 'err_generic' }

// A new code for this link (never returned to the client — the caller sends it and forgets it).
export async function otpIssue(store: OtpStore, o: { linkId: string; revisionId: string; channel: OtpChannel; now?: number; code?: string }): Promise<IssueOut> {
  const now = o.now ?? Date.now()
  const row = await store.get(o.linkId)
  if (row && ms(row.locked_until) > now) return { ok: false, error: 'err_otp_locked', minutes: mins(ms(row.locked_until), now) }
  if (row && ms(row.last_sent_at) + OTP_RESEND_MS > now) return { ok: false, error: 'err_otp_wait', seconds: Math.ceil((ms(row.last_sent_at) + OTP_RESEND_MS - now) / 1000) }
  const code = o.code ?? newCode()
  const next: OtpRow = {
    link_id: o.linkId, revision_id: o.revisionId, channel: o.channel, code_hash: otpHash(o.linkId, code),
    expires_at: new Date(now + OTP_TTL_MS).toISOString(), last_sent_at: new Date(now).toISOString(), sends: (row?.sends || 0) + 1,
    tries: row?.tries ?? 0, locked_until: null, verified_at: null, consumed_at: null,
  }
  const ok = await store.put(next, row ? row.tries : null)
  return ok ? { ok: true, code } : { ok: false, error: 'err_generic' }
}

export type VerifyOut = { ok: true; verified_at: string; channel: OtpChannel } |
  { ok: false; error: 'err_otp'; left: number } | { ok: false; error: 'err_otp_locked'; minutes: number } | { ok: false; error: 'err_otp_expired' | 'err_otp_none' | 'err_generic' }

export async function otpVerify(store: OtpStore, o: { linkId: string; revisionId: string; code: string; now?: number }): Promise<VerifyOut> {
  const now = o.now ?? Date.now()
  const row = await store.get(o.linkId)
  if (row && ms(row.locked_until) > now) return { ok: false, error: 'err_otp_locked', minutes: mins(ms(row.locked_until), now) }
  if (!row || !row.code_hash) return { ok: false, error: 'err_otp_none' }
  if (row.revision_id !== o.revisionId) return { ok: false, error: 'err_otp_none' }
  if (ms(row.expires_at) <= now) return { ok: false, error: 'err_otp_expired' }
  const typed = String(o.code || '').replace(/\D/g, '')
  // hash whatever was typed (even a malformed one) so the timing never says whether the shape was right
  const good = otpEqual(otpHash(o.linkId, typed.length === 6 ? typed : 'x' + typed), row.code_hash) && typed.length === 6
  if (good) {
    const verified_at = new Date(now).toISOString()
    const ok = await store.put({ ...row, code_hash: null, tries: 0, verified_at, consumed_at: null }, row.tries)
    return ok ? { ok: true, verified_at, channel: row.channel } : { ok: false, error: 'err_generic' }
  }
  const tries = row.tries + 1
  if (tries >= OTP_MAX_TRIES) {
    const until = now + OTP_LOCK_MS
    const ok = await store.put({ ...row, tries: 0, code_hash: null, locked_until: new Date(until).toISOString() }, row.tries)
    return ok ? { ok: false, error: 'err_otp_locked', minutes: mins(until, now) } : { ok: false, error: 'err_generic' }
  }
  const ok = await store.put({ ...row, tries }, row.tries)
  return ok ? { ok: false, error: 'err_otp', left: OTP_MAX_TRIES - tries } : { ok: false, error: 'err_generic' }
}

// The sign path's check. `on` false → null (the caller adds NOTHING — the sign path is byte-for-byte what it was).
// `channelAvailable` false → the code could not be asked (no phone, no e-mail): the signature proceeds and says so in the attribution.
export async function otpSignGate(o: { on: boolean; store: OtpStore; linkId: string; revisionId: string; channelAvailable: boolean; now?: number }):
  Promise<null | { ok: true; attribution: Record<string, unknown> } | { ok: false; error: 'err_otp_required' }> {
  if (!o.on) return null
  if (!o.channelAvailable) return { ok: true, attribution: { otp_channel: null, otp_verified_at: null, otp_skipped: 'no phone or e-mail on file' } }
  const now = o.now ?? Date.now()
  const row = await o.store.get(o.linkId)
  if (!row || !row.verified_at || row.consumed_at || row.revision_id !== o.revisionId || ms(row.verified_at) + OTP_PASS_MS <= now) return { ok: false, error: 'err_otp_required' }
  return { ok: true, attribution: { otp_channel: row.channel, otp_verified_at: row.verified_at } }
}
// After a successful signature: the pass is used once.
export async function otpConsume(store: OtpStore, linkId: string, now = Date.now()) {
  const row = await store.get(linkId)
  if (row?.verified_at && !row.consumed_at) await store.put({ ...row, consumed_at: new Date(now).toISOString() }, row.tries)
}
// Is there a live pass right now (for the page's DTO)?
export async function otpPassLive(store: OtpStore, linkId: string, revisionId: string, now = Date.now()): Promise<boolean> {
  const row = await store.get(linkId)
  return !!row?.verified_at && !row.consumed_at && row.revision_id === revisionId && ms(row.verified_at) + OTP_PASS_MS > now
}
