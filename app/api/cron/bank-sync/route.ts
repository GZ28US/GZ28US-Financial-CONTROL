import { NextRequest, NextResponse } from 'next/server'
import { syncAllBankItems } from '@/lib/plaid.server'

// REDE DE SEGURANÇA (cron 6/6h): mesmo que um webhook do Plaid se perca, o sync
// por cursor pega tudo que ficou pra trás. Idempotente — rodar em cima do webhook
// não duplica nada (dedupe físico pelo UNIQUE em plaid_id).
export const maxDuration = 120

export async function GET(req: NextRequest) {
  // Só o cron da Vercel (Authorization: Bearer CRON_SECRET) — a rota estava aberta
  // e devolvia saldo e contas (revisão #6). Resposta enxuta: contagens, sem saldo.
  const auth = req.headers.get('authorization') || ''
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const results = await syncAllBankItems()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return NextResponse.json({ ok: true, at: new Date().toISOString(), results: (results as any[]).map((r) => ({ account: r.account, added: r.added, modified: r.modified, removed: r.removed, balances: r.balances, error: r.error || r.balance_error || null })) })
}
