import { NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, pkcePair, authUrl } from '@/lib/streamMail.server'

// STREAM mail hookup, step 1 — visit this URL in a browser, sign in with
// gz28us@hotmail.com and consent. PKCE verifier + state are minted here,
// stashed in stream_mail_auth, and checked by the callback. No client secret
// exists anywhere: the Azure app is a public client.

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = streamDb()
  const auth = await getMailAuth(db)
  if (!auth?.client_id) {
    return NextResponse.json({ error: 'client_id not configured in stream_mail_auth yet' }, { status: 503 })
  }
  const { verifier, challenge } = pkcePair()
  const state = pkcePair().verifier.slice(0, 24)
  await setMailAuth(db, { pkce_verifier: verifier, oauth_state: state })
  return NextResponse.redirect(authUrl(auth.client_id, challenge, state))
}
