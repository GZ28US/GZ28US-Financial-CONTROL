import { NextResponse } from 'next/server'

// Lists the WhatsApp groups the UltraMsg instance belongs to — id + name only.
// Lets the assistant discover group ids (e.g. "GZ28US - STAFF") without the
// UltraMsg credentials ever leaving the server.

export const dynamic = 'force-dynamic'

export async function GET() {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/groups?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response' }, { status: 502 })
  return NextResponse.json({ groups: data.map((g: any) => ({ id: g.id, name: g.name })) })
}
