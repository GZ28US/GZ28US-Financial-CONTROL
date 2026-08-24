import { NextResponse } from 'next/server'
import { streamDb, refreshAllTracking } from '@/lib/stream.server'

// ── STREAM AUTO-ATUALIZÁVEL (ordem do Márcio, 24/ago/2026) ───────────────────
// "o stream tinha que ser automático, sem precisar de gatilho nosso... se ele
// sabe o rastreio do item, tinha que ele se auto-atualizar de 1 em 1 hora,
// jamais teríamos que ser nós a fazermos isso."
//
// O refresh já existia, mas pendurado no mail-poll — que tem throttle de 10min
// E 15 tarefas dentro de 60s. Quando o poll estoura o tempo (ou está throttled,
// como estava hoje), o rastreio simplesmente não roda. Mesma doença que o
// marketing-kill teve, mesma cura: CRON PRÓPRIO, uma tarefa só, sempre roda.
//
// De hora em hora é o certo: transportadora posta checkpoint a cada poucas
// horas, e o 17TRACK cobra por consulta — 24 ciclos/dia cobre tudo sem
// desperdício (5 em 5 min seria 288, sem nenhum ganho de informação).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const r = await refreshAllTracking(streamDb())
    return NextResponse.json({ ok: true, ms: Date.now() - t0, ...r })
  } catch (e) {
    console.error('[track-refresh]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
export async function POST() { return GET() }
