import { NextRequest } from 'next/server'
import { socialDb, takeState, callbackUrl, upsertRow, resultPage, platformOn } from '@/lib/social.server'

// INTEGRATIONS · GOOGLE step 2 (09/11/2026). code (+ PKCE) → access + refresh; userinfo says WHICH Google account consented.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (!(await platformOn('GOOGLE'))) return resultPage('Google NOT connected', 'social.google.enabled is OFF.', false)
  const db = socialDb()
  const st = await takeState(db, 'GOOGLE', sp.get('state'))
  if (!st) return resultPage('Google NOT connected', 'This link is unknown, used or older than 30 minutes — start again at /ca/social/connect.', false)
  const code = sp.get('code')
  if (!code) return resultPage('Google NOT connected', sp.get('error') || 'No code returned', false)
  const tok = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl(req.nextUrl.origin, 'GOOGLE'), grant_type: 'authorization_code', code_verifier: st.verifier || '',
    }),
  })).json().catch(() => ({}))
  if (!tok?.access_token) return resultPage('Google NOT connected', tok?.error_description || tok?.error || 'token exchange failed', false)
  const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json().catch(() => ({}))
  if (!me?.email) return resultPage('Google NOT connected', 'Could not tell which Google account consented.', false)
  const scopes = String(tok.scope || '').split(' ').filter(Boolean)
  await upsertRow(db, {
    platform: 'GOOGLE', kind: 'GOOGLE_ACCOUNT', external_id: String(me.email).toLowerCase(), account: me.email,
    access_token: tok.access_token, refresh_token: tok.refresh_token, access_expires_in: tok.expires_in, scopes, connected_by: st.by,
  })
  const want = ['business.manage', 'calendar', 'adwords'].filter(s => !scopes.some(x => x.endsWith(s)))
  return resultPage('Google connected', `${me.email}${want.length ? `\n\nNot granted: ${want.join(', ')}` : ''}${tok.refresh_token ? '' : '\n\n⚠ No refresh token came back — revoke at myaccount.google.com/permissions and connect again.'}\n\nYou can close this tab.`, !!tok.refresh_token)
}
