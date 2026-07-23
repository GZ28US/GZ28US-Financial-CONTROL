// SERVER-ONLY — STREAM phase 3: the gz28us@hotmail.com watcher.
// Reads the mailbox through Microsoft Graph (personal-account OAuth, PKCE
// public client — no client secret anywhere) and auto-captures tracking
// numbers from supplier "your order has shipped" emails. Auth state lives in
// stream_mail_auth (single row, RLS with no policies = service-role only):
//   client_id      — the Azure app registration id (public, not a secret)
//   refresh_token  — minted by /api/stream/mail-callback, rotated on use
//   pkce_verifier / oauth_state — transient, used once during the consent hop
//   last_poll      — high-water mark for the message scan

import type { SupabaseClient } from '@supabase/supabase-js'
import { guessCarrier, type StreamRow } from './stream'

export const MAIL_REDIRECT = 'https://www.gz28us.com/ca/api/stream/mail-callback'
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
export const MAIL_SCOPE = 'offline_access Mail.Read'

export type MailAuth = {
  id: number
  client_id: string | null
  refresh_token: string | null
  pkce_verifier: string | null
  oauth_state: string | null
  last_poll: string | null
}

export async function getMailAuth(db: SupabaseClient): Promise<MailAuth | null> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('id', 1).maybeSingle()
  return (data as MailAuth) || null
}
export async function setMailAuth(db: SupabaseClient, patch: Partial<MailAuth>): Promise<void> {
  await db.from('stream_mail_auth').upsert([{ id: 1, ...patch, updated_at: new Date().toISOString() }])
}

// ── OAuth (public client + PKCE, all server-side) ───────────────────────────
export function pkcePair(): { verifier: string; challenge: string } {
  const { randomBytes, createHash } = require('crypto') as typeof import('crypto')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authUrl(clientId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MAIL_REDIRECT,
    scope: MAIL_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  })
  return `${AUTHORITY}/authorize?${q}`
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const r = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  return r.json().catch(() => null)
}

export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<any> {
  return tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: MAIL_REDIRECT, code_verifier: verifier, scope: MAIL_SCOPE })
}

// Refresh → access token; Microsoft rotates the refresh token, so persist the
// new one every time or the chain eventually dies.
export async function freshAccessToken(db: SupabaseClient, auth: MailAuth): Promise<string | null> {
  if (!auth.client_id || !auth.refresh_token) return null
  const res = await tokenRequest({ client_id: auth.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, scope: MAIL_SCOPE })
  if (!res?.access_token) return null
  if (res.refresh_token && res.refresh_token !== auth.refresh_token) {
    await setMailAuth(db, { refresh_token: res.refresh_token })
  }
  return res.access_token
}

// ── message scanning ────────────────────────────────────────────────────────
export type MailMsg = { subject: string; from: string; fromAddr: string; received: string; text: string }

export async function fetchRecentMessages(accessToken: string, sinceIso: string): Promise<MailMsg[]> {
  const q = new URLSearchParams({
    $top: '50',
    $select: 'subject,from,receivedDateTime,body',
    $filter: `receivedDateTime ge ${sinceIso}`,
    $orderby: 'receivedDateTime desc',
  })
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?${q}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data?.value)) return []
  return data.value.map((m: any) => ({
    subject: String(m.subject || ''),
    from: String(m.from?.emailAddress?.name || ''),
    fromAddr: String(m.from?.emailAddress?.address || '').toLowerCase(),
    received: String(m.receivedDateTime || ''),
    text: String(m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' '),
  }))
}

// Every tracking-number shape we can trust from an email body/subject.
const TRACKING_RES: RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/g,             // UPS
  /\b9[2345]\d{20,24}\b/g,           // USPS 92/93/94/95…
  /\b\d{15}\b/g,                     // FedEx 15
  /\b\d{12}\b/g,                     // FedEx 12
  /\b[A-Z]{2}\d{9}US\b/g,            // USPS intl
]
export function extractTrackings(s: string): string[] {
  const out = new Set<string>()
  for (const re of TRACKING_RES) for (const m of s.match(re) || []) out.add(m)
  // A FedEx-12 match that is really a phone number etc. is filtered by context:
  // only keep 12-digit hits when a shippy word is nearby in the same text.
  return [...out].filter(t => !/^\d{12}$/.test(t) || /track|ship|carrier|fedex|deliver/i.test(s))
}

const normTok = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4)

// Does this email plausibly belong to this stream row's supplier?
export function supplierMatches(row: StreamRow, msg: MailMsg): boolean {
  const hay = `${msg.fromAddr} ${msg.from.toLowerCase()} ${msg.subject.toLowerCase()}`
  return normTok(row.supplier || '').some(tok => hay.includes(tok))
}

// Match open stream rows against one email. Strongest first:
//   1. the row's order number appears in the email
//   2. the sender/subject matches the row's supplier AND that supplier has
//      exactly ONE open row (no ambiguity)
export function matchRows(open: StreamRow[], msg: MailMsg): StreamRow[] {
  const inMail = `${msg.subject} ${msg.text}`
  const byOrder = open.filter(r => r.order_number && r.order_number.length >= 4 && inMail.includes(r.order_number))
  if (byOrder.length) return byOrder
  const bySupplier = open.filter(r => supplierMatches(r, msg))
  const suppliers = new Set(bySupplier.map(r => (r.supplier || '').toLowerCase()))
  return suppliers.size === 1 && bySupplier.length === 1 ? bySupplier : []
}

export { guessCarrier }
