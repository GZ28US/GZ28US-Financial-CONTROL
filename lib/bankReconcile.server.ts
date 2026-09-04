// lib/bankReconcile.server.ts — pool, ranking e motores da conciliação bancária.
// Só servidor (service key). A rota app/api/bank/reconcile/route.ts é fina e usa isto.
//
// CONCILIAÇÃO BANCÁRIA (Data Checker · card "Banco sem casamento", 21/ago):
// cada linha NEW do banco é uma pendência. Achamos CANDIDATOS no app — mesmo
// valor (±$0,01), data próxima, ou grupo de compra somado (um pedido de 3 itens
// = uma cobrança) — e aplicamos a decisão: MATCH (e backfill do payment_date do
// app quando falta), TRANSFER, IGNORE ou EXPLAIN (QUEUED com a nota).
// Convenção Plaid: amount > 0 = saiu, < 0 = entrou.
//
// v0.3.0 (22/ago, "Go!" do Márcio) — MOTORES, só o que é CERTO:
//   FEE   tarifa da Regions (vocabulário do banco / categoria BANK_FEES, ≤ $300):
//         casa com tarifa já lançada se houver UMA; duas ou mais = ambígua, fica
//         pro humano; nenhuma = CRIA a linha em fixed_cost_expenses (fornecedor
//         "Regions Bank", FIXED ⇒ o DRE soma) com bank_transaction_id.
//   EXACT centavos iguais + candidato ÚNICO no app (±30d) + linha ÚNICA no banco
//         (±30d, mesmo valor e direção) + ≤3 dias + NOME batendo + não pendente +
//         candidato datado. Valor redondo (múltiplo de $50) só ≥ $1.000; valor que
//         se repete ≥3× em 45 dias nunca.
//   Revisão adversarial de 22/ago (34 agentes, 25 defeitos confirmados) moldou
//   o resto: o nome ignora vocabulário genérico (card/purchase/zelle/orlando/
//   números) e em Zelle/wire exige o BENEFICIÁRIO; alias é palavra inteira;
//   o MATCH primeiro TRANCA a linha do banco (0 linhas = já decidida) e só
//   depois escreve no app, guardando em `backfill` exatamente o que escreveu —
//   DESFAZER reverte só isso; grupo ⇄ item se excluem dentro do mesmo plano;
//   o lote roda em paralelo limitado e em fatias (remaining) pra caber no tempo.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto'
import { supplierDirectoryFrom, matchSupplier, type SupplierEntry } from './supplierMatch'

export const num = (v: unknown) => parseFloat(String(v)) || 0
const okDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)
const daysBetween = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
// Dias COM sinal (to − from): maturidade nunca deixa passar linha datada no futuro (fase B).
export const signedDays = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 864e5)
const paidAtFor = (date: string) => date + 'T12:00:00-04:00'
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

export async function fetchAll(db: any, table: string, select: string, filter?: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).order('id').range(from, from + 999)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

export type Member = { table: string; id: string }
export type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; group?: string | null; members?: Member[]; href?: string; detail?: string; score?: number; dd?: number | null; supplier_id?: string | null }
// AUTO-BOOK (BL 0.8.0): `sched` = contas fixas AGENDADAS em aberto (sem pagamento
// e sem elo com o banco) — a regra de fornecedor ADOTA a agendada do mês em vez
// de criar uma segunda linha (risco #1 confirmado pela revisão: valor diferente
// nos centavos duplicava a conta e deixava um "a pagar" fantasma).
export type Sched = { id: string; supplier_id: string; expense_date: string; amount: number; description: string | null; paid_from: string | null }
export type Pool = { out: Cand[]; inn: Cand[]; sched: Sched[] }
// `o` = valor ANTERIOR do campo (undefined nos registros antigos = volta pra null).
export type Backfill = { t: string; id: string; f: 'payment_date' | 'paid_at' | 'amount' | 'paid_from' | 'payment_method' | 'bank_transaction_id' | 'description' | 'invoice_id'; v: string; o?: string | null }
export const DATE_TABLES = new Set(['invoice_expenses', 'fixed_cost_expenses', 'expenses', 'goods', 'good_expenses', 'inputs', 'inventory', 'invoice_parts'])

// AUTO-BOOK — constantes de doutrina (3/set/2026; donos podem mover):
export const RULE_AGE_DAYS = 7            // maturidade: RULE/LEARN só criam depois de 7 dias (o humano ainda lança atrasado)
export const AUTO_BOOK_FLOOR = '2025-11-10' // fase B (4/set): piso levantado até a abertura da conta — a rodada automática varre o backlog inteiro
export const ADOPT_WINDOW_DAYS = 20       // agendada do mês: ±20 dias da cobrança
export const LEARN_BLOCK_PFC = new Set(['GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'GENERAL_MERCHANDISE_SUPERSTORES', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE'])
export const LEARN_BLOCK_NAME = /AMAZON|AMZN|EBAY|TEMU|PAYPAL|WAL-?MART\.COM|ZELLE|WIRE/i
export const MARKER_CREATED = '(regra · Bank Link)'
export const MARKER_ADOPTED = '(regra · Bank Link · agendada)'
// ── AUTO-BOOK FASE B (4/set/2026, João + Márcio): o balde «Compras a atribuir» ──
// Linha que regra nenhuma nomeia vira despesa REAL no mesmo dia, numa pseudo-invoice
// de origem BUCKET (invoice_code A ATRIBUIR, sem carro, sem cliente). Elo linha ⇄
// banco = purchase_group (uuid da linha do banco); order_number continua sagrado.
export const BUCKET_ORIGIN = 'BUCKET'                     // invoices.origin do balde — durável: o editor nunca reescreve origin
export const BUCKET_CODE = 'A ATRIBUIR'
export const MARKER_BUCKET = '(a atribuir · Bank Link)'    // item enquanto está no balde
export const MARKER_ASSIGNED = '(atribuída · Bank Link)'   // item/descrição depois de atribuída — mesma família '%Bank Link)%'
export const ENGINE_BUCKET = 'BUCKET'                      // match_engine da linha do banco, pra vida toda da linha
// Classes que NUNCA entram por regra PADRÃO ou por classe: dinheiro-movimento e o
// que parece pessoal/estrutural — só regra HUMANA com regex nomeia essas.
export const HUMAN_TIER = new Set(['TRANSFER', 'BANK_FEE', 'INCOME', 'RESTAURANT', 'LODGING', 'TRAVEL', 'ENTERTAINMENT', 'CLOTHING', 'DEPT_STORE', 'DRUGSTORE', 'GOVERNMENT', 'INSURANCE', 'UTILITY', 'RENT', 'TELECOM', 'ACCOUNTING'])
export const ATTRIB_REPORT_DAYS = 14                       // balão «EXPENSE PAID» só quando a compra é recente (data do banco)
export const ORPHAN_GRACE_MIN = 10                         // purga de órfão do balde só depois de 10 min (janela das ações da fila)
export const INPUT_CATEGORIES = ['CONSUMPTION', 'STOCK', 'APARTMENT', 'CATS', 'TEAM']   // vocabulário das telas de supplies — SHOP nunca existiu

// Monta o pool de candidatos do app: saídas (OUT) e entradas (IN), já sem o
// que outra linha do banco casou — inclusive o cruzamento grupo ⇄ item.
export async function candidatePool(db: any): Promise<Pool> {
  const [invExp, fixed, suppliers, expenses, goods, goodExp, inputs, inventory, payments, invParts, invoices, rides, clients, capital, finEv, financing, matched] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, purchase_group, paid_from'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date, expense_date, paid_from, bank_transaction_id'),
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, description, cost_type'),
    fetchAll(db, 'expenses', 'id, description, type, amount, payment_date, expense_date, origin, paid_from'),
    fetchAll(db, 'goods', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from'),
    fetchAll(db, 'good_expenses', 'id, good_id, description, supplier, amount, payment_date, expense_date, paid_from'),
    fetchAll(db, 'inputs', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from, category'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from'),
    fetchAll(db, 'invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, source, description, paid_to'),
    fetchAll(db, 'invoice_parts', 'id, invoice_id, description, unit_price, quantity, base_cost, payment_date, kit_group, kit_name'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote, origin'),
    fetchAll(db, 'rides', 'id, project_name, client_id'),
    fetchAll(db, 'clients', '*').catch(() => []),
    fetchAll(db, 'capital_events', 'id, event_date, kind, member, amount, description').catch(() => []),
    fetchAll(db, 'financing_events', 'id, financing_id, event_date, kind, amount, description').catch(() => []),
    fetchAll(db, 'financing', 'id, lender').catch(() => []),
    // Linha REMOVED pelo Plaid (pending que virou posted com outro id) solta o
    // alvo: a linha nova casa com a MESMA linha do app em vez de criar gêmea.
    fetchAll(db, 'bank_transactions', 'matched_table, matched_id', (q: any) => q.not('matched_id', 'is', null).neq('match_status', 'REMOVED')),
  ])
  const today = todayNY()
  const taken = new Set(matched.filter((m: any) => m.matched_id).map((m: any) => m.matched_table + ':' + m.matched_id))
  // Grupo casado ⇒ seus itens saem; item casado ⇒ seu grupo sai.
  const takenGroups = new Set([...taken].filter(k => k.startsWith('purchase_group:')).map(k => k.slice('purchase_group:'.length)))
  const brokenGroups = new Set<string>()
  for (const [tbl, rows] of [['goods', goods], ['inputs', inputs], ['inventory', inventory], ['invoice_expenses', invExp]] as const)
    for (const r of rows) if (r.purchase_group && taken.has(tbl + ':' + r.id)) brokenGroups.add(r.purchase_group)

  const invById = new Map(invoices.map((i: any) => [i.id, i]))
  const clientName = new Map(clients.map((c: any) => [c.id, c.name || c.full_name || c.company || c.nickname || '']))
  const rideById = new Map(rides.map((r: any) => [r.id, r]))
  const supName = new Map(suppliers.map((s: any) => [s.id, s.company || s.description || '']))
  // Tarifa bancária tem casa própria (João, 26/ago): fornecedor BANK ⇒ selo
  // TARIFA e ABRIR → /costs/bank, nunca mais "Tarifas da conta" como custo fixo.
  const bankSup = new Set(suppliers.filter((s: any) => s.cost_type === 'BANK').map((s: any) => s.id))
  const lender = new Map(financing.map((f: any) => [f.id, f.lender]))
  const invLabel = (invoiceId: string) => { const i = invById.get(invoiceId); const r = i ? rideById.get(i.ride_id) : null; return i ? `${i.origin === BUCKET_ORIGIN ? 'A ATRIBUIR · ' : ''}${i.invoice_code || '—'} ${r?.project_name || ''}`.trim() : '—' }
  const invClient = (invoiceId: string) => { const i = invById.get(invoiceId); const r = i ? rideById.get(i.ride_id) : null; return r ? clientName.get(r.client_id) || '' : '' }
  // "Conferir" (UX, João 25/ago): todo candidato diz DE ONDE veio e abre o registro real.
  const invHref = (invoiceId: string) => { const i = invById.get(invoiceId); if (i && i.origin === BUCKET_ORIGIN) return '/adm/bank#a-atribuir'; return i && i.ride_id ? `/rides/${i.ride_id}/invoices/${invoiceId}` : '/adm/reports' }
  const dts = (pay: string | null | undefined, other: string | null | undefined, otherLabel: string) => [pay ? 'pago ' + pay : 'SEM data de pagamento', other ? otherLabel + ' ' + other : null].filter(Boolean).join(' · ')
  const realInvoice = (invoiceId: string) => { const i = invById.get(invoiceId); return !!i && !i.is_quote }
  const out: Cand[] = [], inn: Cand[] = []
  // Pagou/recebeu o Brasil ⇒ nunca passa na Regions. Datado no futuro ⇒ ainda não aconteceu.
  // Pago por sócio (BETO/HERALDO/RAFA) também nunca passou na Regions — fora
  // do pool igual ao GZ28BR (caso do histórico do Humberto, 26/ago).
  const brPaid = (r: any) => ['GZ28BR', 'BETO', 'HERALDO', 'RAFA'].includes(String(r.paid_from || '')) || r.paid_to === 'GZ28BR'
  const future = (d: string | null) => !!d && d.slice(0, 10) > today
  // Valor negativo no app = estorno/crédito: vai pro pool OPOSTO com o valor absoluto.
  const push = (arr: Cand[], c: Cand) => {
    if (taken.has(c.table + ':' + c.id) || Math.abs(c.amount) < 0.005 || future(c.date)) return
    if (c.amount < 0) (arr === out ? inn : out).push({ ...c, amount: -c.amount, label: c.label + ' · ESTORNO' })
    else arr.push(c)
  }
  const memberFree = (r: any) => !(r.purchase_group && takenGroups.has(r.purchase_group))
  const grp = (r: any) => (r.purchase_group as string) || null

  for (const e of invExp) { if (!realInvoice(e.invoice_id) || brPaid(e) || !memberFree(e)) continue
    // Fricção do Márcio (26/ago): era a ÚNICA origem sem selo — começava direto
    // no código da invoice e virava adivinhação. EXPENSE, espelho do INCOME.
    push(out, { table: 'invoice_expenses', id: e.id, group: grp(e), label: `EXPENSE · ${invLabel(e.invoice_id)} · ${e.item || ''}${e.supplier ? ' · ' + e.supplier : ''}`, date: e.payment_date || e.expense_date || null, amount: num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra), undated: !okDate(e.payment_date), href: invHref(e.invoice_id), detail: `DESPESA da invoice ${invLabel(e.invoice_id)} · ${num(e.price)}×${num(e.quantity) || 1}${num(e.tax) ? ' + tax ' + num(e.tax) : ''}${num(e.extra) ? ' + extra ' + num(e.extra) : ''} · ${dts(e.payment_date, e.expense_date, 'lançada')}` }) }
  for (const f of fixed) if (!brPaid(f)) {
    const ehTarifa = bankSup.has(f.supplier_id)
    push(out, { table: 'fixed_cost_expenses', id: f.id, supplier_id: f.supplier_id || null, label: `${ehTarifa ? 'TARIFA' : 'FIXO'} · ${supName.get(f.supplier_id) || ''} · ${f.description || ''}`, date: f.payment_date || f.expense_date || null, amount: num(f.amount), undated: !okDate(f.payment_date), href: ehTarifa ? '/costs/bank' : (f.supplier_id ? '/costs/fixed/' + f.supplier_id : '/costs/fixed'), detail: ehTarifa ? `TARIFA BANCÁRIA já lançada · ${dts(f.payment_date, f.expense_date, 'lançada')}` : `CUSTO FIXO de ${supName.get(f.supplier_id) || 'fornecedor'} · ${dts(f.payment_date, f.expense_date, 'lançado')}` })
  }
  // AGENDADAS em aberto (sem baixa, sem elo com o banco, não-BR) — NÃO filtra
  // futuro: a agendada costuma ter data DEPOIS da cobrança real.
  const sched: Sched[] = fixed.filter((f: any) => !f.payment_date && !f.bank_transaction_id && !brPaid(f) && f.supplier_id && okDate(f.expense_date))
    .map((f: any) => ({ id: f.id, supplier_id: f.supplier_id, expense_date: String(f.expense_date).slice(0, 10), amount: num(f.amount), description: f.description || null, paid_from: f.paid_from || null }))
  for (const x of expenses) if (!brPaid(x)) push(out, { table: 'expenses', id: x.id, label: `${x.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${x.description || x.type || ''}`, date: x.payment_date || x.expense_date || null, amount: num(x.amount), undated: !okDate(x.payment_date), href: '/staff', detail: `${x.origin === 'PERSONAL' ? 'DESPESA PESSOAL' : 'FOLHA/STAFF'} · ${dts(x.payment_date, x.expense_date, 'lançada')}` })
  for (const g of goods) if (!brPaid(g) && memberFree(g)) push(out, { table: 'goods', id: g.id, group: grp(g), label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.purchase_date || null, amount: num(g.unit_price) * (num(g.quantity) || 1), undated: !okDate(g.payment_date), href: '/goods', detail: `BEM/EQUIPAMENTO (GOODS) · ${g.supplier || 'sem fornecedor'} · ${dts(g.payment_date, g.purchase_date, 'comprado')}` })
  for (const g of goodExp) if (!brPaid(g)) push(out, { table: 'good_expenses', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.expense_date || null, amount: num(g.amount), undated: !okDate(g.payment_date), href: '/goods', detail: `DESPESA de bem/equipamento (GOODS) · ${g.supplier || 'sem fornecedor'} · ${dts(g.payment_date, g.expense_date, 'lançada')}` })
  for (const x of inputs) if (!brPaid(x) && memberFree(x)) push(out, { table: 'inputs', id: x.id, group: grp(x), label: `SUPPLY · ${x.category ? x.category + ' · ' : ''}${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date), href: '/supplies', detail: `INSUMO (SUPPLIES${x.category ? ' · ' + x.category : ''}) · ${x.supplier || 'sem fornecedor'} · ${num(x.unit_price)}×${num(x.quantity) || 1} · ${dts(x.payment_date, x.purchase_date, 'comprado')}` })
  for (const x of inventory) if (x.source_type === 'PURCHASED' && !brPaid(x) && memberFree(x)) push(out, { table: 'inventory', id: x.id, group: grp(x), label: `STOCK · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date), href: '/inventory', detail: `ESTOQUE comprado · ${x.supplier || 'sem fornecedor'} · ${num(x.unit_price)}×${num(x.quantity) || 1} · ${dts(x.payment_date, x.purchase_date, 'comprado')}` })
  for (const e of finEv) {
    const c = { table: 'financing_events', id: e.id, label: `EMPRÉSTIMO · ${lender.get(e.financing_id) || ''} · ${e.kind}${e.description ? ' · ' + e.description : ''}`, date: e.event_date, amount: num(e.amount), undated: false, href: '/adm/financials', detail: `EVENTO de empréstimo (${e.kind}) · ${lender.get(e.financing_id) || 'credor'} · em ${e.event_date}` }
    push(e.kind === 'DISBURSEMENT' ? inn : out, c)
  }
  for (const c of capital) push(c.kind === 'CONTRIBUTION' ? inn : out, { table: 'capital_events', id: c.id, label: `CAPITAL · ${c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'} · ${c.member || ''}${c.description ? ' · ' + c.description : ''}`, date: c.event_date, amount: num(c.amount), undated: false, href: '/adm/financials', detail: `${c.kind === 'CONTRIBUTION' ? 'APORTE de capital' : 'RETIRADA de capital'} · ${c.member || 'sócio'} · em ${c.event_date}` })
  for (const p of payments) { if (!realInvoice(p.invoice_id) || brPaid(p)) continue
    push(inn, { table: 'invoice_payments', id: p.id, label: `INCOME · ${invLabel(p.invoice_id)}${invClient(p.invoice_id) ? ' · ' + invClient(p.invoice_id) : ''}${p.description ? ' · ' + p.description : ''}${p.source ? ' · ' + p.source : ''}`, date: p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || null), amount: num(p.amount), undated: !p.paid_at, href: invHref(p.invoice_id), detail: `RECEBIMENTO da invoice ${invLabel(p.invoice_id)} · cliente ${invClient(p.invoice_id) || '—'} · ${p.paid_at ? 'baixado ' + String(p.paid_at).slice(0, 10) : 'previsto ' + (p.payment_date || '—') + ' · SEM baixa'}${p.source ? ' · via ' + p.source : ''}` }) }
  // CUSTO dos parts vendidos (ponto cego da 1ª rodada, João+Márcio 24/ago): o
  // invoice_part tem preço de VENDA (unit_price) e CUSTO (base_cost) — o banco
  // cobra o CUSTO. Kits (kit_group) viram UMA cobrança somada, como pedidos.
  const takenKits = new Set([...taken].filter(k => k.startsWith('kit_group:')).map(k => k.slice('kit_group:'.length)))
  const brokenKits = new Set<string>()
  for (const p of invParts) if (p.kit_group && taken.has('invoice_parts:' + p.id)) brokenKits.add(p.kit_group)
  const kits = new Map<string, { amount: number; date: string | null; label: string; n: number; undated: boolean; members: Member[] }>()
  for (const p of invParts) {
    if (!realInvoice(p.invoice_id)) continue
    const cost = (num(p.base_cost)) * (num(p.quantity) || 1)
    if (cost < 0.005) continue
    const inKit = !!p.kit_group && !brokenKits.has(p.kit_group) && !takenKits.has(p.kit_group)
    if (!(p.kit_group && takenKits.has(p.kit_group)))
      push(out, { table: 'invoice_parts', id: p.id, group: null, label: `PART CUSTO · ${invLabel(p.invoice_id)} · ${p.description || ''}`, date: p.payment_date || null, amount: cost, undated: !okDate(p.payment_date), href: invHref(p.invoice_id), detail: `CUSTO do part vendido na ${invLabel(p.invoice_id)} · venda ${num(p.unit_price)} × custo ${num(p.base_cost)}${(num(p.quantity) || 1) > 1 ? ' ×' + num(p.quantity) : ''}${p.kit_name ? ' · kit ' + p.kit_name : ''} · ${p.payment_date ? 'pago ' + p.payment_date : 'SEM data de pagamento'}` })
    if (inKit) {
      const g = kits.get(p.kit_group) || { amount: 0, date: null, label: `KIT CUSTO · ${p.kit_name || p.kit_group} · ${invLabel(p.invoice_id)}`, n: 0, undated: false, members: [] }
      g.amount += cost; g.n++; g.members.push({ table: 'invoice_parts', id: p.id })
      if (p.payment_date && (!g.date || p.payment_date < g.date)) g.date = p.payment_date
      if (!okDate(p.payment_date)) g.undated = true
      kits.set(p.kit_group, g)
    }
  }
  kits.forEach((g, id) => { if (g.n > 1) push(out, { table: 'kit_group', id, label: `${g.label} · ${g.n} itens`, date: g.date, amount: g.amount, undated: g.undated, members: g.members, detail: `KIT: soma do CUSTO de ${g.n} parts do mesmo kit — o banco cobra o kit inteiro de uma vez` }) })
  // Grupos de compra: um pedido com vários itens vira UMA cobrança no banco.
  // Só entram os MESMOS itens que contam (PURCHASED, livres, não-BR, invoice
  // real); grupo com item já casado não é oferecido. O grupo carrega seus
  // MEMBROS: o backfill e o DESFAZER mexem só neles (v0.3.0 revisão #18).
  const groups = new Map<string, { amount: number; date: string | null; label: string; n: number; undated: boolean; members: Member[] }>()
  for (const [tbl, rows] of [['goods', goods], ['inputs', inputs], ['inventory', inventory], ['invoice_expenses', invExp]] as const) {
    for (const r of rows) {
      if (!r.purchase_group || brokenGroups.has(r.purchase_group) || takenGroups.has(r.purchase_group) || brPaid(r)) continue
      if (tbl === 'inventory' && r.source_type !== 'PURCHASED') continue
      if (tbl === 'invoice_expenses' && !realInvoice(r.invoice_id)) continue
      const g = groups.get(r.purchase_group) || { amount: 0, date: null, label: `PEDIDO · ${r.supplier || tbl.toUpperCase()}${tbl === 'invoice_expenses' ? ' · ' + invLabel(r.invoice_id) : ''}`, n: 0, undated: false, members: [] }
      g.amount += tbl === 'invoice_expenses' ? num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra) : num(r.unit_price) * (num(r.quantity) || 1); g.n++
      g.members.push({ table: tbl, id: r.id })
      const d = r.payment_date || r.purchase_date || r.expense_date || null
      if (d && (!g.date || d < g.date)) g.date = d
      if (!okDate(r.payment_date)) g.undated = true
      groups.set(r.purchase_group, g)
    }
  }
  groups.forEach((g, id) => { if (g.n > 1) push(out, { table: 'purchase_group', id, label: `${g.label} · ${g.n} itens`, date: g.date, amount: g.amount, undated: g.undated, members: g.members, detail: `PEDIDO: soma de ${g.n} itens comprados juntos — o banco cobra o pedido inteiro de uma vez` }) })
  return { out, inn, sched }
}

