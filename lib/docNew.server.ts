/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — createQuote(), behind POST /ca/api/doc/new — QUOTE PORTAL M3 (06/11/2026; blueprint §2.2 /doc/new, §6.1).
// Creates a NEW QUOTE all or nothing:
//   { client_id } | { lead: { name, phone?, email?, country?, preferred_message_method? } }   → the client (a lead = a new QUOTE client)
//   { ride_id } | { ride_id: null }                                                          → on a car, or a client-level quote
//   { start: 'blank' | 'duplicate', from_id?, service? }
// blank  = Full Project Labor at 0 (the editor's starting point). duplicate = items · services · notes · the UNPAID (forecast)
// expenses with part_number/kits/export_status/item_discount kept, a FRESH purchase_group per source group, and order_number /
// receipt_url / payment_date / expense_date NULLED; never incomes, paid expenses, approvals, revisions, links or events (v2 U-11).
// Packs keep their engine in the legacy NEW page (MAP×margin, add-ons, BRL→USD, Importação dropped): /doc/new hands off there with
// ?from=doc and that page comes back to /doc/<id>. Terms + plan are seeded here (seed_terms) so no quote is ever without a plan.
// Gate: qi_v2.actions — or a «GZ28 TEST» client (our own fixtures). The route adds requireStaff. Nothing here sends anything.
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { actionsAllow } from './quotePublic.server'

const UUID = /^[0-9a-f-]{36}$/
const FULL_PROJECT_LABOR = 'Full Project Labor'
type Out = { status: number; body: Record<string, unknown> }
const bad = (error: string, status = 400): Out => ({ status, body: { error } })
const pad3 = (n: number) => String(n).padStart(3, '0')
const str = (v: unknown, max = 200) => { const s = String(v ?? '').trim().slice(0, max); return s || null }
export const nextSuffix = (codes: (string | null)[]) => {
  const used = new Set(codes.map(c => { const m = String(c || '').match(/\.(\d+)$/); return m ? Number(m[1]) : null }))
  let n = 1; while (used.has(n)) n++; return n
}

