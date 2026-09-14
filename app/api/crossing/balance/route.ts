import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { crossingBalance, CrossingReadError } from '@/lib/crossingBalance.server'

// ── QUANTO O BR DEVE AO US (14/set/2026) — só leitura ──────────────────────────
// GET → CrossingBalance (lib/crossingBalance.ts): brOwesUs e as shopping invoices dos dois lados (US 006.N,
// BR 085.N) com cada linha que entra na conta. As três telas — GZ-FLOW, Balanço e o card «Conta corrente GZ28BR»
// do Data Checker — chamam ESTA rota com sessionHeaders(), então o número é um só.
// Portão requireUser (tela logada). A chave de serviço dos dois bancos fica no servidor.
// Falha fecha: sem chave ou com leitura quebrada a resposta é erro, nunca um saldo parcial.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ ok: false, kind: 'auth', error: 'Sessão do app ausente ou vencida — entre de novo.' }, { status: 401 })
  try {
    const data = await crossingBalance()
    return NextResponse.json({ ok: true, ...data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const kind = e instanceof CrossingReadError ? e.kind : 'db'
    return NextResponse.json({ ok: false, kind, error: String((e as Error)?.message || e).slice(0, 400) }, { status: kind === 'service-key' ? 503 : 502 })
  }
}
