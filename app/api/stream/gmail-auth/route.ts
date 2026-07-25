import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { setMailAuth } from '@/lib/streamMail.server'

// Gmail hookup, step 1 — mirrors the Microsoft mail-auth flow, but for Google.
// Slot 4 of stream_mail_auth is the Gmail row. Requires GOOGLE_CLIENT_ID (and
// the callback needs GOOGLE_CLIENT_SECRET). Redirects to Google's consent
// screen with offline access so a refresh token comes back.

export const dynamic = 'force-dynamic'

const SLOT = 4
export const GMAIL_SCOPE = 'https://mail.google.com/'

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 503 })
  const state = `${SLOT}.${crypto.randomUUID()}`
  const db = streamDb()
  await setMailAuth(db, { client_id: clientId, oauth_state: state, pkce_verifier: null }, SLOT)
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
