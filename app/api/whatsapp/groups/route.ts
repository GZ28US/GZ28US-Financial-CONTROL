import { NextRequest, NextResponse } from 'next/server'
import { readKeyOk, requireUser } from '@/lib/apiAuth.server'

// Lists the WhatsApp groups the UltraMsg instance belongs to — id, name and participants (jid, admin flags).
// Lets the assistant discover group ids (e.g. "GZ28US - STAFF") without the
// UltraMsg credentials ever leaving the server.
//
// Gate (audit of 11/set/2026): it used to answer anyone. Now only a logged-in
// screen (requireUser) or the read key in the x-read-key header (never ?key=,
// since 14/set/2026) gets the list; a missing env var lets nobody in.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/groups?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response' }, { status: 502 })
  // participants (10/11/2026, Processos & Legais 2: which of the 76 groups each US/BR number is in). UltraMsg already sends
  // them in this payload — the shape varies by version, so read it tolerantly. Still read-only, same gate.
  const jid = (v: any) => String(v?._serialized || v?.user && `${v.user}@${v.server || 'c.us'}` || v || '')
  const people = (g: any) => (g.groupMetadata?.participants || g.participants || []).map((p: any) => ({
    id: jid(p.id ?? p), name: p.name || p.pushname || p.notify || null,
    admin: !!(p.isAdmin || p.admin === 'admin' || p.isSuperAdmin || p.admin === 'superadmin'), superadmin: !!(p.isSuperAdmin || p.admin === 'superadmin'),
  }))
  return NextResponse.json({ groups: data.map((g: any) => ({ id: g.id, name: g.name, participants: people(g) })) })
}
