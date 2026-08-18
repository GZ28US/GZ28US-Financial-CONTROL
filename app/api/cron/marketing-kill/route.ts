import { NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { runMarketingKill } from '@/lib/marketingKill.server'

// Cron PRÓPRIO de 5 em 5 minutos (vercel.json) — separado do mail-poll de propósito:
// o poll grande faz 15 tarefas em 60s e, se estourar, as últimas não rodam. A limpeza
// de marketing não pode depender da sobra de tempo de ninguém (caso 18/ago: e-mail da
// Temu 27h na caixa). Aqui só existe uma tarefa, e ela sempre roda.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const r = await runMarketingKill(streamDb())
    return NextResponse.json({ ok: true, ms: Date.now() - t0, killed: r.killed.length, blocked: r.blocked.length, details: r })
  } catch (e) {
    console.error('[marketing-kill]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
export async function POST() { return GET() }
