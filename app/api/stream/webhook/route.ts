import { NextRequest, NextResponse } from 'next/server'
import { streamDb, applyTrackInfo } from '@/lib/stream.server'
import type { StreamRow } from '@/lib/stream'

// 17TRACK push webhook — configure at https://api.17track.net (Settings →
// Webhook) as:
//   https://www.gz28us.com/ca/api/stream/webhook?key=<STREAM_WEBHOOK_SECRET>
// Every tracking update lands here: we match the tracking number to its
// STREAM row(s), apply the new status/ETA/checkpoint, and the transition
// reports (SHIPPED / DELIVERED → WhatsApp) fire inside applyTrackInfo.
// Always answers 200 so 17TRACK never retries into a storm.

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.STREAM_WEBHOOK_SECRET
  if (secret && req.nextUrl.searchParams.get('key') !== secret) {
    return NextResponse.json({ error: 'bad key' }, { status: 401 })
  }

  const payload = await req.json().catch(() => null)
  const number = payload?.data?.number
  const info = payload?.data?.track_info
  if (!number || !info) return NextResponse.json({ received: true })

  try {
    const db = streamDb()
    const { data: rows } = await db.from('part_streams').select('*').eq('tracking_number', String(number))
    for (const row of (rows as StreamRow[]) || []) {
      await applyTrackInfo(db, row, info)
    }
  } catch (e) {
    console.error('[stream-webhook]', e)
  }
  return NextResponse.json({ received: true })
}
