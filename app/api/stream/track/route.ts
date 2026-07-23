import { NextRequest, NextResponse } from 'next/server'
import { streamDb, t17Register, t17GetInfo, applyTrackInfo } from '@/lib/stream.server'
import type { StreamRow } from '@/lib/stream'

// STREAM tracking actions, called by the /stream page:
//   { id, action: 'register' } — a tracking number was just saved on the row.
//     Registers it with 17TRACK (webhook takes over from there) and flips the
//     row to SHIPPED: a tracking number in hand means the order shipped.
//   { id, action: 'refresh' }  — pull the latest 17TRACK info on demand.
// Both fall back gracefully when TRACK17_API_KEY isn't set — the SHIPPED flip
// and WhatsApp report still run; only the automatic follow-up needs the key.

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { id, action } = await req.json().catch(() => ({} as { id?: string; action?: string }))
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 })

  const db = streamDb()
  const { data: row } = await db.from('part_streams').select('*').eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ error: 'stream row not found' }, { status: 404 })
  const stream = row as StreamRow

  if (!stream.tracking_number) return NextResponse.json({ error: 'row has no tracking number' }, { status: 400 })

  if (action === 'register') {
    const registered = await t17Register(stream.tracking_number)
    // Fresh numbers often have no events yet — the synthetic InTransit flips the
    // row to SHIPPED (never downgrades) and fires the WhatsApp report; real
    // 17TRACK info refines carrier/ETA when available.
    const info = (await t17GetInfo(stream.tracking_number)) || { latest_status: { status: 'InTransit' } }
    if (!info.latest_status?.status) info.latest_status = { status: 'InTransit' }
    const updated = await applyTrackInfo(db, stream, info)
    return NextResponse.json({ ok: true, registered, row: updated })
  }

  if (action === 'refresh') {
    const info = await t17GetInfo(stream.tracking_number)
    if (!info) return NextResponse.json({ ok: false, reason: 'no tracking info (TRACK17_API_KEY set?)', row: stream })
    const updated = await applyTrackInfo(db, stream, info)
    return NextResponse.json({ ok: true, row: updated })
  }

  return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 })
}
