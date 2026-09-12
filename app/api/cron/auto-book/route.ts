import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { runAutoBookMail } from '@/lib/autoBookMail.server'

// AUTO-BOOK — A RODADA DE 1 EM 1 HORA (Márcio, 06/set/2026):
//   "ensine o robô a fazer o round de 1 em 1 hora, pra que ele deixe pra vc aqui
//    só o que ele tiver dúvida."
//
// POR QUE UM CRON PRÓPRIO, E NÃO MAIS UM TRABALHO DENTRO DO mail-poll:
// o mail-poll já carrega 15 trabalhos em série, roda de 5 em 5 minutos e ESTOUROU
// o teto de tempo por 4 dias seguidos — quem estava no fim da fila simplesmente
// não rodava (ver o comentário do maxDuration lá). A captura de compra nova é
// justamente o trabalho que não pode morrer calado, então ela ganha relógio
// próprio, de hora em hora, e ninguém na frente dela.
//
// A janela é de 3 HORAS para uma batida de 1 hora, de propósito: sobreposição de
// 2h é o seguro contra a passada que falhou, contra o atraso do provedor e contra
// o e-mail que chega no segundo exato da virada. Repetir não custa nada — o
// `message_key` é único e a linha repetida é recusada pelo banco.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// `horas` só existe para o dia em que a rodada ficou parada (deploy, cota, teto de
// tempo) e é preciso pescar a janela perdida de uma vez. Teto de 168h = 7 dias: o
// custo de varrer é o do provedor, mas o custo de uma janela larga sem querer é
// encher a fila de dúvida com coisa velha já resolvida na mão.
export async function GET(req: NextRequest) {
  // QUEM PODE ACORDAR O ROBÔ (10/set/2026, Livro 1.4). Até hoje a rota estava
  // aberta: qualquer um com a URL disparava uma varredura de até 168 horas que lê
  // as seis caixas, arquiva e-mail e lança linha (achado da sessão do João).
  // Passam só o cron da Vercel (Authorization: Bearer CRON_SECRET) e quem tem a
  // chave de leitura — é a chave que mantém possível a rodada humana de `?horas=N`
  // (header `x-read-key`, ou `?key=` para quem já chama assim). O `!!` impede que
  // um CRON_SECRET ausente vire a senha "Bearer undefined".
  // PORTÃO ÚNICO (11/set/2026): a checagem à mão virou lib/apiAuth.server.ts, pra
  // troca de chave mexer num lugar só. Aceita o cron da Vercel (Bearer CRON_SECRET)
  // ou a chave de leitura no header x-read-key; `?key=` segue valendo enquanto os
  // scripts das sessões e o atalho do iPhone não migram (a chave na URL vai parar
  // em todo log de acesso). As duas comparações falham fechadas.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = streamDb()
  const h = Math.min(168, Math.max(1, parseInt(req.nextUrl.searchParams.get('horas') || '3') || 3))
  try {
    const r = await runAutoBookMail(db, h, req.nextUrl.searchParams.get('horas') ? 'human' : 'cron')
    return NextResponse.json({ ok: true, horas: h, ...r })
  } catch (e) {
    console.error('[auto-book]', e)
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) { return GET(req) }
