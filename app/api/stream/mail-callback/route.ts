import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, exchangeCode } from '@/lib/streamMail.server'

// Mail hookup, step 2 — Microsoft redirects here after consent. The code is
// exchanged (PKCE, no secret) and the refresh token is stored straight into
// stream_mail_auth: it never travels through a chat, a file or an env var.
// Multi-account (2026-07-24): the state's "N." prefix picks the row, and the
// connected mailbox is discovered via Graph /me and recorded on the row.

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

  const slot = Math.max(1, parseInt((state || '').split('.')[0] || '1') || 1)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth?.client_id || !auth.pkce_verifier) return page('Mail hookup failed', 'No pending auth — start at /api/stream/mail-auth', false)
  if (!state || state !== auth.oauth_state) return page('Mail hookup failed', 'State mismatch — start again at /api/stream/mail-auth', false)

  const res = await exchangeCode(auth.client_id, code, auth.pkce_verifier)
  if (!res?.refresh_token) return page('Mail hookup failed', res?.error_description || 'Token exchange failed', false)

  // Which mailbox did we just connect? Ask Graph — never assume. /me comes back
  // empty without a User.Read scope on consumer accounts, so fall back to the
  // recipients of the inbox's own messages (mail addressed to the account).
  let account: string | null = null
  try {
    const gh = { Authorization: `Bearer ${res.access_token}` }
    const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail', { headers: gh })).json()
    account = me?.mail || me?.userPrincipalName || null
    if (!account) {
      const inb = await (await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=5&$select=toRecipients', { headers: gh })).json()
      const addrs = (inb?.value || []).flatMap((m: any) => (m.toRecipients || []).map((r: any) => String(r.emailAddress?.address || '').toLowerCase()))
      account = addrs.find((x: string) => x.includes('@hotmail') || x.includes('@outlook') || x.includes('@gz28')) || addrs[0] || null
    }
  } catch { /* best-effort */ }

  await setMailAuth(db, { refresh_token: res.refresh_token, account, pkce_verifier: null, oauth_state: null }, slot)
  return page('Mailbox connected', `${account || 'A conta'} está conectada (slot ${slot}). Pode fechar esta aba.`, true)
}
