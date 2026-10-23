import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { crossingDbs, CrossingReadError } from '@/lib/crossingBalance.server'
import { intercompanyLedger } from '@/lib/intercompanyLedger.server'
import { casarTransferenciasComRegions } from '@/lib/intercompanyBank.server'

// ── O CRON DA CONTA BR↔US (23/out/2026) — de hora em hora, no lugar do cron do espelho ────────────────────────
// ESPELHO ENCERRADO (Márcio, 23/10/2026): o motor de lib/crossing.server.ts não grava mais (ESPELHO_ENCERRADO). Esta rodada:
//   1. casa as transferências BR→US que chegaram com a linha NEW da Regions de mesmo valor (lib/intercompanyBank.server.ts);
//   2. calcula a conta (lib/intercompanyLedger.server.ts) e devolve o saldo e as pontas soltas, para o log da Vercel.
// Nada mais é copiado entre os apps. Portão: cron da Vercel ou x-read-key.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const dbs = crossingDbs()
    const casamento = await casarTransferenciasComRegions(dbs.us)
    const ledger = await intercompanyLedger(dbs)
    const pontas: Record<string, number> = {}
    for (const p of ledger.looseEnds) pontas[p.kind] = (pontas[p.kind] || 0) + 1
    return NextResponse.json({ ok: true, espelho: 'encerrado 23/10/2026', brOwesUs: ledger.brOwesUs, lancamentos: ledger.entries.length, transferencias: ledger.transfers.length, pontas_soltas: pontas, casamento }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const kind = e instanceof CrossingReadError ? e.kind : 'db'
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[cron crossing]', kind, msg)
    return NextResponse.json({ ok: false, kind, error: msg }, { status: kind === 'service-key' ? 503 : 502 })
  }
}
