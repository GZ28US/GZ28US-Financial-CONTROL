import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { socialDb, healthPass } from '@/lib/social.server'

// SOCIAL LINK — daily token keeper (09/11/2026). YouTube and TikTok: force a refresh (TikTok's refresh token rotates, and an
// untouched Google refresh token dies after 6 months). Meta: debug_token on each page/user token; dead ones are marked EXPIRED
// so the connect screen shows RECONNECT. Platforms whose switch is OFF are skipped. Sends nothing to anyone.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const results = await healthPass(socialDb())
  const bad = results.filter(r => !r.ok)
  if (bad.length) console.error('[social-health]', JSON.stringify(bad))
  return NextResponse.json({ checked: results.length, bad: bad.length, results })
}
