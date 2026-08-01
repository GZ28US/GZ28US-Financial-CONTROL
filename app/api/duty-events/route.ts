import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── DUTY EVENTS LOG (Márcio, 01/ago/2026) ────────────────────────────────────
// "It's VERY VERY important that the system has it all saved!!!! The system
// must know everything about all staff duties, by himself!"
// Every START / RESUME / PAUSE / DONE press on the DUTIES pages (shop + self)
// posts here in the same breath it reports to the WhatsApp group. duty_events
// is the per-event history the aggregate columns on invoice_duties can't give
// (which duties were touched on which day, segments, productivity).
// RLS is ON with no anon policies — only this route (service role) writes.

export const dynamic = 'force-dynamic'

const ACTIONS = new Set(['STARTED', 'RESUMED', 'PAUSED', 'DONE'])

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  if (!b || !ACTIONS.has(String(b.action))) return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })
  const { error } = await db.from('duty_events').insert({
    duty_id: b.duty_id || null,
    staff_id: b.staff_id || null,
    staff_name: (b.staff_name || '').slice(0, 120) || null,
    action: String(b.action),
    at: b.at || new Date().toISOString(),
    seconds_banked: Number.isFinite(Number(b.seconds_banked)) ? Math.round(Number(b.seconds_banked)) : null,
    description: (b.description || '').slice(0, 500) || null,
    car_label: (b.car_label || '').slice(0, 200) || null,
    invoice_code: (b.invoice_code || '').slice(0, 60) || null,
    source: 'APP',
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