/* ─────────────── NOME: o que conta como "bate" ─────────────── */

// Vocabulário que NÃO identifica ninguém (está em centenas de linhas do banco
// e em dezenas de rótulos do app). Revisão #2: sem isto "zelle"/"orlando"/o
// final do cartão passavam por nome.
const STOP = new Set(['card', 'purchase', 'pin', 'paypal', 'zelle', 'debit', 'credit', 'from', 'online', 'transfer', 'payment', 'deposit', 'regions', 'orlando', 'kissimmee', 'florida', 'wire', 'inst', 'xfer', 'gz28', 'speeds', 'speedshop', 'recurring', 'transaction', 'ref', 'llc', 'inc', 'corp', 'the', 'and', 'with', 'shop', 'store', 'check', 'bank', 'fee', 'fees', 'income', 'fixo', 'goods', 'input', 'stock', 'pedido', 'itens', 'folha', 'pessoal', 'estorno'])
export function words(s: string): string[] {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
}
const wordHit = (a: string[], b: string[]) => a.some(w => b.some(x => x === w || (w.length >= 5 && x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))))
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Como o banco escreve ⇄ como o app chama. Palavra INTEIRA no rótulo (revisão #4);
// `not` veta rótulos que usam a palavra em outro sentido (bomba de combustível
// não é posto de gasolina).
type Alias = { re: RegExp; words: string[]; not?: RegExp }
const ALIASES: Alias[] = [
  { re: /DELAWAR/i, words: ['high horse', 'hhp'] }, { re: /HPTUNER|HP TUNERS/i, words: ['hp tuners', 'hptuners'] }, { re: /TITAN MOT/i, words: ['titan motorsports', 'titan mot'] },
  { re: /TEXASSPEE|TEXAS SPEED/i, words: ['texas speed'] }, { re: /KONG PE/i, words: ['kong'] }, { re: /ZPE IN|\bZPE\b/i, words: ['zpe', 'griptec'] }, { re: /MODERN|\bMMX\b/i, words: ['modern muscle', 'mmx'] },
  { re: /METAPLATFOR|FACEBK|META PLATFORMS/i, words: ['meta platforms', 'facebook', 'instagram', 'anuncio', 'anúncio'] }, { re: /AMERICAN AIR/i, words: ['american air', 'american airlines', 'flight', 'voo'] },
  { re: /LAGOSEC/i, words: ['nordvpn', 'nord security'] }, { re: /PROGRESSIVE/i, words: ['progressive'] }, { re: /TREPERFO|T1 RACE/i, words: ['t1 race', 'race development'] }, { re: /ANTHROPIC|CLAUDE/i, words: ['claude', 'anthropic'] },
  { re: /DLAUTO/i, words: ['dlauto', 'dl auto'] }, { re: /SPACE ORL/i, words: ['space orl', 'warehouse', 'galpão', 'galpao'] }, { re: /LUMA|VENTERRA/i, words: ['luma', 'headwaters'] }, { re: /DUKE/i, words: ['duke'] },
  { re: /DROPBOX/i, words: ['dropbox'] }, { re: /APPLE/i, words: ['apple', 'icloud'], not: /airpods|iphone|ipad|macbook|best buy/i }, { re: /GOOGLE/i, words: ['google'] }, { re: /SUPABASE/i, words: ['supabase'] }, { re: /VERCEL/i, words: ['vercel'] },
  { re: /AUTOZONE/i, words: ['autozone'] }, { re: /HARBOR/i, words: ['harbor'] }, { re: /SUMMIT/i, words: ['summit'] }, { re: /JEGS/i, words: ['jegs'] }, { re: /EBAY/i, words: ['ebay'] }, { re: /AMAZON|AMZN/i, words: ['amazon'] }, { re: /WALMART|WAL-MART/i, words: ['walmart'] },
  { re: /RACETRAC|WAWA|SHELL|\bBP\b|7-ELEVEN|CHEVRON|EXXON|SUNOCO|MARATHON/i, words: ['gasolina', 'combustível', 'combustivel', 'gasoline', 'unld', 'super gas', 'fuel'], not: /injector|pump|rail|regulator|filter|module|hose|sensor|line|cell|tank/i },
]
// Apelidos vindos do BANCO DE DADOS (bank_aliases, semeados no card — BL 0.7.0):
// somam-se aos hard-coded acima sem precisar de deploy. Cache por lambda.
let DB_ALIASES: Alias[] = []
export async function loadDbAliases(db: any): Promise<void> {
  try {
    const { data } = await db.from('bank_aliases').select('pattern, words, not_pattern')
    DB_ALIASES = (data || []).map((r: any) => {
      try {
        return { re: new RegExp(r.pattern, 'i'), words: String(r.words || '').split(',').map((w: string) => w.trim().toLowerCase()).filter(Boolean), not: r.not_pattern ? new RegExp(r.not_pattern, 'i') : undefined }
      } catch { return null }
    }).filter(Boolean) as Alias[]
  } catch { DB_ALIASES = [] /* tabela ainda não existe — segue só com os hard-coded */ }
}

// Nome bate? Em Zelle/wire o BENEFICIÁRIO tem que aparecer no rótulo (revisão #3);
// nas demais, palavra útil em comum (prefixo de 5 vale) ou alias inteiro.
export function nameHit(line: any, c: Cand): boolean {
  const bank = ((line.merchant || '') + ' ' + (line.name || '')).toLowerCase()
  const lab = String(c.label || '').toLowerCase()
  const lw = words(lab)
  const payee = bank.match(/zelle (?:debit to|credit from) ([a-z0-9&' .-]+?)(?: ref#?|$)/i) || bank.match(/wire transfer (?:incoming |outgoing |domestic |intl |international )?(?!fee)([a-z0-9&' .-]+)/i)
  if (payee) { const pw = words(payee[1]); return pw.length > 0 && wordHit(pw, lw) }
  if (wordHit(words(bank), lw)) return true
  for (const a of [...ALIASES, ...DB_ALIASES]) if (a.re.test(bank) && !(a.not && a.not.test(lab)) && a.words.some(w => new RegExp('\\b' + esc(w) + '\\b', 'i').test(lab))) return true
  return false
}

export function rank(line: any, pool: Pool): Cand[] {
  const amt = Math.abs(num(line.amount))
  const arr = num(line.amount) > 0 ? pool.out : pool.inn
  const bw = words((line.merchant || '') + ' ' + (line.name || ''))
  return arr.filter(c => Math.abs(c.amount - amt) < 0.011).map(c => {
    let score = 50
    const dd = c.date ? daysBetween(c.date, line.date) : null
    if (dd === null) score += 5
    else if (dd === 0) score += 30
    else if (dd <= 3) score += 20
    else if (dd <= 7) score += 10
    else if (dd <= 30) score += 2
    else score -= 40
    if (c.undated) score += 5
    const lw = words(c.label); let hit = 0; bw.forEach(t => { if (lw.includes(t)) hit++ })
    score += Math.min(15, hit * 5)
    if (nameHit(line, c)) score += 10
    const { members, ...rest } = c; void members
    return { ...rest, score, dd }
  }).filter(c => (c.score || 0) > 20).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)
}

/* ─────────────── MOTORES ─────────────── */

const FEE_RE = /ANALYSIS CHARGE|SERVICE ASSESSMENT|WIRE TRANSFER INCOMING FEE|WIRE TRANSFER .* FEE|WIRE TRANSFER DOMESTIC OUT F|EXCESSIVE WITHDRAWAL|MONTHLY FEE|CASH DEPOSIT FEE|SERVICE CHARGE|OVERDRAFT FEE|NSF FEE|STOP PAYMENT FEE|PAPER STATEMENT|RETURNED ITEM FEE/i
export const isFee = (l: any) => num(l.amount) > 0 && num(l.amount) <= 300 && !l.pending && (l.category === 'BANK_FEES' || FEE_RE.test(String(l.name || '')))
// Tarifa já lançada no app: vocabulário de tarifa E fornecedor Regions (revisão #5 —
// "Taxes & Fees" da concessionária ou "Plug Wire Set" não são tarifa bancária).
const FEE_LABEL = /\b(regions( bank)?|wire (transfer )?fee|analysis charge|service assessment|tarifa banc\w*|taxa banc\w*|bank fee)\b/i
const isFeeCand = (c: Cand) => { const segs = c.label.split(' · '); const sup = segs[segs.length - 1] || ''; return FEE_LABEL.test(c.label) && (/regions/i.test(sup) || (c.table === 'fixed_cost_expenses' && /^FIXO · regions/i.test(c.label))) }

// BL 0.7.0: NAME = ambíguo desempatado por nome/apelido (289 medidos em 31/ago);
// RULE = linha sem candidato de família conhecida que a regra humana manda CRIAR.
// BL 0.8.0 (AUTO-BOOK): regra casa por regex OU categoria do Plaid (pfc) OU
// chave de comerciante; origem HUMAN (digitada) ou LEARNED (aprendida do MATCH
// humano); alvo TRANSFER (status, sem lançamento — só regra humana com regex);
// direção; teto de valor. Precedência: HUMAN+regex > HUMAN só-pfc > LEARNED.
export type MerchantRule = { id: string; pattern: string | null; target: 'FIXED_EXPENSE' | 'INPUT' | 'TRANSFER' | 'BUCKET'; supplier_id: string | null; category: string | null; label: string | null; active: boolean; pfc_primary?: string | null; pfc_detailed?: string | null; origin?: 'HUMAN' | 'LEARNED' | 'DEFAULT' | null; merchant_key?: string | null; direction?: 'OUT' | 'IN' | 'ANY' | null; amount_max?: number | null; key?: string | null; klass?: string | null; priority?: number | null; created_at?: string | null }
export type PlanItem = { line: any; cand: Cand | null; engine: 'FEE' | 'EXACT' | 'NAME' | 'RULE' | 'LEARN' | 'BUCKET'; create: boolean; rule?: MerchantRule; adopt?: Sched; transfer?: boolean; cls?: Classified }
export type Plan = { items: PlanItem[]; skipped: Record<string, number> }
export type BuildOpts = { today?: string; minCreateAge?: number; itemTwins?: Set<string> }

