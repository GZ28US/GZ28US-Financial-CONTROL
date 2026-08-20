'use client'

// FINANCIAL STATEMENTS — carregador de dados compartilhado (DRE / DFC / Balanço).
// Uma busca só, client-side, paginada (invoice_expenses passa de 1.000 linhas e o
// PostgREST corta em 1.000 por request). As três telas leem o MESMO dataset para
// os números baterem entre si — a regra de cada linha mora aqui, não nas telas.
//
// Fonte de custo é SEMPRE invoice_expenses — invoice_parts.base_cost é campo de
// exibição (espelha o preço de venda nos car deals) e não entra em conta nenhuma.
import { supabase } from '@/lib/supabase'

const num = (v: unknown) => parseFloat(String(v)) || 0
const okDate = (d: string | null | undefined) => !!d && /^\d{4}-\d{2}-\d{2}/.test(d)

// Uma linha de invoice_expenses: preço × qtd + tax + extra (mesma conta do app inteiro).
export const expLine = (e: { price?: unknown; quantity?: unknown; tax?: unknown; extra?: unknown }) =>
  num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)
export const qtyLine = (r: { unit_price?: unknown; quantity?: unknown }) =>
  num(r.unit_price) * (num(r.quantity) || 1)

// Piso de capitalização (D8, provisório até o Márcio bater o martelo):
// GOODS >= piso é imobilizado; abaixo é ferramental/consumo do ano.
export const CAP_FLOOR = 2500

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FinData = {
  invoices: any[]           // só reais (is_quote = false)
  payments: any[]
  invExpenses: any[]
  invParts: any[]
  invServices: any[]
  expenses: any[]           // staff / variáveis (payroll)
  fixedExpenses: any[]      // fixed_cost_expenses
  fixedSuppliers: Map<string, any>
  goods: any[]
  goodExpenses: any[]
  inputs: any[]
  inventory: any[]
  rides: Map<string, any>
  clients: Map<string, any>
  invoiceById: Map<string, any>
  dataFixes: any[] | null       // trilha do DATA CHECK (null até MIGRATION_data_fixes.sql)
  // Fase 2 — os três livros (null até MIGRATION_financial_ledgers.sql rodar)
  capitalEvents: any[] | null
  financing: any[] | null
  financingEvents: any[] | null
  cashBalances: any[] | null
  ledgersReady: boolean
}

// Igual ao fetchAll, mas devolve null se a tabela ainda não existe (os livros
// da Fase 2 só nascem quando o Márcio rodar MIGRATION_financial_ledgers.sql).
async function fetchOpt(table: string, select: string): Promise<any[] | null> {
  try { return await fetchAll(table, select) } catch { return null }
}

