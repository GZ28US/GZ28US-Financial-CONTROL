import { NextRequest } from 'next/server'
import { socialDb, takeState, callbackUrl, upsertRow, resultPage, platformOn } from '@/lib/social.server'

// SOCIAL LINK · TIKTOK step 2 (09/11/2026). code → access (24 h) + refresh (365 d, rotates); user/info says which account consented.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (!(await platformOn('TIKTOK'))) return resultPage('TikTok NOT connected', 'social.tiktok.enabled is OFF.', false)
  const db = socialDb()
  const st = await takeState(db, 'TIKTOK', sp.get('state'))
  if (!st) return resultPage('TikTok NOT connected', 'This link is unknown, used or older than 30 minutes — start again at /ca/social/connect.', false)
  const code = sp.get('code')
  if (!code) return resultPage('TikTok NOT connected', sp.get('error_description') || sp.get('error') || 'No code returned', false)
  const tok = await (await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, code,
      grant_type: 'authorization_code', redirect_uri: callbackUrl(req.nextUrl.origin, 'TIKTOK'),
    }),
  })).json().catch(() => ({}))
  if (!tok?.access_token || !tok?.open_id) return resultPage('TikTok NOT connected', tok?.error_description || tok?.error || 'token exchange failed', false)
  const info = await (await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,avatar_url', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })).json().catch(() => ({}))
  const u = info?.data?.user || {}
  await upsertRow(db, {
    platform: 'TIKTOK', kind: 'TT_ACCOUNT', external_id: tok.open_id, account: u.username ? `@${u.username}` : (u.display_name || tok.open_id),
    access_token: tok.access_token, refresh_token: tok.refresh_token, access_expires_in: tok.expires_in, refresh_expires_in: tok.refresh_expires_in,
    scopes: String(tok.scope || '').split(',').filter(Boolean), connected_by: st.by, meta: { display_name: u.display_name || null },
  })
  return resultPage('TikTok connected', `${u.display_name || ''} ${u.username ? '@' + u.username : ''}\nScopes: ${tok.scope}\n\nYou can close this tab.`, true)
}
