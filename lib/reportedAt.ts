// REPORTED OU NÃO, NA PRÓPRIA LINHA (Márcio, 16/set/2026): «o app está mandando report de expense que já
// havia mandado, crie uma coluna no banco pras expenses e incomes as marcando como REPORTED ou NÃO, pra nunca
// mais acontecer isso. O App não reporta mais coisa que já reportou.»
//
// A coluna é `reported_at` (timestamptz) nas 8 tabelas de dinheiro — MIGRATION_reported_at.sql. NULL = NÃO
// reportada; com data = REPORTED (o balão saiu, ou a linha foi tratada em silêncio de propósito: retroativo,
// dinheiro já anunciado pelo banco, recusa no diálogo do editor). Nenhum robô nem tela reporta linha com data.
// Até 16/set o «já reportei» morava FORA da linha (stream_mail_moves 'ern:<tipo>:<id>' e expense_reports_sent),
// e isso repetia balão: linha recriada ganhava id novo, o cron de staff só olhava o próprio dia.
//
// A REGRA DE ESCRITA É UMA SÓ: quem vai reportar RESERVA a linha antes de mandar — o update só pega linha ainda
// sem data (`reported_at is null`) e devolve quais pegou. Dois robôs olhando a mesma linha ao mesmo tempo (a rede
// de 5 minutos e o cron das 11h rodam juntos às 15:00 UTC) nunca mandam os dois: só manda quem reservou.
// Módulo PURO (sem 'use client', sem import de servidor): a rota, os robôs e as telas usam o mesmo mapa.

export const REPORT_TABLES = {
  ie: 'invoice_expenses',
  ip: 'invoice_incomes',
  se: 'staff_expenses',
  as: 'assets',
  ae: 'assets_expenses',
  in: 'inputs',
  iv: 'inventory',
  fc: 'fixed_cost_expenses',
} as const
export type ReportKind = keyof typeof REPORT_TABLES
export type ReportTable = (typeof REPORT_TABLES)[ReportKind]
export const REPORT_KEY_RE = /^(ie|ip|se|as|ae|in|iv|fc):[0-9a-f-]{36}$/

/** A chave curta de uma linha ('ie:<uuid>') — o formato que a rota /api/report-net/mute aceita. */
export const reportKey = (kind: ReportKind, id: string) => `${kind}:${id}`

/** Já saiu? Qualquer linha lida com `select('*')` traz a coluna. */
export const isReported = (row: { reported_at?: string | null } | null | undefined) => !!row?.reported_at

type Db = { from: (table: string) => any }   // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Reserva as linhas para report: grava reported_at = agora SÓ nas que ainda estão sem data e devolve os ids que
 * esta chamada pegou. Quem não recebe o id de volta NÃO manda o balão — outro já mandou ou está mandando.
 * A reserva vale mesmo se o envio falhar depois (a mesma escolha da rede desde 04/set: a data registra que a linha
 * FOI TRATADA; sem isso o balão voltaria a cada 5 minutos).
 */
export async function claimReport(db: Db, table: ReportTable, ids: (string | null | undefined)[]): Promise<{ claimed: Set<string>; error: string | null }> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  const claimed = new Set<string>()
  const errors: string[] = []
  const now = new Date().toISOString()
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await db.from(table).update({ reported_at: now }).in('id', list.slice(i, i + 200)).is('reported_at', null).select('id')
    if (error) { errors.push(`${table}: ${error.message}`); continue }
    for (const r of (data || []) as { id: string }[]) claimed.add(r.id)
  }
  return { claimed, error: errors.length ? errors.join(' · ') : null }
}
