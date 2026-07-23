import { NextResponse } from 'next/server'
import { streamDb, t17Register, t17GetInfo, applyTrackInfo } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, freshAccessToken, fetchRecentMessages, extractTrackings, matchRows, guessCarrier, organizeInbox } from '@/lib/streamMail.server'
import type { StreamRow } from '@/lib/stream'

// STREAM mail watcher — scans gz28us@hotmail.com for supplier shipping emails
// and auto-fills tracking numbers on open STREAM rows. Matched rows get the
// tracking registered with 17TRACK and flip to SHIPPED (WhatsApp report fires
// inside applyTrackInfo). Called fire-and-forget by the /stream page and daily
// by the Vercel cron; a 10-minute server-side throttle keeps it cheap.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const THROTTLE_MIN = 10
const FIRST_RUN_DAYS = 3

async function run(force: boolean): Promise<NextResponse> {
  const db = streamDb()
  const auth = await getMailAuth(db)
  if (!auth?.refresh_token) return NextResponse.json({ ok: false, reason: 'mailbox not connected (run /api/stream/mail-auth)' })

  const now = Date.now()
  if (!force && auth.last_poll && now - new Date(auth.last_poll).getTime() < THROTTLE_MIN * 60_000) {
    return NextResponse.json({ ok: true, skipped: 'throttled', updated: 0 })
  }

  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ ok: false, reason: 'token refresh failed — reconnect at /api/stream/mail-auth' })

  const sinceIso = auth.last_poll || new Date(now - FIRST_RUN_DAYS * 86_400_000).toISOString()
  const msgs = await fetchRecentMessages(token, sinceIso)
  // High-water mark moves regardless of matches — a mail scanned once is done.
  await setMailAuth(db, { last_poll: new Date(now).toISOString() })

  // ── tracking capture ──────────────────────────────────────────────────────
  let updated = 0
  const details: string[] = []
  // Open rows = still waiting for a tracking number.
  const { data } = await db.from('part_streams').select('*').is('tracking_number', null).neq('status', 'DELIVERED')
  const open = (data as StreamRow[]) || []
  if (msgs.length && open.length) {
    // Numbers already assigned to ANY row (delivered included) are spoken for —
    // "Re:" threads quote old shipments' trackings forever, and without this a
    // fresh BOUGHT row from the same supplier would re-capture the old number.
    const { data: assigned } = await db.from('part_streams').select('tracking_number').not('tracking_number', 'is', null)
    const taken = new Set((assigned || []).map(r => String(r.tracking_number)))
    for (const msg of msgs) {
      const trackings = extractTrackings(`${msg.subject} ${msg.text}`).filter(t => !taken.has(t))
      if (!trackings.length) continue
      const rows = matchRows(open.filter(r => !r.tracking_number), msg)
      for (let i = 0; i < rows.length && i < trackings.length; i++) {
        const row = rows[i]
        const tracking = trackings[i]
        taken.add(tracking)
        await db.from('part_streams').update({ tracking_number: tracking, carrier: guessCarrier(tracking) }).eq('id', row.id)
        row.tracking_number = tracking
        await t17Register(tracking)
        const info = (await t17GetInfo(tracking)) || { latest_status: { status: 'InTransit' } }
        if (!info.latest_status?.status) info.latest_status = { status: 'InTransit' }
        await applyTrackInfo(db, row, info)
        updated++
        details.push(`${row.item} ← ${tracking} (${msg.subject.slice(0, 60)})`)
      }
    }
  }

  // ── inbox organizer — purchase emails file into the car's Outlook folder
  // 10+ min after the user reads them; doubts stay put and get logged.
  let organizer: { moved: string[]; doubts: string[] } = { moved: [], doubts: [] }
  try { organizer = await organizeInbox(db, token) } catch (e) { console.error('[mail-organize]', e) }

  return NextResponse.json({ ok: true, scanned: msgs.length, updated, details, moved: organizer.moved, doubts: organizer.doubts })
}

export async function POST() { return run(false) }
// Vercel cron calls GET daily as the backstop; force past the throttle.
export async function GET() { return run(true) }
