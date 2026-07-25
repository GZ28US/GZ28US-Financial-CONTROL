import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { runAppsSweep } from '@/lib/appsMail.server'

// Disparo manual do APPS watcher (o cron de 30min roda dentro do mail-poll).
// ?full=1 varre o Gmail INTEIRO — usado no backfill inicial e em re-sincronias.
// Idempotente: e-mail com marcador Apps/* nunca é reprocessado.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get('full') === '1'
  const result = await runAppsSweep(streamDb(), { full })
  return NextResponse.json({ ok: true, full, ...result })
}
