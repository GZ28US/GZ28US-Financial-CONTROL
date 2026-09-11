import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, mailProvider } from '@/lib/streamMail.server'
import { requireUser } from '@/lib/apiAuth.server'

// Gmail hookup, step 1 — mirrors the Microsoft mail-auth flow, but for Google.
// Requires GOOGLE_CLIENT_ID (and the callback needs GOOGLE_CLIENT_SECRET).
// Returns the URL of Google's consent screen (offline access, so a refresh
// token comes back); /ca/stream/connect sends the browser there.
//
// Multi-account (04/set/2026): slot N picks the stream_mail_auth row —
//   4 (default) = gz28us@gmail.com (the original hookup, 26/ago)
//   5 = gz28speedshop@gmail.com · ...
// The state carries the slot so the callback stores the token in the right row
// (same trick as mail-auth). Which provider a row speaks is derived from the
// row itself (mailProvider) — so a slot that already holds a CONNECTED
// Microsoft mailbox is refused: hooking Google into it would overwrite the
// Azure client_id and silently kill that box.
//
// PORTÃO (11/set/2026) — mesma lei do mail-auth: começar exige admin logado
// (POST + requireUser, resposta { url }), o GET só aponta a tela, e o state leva
// `N.<uuid>.replace|keep`. Sem o `replace`, o gmail-callback nunca grava por cima
// de outra conta: conta diferente vai para a própria linha ou para um slot novo,
// como já ia.

export const dynamic = 'force-dynamic'

export const GMAIL_SCOPE = 'https://mail.google.com/'

// GET não liga mais nada — só aponta a tela, com o slot do link antigo.
export async function GET(req: NextRequest) {
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get('slot') || '4') || 4)
  const href = `/ca/stream/connect?provider=gmail&slot=${slot}`
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Connect a mailbox</title>
     <body style="background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
     <div style="text-align:center"><h1>This link no longer connects a mailbox</h1>
     <p style="color:#9ca3af;font-size:18px">Sign in to the app and use <a style="color:#60a5fa" href="${href}">/ca/stream/connect</a>.</p></div>`,
    { status: 405, headers: { 'Content-Type': 'text/html; charset=utf-8', Allow: 'POST' } },
  )
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 503 })
  const b = await req.json().catch(() => ({}))
  const slot = Math.max(1, parseInt(String(b?.slot ?? '4')) || 4)
  // Só `true` de verdade troca a conta do slot — qualquer outra coisa é manter.
  const replace = b?.replace === true
  const db = streamDb()
  const existing = await getMailAuth(db, slot)
  if (existing?.refresh_token && mailProvider(existing) !== 'gmail') {
    return NextResponse.json({ error: `slot ${slot} is a Microsoft mailbox (${existing.account || '?'}) — pick another slot` }, { status: 409 })
  }
  const state = `${slot}.${crypto.randomUUID()}.${replace ? 'replace' : 'keep'}`
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
  return NextResponse.json({ url: url.toString() })
}
