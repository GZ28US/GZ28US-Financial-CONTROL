import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, pkcePair, authUrl } from '@/lib/streamMail.server'

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
  const { verifier, challenge } = pkcePair()
  const state = `${slot}.${pkcePair().verifier.slice(0, 24)}`
  await setMailAuth(db, { client_id: base.client_id, pkce_verifier: verifier, oauth_state: state }, slot)
  return NextResponse.redirect(authUrl(base.client_id, challenge, state))
}
