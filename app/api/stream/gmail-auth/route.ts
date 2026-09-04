import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, mailProvider } from '@/lib/streamMail.server'

// Gmail hookup, step 1 — mirrors the Microsoft mail-auth flow, but for Google.
// Requires GOOGLE_CLIENT_ID (and the callback needs GOOGLE_CLIENT_SECRET).
// Redirects to Google's consent screen with offline access so a refresh token
// comes back.
//
// Multi-account (04/set/2026): ?slot=N picks the stream_mail_auth row —
//   4 (default) = gz28us@gmail.com (the original hookup, 26/ago)
//   5 = gz28speedshop@gmail.com · ...
// The state carries the slot so the callback stores the token in the right row
// (same trick as mail-auth). Which provider a row speaks is derived from the
// row itself (mailProvider) — so a slot that already holds a CONNECTED
// Microsoft mailbox is refused: hooking Google into it would overwrite the
// Azure client_id and silently kill that box.

export const dynamic = 'force-dynamic'

export const GMAIL_SCOPE = 'https://mail.google.com/'

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 503 })
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get('slot') || '4') || 4)
  const db = streamDb()
  const existing = await getMailAuth(db, slot)
  if (existing?.refresh_token && mailProvider(existing) !== 'gmail') {
    return NextResponse.json({ error: `slot ${slot} is a Microsoft mailbox (${existing.account || '?'}) — pick another slot` }, { status: 409 })
  }
  const state = `${slot}.${crypto.randomUUID()}`
  await setMailAuth(db, { client_id: clientId, oauth_state: state, pkce_verifier: null }, slot)
  const redirect = `${req.nextUrl.origin}/ca/api/stream/gmail-callback`
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GMAIL_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString())
}