// Chave de comerciante: o merchant_entity_id do Plaid (marca) ou o nome limpo.
export const merchantKey = (l: any): string | null => {
  if (l.entity) return String(l.entity)
  const m = String(l.merchant || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  return m || null
}
/* ─────────────── CLASSIFICADOR (fase B) ─────────────── */
// Cada linha ganha uma CLASSE canônica a partir do que existe nela: a categoria do
// Plaid (linhas Plaid), o MCC embutido no nome do extrato (linhas importadas de
// extrato: "PIN Purchase BP#… 5541 Orlando 7666" — 5541 é posto), ou a marca no
// nome. Puro, nunca gravado: calculado uma vez por linha em buildPlan/rota/fila.
export type Klass = 'TRANSFER' | 'BANK_FEE' | 'INCOME' | 'FUEL' | 'TOLLS' | 'CONVENIENCE' | 'GROCERY' | 'SUPERSTORE' | 'WHOLESALE_CLUB' | 'DISCOUNT_VARIETY' | 'HARDWARE' | 'HOME_SUPPLY' | 'AUTO_PARTS' | 'AUTO_SERVICE' | 'MARKETPLACE' | 'TEMU' | 'PAYPAL' | 'SQUARE' | 'POSTAGE' | 'MISC_RETAIL' | 'SERVICES' | 'SAAS' | 'ADVERTISING' | 'TELECOM' | 'UTILITY' | 'INSURANCE' | 'RENT' | 'GOVERNMENT' | 'ACCOUNTING' | 'RESTAURANT' | 'LODGING' | 'TRAVEL' | 'ENTERTAINMENT' | 'CLOTHING' | 'DEPT_STORE' | 'DRUGSTORE' | 'UNKNOWN'
export type Classified = { klass: Klass; via: 'MONEY' | 'PAYPAL' | 'FUEL' | 'NAME' | 'PFC' | 'MCC' | 'NONE'; mcc: string | null; counterparty: string | null; card: boolean }

// MCC no nome do extrato: o último token de 4 dígitos é o sufixo do cartão; antes
// dele pode vir "FL 32837" (estado + CEP); o primeiro token de 4 dígitos em
// [0700..9999] andando pra trás é o MCC.
export function mccOf(name: string | null | undefined): string | null {
  const t = String(name || '').trim().split(/\s+/)
  if (t.length < 2) return null
  let i = t.length - 1
  if (!/^\d{4}$/.test(t[i])) return null
  i--
  if (i >= 1 && /^\d{5}$/.test(t[i]) && /^[A-Z]{2}$/.test(t[i - 1])) i -= 2
  for (; i >= 0; i--) { if (/^\d{4}$/.test(t[i])) { const n = Number(t[i]); if (n >= 700 && n <= 9999) return t[i]; return null } }
  return null
}
export const isCardPurchase = (name: string | null | undefined) => /^(CARD|PIN) PURCHASE|^RECURRING CARD|^PAYPAL (PURCHASE|INST XFER|ECHECK)|^WALMART\.COM PURCHASE|^SQ \*/i.test(String(name || ''))
// Comerciante "limpo" de uma linha de extrato: tira o vocabulário do banco, corta no
// MCC, joga fora "#…" e dígitos, fica com as três primeiras palavras.
export function stmtMerchant(name: string | null | undefined): string {
  const mcc = mccOf(name)
  let t = String(name || '')
  if (mcc) t = t.slice(0, t.lastIndexOf(' ' + mcc + ' ') > 0 ? t.lastIndexOf(' ' + mcc + ' ') : undefined)
  // Tira TODO o vocabulário do banco na frente ("Recurring Card Transaction …" tem três).
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/^(card|pin|purchase|recurring|transaction|paypal|inst|xfer|echeck|gz28|v8|speeds?|pp)\b[\s*]*/i, '') }
  t = t.replace(/#\S*/g, ' ').replace(/\*/g, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.split(' ').filter(w => w.length >= 2).slice(0, 3).join(' ')
}
const BRAND: [Klass, RegExp][] = [
  ['SAAS', /AMAZON PRIME|PRIME VIDEO/i],                       // antes de MARKETPLACE (Amzn.com/bill)
  ['ADVERTISING', /METAPLATFOR|FACEBK|META PLATFORMS|FB\.ME|GOOGLE ?\*?ADS/i],   // antes de SAAS (GOOGLE)
  ['AUTO_PARTS', /AUTOZONE|ADVANCE AUTO|O'?REILLY|\bNAPA\b|ROCKAUTO|SUMMIT|JEGS|HPTUNER|HP TUNERS|DELAWAR|HIGH HORSE|\bHHP\b|TREPERF|T1 RACE|KONG PE|TITAN MOT|TEXASSPEE|TEXAS SPEED|\bZPE\b|GRIPTEC|PURED? ?RIVE|PURE DRIVE|MODERN MUSCLE|\bMMX\b|HALLTECH|DLAUTO|CENTRAL FLORID|JDM EXPRESS|INJECTOR DYN|O&J|OJ PERF|LINGENFELTER/i],
  ['AUTO_SERVICE', /MONTWAY|COPART|CARFAX|AUTO BODY|HYDRAULIC H|ALIGNMENT|DYNO|\bTIRE\b/i],
  ['MARKETPLACE', /AMAZON MKTP|AMZN MKTP|AMAZON RETA|AMAZON\.COM|AMZN\.COM|\bEBAY\b|WALMART\.COM|WAL-MART\.COM/i],
  ['TEMU', /\bTEMU\b/i],
  ['SAAS', /ANTHROPIC|CLAUDE\.AI|VERCEL|SUPABASE|DROPBOX|GOOGLE(?! ADS)|APPLE\.COM|PP\*APPLE|ITUNES|MICROSOFT|OPENAI|CHATGPT|MIDJOURNEY|LAGOSEC|NORDVPN|ULTRAMSG|TEAMVIEWER|GODADDY|RECRAFT|SKYWORK|GREEN-?API|ADOBE|CANVA|ZOOM\.US|NOTION|GITHUB|17TRACK|AMAZON PRIME|PRIME VIDEO/i],
  ['TELECOM', /T-?MOBILE|TMOBILE|VERIZON|AT&T|SPECTRUM|XFINITY|COMCAST/i],
  ['UTILITY', /DUKE ENERGY|\bDUKE\b|OCBCC|SOLID WAS|ORANGE COUNTY UTIL|\bOUC\b/i],
  ['INSURANCE', /PROGRESSIVE|GEICO|STATE FARM|ALLSTATE/i],
  ['RENT', /SPACE ORL|GRANDEFLATS|YARDI|VENTERRA|\bLUMA\b|\bSEMA\b/i],
  ['GOVERNMENT', /PMT\*ORANGE COUN|FLORIDA REVI|FL DEPT|\bDMV\b|SUNBIZ|\bIRS\b|USTREAS/i],
  ['TOLLS', /SUNPASS|E-?PASS|\bTOLL/i],
  ['POSTAGE', /UPS STORE|THE UPS|\bUSPS\b|FEDEX/i],
  ['HARDWARE', /HARBOR FREIGHT|SOUTH ORANGE AC|ACE HARDWARE|ACE HDWE|LOWE'?S|HOME DEPOT|NORTHERN TOOL|GRAINGER|FASTENAL|SKYCRAFT/i],
  ['GROCERY', /\bALDI\b|PUBLIX|SEABRA|BRAVO SUPER|WINN.?DIXIE|WHOLE FOODS|TRADER JOE/i],
  ['SUPERSTORE', /WAL-?MART(?!\.COM)|WM SUPERCENTER|\bTARGET\b/i],
  ['WHOLESALE_CLUB', /SAMS ?CLUB|SAM'S CLUB|COSTCO|BJ'?S WHOLESALE/i],
  ['DISCOUNT_VARIETY', /DOLLAR ?TREE|DOLLAR GENERAL|FAMILY DOLLAR|FIVE BELOW|BIG LOTS/i],
  ['CLOTHING', /\bROSS\b|MARSHALLS|TJ ?MAXX|HOMEGOODS|BURLINGTON|KOHL|MACY|OLD NAVY|\bGAP\b|SHEIN/i],
  ['DRUGSTORE', /WALGREENS|\bCVS\b|RITE AID/i],
  ['RESTAURANT', /LONGHORN|CHICK-FIL|MCDONALD|STARBUCKS|CHIPOTLE|OUTBACK|OLIVE GARDEN|DUNKIN|WENDY|BURGER KING|TACO BELL|SUBWAY|PIZZA|SUSHI|GRILL|RESTAURANT|CAFE|DOORDASH|UBER ?EATS/i],
  ['LODGING', /ORLANDO PALMS|HOTEL|\bINN\b|MARRIOTT|HILTON|HYATT|AIRBNB|VRBO/i],
  ['TRAVEL', /UNITED ?AIR|COPA ?AIR|AMERICAN ?AIR|DELTA ?AIR|SPIRIT ?AIR|JETBLUE|FRONTIER|\bUBER\b(?! ?EATS)|LYFT|HERTZ|AVIS|ENTERPRISE RENT|EXPEDIA|BOOKING\.COM/i],
  ['ACCOUNTING', /DRUMMOND|\bCPA\b/i],
  ['FUEL', /RACETRAC|WAWA|\bSHELL\b|\bBP\b|BP#|7-ELEVEN|CHEVRON|EXXON|SUNOCO|MARATHON|TEXACO|CIRCLE K|\bMOBIL\b|\bREBEL\b|MURPHY/i],
]
const PFC_MAP: [RegExp, Klass][] = [
  [/^TRANSPORTATION_GAS$/, 'FUEL'], [/^TRANSPORTATION_TOLLS$/, 'TOLLS'], [/^FOOD_AND_DRINK_GROCERIES$/, 'GROCERY'],
  [/^GENERAL_MERCHANDISE_SUPERSTORES$/, 'SUPERSTORE'], [/^GENERAL_MERCHANDISE_DISCOUNT_STORES$/, 'DISCOUNT_VARIETY'], [/^GENERAL_MERCHANDISE_CONVENIENCE_STORES$/, 'CONVENIENCE'],
  [/^HOME_IMPROVEMENT_HARDWARE$/, 'HARDWARE'], [/^HOME_IMPROVEMENT_(FURNITURE|OTHER)/, 'HOME_SUPPLY'], [/^GENERAL_MERCHANDISE_ONLINE_MARKETPLACES$/, 'MARKETPLACE'],
  [/^GENERAL_MERCHANDISE_(OTHER_GENERAL_MERCHANDISE|SPORTING_GOODS|ELECTRONICS)$/, 'MISC_RETAIL'], [/^GENERAL_SERVICES_AUTOMOTIVE$/, 'AUTO_SERVICE'],
  [/^GENERAL_SERVICES_(OTHER_GENERAL_SERVICES|EDUCATION)$/, 'SERVICES'], [/^GENERAL_SERVICES_POSTAGE_AND_SHIPPING$/, 'POSTAGE'],
  [/^GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING$/, 'ACCOUNTING'], [/^GENERAL_SERVICES_INSURANCE$/, 'INSURANCE'],
  [/^GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES$/, 'CLOTHING'], [/^GENERAL_MERCHANDISE_DEPARTMENT_STORES$/, 'DEPT_STORE'],
  [/^RENT_AND_UTILITIES_RENT$/, 'RENT'], [/^RENT_AND_UTILITIES_(GAS_AND_ELECTRICITY|WATER|SEWAGE_AND_WASTE_MANAGEMENT)$/, 'UTILITY'], [/^RENT_AND_UTILITIES_(TELEPHONE|INTERNET_AND_CABLE)$/, 'TELECOM'],
  [/^FOOD_AND_DRINK_/, 'RESTAURANT'], [/^TRAVEL_LODGING$/, 'LODGING'], [/^TRAVEL_|^TRANSPORTATION_(TAXIS_AND_RIDE_SHARES|PARKING|PUBLIC_TRANSIT)$/, 'TRAVEL'],
  [/^ENTERTAINMENT_/, 'ENTERTAINMENT'], [/^MEDICAL_/, 'DRUGSTORE'], [/^GOVERNMENT_AND_NON_PROFIT_/, 'GOVERNMENT'], [/^PERSONAL_CARE_/, 'CLOTHING'],
]
const MCC_MAP: Record<string, Klass> = {}
const mccSet = (codes: string, k: Klass) => { for (const c of codes.split(' ')) MCC_MAP[c] = k }
mccSet('5541 5542 5172', 'FUEL'); mccSet('5411 5422 5462', 'GROCERY'); mccSet('5499', 'CONVENIENCE'); mccSet('5300', 'WHOLESALE_CLUB'); mccSet('5310 5331 5399', 'DISCOUNT_VARIETY'); mccSet('5311', 'DEPT_STORE')
mccSet('5251 5072', 'HARDWARE'); mccSet('5200 5211 5712 5719 5722', 'HOME_SUPPLY'); mccSet('5531 5532 5533 5013 5085 5065', 'AUTO_PARTS'); mccSet('5511 7531 7538 7542 7549', 'AUTO_SERVICE')
mccSet('5942', 'MARKETPLACE'); mccSet('5968 5734 7372 7375 5815 5816 5817 5818', 'SAAS'); mccSet('4812 4814 4816 4899', 'TELECOM'); mccSet('4900', 'UTILITY'); mccSet('6513', 'RENT'); mccSet('6300 5960', 'INSURANCE')
mccSet('7311 7310', 'ADVERTISING'); mccSet('5812 5813 5814', 'RESTAURANT'); mccSet('7011', 'LODGING'); mccSet('4111 4121 4131 4511 7512', 'TRAVEL'); mccSet('4214 4215', 'POSTAGE'); mccSet('7399 7392 7299', 'SERVICES')
mccSet('8931', 'ACCOUNTING'); mccSet('9399 9311 9222', 'GOVERNMENT'); mccSet('5912 5122', 'DRUGSTORE'); mccSet('5611 5621 5651 5661 5691 5699', 'CLOTHING'); mccSet('7832 7841 7922 7991 7994 7996 7997 7998', 'ENTERTAINMENT')
mccSet('5732 5735 5940 5941 5945 5996 5999', 'MISC_RETAIL'); mccSet('6011', 'TRANSFER')
const mccKlass = (mcc: string | null): Klass | null => { if (!mcc) return null; if (MCC_MAP[mcc]) return MCC_MAP[mcc]; const n = Number(mcc); if (n >= 3501 && n <= 3999) return 'LODGING'; if (n >= 3000 && n <= 3500) return 'TRAVEL'; return null }
const MONEY_RE = /ZELLE|WIRE TRANSFER|^DEPOSIT|MOBILE DEPOSIT|CASH DEPOSIT|ATM WITHDRAWAL|^CHECK\b|TRANSFER OF FUNDS|ACCTVERIFY|PENNY TEST|^BANK DEBIT|LOAN PAYMENT/i
const brandOf = (text: string): Klass | null => { for (const [k, re] of BRAND) if (re.test(text)) return k; return null }

export function classify(l: any): Classified {
  const name = String(l.name || ''), merchant = String(l.merchant || ''), text = merchant + ' ' + name
  const pfc = String(l.pfc_detailed || ''), mcc = mccOf(name), card = isCardPurchase(name)
  const out: Classified = { klass: 'UNKNOWN', via: 'NONE', mcc, counterparty: null, card }
  // 1) dinheiro-movimento: transferência, tarifa, entrada
  // pfc de transferência por APP com marca de PEÇA no nome (Delawar = High Horse) é compra, não movimento (revisão 31); wire/Zelle no nome continuam parados.
  const pfcTransfer = /^(TRANSFER_|LOAN_PAYMENTS_)/.test(pfc)
  const partsViaApp = pfcTransfer && !MONEY_RE.test(name) && !/WIRE/i.test(pfc) && brandOf(text) === 'AUTO_PARTS'
  if (MONEY_RE.test(name) || (pfcTransfer && !partsViaApp)) return { ...out, klass: 'TRANSFER', via: 'MONEY' }
  if (isFee(l) || /^BANK_FEES_/.test(pfc)) return { ...out, klass: 'BANK_FEE', via: 'MONEY' }
  if (num(l.amount) < 0 || /^INCOME_/.test(pfc)) return { ...out, klass: 'INCOME', via: 'MONEY' }
  // 2) PayPal / Square: a contraparte decide; sem marca conhecida, a classe é o processador
  const cps = Array.isArray(l.cps) ? l.cps : []
  if (l.processor === 'PayPal' || /^PAYPAL|PAYPAL \*|PP\*|PAYPAL (PURCHASE|INST XFER|ECHECK|TRANSFER) GZ28/i.test(name)) {
    const m = name.match(/^Paypal (?:Purchase|Inst Xfer|Echeck|Transfer) Gz28 V8 Speeds?\s*(.*)$/i)
    const star = name.match(/Paypal \*\s*([^\d]+?)(?:\s+\d|$)/i)
    const pp = name.match(/\bPP\*\s*([^\d]+?)(?:\s+\d|$)/i)   // "Card Purchase Pp*metaplatfor 7311 …"
    const cp = cps.find((c: any) => c && c.type === 'merchant')?.name || (star && star[1]) || (pp && pp[1]) || (m && m[1]) || null
    // Marca da contraparte; sem marca, o MCC do comerciante (7311 = anúncio) ou a pfc decidem; só então «PAYPAL».
    const kb = cp ? brandOf(cp) : null
    const kf = kb || mccKlass(mcc) || (pfc ? (PFC_MAP.find(([re]) => re.test(pfc)) || [null, null])[1] : null)
    const kk = kf && !['MARKETPLACE', 'MISC_RETAIL', 'DISCOUNT_VARIETY', 'DEPT_STORE'].includes(kf) ? kf : (kb || 'PAYPAL')
    return { ...out, klass: kk as Klass, via: 'PAYPAL', counterparty: cp ? String(cp).trim() : null }
  }
  if (/^SQ \*|SQUARE/i.test(name)) { const cp = name.replace(/^SQ \*\s*/i, '').replace(/\d.*$/, '').trim() || null; const k = cp ? brandOf(cp) : null; return { ...out, klass: k || 'SQUARE', via: 'PAYPAL', counterparty: cp } }
  // 3) combustível por EVIDÊNCIA (Wawa/RaceTrac/Sams são bomba E loja — a evidência decide antes da marca)
  if (pfc === 'TRANSPORTATION_GAS' || (mcc && ['5541', '5542', '5172'].includes(mcc))) return { ...out, klass: 'FUEL', via: 'FUEL' }
  if (/_CONVENIENCE_STORES$/.test(pfc) || mcc === '5499') return { ...out, klass: 'CONVENIENCE', via: 'FUEL' }
  // 4) marca no nome
  const b = brandOf(text)
  if (b) return { ...out, klass: b, via: 'NAME' }
  // 5) categoria do Plaid
  if (pfc) for (const [re, k] of PFC_MAP) if (re.test(pfc)) return { ...out, klass: k, via: 'PFC' }
  // 6) MCC do extrato
  const mk = mccKlass(mcc)
  if (mk) return { ...out, klass: mk, via: 'MCC' }
  return out
}

// UM FORNECEDOR, UM NOME: o nome escrito é o do cadastro de suppliers (nome ou
// alias), nunca o texto cru do banco. Sem cadastro: merchant do Plaid, senão o
// comerciante limpo do extrato em Title Case, senão «Compra».
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase())
// Palavras que sozinhas nunca identificam fornecedor (o cadastro casa por PREFIXO —
// "The" casava "The Racers Edge…" e mandava a UPS Store pra TRE Performance).
const SUP_STOP = new Set(['the', 'card', 'pin', 'purchase', 'recurring', 'transaction', 'paypal', 'inst', 'xfer', 'echeck', 'store', 'inc', 'llc', 'com', 'www', 'usa', 'us', 'orlando', 'fl', 'online', 'shop', 'bill', 'sale'])
// Marcas conhecidas sem cadastro: um nome só, nunca o texto cru do extrato.
const CANON: [RegExp, string][] = [
  [/AMAZON|AMZN/i, 'Amazon'], [/WAL-?MART|WM SUPERCENTER/i, 'Walmart'], [/\bTARGET\b/i, 'Target'], [/HOME DEPOT/i, 'The Home Depot'], [/HARBOR FREIGHT/i, 'Harbor Freight'], [/WAYFAIR/i, 'Wayfair'],
  [/UPS STORE|THE UPS/i, 'The UPS Store'], [/SAMS ?CLUB|SAM'S CLUB/i, 'Sams Club'], [/\bALDI\b/i, 'Aldi'], [/PUBLIX/i, 'Publix'], [/SEABRA/i, 'Seabra Foods'], [/DOLLAR ?TREE/i, 'Dollar Tree'], [/FAMILY DOLLAR/i, 'Family Dollar'],
  [/RACETRAC/i, 'RaceTrac'], [/\bWAWA\b/i, 'Wawa'], [/\bBP\b|BP#/i, 'BP'], [/\bSHELL\b/i, 'Shell'], [/7-ELEVEN/i, '7-Eleven'], [/CHEVRON/i, 'Chevron'], [/TEXACO/i, 'Texaco'], [/\bREBEL\b/i, 'Rebel'],
  [/\bTEMU\b/i, 'Temu'], [/\bEBAY\b/i, 'eBay'], [/APPLE\.COM|PP\*APPLE|\bAPPLE\b/i, 'Apple'], [/ANTHROPIC|CLAUDE/i, 'Anthropic'], [/METAPLATFOR|FACEBK|META PLATFORMS/i, 'Meta Platforms'],
  [/SOUTH ORANGE AC/i, 'South Orange Ace Hardware'], [/ADVANCE AUTO/i, 'Advance Auto Parts'], [/AUTOZONE/i, 'AutoZone'], [/O'?REILLY/i, 'OReilly Auto Parts'],
  [/\bROSS\b/i, 'Ross'], [/MARSHALLS/i, 'Marshalls'], [/TJ ?MAXX/i, 'TJ Maxx'], [/HOMEGOODS/i, 'HomeGoods'], [/WALGREENS/i, 'Walgreens'], [/T-?MOBILE|TMOBILE/i, 'T-Mobile'], [/SUNPASS/i, 'SunPass'],
  [/OCBCC|SOLID WAS/i, 'Orange County Solid Waste'], [/ORLANDO PALMS/i, 'Orlando Palms Hotel'], [/UNITED ?AIR/i, 'United Airlines'], [/COPA ?AIR/i, 'Copa Airlines'], [/AMERICAN ?AIR/i, 'American Airlines'],
  [/HPTUNER|HP TUNERS/i, 'HP Tuners'], [/SUMMIT/i, 'Summit Racing Equipment'], [/KONG PE/i, 'Kong Performance'], [/MONTWAY/i, 'Montway'], [/DRUMMOND/i, 'Drummond Advisors'], [/PROGRESSIVE/i, 'Progressive'],
  [/DUKE ENERGY|\bDUKE\b/i, 'Duke Energy'], [/SPACE ORL/i, 'Space ORL'], [/GRANDEFLATS/i, 'Grandeflats'], [/\bSEMA\b/i, 'SEMA'], [/VERCEL/i, 'Vercel'], [/SUPABASE/i, 'Supabase'], [/ULTRAMSG/i, 'UltraMsg'], [/GODADDY/i, 'GoDaddy'], [/DROPBOX/i, 'Dropbox'], [/MICROSOFT/i, 'Microsoft'], [/OPENAI|CHATGPT/i, 'OpenAI'], [/MIDJOURNEY/i, 'Midjourney'],
]
export function supplierNameFor(l: any, cls: Classified, dir: SupplierEntry[]): string {
  // 1) cadastro (UM FORNECEDOR, UM NOME): chave exata vale sempre; prefixo só com 5+
  //    caracteres e nunca por uma palavra de parada sozinha.
  const usable = (q: string) => { const w = q.toLowerCase().split(/\s+/).filter(Boolean); return normSupLocal(q).length >= 3 && !(w.length === 1 && SUP_STOP.has(w[0])) }
  // Casamento ESTRITO com o cadastro (revisão 27/30): chave exata; ou a consulta é
  // PREFIXO de uma chave de 6+ ("Kong Perfor" → kongperformance) com 5+ caracteres;
  // ou o NOME inteiro do fornecedor é prefixo da consulta ("Titan Motorsports, 11370…").
  // Fragmento de alias ("orlando" saído do endereço da loja) nunca decide.
  const tryReg = (q: string | null | undefined): string | null => {
    if (!q || !usable(String(q))) return null
    const n = normSupLocal(String(q))
    if (n.length < 3) return null
    const exact = dir.find(d => d.keys.includes(n))
    if (exact) return exact.name
    const hits = dir.filter(d => d.keys.some(k => (k.length >= 6 && n.length >= 5 && k.startsWith(n)) || (k === normSupLocal(d.name) && k.length >= 6 && n.startsWith(k))))
    return hits.length === 1 ? hits[0].name : null
  }
  const merchant = /^(paypal|square|venmo|zelle|cash app)$/i.test(String(l.merchant || '').trim()) ? '' : l.merchant   // processador não é fornecedor
  for (const t of [cls.counterparty, merchant, stmtMerchant(l.name)]) { const r = tryReg(t); if (r) return r }
  const words = String(cls.counterparty || merchant || stmtMerchant(l.name) || '').split(/\s+/).filter(w => w && !SUP_STOP.has(w.toLowerCase()))
  for (let n = Math.min(3, words.length); n >= 1; n--) { const r = tryReg(words.slice(0, n).join(' ')); if (r) return r }
  // 2) marca conhecida
  const text = [cls.counterparty, l.merchant, l.name].filter(Boolean).join(' ')
  for (const [re, name] of CANON) if (re.test(text)) return name
  // 3) merchant do Plaid; 4) comerciante do extrato em Title Case; 5) «Compra»
  if (merchant) return String(merchant).trim().slice(0, 120)
  const sm = stmtMerchant(l.name)
  return (sm ? titleCase(sm) : 'Compra').slice(0, 120)
}
const normSupLocal = (x: string) => (x || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '').replace(/[^a-z0-9]/g, '')

type Compiled = { r: MerchantRule; re: RegExp | null }
export function compileRules(rules: MerchantRule[]): Compiled[] {
  // Precedência: HUMANA+regex > HUMANA só-pfc/classe > APRENDIDA > PADRÃO; dentro
  // da mesma faixa, prioridade e depois criação — ordem determinística (fetchAll
  // ordena por uuid, que é aleatório; fase B).
  const prec = (r: MerchantRule) => r.origin === 'LEARNED' ? 2 : r.origin === 'DEFAULT' ? 3 : r.pattern ? 0 : 1
  return rules.filter(r => r.active).map(r => { try { return { r, re: r.pattern ? new RegExp(r.pattern, 'i') : null } } catch { return null } })
    .filter(Boolean).sort((a, b) => (prec(a!.r) - prec(b!.r)) || ((a!.r.priority ?? 100) - (b!.r.priority ?? 100)) || String(a!.r.created_at || '').localeCompare(String(b!.r.created_at || '')) || String(a!.r.id).localeCompare(String(b!.r.id))) as Compiled[]
}
export function ruleMatches(x: Compiled, l: any, amt: number, cls?: Classified): boolean {
  const r = x.r
  const dir = r.direction || 'OUT'
  if (dir === 'OUT' && !(num(l.amount) > 0)) return false
  if (dir === 'IN' && !(num(l.amount) < 0)) return false
  const c = cls || classify(l)
  if (r.klass && c.klass !== r.klass) return false
  // Dinheiro-movimento e classe humana nunca entram por PADRÃO/classe — só regex HUMANA.
  if ((r.origin === 'DEFAULT' || r.klass) && HUMAN_TIER.has(c.klass) && !(x.re && (r.origin === 'HUMAN' || r.origin === 'DEFAULT'))) return false
  // UNKNOWN só chega ao balde pela regra com pattern de cartão.
  if (r.target === 'BUCKET' && c.klass === 'UNKNOWN' && !x.re) return false
  if (x.re) { const nm = String(l.name || ''), mc = String(l.merchant || ''); if (!(x.re.test(mc + ' ' + nm) || x.re.test(nm) || x.re.test(mc))) return false }   // ^ vale no nome E no merchant (revisão 24/28)
  if (r.merchant_key && merchantKey(l) !== r.merchant_key) return false
  if (r.pfc_primary && l.category !== r.pfc_primary) return false
  if (r.pfc_detailed && l.pfc_detailed !== r.pfc_detailed) return false
  if (r.amount_max != null && amt > num(r.amount_max)) return false
  return true
}
// Assinatura do feed duplicado: mesma (data, valor, nome) em 2+ conexões.
export const twinKey = (l: any) => String(l.date).slice(0, 10) + '|' + (num(l.amount) > 0 ? 'o' : 'i') + Math.abs(num(l.amount)).toFixed(2) + '|' + String(l.name || '').toUpperCase().trim()

// Decide o que é CERTO. Não escreve nada — quem escreve é applyPlan.
export function buildPlan(lines: any[], pool: Pool, rules: MerchantRule[] = [], opts: BuildOpts = {}): Plan {
  const compiled = compileRules(rules)
  const today = opts.today || todayNY()
  const plan: Plan = { items: [], skipped: {} }
  const skip = (k: string) => { plan.skipped[k] = (plan.skipped[k] || 0) + 1 }
  const used = new Set<string>()
  // Grupo consumido ⇒ membros fora; membro consumido ⇒ grupo fora (revisão #15).
  const consume = (c: Cand) => {
    used.add(c.table + ':' + c.id)
    if (c.table === 'purchase_group') for (const m of c.members || []) used.add(m.table + ':' + m.id)
    if (c.group) used.add('purchase_group:' + c.group)
  }
  const free = (c: Cand) => !used.has(c.table + ':' + c.id)
  const key = (l: any) => (num(l.amount) > 0 ? 'o' : 'i') + Math.abs(num(l.amount)).toFixed(2)
  const sorted = [...lines].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  for (const l of sorted) {
    const amt = Math.abs(num(l.amount))
    const cls = classify(l)
    // Feed duplicado (revisão D6): gêmea em OUTRA conexão nunca casa nem cria.
    if (opts.itemTwins && opts.itemTwins.has(twinKey(l))) { skip('gêmeo em outra conexão (feed duplicado)'); continue }
    if (isFee(l)) {
      const c = pool.out.filter(x => free(x) && Math.abs(x.amount - amt) < 0.011 && x.date && daysBetween(x.date, l.date) <= 7 && isFeeCand(x))
      if (c.length === 1) { consume(c[0]); plan.items.push({ line: l, cand: c[0], engine: 'FEE', create: false }) }
      else if (c.length > 1) skip('tarifa ambígua (2+ lançadas)')
      else plan.items.push({ line: l, cand: null, engine: 'FEE', create: true })
      continue
    }
    if (l.pending) { skip('pendente'); continue }
    const arr = num(l.amount) > 0 ? pool.out : pool.inn
    const same = arr.filter(x => free(x) && Math.abs(x.amount - amt) < 0.011)
    // Mesmo valor a mais de 30 dias não é a mesma compra (dry run da fase B: 168
    // linhas presas por coincidência de valor) — sem candidato PERTO, a regra decide.
    const near = same.filter(x => !x.date || daysBetween(x.date, l.date) <= 30)
    if (!near.length) {
      // Sem candidato: a REGRA decide (BL 0.7.0 → 0.8.0). TRANSFER = status sem
      // lançamento; FIXED_EXPENSE ADOTA a agendada do mês ou cria; INPUT cria.
      // Só saídas criam; maturidade de 7 dias evita o humano lançar depois.
      const rule = compiled.find(x => ruleMatches(x, l, amt, cls))
      if (!rule) {
        // Regra que casaria não fosse o TETO (revisão 32): rótulo próprio, pro dono ver o que o teto segura.
        const capped = compiled.find(x => x.r.amount_max != null && amt > num(x.r.amount_max) && ruleMatches(x, l, 0, cls))
        if (capped) { skip('acima do teto da regra ' + (capped.r.key || capped.r.label || '?') + ' ($' + num(capped.r.amount_max).toFixed(0) + ')'); continue }
        skip((same.length ? 'tem gêmeo no app — candidato longe' : 'sem candidato') + (HUMAN_TIER.has(cls.klass) ? ' (classe humana: ' + cls.klass + ')' : '')); continue
      }
      if (rule.r.target === 'TRANSFER') { plan.items.push({ line: l, cand: null, engine: 'RULE', create: false, transfer: true, rule: rule.r }); continue }
      if (!(num(l.amount) > 0)) { skip('entrada nunca cria'); continue }
      if (opts.minCreateAge && signedDays(l.date, today) < opts.minCreateAge) { skip(`aguardando maturidade (${opts.minCreateAge}d)`); continue }
      // Quase-gêmeo (revisão HIGH 2 / MEDIUM 26): gente lançou a MESMA compra sem o
      // imposto, ou com centavos de diferença (Anthropic por uso, Meta, recibo sem tax) —
      // vale pra TODA criação (regra, aprendida, balde). Só pula: nunca consome a linha do
      // app (consumir cegava a linha exata que vinha depois — reproduzido na revisão).
      {
        const tail = Math.max(0.30, 0.005 * amt)
        const nearTwin = arr.filter(x => free(x) && x.amount >= amt / 1.10 && x.amount <= amt + tail && x.date && daysBetween(x.date, l.date) <= 10 && nameHit(l, x))
        if (nearTwin.length) { skip('quase-gêmeo no app (nome + valor na faixa do imposto) — decida'); continue }
      }
      if (rule.r.target === 'BUCKET') {
        // BALDE (fase B): despesa real no mesmo dia, sem dono. Maturidade de 7 dias
        // também no APLICAR humano (a nota escaneada 3 dias depois costuma estar ali);
        // quase-gêmeo (mesmo nome, valor na faixa do imposto, 10 dias) nunca cria.
        const age = Math.max(opts.minCreateAge || 0, RULE_AGE_DAYS)
        if (signedDays(l.date, today) < age) { skip(`balde aguarda maturidade (${age}d)`); continue }
        plan.items.push({ line: l, cand: null, engine: 'BUCKET', create: true, rule: rule.r, cls }); continue
      }
      const engine: 'RULE' | 'LEARN' = rule.r.origin === 'LEARNED' ? 'LEARN' : 'RULE'
      if (rule.r.target === 'FIXED_EXPENSE') {
        const near = pool.sched.filter(s => s.supplier_id === rule.r.supplier_id && !used.has('sched:' + s.id) && !used.has('fixed_cost_expenses:' + s.id) && daysBetween(s.expense_date, l.date) <= ADOPT_WINDOW_DAYS)
        // Tolerância de valor (revisão do diff): agendada só é adotada se o valor
        // real ficar a ±50% (ou ≤ $100) do previsto — fora disso é OUTRA conta e
        // a linha fica pro humano (nunca sobrescreve o previsto às cegas).
        const cands = near.filter(s => Math.abs(s.amount - amt) <= Math.max(100, 0.5 * s.amount))
        if (near.length && !cands.length) { skip('agendada do mês com valor muito diferente (±50%)'); continue }
        cands.sort((a, b) => (daysBetween(a.expense_date, l.date) - daysBetween(b.expense_date, l.date)) || (Math.abs(a.amount - amt) - Math.abs(b.amount - amt)))
        const adopt = cands[0]
        if (adopt) { used.add('sched:' + adopt.id); used.add('fixed_cost_expenses:' + adopt.id) }
        plan.items.push({ line: l, cand: null, engine, create: true, adopt, rule: rule.r }); continue
      }
      plan.items.push({ line: l, cand: null, engine, create: true, rule: rule.r }); continue
    }
    // BL 0.7.0: ambíguo NÃO morre mais sem tentar o nome — se exatamente UM
    // candidato bate por nome/apelido, ele vence (engine NAME). Antes, o skip
    // vinha antes do nameHit e o desempate nunca rodava (289 linhas medidas).
    let c: Cand
    let engineTag: 'EXACT' | 'NAME' = 'EXACT'
    if (near.length === 1) c = near[0]
    else {
      const byName = near.filter(x => nameHit(l, x))
      if (byName.length !== 1) { skip('tem gêmeo no app — candidato ambíguo'); continue }
      c = byName[0]; engineTag = 'NAME'
    }
    if (!c.date) { skip('candidato sem data'); continue }
    const dd = daysBetween(c.date, l.date)
    if (dd > (c.undated ? 7 : 3)) { skip('tem gêmeo no app — mais de 3 dias'); continue }
    // Unicidade do lado do BANCO: outra linha NEW com mesmo valor e direção a ±30d.
    const twins = sorted.filter(o => o !== l && key(o) === key(l) && daysBetween(o.date, l.date) <= 30)
    if (twins.length) { skip('valor repetido no banco'); continue }
    const rep45 = sorted.filter(o => o !== l && key(o) === key(l) && daysBetween(o.date, l.date) <= 45).length
    if (rep45 >= 2) { skip('série (≥3× em 45d)'); continue }
    if (!nameHit(l, c)) { skip('tem gêmeo no app — nome não bate'); continue }
    if (amt % 50 === 0 && amt < 1000) { skip('valor redondo < $1k'); continue }
    consume(c)
    plan.items.push({ line: l, cand: c, engine: engineTag, create: false })
  }
  return plan
}

// Impressão digital do plano: APLICAR só roda o plano que o Márcio VIU (revisão #22).
export function planHash(plan: Plan): string {
  const ids = plan.items.map(i => i.line.id + '>' + (i.cand ? i.cand.table + ':' + i.cand.id : i.adopt ? 'adopt:' + i.adopt.id : i.transfer ? 'transfer' : i.engine === 'BUCKET' ? 'bucket' : 'create') + (i.rule ? '#' + i.rule.id : '')).sort()
  let h = 5381; for (const s of ids) for (let k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) >>> 0
  return ids.length + '-' + h.toString(36)
}

export const planSummary = (plan: Plan) => {
  const fee = plan.items.filter(i => i.engine === 'FEE'), exact = plan.items.filter(i => i.engine === 'EXACT')
  const name = plan.items.filter(i => i.engine === 'NAME')
  const creates = plan.items.filter(i => (i.engine === 'RULE' || i.engine === 'LEARN') && i.create)
  const learn = plan.items.filter(i => i.engine === 'LEARN'), transfer = plan.items.filter(i => i.transfer)
  const bucket = plan.items.filter(i => i.engine === 'BUCKET')
  const byKlass: Record<string, number> = {}
  for (const i of bucket) { const k = i.cls?.klass || '?'; byKlass[k] = (byKlass[k] || 0) + 1 }
  const ruleLabel = (i: PlanItem) => { const l = i.line, r = i.rule!; const base = `${l.date} · ${l.merchant || l.name} · $${Math.abs(num(l.amount)).toFixed(2)}`
    if (i.adopt) return `${base} → ADOTA agendada de ${i.adopt.expense_date} ($${i.adopt.amount.toFixed(2)} → $${Math.abs(num(l.amount)).toFixed(2)})${r.label ? ' · ' + r.label : ''}`
    return `${base} → CRIA ${r.target === 'INPUT' ? 'SUPPLY ' + (r.category || 'CONSUMPTION') : 'despesa do fornecedor'}${r.label ? ' · ' + r.label : ''}${i.engine === 'LEARN' ? ' (regra aprendida)' : ''}` }
  return {
    fee_create: fee.filter(i => i.create).length, fee_match: fee.filter(i => !i.create).length, exact: exact.length,
    name: name.length, rule_create: creates.filter(i => !i.adopt).length, rule_adopt: creates.filter(i => !!i.adopt).length,
    learn: learn.length, transfer: transfer.length, bucket: bucket.length, by_klass: byKlass,
    total: plan.items.length, skipped: plan.skipped, hash: planHash(plan),
    samples: {
      bucket: bucket.slice(0, 8).map(({ line: l, cls, rule: r }) => `${l.date} · ${l.merchant || l.name} · $${Math.abs(num(l.amount)).toFixed(2)} → A ATRIBUIR (${cls?.klass || '?'} via ${cls?.via || '?'})${r?.label ? ' · ' + r.label : ''}`),
      fee: fee.filter(i => i.create).slice(0, 5).map(({ line: l }) => `${l.date} · ${l.name} · $${Math.abs(num(l.amount)).toFixed(2)}`),
      exact: exact.slice(0, 12).map(({ line: l, cand: c }) => `${l.date} · ${l.merchant || l.name} · ${num(l.amount) > 0 ? '−' : '+'}$${Math.abs(num(l.amount)).toFixed(2)} ⇄ ${c!.label}`),
      name: name.slice(0, 8).map(({ line: l, cand: c }) => `${l.date} · ${l.merchant || l.name} · $${Math.abs(num(l.amount)).toFixed(2)} ⇄ ${c!.label} (desempate por nome)`),
      rule: creates.slice(0, 8).map(ruleLabel),
      transfer: transfer.slice(0, 5).map(({ line: l, rule: r }) => `${l.date} · ${l.merchant || l.name} · ${num(l.amount) > 0 ? '−' : '+'}$${Math.abs(num(l.amount)).toFixed(2)} → TRANSFER${r?.label ? ' · ' + r.label : ''}`),
    },
  }
}

/* ─────────────── ESCRITA (humano e motor usam o mesmo) ─────────────── */

// 1) TRANCA a linha do banco (NEW → MATCHED). 0 linhas = outra aba/sync já
//    decidiu ⇒ erro, nada no app foi tocado. 2) Backfill no app, guardando
//    EXATAMENTE o que escreveu. 3) Grava `backfill` na linha. (revisões #6 #7 #11)
// DIÁRIO DA CONCILIAÇÃO (31/ago — reset do Márcio apagou todo o casamento):
// toda decisão vira linha em bank_match_log, estruturada e re-aplicável
// (action=restore_log no route). Log nunca derruba a operação: erro engolido.
export async function logMatchEvent(db: any, line: any, action: string, fields: { matched_table?: string | null; matched_id?: string | null; note?: unknown; engine?: unknown; batch?: unknown; members?: unknown }) {
  try {
    await db.from('bank_match_log').insert({
      bank_id: String(line.id), bank_date: line.date || null, bank_name: (line.name || line.merchant || '').slice(0, 200) || null,
      bank_amount: num(line.amount) || null, action,
      matched_table: fields.matched_table || null, matched_id: fields.matched_id || null,
      note: fields.note != null ? String(fields.note).slice(0, 300) : null,
      engine: fields.engine != null ? String(fields.engine) : null,
      batch: fields.batch != null ? String(fields.batch) : null,
      members: fields.members || null,
    })
  } catch { /* diário nunca derruba a conciliação */ }
}

// `pre` (BL 0.8.0) = escritas que o chamador JÁ fez no app antes de trancar a
// linha (adoção da agendada: valor/paid_from/elo) — entram no `backfill` pra
// DESFAZER devolver cada campo ao valor anterior.
export async function writeMatch(db: any, line: any, cand: Cand | { table: string; id: string; members?: Member[] }, extra: Record<string, unknown>, pre: Backfill[] = []): Promise<{ backfill: Backfill[] }> {
  const { data: claimed, error: claimErr } = await db.from('bank_transactions')
    .update({ match_status: 'MATCHED', matched_table: cand.table, matched_id: cand.id, backfill: null, ...extra })
    .eq('id', line.id).eq('match_status', 'NEW').select('id')
  if (claimErr) throw new Error(claimErr.message)
  if (!claimed || !claimed.length) throw new Error('linha do banco já decidida (outra aba ou sync) — recarregue')
  await logMatchEvent(db, line, 'MATCH', { matched_table: cand.table, matched_id: cand.id, note: (extra as any).matched_note, engine: (extra as any).match_engine, batch: (extra as any).match_batch, members: (cand as any).members || null })
  const backfill: Backfill[] = [...pre]
  const fill = async (table: string, ids: string[], field: 'payment_date' | 'paid_at', value: string) => {
    if (!ids.length) return
    const { data, error } = await db.from(table).update({ [field]: value }).in('id', ids).is(field, null).select('id')
    if (error) throw new Error(`${table}: ${error.message}`)
    for (const r of data || []) backfill.push({ t: table, id: r.id, f: field, v: value })
  }
  if (DATE_TABLES.has(cand.table)) await fill(cand.table, [cand.id], 'payment_date', line.date)
  else if (cand.table === 'invoice_payments') await fill('invoice_payments', [cand.id], 'paid_at', paidAtFor(line.date))
  else if (cand.table === 'purchase_group' || cand.table === 'kit_group') {
    // Só os MEMBROS que formaram o total do grupo (revisão #18), nunca "todo mundo do grupo".
    const byTable = new Map<string, string[]>()
    for (const m of cand.members || []) byTable.set(m.table, [...(byTable.get(m.table) || []), m.id])
    for (const [t, ids] of byTable) await fill(t, ids, 'payment_date', line.date)
  }
  if (backfill.length) {
    const { error } = await db.from('bank_transactions').update({ backfill }).eq('id', line.id)
    if (error) throw new Error('backfill registrado no app mas não na linha do banco: ' + error.message)
  }
  return { backfill }
}

// REPASSE (João, 26/ago): acha a invoice do wire que CAUSOU a tarifa — wire
// ÚNICO no dia (±1), mesma direção (INCOMING fee ⇐ wire que entrou; OUT fee ⇐
// wire que saiu), sem vocabulário de tarifa, já CASADO com a invoice. 0 ou 2+
// wires no dia = ambíguo = null (a tarifa segue pro Regions Bank, como sempre).
async function wireInvoiceFor(db: any, l: any): Promise<{ invoice_id: string; code: string } | null> {
  const d = Date.parse(String(l.date || '').slice(0, 10))
  if (!d) return null
  const d0 = new Date(d - 864e5).toISOString().slice(0, 10), d1 = new Date(d + 864e5).toISOString().slice(0, 10)
  const { data } = await db.from('bank_transactions').select('name, amount, matched_table, matched_id')
    .gte('date', d0).lte('date', d1).ilike('name', '%WIRE%').eq('match_status', 'MATCHED')
  const wantIn = /INCOMING/i.test(String(l.name || ''))
  const wires = (data || []).filter((w: any) => !FEE_RE.test(String(w.name || '')) && (wantIn ? num(w.amount) < 0 : num(w.amount) > 0) && ['invoice_payments', 'invoice_expenses', 'invoice_parts'].includes(String(w.matched_table)))
  if (wires.length !== 1) return null
  const w = wires[0]
  const { data: src } = await db.from(w.matched_table).select('invoice_id').eq('id', w.matched_id).maybeSingle()
  if (!src?.invoice_id) return null
  const { data: inv } = await db.from('invoices').select('id, invoice_code, is_quote').eq('id', src.invoice_id).maybeSingle()
  return inv && !inv.is_quote ? { invoice_id: inv.id, code: inv.invoice_code || '' } : null
}

// DESFAZER: reverte só o que `backfill` diz que escrevemos (valor igual ⇒ ninguém
// mexeu depois); linha sem registro (casada antes da v0.3.0) usa a regra antiga
// de igualdade com a data do banco. Tarifa criada pelo motor é apagada. Cada
// passo checa erro; a linha do banco é a ÚLTIMA escrita. (revisões #6 #10)
// BL 0.8.0 (revisão): a ordem importa — PRIMEIRO reverte o backfill (a agendada
// adotada volta ao valor/paid_from original e SOLTA o elo bank_transaction_id),
// DEPOIS apaga o que o motor CRIOU (marcador no texto + elo com a linha — nunca
// pelo engine sozinho, nunca linha de gente). RULE/LEARN entram na deleção:
// antes, DESFAZER deixava a despesa criada por regra viva no DRE (risco #2).
export async function writeUnmatch(db: any, line: any, changed: string[], opts: { unlearn?: boolean } = {}) {
  let bucketHandled = false
  if (line.match_status === 'MATCHED' && line.matched_table && line.matched_id) {
    const t = line.matched_table as string, id = line.matched_id as string
    const recorded: Backfill[] | null = Array.isArray(line.backfill) ? line.backfill : null
    if (String(line.match_engine) === ENGINE_BUCKET) {
      // BALDE (fase B): antes de escrever qualquer coisa, TUDO que o motor criou ou
      // moveu por esta linha ainda tem o marcador «Bank Link»? Linha editada por
      // gente nunca é apagada — o DESFAZER inteiro é recusado.
      // A cópia do chamador pode estar velha (DESFAZER LOTE lê centenas de linhas e
      // outra pessoa atribui uma no meio — revisão 25): relê e aborta se mudou.
      const { data: cur } = await db.from('bank_transactions').select('reviewed_at, matched_table, matched_id, match_batch').eq('id', line.id).maybeSingle()
      if (!cur || String(cur.reviewed_at || '') !== String(line.reviewed_at || '') || String(cur.matched_id || '') !== String(line.matched_id || '') || String(cur.matched_table || '') !== String(line.matched_table || '')) throw new Error('linha mudou enquanto desfazia — recarregue')
      const bucketId = await bucketInvoiceId(db)
      const reach = await bucketReach(db, line, bucketId)
      const dirty = reach.filter(r => !/Bank Link/.test(r.text))
      if (dirty.length) throw new Error('linha editada por gente — desfaça na invoice (' + [...new Set(dirty.map(r => r.table))].join(', ') + ')')
      // Ponteiro morto (tudo já apagado no editor) não tem o que proteger — o DESFAZER passa (revisão 12).
      if (line.matched_table === 'purchase_group' && reach.length) {
        const expected = await lastMatchMembersCount(db, line.id)
        if (expected != null && reach.filter(r => r.table !== 'invoice_expenses' || r.text.includes(MARKER_ASSIGNED) || r.text.includes(MARKER_BUCKET)).length < expected) throw new Error('parte editada por gente — desfaça na invoice')
      }
      bucketHandled = true
    }
    if (recorded) {
      for (const b of recorded) {
        const prev = b.o === undefined ? null : b.o
        const { data: r, error } = await db.from(b.t).update({ [b.f]: prev }).eq('id', b.id).eq(b.f, b.v).select('id')
        if (error) throw new Error(`${b.t}: ${error.message}`)
        if (r && r.length) changed.push(`${b.t}.${b.f}→${prev ?? 'null'}`)
      }
    }
    if (['FEE', 'RULE', 'LEARN'].includes(String(line.match_engine)) && t === 'fixed_cost_expenses') {
      // Adotada já foi solta pelo revert acima (bank_transaction_id → null): o
      // .eq('bank_transaction_id') a poupa por construção; só a CRIADA morre.
      const { data: r, error } = await db.from('fixed_cost_expenses').delete().eq('id', id).eq('bank_transaction_id', line.id).ilike('description', '%Bank Link)%').not('description', 'ilike', '%agendada)%').select('id')
      if (error) throw new Error('fixed_cost_expenses: ' + error.message)
      if (r && r.length) changed.push(line.match_engine === 'FEE' ? 'tarifa criada pelo motor apagada' : 'despesa criada por regra apagada')
    }
    if (['RULE', 'LEARN'].includes(String(line.match_engine)) && t === 'inputs') {
      const { data: r, error } = await db.from('inputs').delete().eq('id', id).eq('order_number', ('bank:' + line.id).slice(0, 120)).ilike('description', '%' + MARKER_CREATED + '%').select('id')
      if (error) throw new Error('inputs: ' + error.message)
      if (r && r.length) changed.push('supply criado por regra apagado')
    }
    if (bucketHandled) {
      // Apaga por marcador + elo, em todas as casas onde a linha pode ter ido:
      // balde, insumo/estoque atribuído, custo fixo atribuído (criado — a adotada
      // voltou pelo backfill), partes divididas em invoices. Tudo ou nada.
      const bucketId = await bucketInvoiceId(db)
      const del = async (table: string, f: (q: any) => any, col: string, msg: string) => {
        const { data: r, error } = await f(db.from(table).delete().eq('purchase_group', line.id).ilike(col, '%Bank Link)%')).select('id')
        if (error) throw new Error(table + ': ' + error.message)
        if (r && r.length) changed.push(msg + (r.length > 1 ? ' ×' + r.length : ''))
      }
      // Elo com o STREAM (PESCA fundida) morre junto com a linha apagada.
      { const { data: ids } = await db.from('invoice_expenses').select('id').eq('purchase_group', line.id).ilike('item', '%Bank Link)%'); const list = (ids || []).map((x: any) => x.id); if (list.length) await db.from('part_stream_items').delete().eq('source_table', 'invoice_expenses').in('source_id', list).then(() => undefined, () => undefined) }
      await del('invoice_expenses', q => q.eq('invoice_id', bucketId), 'item', 'compra do balde apagada')
      await del('inputs', q => q, 'description', 'insumo atribuído apagado')
      await del('inventory', q => q, 'description', 'estoque atribuído apagado')
      {
        const { data: r, error } = await db.from('fixed_cost_expenses').delete().eq('bank_transaction_id', line.id).ilike('description', '%Bank Link)%').not('description', 'ilike', '%agendada)%').select('id')
        if (error) throw new Error('fixed_cost_expenses: ' + error.message)
        if (r && r.length) changed.push('custo fixo atribuído apagado')
      }
      // Partes divididas só quando a linha É uma divisão — uma linha atribuída a CARRO tem a mesma cara e voltou pelo backfill (revisão 25).
      if (line.matched_table === 'purchase_group') await del('invoice_expenses', q => q.neq('invoice_id', bucketId).ilike('item', '%' + MARKER_ASSIGNED + '%'), 'item', 'parte dividida apagada')
    }
    if (line.match_engine === 'FEE' && t === 'invoice_expenses') {
      // REPASSE (João, 26/ago): a despesa de invoice que o motor criou pra tarifa
      // de wire morre junto — o marcador "(auto Bank Link)" no item garante que
      // NUNCA apagamos linha lançada por gente.
      const { data: r, error } = await db.from('invoice_expenses').delete().eq('id', id).ilike('item', '%repasse (auto Bank Link)%').select('id')
      if (error) throw new Error('invoice_expenses: ' + error.message)
      if (r && r.length) changed.push('repasse criado pelo motor apagado')
    }
    if (recorded || bucketHandled) { /* já revertido acima / balde já tratado */ } else if (DATE_TABLES.has(t)) {
      const { data: r, error } = await db.from(t).update({ payment_date: null }).eq('id', id).eq('payment_date', line.date).select('id')
      if (error) throw new Error(`${t}: ${error.message}`)
      if (r && r.length) changed.push(`${t}.payment_date→null`)
    } else if (t === 'invoice_payments') {
      const { data: r, error } = await db.from('invoice_payments').update({ paid_at: null }).eq('id', id).eq('paid_at', paidAtFor(line.date)).select('id')
      if (error) throw new Error('invoice_payments: ' + error.message)
      if (r && r.length) changed.push('invoice_payments.paid_at→null')
    } else if (t === 'purchase_group') {
      for (const g of ['goods', 'inputs', 'inventory', 'invoice_expenses']) {
        const { data: r, error } = await db.from(g).update({ payment_date: null }).eq('purchase_group', id).eq('payment_date', line.date).select('id')
        if (error) throw new Error(`${g}: ${error.message}`)
        if (r && r.length) changed.push(`${g}×${r.length}.payment_date→null`)
      }
    } else if (t === 'kit_group') {
      const { data: r, error } = await db.from('invoice_parts').update({ payment_date: null }).eq('kit_group', id).eq('payment_date', line.date).select('id')
      if (error) throw new Error('invoice_parts: ' + error.message)
      if (r && r.length) changed.push(`invoice_parts×${r.length}.payment_date→null`)
    }
  }
  // PAID FROM cravado por causa DESTE casamento (bulk CERTO do Data Checker,
  // trilha check_key 'paid-from' + label 'CERTO (Regions)') volta a vazio —
  // desfazer o casamento desfaz a prova (revisão #20).
  if (line.match_status === 'MATCHED' && line.matched_table && line.matched_id) {
    const targets: { t: string; id: string }[] = line.matched_table === 'purchase_group' ? [] : [{ t: line.matched_table, id: line.matched_id }]
    if (line.matched_table === 'purchase_group') for (const g of ['goods', 'inputs', 'inventory', 'invoice_expenses']) {
      const { data: ms } = await db.from(g).select('id').eq('purchase_group', line.matched_id)
      for (const m of ms || []) targets.push({ t: g, id: m.id })
    }
    for (const tg of targets) {
      const { data: fx } = await db.from('data_fixes').select('id').eq('check_key', 'paid-from').eq('table_name', tg.t).eq('row_id', tg.id).eq('new_value', 'GZ28US').ilike('label', 'CERTO (Regions)%').limit(1)
      if (fx && fx.length) {
        const { data: r } = await db.from(tg.t).update({ paid_from: null }).eq('id', tg.id).eq('paid_from', 'GZ28US').select('id')
        if (r && r.length) changed.push(tg.t + '.paid_from→null (era prova do casamento)')
      }
    }
  }
  // DESFAZER de linha LEARN pausa a regra aprendida (desaprende) — só no undo
  // por linha; DESFAZER LOTE passa unlearn:false (o lote não é juízo da regra).
  if (opts.unlearn && line.match_engine === 'LEARN' && line.match_rule) {
    const { data: r } = await db.from('bank_merchant_rules').update({ active: false, paused_reason: 'pausada por DESFAZER em ' + todayNY() }).eq('id', line.match_rule).eq('origin', 'LEARNED').select('id')
    if (r && r.length) changed.push('regra aprendida pausada')
  }
  const update = { match_status: 'NEW', matched_table: null, matched_id: null, matched_note: null, match_engine: null, match_batch: null, match_rule: null, reviewed_at: null, backfill: null }
  const { data, error } = await db.from('bank_transactions').update(update).eq('id', line.id).eq('match_status', line.match_status).select('id')
  if (error) throw new Error(error.message)
  if (!data || !data.length) throw new Error('linha mudou enquanto desfazia — recarregue')
  return update
}

// STATUS sem lançamento (TRANSFER / IGNORED / QUEUED) — funil único pra humano,
// regra e restore_log: tranca a linha NEW, carimba engine/batch/rule, diário.
export async function writeStatus(db: any, line: any, status: 'IGNORED' | 'TRANSFER' | 'QUEUED', extra: { note?: string | null; engine?: string | null; batch?: string | null; rule?: string | null } = {}) {
  const { data, error } = await db.from('bank_transactions')
    .update({ match_status: status, matched_note: extra.note ?? null, matched_table: null, matched_id: null, match_engine: extra.engine ?? null, match_batch: extra.batch ?? null, match_rule: extra.rule ?? null, reviewed_at: null, backfill: null })
    .eq('id', line.id).eq('match_status', 'NEW').select('id')
  if (error) throw new Error(error.message)
  if (!data || !data.length) throw new Error('linha do banco já decidida — recarregue')
  await logMatchEvent(db, line, status === 'IGNORED' ? 'IGNORE' : status === 'TRANSFER' ? 'TRANSFER' : 'QUEUE', { note: extra.note, engine: extra.engine, batch: extra.batch })
}

async function regionsSupplier(db: any): Promise<string> {
  const { data } = await db.from('fixed_cost_suppliers').select('id').ilike('company', 'Regions Bank%').limit(1).maybeSingle()
  if (data?.id) return data.id
  const { data: ins, error } = await db.from('fixed_cost_suppliers').insert({ company: 'Regions Bank', description: 'Tarifas da conta •9336 — wire fee, analysis charge, international service assessment (criado pelo motor FEE do Bank Link)', cost_type: 'BANK', periodicity: 'MONTHLY' }).select('id').single()
  if (error || !ins) throw new Error('não consegui criar o fornecedor "Regions Bank": ' + (error?.message || '?'))
  return ins.id
}

// Paralelismo limitado: N linhas em voo, cada uma com suas escritas em ordem.
async function pmap<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it) } }))
}

