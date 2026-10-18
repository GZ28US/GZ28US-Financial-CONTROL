// /api/performance/seed-pack — a performance do carro nasce com a invoice do pack GZ28 Shop LOCKED validado (18/10/2026).
// POST { invoiceId } → lib/packPerformance.server.ts. Chamado pela tela de nova invoice (depois do applyPack) e pelo editor
// quando a quote vira invoice. Idempotente.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { seedPackPerformance } from '@/lib/packPerformance.server'

export const maxDuration = 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'sem service key' }, { status: 500 })
  const body = await req.json().catch(() => ({}))
  const invoiceId = String(body?.invoiceId || '')
  if (!UUID.test(invoiceId)) return NextResponse.json({ error: 'invoiceId inválido' }, { status: 400 })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  try {
    const r = await seedPackPerformance(db, invoiceId)
    return NextResponse.json(r, { status: r.ok ? 200 : 500 })
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [String(err)] }, { status: 500 })
  }
}
