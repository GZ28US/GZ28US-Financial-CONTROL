import { NextRequest, NextResponse } from 'next/server'
import { startGate } from '@/lib/socialStart.server'
import { socialDb, mintState, EBAY_SCOPES } from '@/lib/social.server'

// INTEGRATIONS · EBAY step 1 (09/11/2026). eBay's redirect_uri is the RuName (EBAY_RUNAME), whose "auth accepted URL" in the eBay
// developer portal must be https://www.gz28us.com/ca/api/social/ebay/callback. Buyer purchase history only; booking stays AutoBook's.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await startGate(req, 'EBAY', ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'])
  if (g instanceof NextResponse) return g
  const { state } = await mintState(socialDb(), 'EBAY', g.by)
  const u = new URL('https://auth.ebay.com/oauth2/authorize')
  u.searchParams.set('client_id', process.env.EBAY_CLIENT_ID!)
  u.searchParams.set('redirect_uri', process.env.EBAY_RUNAME!)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', EBAY_SCOPES.join(' '))
  u.searchParams.set('state', state)
  return NextResponse.json({ url: u.toString() })
}