export type ApplyResult = { batch: string; fee_match: number; fee_create: number; exact: number; name: number; rule_create: number; rule_adopt: number; learn: number; transfer: number; bucket: number; remaining: number; errors: string[] }

// Aplica até `max` itens do plano a partir de `offset` (o cliente repete enquanto
// remaining > 0 — revisão #12: 317 linhas × 2–3 idas ao banco não cabem num request).
// Tarifa: acha/cria a linha do custo fixo → tranca a linha do banco; se a
// trava falhar, apaga a tarifa recém-criada (nada órfão — revisão #7).
// BL 0.8.0: TRANSFER por regra (status, sem lançamento); FIXED_EXPENSE ADOTA a
// agendada do mês (valor ajustado, elo gravado no backfill pra DESFAZER) ou cria;
// INPUT cria; LEARN = regra aprendida (mesmo caminho, contado à parte).
export async function applyPlan(db: any, plan: Plan, opts: { max?: number; batch?: string; offset?: number } = {}): Promise<ApplyResult> {
  const max = opts.max || 150
  const offset = opts.offset || 0
  const batch = opts.batch || randomUUID()
  const slice = plan.items.slice(offset, offset + max)
  const res: ApplyResult = { batch, fee_match: 0, fee_create: 0, exact: 0, name: 0, rule_create: 0, rule_adopt: 0, learn: 0, transfer: 0, bucket: 0, remaining: Math.max(0, plan.items.length - offset - slice.length), errors: [] }
  const lineLabel = (l: any) => `${l.date} · ${l.merchant || l.name || ''} · ${num(l.amount)}`
  const fix = (row_id: string, label: string, newValue = 'MATCHED') => ({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id, field: 'match_status', old_value: 'NEW', new_value: newValue, label: label.slice(0, 200) })
  let supplierId: string | null = null
  if (slice.some(i => i.engine === 'FEE' && i.create)) supplierId = await regionsSupplier(db)
  // Fase B: o balde e o nome canônico do fornecedor (UM FORNECEDOR, UM NOME) —
  // resolvidos uma vez por fatia, só quando a fatia precisa.
  let bucketId = ''
  let dir: SupplierEntry[] = []
  if (slice.some(i => i.engine === 'BUCKET' || (i.create && !!i.rule))) dir = supplierDirectoryFrom(await fetchAll(db, 'suppliers', 'id, name, aliases, is_dealership'))
  if (slice.some(i => i.engine === 'BUCKET')) bucketId = await bucketInvoiceId(db)
  const fixes: any[] = []
  await pmap(slice, 6, async (it) => {
    const l = it.line
    // Só desfaz o que ainda é NOSSO (revisão do diff, 3/set): se a linha já
    // aponta pro rowId, OUTRO aplicador trancou a linha usando a linha que a
    // gente criou/adotou — deixar quieto, nunca apagar/desadotar.
    const stillOurs = async (table: string, rowId: string) => {
      const { data } = await db.from('bank_transactions').select('matched_table, matched_id').eq('id', l.id).maybeSingle()
      return !(data && data.matched_table === table && String(data.matched_id) === String(rowId))
    }
    try {
      if (it.transfer && it.rule) {
        const r = it.rule
        await writeStatus(db, l, 'TRANSFER', { note: ('AUTO · RULE · TRANSFER · ' + (r.label || l.merchant || l.name || '')).slice(0, 150), engine: 'RULE', batch, rule: r.id })
        res.transfer++
        fixes.push(fix(l.id, 'RULE → TRANSFER · ' + lineLabel(l), 'TRANSFER'))
      } else if (it.engine === 'FEE' && it.create) {
        // BOOKKEEPING, não cobrança (João, 26/ago, 2º ato): cobrar o cliente
        // DEPOIS do wire é ideia morta — o preço cobre a tarifa ANTES, na
        // montagem da invoice. A tarifa mora SEMPRE em /costs/bank; quando o
        // wire causador já está casado (único no dia, mesma direção), a
        // atribuição entra como ANOTAÇÃO na descrição e na nota — nada de criar
        // despesa na invoice.
        const attr = /WIRE/i.test(String(l.name || '')) ? await wireInvoiceFor(db, l) : null
        const desc = `${String(l.name || 'Tarifa bancária').trim()} — tarifa Regions •9336 (auto · Bank Link)${attr ? ` · causada pelo wire da ${attr.code || 'invoice'}` : ''}`
        // Reaproveita se uma tentativa anterior já criou (retry idempotente).
        const { data: prev } = await db.from('fixed_cost_expenses').select('id').eq('bank_transaction_id', l.id).maybeSingle()
        let rowId: string = prev?.id || ''
        if (!rowId) {
          const { data: row, error } = await db.from('fixed_cost_expenses').insert({
            supplier_id: supplierId, type: 'SINGLE', description: desc.slice(0, 200), amount: Math.abs(num(l.amount)), source: 'GZ28US',
            expense_date: l.date, payment_date: l.date, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: l.id,
          }).select('id').single()
          if (error || !row) throw new Error(error?.message || 'insert falhou')
          rowId = row.id
        }
        try {
          await writeMatch(db, l, { table: 'fixed_cost_expenses', id: rowId }, { matched_note: 'AUTO · FEE · TARIFA · ' + desc.slice(0, 150), match_engine: 'FEE', match_batch: batch, reviewed_at: null })
        } catch (e) {
          if (!prev && await stillOurs('fixed_cost_expenses', rowId)) await db.from('fixed_cost_expenses').delete().eq('id', rowId).eq('bank_transaction_id', l.id)
          throw e
        }
        res.fee_create++
        fixes.push(fix(l.id, 'FEE criou tarifa' + (attr ? ' (wire da ' + attr.code + ')' : '') + ' · ' + lineLabel(l)))
      } else if ((it.engine === 'RULE' || it.engine === 'LEARN') && it.create && it.rule) {
        // A REGRA (humana ou aprendida) cria o lançamento que nunca foi feito e
        // casa na hora — mesmo padrão do motor FEE (idempotente no retry).
        const r = it.rule
        const tag = it.engine
        const amtAbs = Math.abs(num(l.amount))
        const bankName = String(l.merchant || l.name || 'Compra').trim()
        const canon = supplierNameFor(l, it.cls || classify(l), dir)   // UM FORNECEDOR, UM NOME também na descrição (revisão)
        // UMA DATA (lei do Márcio): expense_date = purchase_date = payment_date = data
        // do banco em tudo que o motor cria (fase B; antes usava authorized_date).
        const bookDate = String(l.date).slice(0, 10)
        if (r.target === 'FIXED_EXPENSE') {
          if (!r.supplier_id) throw new Error('regra sem fornecedor')
          const { data: prev } = await db.from('fixed_cost_expenses').select('id').eq('bank_transaction_id', l.id).maybeSingle()
          let rowId: string = prev?.id || ''
          let adopted = false
          let inserted = false   // só apaga no rollback o que ESTA chamada inseriu
          const pre: Backfill[] = []
          const a = it.adopt
          if (!rowId && a) {
            // ADOTA a agendada do mês: trava guardada (sem baixa, sem elo) — se
            // perder a corrida (humano ou outra rodada), cai no insert de sempre.
            const newDesc = (String(a.description || bankName) + ' ' + MARKER_ADOPTED).slice(0, 200)
            const { data: claimed } = await db.from('fixed_cost_expenses').update({ amount: amtAbs, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: l.id, description: newDesc })
              .eq('id', a.id).is('payment_date', null).is('bank_transaction_id', null).select('id')
            if (claimed && claimed.length) {
              rowId = a.id; adopted = true
              pre.push(
                { t: 'fixed_cost_expenses', id: a.id, f: 'amount', v: String(amtAbs), o: String(a.amount) },
                { t: 'fixed_cost_expenses', id: a.id, f: 'paid_from', v: 'GZ28US', o: a.paid_from ?? null },
                { t: 'fixed_cost_expenses', id: a.id, f: 'payment_method', v: 'BANK ACCOUNT', o: null },
                { t: 'fixed_cost_expenses', id: a.id, f: 'bank_transaction_id', v: String(l.id), o: null },
                { t: 'fixed_cost_expenses', id: a.id, f: 'description', v: newDesc, o: a.description ?? null },
              )
            } else {
              // Perdeu a corrida: alguém (humano ou outra rodada) já ligou uma
              // linha a esta cobrança — NUNCA reaproveitar linha alheia (o
              // rollback apagaria o que não é nosso). Pula com erro; replaneja.
              const { data: again } = await db.from('fixed_cost_expenses').select('id').eq('bank_transaction_id', l.id).maybeSingle()
              if (again?.id) throw new Error('linha já ligada por outra rodada — replaneje')
            }
          }
          if (!rowId) {
            const { data: row, error } = await db.from('fixed_cost_expenses').insert({
              supplier_id: r.supplier_id, type: 'SINGLE', description: (canon + ' — ' + bankName.slice(0, 80) + ' ' + MARKER_CREATED).slice(0, 200), amount: amtAbs, source: 'GZ28US',
              expense_date: bookDate, payment_date: l.date, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: l.id,
            }).select('id').single()
            if (error || !row) throw new Error(error?.message || 'insert falhou')
            rowId = row.id; inserted = true
          }
          try {
            await writeMatch(db, l, { table: 'fixed_cost_expenses', id: rowId }, { matched_note: ('AUTO · ' + tag + ' · ' + (r.label || bankName) + (adopted && a ? ' · ADOTOU agendada de ' + a.expense_date : '')).slice(0, 150), match_engine: tag, match_batch: batch, match_rule: r.id, reviewed_at: null }, pre)
          } catch (e) {
            if (adopted && a) { if (await stillOurs('fixed_cost_expenses', a.id)) await db.from('fixed_cost_expenses').update({ amount: a.amount, paid_from: a.paid_from ?? null, payment_method: null, bank_transaction_id: null, description: a.description }).eq('id', a.id).eq('bank_transaction_id', l.id) }
            else if (inserted && await stillOurs('fixed_cost_expenses', rowId)) await db.from('fixed_cost_expenses').delete().eq('id', rowId).eq('bank_transaction_id', l.id)
            throw e
          }
          if (adopted) res.rule_adopt++; else res.rule_create++
          if (tag === 'LEARN') res.learn++
          fixes.push(fix(l.id, `${tag} ${adopted && a ? 'ADOTOU agendada de ' + a.expense_date : 'criou despesa'} · ${lineLabel(l)}`))
        } else {
          // INPUT/SUPPLY — inputs não tem bank_transaction_id: o elo idempotente
          // vai em order_number ('bank:<id>'), que também documenta a origem.
          const linkRef = ('bank:' + l.id).slice(0, 120)
          const { data: prev } = await db.from('inputs').select('id').eq('order_number', linkRef).maybeSingle()
          let rowId: string = prev?.id || ''
          let inserted = false
          if (!rowId) {
            const { data: row, error } = await db.from('inputs').insert({
              description: (canon + ' — ' + bankName.slice(0, 80) + ' ' + MARKER_CREATED).slice(0, 200), category: INPUT_CATEGORIES.includes(String(r.category)) ? r.category : 'CONSUMPTION',
              quantity: 1, unit_price: amtAbs, supplier: canon,
              purchase_date: bookDate, payment_date: l.date, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', source: 'GZ28US', order_number: linkRef,
            }).select('id').single()
            if (error || !row) throw new Error(error?.message || 'insert falhou')
            rowId = row.id; inserted = true
          }
          try {
            await writeMatch(db, l, { table: 'inputs', id: rowId }, { matched_note: ('AUTO · ' + tag + ' · ' + (r.label || bankName)).slice(0, 150), match_engine: tag, match_batch: batch, match_rule: r.id, reviewed_at: null })
          } catch (e) { if (inserted && await stillOurs('inputs', rowId)) await db.from('inputs').delete().eq('id', rowId).eq('order_number', linkRef); throw e }
          res.rule_create++
          if (tag === 'LEARN') res.learn++
          fixes.push(fix(l.id, `${tag} criou SUPPLY ${INPUT_CATEGORIES.includes(String(r.category)) ? r.category : 'CONSUMPTION'} · ${lineLabel(l)}`))
        }
      } else if (it.engine === 'BUCKET' && it.create && it.rule) {
        // BALDE (fase B): a compra vira despesa REAL no mesmo dia, na pseudo-invoice
        // A ATRIBUIR, casada com a linha do banco. Elo = purchase_group (uuid da
        // linha); order_number fica NULL (é o número do pedido da loja, sagrado).
        // Retry idempotente: uma linha do balde por linha do banco enquanto está no balde.
        const r = it.rule
        const cls = it.cls || classify(l)
        const supplier = supplierNameFor(l, cls, dir)
        const amtAbs = Math.abs(num(l.amount))
        const { data: prev } = await db.from('invoice_expenses').select('id').eq('purchase_group', l.id).eq('invoice_id', bucketId).maybeSingle()
        let rowId: string = prev?.id || ''
        let inserted = false
        if (!rowId) {
          const { data: row, error } = await db.from('invoice_expenses').insert(bucketRowShape(l, bucketId, supplier)).select('id').single()
          if (error || !row) throw new Error(error?.message || 'insert falhou')
          rowId = row.id; inserted = true
        }
        try {
          await writeMatch(db, l, { table: 'invoice_expenses', id: rowId }, { matched_note: ('AUTO · BUCKET · ' + cls.klass + ' · ' + supplier).slice(0, 150), match_engine: ENGINE_BUCKET, match_batch: batch, match_rule: r.id, reviewed_at: null })
        } catch (e) {
          if (inserted && await stillOurs('invoice_expenses', rowId)) await db.from('invoice_expenses').delete().eq('id', rowId).eq('invoice_id', bucketId).eq('purchase_group', l.id)
          throw e
        }
        res.bucket++
        fixes.push(fix(l.id, `BUCKET criou A ATRIBUIR (${cls.klass}) · ${lineLabel(l)}`))
      } else {
        const c = it.cand!
        const { backfill } = await writeMatch(db, l, c, { matched_note: `AUTO · ${it.engine} · ` + c.label.slice(0, 120), match_engine: it.engine, match_batch: batch, reviewed_at: null })
        if (it.engine === 'FEE') res.fee_match++; else if (it.engine === 'NAME') res.name++; else res.exact++
        fixes.push(fix(l.id, `${it.engine} · ${lineLabel(l)} ⇄ ${c.label}${backfill.length ? ' → ' + backfill.map(b => `${b.t}.${b.f}=${b.v.slice(0, 10)}`).join(', ') : ''}`))
      }
    } catch (e) { res.errors.push(`${it.engine} ${lineLabel(l)}: ${String((e as Error).message || e)}`) }
    if (fixes.length >= 25) { const chunk = fixes.splice(0, fixes.length); await db.from('data_fixes').insert(chunk).then(() => undefined, () => undefined) }
  })
  if (fixes.length) await db.from('data_fixes').insert(fixes).then(() => undefined, () => undefined)
  return res
}

