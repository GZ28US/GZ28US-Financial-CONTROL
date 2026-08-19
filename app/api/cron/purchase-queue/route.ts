import { NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { runPurchaseQueue } from '@/lib/purchaseQueue.server'

// Cron PRÓPRIO de 5 em 5 minutos (vercel.json) — mesma lição do marketing-kill:
// a fila de destino das compras não pode depender da sobra de tempo do
// mail-poll. Aqui só existe uma tarefa, e ela sempre roda: regras → respostas
// do grupo → perguntas (uma por expense) → lembrete de hora em hora.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const r = await runPurchaseQueue(streamDb())
    return NextResponse.json({ ok: true, ms: Date.now() - t0, ...r })
  } catch (e) {
    console.error('[purchase-queue]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
export async function POST() { return GET() }
