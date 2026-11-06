/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — CHANGE ORDERS (QUOTE PORTAL M4, 06/11/2026; blueprint §3.2 T13/T14, §3.5; MIGRATION_quote_portal_change_order.sql).
// buildChangeOrder(): from the document as it is NOW (lines inserted after the signature, estornos) plus the staff's proposed edits of
// FROZEN lines (reprice / requantify / rename / remove — the DB lock keeps those rows untouched until the CO is approved), builds
// revision n+1 kind CHANGE_ORDER: the lines, the totals by law, the plan in cents (paid installments keep their cents, the LAST UNPAID
// installment absorbs the difference, C-27/C-32) and the delta against the newest APPROVED revision {added, removed, changed,
// grand_before, grand_after}. Pure on a DocState; the route calls change_order_send() with the result.
// coBand(): Fla. Stat. §559.909 — a shop may not charge more than the written estimate by more than $10 or 10 %, whichever is greater,
// not to exceed $50, without the customer's consent. Inside that band (or any decrease) staff may RECORD the approval (SHOP_*);
// above it the client approves on the link.
import { invoiceMoneyFor } from './flTax'
import { buildRevision, canonicalJson, sha256, type DocState, type PlanRow } from './quoteDoc.server'

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (n: number) => Math.round(n * 100) / 100

export type CoEdit = { id: string; description?: string; unit_price?: number; quantity?: number; price?: number; remove?: boolean }
export type CoEdits = { items?: CoEdit[]; services?: CoEdit[] }
export type CoDelta = {
  base_seq: number; grand_before: number; grand_after: number; diff: number
  added: { id: string; kind: string; description: string; total: number }[]
  removed: { id: string; kind: string; description: string; total: number }[]
  changed: { id: string; kind: string; description: string; before: { description: string; unit_price: number; quantity: number; total: number }; after: { description: string; unit_price: number; quantity: number; total: number } }[]
}

export function approvedRevision(s: DocState) {
  const approvedIds = new Set(s.approvals.map(a => a.revision_id))
  return [...s.revisions].filter(r => (r.kind === 'QUOTE' || r.kind === 'CHANGE_ORDER') && approvedIds.has(r.id)).sort((a, b) => b.seq - a.seq)[0] || null
}

export function coBand(grandBefore: number, grandAfter: number) {
  const increase = r2(grandAfter - grandBefore)
  const band = Math.min(50, Math.max(10, r2(grandBefore * 0.10)))
  return { increase, band, staffMayRecord: increase <= band + 0.005 }
}

