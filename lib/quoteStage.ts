// THE STAGE of a quote/invoice document — derived from facts, never stored (blueprint §3.1; C-05, C-19). Pure, shared by the
// staff page (/doc), the ACTION NEEDED index and the public page. `live_status` (INCOMPLETE / ONLINE / CLOSED) is the other,
// independent axis and is not touched here.
//
// PAID per installment = Σ amounts of the incomes carrying that installment_id with paid_at (refund / dispute rows carry the
// installment they reverse, so a refund brings the installment back to unpaid).

export type Stage = 'VOID' | 'INVOICE' | 'SIGNED' | 'DRAFT' | 'EXPIRED' | 'DECLINED' | 'CHANGES' | 'VIEWED' | 'SENT'
export type SubStage = 'DEPOSIT_PENDING' | 'DEPOSIT_CLEARING' | 'DEPOSIT_FAILED' | 'DEPOSIT_RECEIVED' | 'DEPOSIT_REFUNDED' | 'NEW_VERSION_PENDING' | 'CHANGE_ORDER_PENDING' | null

export type StageInput = {
  is_quote: boolean
  link: { revoked_at: string | null; first_viewed_at: string | null } | null       // latest link (live, or the revoked one if none is live)
  liveLink: boolean                                                                  // a non-revoked link exists
  live: { id: string; seq: number; created_at: string; kind?: string } | null        // live revision (QUOTE/CHANGE_ORDER, not superseded)
  hasSuperseded: boolean
  approvalOnLive: boolean
  anyApproval: boolean
  attempts: { status: string; installment_id: string | null; seq: number | null; verification?: string | null; created_at: string; revision_id?: string | null }[]
  validUntil: string | null                                                          // invoice_terms.valid_until (YYYY-MM-DD)
  today: string                                                                      // Orlando YYYY-MM-DD
  events: { kind: string; at: string }[]
  openChanges: boolean                                                               // CHANGES note after the live revision, not hidden
  plan: { id: string; seq: number; amount: number }[]                                // amounts in US$ (frozen from the revision when one exists)
  incomes: { installment_id: string | null; amount: number; paid_at: string | null }[]
}

export type StageOut = { stage: Stage; sub: SubStage; paidBySeq: Record<number, boolean>; paidAmountBySeq: Record<number, number> }

export function paidBySeq(plan: StageInput['plan'], incomes: StageInput['incomes']) {
  const amt: Record<number, number> = {}, paid: Record<number, boolean> = {}
  for (const p of plan) {
    const s = incomes.filter(i => i.installment_id === p.id && i.paid_at).reduce((a, i) => a + Number(i.amount || 0), 0)
    amt[p.seq] = Math.round(s * 100) / 100
    paid[p.seq] = s >= p.amount - 0.01
  }
  return { paid, amt }
}

export function quoteStage(d: StageInput): StageOut {
  const { paid, amt } = paidBySeq(d.plan, d.incomes)
  const out = (stage: Stage, sub: SubStage = null): StageOut => ({ stage, sub, paidBySeq: paid, paidAmountBySeq: amt })
  if (d.link?.revoked_at && !d.liveLink) return out('VOID')
  const latest = [...d.attempts].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (!d.is_quote) {
    if (!d.live && !d.anyApproval) return out('INVOICE')
    if (d.live?.kind === 'CHANGE_ORDER' && !d.approvalOnLive) return out('INVOICE', 'CHANGE_ORDER_PENDING')   // M4: the client approves the CO on the link
    const first = d.plan.find(p => p.seq === 1)
    if (first) {
      if (paid[1]) return out('INVOICE', 'DEPOSIT_RECEIVED')
      const any = d.incomes.some(i => i.installment_id === first.id && i.paid_at)
      if (any) return out('INVOICE', 'DEPOSIT_REFUNDED')
      if (d.attempts.some(a => a.status === 'PROCESSING' && a.seq === 1)) return out('INVOICE', 'DEPOSIT_CLEARING')
      if (latest?.status === 'FAILED') return out('INVOICE', 'DEPOSIT_FAILED')
    }
    return out('INVOICE')
  }
  if (d.live && d.approvalOnLive) {
    if (d.attempts.some(a => a.status === 'PROCESSING')) return out('SIGNED', 'DEPOSIT_CLEARING')
    if (d.attempts.some(a => a.status === 'OPEN')) return out('SIGNED', 'DEPOSIT_PENDING')
    if (latest?.status === 'FAILED') return out('SIGNED', 'DEPOSIT_FAILED')
    return out('SIGNED')
  }
  if (!d.live && d.hasSuperseded) return out('DRAFT', 'NEW_VERSION_PENDING')
  if (!d.live) return out('DRAFT')
  if (d.validUntil && d.validUntil < d.today) return out('EXPIRED')
  const since = d.live.created_at
  const after = d.events.filter(e => e.at >= since)
  const lastDecl = after.filter(e => e.kind === 'DECLINED').map(e => e.at).sort().pop()
  const lastWithdraw = after.filter(e => e.kind === 'DECLINE_WITHDRAWN').map(e => e.at).sort().pop()
  if (lastDecl && (!lastWithdraw || lastWithdraw < lastDecl)) return out('DECLINED')
  if (d.openChanges) return out('CHANGES')
  if (d.link?.first_viewed_at && after.some(e => e.kind === 'VIEWED')) return out('VIEWED')
  return out('SENT')
}

// The ACTION NEEDED order (blueprint §2.2 /doc index; A-16): what needs the owner first.
export function actionRank(s: StageOut): number {
  if (s.stage === 'SIGNED' && !s.sub) return 0
  if (s.stage === 'SIGNED' && s.sub === 'DEPOSIT_FAILED') return 1
  if (s.stage === 'SIGNED') return 2
  if (s.stage === 'CHANGES') return 3
  if (s.stage === 'DECLINED') return 4
  if (s.stage === 'VIEWED') return 6
  if (s.stage === 'SENT') return 7
  if (s.stage === 'EXPIRED') return 8
  if (s.stage === 'DRAFT') return 9
  if (s.stage === 'INVOICE') return 10
  return 11
}

export const STAGE_LABEL: Record<Stage, string> = {
  VOID: 'VOID', INVOICE: 'INVOICE', SIGNED: 'SIGNED', DRAFT: 'DRAFT', EXPIRED: 'EXPIRED', DECLINED: 'DECLINED',
  CHANGES: 'CHANGES REQUESTED', VIEWED: 'VIEWED', SENT: 'SENT',
}
export const SUB_LABEL: Record<Exclude<SubStage, null>, string> = {
  DEPOSIT_PENDING: 'deposit pending', DEPOSIT_CLEARING: 'deposit clearing', DEPOSIT_FAILED: 'deposit failed',
  DEPOSIT_RECEIVED: 'deposit received', DEPOSIT_REFUNDED: 'deposit refunded', NEW_VERSION_PENDING: 'new version pending', CHANGE_ORDER_PENDING: 'change order awaiting approval',
}
