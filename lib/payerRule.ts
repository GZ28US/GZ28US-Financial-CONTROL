// ── QUEM PAGA E QUEM RECEBE, TABELA POR TABELA (Márcio, 11/set/2026) ─────────
// Módulo PURO (sem 'use client', sem import): a tela (components/PaymentFields) e os
// robôs do servidor leem a MESMA régua.
//
// A régua dele: tabela que é movimentação de dinheiro grava os dois campos, no mínimo
// com GZ28US escondido («isso é movimentação de $, então tem que ter GZ28US escondido
// pra paid to e paid from»). ESCOLHA só existe em cinco tabelas («nenhuma outra do app»):
//   · nas despesas (invoice_expenses, assets, assets_expenses, staff_expenses) o PAID
//     FROM escolhe GZ28US ou GZ28BR, e o PAID TO fica «SEMPRE como GZ28US, pra todas,
//     só não mostre na tela»;
//   · nas incomes é ao contrário: o PAID TO escolhe e o PAID FROM não existe (a coluna
//     caiu na onda 9). 'none' = nunca vai no payload.
// Em inputs, inventory e fixed_cost_expenses não há escolha: os dois são GZ28US, escondidos.
// EXCEÇÃO (Márcio, 16/set/2026, pela sessão Auto Book): o custo fixo de MARKETING abre o PAID FROM GZ28BR — «o que for de
// Vegas, ponha em Marketing, SEMA 2025», e passagem/estadia do SEMA 2025 foi paga pelo BR. A régua desse fornecedor é
// fixed_cost_marketing (mesma tabela do banco, fixed_cost_expenses; quem escolhe é fixedCostPayerTable pelo cost_type).
// A linha GZ28BR atravessa para uma 085.N por fornecedor de marketing (lib/crossing.server.ts, chave US:fixed:<id>).
// ESTOQUE DOADO não é compra: peça doada não tem pagador nenhum (inventory_donated).
// SEM CHECK no banco, de propósito: «qualquer empresa pode pagar pra qualquer empresa, o
// importante é o Flow reportar» — a regra mora aqui.
// invoice_items não aparece: «não existe movimentação financeira no ITEMS».
export type PayerMode = 'choice' | 'house' | 'none'
export const HOUSE_PAYER = 'GZ28US'
export const PAYER_RULE = {
  invoice_expenses: { paidFrom: 'choice', paidTo: 'house' },
  invoice_incomes: { paidFrom: 'none', paidTo: 'choice' },
  assets: { paidFrom: 'choice', paidTo: 'house' },
  assets_expenses: { paidFrom: 'choice', paidTo: 'house' },
  staff_expenses: { paidFrom: 'choice', paidTo: 'house' },
  inputs: { paidFrom: 'house', paidTo: 'house' },
  inventory: { paidFrom: 'house', paidTo: 'house' },
  inventory_donated: { paidFrom: 'none', paidTo: 'none' },
  fixed_cost_expenses: { paidFrom: 'house', paidTo: 'house' },
  fixed_cost_marketing: { paidFrom: 'choice', paidTo: 'house' },
} as const satisfies Record<string, { paidFrom: PayerMode; paidTo: PayerMode }>
export type PayerTable = keyof typeof PAYER_RULE

// A linha de estoque escolhe a régua pela ORIGEM: doada não tem pagador.
export const stockPayerTable = (sourceType: string | null | undefined): PayerTable =>
  sourceType === 'DONATED' ? 'inventory_donated' : 'inventory'
// A parcela de custo fixo escolhe a régua pelo TIPO do fornecedor: só MARKETING tem PAID FROM à mostra.
// Não é nome de tabela do banco — quem grava continua escrevendo em fixed_cost_expenses.
export const fixedCostPayerTable = (costType: string | null | undefined): PayerTable =>
  String(costType || '').toUpperCase() === 'MARKETING' ? 'fixed_cost_marketing' : 'fixed_cost_expenses'

const blank = (v: unknown) => !String(v ?? '').trim()
// O whoPaid (auditPayer/closeScore) só lê do SOURCE os valores GZ28US/GZ28BR/REGIONS; texto de cartão («Visa ••••7666») não é pagador.
const isOtherPayerSource = (v: unknown) => String(v ?? '').trim().toUpperCase() === 'GZ28BR'