// Linhas NEW com os campos do raw do Plaid que o motor usa (aliases PostgREST:
// entity, pfc_detailed, authorized_date, processor — nulos nas linhas de extrato).
export async function newLines(db: any, limit: number, opts: { since?: string } = {}) {
  const acc: any[] = []
  const SEL = 'id, item_id, date, amount, name, merchant, pending, check_number, plaid_id, category, entity:raw->>merchant_entity_id, pfc_detailed:raw->personal_finance_category->>detailed, authorized_date:raw->>authorized_date, processor:raw->payment_meta->>payment_processor, cps:raw->counterparties, pfc_conf:raw->personal_finance_category->>confidence_level'
  for (let from = 0; from < limit; from += 1000) {   // pagina — PostgREST corta em 1.000 por request
    let q = db.from('bank_transactions').select(SEL).eq('match_status', 'NEW')
    if (opts.since) q = q.gte('date', opts.since)
    const { data, error } = await q.order('date', { ascending: false }).order('id').range(from, Math.min(from + 999, limit - 1))
    if (error) throw new Error('bank_transactions: ' + error.message)
    acc.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return acc
}

/* ─────────────── O BALDE «Compras a atribuir» (fase B) ─────────────── */

let BUCKET_ID_CACHE: string | null = null
// A pseudo-invoice do balde: uma só (índice parcial único em invoices.origin =
// BUCKET, criado pela MIGRATION_auto_book_phase_b.sql). Sem ela, cria; com duas,
// falha alto (impossível com o índice — defensivo).
export async function bucketInvoiceId(db: any): Promise<string> {
  if (BUCKET_ID_CACHE) return BUCKET_ID_CACHE
  const { data, error } = await db.from('invoices').select('id').eq('origin', BUCKET_ORIGIN)
  if (error) throw new Error('invoices: ' + error.message)
  if (data && data.length > 1) throw new Error('invoice A ATRIBUIR duplicada — rode MIGRATION_auto_book_phase_b.sql')
  if (data && data.length === 1) { BUCKET_ID_CACHE = data[0].id; return BUCKET_ID_CACHE! }
  // Sem balde = migration não rodou. NUNCA criar daqui (revisão): sem o índice
  // parcial, duas lambdas criariam dois baldes e o motor travaria pra sempre.
  throw new Error('invoice A ATRIBUIR não existe — rode MIGRATION_auto_book_phase_b.sql (invoices_bucket)')
}

// A linha do balde — o formato exato (§1.2 da spec da fase B). UMA DATA: a data
// do banco nas duas colunas. paid_from/paid_to GZ28US: o banco pagou.
export function bucketRowShape(l: any, bucketId: string, supplier: string) {
  return {
    invoice_id: bucketId,
    item: (supplier + ' ' + MARKER_BUCKET).slice(0, 200),
    supplier: supplier.slice(0, 120),
    price: Math.abs(num(l.amount)), quantity: 1, tax: 0, extra: 0, item_discount: 0,
    expense_date: String(l.date).slice(0, 10), payment_date: String(l.date).slice(0, 10),
    paid_from: 'GZ28US', paid_to: 'GZ28US', payment_method: 'BANK ACCOUNT', source: 'GZ28US',
    purchase_group: l.id,
    export_status: 'FRESH', picked_up: false, receipt_proves_payment: false, cancel_status: null,
    order_number: null, part_id: null, kit_group: null, kit_name: null, stock_source_type: null, stock_donor: null, position: null,
  }
}
export async function createBucketRow(db: any, line: any, dir: SupplierEntry[], cls?: Classified): Promise<{ id: string; supplier: string }> {
  const bucketId = await bucketInvoiceId(db)
  const supplier = supplierNameFor(line, cls || classify(line), dir)
  const { data: row, error } = await db.from('invoice_expenses').insert(bucketRowShape(line, bucketId, supplier)).select('id').single()
  if (error || !row) throw new Error('invoice_expenses: ' + (error?.message || 'insert falhou'))
  return { id: row.id, supplier }
}

// Tudo que o motor criou/moveu por causa desta linha (elo purchase_group = id da
// linha; custo fixo por bank_transaction_id) + a linha apontada. Texto = onde
// mora o marcador (item/description).
export async function bucketReach(db: any, line: any, bucketId: string): Promise<{ table: string; id: string; text: string; invoice_id?: string | null }[]> {
  void bucketId
  const out: { table: string; id: string; text: string; invoice_id?: string | null }[] = []
  const seen = new Set<string>()
  const add = (table: string, rows: any[] | null, col: string) => { for (const r of rows || []) { const k = table + ':' + r.id; if (seen.has(k)) continue; seen.add(k); out.push({ table, id: r.id, text: String(r[col] || ''), invoice_id: r.invoice_id ?? null }) } }
  const [ie, inp, inv, fx] = await Promise.all([
    db.from('invoice_expenses').select('id, item, invoice_id').eq('purchase_group', line.id),
    db.from('inputs').select('id, description').eq('purchase_group', line.id),
    db.from('inventory').select('id, description').eq('purchase_group', line.id),
    db.from('fixed_cost_expenses').select('id, description').eq('bank_transaction_id', line.id),
  ])
  for (const r of [ie, inp, inv, fx]) if (r.error) throw new Error(r.error.message)
  add('invoice_expenses', ie.data, 'item'); add('inputs', inp.data, 'description'); add('inventory', inv.data, 'description'); add('fixed_cost_expenses', fx.data, 'description')
  const t = String(line.matched_table || ''), id = String(line.matched_id || '')
  if (id && ['invoice_expenses', 'inputs', 'inventory', 'fixed_cost_expenses'].includes(t) && !seen.has(t + ':' + id)) {
    const col = t === 'invoice_expenses' ? 'item' : 'description'
    const { data } = await db.from(t).select('id, ' + col + (t === 'invoice_expenses' ? ', invoice_id' : '')).eq('id', id).maybeSingle()
    if (data) add(t, [data], col)
  }
  return out
}
// Quantas partes a última divisão desta linha registrou no diário (members).
export async function lastMatchMembersCount(db: any, bankId: string): Promise<number | null> {
  try {
    const { data } = await db.from('bank_match_log').select('members').eq('bank_id', bankId).eq('action', 'MATCH').order('at', { ascending: false }).limit(1).maybeSingle()
    return Array.isArray(data?.members) ? data.members.length : null
  } catch { return null }
}

// Órfão do balde: linha no balde sem linha MATCHED apontando (por id ou grupo),
// com mais de 10 min (janela das ações da fila). Apaga e registra. Esperado 0.
export async function purgeBucketOrphans(db: any): Promise<number> {
  const bucketId = await bucketInvoiceId(db)
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MIN * 60e3).toISOString()
  const rows = await fetchAll(db, 'invoice_expenses', 'id, purchase_group, item, price, payment_date', (q: any) => q.eq('invoice_id', bucketId).ilike('item', '%' + MARKER_BUCKET + '%').lt('created_at', cutoff))
  if (!rows.length) return 0
  const pointed = await fetchAll(db, 'bank_transactions', 'matched_table, matched_id', (q: any) => q.eq('match_status', 'MATCHED').in('matched_table', ['invoice_expenses', 'purchase_group']))
  const byId = new Set(pointed.filter((p: any) => p.matched_table === 'invoice_expenses').map((p: any) => String(p.matched_id)))
  const byGroup = new Set(pointed.filter((p: any) => p.matched_table === 'purchase_group').map((p: any) => String(p.matched_id)))
  let n = 0
  for (const r of rows) {
    if (byId.has(String(r.id)) || (r.purchase_group && byGroup.has(String(r.purchase_group)))) continue
    // Reconfere o ponteiro NA HORA (uma atribuição pode ter apontado depois do retrato).
    const { data: now } = await db.from('bank_transactions').select('id').eq('match_status', 'MATCHED').or('and(matched_table.eq.invoice_expenses,matched_id.eq.' + r.id + ')' + (r.purchase_group ? ',and(matched_table.eq.purchase_group,matched_id.eq.' + r.purchase_group + ')' : '')).limit(1)
    if (now && now.length) continue
    const { data } = await db.from('invoice_expenses').delete().eq('id', r.id).eq('invoice_id', bucketId).ilike('item', '%' + MARKER_BUCKET + '%').select('id')
    if (data && data.length) {
      n++
      await db.from('data_fixes').insert({ check_key: 'bank-bucket', table_name: 'invoice_expenses', row_id: r.id, field: 'PURGED', old_value: String(r.price), new_value: null, label: ('órfão do balde purgado · ' + (r.payment_date || '') + ' · ' + String(r.item || '')).slice(0, 200) }).then(() => undefined, () => undefined)
    }
  }
  return n
}

