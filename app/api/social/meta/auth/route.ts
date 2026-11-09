import { NextRequest, NextResponse } from 'next/server'
import { startGate } from '@/lib/socialStart.server'
import { socialDb, mintState, callbackUrl, META_SCOPES, GRAPH_VERSION } from '@/lib/social.server'

// SOCIAL LINK · META step 1 (09/11/2026). One consent covers Facebook Page(s), the Instagram Business account(s) linked to them,
// Messenger + IG DMs and the Business Suite assets. Returns the consent URL; /ca/social/connect sends the browser there.
// META_CONFIG_ID (optional): a "Facebook Login for Business" configuration — when set, Meta uses its permission list instead of `scope`.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await startGate(req, 'META', ['META_APP_ID', 'META_APP_SECRET'])
  if (g instanceof NextResponse) return g
  const { state } = await mintState(socialDb(), 'META', g.by)
  const u = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`)
  u.searchParams.set('client_id', process.env.META_APP_ID!)
  u.searchParams.set('redirect_uri', callbackUrl(req.nextUrl.origin, 'META'))
  u.searchParams.set('state', state)
  u.searchParams.set('response_type', 'code')
  if (process.env.META_CONFIG_ID) u.searchParams.set('config_id', process.env.META_CONFIG_ID)
  else u.searchParams.set('scope', META_SCOPES.join(','))
  return NextResponse.json({ url: u.toString() })
}
