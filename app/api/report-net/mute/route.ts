import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/apiAuth.server'
import { REPORT_KEY_RE, REPORT_TABLES, claimReport, type ReportKind } from '@/lib/reportedAt'

// REPORT-NET MUTE (incidente 31/jul/2026): quando o usuário responde NÃO no
// diálogo de report do editor, a escolha precisa valer também para a rede de
// segurança (expenseReportNet), que revarre tudo no cron. Chamado no fechamento
// do diálogo para TODAS as linhas listadas (enviadas ou recusadas) — enviar de
// novo nunca acontece, silenciar é respeitado.
//
// DESDE 16/SET/2026 A MARCA É A COLUNA reported_at DA PRÓPRIA LINHA (lib/reportedAt.ts, ordem do Márcio: «o App não
// reporta mais coisa que já reportou»). A rota grava a data SÓ onde ainda não há (a primeira vez vale) e aceita
// as 8 tabelas de dinheiro: ie invoice_expenses · ip invoice_incomes · se staff_expenses · as assets ·
// ae assets_expenses · in inputs · iv inventory · fc fixed_cost_expenses. É por ela que toda tela que manda
// report grava que mandou.
//
// PORTÃO (13/set/2026): silenciar a rede é decisão da tela do editor, logada
// (sessionHeaders). Aberta, qualquer um calava o aviso de gasto por id.

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) return NextResponse.json({ ok: false, error: 'missing env' }, { status: 500 })
  const body = await req.json().catch(() => null)
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown) => typeof k === 'string' && REPORT_KEY_RE.test(k)) : []
  if (keys.length === 0) return NextResponse.json({ ok: true, muted: 0 })
  const db = createClient(url, service)
  const porTabela = new Map<string, string[]>()
  for (const k of keys) {
    const [kind, id] = k.split(':') as [ReportKind, string]
    const t = REPORT_TABLES[kind]
    porTabela.set(t, [...(porTabela.get(t) || []), id])
  }
  let muted = 0
  const errors: string[] = []
  const kindOf = Object.fromEntries(Object.entries(REPORT_TABLES).map(([k, t]) => [t, k])) as Record<string, string>
  // `claimed` = as chaves que ESTA chamada datou. A tela que vai mandar um balão só manda o das linhas que vieram
  // aqui (lib/reportMark.ts): a que não veio já tinha data — outro robô ou outra tela já tratou.
  const claimed: string[] = []
  for (const [t, ids] of porTabela) {
    const r = await claimReport(db, t as (typeof REPORT_TABLES)[ReportKind], ids)
    muted += r.claimed.size
    for (const id of r.claimed) claimed.push(`${kindOf[t]}:${id}`)
    if (r.error) errors.push(r.error)
  }
  // Linha que já tinha data não conta em `muted` — continua sendo sucesso (idempotente por natureza).
  if (errors.length) return NextResponse.json({ ok: false, muted, claimed, error: errors.join(' · ') }, { status: 500 })
  return NextResponse.json({ ok: true, muted, claimed })
}
