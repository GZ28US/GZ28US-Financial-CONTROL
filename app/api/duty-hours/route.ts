import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── LAST-7-DAYS WORKED HOURS per staff member (Márcio, 02/ago/2026) ──────────
// Feeds the day-by-day bar chart shown when a member's board is expanded on
// the DUTIES page. duty_events has no anon policies (RLS), so the aggregation
// runs here with the service role and ships ONLY aggregate seconds per local
// day — never event detail. Same math as the 4am report: worked time = deltas
// of the cumulative seconds_banked at every PAUSED/DONE, bucketed by
// Orlando's local day.

export const dynamic = 'force-dynamic'

const TZ_OFFSET_MS = 4 * 3600 * 1000 // Orlando EDT (UTC-4), same clock as the 4am report
const localDay = (iso: string) => new Date(new Date(iso).getTime() - TZ_OFFSET_MS).toISOString().slice(0, 10)

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })

  // The last N local days, today included, oldest first. 14 fills the board
  // card edge to edge (Márcio, 02/ago/2026 — "até completar a tela").
  const N = 14
  const todayLocal = localDay(new Date().toISOString())
  const base = new Date(todayLocal + 'T00:00:00Z').getTime()
  const days: string[] = []
  for (let i = N - 1; i >= 0; i--) days.push(new Date(base - i * 86400000).toISOString().slice(0, 10))

  // Deltas need the WHOLE history: seconds_banked is cumulative per
  // staff|duty, so an event before the window still sets the baseline.
  const { data: events, error } = await db.from('duty_events')
    .select('staff_id, staff_name, action, at, seconds_banked, description')
    .order('at')
    .limit(10000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const dayIdx = new Map(days.map((d, i) => [d, i]))
  const byStaff: Record<string, number[]> = {}
  const lastBank: Record<string, number> = {}
  for (const e of events || []) {
    if (e.action !== 'PAUSED' && e.action !== 'DONE') continue
    if (e.seconds_banked == null) continue
    const who = e.staff_id || e.staff_name || ''
    const k = `${who}|${e.description || ''}`
    // Bank smaller than the last one = a NEW ROUND (MANOBRAS resets to zero
    // after every DONE) — the whole bank is fresh time, not a regression.
    const prev = lastBank[k] || 0
    const delta = e.seconds_banked >= prev ? e.seconds_banked - prev : e.seconds_banked
    lastBank[k] = e.seconds_banked
    if (!delta || !e.staff_id) continue
    const i = dayIdx.get(localDay(e.at))
    if (i === undefined) continue
    const arr = byStaff[e.staff_id] || (byStaff[e.staff_id] = days.map(() => 0))
    arr[i] += delta
  }

  return NextResponse.json({ days, byStaff })
}
