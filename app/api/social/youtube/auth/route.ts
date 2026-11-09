import { NextRequest, NextResponse } from 'next/server'
import { startGate } from '@/lib/socialStart.server'
import { socialDb, mintState, callbackUrl, YOUTUBE_SCOPES } from '@/lib/social.server'

// SOCIAL LINK · YOUTUBE step 1 (09/11/2026). Same Google OAuth client as the Gmail hookup (GOOGLE_CLIENT_ID/SECRET); the YouTube
// Data API v3 + YouTube Analytics API must be enabled in that Cloud project and this callback URL added to the client. Offline +
// consent so a refresh token comes back; PKCE S256 on top of the state. At the Google screen pick the @gz28us CHANNEL (brand account).
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await startGate(req, 'YOUTUBE', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
  if (g instanceof NextResponse) return g
  const { state, challenge } = await mintState(socialDb(), 'YOUTUBE', g.by, true)
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  u.searchParams.set('redirect_uri', callbackUrl(req.nextUrl.origin, 'YOUTUBE'))
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', YOUTUBE_SCOPES.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent select_account')
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', challenge!)
  u.searchParams.set('code_challenge_method', 'S256')
  return NextResponse.json({ url: u.toString() })
}
