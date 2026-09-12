import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { runMarketingKill } from '@/lib/marketingKill.server'

// Cron PRÓPRIO de 5 em 5 minutos (vercel.json) — separado do mail-poll de propósito:
// o poll grande faz 15 tarefas em 60s e, se estourar, as últimas não rodam. A limpeza
// de marketing não pode depender da sobra de tempo de ninguém (caso 18/ago: e-mail da
// Temu 27h na caixa). Aqui só existe uma tarefa, e ela sempre roda.
//
// QUEM PODE DISPARAR (10/set/2026): o cron da Vercel (Authorization: Bearer CRON_SECRET)
// ou quem tem a chave de leitura (header `x-read-key`, ou `?key=`). A rota estava
// aberta. O estrago possível era pequeno — ela só faz o que o cron já faz de 5 em 5
// minutos —, mas robô que APAGA e-mail não fica com a porta aberta. Fechada junto com a
// do auto-book, com o aval do Márcio. O `!!` impede que um CRON_SECRET ausente vire a
// senha "Bearer undefined".

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // PORTÃO ÚNICO (11/set/2026): a checagem à mão virou lib/apiAuth.server.ts, pra
  // troca de chave mexer num lugar só. Aceita o cron da Vercel (Bearer CRON_SECRET)
  // ou a chave de leitura no header x-read-key; `?key=` segue valendo enquanto os
  // scripts das sessões e o atalho do iPhone não migram (a chave na URL vai parar
  // em todo log de acesso). As duas comparações falham fechadas.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const t0 = Date.now()
  try {
    const r = await runMarketingKill(streamDb())
    return NextResponse.json({ ok: true, ms: Date.now() - t0, killed: r.killed.length, blocked: r.blocked.length, details: r })
  } catch (e) {
    console.error('[marketing-kill]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
export async function POST(req: NextRequest) { return GET(req) }