// ESCONDIDO GRAVA — na linha nova, e na hora em que o pagamento nasce; nunca por cima.
// `before` = a linha como estava ANTES deste salvamento (null = linha nova).
//   · linha NOVA → GZ28US, sempre, paga ou não;
//   · linha que já existe e cujo pagamento é registrado NESTE salvamento (estava sem
//     payment_date e sai com) → GZ28US, SÓ se o campo estiver vazio: um valor gravado
//     (GZ28BR inclusive) nunca é trocado por um campo que a tela nem mostra;
//   · fora isso → a chave nem vai no payload, e o banco fica com o que tem. Reescrever a
//     cada edição apagaria a diferença entre «é GZ28US» e «ninguém olhou» (o DFC já lê
//     vazio como GZ28US). Linha PAGA com PAID FROM vazio em SUPPLIES, ESTOQUE ou CUSTO
//     FIXO tem caminho próprio: o card «PAID FROM de SUPPLIES, ESTOQUE e CUSTO FIXO» do
//     Data Checker, com trilha.
// Escolha nunca sai daqui: quem grava escolha é a tela que a mostra.
export function hiddenPayers(
  table: PayerTable,
  before: { paid: boolean; paid_from?: string | null; paid_to?: string | null; source?: string | null } | null,
  paidNow: boolean,
): { paid_from?: string; paid_to?: string } {
  const rule: { paidFrom: PayerMode; paidTo: PayerMode } = PAYER_RULE[table]
  const out: { paid_from?: string; paid_to?: string } = {}
  const born = (stored: unknown) => before === null || (!before.paid && paidNow && blank(stored))
  // SOURCE legado conta como resposta (revisão 14/set): whoPaid lê o source quando paid_from está vazio, então
  // um source GZ28BR é pagador gravado — o escondido não o vira GZ28US por baixo.
  const legacyOther = !!before && isOtherPayerSource(before.source)
  if (rule.paidFrom === 'house' && !legacyOther && born(before?.paid_from)) out.paid_from = HOUSE_PAYER
  if (rule.paidTo === 'house' && born(before?.paid_to)) out.paid_to = HOUSE_PAYER
  return out
}

// Para quem grava o pagamento SEM ter a linha inteira na mão (robô do servidor, diálogo
// que muda o grupo inteiro): preenche no banco os campos escondidos que estão VAZIOS
// nas linhas dadas — a condição mora na própria escrita, então um valor gravado nunca
// é sobrescrito, nem se a tela estiver velha. Chame só onde o pagamento acabou de nascer
// (ou numa linha nova). Estoque DOADO fica de fora pela origem. Devolve o erro, se houver
// — o pagamento já foi gravado; o escondido que falhar é aviso, não desfaz nada.
type Db = { from: (table: string) => any }   // eslint-disable-line @typescript-eslint/no-explicit-any
export async function fillHiddenPayers(db: Db, table: Exclude<PayerTable, 'inventory_donated' | 'invoice_incomes' | 'fixed_cost_marketing'>, ids: (string | null | undefined)[]): Promise<string | null> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  if (!list.length) return null
  const rule: { paidFrom: PayerMode; paidTo: PayerMode } = PAYER_RULE[table]
  const cols = [rule.paidFrom === 'house' ? 'paid_from' : null, rule.paidTo === 'house' ? 'paid_to' : null].filter((c): c is string => !!c)
  const errors: string[] = []
  // SOURCE legado conta como pagador gravado (revisão 14/set): linha com source GZ28BR não recebe PAID FROM
  // escondido — whoPaid a lê pelo source e o saldo US vs BR mudaria calado.
  let fromIds = list
  if (cols.includes('paid_from')) {
    const keep: string[] = []
    for (let i = 0; i < list.length; i += 200) {
      const { data, error } = await db.from(table).select('id, source').in('id', list.slice(i, i + 200))
      if (error) { errors.push(table + '.source: ' + error.message); continue }
      for (const r of (data || []) as { id: string; source: string | null }[]) if (!isOtherPayerSource(r.source)) keep.push(r.id)
    }
    fromIds = keep
  }
  for (const col of cols) {
    const ids = col === 'paid_from' ? fromIds : list
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200)
      // Vazio é NULL ou '' — duas escritas, cada uma condicionada no banco. O corte do
      // doado é o único .or() da consulta (source_type é anulável: nulo não é doado).
      for (const empty of [null, ''] as const) {
        let q = db.from(table).update({ [col]: HOUSE_PAYER }).in('id', slice)
        q = empty === null ? q.is(col, null) : q.eq(col, '')
        if (table === 'inventory') q = q.or('source_type.is.null,source_type.neq.DONATED')
        const { error } = await q
        if (error) errors.push(`${table}.${col}: ${error.message}`)
      }
    }
  }
  return errors.length ? errors.join(' · ') : null
}
