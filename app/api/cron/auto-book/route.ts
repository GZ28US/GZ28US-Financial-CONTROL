import { NextResponse } from 'next/server'
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

export async function GET() {
  const db = streamDb()
  try {
    const r = await runAutoBookMail(db, 3)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    console.error('[auto-book]', e)
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
  }
}

export async function POST() { return GET() }