async function fetchAll(table: string, select: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    // ORDER BY estável é obrigatório: sem ele o Postgres pode reordenar entre
    // as duas requests e uma linha na fronteira dos 1.000 some ou duplica.
    const { data, error } = await supabase.from(table).select(select).order('id').range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

export async function loadFinancials(): Promise<FinData> {
  const [invoices, payments, invExpenses, invParts, invServices, expenses,
    fixedExpenses, fixedSuppliers, goods, goodExpenses, inputs, inventory, rides, clients] = await Promise.all([
    fetchAll('invoices', 'id, invoice_code, ride_id, client_id, is_quote, live_status, origin, florida_taxes, global_discount, fl_tax_expense_date, entry_date, hiring_date, conclusion_date, delivery_date, mileage'),
    fetchAll('invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, source, paid_to, description'),
    fetchAll('invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, source'),
    fetchAll('invoice_parts', 'id, invoice_id, description, unit_price, quantity'),
    fetchAll('invoice_services', 'id, invoice_id, description, price'),
    fetchAll('expenses', 'id, type, description, amount, expense_date, payment_date, origin, paid_from, paid_to, source, season_id'),
    fetchAll('fixed_cost_expenses', 'id, supplier_id, description, amount, expense_date, payment_date, paid_from, paid_to, source'),
    fetchAll('fixed_cost_suppliers', 'id, company, description, cost_type'),
    fetchAll('goods', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source'),
    fetchAll('good_expenses', 'id, good_id, description, amount, expense_date, payment_date, paid_from, paid_to, source'),
    fetchAll('inputs', 'id, description, category, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source'),
    fetchAll('inventory', 'id, description, source_type, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source'),
    fetchAll('rides', 'id, project_code, project_name, model, version, title_scope, is_quote, origin, client_id, is_brand_new'),
    fetchAll('clients', 'id, name, country'),
  ])
  const [capitalEvents, financingRows, financingEvents, cashBalances, dataFixes] = await Promise.all([
    fetchOpt('capital_events', '*'), fetchOpt('financing', '*'),
    fetchOpt('financing_events', '*'), fetchOpt('cash_balances', '*'),
    fetchOpt('data_fixes', '*'),
  ])
  const real = invoices.filter((i: any) => !i.is_quote)
  // Filhas de QUOTE ficam fora de TUDO: linha de despesa de orçamento (herdada
  // dos packs) não é caixa, não é contas a pagar, não é custo — era $206k de
  // fornecedores-fantasma no Balanço antes deste filtro.
  const realIds = new Set(real.map((i: any) => i.id))
  const byReal = (r: any) => realIds.has(r.invoice_id)
  return {
    invoices: real,
    payments: payments.filter(byReal), invExpenses: invExpenses.filter(byReal),
    invParts: invParts.filter(byReal), invServices: invServices.filter(byReal),
    expenses, fixedExpenses,
    fixedSuppliers: new Map(fixedSuppliers.map((s: any) => [s.id, s])),
    goods, goodExpenses, inputs, inventory,
    rides: new Map(rides.map((r: any) => [r.id, r])),
    clients: new Map(clients.map((c: any) => [c.id, c])),
    invoiceById: new Map(real.map((i: any) => [i.id, i])),
    dataFixes,
    capitalEvents, financing: financingRows, financingEvents, cashBalances,
    ledgersReady: !!(capitalEvents && financingRows && financingEvents && cashBalances),
  }
}

// ── Totais por invoice (mesmas fórmulas da tela de invoices) ────────────────
export function invoiceTotals(d: FinData, inv: any) {
  const parts = d.invParts.filter(p => p.invoice_id === inv.id).reduce((s, p) => s + num(p.unit_price) * num(p.quantity), 0)
  const services = d.invServices.filter(s2 => s2.invoice_id === inv.id).reduce((s, x) => s + num(x.price), 0)
  const flTax = parts * (num(inv.florida_taxes) / 100)
  const pAndS = parts + flTax + services
  const discount = pAndS * (num(inv.global_discount) / 100)
  const grand = pAndS - discount
  const cost = d.invExpenses.filter(e => e.invoice_id === inv.id).reduce((s, e) => s + expLine(e), 0)
  const received = d.payments.filter(p => p.invoice_id === inv.id && p.paid_at).reduce((s, p) => s + num(p.amount), 0)
  return { parts, services, flTax, discount, grand, cost, received }
}

// Dono do carro (CAR DESTINY): OWN/TOOL são NOSSOS — o custo deles é frota/
// imobilizado, nunca WIP de projeto. O resto é carro de cliente.
export const rideScope = (d: FinData, inv: any): string | null =>
  (inv?.ride_id && d.rides.get(inv.ride_id)?.title_scope) || null
export const isOurRide = (d: FinData, inv: any) => {
  const s = rideScope(d, inv); return s === 'OWN' || s === 'TOOL'
}

// Rótulo e link de uma invoice (padrão do gz-flow: rides/<id>/invoices/<id>).
export function invoiceMeta(d: FinData, invoiceId: string) {
  const inv = d.invoiceById.get(invoiceId)
  const ride = inv?.ride_id ? d.rides.get(inv.ride_id) : null
  const car = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
  const ownerSeg = inv?.ride_id ? 'rides/' + inv.ride_id : 'clients/' + inv?.client_id
  return { code: inv?.invoice_code || '—', car, href: inv ? '/' + ownerSeg + '/invoices/' + inv.id : '/invoices' }
}

// ── DFC: todo movimento de caixa vira um evento datado ──────────────────────
// section OPER/INVEST/FIN + line (chave da linha na tabela). amount>0 entra,
// amount<0 sai. Sem payment_date ⇒ ainda não é caixa ⇒ fica de fora (vai pro
// contas-a-pagar do Balanço).
export type CashEvent = {
  date: string; section: 'OPER' | 'INVEST' | 'FIN'; line: string
  amount: number; code: string; label: string; href: string
}

export function buildCashEvents(d: FinData): CashEvent[] {
  const ev: CashEvent[] = []
  const push = (date: string | null | undefined, section: CashEvent['section'], line: string,
    amount: number, code: string, label: string, href: string) => {
    if (!okDate(date) || !amount) return
    ev.push({ date: String(date).slice(0, 10), section, line, amount, code, label, href })
  }

  // Recebimentos — só o que TEM paid_at (agendado ainda não é caixa). Recebido
  // pela GZ28BR (2025) é linha própria: é receita nossa que virou saldo lá.
  for (const p of d.payments) {
    if (!p.paid_at) continue
    const m = invoiceMeta(d, p.invoice_id)
    // Data do caixa é o RECEBIMENTO (paid_at); payment_date é só o agendado.
    const cashDate = String(p.paid_at).slice(0, 10)
    push(okDate(cashDate) ? cashDate : p.payment_date, 'OPER',
      p.paid_to === 'GZ28BR' ? 'RECEIPTS_BR' : 'RECEIPTS',
      num(p.amount), m.code, m.car || p.description || p.source || '', m.href)
  }
  // Fornecedores de projeto (inclui compra de carro — separação é papo do DRE/D3).
  for (const e of d.invExpenses) {
    const m = invoiceMeta(d, e.invoice_id)
    push(e.payment_date, 'OPER', 'JOB_COST', -expLine(e), m.code,
      [m.car, e.item].filter(Boolean).join(' · '), m.href)
  }
  // Folha e retiradas — origin separa a empresa do pessoal do Márcio.
  for (const x of d.expenses) {
    push(x.payment_date, x.origin === 'PERSONAL' ? 'FIN' : 'OPER',
      x.origin === 'PERSONAL' ? 'DRAW' : 'PAYROLL',
      -num(x.amount), 'STAFF', x.description || x.type || '', '/staff')
  }
  // Custos fixos por família (cost_type do fornecedor).
  for (const f of d.fixedExpenses) {
    const sup = d.fixedSuppliers.get(f.supplier_id)
    const ct = sup?.cost_type || 'UNCLASSIFIED'
    const line = ct === 'APP' ? 'APPS' : ct === 'MARKETING' ? 'MARKETING' : ct === 'FIXED' ? 'FIXED' : 'MISC'
    const href = ct === 'APP' ? '/costs/apps/' + f.supplier_id : (ct === 'MARKETING' || ct === 'ASSET') ? '/costs/assets/' + f.supplier_id : '/costs/fixed/' + f.supplier_id
    push(f.payment_date, 'OPER', line, -num(f.amount), ct,
      [sup?.company, f.description].filter(Boolean).join(' · '), f.supplier_id ? href : '/costs/fixed')
  }
  // Consumíveis & diversos (inputs: oficina, apartamento, gatos — D10 decide depois).
  for (const x of d.inputs)
    push(x.payment_date, 'OPER', 'MISC', -qtyLine(x), (x.category || 'INPUT'), x.description || '', '/inputs')
  // Investimento: equipamento (GOODS) e estoque comprado.
  for (const g of d.goods)
    push(g.payment_date, 'INVEST', 'EQUIP', -qtyLine(g), 'GOODS', g.description || '', '/goods/' + g.id)
  for (const g of d.goodExpenses)
    push(g.payment_date, 'INVEST', 'EQUIP', -num(g.amount), 'GOODS', g.description || '', '/goods/' + g.good_id)
  for (const s of d.inventory)
    if (s.source_type === 'PURCHASED')
      push(s.payment_date, 'INVEST', 'STOCK', -qtyLine(s), 'STOCK', s.description || '', '/inventory')

  // Fase 2 — livros: aporte/retirada de sócio e eventos de empréstimo.
  if (d.ledgersReady) {
    for (const c of d.capitalEvents!) {
      push(c.event_date, 'FIN', c.kind === 'CONTRIBUTION' ? 'CAPITAL' : 'DRAW',
        (c.kind === 'CONTRIBUTION' ? 1 : -1) * num(c.amount), 'CAPITAL',
        [c.member, c.description].filter(Boolean).join(' · '), '/adm/financials/ledgers')
    }
    const finById = new Map(d.financing!.map((f: any) => [f.id, f]))
    for (const e of d.financingEvents!) {
      const lender = finById.get(e.financing_id)?.lender || ''
      const line = e.kind === 'DISBURSEMENT' ? 'LOAN_IN' : e.kind === 'PAYMENT' ? 'LOAN_PAY' : 'INTEREST'
      push(e.event_date, 'FIN', line, (e.kind === 'DISBURSEMENT' ? 1 : -1) * num(e.amount),
        'LOAN', [lender, e.description].filter(Boolean).join(' · '), '/adm/financials/ledgers')
    }
  }

  return ev.sort((a, b) => a.date.localeCompare(b.date))
}

// Totais dos livros da Fase 2 (null enquanto a migration não rodou):
// capital, retiradas formais, saldo devedor de empréstimos, juros pagos e o
// último saldo de caixa POR CONTA (o Balanço soma; a conciliação compara).
export function ledgerTotals(d: FinData) {
  if (!d.ledgersReady) return null
  const contributions = d.capitalEvents!.filter((c: any) => c.kind === 'CONTRIBUTION').reduce((s: number, c: any) => s + num(c.amount), 0)
  const capDraws = d.capitalEvents!.filter((c: any) => c.kind === 'DRAW').reduce((s: number, c: any) => s + num(c.amount), 0)
  let loanBalance = 0, interestPaid = 0
  for (const e of d.financingEvents!) {
    if (e.kind === 'DISBURSEMENT') loanBalance += num(e.amount)
    else if (e.kind === 'PAYMENT') loanBalance -= num(e.amount)
    else interestPaid += num(e.amount)
  }
  const latest = new Map<string, { date: string; balance: number }>()
  for (const b of d.cashBalances!) {
    const cur = latest.get(b.account)
    if (!cur || String(b.balance_date) > cur.date) latest.set(b.account, { date: String(b.balance_date), balance: num(b.balance) })
  }
  const cashAccounts = [...latest.entries()].map(([account, v]) => ({ account, date: v.date, balance: v.balance }))
    .sort((a, b) => b.balance - a.balance)
  const cashTotal = cashAccounts.reduce((s, a) => s + a.balance, 0)
  return { contributions, capDraws, loanBalance, interestPaid, cashAccounts, cashTotal }
}

// Sem data de pagamento = ainda devido (vira Fornecedores a Pagar no Balanço).
export function unpaidTotals(d: FinData) {
  const inv = d.invExpenses.filter(e => !okDate(e.payment_date)).reduce((s, e) => s + expLine(e), 0)
  const fixed = d.fixedExpenses.filter(e => !okDate(e.payment_date)).reduce((s, e) => s + num(e.amount), 0)
  const staff = d.expenses.filter(e => !okDate(e.payment_date) && e.origin !== 'PERSONAL').reduce((s, e) => s + num(e.amount), 0)
  const purchases = d.goods.filter(g => !okDate(g.payment_date)).reduce((s, g) => s + qtyLine(g), 0)
    + d.goodExpenses.filter(g => !okDate(g.payment_date)).reduce((s, g) => s + num(g.amount), 0)
    + d.inputs.filter(x => !okDate(x.payment_date)).reduce((s, x) => s + qtyLine(x), 0)
    + d.inventory.filter(x => x.source_type === 'PURCHASED' && !okDate(x.payment_date)).reduce((s, x) => s + qtyLine(x), 0)
  return { inv, fixed, staff, purchases, total: inv + fixed + staff + purchases }
}