/* ─────────────── REGRAS PADRÃO (fase B) — o cérebro semeado pelo app ─────────────── */

// Fornecedor da frota pra combustível e pedágio — criado pelo motor se não existir
// (padrão do regionsSupplier). SINGLE + slots vazios ⇒ nunca gera agendada.
export async function ensureFleetSupplier(db: any): Promise<string> {
  const { data } = await db.from('fixed_cost_suppliers').select('id').eq('cost_type', 'FLEET').ilike('company', 'Frota — combust%').limit(1).maybeSingle()
  if (data?.id) return data.id
  const { data: ins, error } = await db.from('fixed_cost_suppliers').insert({
    company: 'Frota — combustível & rodagem',
    description: 'Combustível E pedágio dos carros da casa (BP, Wawa, Shell, RaceTrac, Sams, SunPass) — criado pelo AUTO-BOOK do Bank Link, fase B. Cada abastecimento entra como despesa SINGLE paga, ligada à linha do banco.',
    cost_type: 'FLEET', periodicity: 'SINGLE', date_entry: todayNY(), payment_day_1: null, amount_1: null, payment_day_2: null, amount_2: null,
  }).select('id').single()
  if (error || !ins) {
    const { data: again } = await db.from('fixed_cost_suppliers').select('id').eq('cost_type', 'FLEET').ilike('company', 'Frota — combust%').limit(1).maybeSingle()   // corrida no índice único: outra lambda criou
    if (again?.id) return again.id
    throw new Error('fornecedor da frota: ' + (error?.message || 'insert falhou'))
  }
  return ins.id
}

