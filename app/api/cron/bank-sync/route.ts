import { NextRequest, NextResponse } from 'next/server'
import { syncAllBankItems, bankDb } from '@/lib/plaid.server'
import { autoBook } from '@/lib/bankReconcile.server'

// REDE DE SEGURANÇA (cron 6/6h): mesmo que um webhook do Plaid se perca, o sync
// por cursor pega tudo que ficou pra trás. Idempotente — rodar em cima do webhook
// não duplica nada (dedupe físico pelo UNIQUE em plaid_id).
// AUTO-BOOK (BL 0.8.0): depois do sync, o motor automático REGISTRA as linhas
// novas sozinho — casa de verdade em bank_auto_runs (uma rodada por vez, 240 s).
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Só o cron da Vercel (Authorization: Bearer CRON_SECRET) — a rota estava aberta
  // e devolvia saldo e contas (revisão #6). Resposta enxuta: contagens, sem saldo.
  const auth = req.headers.get('authorization') || ''
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const t0 = Date.now()
  const results = await syncAllBankItems()
  // Orçamento do motor conta a partir do INÍCIO do request (o sync já gastou):
  // 300 s de lambda − 25 s de folga − o que o sync levou, nunca menos de 30 s.
  const auto = await autoBook(bankDb(), { trigger: 'cron', deadlineMs: Math.max(30_000, 275_000 - (Date.now() - t0)) })
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return NextResponse.json({
    ok: true, at: new Date().toISOString(),
    results: (results as any[]).map((r) => ({ account: r.account, added: r.added, modified: r.modified, removed: r.removed, balances: r.balances, error: r.error || r.balance_error || null })),
    auto: { run: auto.run || null, status: auto.status, skipped: auto.skipped || null, counts: auto.counts, errors: auto.errors.length, remaining: auto.remaining, lines: auto.lines },
  })
}
