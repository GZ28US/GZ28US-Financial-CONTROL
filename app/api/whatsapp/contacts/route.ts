import { NextRequest, NextResponse } from 'next/server'
import { readKeyOk } from '@/lib/apiAuth.server'

// US-instance UltraMsg contact search by name (?q=), returning only id + name —
// lets the assistant resolve a recipient without the credentials leaving the
// server. Read key in header x-read-key or ?key=, failing closed when the env
// var is missing. Mirror of the BR app's route.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase()
  if (q.length < 3) return NextResponse.json({ error: 'q needs 3+ characters' }, { status: 400 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/contacts?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response' }, { status: 502 })
  const hits = data
    .filter((c: any) => String(c.name || c.pushname || '').toLowerCase().includes(q))
    .slice(0, 20)
    .map((c: any) => ({ id: c.id, name: c.name || c.pushname }))
  return NextResponse.json({ hits })
}
