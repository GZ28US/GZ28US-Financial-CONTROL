import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/apiAuth.server'

// ── DUTY EVENTS LOG (Márcio, 01/ago/2026) ────────────────────────────────────
// "It's VERY VERY important that the system has it all saved!!!! The system
// must know everything about all staff duties, by himself!"
// Every START / RESUME / PAUSE / DONE press on the DUTIES pages (shop + self)
// posts here in the same breath it reports to the WhatsApp group. duty_events
// is the per-event history the aggregate columns on invoice_duties can't give
// (which duties were touched on which day, segments, productivity).
// RLS is ON with no anon policies — only this route (service role) writes.
//
// PORTÃO (13/set/2026). Dois chamadores, dois jeitos de entrar:
//   • /duties (tela logada) → JWT do Supabase (sessionHeaders), como sempre.
//   • /duties/self/<staffId> (celular do staff, SEM login) → a mesma chave que a
//     página já usa nas RPCs duties_self_load / duty_self_update: o id do staff,
//     que só existe no link mandado a ele. O staff tem de existir e a duty, se
//     vier, tem de ser DELE. Nesse caminho o nome e a hora saem do servidor —
//     o pedido não escolhe quem foi nem quando.
// Sem sessão e sem esse vínculo, 401.

export const dynamic = 'force-dynamic'

const ACTIONS = new Set(['STARTED', 'RESUMED', 'PAUSED', 'DONE'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })

  const logado = await requireUser(req)
  let staffName: string | null = null
  if (!logado) {
    const staffId = String(b?.staff_id || '')
    const dutyId = b?.duty_id == null ? null : String(b.duty_id)
    if (!UUID.test(staffId) || (dutyId !== null && !UUID.test(dutyId))) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const { data: st, error: sErr } = await db.from('staff').select('name').eq('id', staffId).maybeSingle()
    if (sErr) return NextResponse.json({ error: 'database error' }, { status: 500 })
    if (!st) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (dutyId) {
      const { data: d, error: dErr } = await db.from('invoice_duties').select('id').eq('id', dutyId).eq('staff_id', staffId).maybeSingle()
      if (dErr) return NextResponse.json({ error: 'database error' }, { status: 500 })
      if (!d) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    staffName = st.name || null
  }

  if (!b || !ACTIONS.has(String(b.action))) return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  const { error } = await db.from('duty_events').insert({
    duty_id: b.duty_id || null,
    staff_id: b.staff_id || null,
    staff_name: logado ? (String(b.staff_name || '').slice(0, 120) || null) : staffName,
    action: String(b.action),
    at: (logado && b.at) || new Date().toISOString(),
    seconds_banked: Number.isFinite(Number(b.seconds_banked)) ? Math.round(Number(b.seconds_banked)) : null,
    description: String(b.description || '').slice(0, 500) || null,
    car_label: String(b.car_label || '').slice(0, 200) || null,
    invoice_code: String(b.invoice_code || '').slice(0, 60) || null,
    source: 'APP',
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