export function buildChangeOrder(s: DocState, edits: CoEdits, opts: { validUntil?: string | null } = {}) {
  const problems: string[] = []
  const inv = s.bundle.invoice
  if (inv.is_quote) return { problems: ['still a quote — before the deposit use NEW REVISION'] } as const
  const base = approvedRevision(s)
  if (!base) return { problems: ['no approved revision to change'] } as const
  if (!s.terms) return { problems: ['no terms'] } as const
  const frozen = new Map<string, any>(((base.document?.lines || []) as any[]).map(l => [String(l.id), l]))
  const byId = <T extends { id: string }>(xs: T[] | undefined) => new Map((xs || []).filter(x => x && x.id).map(x => [String(x.id), x]))
  const ie = byId(edits.items), se = byId(edits.services)
  for (const id of [...ie.keys(), ...se.keys()]) {
    const it = s.bundle.items.find(i => String(i.id) === id), sv = s.bundle.services.find(v => String(v.id) === id)
    if (!it && !sv) problems.push(`line ${id.slice(0, 8)} is not on this document`)
    if (it && (it.mirror_expense_id || it.mirror_src)) problems.push(`"${it.description}" is a mirror line (born from an expense) — change it in the editor`)
  }
  if (problems.length) return { problems } as const
  // the document as it would be: today's rows + the proposed edits
  const items = s.bundle.items.filter(i => !ie.get(String(i.id))?.remove).map(i => {
    const e = ie.get(String(i.id)); if (!e) return i
    return { ...i, description: e.description != null ? String(e.description).trim() || i.description : i.description,
      unit_price: e.unit_price != null ? num(e.unit_price) : i.unit_price, quantity: e.quantity != null ? (num(e.quantity) || 1) : i.quantity }
  })
  const services = s.bundle.services.filter(v => !se.get(String(v.id))?.remove).map(v => {
    const e = se.get(String(v.id)); if (!e) return v
    return { ...v, description: e.description != null ? String(e.description).trim() || v.description : v.description, price: e.price != null ? num(e.price) : v.price }
  })
  const live = items.filter(i => i.counts)
  const money = invoiceMoneyFor(inv, s.bundle.ride?.title_scope, s.bundle.client as any, live.map(i => num(i.unit_price) * num(i.quantity)), services.map(v => num(v.price)))
  const bundle = { ...s.bundle, items, services, money }
  // the plan: paid rows keep their cents; the last unpaid row absorbs (grand_after − Σ the others)
  const baseCents = new Map<string, number>(((base.document?.installments || []) as any[]).map(i => [String(i.id), Number(i.amount_cents)]))
  const rows = [...s.plan].sort((a, b) => a.seq - b.seq)
  const paid = (p: PlanRow) => !!s.stage.paidBySeq[p.seq]
  const absorber = [...rows].reverse().find(p => !paid(p))
  if (!absorber) return { problems: ['every installment is paid — add the extra as a new line and RECORD PAYMENT (an extra installment arrives later)'] } as const
  const total = Math.round(r2(money.grand) * 100)
  const others = rows.filter(p => p.id !== absorber.id).reduce((a, p) => a + (baseCents.get(p.id) ?? 0), 0)
  const absorbCents = total - others
  if (absorbCents <= 0) return { problems: [`the change takes the open installment ${absorber.seq} to ${(absorbCents / 100).toFixed(2)} — a credit above the unpaid balance is a REFUND, not a change order`] } as const
  const fixed: PlanRow[] = rows.map(p => ({ ...p, pct: null, amount: (p.id === absorber.id ? absorbCents : (baseCents.get(p.id) ?? 0)) / 100 }))
  const b = buildRevision(bundle as any, s.terms, fixed, { validUntil: opts.validUntil ?? null })
  problems.push(...b.problems.filter(p => !/payment plan amounts exceed/.test(p)))
  // delta against the approved revision
  const now = new Map<string, any>(((b.document.lines || []) as any[]).map(l => [String(l.id), l]))
  const pick = (l: any) => ({ description: String(l.description), unit_price: num(l.unit_price), quantity: num(l.quantity), total: num(l.total) })
  const delta: CoDelta = {
    base_seq: base.seq, grand_before: num(base.grand_total), grand_after: b.grand, diff: r2(b.grand - num(base.grand_total)),
    added: [...now.values()].filter(l => !frozen.has(String(l.id))).map(l => ({ id: String(l.id), kind: l.kind, description: l.description, total: num(l.total) })),
    removed: [...frozen.values()].filter(l => !now.has(String(l.id))).map(l => ({ id: String(l.id), kind: l.kind, description: l.description, total: num(l.total) })),
    changed: [...now.values()].filter(l => frozen.has(String(l.id))).map(l => ({ l, f: frozen.get(String(l.id)) }))
      .filter(({ l, f }) => l.description !== f.description || num(l.unit_price) !== num(f.unit_price) || num(l.quantity) !== num(f.quantity))
      .map(({ l, f }) => ({ id: String(l.id), kind: l.kind, description: l.description, before: pick(f), after: pick(l) })),
  }
  if (!delta.added.length && !delta.removed.length && !delta.changed.length && Math.abs(delta.diff) < 0.005) problems.push('nothing changes — the document equals the approved revision')
  const document: Record<string, any> = { ...b.document, kind: 'CHANGE_ORDER', change_order: { base_seq: base.seq, delta } }
  return { problems, document, sha256: sha256(canonicalJson(document)), presented_sha256: b.presented_sha256, terms_sha256: b.terms_sha256,
    grand: b.grand, fl_tax: b.fl_tax, fl_status: b.fl_status, delta, band: coBand(delta.grand_before, delta.grand_after) } as const
}