export async function createQuote(db: SupabaseClient, b: any, actor: string): Promise<Out> {
  // 1. CLIENT
  let client: any = null
  if (b.client_id) {
    if (!UUID.test(String(b.client_id))) return bad('client_id')
    const { data } = await db.from('clients').select('id, name, client_number, is_quote, origin').eq('id', b.client_id).maybeSingle()
    if (!data) return bad('client not found', 404)
    client = data
  } else if (b.lead?.name && str(b.lead.name)) {
    client = { name: str(b.lead.name, 120) }
  } else return bad('client_id or lead.name required')
  const isTest = /^GZ28 TEST/i.test(String(client.name || ''))
  if (!(await actionsAllow(isTest))) return { status: 409, body: { error: 'V2 actions are off (qi_v2.actions)', key: 'qi_v2.actions' } }
  if (client.origin === 'SHOP') return bad('SHOP clients quote in the SHOP area', 409)

  // 2. CAR (validated before anything is written)
  let ride: any = null
  if (b.ride_id) {
    if (!UUID.test(String(b.ride_id))) return bad('ride_id')
    if (!client.id) return bad('a new lead has no cars yet — create the quote without a car, or create the car first', 409)
    const { data } = await db.from('rides').select('id, project_code, client_id, origin').eq('id', b.ride_id).maybeSingle()
    if (!data) return bad('ride not found', 404)
    if (data.client_id !== client.id) return bad('that car belongs to another client', 409)
    if (data.origin === 'SHOP') return bad('SHOP cars quote in the SHOP area', 409)
    ride = data
  }
  // 3. START FROM
  const start = b.start === 'duplicate' ? 'duplicate' : 'blank'
  let src: any = null
  if (start === 'duplicate') {
    if (!UUID.test(String(b.from_id || ''))) return bad('from_id')
    const { data } = await db.from('invoices').select('id, service, pack_id, target_grand_total, global_discount, import_margin, fl_tax_override, fl_tax_override_reason, origin').eq('id', b.from_id).maybeSingle()
    if (!data) return bad('source document not found', 404)
    src = data
  }

  const made: { client?: string; invoice?: string } = {}
  try {
    if (!client.id) {
      // numbering: a real lead never counts our «GZ28 TEST» fixtures (the preview fixture holds #9999); a test lead goes after everything
      let mq = db.from('clients').select('client_number').eq('origin', 'PROJECT').eq('is_quote', true)
      if (!isTest) mq = mq.not('name', 'ilike', 'GZ28 TEST%')
      const { data: mx } = await mq.order('client_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      const { data, error } = await db.from('clients').insert({ name: client.name, phone: str(b.lead.phone, 40), email: str(b.lead.email, 120)?.toLowerCase() || null,
        country: str(b.lead.country, 40)?.toUpperCase() || null, preferred_message_method: str(b.lead.preferred_message_method, 40),
        client_number: (Number(mx?.client_number) || 0) + 1, is_quote: true, origin: 'PROJECT' }).select('id, name, client_number, is_quote, origin').single()
      if (error) throw new Error('client: ' + error.message)
      client = data; made.client = data.id
    }
    // invoice code: <car code>.<n> on a car, <client number>.<n> without one (the legacy NEW rule)
    let code: string
    if (ride) { const { data } = await db.from('invoices').select('invoice_code').eq('ride_id', ride.id); code = `${ride.project_code}.${nextSuffix((data || []).map(x => x.invoice_code))}` }
    else { const { data } = await db.from('invoices').select('invoice_code').eq('client_id', client.id).is('ride_id', null); code = `${pad3(Number(client.client_number) || 0)}.${nextSuffix((data || []).map(x => x.invoice_code))}` }
    const row: any = { invoice_code: code, ride_id: ride?.id || null, client_id: client.id, origin: 'PROJECT', is_quote: true, live_status: 'INCOMPLETE',
      service: str(b.service, 200) ?? src?.service ?? null }
    if (src) Object.assign(row, { pack_id: src.pack_id ?? null, target_grand_total: src.target_grand_total ?? null, global_discount: src.global_discount ?? null,
      import_margin: src.import_margin ?? 0, fl_tax_override: src.fl_tax_override ?? null, fl_tax_override_reason: src.fl_tax_override_reason ?? null })
    const { data: inv, error: ie } = await db.from('invoices').insert(row).select('id, invoice_code').single()
    if (ie) throw new Error('invoice: ' + ie.message)
    made.invoice = inv.id

    if (start === 'blank') {
      const { error } = await db.from('invoice_services').insert({ invoice_id: inv.id, description: FULL_PROJECT_LABOR, price: 0 })
      if (error) throw new Error('services: ' + error.message)
    } else {
      const [it, sv, nt, ex] = await Promise.all([
        db.from('invoice_items').select('description, unit_price, quantity, base_cost, position, kit_group, kit_name, source_item, cancel_status').eq('invoice_id', src.id).order('position', { ascending: true, nullsFirst: false }).order('created_at'),
        db.from('invoice_services').select('description, price').eq('invoice_id', src.id).order('created_at'),
        db.from('invoice_notes').select('note, client_visible').eq('invoice_id', src.id).order('created_at'),
        db.from('invoice_expenses').select('supplier, item, price, tax, extra, quantity, item_discount, part_number, export_status, purchase_group, kit_group, kit_name, position, nature, part_id, payment_date, cancel_status').eq('invoice_id', src.id).order('created_at'),
      ])
      for (const [n, r] of [['items', it], ['services', sv], ['notes', nt], ['expenses', ex]] as const) if (r.error) throw new Error(`${n}: ${r.error.message}`)
      const items = (it.data || []).filter((p: any) => !p.cancel_status).map((p: any) => ({ invoice_id: inv.id, description: p.description, unit_price: p.unit_price, quantity: p.quantity,
        base_cost: p.base_cost, position: p.position, kit_group: p.kit_group, kit_name: p.kit_name, source_item: p.source_item }))
      if (items.length) { const { error } = await db.from('invoice_items').insert(items); if (error) throw new Error('items: ' + error.message) }
      const svcs = (sv.data || []).length ? (sv.data || []).map((v: any) => ({ invoice_id: inv.id, description: v.description, price: v.price })) : [{ invoice_id: inv.id, description: FULL_PROJECT_LABOR, price: 0 }]
      { const { error } = await db.from('invoice_services').insert(svcs); if (error) throw new Error('services: ' + error.message) }
      const notes = (nt.data || []).map((x: any) => ({ invoice_id: inv.id, note: x.note, client_visible: x.client_visible !== false }))
      if (notes.length) { const { error } = await db.from('invoice_notes').insert(notes); if (error) throw new Error('notes: ' + error.message) }
      const groups = new Map<string, string>()
      const fresh = (g: string | null) => { if (!g) return null; if (!groups.has(g)) groups.set(g, randomUUID()); return groups.get(g)! }
      const exps = (ex.data || []).filter((e: any) => !e.payment_date && !e.cancel_status).map((e: any) => ({
        invoice_id: inv.id, supplier: e.supplier, item: e.item, price: e.price, tax: e.tax, extra: e.extra, quantity: e.quantity, item_discount: e.item_discount,
        part_number: e.part_number, export_status: e.export_status || 'FRESH', purchase_group: fresh(e.purchase_group), kit_group: e.kit_group, kit_name: e.kit_name,
        position: e.position, nature: e.nature, part_id: e.part_id, order_number: null, receipt_url: null, payment_date: null, expense_date: null }))
      if (exps.length) { const { error } = await db.from('invoice_expenses').insert(exps); if (error) throw new Error('expenses: ' + error.message) }
    }
    const { error: se } = await db.rpc('seed_terms', { p_invoice: inv.id })
    if (se) throw new Error('terms: ' + se.message)
    await db.from('data_fixes').insert({ check_key: 'doc-new', table_name: 'invoices', row_id: inv.id, field: 'created', old_value: null, new_value: inv.invoice_code,
      label: `/doc/new · ${start}${src ? ' de ' + src.id : ''} · ${client.name} · ${actor}`.slice(0, 200) }).then(() => undefined, () => undefined)
    return { status: 200, body: { ok: true, id: inv.id, invoice_code: inv.invoice_code, client_id: client.id } }
  } catch (e) {
    // all or nothing: the half-made quote (and a lead born in this call) leave nothing behind; invoice_expenses' FK is RESTRICT
    if (made.invoice) { await db.from('invoice_expenses').delete().eq('invoice_id', made.invoice); await db.from('invoices').delete().eq('id', made.invoice) }
    if (made.client) await db.from('clients').delete().eq('id', made.client)
    return bad(String((e as Error).message || e), 500)
  }
}
