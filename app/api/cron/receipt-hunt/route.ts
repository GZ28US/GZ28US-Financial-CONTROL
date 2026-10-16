import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { huntReceipts } from '@/lib/receiptHunt.server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'

// O RECIBO DO GRUPO CASA A LINHA DA REGIONS (16/10/2026, Márcio: «tem que ser automático pelo robô esta busca»).
// De hora em hora: lê as fotos novas dos grupos do time, casa com as linhas paradas e lança no destino da legenda.
// `?dry=1` (só com a chave de leitura) lê as fotos mas não lança nem casa — mostra o que faria.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const dry = req.nextUrl.searchParams.get('dry') === '1'
  const maxScans = Math.min(60, Math.max(0, parseInt(req.nextUrl.searchParams.get('scans') || '20') || 20))
  try {
    const r = await huntReceipts(bankDb(), { deadlineMs: 280_000, maxScans, dry })
    return NextResponse.json({ ok: true, dry, ...r })
  } catch (e) {
    console.error('[receipt-hunt]', e)
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) { return GET(req) }
