import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { CrossingReadError } from '@/lib/crossingBalance.server'
import { intercompanyLedger } from '@/lib/intercompanyLedger.server'

// ── A CONTA CORRENTE BR↔US, CALCULADA (23/out/2026) — só leitura ─────────────
// GET → Ledger (lib/intercompanyLedger.server.ts): o saldo «quanto o BR deve ao US» e cada lançamento que o compõe,
// nos dois apps (PAID BY / RECEIVED BY da outra empresa) + as transferências. Portão: tela logada, cron ou x-read-key.
// Falha fecha: erro de leitura devolve erro, nunca saldo parcial.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ ok: false, kind: 'auth', error: 'unauthorized' }, { status: 401 })
  try {
    const data = await intercompanyLedger()
    return NextResponse.json({ ok: true, ...data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const kind = e instanceof CrossingReadError ? e.kind : 'db'
    return NextResponse.json({ ok: false, kind, error: String((e as Error)?.message || e).slice(0, 400) }, { status: kind === 'service-key' ? 503 : 502 })
  }
}
