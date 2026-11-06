// THE MONEY OF A DOCUMENT FOR EVERY READER — QUOTE PORTAL M3 (06/11/2026; blueprint §7.6, refute consumers r2 #4).
// Before the client signs, the money is the law computed live (lib/flTax `invoiceMoneyFor`: car's OWNER & DESTINATION, client
// address, override, global discount). AFTER an approval exists, the contract is frozen: the approved revision's `grand_total`,
// `fl_tax`, `fl_tax_status` are the truth for every money consumer (lists, view, HOME/FUTURE, statements), so a later edit of the
// car's title scope, the client's state or the discount never silently changes what the client signed. The live numbers keep
// showing the drift ("signed total ≠ live total" on /doc and the Data Checker card) until a CHANGE ORDER (M4) freezes a new one.
// Isomorphic (no server-only imports). Readers call `primeApproved(db)` once per load, then `docMoneyFor(...)` like invoiceMoneyFor.
import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceMoneyFor, type InvoiceMoney, type FlTaxStatus } from './flTax'

export type Approved = { invoice_id: string; revision_id: string; seq: number; grand: number; fl_tax: number; fl_tax_status: string; signed_at: string }
export type DocMoney = InvoiceMoney & { source: 'approved' | 'live'; live?: InvoiceMoney; approvedSeq?: number }

let approved = new Map<string, Approved>()
let primedAt = 0

// The newest approval per invoice (highest revision seq). Small table; read once per page load (30 s reuse).
export async function primeApproved(db: SupabaseClient, force = false): Promise<Map<string, Approved>> {
  if (!force && Date.now() - primedAt < 30_000) return approved
  const { data: aps, error } = await db.from('invoice_approvals').select('invoice_id, revision_id, signed_at')
  if (error) { console.error('[money] approvals', error.message); return approved }   // fail soft: live law, exactly as before
  const revIds = [...new Set((aps || []).map(a => a.revision_id).filter(Boolean))]
  const revs = new Map<string, { seq: number; grand_total: number; fl_tax: number; fl_tax_status: string; kind: string }>()
  for (let i = 0; i < revIds.length; i += 200) {
    const { data, error: e2 } = await db.from('invoice_revisions').select('id, seq, kind, grand_total, fl_tax, fl_tax_status').in('id', revIds.slice(i, i + 200))
    if (e2) { console.error('[money] revisions', e2.message); return approved }
    for (const r of data || []) revs.set(r.id, r as never)
  }
  const next = new Map<string, Approved>()
  for (const a of aps || []) {
    const r = revs.get(a.revision_id)
    if (!r || r.kind === 'LEGACY_BACKUP') continue
    const cur = next.get(a.invoice_id)
    if (cur && cur.seq >= r.seq) continue
    next.set(a.invoice_id, { invoice_id: a.invoice_id, revision_id: a.revision_id, seq: r.seq, grand: Number(r.grand_total), fl_tax: Number(r.fl_tax), fl_tax_status: r.fl_tax_status, signed_at: a.signed_at })
  }
  approved = next; primedAt = Date.now()
  return approved
}
export const approvedFor = (invoiceId: string | null | undefined) => (invoiceId ? approved.get(invoiceId) || null : null)

// Same signature as invoiceMoneyFor + the invoice id travels inside `inv`. No approval → byte-identical to invoiceMoneyFor.
export function docMoneyFor(inv: Parameters<typeof invoiceMoneyFor>[0] & { id?: string | null }, scope: string | null | undefined,
  client: Parameters<typeof invoiceMoneyFor>[2], partLines: number[], serviceLines: number[], ap: Approved | null = approvedFor(inv?.id)): DocMoney {
  const live = invoiceMoneyFor(inv, scope, client, partLines, serviceLines)
  if (!ap) return { ...live, source: 'live' }
  const status = ap.fl_tax_status as FlTaxStatus
  return { ...live, status, taxable: ap.fl_tax > 0, tax: ap.fl_tax, grand: ap.grand, source: 'approved', live, approvedSeq: ap.seq }
}
