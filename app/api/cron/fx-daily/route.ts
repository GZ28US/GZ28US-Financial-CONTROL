import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { crossingDbs } from '@/lib/crossingBalance.server'
import { carregarCotacoes } from '@/lib/crossing.server'

// O BID DIÁRIO USD-BRL (fx_usd_brl_daily) TODO DIA (26/out/2026). Quem enchia a tabela era o motor do espelho, ao precisar
// de uma data — com o espelho encerrado em 23/10, a tabela parou em 22/10. Agora este cron (01:30 de Brasília) pede os
// últimos 30 dias FECHADOS: carregarCotacoes lê o que já está guardado e só busca na AwesomeAPI o que falta (dia fechado
// nunca muda). Quem lê: o app BR (R$ estimado de linha só em US$ — COSTS → SUPPLIERS) e a conta BR↔US.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const diaSP = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const datas: string[] = []
  for (let i = 1; i <= 30; i++) datas.push(diaSP(new Date(Date.now() - i * 86400000)))
  try {
    const { us } = crossingDbs()
    const r = await carregarCotacoes(datas, us)
    const { data: ult } = await us.from('fx_usd_brl_daily').select('dia, bid').not('bid', 'is', null).order('dia', { ascending: false }).limit(1)
    return NextResponse.json({ ok: !r.falha, falha: r.falha, dias_com_cotacao: r.bids.size, ultimo: (ult || [])[0] || null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
