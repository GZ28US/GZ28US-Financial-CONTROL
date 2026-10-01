// ÚLTIMA ATIVIDADE (Márcio, 01/10/2026 — «last activity 1st»): as listas de clientes, rides e invoices ordenam
// pela mexida mais recente — o próprio registro, os rides e as invoices dele, e cada renda, despesa, item, serviço
// e nota dessas invoices, criado OU alterado. Antes a lista de clientes só via cliente/ride/invoice: os US$ 11.157,09
// que entraram na 006.36 não subiam o US.006. Compara em milissegundos, nunca texto.
import { supabase } from '@/lib/supabase'

// As linhas que moram dentro de uma invoice (US). No BR: invoice_payments e invoice_parts.
export const TABELAS_DA_INVOICE = ['invoice_incomes', 'invoice_expenses', 'invoice_items', 'invoice_services', 'invoice_notes'] as const

const ms = (x: string | null | undefined) => { if (!x) return NaN; const t = new Date(x).getTime(); return isNaN(t) ? NaN : t }

// O carimbo mais recente da lista (ISO como veio do banco), '' se nenhum vale.
export function maisRecente(...xs: (string | null | undefined)[]): string {
  let melhor = '', t0 = -Infinity
  for (const x of xs) { const t = ms(x); if (!isNaN(t) && t > t0) { t0 = t; melhor = String(x) } }
  return melhor
}

// Em milissegundos, para o sort (0 quando não há carimbo: vai para o fim).
export const msAtividade = (x: string | null | undefined) => { const t = ms(x); return isNaN(t) ? 0 : t }

// A mexida mais recente DENTRO das invoices dadas: uma consulta por tabela, só a linha mais nova (updated_at nasce
// now() e só cresce) — não depende de baixar todas as linhas, então o teto de 1.000 linhas do Supabase não come a
// atividade de um cliente grande. Ids em lotes, para a URL não estourar.
export async function atividadeDasInvoices(invoiceIds: string[]): Promise<string> {
  const ids = [...new Set(invoiceIds.filter(Boolean))]
  if (!ids.length) return ''
  const lotes: string[][] = []
  for (let i = 0; i < ids.length; i += 150) lotes.push(ids.slice(i, i + 150))
  const achados = await Promise.all(lotes.flatMap(lote => TABELAS_DA_INVOICE.map(async tabela => {
    const { data } = await supabase.from(tabela).select('created_at, updated_at').in('invoice_id', lote)
      .order('updated_at', { ascending: false, nullsFirst: false }).limit(1)
    const r = (data || [])[0] as { created_at?: string | null; updated_at?: string | null } | undefined
    return r ? maisRecente(r.created_at, r.updated_at) : ''
  })))
  return maisRecente(...achados)
}

// Hora de Orlando (lei do relógio: o banco devolve UTC; colar cru adianta 4h e vira o dia à noite).
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
export const rotuloAtividade = (iso: string) => (iso ? `Last activity: ${fmt.format(new Date(iso))} (Orlando)` : '')
