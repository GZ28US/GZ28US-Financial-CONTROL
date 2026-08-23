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

export const num = (v: unknown) => parseFloat(String(v)) || 0
const okDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)
const daysBetween = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
const paidAtFor = (date: string) => date + 'T12:00:00-04:00'
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

async function fetchAll(db: any, table: string, select: string, filter?: (q: any) => any): Promise<any[]> {
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
export type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; group?: string | null; members?: Member[]; score?: number; dd?: number | null }
export type Pool = { out: Cand[]; inn: Cand[] }
export type Backfill = { t: string; id: string; f: 'payment_date' | 'paid_at'; v: string }
export const DATE_TABLES = new Set(['invoice_expenses', 'fixed_cost_expenses', 'expenses', 'goods', 'good_expenses', 'inputs', 'inventory'])

// Monta o pool de candidatos do app: saídas (OUT) e entradas (IN), já sem o
// que outra linha do banco casou — inclusive o cruzamento grupo ⇄ item.
export async function candidatePool(db: any): Promise<Pool> {
  const [invExp, fixed, suppliers, expenses, goods, goodExp, inputs, inventory, payments, invoices, rides, clients, capital, finEv, financing, matched] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, purchase_group, paid_from'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date, expense_date, paid_from'),
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, description'),
    fetchAll(db, 'expenses', 'id, description, type, amount, payment_date, expense_date, origin, paid_from'),
    fetchAll(db, 'goods', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from'),
    fetchAll(db, 'good_expenses', 'id, good_id, description, supplier, amount, payment_date, expense_date, paid_from'),
    fetchAll(db, 'inputs', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, payment_date, purchase_date, purchase_group, paid_from'),
    fetchAll(db, 'invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, source, description, paid_to'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote'),
    fetchAll(db, 'rides', 'id, project_name, client_id'),
    fetchAll(db, 'clients', '*').catch(() => []),
    fetchAll(db, 'capital_events', 'id, event_date, kind, member, amount, description').catch(() => []),
    fetchAll(db, 'financing_events', 'id, financing_id, event_date, kind, amount, description').catch(() => []),
    fetchAll(db, 'financing', 'id, lender').catch(() => []),
    fetchAll(db, 'bank_transactions', 'matched_table, matched_id', (q: any) => q.not('matched_id', 'is', null)),
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
  const lender = new Map(financing.map((f: any) => [f.id, f.lender]))
  const invLabel = (invoiceId: string) => { const i = invById.get(invoiceId); const r = i ? rideById.get(i.ride_id) : null; return i ? `${i.invoice_code || '—'} ${r?.project_name || ''}`.trim() : '—' }
  const invClient = (invoiceId: string) => { const i = invById.get(invoiceId); const r = i ? rideById.get(i.ride_id) : null; return r ? clientName.get(r.client_id) || '' : '' }
  const realInvoice = (invoiceId: string) => { const i = invById.get(invoiceId); return !!i && !i.is_quote }
  const out: Cand[] = [], inn: Cand[] = []
  // Pagou/recebeu o Brasil ⇒ nunca passa na Regions. Datado no futuro ⇒ ainda não aconteceu.
  const brPaid = (r: any) => r.paid_from === 'GZ28BR' || r.paid_to === 'GZ28BR'
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
    push(out, { table: 'invoice_expenses', id: e.id, group: grp(e), label: `${invLabel(e.invoice_id)} · ${e.item || ''}${e.supplier ? ' · ' + e.supplier : ''}`, date: e.payment_date || e.expense_date || null, amount: num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra), undated: !okDate(e.payment_date) }) }
  for (const f of fixed) if (!brPaid(f)) push(out, { table: 'fixed_cost_expenses', id: f.id, label: `FIXO · ${supName.get(f.supplier_id) || ''} · ${f.description || ''}`, date: f.payment_date || f.expense_date || null, amount: num(f.amount), undated: !okDate(f.payment_date) })
  for (const x of expenses) if (!brPaid(x)) push(out, { table: 'expenses', id: x.id, label: `${x.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${x.description || x.type || ''}`, date: x.payment_date || x.expense_date || null, amount: num(x.amount), undated: !okDate(x.payment_date) })
  for (const g of goods) if (!brPaid(g) && memberFree(g)) push(out, { table: 'goods', id: g.id, group: grp(g), label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.purchase_date || null, amount: num(g.unit_price) * (num(g.quantity) || 1), undated: !okDate(g.payment_date) })
  for (const g of goodExp) if (!brPaid(g)) push(out, { table: 'good_expenses', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.expense_date || null, amount: num(g.amount), undated: !okDate(g.payment_date) })
  for (const x of inputs) if (!brPaid(x) && memberFree(x)) push(out, { table: 'inputs', id: x.id, group: grp(x), label: `INPUT · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const x of inventory) if (x.source_type === 'PURCHASED' && !brPaid(x) && memberFree(x)) push(out, { table: 'inventory', id: x.id, group: grp(x), label: `STOCK · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const e of finEv) {
    const c = { table: 'financing_events', id: e.id, label: `EMPRÉSTIMO · ${lender.get(e.financing_id) || ''} · ${e.kind}${e.description ? ' · ' + e.description : ''}`, date: e.event_date, amount: num(e.amount), undated: false }
    push(e.kind === 'DISBURSEMENT' ? inn : out, c)
  }
  for (const c of capital) push(c.kind === 'CONTRIBUTION' ? inn : out, { table: 'capital_events', id: c.id, label: `CAPITAL · ${c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'} · ${c.member || ''}${c.description ? ' · ' + c.description : ''}`, date: c.event_date, amount: num(c.amount), undated: false })
  for (const p of payments) { if (!realInvoice(p.invoice_id) || brPaid(p)) continue
    push(inn, { table: 'invoice_payments', id: p.id, label: `INCOME · ${invLabel(p.invoice_id)}${invClient(p.invoice_id) ? ' · ' + invClient(p.invoice_id) : ''}${p.description ? ' · ' + p.description : ''}${p.source ? ' · ' + p.source : ''}`, date: p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || null), amount: num(p.amount), undated: !p.paid_at }) }
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
  groups.forEach((g, id) => { if (g.n > 1) push(out, { table: 'purchase_group', id, label: `${g.label} · ${g.n} itens`, date: g.date, amount: g.amount, undated: g.undated, members: g.members }) })
  return { out, inn }
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
// Nome bate? Em Zelle/wire o BENEFICIÁRIO tem que aparecer no rótulo (revisão #3);
// nas demais, palavra útil em comum (prefixo de 5 vale) ou alias inteiro.
export function nameHit(line: any, c: Cand): boolean {
  const bank = ((line.merchant || '') + ' ' + (line.name || '')).toLowerCase()
  const lab = String(c.label || '').toLowerCase()
  const lw = words(lab)
  const payee = bank.match(/zelle (?:debit to|credit from) ([a-z0-9&' .-]+?)(?: ref#?|$)/i) || bank.match(/wire transfer (?:incoming |outgoing |domestic |intl |international )?(?!fee)([a-z0-9&' .-]+)/i)
  if (payee) { const pw = words(payee[1]); return pw.length > 0 && wordHit(pw, lw) }
  if (wordHit(words(bank), lw)) return true
  for (const a of ALIASES) if (a.re.test(bank) && !(a.not && a.not.test(lab)) && a.words.some(w => new RegExp('\\b' + esc(w) + '\\b', 'i').test(lab))) return true
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

export type PlanItem = { line: any; cand: Cand | null; engine: 'FEE' | 'EXACT'; create: boolean }
export type Plan = { items: PlanItem[]; skipped: Record<string, number> }

// Decide o que é CERTO. Não escreve nada — quem escreve é applyPlan.
export function buildPlan(lines: any[], pool: Pool): Plan {
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
    if (!same.length) { skip('sem candidato'); continue }
    const near = same.filter(x => !x.date || daysBetween(x.date, l.date) <= 30)
    if (near.length !== 1) { skip(near.length ? 'candidato ambíguo' : 'candidato longe'); continue }
    const c = near[0]
    if (!c.date) { skip('candidato sem data'); continue }
    const dd = daysBetween(c.date, l.date)
    if (dd > (c.undated ? 7 : 3)) { skip('mais de 3 dias'); continue }
    // Unicidade do lado do BANCO: outra linha NEW com mesmo valor e direção a ±30d.
    const twins = sorted.filter(o => o !== l && key(o) === key(l) && daysBetween(o.date, l.date) <= 30)
    if (twins.length) { skip('valor repetido no banco'); continue }
    const rep45 = sorted.filter(o => o !== l && key(o) === key(l) && daysBetween(o.date, l.date) <= 45).length
    if (rep45 >= 2) { skip('série (≥3× em 45d)'); continue }
    if (!nameHit(l, c)) { skip('nome não bate'); continue }
    if (amt % 50 === 0 && amt < 1000) { skip('valor redondo < $1k'); continue }
    consume(c)
    plan.items.push({ line: l, cand: c, engine: 'EXACT', create: false })
  }
  return plan
}

// Impressão digital do plano: APLICAR só roda o plano que o Márcio VIU (revisão #22).
export function planHash(plan: Plan): string {
  const ids = plan.items.map(i => i.line.id + '>' + (i.cand ? i.cand.table + ':' + i.cand.id : 'create')).sort()
  let h = 5381; for (const s of ids) for (let k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) >>> 0
  return ids.length + '-' + h.toString(36)
}

export const planSummary = (plan: Plan) => {
  const fee = plan.items.filter(i => i.engine === 'FEE'), exact = plan.items.filter(i => i.engine === 'EXACT')
  return {
    fee_create: fee.filter(i => i.create).length, fee_match: fee.filter(i => !i.create).length, exact: exact.length,
    total: plan.items.length, skipped: plan.skipped, hash: planHash(plan),
    samples: {
      fee: fee.filter(i => i.create).slice(0, 5).map(({ line: l }) => `${l.date} · ${l.name} · $${Math.abs(num(l.amount)).toFixed(2)}`),
      exact: exact.slice(0, 12).map(({ line: l, cand: c }) => `${l.date} · ${l.merchant || l.name} · ${num(l.amount) > 0 ? '−' : '+'}$${Math.abs(num(l.amount)).toFixed(2)} ⇄ ${c!.label}`),
    },
  }
}

/* ─────────────── ESCRITA (humano e motor usam o mesmo) ─────────────── */

// 1) TRANCA a linha do banco (NEW → MATCHED). 0 linhas = outra aba/sync já
//    decidiu ⇒ erro, nada no app foi tocado. 2) Backfill no app, guardando
//    EXATAMENTE o que escreveu. 3) Grava `backfill` na linha. (revisões #6 #7 #11)
export async function writeMatch(db: any, line: any, cand: Cand | { table: string; id: string; members?: Member[] }, extra: Record<string, unknown>): Promise<{ backfill: Backfill[] }> {
  const { data: claimed, error: claimErr } = await db.from('bank_transactions')
    .update({ match_status: 'MATCHED', matched_table: cand.table, matched_id: cand.id, backfill: null, ...extra })
    .eq('id', line.id).eq('match_status', 'NEW').select('id')
  if (claimErr) throw new Error(claimErr.message)
  if (!claimed || !claimed.length) throw new Error('linha do banco já decidida (outra aba ou sync) — recarregue')
  const backfill: Backfill[] = []
  const fill = async (table: string, ids: string[], field: 'payment_date' | 'paid_at', value: string) => {
    if (!ids.length) return
    const { data, error } = await db.from(table).update({ [field]: value }).in('id', ids).is(field, null).select('id')
    if (error) throw new Error(`${table}: ${error.message}`)
    for (const r of data || []) backfill.push({ t: table, id: r.id, f: field, v: value })
  }
  if (DATE_TABLES.has(cand.table)) await fill(cand.table, [cand.id], 'payment_date', line.date)
  else if (cand.table === 'invoice_payments') await fill('invoice_payments', [cand.id], 'paid_at', paidAtFor(line.date))
  else if (cand.table === 'purchase_group') {
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

// DESFAZER: reverte só o que `backfill` diz que escrevemos (valor igual ⇒ ninguém
// mexeu depois); linha sem registro (casada antes da v0.3.0) usa a regra antiga
// de igualdade com a data do banco. Tarifa criada pelo motor é apagada. Cada
// passo checa erro; a linha do banco é a ÚLTIMA escrita. (revisões #6 #10)
export async function writeUnmatch(db: any, line: any, changed: string[]) {
  if (line.match_status === 'MATCHED' && line.matched_table && line.matched_id) {
    const t = line.matched_table as string, id = line.matched_id as string
    if (line.match_engine === 'FEE' && t === 'fixed_cost_expenses') {
      const { data: r, error } = await db.from('fixed_cost_expenses').delete().eq('id', id).eq('bank_transaction_id', line.id).select('id')
      if (error) throw new Error('fixed_cost_expenses: ' + error.message)
      if (r && r.length) changed.push('tarifa criada pelo motor apagada')
    }
    const recorded: Backfill[] | null = Array.isArray(line.backfill) ? line.backfill : null
    if (recorded) {
      for (const b of recorded) {
        const { data: r, error } = await db.from(b.t).update({ [b.f]: null }).eq('id', b.id).eq(b.f, b.v).select('id')
        if (error) throw new Error(`${b.t}: ${error.message}`)
        if (r && r.length) changed.push(`${b.t}.${b.f}→null`)
      }
    } else if (DATE_TABLES.has(t)) {
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
  const update = { match_status: 'NEW', matched_table: null, matched_id: null, matched_note: null, match_engine: null, match_batch: null, reviewed_at: null, backfill: null }
  const { data, error } = await db.from('bank_transactions').update(update).eq('id', line.id).eq('match_status', line.match_status).select('id')
  if (error) throw new Error(error.message)
  if (!data || !data.length) throw new Error('linha mudou enquanto desfazia — recarregue')
  return update
}

async function regionsSupplier(db: any): Promise<string> {
  const { data } = await db.from('fixed_cost_suppliers').select('id').ilike('company', 'Regions Bank%').limit(1).maybeSingle()
  if (data?.id) return data.id
  const { data: ins, error } = await db.from('fixed_cost_suppliers').insert({ company: 'Regions Bank', description: 'Tarifas da conta •9336 — wire fee, analysis charge, international service assessment (criado pelo motor FEE do Bank Link)', cost_type: 'FIXED', periodicity: 'MONTHLY' }).select('id').single()
  if (error || !ins) throw new Error('não consegui criar o fornecedor "Regions Bank": ' + (error?.message || '?'))
  return ins.id
}

// Paralelismo limitado: N linhas em voo, cada uma com suas escritas em ordem.
async function pmap<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it) } }))
}