type DefaultRule = { key: string; priority: number; klass: Klass; target: 'FIXED_EXPENSE' | 'INPUT' | 'BUCKET'; amount_max: number | null; label: string; category?: string; pattern?: string; supplier?: 'FLEET' | { cost_type: string; re: RegExp; cap?: (s: any) => number } }
const SAAS_SLUGS: { slug: string; pattern: string; sup: RegExp }[] = [
  { slug: 'anthropic', pattern: 'ANTHROPIC|CLAUDE\\.AI', sup: /ANTHROPIC|CLAUDE/i }, { slug: 'vercel', pattern: 'VERCEL', sup: /VERCEL/i }, { slug: 'supabase', pattern: 'SUPABASE', sup: /SUPABASE/i },
  { slug: 'apple', pattern: 'PP\\*APPLE|APPLE\\.COM|ITUNES', sup: /^APPLE\b/i }, { slug: 'google', pattern: 'GOOGLE(?! ADS)', sup: /GOOGLE/i }, { slug: 'dropbox', pattern: 'DROPBOX', sup: /DROPBOX/i },
  { slug: 'ultramsg', pattern: 'ULTRAMSG', sup: /ULTRAMSG|SWIFT TECH/i }, { slug: 'lagosec', pattern: 'LAGOSEC|NORDVPN|NORD SEC', sup: /LAGOSEC|NORD/i }, { slug: 'teamviewer', pattern: 'TEAMVIEWER', sup: /TEAMVIEWER/i },
  { slug: 'godaddy', pattern: 'GODADDY', sup: /GODADDY/i }, { slug: 'microsoft', pattern: 'MICROSOFT', sup: /MICROSOFT/i }, { slug: 'openai', pattern: 'OPENAI|CHATGPT', sup: /OPENAI/i },
  { slug: 'midjourney', pattern: 'MIDJOURNEY', sup: /MIDJOURNEY/i }, { slug: 'recraft', pattern: 'RECRAFT', sup: /RECRAFT/i }, { slug: 'skywork', pattern: 'SKYWORK', sup: /SKYWORK/i },
  { slug: 'green-api', pattern: 'GREEN-?API', sup: /GREEN.?API/i }, { slug: 'amazon-prime', pattern: 'AMAZON PRIME|PRIME VIDEO', sup: /AMAZON PRIME|^AMAZON/i },
]
const saasCap = (s: any) => { const a = num(s?.amount_1); return a > 0 ? Math.max(200, Math.round(3 * a * 100) / 100) : 500 }
export const DEFAULTS: DefaultRule[] = [
  { key: 'def:fuel', priority: 10, klass: 'FUEL', target: 'FIXED_EXPENSE', amount_max: 250, label: 'PADRÃO · combustível da frota', supplier: 'FLEET' },
  { key: 'def:tolls', priority: 11, klass: 'TOLLS', target: 'FIXED_EXPENSE', amount_max: 200, label: 'PADRÃO · pedágio da frota', supplier: 'FLEET' },
  { key: 'def:grocery', priority: 20, klass: 'GROCERY', target: 'INPUT', amount_max: 300, label: 'PADRÃO · mercado', category: 'CONSUMPTION' },
  { key: 'def:superstore', priority: 21, klass: 'SUPERSTORE', target: 'INPUT', amount_max: 300, label: 'PADRÃO · Walmart/Target', category: 'CONSUMPTION' },
  { key: 'def:wholesale', priority: 22, klass: 'WHOLESALE_CLUB', target: 'INPUT', amount_max: 400, label: 'PADRÃO · Sams/Costco', category: 'CONSUMPTION' },
  { key: 'def:convenience', priority: 23, klass: 'CONVENIENCE', target: 'INPUT', amount_max: 100, label: 'PADRÃO · conveniência', category: 'CONSUMPTION' },
  { key: 'def:discount', priority: 24, klass: 'DISCOUNT_VARIETY', target: 'INPUT', amount_max: 150, label: 'PADRÃO · Dollar Tree e cia', category: 'CONSUMPTION' },
  { key: 'def:hardware-small', priority: 30, klass: 'HARDWARE', target: 'INPUT', amount_max: 150, label: 'PADRÃO · ferragem miúda', category: 'CONSUMPTION' },
  { key: 'def:hardware', priority: 31, klass: 'HARDWARE', target: 'BUCKET', amount_max: 5000, label: 'PADRÃO · ferragem grande → balde' },
  { key: 'def:home-supply-small', priority: 32, klass: 'HOME_SUPPLY', target: 'INPUT', amount_max: 150, label: 'PADRÃO · casa/oficina miúdo', category: 'CONSUMPTION' },
  { key: 'def:home-supply', priority: 33, klass: 'HOME_SUPPLY', target: 'BUCKET', amount_max: 5000, label: 'PADRÃO · casa/oficina grande → balde' },
  { key: 'def:auto-parts', priority: 40, klass: 'AUTO_PARTS', target: 'BUCKET', amount_max: 20000, label: 'PADRÃO · peça → balde' },
  { key: 'def:auto-service', priority: 41, klass: 'AUTO_SERVICE', target: 'BUCKET', amount_max: 10000, label: 'PADRÃO · serviço automotivo → balde' },
  { key: 'def:marketplace', priority: 42, klass: 'MARKETPLACE', target: 'BUCKET', amount_max: 5000, label: 'PADRÃO · Amazon/eBay → balde' },
  { key: 'def:temu', priority: 43, klass: 'TEMU', target: 'BUCKET', amount_max: 1000, label: 'PADRÃO · Temu → balde' },
  { key: 'def:paypal', priority: 44, klass: 'PAYPAL', target: 'BUCKET', amount_max: 20000, label: 'PADRÃO · PayPal → balde' },
  { key: 'def:square', priority: 45, klass: 'SQUARE', target: 'BUCKET', amount_max: 5000, label: 'PADRÃO · Square → balde' },
  { key: 'def:postage', priority: 46, klass: 'POSTAGE', target: 'BUCKET', amount_max: 2000, label: 'PADRÃO · frete/correio → balde' },
  { key: 'def:misc-retail', priority: 47, klass: 'MISC_RETAIL', target: 'BUCKET', amount_max: 2500, label: 'PADRÃO · varejo diverso → balde' },
  { key: 'def:services', priority: 48, klass: 'SERVICES', target: 'BUCKET', amount_max: 2500, label: 'PADRÃO · serviço diverso → balde' },
  ...SAAS_SLUGS.map((x, i) => ({ key: 'def:saas:' + x.slug, priority: 50 + i, klass: 'SAAS' as Klass, target: 'FIXED_EXPENSE' as const, amount_max: null, label: 'PADRÃO · assinatura ' + x.slug, pattern: x.pattern, supplier: { cost_type: 'APP', re: x.sup, cap: saasCap } })),
  { key: 'def:saas-other', priority: 70, klass: 'SAAS', target: 'BUCKET', amount_max: 500, label: 'PADRÃO · assinatura sem fornecedor → balde (sai por FIXO)' },
  { key: 'def:rent-spaceorl', priority: 71, klass: 'RENT', target: 'FIXED_EXPENSE', amount_max: null, label: 'PADRÃO · storage Space ORL', pattern: 'SPACE ORL', supplier: { cost_type: 'FIXED', re: /SPACE ORL/i, cap: (s: any) => num(s?.amount_1) > 0 ? Math.round(3 * num(s.amount_1) * 100) / 100 : 1500 } },
  { key: 'def:advertising', priority: 72, klass: 'ADVERTISING', target: 'FIXED_EXPENSE', amount_max: 5000, label: 'PADRÃO · anúncios Meta', supplier: { cost_type: 'MARKETING', re: /^META\b|META PLATFORMS|FACEBOOK/i } },
  { key: 'def:unknown-card', priority: 99, klass: 'UNKNOWN', target: 'BUCKET', amount_max: 2000, label: 'PADRÃO · compra no cartão sem classe → balde', pattern: '^(CARD|PIN) PURCHASE|^RECURRING CARD' },
]

