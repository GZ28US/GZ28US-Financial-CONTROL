import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { runAppsSweep } from '@/lib/appsMail.server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'

// Disparo manual do APPS watcher (o cron de 30min roda dentro do mail-poll).
// ?full=1 varre o Gmail INTEIRO — usado no backfill inicial e em re-sincronias.
// Idempotente: e-mail com marcador Apps/* nunca é reprocessado.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // PORTÃO (11/set/2026): o sweep apaga parcelas agendadas não pagas quando acha e-mail de cancelamento,
  // e ?full=1 varre o Gmail inteiro — nunca para anônimo. Não há cron desta rota na Vercel: quem dispara
  // é sessão com a chave de leitura (x-read-key; `?key=` ainda vale na transição).
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const full = req.nextUrl.searchParams.get('full') === '1'
  const result = await runAppsSweep(streamDb(), { full })
  return NextResponse.json({ ok: true, full, ...result })
}
