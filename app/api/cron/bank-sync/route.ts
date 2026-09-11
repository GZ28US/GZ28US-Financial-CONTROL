import { NextRequest, NextResponse } from 'next/server'
import { syncAllBankItems, bankDb } from '@/lib/plaid.server'
import { autoBook } from '@/lib/bankReconcile.server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'

// REDE DE SEGURANÇA (cron 6/6h): mesmo que um webhook do Plaid se perca, o sync
// por cursor pega tudo que ficou pra trás. Idempotente — rodar em cima do webhook
// não duplica nada (dedupe físico pelo UNIQUE em plaid_id).
// AUTO-BOOK (BL 0.8.0): depois do sync, o motor automático REGISTRA as linhas
// novas sozinho — casa de verdade em bank_auto_runs (uma rodada por vez, 240 s).
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Só o cron da Vercel (Authorization: Bearer CRON_SECRET) ou a chave de leitura — a rota estava aberta
  // e devolvia saldo e contas (revisão #6). Resposta enxuta: contagens, sem saldo.
  // PORTÃO (11/set/2026): a comparação antiga (`auth !== 'Bearer ' + CRON_SECRET`) deixava entrar quem
  // mandasse "Bearer undefined" se a variável sumisse do ambiente. cronOk/readKeyOk falham fechados.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const t0 = Date.now()
  const results = await syncAllBankItems()
  // Orçamento do motor conta a partir do INÍCIO do request (o sync já gastou):
  // 300 s de lambda − 25 s de folga − o que o sync levou, nunca menos de 30 s.
  const auto = await autoBook(bankDb(), { trigger: 'cron', deadlineMs: Math.max(30_000, 275_000 - (Date.now() - t0)) })

  // TRAZER ZERO NÃO É ESTAR SAUDÁVEL (08/set/2026). As oito rodadas anteriores
  // disseram DONE com `errors: []` enquanto o feed estava mudo desde 04/set —
  // o Zelle de US$ 632,26 que o Regions confirmou nem apareceu. A rodada só
  // sabia dizer "não deu erro", que é coisa diferente de "trouxe o dia".
  // É a mesma doença do mail-poll, que morreu calado por quatro dias.
  // Silêncio prolongado passa a ser ALERTA na resposta e no log.
  const db = bankDb()
  const alertas: string[] = []
  const { data: contas } = await db.from('bank_accounts').select('id, display_name, institution, status').eq('status', 'ACTIVE')
  for (const c of contas || []) {
    const { data: u } = await db.from('bank_transactions').select('date').eq('item_id', c.id)
      .order('date', { ascending: false }).limit(1).maybeSingle()
    if (!u?.date) continue
    const dias = Math.floor((Date.now() - new Date(u.date + 'T12:00:00Z').getTime()) / 86_400_000)
    // 3 dias já cobre fim de semana; 7 é cegueira. Conservador de propósito:
    // alerta que grita à toa vira alerta ignorado.
    if (dias >= 3) alertas.push(`${c.display_name || c.institution}: sem transação nova há ${dias} dias (última ${u.date}) — ver /api/bank/health`)
  }
  if (alertas.length) console.error('[bank-sync] FEED PARADO:', alertas.join(' | '))

  /* eslint-disable @typescript-eslint/no-explicit-any */
  return NextResponse.json({
    ok: alertas.length === 0, alertas, at: new Date().toISOString(),
    results: (results as any[]).map((r) => ({ account: r.account, added: r.added, modified: r.modified, removed: r.removed, balances: r.balances, error: r.error || r.balance_error || null })),
    auto: { run: auto.run || null, status: auto.status, skipped: auto.skipped || null, counts: auto.counts, errors: auto.errors.length, remaining: auto.remaining, lines: auto.lines },
  })
}
