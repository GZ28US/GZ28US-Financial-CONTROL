import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { crossingBalance, crossingDbs, CrossingReadError } from '@/lib/crossingBalance.server'
import { intercompanyLedger } from '@/lib/intercompanyLedger.server'

// ── QUANTO O BR DEVE AO US — o número único das telas (23/out/2026: a CONTA CALCULADA) ──────────────────────
// GET → brOwesUs = o saldo de lib/intercompanyLedger.server.ts (PAID BY / RECEIVED BY dos dois apps + transferências), que o
// Balanço («Conta corrente GZ28BR») e o card do Data Checker mostram — o MESMO número do GZ-FLOW. Junto vai o detalhe do
// espelho antigo (usSide/brSide das 006.N/085.N, lib/crossingBalance.ts) e o saldo dele em `legacy`, só para conferência:
// o espelho está encerrado e é histórico. Portão requireUser. Falha fecha: erro → sem número.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ ok: false, kind: 'auth', error: 'Sessão do app ausente ou vencida — entre de novo.' }, { status: 401 })
  try {
    const dbs = crossingDbs()
    const [ledger, legacy] = await Promise.all([intercompanyLedger(dbs), crossingBalance(dbs)])
    const pontas: Record<string, number> = {}
    for (const p of ledger.looseEnds) pontas[p.kind] = (pontas[p.kind] || 0) + 1
    return NextResponse.json({
      ok: true,
      ...legacy,
      brOwesUs: ledger.brOwesUs,
      generatedAt: ledger.generatedAt,
      ledger: { brOwes: ledger.totals.brOwes, usOwes: ledger.totals.usOwes, byKind: ledger.totals.byKind, eras: ledger.eras, entries: ledger.entries.length, transfers: ledger.transfers.length, looseEnds: pontas, fx: ledger.fx },
      legacy: { brOwesUs: legacy.brOwesUs, usOpen: legacy.usSide.totals.open, brOpen: legacy.brSide.totals.open },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const kind = e instanceof CrossingReadError ? e.kind : 'db'
    return NextResponse.json({ ok: false, kind, error: String((e as Error)?.message || e).slice(0, 400) }, { status: kind === 'service-key' ? 503 : 502 })
  }
}
