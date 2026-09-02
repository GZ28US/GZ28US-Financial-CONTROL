import { NextRequest, NextResponse } from 'next/server'
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
  const auth = req.headers.get('authorization') || ''
  const key = req.nextUrl.searchParams.get('key') || ''
  const cronOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
  const keyOk = !!process.env.WHATSAPP_READ_KEY && key === process.env.WHATSAPP_READ_KEY
  if (!cronOk && !keyOk) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '20') || 20

  try {
    const result = await waTranscribePending({ limit })
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result })
  } catch (e) {
    console.error('[whatsapp-transcribe]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
