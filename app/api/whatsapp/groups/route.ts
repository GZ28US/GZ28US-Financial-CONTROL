import { NextRequest, NextResponse } from 'next/server'
import { readKeyOk, requireUser } from '@/lib/apiAuth.server'

// Lists the WhatsApp groups the UltraMsg instance belongs to — id + name only.
// Lets the assistant discover group ids (e.g. "GZ28US - STAFF") without the
// UltraMsg credentials ever leaving the server.
//
// Gate (audit of 11/set/2026): it used to answer anyone. Now only a logged-in
// screen (requireUser) or the read key — header x-read-key, or ?key= like the
// other read routes — gets the list; a missing env var lets nobody in.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req, { allowQuery: true }) && !(await requireUser(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/groups?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response' }, { status: 502 })
  return NextResponse.json({ groups: data.map((g: any) => ({ id: g.id, name: g.name })) })
}
