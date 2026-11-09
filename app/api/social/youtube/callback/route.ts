import { NextRequest } from 'next/server'
import { socialDb, takeState, callbackUrl, upsertRow, resultPage, platformOn } from '@/lib/social.server'

// SOCIAL LINK · YOUTUBE step 2 (09/11/2026). code (+ PKCE verifier) → access + refresh token; channels.list(mine) says WHICH channel
// consented — never assumed. One YT_CHANNEL row per channel id.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (!(await platformOn('YOUTUBE'))) return resultPage('YouTube NOT connected', 'social.youtube.enabled is OFF.', false)
  const db = socialDb()
  const st = await takeState(db, 'YOUTUBE', sp.get('state'))
  if (!st) return resultPage('YouTube NOT connected', 'This link is unknown, used or older than 30 minutes — start again at /ca/social/connect.', false)
  const code = sp.get('code')
  if (!code) return resultPage('YouTube NOT connected', sp.get('error') || 'No code returned', false)
  const tok = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl(req.nextUrl.origin, 'YOUTUBE'), grant_type: 'authorization_code', code_verifier: st.verifier || '',
    }),
  })).json().catch(() => ({}))
  if (!tok?.access_token) return resultPage('YouTube NOT connected', tok?.error_description || tok?.error || 'token exchange failed', false)
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })).json().catch(() => ({}))
  const c = ch?.items?.[0]
  if (!c?.id) return resultPage('YouTube NOT connected', ch?.error?.message || 'That Google account has no YouTube channel — pick the @gz28us channel on the Google screen.', false)
  await upsertRow(db, {
    platform: 'YOUTUBE', kind: 'YT_CHANNEL', external_id: c.id, account: c.snippet?.customUrl || c.snippet?.title,
    access_token: tok.access_token, refresh_token: tok.refresh_token, access_expires_in: tok.expires_in,
    scopes: String(tok.scope || '').split(' ').filter(Boolean), connected_by: st.by,
    meta: { title: c.snippet?.title, uploads: c.contentDetails?.relatedPlaylists?.uploads || null },
  })
  return resultPage('YouTube connected', `${c.snippet?.title} (${c.snippet?.customUrl || c.id})${tok.refresh_token ? '' : '\n\n⚠ Google sent no refresh token — revoke the app at myaccount.google.com/permissions and connect again.'}\n\nYou can close this tab.`, !!tok.refresh_token)
}
