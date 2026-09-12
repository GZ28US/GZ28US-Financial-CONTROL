// ── O MAPA DOS CINCO RENAMES (onda 2 do pacote, 11/set/2026) ─────────────────
//
// O banco do US renomeou cinco tabelas:
//     invoice_payments → invoice_incomes
//     invoice_parts    → invoice_items
//     goods            → assets
//     good_expenses    → assets_expenses
//     expenses         → staff_expenses
//
// A migration reescreve o nome ONDE ELE VIVE COMO DADO em quatro colunas:
// bank_transactions.matched_table, bank_match_log.matched_table,
// mail_processed.ref_table e auto_book_mail.booked_table. Quem lê dessas quatro
// NÃO precisa deste mapa.
//
// DOIS LUGARES FICARAM COM O NOME VELHO GRAVADO, e são exatamente os dois que o
// código usa para montar um DESFAZER — `db.from(<valor lido do banco>)`:
//
//   1. `data_fixes.table_name` é LOG HISTÓRICO: é o registro do que foi
//      consertado, com o nome que a tabela tinha na hora. Reescrever o log seria
//      apagar história. Medido em 11/set/2026 pela REST: 91 linhas com nome velho
//      (goods 49, expenses 29, invoice_parts 12, invoice_payments 1).
//   2. `bank_transactions.backfill` é JSON `[{t,id,f,v,o}]` com o nome da tabela
//      em `t`, e o DESFAZER faz `db.from(b.t).update(...)`. A migration não toca
//      nesse JSON. Medido em 11/set/2026: 74 entradas em 62 linhas, das quais 11
//      com nome velho (goods 8, invoice_payments 3). Sem este mapa, essas 11
//      param de reverter quando a onda 5 derrubar as views-ponte — e o DESFAZER
//      inteiro passa a estourar, calado para quem clicou.
//
// A tradução é SÓ NA LEITURA e é idempotente: nome novo entra e sai igual. O que
// não está no mapa passa intacto — inclusive os valores com prefixo `US.` / `BR.`
// (`US.goods`, `BR.invoice_expenses`), que são OUTRA convenção: marcam a zona, não
// a tabela, e nunca foram destino de `db.from`.
export const TABELAS_RENOMEADAS: Readonly<Record<string, string>> = {
  invoice_payments: 'invoice_incomes',
  invoice_parts: 'invoice_items',
  goods: 'assets',
  good_expenses: 'assets_expenses',
  expenses: 'staff_expenses',
}

/** O nome de HOJE de uma tabela cujo nome veio gravado no banco. Casamento EXATO
 *  (nunca por pedaço: 'expenses' é pedaço de invoice_expenses, good_expenses,
 *  fixed_cost_expenses e expense_reports_sent). Não achou: devolve como veio. */
export function tabelaAtual(nome: string | null | undefined): string {
  const n = String(nome ?? '')
  return TABELAS_RENOMEADAS[n] ?? n
}

/** Os nomes que aquela tabela JÁ TEVE, do mais novo pro mais velho — para FILTRAR
 *  um log histórico por nome de tabela (`data_fixes.table_name`), onde linhas antigas
 *  guardam a grafia da época. Filtrar só pelo nome de hoje passa reto por elas: em
 *  11/set/2026 eram 21 linhas de check_key 'paid-from' (goods 11, expenses 10) que o
 *  DESFAZER do casamento precisa achar para devolver o PAID FROM a vazio. */
export function nomesHistoricos(atual: string): string[] {
  const velhos = Object.entries(TABELAS_RENOMEADAS).filter(([, novo]) => novo === atual).map(([velho]) => velho)
  return [atual, ...velhos]
}
