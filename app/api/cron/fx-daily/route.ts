import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { crossingDbs } from '@/lib/crossingBalance.server'
import { carregarCotacoes } from '@/lib/crossing.server'

// O BID DIÁRIO USD-BRL (fx_usd_brl_daily) TODO DIA (26/out/2026). Quem enchia a tabela era o motor do espelho, ao precisar
// de uma data — com o espelho encerrado em 23/10, a tabela parou em 22/10. Agora este cron (01:30 de Brasília) pede os
// últimos 30 dias FECHADOS: carregarCotacoes lê o que já está guardado e só busca na AwesomeAPI o que falta (dia fechado
// nunca muda). RESERVA: a AwesomeAPI devolve 429 para o IP compartilhado da Vercel — o que faltar vem da PTAX do Banco
// Central (cotação de COMPRA do fechamento), gravada com fonte própria; dia sem pregão fica sem linha.
// Quem lê: o app BR (R$ estimado de linha só em US$ — COSTS → SUPPLIERS) e a conta BR↔US.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const diaSP = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
const mdy = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const datas: string[] = []
  for (let i = 1; i <= 30; i++) datas.push(diaSP(new Date(Date.now() - i * 86400000)))
  const de = datas[datas.length - 1], ate = datas[0]
  try {
    const { us } = crossingDbs()
    const r = await carregarCotacoes(datas, us)
    let bcb = 0
    const { data: tem } = await us.from('fx_usd_brl_daily').select('dia').gte('dia', de).lte('dia', ate)
    const ja = new Set(((tem || []) as { dia: string }[]).map(t => t.dia))
    const faltam = new Set(datas.filter(d => !ja.has(d)))
    if (faltam.size) {
      const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${mdy(de)}'&@dataFinalCotacao='${mdy(ate)}'&$format=json`
      const resp = await fetch(url, { cache: 'no-store' })
      if (resp.ok) {
        const j = await resp.json() as { value?: { cotacaoCompra: number; dataHoraCotacao: string }[] }
        // a PTAX publica vários boletins no dia; o último (fechamento) vale
        const porDia = new Map<string, { cotacaoCompra: number; dataHoraCotacao: string }>()
        for (const v of j.value || []) { const d = v.dataHoraCotacao.slice(0, 10); const p = porDia.get(d); if (!p || v.dataHoraCotacao > p.dataHoraCotacao) porDia.set(d, v) }
        const linhas = [...porDia.entries()].filter(([d]) => faltam.has(d))
          .map(([d, v]) => ({ dia: d, bid: v.cotacaoCompra, ts: Date.parse(v.dataHoraCotacao.replace(' ', 'T')), fonte: 'BCB PTAX compra (reserva — AwesomeAPI 429)' }))
        if (linhas.length) {
          const { error } = await us.from('fx_usd_brl_daily').upsert(linhas, { onConflict: 'dia', ignoreDuplicates: true })
          if (!error) bcb = linhas.length
        }
      }
    }
    const { data: ult } = await us.from('fx_usd_brl_daily').select('dia, bid, fonte').not('bid', 'is', null).order('dia', { ascending: false }).limit(1)
    return NextResponse.json({ ok: !r.falha || bcb > 0, falha: r.falha, gravados_bcb: bcb, ultimo: (ult || [])[0] || null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
