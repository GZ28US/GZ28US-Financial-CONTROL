import { NextRequest, NextResponse } from 'next/server'
import { startGate } from '@/lib/socialStart.server'
import { socialDb, mintState, callbackUrl, GOOGLE_SCOPES } from '@/lib/social.server'

// INTEGRATIONS · GOOGLE step 1 (09/11/2026). One consent on gz28us@gmail.com = Business Profile + Calendar + Google Ads. Same OAuth
// client as Gmail/YouTube; the Cloud project needs the APIs enabled and this callback URL added. Sign in as gz28us@gmail.com.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await startGate(req, 'GOOGLE', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
  if (g instanceof NextResponse) return g
  const { state, challenge } = await mintState(socialDb(), 'GOOGLE', g.by, true)
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  u.searchParams.set('redirect_uri', callbackUrl(req.nextUrl.origin, 'GOOGLE'))
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent select_account')
  u.searchParams.set('login_hint', 'gz28us@gmail.com')
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', challenge!)
  u.searchParams.set('code_challenge_method', 'S256')
  return NextResponse.json({ url: u.toString() })
}
