/* eslint-disable @typescript-eslint/no-explicit-any */
// POST /ca/api/doc/new — QUOTE PORTAL M3 (06/11/2026; blueprint §2.2 /doc/new, §6.1). Creates a NEW QUOTE server-side, all or nothing:
//   { client_id } | { lead: { name, phone?, email?, country?, preferred_message_method? } }   → the client (a lead = a new QUOTE client)
//   { ride_id } | { ride_id: null }                                                          → on a car, or a client-level quote
//   { start: 'blank' | 'duplicate', from_id?, service? }
// blank  = Full Project Labor at 0 (the editor's starting point). duplicate = items · services · notes · the UNPAID (forecast)
// expenses with part_number/kits/export_status/item_discount kept, a FRESH purchase_group per source group, and order_number /
// receipt_url / payment_date / expense_date NULLED; never incomes, paid expenses, approvals, revisions, links or events (v2 U-11).
// Packs keep their engine in the legacy NEW page (MAP×margin, add-ons, BRL→USD, Importação dropped): /doc/new hands off there with
// ?from=doc and that page comes back to /doc/<id>. Terms + plan are seeded here (seed_terms) so no quote is ever without a plan.
// Gate: requireStaff + qi_v2.actions — or a «GZ28 TEST» client (our own fixtures). Nothing here sends anything.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { createQuote } from '@/lib/docNew.server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'staff only (a human login; machine accounts refused)' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  let db
  try { db = serviceDb() } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 503 }) }
  const r = await createQuote(db, b, staff.email)
  return NextResponse.json(r.body, { status: r.status })
}