export type ApplyResult = { batch: string; fee_match: number; fee_create: number; exact: number; remaining: number; errors: string[] }

// Aplica até `max` itens do plano (o cliente repete enquanto remaining > 0 —
// revisão #12: 317 linhas × 2–3 idas ao banco não cabem num request).
// Tarifa: acha/cria a linha do custo fixo → tranca a linha do banco; se a
// trava falhar, apaga a tarifa recém-criada (nada órfão — revisão #7).
export async function applyPlan(db: any, plan: Plan, opts: { max?: number; batch?: string } = {}): Promise<ApplyResult> {
  const max = opts.max || 150
  const batch = opts.batch || randomUUID()
  const res: ApplyResult = { batch, fee_match: 0, fee_create: 0, exact: 0, remaining: Math.max(0, plan.items.length - max), errors: [] }
  const lineLabel = (l: any) => `${l.date} · ${l.merchant || l.name || ''} · ${num(l.amount)}`
  const fix = (row_id: string, label: string) => ({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id, field: 'match_status', old_value: 'NEW', new_value: 'MATCHED', label: label.slice(0, 200) })
  let supplierId: string | null = null
  if (plan.items.some(i => i.create)) supplierId = await regionsSupplier(db)
  const fixes: any[] = []
  await pmap(plan.items.slice(0, max), 6, async (it) => {
    const l = it.line
    try {
      if (it.engine === 'FEE' && it.create) {
        const desc = `${String(l.name || 'Tarifa bancária').trim()} — tarifa Regions •9336 (auto · Bank Link)`
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
          await writeMatch(db, l, { table: 'fixed_cost_expenses', id: rowId }, { matched_note: 'AUTO · FEE · ' + desc.slice(0, 120), match_engine: 'FEE', match_batch: batch, reviewed_at: null })
        } catch (e) {
          if (!prev) await db.from('fixed_cost_expenses').delete().eq('id', rowId).eq('bank_transaction_id', l.id)
          throw e
        }
        res.fee_create++
        fixes.push(fix(l.id, 'FEE criou tarifa · ' + lineLabel(l)))
      } else {
        const c = it.cand!
        const { backfill } = await writeMatch(db, l, c, { matched_note: `AUTO · ${it.engine} · ` + c.label.slice(0, 120), match_engine: it.engine, match_batch: batch, reviewed_at: null })
        if (it.engine === 'FEE') res.fee_match++; else res.exact++
        fixes.push(fix(l.id, `${it.engine} · ${lineLabel(l)} ⇄ ${c.label}${backfill.length ? ' → ' + backfill.map(b => `${b.t}.${b.f}=${b.v.slice(0, 10)}`).join(', ') : ''}`))
      }
    } catch (e) { res.errors.push(`${it.engine} ${lineLabel(l)}: ${String((e as Error).message || e)}`) }
    if (fixes.length >= 25) { const chunk = fixes.splice(0, fixes.length); await db.from('data_fixes').insert(chunk).then(() => undefined, () => undefined) }
  })
  if (fixes.length) await db.from('data_fixes').insert(fixes).then(() => undefined, () => undefined)
  return res
}

export async function newLines(db: any, limit: number) {
  const acc: any[] = []
  for (let from = 0; from < limit; from += 1000) {   // pagina — PostgREST corta em 1.000 por request
    const { data, error } = await db.from('bank_transactions').select('id, date, amount, name, merchant, pending, check_number, plaid_id, category')
      .eq('match_status', 'NEW').order('date', { ascending: false }).order('id').range(from, Math.min(from + 999, limit - 1))
    if (error) throw new Error('bank_transactions: ' + error.message)
    acc.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return acc
}
