import { NextRequest, NextResponse } from 'next/server'

// Recent chats of the US UltraMsg instance (?limit=&key=) — id + name + last
// message, so the assistant can locate a conversation even when the contact
// isn't saved. Read access requires WHATSAPP_READ_KEY. Mirror of the BR route.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (need && req.nextUrl.searchParams.get('key') !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30') || 30, 100)
  const r = await fetch(`https://api.ultramsg.com/${instance}/chats?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response' }, { status: 502 })
  const chats = data.slice(0, limit).map((c: any) => ({
    id: c.id,
    name: c.name || null,
    isGroup: String(c.id || '').endsWith('@g.us'),
    time: c.time ? new Date(c.time * 1000).toISOString() : null,
    last: typeof c.last_message === 'string' ? c.last_message.slice(0, 120) : (c.last_message?.body ? String(c.last_message.body).slice(0, 120) : null),
  }))
  return NextResponse.json({ count: chats.length, chats })
}
