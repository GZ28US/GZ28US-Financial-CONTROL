import { NextRequest } from 'next/server'
import { socialDb, takeState, upsertRow, resultPage, platformOn, EBAY_SCOPES } from '@/lib/social.server'

// INTEGRATIONS · EBAY step 2 (09/11/2026). code → access (2 h) + refresh (~18 months); the Identity API says which eBay user consented.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (!(await platformOn('EBAY'))) return resultPage('eBay NOT connected', 'social.ebay.enabled is OFF.', false)
  const db = socialDb()
  const st = await takeState(db, 'EBAY', sp.get('state'))
  if (!st) return resultPage('eBay NOT connected', 'This link is unknown, used or older than 30 minutes — start again at /ca/social/connect.', false)
  const code = sp.get('code')
  if (!code) return resultPage('eBay NOT connected', sp.get('error_description') || sp.get('error') || 'No code returned', false)
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const tok = await (await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME! }),
  })).json().catch(() => ({}))
  if (!tok?.access_token) return resultPage('eBay NOT connected', tok?.error_description || tok?.error || 'token exchange failed', false)
  const me = await (await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json().catch(() => ({}))
  const id = me?.userId || me?.username
  if (!id) return resultPage('eBay NOT connected', 'Could not tell which eBay user consented.', false)
  await upsertRow(db, {
    platform: 'EBAY', kind: 'EBAY_USER', external_id: String(id), account: me.username || String(id),
    access_token: tok.access_token, refresh_token: tok.refresh_token, access_expires_in: tok.expires_in,
    refresh_expires_in: tok.refresh_token_expires_in, scopes: EBAY_SCOPES, connected_by: st.by,
  })
  return resultPage('eBay connected', `${me.username || id}\n\nYou can close this tab.`, true)
}
