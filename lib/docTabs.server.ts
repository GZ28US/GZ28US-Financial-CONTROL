/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the full tabs of /ca/doc/<id> (QUOTE PORTAL M3, 06/11/2026; blueprint §2.2, §6.4, §6.5).
// ITEMS · SERVICES · EXPENSES · NOTES · DUTIES (+ INCOMES and ACTIVITY, which the page already had) and the CLOSE checklist.
// Writes are immediate, one row per call, from the staff route (/api/doc/<id>/<action>, requireStaff + actionsAllow).
// The DB is the lock: trg_lock_presented_lines refuses any change to a line frozen in the live (sent) revision — this file only
// pre-flags those lines (`locked`) so the screen greys them out and says "sent rev n — change order". Mirror lines (born from an
// expense) and the margin re-pricer / TARGET solver / expense engine stay in the legacy editor (EDIT IN EDITOR →) for now.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocState } from './quoteDoc.server'

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const okDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)
const PRIORITIES = new Set(['1', '2', '3', '4', '5'])

// C-18: CLOSED = Σ listed incomes ≥ grand (½-cent tolerance) ∧ every income dated (payment_date or milestone label) ∧ conclusion date.
// D-17 DEFAULT A: unpaid plan rows do NOT block — they print in red as A/R.
export function closeChecklist(s: DocState) {
  const inc = s.bundle.incomes
  const listed = inc.reduce((a, i) => a + num(i.amount), 0)
  const grand = s.bundle.money.grand
  const undated = inc.filter(i => !okDate(i.payment_date) && !i.date_label)
  const planUnpaid = (s.plan || []).filter((p: any) => !inc.some(i => i.installment_id === p.id && i.paid_at))
  const items = [
    { key: 'listed', ok: listed - grand >= -0.005, label: `incomes listed ${listed.toFixed(2)} ≥ grand ${grand.toFixed(2)}`, fix: listed - grand < -0.005 ? `add incomes for ${(grand - listed).toFixed(2)}` : null },
    { key: 'dated', ok: undated.length === 0, label: 'every income dated or labelled', fix: undated.length ? `${undated.length} income(s) without date: ${undated.map(i => i.description || num(i.amount).toFixed(2)).join(', ').slice(0, 120)}` : null },
    { key: 'concluded', ok: okDate(s.bundle.invoice.conclusion_date), label: 'conclusion date set', fix: okDate(s.bundle.invoice.conclusion_date) ? null : 'set the CONCLUSION DATE (editor)' },
  ]
  return { ok: items.every(i => i.ok), items, planUnpaid: planUnpaid.map((p: any) => ({ seq: p.seq, label: p.label || p.label_key })), received: s.bundle.received }
}

export async function tabsExtras(db: SupabaseClient, s: DocState) {
  const id = s.bundle.invoice.id
  const lockedIds = new Set(((s.live?.document?.lines || []) as any[]).map(l => String(l.id)))
  const [exp, dut, staff] = await Promise.all([
    db.from('invoice_expenses').select('id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, order_number, cancel_status, nature, receipt_url, paid_from').eq('invoice_id', id).order('created_at'),
    db.from('invoice_duties').select('id, description, done, priority, staff_id, estimated_seconds, time_seconds, work_started_at, work_ended_at').eq('invoice_id', id).order('created_at'),
    db.from('staff').select('id, name').order('name'),
  ])
  const lineTotal = (e: any) => num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)
  return {
    items: s.bundle.items.map(i => ({ id: i.id, description: i.description, quantity: i.quantity, unit_price: i.unit_price, total: num(i.unit_price) * num(i.quantity),
      kit_name: i.kit_name || null, cancel_status: i.cancel_status || null, counts: i.counts, mirror: !!(i.mirror_expense_id || i.mirror_src), locked: lockedIds.has(String(i.id)) })),
    services: s.bundle.services.map(v => ({ id: v.id, description: v.description, price: v.price, locked: lockedIds.has(String(v.id)) })),
    notes: s.bundle.notes.map(n => ({ id: n.id, note: n.note, client_visible: n.client_visible !== false, created_at: n.created_at })),
    expenses: (exp.data || []).map((e: any) => ({ ...e, total: lineTotal(e), paid: okDate(e.payment_date) })),
    duties: dut.data || [], staff: staff.data || [],
    close: s.bundle.invoice.is_quote ? null : closeChecklist(s),
  }
}

