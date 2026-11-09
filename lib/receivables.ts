// A RECEBER DE CLIENTE, CALCULADO (09/11/2026 — pedido A do AutoBook US, regra SAGRADA do Márcio):
// «no current flow tem que aparecer tudo o que temos a receber de vencido e sem data, sagrado, tudo… exceto as parcelas
// datadas, que vão aparecer nos future flow».
//
// Antes a HOME e o FUTURE somavam as LINHAS de income em aberto que alguém tinha digitado (o «Pending balance» manual).
// Quando o total da invoice mudava (imposto pela lei, desconto, item novo) e ninguém mexia no income, a dívida sumia ou
// dobrava: WhiteSnake US.024.2 mostrava 5.675,96 de 9.901,80 faturados; Marcelo US.021.1 tinha 1.574,51 em lugar nenhum.
//
// Agora, por invoice de CLIENTE: A RECEBER = GRAND − Σ incomes PAGAS (paid_at).
//   · income em aberto DATADA no futuro  → FUTURE Flow (parcela)
//   · income em aberto DATADA até hoje   → CURRENT, DELAYED
//   · income em aberto de MARCO (chegada/conclusão) → CURRENT, no grupo do marco
//   · o que SOBRA (a receber − datadas − marcos)    → CURRENT, UNDATED, UMA linha por invoice
// As linhas de income sem data deixam de ser a fonte: viram só a explicação (hover).
// Σ incomes listadas ≠ GRAND vira aviso — alguém precisa acertar a invoice.
// Isomórfico (sem import de servidor): HOME e FUTURE usam a MESMA conta.

// Carro da CASA não deve a ninguém: OWN/TOOL são nossos, PART_OUT vira estoque (lib/financials isOurRide).
export const HOUSE_SCOPES = new Set(['OWN', 'TOOL', 'PART_OUT'])
// 006.N / 085.N = livros históricos e compras da casa, não cobrança de cliente.
const NOT_CLIENT_CODE = /^(006|085)\./

export function isClientInvoice(code: string | null | undefined, scope: string | null | undefined): boolean {
  return !HOUSE_SCOPES.has(String(scope || '')) && !NOT_CLIENT_CODE.test(String(code || ''))
}

// O GRAND da tela da invoice (lib/money docMoneyFor: imposto pela lei, desconto, contrato assinado). Shopping invoice
// (sem carro) que só tem DESPESA e nenhum item vendido: o cliente deve a despesa × (1 + import_margin) — é o que a
// fatura de compra cobra (031.3, 031.4), e o docMoneyFor devolve 0 porque não há item.
export function invoiceGrand(moneyGrand: number, opts: { shopping: boolean; expenseSum: number; importMargin: number | null | undefined }): number {
  if (moneyGrand > 0.005 || !opts.shopping) return moneyGrand
  return Math.round(opts.expenseSum * (1 + (Number(opts.importMargin) || 0) / 100) * 100) / 100
}

export type IncomeIn = { id: string; amount: number | string | null; paid_at: string | null; payment_date: string | null; description?: string | null; source?: string | null; date_label?: string | null }
export type Receivable = {
  grand: number; paid: number; receivable: number; listed: number; mismatch: number
  future: IncomeIn[]; delayed: IncomeIn[]; milestone: IncomeIn[]; undated: number; undatedRows: IncomeIn[]
}

const ok = (d: string | null | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(String(d).slice(0, 10))
const n = (v: unknown) => parseFloat(String(v ?? '')) || 0

export function receivableOf(grand: number, incomes: IncomeIn[], today: string, milestoneOf: (label: string | null | undefined) => string | undefined): Receivable {
  const paid = incomes.filter(p => !!p.paid_at).reduce((x, p) => x + n(p.amount), 0)
  const listed = incomes.reduce((x, p) => x + n(p.amount), 0)
  const receivable = Math.max(0, Math.round((grand - paid) * 100) / 100)
  const open = incomes.filter(p => !p.paid_at && Math.abs(n(p.amount)) > 0.005)
  const milestone = open.filter(p => !!milestoneOf(p.date_label))
  const dated = open.filter(p => !milestoneOf(p.date_label) && ok(p.payment_date))
  const future = dated.filter(p => String(p.payment_date).slice(0, 10) > today)
  const delayed = dated.filter(p => String(p.payment_date).slice(0, 10) <= today)
  const undatedRows = open.filter(p => !milestoneOf(p.date_label) && !ok(p.payment_date))
  const spoken = [...dated, ...milestone].reduce((x, p) => x + n(p.amount), 0)
  const undated = Math.max(0, Math.round((receivable - spoken) * 100) / 100)
  return { grand, paid, receivable, listed, mismatch: Math.round((listed - grand) * 100) / 100, future, delayed, milestone, undated, undatedRows }
}
