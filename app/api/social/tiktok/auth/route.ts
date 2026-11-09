import { NextRequest, NextResponse } from 'next/server'
import { startGate } from '@/lib/socialStart.server'
import { socialDb, mintState, callbackUrl, TIKTOK_SCOPES } from '@/lib/social.server'

// SOCIAL LINK · TIKTOK step 1 (09/11/2026). TikTok for Developers app with Login Kit + Content Posting API (+ Display scopes).
// While the app is unaudited/sandbox, only accounts listed as target users can consent, and anything posted is private (SELF_ONLY).
// TIKTOK_SCOPES (optional, comma list) narrows the ask to what the app has been granted so far.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await startGate(req, 'TIKTOK', ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'])
  if (g instanceof NextResponse) return g
  const { state } = await mintState(socialDb(), 'TIKTOK', g.by)
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/')
  u.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY!)
  u.searchParams.set('scope', process.env.TIKTOK_SCOPES || TIKTOK_SCOPES.join(','))
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', callbackUrl(req.nextUrl.origin, 'TIKTOK'))
  u.searchParams.set('state', state)
  return NextResponse.json({ url: u.toString() })
}
