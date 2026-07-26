import { NextResponse } from 'next/server'
import { streamDb, t17Register, t17GetInfo, applyTrackInfo, notify, whereLabel } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, freshAccessToken, fetchRecentMessages, extractTrackings, matchRows, guessCarrier, organizeInbox, sweepSpam, sweepMarketing } from '@/lib/streamMail.server'
import { runAppsSweep } from '@/lib/appsMail.server'
import { runStaffTravelSweep } from '@/lib/staffTravel.server'
import { runExpenseReportNet } from '@/lib/expenseReportNet.server'
import { runPurchaseCapture } from '@/lib/purchaseCapture.server'
import { runInboxZero } from '@/lib/inboxZero.server'
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
  // Open rows = still waiting for a tracking number (pre-delivery statuses only —
  // cancelled/refunded/arrived rows never capture a tracking).
  const { data } = await db.from('part_streams').select('*').is('tracking_number', null).in('status', ['BOUGHT', 'SHIPPED'])
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

  // ── refund watch — a CANCELLED row waits for the supplier's refund email;
  // when one lands (matched by order number, else unambiguous supplier) the row
  // flips to REFUNDED and reports it. Manual REFUNDED on the board stays as the
  // fallback for refunds that never email.
  const refunded: string[] = []
  // Only ISSUED-refund language flips the row. Cancellation acknowledgments
  // ("Got it - you want to cancel", "you'll get a refund") merely PROMISE a
  // refund — the first live run flipped on one of those, so future/conditional
  // wording must never match; the money has to have actually moved.
  const REFUND_WORDS = /(refund (has been|was|is) (issued|sent|processed|completed|credited|on its way)|refund (issued|processed|completed)|(issued|processed|sent) (your|a|the) refund|your refund of|(you have been|you've been|you were) refunded|reembolso (efetuado|realizado|conclu[ií]do)|estorno (efetuado|realizado)|compra estornada)/i
  const { data: cData } = await db.from('part_streams').select('*').eq('status', 'CANCELLED')
  const cancelled = (cData as StreamRow[]) || []
  if (msgs.length && cancelled.length) {
    for (const msg of msgs) {
      if (!REFUND_WORDS.test(`${msg.subject} ${msg.text}`)) continue
      for (const row of matchRows(cancelled.filter(r => r.status === 'CANCELLED'), msg)) {
        row.status = 'REFUNDED'
        await db.from('part_streams').update({
          status: 'REFUNDED',
          last_event: `Refund confirmed — ${msg.subject.slice(0, 80)}`,
          last_event_at: new Date().toISOString(),
        }).eq('id', row.id)
        const where = await whereLabel(db, row)
        await notify(row, `💸 *STREAM — REFUNDED*\n${row.item}\n${[row.supplier, where].filter(Boolean).join(' · ')}${row.order_number ? `\nOrder ${row.order_number}` : ''}`)
        refunded.push(row.item)
      }
    }
  }

  // ── inbox organizer — purchase emails file into the car's Outlook folder
  // 10+ min after the user reads them; doubts stay put and get logged.
  let organizer: { moved: string[]; doubts: string[] } = { moved: [], doubts: [] }
  try { organizer = await organizeInbox(db, token) } catch (e) { console.error('[mail-organize]', e) }

  // ── spam auto-clean — toda passada varre as 3 caixas e apaga o marketing
  // conhecido na hora (regra 2026-07-24: "apague logo que chegar").
  let spam: { deleted: string[] } = { deleted: [] }
  try { spam = await sweepSpam(db) } catch (e) { console.error('[spam-sweep]', e) }
  let marketing: { deleted: string[] } = { deleted: [] }
  try { marketing = await sweepMarketing(db) } catch (e) { console.error('[marketing-sweep]', e) }

  // ── APPS watcher — recibos de assinatura no Gmail viram pagamentos no módulo
  // APPS, arquivados em Apps/<App> e reportados no grupo (2026-07-25).
  let appsPayments = 0
  try { const r = await runAppsSweep(db); appsPayments = r.payments.length } catch (e) { console.error('[apps-sweep]', e) }
  let staffTravel: { opened: string[]; closed: string[] } = { opened: [], closed: [] }
  try { staffTravel = await runStaffTravelSweep(db) } catch (e) { console.error('[staff-travel]', e) }
  let reportNet: { reported: string[] } = { reported: [] }
  try { reportNet = await runExpenseReportNet(db) } catch (e) { console.error('[report-net]', e) }
  let purchases: { captured: string[] } = { captured: [] }
  try { purchases = await runPurchaseCapture(db) } catch (e) { console.error('[purchase-capture]', e) }

  // ── inbox zero net — depois de todos os sweeps, o que sobrou (>15 min) ganha
  // destino por regra; sem regra → TRIAGEM (Claudinha) + pergunta no grupo.
  let inboxZero: { actions: string[] } = { actions: [] }
  try { inboxZero = await runInboxZero(db) } catch (e) { console.error('[inbox-zero]', e) }

  return NextResponse.json({ ok: true, scanned: msgs.length, updated, details, refunded, moved: organizer.moved, doubts: organizer.doubts, spamDeleted: spam.deleted, marketingDeleted: marketing.deleted, appsPayments, staffTravel, reportNet, purchases, inboxZero })
}

export async function POST() { return run(false) }
// Vercel cron calls GET daily as the backstop; force past the throttle.
export async function GET() { return run(true) }