// Fornecedor de custo fixo ÚNICO que bate (company/description/mail_match) no
// tipo pedido, vivo, e não marcado pra morrer. Dois = ambíguo = regra pulada.
function resolveFixedSupplier(sups: any[], re: RegExp, costType: string): { id: string | null; n: number; row: any | null } {
  const hits = sups.filter(s => s.cost_type === costType && !s.date_conclusion && !/DEIXAR MORRER|CANCEL|DUPLIC/i.test(String(s.description || '')) && (re.test(String(s.company || '')) || re.test(String(s.description || '')) || re.test(String(s.mail_match || ''))))
  return { id: hits.length === 1 ? hits[0].id : null, n: hits.length, row: hits.length === 1 ? hits[0] : null }
}

// SEMEIA as regras PADRÃO: idempotente por chave estável; regra desligada pelo
// dono é lápide (nunca renasce); fornecedor ambíguo = pulada com nota.
export async function seedDefaultRules(db: any, opts: { dryRun?: boolean } = {}): Promise<{ inserted: string[]; skipped: string[] }> {
  const inserted: string[] = [], skipped: string[] = []
  const haveRows = await fetchAll(db, 'bank_merchant_rules', 'key', (q: any) => q.not('key', 'is', null))
  const have = new Set(haveRows.map((r: any) => String(r.key)))
  const sups = await fetchAll(db, 'fixed_cost_suppliers', 'id, company, description, cost_type, date_conclusion, mail_match, amount_1')
  let fleet: string | null = null
  for (const d of DEFAULTS) {
    if (have.has(d.key)) continue
    let supplier_id: string | null = null, amount_max = d.amount_max
    if (d.supplier === 'FLEET') {
      if (opts.dryRun) supplier_id = 'dry-run'
      else { if (!fleet) fleet = await ensureFleetSupplier(db); supplier_id = fleet }
    } else if (d.supplier) {
      const r = resolveFixedSupplier(sups, d.supplier.re, d.supplier.cost_type)
      if (!r.id) { skipped.push(d.key + ': ' + r.n + ' fornecedores batem'); continue }
      supplier_id = r.id
      if (d.supplier.cap) amount_max = d.supplier.cap(r.row)
    }
    if (opts.dryRun) { inserted.push(d.key); continue }
    const { error } = await db.from('bank_merchant_rules').insert({
      key: d.key, origin: 'DEFAULT', active: true, direction: 'OUT', klass: d.klass, target: d.target, priority: d.priority,
      supplier_id: d.target === 'FIXED_EXPENSE' ? supplier_id : null, category: d.target === 'INPUT' ? (d.category || 'CONSUMPTION') : null,
      amount_max, pattern: d.pattern || null, label: d.label,
    })
    if (error) { if (String(error.code) === '23505') skipped.push(d.key + ': já existe'); else skipped.push(d.key + ': ' + error.message) }
    else inserted.push(d.key)
  }
  return { inserted, skipped }
}

/* ─────────────── AUTO-BOOK (BL 0.8.0) — o motor automático ─────────────── */

// Chaves (data|valor|nome) vistas em 2+ conexões (item_id ou 'stmt') — assinatura
// do feed duplicado. Usado pelo autoBook e pelo PLANEJAR humano (mesmo plano).
export async function itemTwinKeys(db: any): Promise<Set<string>> {
  const rows = await fetchAll(db, 'bank_transactions', 'id, item_id, plaid_id, date, amount, name', (q: any) => q.neq('match_status', 'REMOVED'))
  const seen = new Map<string, Set<string>>()
  for (const r of rows) {
    const k = twinKey(r)
    const ik = String(r.plaid_id || '').startsWith('stmt:') ? 'stmt' : String(r.item_id || '?')
    if (!seen.has(k)) seen.set(k, new Set())
    seen.get(k)!.add(ik)
  }
  const out = new Set<string>()
  seen.forEach((s, k) => { if (s.size >= 2) out.add(k) })
  return out
}

export async function loadRules(db: any): Promise<MerchantRule[]> {
  try { return await fetchAll(db, 'bank_merchant_rules', '*', (q: any) => q.eq('active', true)) } catch { return [] }
}

// UMA rodada por vez: índice parcial único em bank_auto_runs (status RUNNING).
// Rodada travada há >15 min sem fim = ABORTED (lambda morreu) e libera a trava.
export async function acquireRun(db: any, trigger: 'cron' | 'webhook' | 'human'): Promise<string | null> {
  const stale = new Date(Date.now() - 15 * 60e3).toISOString()
  await db.from('bank_auto_runs').update({ status: 'ABORTED', finished_at: new Date().toISOString(), note: 'sem finished_at após 15 min' }).eq('status', 'RUNNING').lt('started_at', stale)
  const { data, error } = await db.from('bank_auto_runs').insert({ trigger }).select('id').single()
  if (error) { if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message)) return null; throw new Error('bank_auto_runs: ' + error.message) }
  return data.id as string
}
export async function finishRun(db: any, id: string, patch: { status: string; counts?: Record<string, number>; errors?: string[]; remaining?: number; note?: string }) {
  try {
    // Contagens ACUMULAM entre fatias da mesma rodada (APLICAR humano em fatias).
    const { data: prev } = await db.from('bank_auto_runs').select('counts, errors').eq('id', id).maybeSingle()
    const counts: Record<string, number> = { ...(prev?.counts || {}) }
    for (const [k, v] of Object.entries(patch.counts || {})) counts[k] = (counts[k] || 0) + (v || 0)
    const errors = [...(Array.isArray(prev?.errors) ? prev.errors : []), ...(patch.errors || [])].slice(0, 50)
    // RUNNING entre fatias do APLICAR humano mantém a TRAVA (índice parcial) —
    // finished_at só quando a rodada de fato termina.
    await db.from('bank_auto_runs').update({ status: patch.status, finished_at: patch.status === 'RUNNING' ? null : new Date().toISOString(), counts, errors, remaining: patch.remaining ?? null, note: patch.note ?? null }).eq('id', id)
  } catch { /* nunca derruba a rodada */ }
}

// MEMÓRIA DE COMERCIANTE: um MATCH humano em custo fixo (fornecedor) ou supply
// (categoria) ensina uma regra APRENDIDA chaveada por comerciante+categoria+
// direção — nasce PROPOSTA (inativa), ativa na 2ª decisão igual, com teto de
// valor 3× o maior ensinado; marketplaces/PayPal/Zelle nunca ensinam; conflito
// pausa; regra HUMANA nunca é tocada. Melhor esforço: erro vira string.
export async function learnFromMatch(db: any, line: any, cand: { table: string; id: string; supplier_id?: string | null }): Promise<string | null> {
  try {
    if (!(num(line.amount) > 0)) return null
    const key = merchantKey(line)
    if (!key) return null
    if (LEARN_BLOCK_NAME.test((line.merchant || '') + ' ' + (line.name || ''))) return null
    if (line.pfc_detailed && LEARN_BLOCK_PFC.has(String(line.pfc_detailed))) return null
    if (line.processor) return null
    let target: 'FIXED_EXPENSE' | 'INPUT', supplier_id: string | null = null, category: string | null = null
    if (cand.table === 'fixed_cost_expenses') {
      const { data: row } = await db.from('fixed_cost_expenses').select('supplier_id').eq('id', cand.id).maybeSingle()
      supplier_id = row?.supplier_id || cand.supplier_id || null
      if (!supplier_id) return null
      const { data: sup } = await db.from('fixed_cost_suppliers').select('cost_type').eq('id', supplier_id).maybeSingle()
      if (['MARKETING', 'ASSET', 'MERCHANDISE'].includes(String(sup?.cost_type))) return null
      target = 'FIXED_EXPENSE'
    } else if (cand.table === 'inputs') {
      const { data: row } = await db.from('inputs').select('category').eq('id', cand.id).maybeSingle()
      category = row?.category || 'CONSUMPTION'; target = 'INPUT'
    } else return null
    const amt = Math.abs(num(line.amount))
    const pfcD = line.pfc_detailed ? String(line.pfc_detailed) : null
    const { data: ex } = await db.from('bank_merchant_rules').select('*').eq('origin', 'LEARNED').eq('merchant_key', key).eq('direction', 'OUT')
    const existing = (ex || []).find((r: any) => (r.pfc_detailed || '') === (pfcD || ''))
    const now = new Date().toISOString()
    if (!existing) {
      const { error } = await db.from('bank_merchant_rules').insert({
        origin: 'LEARNED', merchant_key: key, pfc_primary: line.category || null, pfc_detailed: pfcD, direction: 'OUT', target, supplier_id, category,
        label: 'aprendida · ' + String(line.merchant || line.name || key).slice(0, 80), active: false, hits: 1, amount_max: Math.round(3 * amt * 100) / 100,
        last_hit_at: now, last_taught_bank_id: String(line.id), paused_reason: 'proposta — ativa na 2ª decisão igual',
      })
      return error ? 'erro ao aprender: ' + error.message : 'regra proposta (1/2)'
    }
    const same = existing.target === target && (existing.supplier_id || null) === (supplier_id || null) && (existing.category || null) === (category || null)
    if (!same) {
      await db.from('bank_merchant_rules').update({ active: false, paused_reason: `conflito: ${existing.target}/${existing.supplier_id || existing.category || ''} vs ${target}/${supplier_id || category || ''} (${line.date})` }).eq('id', existing.id)
      return 'regra aprendida em CONFLITO — pausada'
    }
    const hits = (existing.hits || 0) + 1
    const activate = hits >= 2 && String(existing.paused_reason || '').startsWith('proposta')
    await db.from('bank_merchant_rules').update({ hits, amount_max: Math.max(num(existing.amount_max), Math.round(3 * amt * 100) / 100), last_hit_at: now, last_taught_bank_id: String(line.id), ...(activate ? { active: true, paused_reason: null } : {}) }).eq('id', existing.id)
    return activate ? 'regra aprendida ATIVADA' : existing.active ? 'regra aprendida reforçada' : `regra proposta (${hits}/2)`
  } catch (e) { return 'erro ao aprender: ' + String((e as Error).message || e) }
}

export type AutoSummary = { run?: string; status: string; skipped?: string; counts: Record<string, number>; errors: string[]; remaining: number; lines: number }

// AUTO-BOOK: roda depois de todo sync (cron 6/6h · webhook em segundo plano).
// Só linhas POSTADAS desde AUTO_BOOK_FLOOR; FEE/EXACT/NAME/TRANSFER na hora,
// RULE/LEARN com maturidade; fatias de 150 re-planejadas; orçamento de tempo;
// nunca lança exceção pro chamador — tudo vira status/erros em bank_auto_runs.
export async function autoBook(db: any, opts: { trigger: 'cron' | 'webhook' | 'human'; deadlineMs: number; maxItems?: number }): Promise<AutoSummary> {
  const counts: Record<string, number> = { fee_create: 0, fee_match: 0, exact: 0, name: 0, rule_create: 0, rule_adopt: 0, learn: 0, transfer: 0, bucket: 0 }
  const errors: string[] = []
  const notes: string[] = []
  let run: string | null = null
  try {
    run = await acquireRun(db, opts.trigger)
  } catch (e) { return { status: 'ERROR', counts, errors: [String((e as Error).message || e)], remaining: 0, lines: 0 } }
  if (!run) return { status: 'SKIPPED', skipped: 'rodada em andamento', counts, errors, remaining: 0, lines: 0 }
  const t0 = Date.now()
  let status = 'DONE', remaining = 0, lines = 0, applied = 0
  try {
    // Fase B: dentro da trava — purga órfãos do balde (10 min de carência) e
    // semeia as regras PADRÃO que faltam (chave estável; desligada nunca renasce).
    // Purga e semeadura são NOTAS da rodada, nunca erros (revisão: fornecedor
    // ambíguo viraria missão permanente no Data Checker; PADRÃO pulado tem item próprio).
    try { const purged = await purgeBucketOrphans(db); if (purged) notes.push(`${purged} órfão(s) do balde purgado(s)`) } catch (e) { errors.push('purga do balde: ' + String((e as Error).message || e).slice(0, 160)) }
    try { const seeded = await seedDefaultRules(db); if (seeded.inserted.length) notes.push(seeded.inserted.length + ' PADRÃO semeado(s)'); if (seeded.skipped.length) notes.push('PADRÃO pulado: ' + seeded.skipped.join(' · ').slice(0, 200)) } catch (e) { errors.push('semear PADRÃO: ' + String((e as Error).message || e).slice(0, 160)) }
    await loadDbAliases(db)
    const [rules, itemTwins] = await Promise.all([loadRules(db), itemTwinKeys(db)])
    const maxItems = opts.maxItems || 900
    for (let guard = 0; guard < 20; guard++) {
      const all = (await newLines(db, 5000, { since: AUTO_BOOK_FLOOR })).filter((l: any) => !l.pending)
      lines = all.length
      const pool = await candidatePool(db)
      const plan = buildPlan(all, pool, rules, { minCreateAge: RULE_AGE_DAYS, itemTwins })
      remaining = plan.items.length
      if (!plan.items.length) break
      if (Date.now() - t0 > opts.deadlineMs - 25_000 || applied >= maxItems) { status = 'PARTIAL'; break }
      const res = await applyPlan(db, plan, { max: 150, batch: run })
      const done = res.fee_create + res.fee_match + res.exact + res.name + res.rule_create + res.rule_adopt + res.transfer + res.bucket
      applied += done
      for (const k of Object.keys(counts)) counts[k] += (res as any)[k] || 0
      errors.push(...res.errors)
      if (res.errors.length && !done) { status = 'ERROR'; break }   // fatia envenenada: não gira em falso
      remaining = res.remaining
      if (!res.remaining) break
    }
  } catch (e) { status = 'ERROR'; errors.push(String((e as Error).message || e)) }
  await finishRun(db, run, { status, counts, errors: errors.slice(0, 50), remaining, note: `${lines} NEW postadas desde ${AUTO_BOOK_FLOOR} · ${opts.trigger} · ${Math.round((Date.now() - t0) / 1000)}s${notes.length ? ' · ' + notes.join(' · ') : ''}`.slice(0, 500) })
  return { run, status, counts, errors, remaining, lines }
}
