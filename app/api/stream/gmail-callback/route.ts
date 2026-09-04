import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth } from '@/lib/streamMail.server'

// Gmail hookup, step 2 — Google redirects here after consent. The code is
// exchanged (client_id + client_secret, server-side only) and the refresh token
// is stored straight into the stream_mail_auth row named by the state's "N."
// prefix (04/set/2026 — before that, always slot 4): it never travels through
// a chat, a file or a screenshot. Mirrors mail-callback (Microsoft).

export const dynamic = 'force-dynamic'

const page = (title: string, body: string, ok: boolean) => new NextResponse(
  `<!doctype html><meta charset="utf-8"><title>${title}</title>
   <body style="background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
   <div style="text-align:center"><p style="font-size:64px;margin:0">${ok ? '✅' : '❌'}</p>
   <h1>${title}</h1><p style="color:#9ca3af;font-size:18px">${body}</p></div>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
)

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const errDesc = req.nextUrl.searchParams.get('error')
  if (!code) return page('Gmail hookup failed', errDesc || 'No code returned', false)

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return page('Gmail hookup failed', 'GOOGLE_CLIENT_ID/SECRET not configured', false)

  const slot = Math.max(1, parseInt((state || '').split('.')[0] || '4') || 4)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!state || state !== auth?.oauth_state) return page('Gmail hookup failed', 'State mismatch — start again at /api/stream/gmail-auth', false)

  const redirect = `${req.nextUrl.origin}/ca/api/stream/gmail-callback`
  const res = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  })).json()
  if (!res?.refresh_token) return page('Gmail hookup failed', res?.error_description || res?.error || 'Token exchange failed (no refresh token)', false)

  // Which mailbox did we just connect? Ask Gmail — never assume.
  let account: string | null = null
  try {
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${res.access_token}` } })).json()
    account = prof?.emailAddress || null
  } catch { /* best-effort */ }

  await setMailAuth(db, { refresh_token: res.refresh_token, account, oauth_state: null, pkce_verifier: null }, slot)
  return page('Gmail conectado', `${account || 'A conta'} está conectada (slot ${slot}). Pode fechar esta aba.`, true)
}
