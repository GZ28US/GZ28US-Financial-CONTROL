// ── O MAPA DOS CINCO RENAMES (onda 2 do pacote, 11/set/2026) ─────────────────
//
// O banco do US renomeou cinco tabelas:
//     invoice_payments → invoice_incomes
//     invoice_parts    → invoice_items
//     goods            → assets
//     good_expenses    → assets_expenses
//     expenses         → staff_expenses
//
// A migration reescreve o nome ONDE ELE VIVE COMO DADO em quatro colunas DE TEXTO:
// bank_transactions.matched_table, bank_match_log.matched_table,
// mail_processed.ref_table e auto_book_mail.booked_table. Quem lê dessas quatro
// NÃO precisa deste mapa. **Ela não entra em coluna JSON nenhuma** — e é aí que
// mora o resto desta lista.
//
// QUATRO LUGARES FICAM COM O NOME VELHO GRAVADO, e em todos o código faz
// `db.from(<valor lido do banco>)`. Os quatro foram MEDIDOS pela REST na noite de
// 11/set/2026 (entre 23h50 e 00h05 de Orlando), com a migration da onda 2 ainda por
// rodar — conferido no catálogo: as cinco tabelas ainda se chamavam pelo nome velho, e
// as quatro colunas de texto ainda tinham 47 + 48 + 6 + 2 apontamentos velhos para ela
// reescrever. Estes são, portanto, os números que a migration VAI DEIXAR para trás,
// porque ela não passa em coluna JSON nenhuma:
//
//   1. `data_fixes.table_name` é LOG HISTÓRICO: é o registro do que foi
//      consertado, com o nome que a tabela tinha na hora. Reescrever o log seria
//      apagar história. Medido: 91 linhas com nome velho (goods 49, expenses 29,
//      invoice_parts 12, invoice_payments 1).
//   2. `bank_transactions.backfill` é JSON `[{t,id,f,v,o}]` com o nome da tabela
//      em `t`, e o DESFAZER faz `db.from(b.t).update(...)`. Medido: 74 entradas em
//      62 linhas, das quais 11 com nome velho (goods 8, invoice_payments 3). Sem
//      este mapa, essas 11 param de reverter quando a onda 5 derrubar as
//      views-ponte — e o DESFAZER inteiro passa a estourar, calado para quem clicou.
//   3. `bank_match_log.members` é JSON `[{table,id}]`, e é a lista de quais linhas
//      formaram o total de um PEDIDO casado. O RESTAURAR DIÁRIO devolve esses
//      membros ao writeMatch, que faz `db.from(m.table)` para repor a data de
//      pagamento de cada um. Medido: 1.253 registros, 28 com `members`, 2 deles com
//      'goods' dentro (8 entradas) — e os 2 são o ÚLTIMO registro da sua linha do
//      banco, que é exatamente o que o RESTAURAR reencena.
//   4. `auto_book_mail.cands` é JSON `[{table,ref,…}]`: os destinos MEDIDOS que o
//      robô do e-mail oferece na pergunta. A pessoa escolhe um, ele volta como
//      `target` no POST e `lancar` faz `db.from(target.table).insert(...)`. Medido:
//      6 das 20 linhas da fila com 'expenses' dentro (9 entradas). Sem o mapa, a
//      peneira de destino do `lancar` recusa a própria sugestão do robô («tabela
//      "expenses" nao e destino de compra») e a compra não entra.
//
// VARREDURA COMPLETA (mesma noite): as 30 colunas JSON/array das 71 tabelas e views
// do catálogo do US, andadas valor por valor (só STRING-VALOR, nunca CHAVE, casada
// contra o catálogo). Só essas TRÊS guardam nome de tabela lá dentro — backfill,
// members e cands. `supplier_orders.payments` (70 linhas com valor), os seis JSON de
// `packs`, `parts_database.kit_items`, `financeiro_inbox.target/parsed`,
// `auto_book_mail.extracted/answer`, `auto_book_mail_rules.target` (zero regra
// aprendida hoje), `bank_transactions.raw` (1.885 linhas) e
// `bank_transactions.doubt_answered` (0 linhas): nenhum. O `"expenses"` de
// `quote_backups.snapshot` (11 linhas) é CHAVE do próprio snapshot, não nome de
// tabela — e a chave `expenses` do JSON dos packs é a mesma história.
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
