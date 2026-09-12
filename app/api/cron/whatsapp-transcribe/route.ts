import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { waTranscribePending } from '@/lib/waTranscribe.server'

// WHATSAPP HUB — transcrição dos áudios (cron 10/10min). O espelho já guardou a
// linha e o link da mídia; aqui o áudio vira texto na coluna `transcript`.
// Cobre os DOIS números de uma vez: o espelho é um só.
//
// Backfill do histórico (rodar até `scanned: 0`):
//   GET /ca/api/cron/whatsapp-transcribe?key=<WHATSAPP_READ_KEY>&limit=100

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // PORTÃO ÚNICO (11/set/2026): a checagem à mão virou lib/apiAuth.server.ts, pra
  // troca de chave mexer num lugar só. Aceita o cron da Vercel (Bearer CRON_SECRET)
  // ou a chave de leitura no header x-read-key; `?key=` segue valendo enquanto os
  // scripts das sessões e o atalho do iPhone não migram (a chave na URL vai parar
  // em todo log de acesso). As duas comparações falham fechadas.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '20') || 20
  // ?chat=<chatId> fura a fila por conversa — ver waTranscribePending.
  const chatId = (req.nextUrl.searchParams.get('chat') || '').trim() || undefined

  try {
    const result = await waTranscribePending({ limit, chatId })
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result })
  } catch (e) {
    console.error('[whatsapp-transcribe]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
