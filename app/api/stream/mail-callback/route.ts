import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, exchangeCode } from '@/lib/streamMail.server'

// STREAM mail hookup, step 2 — Microsoft redirects here after consent. The
// code is exchanged (PKCE, no secret) and the refresh token is stored straight
// into stream_mail_auth: it never travels through a chat, a file or an env
// var. The page just says whether it worked.

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
  const errDesc = req.nextUrl.searchParams.get('error_description')
  if (!code) return page('Mail hookup failed', errDesc || 'No code returned', false)

  const db = streamDb()
  const auth = await getMailAuth(db)
  if (!auth?.client_id || !auth.pkce_verifier) return page('Mail hookup failed', 'No pending auth — start at /api/stream/mail-auth', false)
  if (!state || state !== auth.oauth_state) return page('Mail hookup failed', 'State mismatch — start again at /api/stream/mail-auth', false)

  const res = await exchangeCode(auth.client_id, code, auth.pkce_verifier)
  if (!res?.refresh_token) return page('Mail hookup failed', res?.error_description || 'Token exchange failed', false)

  await setMailAuth(db, { refresh_token: res.refresh_token, pkce_verifier: null, oauth_state: null })
  return page('STREAM mail connected', 'gz28us@hotmail.com is hooked up — shipping emails now feed the STREAM board automatically. You can close this tab.', true)
}
