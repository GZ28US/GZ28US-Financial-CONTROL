/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /ca/api/doc/checks — the three Data Checker cards of the quote portal (blueprint §2.2 /adm/check, §9 #11). Staff only, read only.
//   closed-with-open-plan (rules R2-05, D-17 A): a CLOSED invoice with a payment-plan installment not fully paid — receivable, not a block;
//   signed-total-drift (consumers #4, rules R2-09): the live total ≠ the approved revision's total (a later edit of car/client/discount,
//     or a line inserted after the signature) — the money readers keep the signed one (lib/money.ts) until a CHANGE ORDER;
//   plan-sum-drift (rules R2-17): a hired document whose live grand ≠ Σ plan cents (estorno, inserted line) — PAY on the last row hides.
// Test documents are left out. Only documents that have a portal plan or an approval are read.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb, loadDocState } from '@/lib/quoteDoc.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!(await requireStaff(req))) return NextResponse.json({ error: 'staff only' }, { status: 403 })
  const db = serviceDb()
  const [{ data: ap }, { data: plan }, { data: tl }] = await Promise.all([
    db.from('invoice_approvals').select('invoice_id'),
    db.from('invoice_installments').select('invoice_id'),
    db.from('quote_links').select('invoice_id').eq('is_test', true),
  ])
  const test = new Set((tl || []).map(l => l.invoice_id))
  const ids = [...new Set([...(ap || []), ...(plan || [])].map(r => r.invoice_id))].filter(id => !test.has(id)).slice(0, 300)
  const out = { closedOpenPlan: [] as any[], signedDrift: [] as any[], planDrift: [] as any[], read: ids.length }
  for (const id of ids) {
    const s = await loadDocState(db, id).catch(() => null)
    if (!s || s.isTest) continue
    const inv = s.bundle.invoice
    const base = { invoice_id: id, code: inv.invoice_code, href: `/doc/${id}`, client: s.bundle.client?.name || '' }
    if (!inv.is_quote && inv.live_status === 'CLOSED') {
      const open = ((s.live?.document?.installments || []) as any[]).filter(i => !s.stage.paidBySeq[i.seq])
      if (open.length) out.closedOpenPlan.push({ ...base, amount: open.reduce((a, i) => a + Number(i.amount_cents) / 100, 0), rows: open.map(i => `${i.seq} ${i.label_text}`) })
    }
    if (s.approvals.length && Math.abs(s.signedDrift || 0) > 0.005) out.signedDrift.push({ ...base, amount: Math.abs(s.signedDrift), signed: Number(s.live?.grand_total || 0), live: s.bundle.money.grand })
    if (!inv.is_quote && s.planDrift !== 0) out.planDrift.push({ ...base, amount: Math.abs(s.planDrift) / 100, cents: s.planDrift })
  }
  return NextResponse.json({ ok: true, ...out })
}
