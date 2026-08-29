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
    fetchAll('invoices', 'id, invoice_code, ride_id, client_id, is_quote, live_status, origin, florida_taxes, global_discount, fl_tax_expense_date, entry_date, hiring_date, conclusion_date, delivery_date, expected_conclusion_date, mileage'),
    fetchAll('invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, source, paid_to, description'),
    fetchAll('invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, source, purchase_group'),
    fetchAll('invoice_parts', 'id, invoice_id, description, unit_price, quantity'),
    fetchAll('invoice_services', 'id, invoice_id, description, price'),
    fetchAll('expenses', 'id, type, description, amount, expense_date, payment_date, origin, paid_from, paid_to, source, season_id'),
    fetchAll('fixed_cost_expenses', 'id, supplier_id, description, amount, expense_date, payment_date, paid_from, paid_to, source'),
    fetchAll('fixed_cost_suppliers', 'id, company, description, cost_type, date_conclusion'),
    fetchAll('goods', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, purchase_group'),
    fetchAll('good_expenses', 'id, good_id, description, amount, expense_date, payment_date, paid_from, paid_to, source'),
    // order_number entra no select (29/ago/2026): o MOVE pra estoque do Data
    // Checker leva o pedido junto — ORDER NUMBER é sagrado e não se perde.
    fetchAll('inputs', 'id, description, supplier, category, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, purchase_group, order_number'),
    fetchAll('inventory', 'id, description, source_type, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, purchase_group'),
    // rides via '*': tabela pequena e é a que mais ganha coluna nova — select
    // explícito derrubava o dataset inteiro quando o deploy chegava antes da
    // migration (caso rides.exported). Com '*', coluna ausente vira undefined.
    fetchAll('rides', '*'),
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

// CARROS × OFICINA (D2/D3 — João decidiu 25/ago): detector POR LINHA do carro
// de export — ≥$15k + vocabulário de carro OU o apelido do próprio ride, com
// guarda de peça (engine/kit/heads/câmbio… nunca é carro). Validado contra as
// 41 linhas ≥$15k do banco real: zero erro depois do apelido (caso "KR TX
// CHRYS - Joker 2nd Payment") e da guarda (caso "Demon 170 NEW Full Engine").
const CAR_TOKENS = /car purchase|compra |challenger|charger|demon|hellcat|redeye|widebody|superstock|camaro|z\/28|vin\s|corvette|mustang|durango/i
const CAR_PART_GUARD = /engine|kit\b|heads|camshaft|transmission|c[âa]mbio|turbo|porting|supercharger|pulley|injector/i
export function isCarLine(text: string | null | undefined, amount: number, nickname?: string | null): boolean {
  const t = String(text || '')
  if (amount < 15000 || CAR_PART_GUARD.test(t)) return false
  if (CAR_TOKENS.test(t)) return true
  const nick = String(nickname || '').trim()
  return nick.length >= 4 && t.toUpperCase().includes(nick.toUpperCase())
}
export const invNickname = (d: FinData, invoiceId: string): string | null => {
  const inv = d.invoiceById.get(invoiceId)
  // BUG corrigido 26/ago: a coluna é project_name (rides não tem nickname) — com
  // nickname o apelido voltava null e o caso Joker (KR TX Chrys) escapava.
  return (inv?.ride_id && d.rides.get(inv.ride_id)?.project_name) || null
}

// G4 (25/ago — João classificou a frota): depreciação linear POR LINHA DE CUSTO.
// Cada gasto do carro deprecia da SUA data (payment_date/expense_date), pela
// vida útil da classe (padrão 60 meses). DESENVOLVIMENTO e TRABALHO depreciam;
// MONUMENTO (a alma) e RESERVA (ativo em carteira) ficam ao custo. Retorna null
// enquanto a MIGRATION_g4_fleet.sql não rodou (coluna ausente = sem alarme).
export function fleetDepreciation(d: FinData): { own: number; tool: number; accum: number } | null {
  const today = new Date()
  const ym = today.getFullYear() * 12 + today.getMonth() + 1
  let any = false, own = 0, tool = 0
  // COLECIONÁVEL (João, 25/ago — caso Devil170, Demon 170 de produção única): o
  // CHASSI não deprecia (valorização provável fica FORA dos livros até realizar
  // — conservadorismo; vira ganho na venda); os EXPERIMENTOS gastos nele sim.
  // isCarLine separa chassi de mod, linha a linha — o mesmo detector validado.
  const cls = new Map<string, { scope: string; life: number; dep: boolean; col: boolean; nick: string | null }>()
  for (const r of d.rides.values()) {
    const c = (r as any).asset_class
    if (c !== undefined) any = true
    if (r.title_scope !== 'OWN' && r.title_scope !== 'TOOL') continue
    cls.set(r.id, { scope: r.title_scope, life: num((r as any).asset_life_months) || 60, dep: c === 'DESENVOLVIMENTO' || c === 'TRABALHO' || c === 'COLECIONAVEL', col: c === 'COLECIONAVEL', nick: r.project_name || null })
  }
  if (!any) return null
  for (const e of d.invExpenses) {
    const rid = d.invoiceById.get(e.invoice_id)?.ride_id
    const k = rid && cls.get(rid)
    if (!k || !k.dep) continue
    const base = expLine(e)
    if (k.col && isCarLine(e.item, base, k.nick)) continue   // chassi colecionável: ao custo
    const dt = String(e.payment_date || e.expense_date || '')
    if (!okDate(dt) || !base) continue
    const months = Math.max(0, ym - (Number(dt.slice(0, 4)) * 12 + Number(dt.slice(5, 7))))
    const dep = base * Math.min(months / k.life, 1)
    if (k.scope === 'OWN') own += dep; else tool += dep
  }
  const r2 = (v: number) => Math.round(v * 100) / 100
  return { own: r2(own), tool: r2(tool), accum: r2(own + tool) }
}

export function buildCashEvents(d: FinData): CashEvent[] {
  const ev: CashEvent[] = []
  const push = (date: string | null | undefined, section: CashEvent['section'], line: string,
    amount: number, code: string, label: string, href: string) => {
    if (!okDate(date) || !amount) return
    ev.push({ date: String(date).slice(0, 10), section, line, amount, code, label, href })
  }

  // FIN 0.9.8 (João decidiu, 25/ago — pendência #21): despesa paga por OUTRO
  // caixa (GZ28BR; RAFA entra pela conta corrente BR, decisão de 22/ago; BETO)
  // não saiu do caixa GZ28US — mas o custo é nosso. A saída operacional fica e
  // nasce a entrada de FINANCIAMENTO espelhada (quem bancou): efeito zero no
  // caixa, igual ao passivo que o Balanço já declara. paid_from vazio segue
  // valendo GZ28US (o card "Quem pagou?" encolhe essa incerteza todo dia).
  const FUNDERS: Record<string, { line: string; who: string }> = {
    GZ28BR: { line: 'FUND_BR', who: 'GZ28BR (conta corrente)' },
    RAFA: { line: 'FUND_BR', who: 'GZ28BR (conta corrente — via Rafa)' },
    BETO: { line: 'FUND_BETO', who: 'Beto (empréstimo de sócio)' },
    HERALDO: { line: 'FUND_HERALDO', who: 'Heraldo (empréstimo de sócio)' },
  }
  const fund = (row: { paid_from?: string | null }, date: string | null | undefined, amount: number, label: string) => {
    const f = FUNDERS[String(row.paid_from || '').trim().toUpperCase()]
    if (f && amount) push(date, 'FIN', f.line, amount, 'FUNDED', f.who + ' · ' + label, '/adm/check')
  }

  // Invoices COM carro (linha de carro na venda ou no custo): os recebimentos
  // delas vão pra linha própria — o caixa não se aloca por linha, então a
  // separação de ENTRADA é por invoice (a nota da tela confessa isso).
  const carInv = new Set<string>()
  for (const e of d.invExpenses) if (isCarLine(e.item, expLine(e), invNickname(d, e.invoice_id))) carInv.add(e.invoice_id)
  for (const p of d.invParts) if (isCarLine(p.description, num(p.unit_price) * num(p.quantity), invNickname(d, p.invoice_id))) carInv.add(p.invoice_id)

  // Recebimentos — só o que TEM paid_at (agendado ainda não é caixa). Recebido
  // pela GZ28BR (2025) é linha própria: é receita nossa que virou saldo lá.
  for (const p of d.payments) {
    if (!p.paid_at) continue
    const m = invoiceMeta(d, p.invoice_id)
    // Data do caixa é o RECEBIMENTO (paid_at); payment_date é só o agendado.
    const cashDate = String(p.paid_at).slice(0, 10)
    const cd = okDate(cashDate) ? cashDate : p.payment_date
    push(cd, 'OPER',
      p.paid_to === 'GZ28BR' ? 'RECEIPTS_BR' : carInv.has(p.invoice_id) ? 'RECEIPTS_CARS' : 'RECEIPTS',
      num(p.amount), m.code, m.car || p.description || p.source || '', m.href)
    // Recebeu na GZ28BR = o dinheiro ficou LÁ: espelho negativo na conta corrente.
    if (p.paid_to === 'GZ28BR') push(cd, 'FIN', 'FUND_BR', -num(p.amount), 'FUNDED',
      'GZ28BR (conta corrente) · recebeu por nós — ' + (m.car || p.description || ''), '/adm/check')
  }
  // Fornecedores de projeto (inclui compra de carro — separação é papo do DRE/D3).
  for (const e of d.invExpenses) {
    const m = invoiceMeta(d, e.invoice_id)
    const car = isCarLine(e.item, expLine(e), invNickname(d, e.invoice_id))
    push(e.payment_date, 'OPER', car ? 'CAR_BUY' : 'JOB_COST', -expLine(e), m.code,
      [m.car, e.item].filter(Boolean).join(' · '), m.href)
    fund(e, e.payment_date, expLine(e), [m.code, e.item].filter(Boolean).join(' · '))
  }
  // Folha e retiradas — origin separa a empresa do pessoal do Márcio.
  // Decisão dos sócios (26/ago): pessoal de sócio = custo de equipe, não retirada.
  // DRAW no DFC ficou só pras retiradas FORMAIS do livro (capital_events).
  for (const x of d.expenses) {
    push(x.payment_date, 'OPER', 'PAYROLL',
      -num(x.amount), 'STAFF', x.description || x.type || '', '/staff')
    fund(x, x.payment_date, num(x.amount), x.description || x.type || '')
  }
  // Custos fixos por família (cost_type do fornecedor).
  for (const f of d.fixedExpenses) {
    const sup = d.fixedSuppliers.get(f.supplier_id)
    const ct = sup?.cost_type || 'UNCLASSIFIED'
    const line = ct === 'APP' ? 'APPS' : (ct === 'MARKETING' || ct === 'MERCHANDISE') ? 'MARKETING' : ct === 'FIXED' ? 'FIXED' : ct === 'BANK' ? 'BANK_FEES' : ct === 'STAFF' ? 'PAYROLL' : ct === 'FLEET' ? 'FLEET_COST' : 'MISC'
    const href = ct === 'APP' ? '/costs/apps/' + f.supplier_id : (ct === 'MARKETING' || ct === 'MERCHANDISE' || ct === 'ASSET') ? '/costs/assets/' + f.supplier_id : ct === 'BANK' ? '/costs/bank' : '/costs/fixed/' + f.supplier_id
    push(f.payment_date, 'OPER', line, -num(f.amount), ct,
      [sup?.company, f.description].filter(Boolean).join(' · '), f.supplier_id ? href : '/costs/fixed')
    fund(f, f.payment_date, num(f.amount), [sup?.company, f.description].filter(Boolean).join(' · '))
  }
  // Consumíveis & diversos (inputs: oficina, apartamento, gatos — D10 decide depois).
  for (const x of d.inputs) {
    push(x.payment_date, 'OPER', 'MISC', -qtyLine(x), (x.category || 'SUPPLY'), x.description || '', '/supplies')
    fund(x, x.payment_date, qtyLine(x), x.description || '')
  }
  // Investimento: equipamento (GOODS) e estoque comprado.
  for (const g of d.goods) {
    push(g.payment_date, 'INVEST', 'EQUIP', -qtyLine(g), 'GOODS', g.description || '', '/goods/' + g.id)
    fund(g, g.payment_date, qtyLine(g), g.description || '')
  }
  for (const g of d.goodExpenses) {
    push(g.payment_date, 'INVEST', 'EQUIP', -num(g.amount), 'GOODS', g.description || '', '/goods/' + g.good_id)
    fund(g, g.payment_date, num(g.amount), g.description || '')
  }
  for (const s of d.inventory)
    if (s.source_type === 'PURCHASED') {
      push(s.payment_date, 'INVEST', 'STOCK', -qtyLine(s), 'STOCK', s.description || '', '/inventory')
      fund(s, s.payment_date, qtyLine(s), s.description || '')
    }

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

// Data de reconhecimento de um invoice FECHADO (insight do Márcio, 20/ago):
// CLOSED já exige todo income datado E recebido — então o último recebimento
// é uma data de conclusão DERIVÁVEL. Hierarquia: conclusion_date explícita
// (verdade do trabalho, capturada pela trava do fechamento) > delivery_date >
// último income. Invoice aberto não tem data mesmo: é WIP sob D2.
export function recognitionDate(d: FinData, inv: any): string | null {
  if (inv.conclusion_date) return inv.conclusion_date
  if (inv.delivery_date) return inv.delivery_date
  if (inv.live_status !== 'CLOSED') return null
  let last = ''
  for (const p of d.payments) if (p.invoice_id === inv.id) {
    const dt = p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || '')
    if (dt && dt > last) last = dt
  }
  return last || null
}

// Sem data de pagamento = ainda devido (vira Fornecedores a Pagar no Balanço).
export function unpaidTotals(d: FinData) {
  const inv = d.invExpenses.filter(e => !okDate(e.payment_date)).reduce((s, e) => s + expLine(e), 0)
  const fixed = d.fixedExpenses.filter(e => !okDate(e.payment_date)).reduce((s, e) => s + num(e.amount), 0)
  const staff = d.expenses.filter(e => !okDate(e.payment_date)).reduce((s, e) => s + num(e.amount), 0)   // pessoal incluso (decisão 26/ago)
  const purchases = d.goods.filter(g => !okDate(g.payment_date)).reduce((s, g) => s + qtyLine(g), 0)
    + d.goodExpenses.filter(g => !okDate(g.payment_date)).reduce((s, g) => s + num(g.amount), 0)
    + d.inputs.filter(x => !okDate(x.payment_date)).reduce((s, x) => s + qtyLine(x), 0)
    + d.inventory.filter(x => x.source_type === 'PURCHASED' && !okDate(x.payment_date)).reduce((s, x) => s + qtyLine(x), 0)
  return { inv, fixed, staff, purchases, total: inv + fixed + staff + purchases }
}