const done = (j: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...j } })
const no = (error: string, status = 400) => ({ status, body: { error } })
// The lock trigger's message is the honest one ("locked by sent revision n — NEW REVISION in /doc"); pass it through.
const dbErr = (m: string) => /locked by sent revision/.test(m) ? no(m.replace(/^.*?(locked by sent revision)/, '$1'), 409) : no(m, 500)

export async function tabAction(db: SupabaseClient, s: DocState, action: string, b: any, actor: string): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const id = s.bundle.invoice.id
  const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max)
  const own = async (table: string, rowId: unknown) => {
    const { data } = await db.from(table).select('id').eq('id', String(rowId || '')).eq('invoice_id', id).maybeSingle()
    return !!data
  }
  switch (action) {
    case 'item-add': {
      const d = str(b.description); if (!d) return no('description required')
      const q = num(b.quantity) || 1, p = num(b.unit_price)
      const { data: mx } = await db.from('invoice_items').select('position').eq('invoice_id', id).order('position', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      const { error } = await db.from('invoice_items').insert({ invoice_id: id, description: d, quantity: q, unit_price: p, position: (num(mx?.position) || 0) + 1 })
      return error ? dbErr(error.message) : done()
    }
    case 'item-save': {
      if (!(await own('invoice_items', b.item_id))) return no('line not on this document', 404)
      const it = s.bundle.items.find(i => i.id === b.item_id)
      if (it?.mirror_expense_id || it?.mirror_src) return no('mirror line (born from an expense) — edit it in the editor', 409)
      const patch: Record<string, unknown> = {}
      if (b.description != null) patch.description = str(b.description)
      if (b.quantity != null) patch.quantity = num(b.quantity)
      if (b.unit_price != null) patch.unit_price = num(b.unit_price)
      if (patch.description === '') return no('description required')
      const { error } = await db.from('invoice_items').update(patch).eq('id', b.item_id)
      return error ? dbErr(error.message) : done()
    }
    case 'item-del': {
      if (!(await own('invoice_items', b.item_id))) return no('line not on this document', 404)
      const it = s.bundle.items.find(i => i.id === b.item_id)
      if (it?.mirror_expense_id || it?.mirror_src) return no('mirror line (born from an expense) — remove it in the editor', 409)
      const { error } = await db.from('invoice_items').delete().eq('id', b.item_id)
      return error ? dbErr(error.message) : done()
    }
    case 'service-add': {
      const d = str(b.description); if (!d) return no('description required')
      const { error } = await db.from('invoice_services').insert({ invoice_id: id, description: d, price: num(b.price) })
      return error ? dbErr(error.message) : done()
    }
    case 'service-save': {
      if (!(await own('invoice_services', b.service_id))) return no('service not on this document', 404)
      const patch: Record<string, unknown> = {}
      if (b.description != null) patch.description = str(b.description)
      if (b.price != null) patch.price = num(b.price)
      if (patch.description === '') return no('description required')
      const { error } = await db.from('invoice_services').update(patch).eq('id', b.service_id)
      return error ? dbErr(error.message) : done()
    }
    case 'service-del': {
      if (!(await own('invoice_services', b.service_id))) return no('service not on this document', 404)
      const { error } = await db.from('invoice_services').delete().eq('id', b.service_id)
      return error ? dbErr(error.message) : done()
    }
    case 'note-add': {
      const t = str(b.note, 4000); if (!t) return no('note required')
      const { error } = await db.from('invoice_notes').insert({ invoice_id: id, note: t, client_visible: b.client_visible !== false })
      return error ? dbErr(error.message) : done()
    }
    case 'note-save': {
      if (!(await own('invoice_notes', b.note_id))) return no('note not on this document', 404)
      const patch: Record<string, unknown> = {}
      if (b.note != null) { patch.note = str(b.note, 4000); if (!patch.note) return no('note required') }
      if (b.client_visible != null) patch.client_visible = !!b.client_visible
      const { error } = await db.from('invoice_notes').update(patch).eq('id', b.note_id)
      return error ? dbErr(error.message) : done()
    }
    case 'note-del': {
      if (!(await own('invoice_notes', b.note_id))) return no('note not on this document', 404)
      const { error } = await db.from('invoice_notes').delete().eq('id', b.note_id)
      return error ? dbErr(error.message) : done()
    }
    case 'duty-add': {
      const d = str(b.description); if (!d) return no('description required')
      const pr = PRIORITIES.has(String(b.priority)) ? String(b.priority) : '1'
      const { error } = await db.from('invoice_duties').insert({ invoice_id: id, description: d, staff_id: b.staff_id || null, priority: pr, done: false,
        estimated_seconds: num(b.estimated_minutes) > 0 ? Math.round(num(b.estimated_minutes) * 60) : null })
      return error ? dbErr(error.message) : done()
    }
    case 'duty-toggle': {
      if (!(await own('invoice_duties', b.duty_id))) return no('duty not on this document', 404)
      const { data: d } = await db.from('invoice_duties').select('done').eq('id', b.duty_id).single()
      const { error } = await db.from('invoice_duties').update({ done: !d?.done }).eq('id', b.duty_id)
      return error ? dbErr(error.message) : done()
    }
    case 'duty-save': {
      if (!(await own('invoice_duties', b.duty_id))) return no('duty not on this document', 404)
      const patch: Record<string, unknown> = {}
      if (b.description != null) { patch.description = str(b.description); if (!patch.description) return no('description required') }
      if (b.staff_id !== undefined) patch.staff_id = b.staff_id || null
      if (b.priority != null && PRIORITIES.has(String(b.priority))) patch.priority = String(b.priority)
      const { error } = await db.from('invoice_duties').update(patch).eq('id', b.duty_id)
      return error ? dbErr(error.message) : done()
    }
    case 'duty-del': {
      if (!(await own('invoice_duties', b.duty_id))) return no('duty not on this document', 404)
      const { error } = await db.from('invoice_duties').delete().eq('id', b.duty_id)
      return error ? dbErr(error.message) : done()
    }
    case 'status': {
      // STATUS ▾ (§6.4): never demotes silently, never touches a quote. CLOSED only through the C-18 checklist.
      if (s.bundle.invoice.is_quote) return no('a quote has no ONLINE/CLOSED — it becomes an invoice at the deposit', 409)
      const to = String(b.to || '')
      if (!['REALTIME', 'CLOSED'].includes(to)) return no('to = REALTIME | CLOSED')
      const from = String(s.bundle.invoice.live_status || 'INCOMPLETE')
      if (from === to) return done({ unchanged: true })
      if (to === 'CLOSED') { const c = closeChecklist(s); if (!c.ok) return { status: 409, body: { error: 'CLOSE checklist not met', checklist: c } } }
      if (from === 'CLOSED' && to === 'REALTIME' && !b.reopen) return no('re-open a CLOSED invoice only with {reopen:true}', 409)
      const { data, error } = await db.from('invoices').update({ live_status: to }).eq('id', id).eq('live_status', from).select('id')
      if (error) return dbErr(error.message)
      if (!data?.length) return no('status changed in another tab — reload', 409)
      await db.from('data_fixes').insert({ check_key: 'doc-status', table_name: 'invoices', row_id: id, field: 'live_status', old_value: from, new_value: to, label: `/doc STATUS · ${s.bundle.invoice.invoice_code} · ${actor}`.slice(0, 200) }).then(() => undefined, () => undefined)
      return done({ from, to })
    }
  }
  return null
}
