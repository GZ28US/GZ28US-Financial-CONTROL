import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { runParcelLocker } from '@/lib/parcelLocker.server'

// ROBÔ DO LOCKER (17/11/2026) — cron PRÓPRIO de 5 em 5 minutos (vercel.json), fora do mail-poll de propósito: lá são 15 robôs em
// série e quem está no fim da fila não roda quando o tempo estoura (04/set/2026). O que ele faz está em lib/parcelLocker.server.ts.
// Quem pode disparar: o cron da Vercel (Bearer CRON_SECRET) ou a chave de leitura no header x-read-key. Chamar à mão é seguro:
// e-mail já tratado não é tratado de novo, e com a chave `notify.chris.parcel_locker` desligada nada é enviado nem arquivado.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const t0 = Date.now()
  try {
    const origin = process.env.SOCIAL_PUBLIC_ORIGIN || 'https://www.gz28us.com'
    // ?dry=N (horas) = ensaio: devolve o texto que o robô escreveria, sem gravar, mandar ou arquivar.
    const r = await runParcelLocker(streamDb(), origin, { dryHours: Number(req.nextUrl.searchParams.get('dry')) || 0 })
    return NextResponse.json({ ok: true, ms: Date.now() - t0, ...r })
  } catch (e) {
    console.error('[parcel-locker]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
export async function POST(req: NextRequest) { return GET(req) }
