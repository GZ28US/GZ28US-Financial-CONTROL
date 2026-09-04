import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, pkcePair, authUrl, mailProvider } from '@/lib/streamMail.server'

// Mail hookup, step 1 — visit this URL in a browser, sign in with the target
// mailbox and consent. PKCE verifier + state are minted here, stashed in
// stream_mail_auth, and checked by the callback. No client secret exists
// anywhere: the Azure app is a public client.
//
// Multi-account (2026-07-24): ?slot=N picks the stream_mail_auth row —
//   1 (default) = gz28us@hotmail.com (the STREAM watcher's box)
//   2 = galpaoz28@hotmail.com · 3 = gz28br@hotmail.com · ...
// The state carries the slot so the callback stores the token in the right row.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get('slot') || '1') || 1)
  const db = streamDb()
  // client_id lives on row 1 (the original hookup) and is shared by every slot.
  const base = await getMailAuth(db, 1)
  if (!base?.client_id) {
    return NextResponse.json({ error: 'client_id not configured in stream_mail_auth yet' }, { status: 503 })
  }
  // Slot que já é uma caixa Google conectada não pode virar Microsoft por
  // engano: o client_id da Azure sobrescreveria o do Google e a caixa morreria
  // muda (04/set/2026 — espelho da guarda do gmail-auth).
  const existing = await getMailAuth(db, slot)
  if (existing?.refresh_token && mailProvider(existing) === 'gmail') {
    return NextResponse.json({ error: `slot ${slot} is a Google mailbox (${existing.account || '?'}) — use /api/stream/gmail-auth?slot=${slot} or pick another slot` }, { status: 409 })
  }
  const { verifier, challenge } = pkcePair()
  const state = `${slot}.${pkcePair().verifier.slice(0, 24)}`
  await setMailAuth(db, { client_id: base.client_id, pkce_verifier: verifier, oauth_state: state }, slot)
  return NextResponse.redirect(authUrl(base.client_id, challenge, state))
}
