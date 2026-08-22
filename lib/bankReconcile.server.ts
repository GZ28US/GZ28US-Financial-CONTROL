// lib/bankReconcile.server.ts — motores e pool da conciliação bancária (v0.3.0).
// Só servidor (service key). A rota app/api/bank/reconcile/route.ts é fina e usa isto.
import { randomUUID } from 'crypto'

// CONCILIAÇÃO BANCÁRIA (Data Checker · card "Banco sem casamento", 21/ago):
// cada linha NEW do banco é uma pendência. Este servidor (as tabelas do banco
// são só-service-key) acha CANDIDATOS no app — mesmo valor (±$0,01), data
// próxima, ou grupo de compra somado (um pedido de 3 itens = uma cobrança) —
// e aplica a decisão humana: MATCH (e backfill do payment_date do app quando
// falta), TRANSFER, IGNORE ou EXPLAIN ("o que foi", fica QUEUED com a nota).
// Tudo exige sessão Supabase válida (JWT no header) e vai pra trilha data_fixes.
//
// Revisão adversarial de 21/ago (BL v0.2.1): o MATCH re-deriva o candidato no
// servidor (nunca confia na lista do cliente); UNMATCH desfaz o backfill que o
// MATCH escreveu; estorno negativo vai pro pool oposto; leitura pagina além
// dos 1.000 do PostgREST. Convenção Plaid: amount > 0 = saiu, < 0 = entrou.
//
// v0.3.0 (22/ago, "Go!" do Márcio) — MOTORES AUTOMÁTICOS, o que é CERTO e só:
//   FEE   tarifa da Regions (vocabulário do banco / categoria BANK_FEES, ≤ $300):
//         casa com linha de tarifa já lançada se houver; senão CRIA a linha em
//         fixed_cost_expenses (fornecedor "Regions Bank", FIXED ⇒ o DRE soma) com
//         bank_transaction_id — DESFAZER apaga exatamente essa linha.
//   EXACT centavos iguais + candidato ÚNICO no app (±30d) + linha ÚNICA no banco
//         (±30d, mesmo valor e direção) + ≤3 dias + nome/alias batendo + não
//         pendente + candidato datado. Valor redondo (múltiplo de $50) só ≥ $1.000;
//         valor que se repete ≥3× em 45 dias nunca (assinatura/série vai pra
//         sugestão). A medição de 22/ago mostrou que "valor exato + único" sem
//         nome casa $12 de anúncio Meta com freio de AutoZone — por isso o nome.
//   Tudo que o motor casa fica em A CONFERIR (reviewed_at null) com OK/DESFAZER
//   por linha e DESFAZER LOTE por rodada (match_batch). Pool: paid_from/paid_to
//   GZ28BR fora (pagou o Brasil), linha datada no futuro fora, invoice_expenses
//   também agrupa por purchase_group.

/* eslint-disable @typescript-eslint/no-explicit-any */
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

export type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; score?: number; dd?: number | null }
export const GROUP_TABLES = ['goods', 'inputs', 'inventory', 'invoice_expenses'] as const
export const DATE_TABLES = new Set(['invoice_expenses', 'fixed_cost_expenses', 'expenses', 'goods', 'good_expenses', 'inputs', 'inventory'])

// Monta o pool de candidatos do app: saídas (OUT) e entradas (IN), já sem o
// que outra linha do banco casou — inclusive o cruzamento grupo ⇄ item.
export async function candidatePool(db: any) {
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

  for (const e of invExp) { if (!invById.get(e.invoice_id) || invById.get(e.invoice_id).is_quote || brPaid(e) || !memberFree(e)) continue
    push(out, { table: 'invoice_expenses', id: e.id, label: `${invLabel(e.invoice_id)} · ${e.item || ''}${e.supplier ? ' · ' + e.supplier : ''}`, date: e.payment_date || e.expense_date || null, amount: num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra), undated: !okDate(e.payment_date) }) }
  for (const f of fixed) if (!brPaid(f)) push(out, { table: 'fixed_cost_expenses', id: f.id, label: `FIXO · ${supName.get(f.supplier_id) || ''} · ${f.description || ''}`, date: f.payment_date || f.expense_date || null, amount: num(f.amount), undated: !okDate(f.payment_date) })
  for (const x of expenses) if (!brPaid(x)) push(out, { table: 'expenses', id: x.id, label: `${x.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${x.description || x.type || ''}`, date: x.payment_date || x.expense_date || null, amount: num(x.amount), undated: !okDate(x.payment_date) })
  for (const g of goods) if (!brPaid(g) && memberFree(g)) push(out, { table: 'goods', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.purchase_date || null, amount: num(g.unit_price) * (num(g.quantity) || 1), undated: !okDate(g.payment_date) })
  for (const g of goodExp) if (!brPaid(g)) push(out, { table: 'good_expenses', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.expense_date || null, amount: num(g.amount), undated: !okDate(g.payment_date) })
  for (const x of inputs) if (!brPaid(x) && memberFree(x)) push(out, { table: 'inputs', id: x.id, label: `INPUT · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const x of inventory) if (x.source_type === 'PURCHASED' && !brPaid(x) && memberFree(x)) push(out, { table: 'inventory', id: x.id, label: `STOCK · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const e of finEv) {
    const c = { table: 'financing_events', id: e.id, label: `EMPRÉSTIMO · ${lender.get(e.financing_id) || ''} · ${e.kind}${e.description ? ' · ' + e.description : ''}`, date: e.event_date, amount: num(e.amount), undated: false }
    push(e.kind === 'DISBURSEMENT' ? inn : out, c)
  }
  for (const c of capital) push(c.kind === 'CONTRIBUTION' ? inn : out, { table: 'capital_events', id: c.id, label: `CAPITAL · ${c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'} · ${c.member || ''}${c.description ? ' · ' + c.description : ''}`, date: c.event_date, amount: num(c.amount), undated: false })
  for (const p of payments) { if (!invById.get(p.invoice_id) || invById.get(p.invoice_id).is_quote || brPaid(p)) continue
    push(inn, { table: 'invoice_payments', id: p.id, label: `INCOME · ${invLabel(p.invoice_id)}${invClient(p.invoice_id) ? ' · ' + invClient(p.invoice_id) : ''}${p.description ? ' · ' + p.description : ''}${p.source ? ' · ' + p.source : ''}`, date: p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || null), amount: num(p.amount), undated: !p.paid_at }) }
  // Grupos de compra: um pedido com vários itens vira UMA cobrança no banco.
  // Só entram os MESMOS itens que contam (PURCHASED, livres, não-BR); grupo com
  // item já casado não é oferecido. invoice_expenses agrupa também (v0.3.0).
  const groups = new Map<string, { amount: number; date: string | null; label: string; n: number; undated: boolean }>()
  for (const [tbl, rows] of [['goods', goods], ['inputs', inputs], ['inventory', inventory], ['invoice_expenses', invExp]] as const) {
    for (const r of rows) {
      if (!r.purchase_group || brokenGroups.has(r.purchase_group) || takenGroups.has(r.purchase_group) || brPaid(r)) continue
      if (tbl === 'inventory' && r.source_type !== 'PURCHASED') continue
      if (tbl === 'invoice_expenses' && (!invById.get(r.invoice_id) || invById.get(r.invoice_id).is_quote)) continue
      const g = groups.get(r.purchase_group) || { amount: 0, date: null, label: `PEDIDO · ${r.supplier || tbl.toUpperCase()}${tbl === 'invoice_expenses' ? ' · ' + invLabel(r.invoice_id) : ''}`, n: 0, undated: false }
      g.amount += tbl === 'invoice_expenses' ? num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra) : num(r.unit_price) * (num(r.quantity) || 1); g.n++
      const d = r.payment_date || r.purchase_date || r.expense_date || null
      if (d && (!g.date || d < g.date)) g.date = d
      if (!okDate(r.payment_date)) g.undated = true
      groups.set(r.purchase_group, g)
    }
  }
  groups.forEach((g, id) => { if (g.n > 1) push(out, { table: 'purchase_group', id, label: `${g.label} · ${g.n} itens`, date: g.date, amount: g.amount, undated: g.undated }) })
  return { out, inn }
}

function tokens(s: string) { return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4)) }

export function rank(line: any, pool: { out: Cand[]; inn: Cand[] }): Cand[] {
  const amt = Math.abs(num(line.amount))
  const arr = num(line.amount) > 0 ? pool.out : pool.inn
  const bankTok = tokens((line.merchant || '') + ' ' + (line.name || ''))
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
    const lt = tokens(c.label); let hit = 0; bankTok.forEach(t => { if (lt.has(t)) hit++ })
    score += Math.min(15, hit * 5)
    if (nameHit(line, c)) score += 10
    return { ...c, score, dd }
  }).filter(c => (c.score || 0) > 20).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)
}

/* ─────────────── MOTORES AUTOMÁTICOS (v0.3.0) ─────────────── */

// Como o banco escreve ⇄ como o app chama. Só o que a medição de 22/ago mostrou
// de fato nas linhas da Regions; cresce com a tabela de aliases da v0.3.1.
const ALIASES: [RegExp, string[]][] = [
  [/DELAWAR/i, ['high horse', 'hhp']], [/HPTUNER|HP TUNERS/i, ['hp tuners', 'hptuners']], [/TITAN MOT/i, ['titan']],
  [/TEXASSPEE|TEXAS SPEED/i, ['texas speed']], [/KONG PE/i, ['kong']], [/ZPE IN|ZPE\b/i, ['zpe', 'griptec']], [/MODERN|MMX/i, ['modern muscle', 'mmx']],
  [/METAPLATFOR|FACEBK|META PLATFORMS/i, ['facebook', 'instagram', 'anuncio', 'anúncio', 'meta']], [/AMERICAN AIR/i, ['flight', 'voo', 'american']],
  [/LAGOSEC/i, ['nordvpn', 'nord']], [/PROGRESSIVE/i, ['progressive']], [/TREPERFO|T1 RACE/i, ['t1 race', 'race develop']], [/ANTHROPIC|CLAUDE/i, ['claude', 'anthropic']],
  [/DLAUTO/i, ['dlauto', 'dl auto']], [/REGIONS|WIRE TRANSFER|ANALYSIS|ASSESSMENT|WITHDRAWAL/i, ['regions', 'wire', 'tarifa', 'fee']], [/SPACE ORL/i, ['space orl', 'warehouse', 'galpão', 'galpao']],
  [/LUMA|VENTERRA/i, ['luma', 'headwaters']], [/DUKE/i, ['duke']], [/DROPBOX/i, ['dropbox']], [/APPLE/i, ['apple', 'icloud']], [/GOOGLE/i, ['google']], [/SUPABASE/i, ['supabase']], [/VERCEL/i, ['vercel']],
  [/AUTOZONE/i, ['autozone']], [/HARBOR/i, ['harbor']], [/SUMMIT/i, ['summit']], [/JEGS/i, ['jegs']], [/EBAY/i, ['ebay']], [/AMAZON|AMZN/i, ['amazon']], [/WALMART|WAL-MART/i, ['walmart']],
  [/RACETRAC|WAWA|SHELL|\bBP\b|7-ELEVEN|CHEVRON|EXXON/i, ['fuel', 'gasolina', 'combustível', 'combustivel']],
]
// Nome bate? Token de ≥4 letras em comum (prefixo de 5 vale: "progressiv" ~
// "progressive") OU alias conhecido. Sem isso o motor não casa sozinho.
function nameHit(line: any, c: Cand): boolean {
  const bank = ((line.merchant || '') + ' ' + (line.name || '')).toLowerCase()
  const lab = String(c.label || '').toLowerCase()
  const bt = [...tokens(bank)], lt = [...tokens(lab)]
  if (bt.some(w => lt.some(x => x === w || (w.length >= 5 && x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))))) return true
  for (const [re, words] of ALIASES) if (re.test(bank) && words.some(w => lab.includes(w))) return true
  return false
}

const FEE_RE = /ANALYSIS CHARGE|SERVICE ASSESSMENT|WIRE TRANSFER INCOMING FEE|WIRE TRANSFER .* FEE|WIRE TRANSFER DOMESTIC OUT F|EXCESSIVE WITHDRAWAL|MONTHLY FEE|CASH DEPOSIT FEE|SERVICE CHARGE|OVERDRAFT|NSF FEE|STOP PAYMENT|PAPER STATEMENT|RETURNED ITEM/i
export const isFee = (l: any) => num(l.amount) > 0 && num(l.amount) <= 300 && !l.pending && (l.category === 'BANK_FEES' || FEE_RE.test(String(l.name || '')))

export type Plan = { fee_match: { line: any; cand: Cand }[]; fee_create: any[]; exact: { line: any; cand: Cand }[]; skipped: Record<string, number> }

// Decide o que é CERTO. Não escreve nada — quem escreve é applyPlan.
export function buildPlan(lines: any[], pool: { out: Cand[]; inn: Cand[] }): Plan {
  const plan: Plan = { fee_match: [], fee_create: [], exact: [], skipped: {} }
  const skip = (k: string) => { plan.skipped[k] = (plan.skipped[k] || 0) + 1 }
  const usedCand = new Set<string>()
  const key = (l: any) => (num(l.amount) > 0 ? 'o' : 'i') + Math.abs(num(l.amount)).toFixed(2)
  const sorted = [...lines].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  for (const l of sorted) {
    const amt = Math.abs(num(l.amount))
    if (isFee(l)) {
      // Tarifa já lançada no app (ex.: "Wire fee Regions" numa invoice)? Casa com ela.
      const c = pool.out.filter(x => !usedCand.has(x.table + ':' + x.id) && Math.abs(x.amount - amt) < 0.011 && x.date && daysBetween(x.date, l.date) <= 7 && /regions|wire|tarifa|fee|taxa|banc/i.test(x.label))
      if (c.length === 1) { usedCand.add(c[0].table + ':' + c[0].id); plan.fee_match.push({ line: l, cand: c[0] }) }
      else plan.fee_create.push(l)
      continue
    }
    if (l.pending) { skip('pendente'); continue }
    const arr = num(l.amount) > 0 ? pool.out : pool.inn
    const same = arr.filter(x => !usedCand.has(x.table + ':' + x.id) && Math.abs(x.amount - amt) < 0.011)
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
    usedCand.add(c.table + ':' + c.id)
    plan.exact.push({ line: l, cand: c })
  }
  return plan
}

// Escreve o MATCH (usado pelo humano e pelos motores): status + backfill de data.
export async function writeMatch(db: any, line: any, table: string, rowId: string, extra: Record<string, unknown>, changed: string[]) {
  const update = { match_status: 'MATCHED', matched_table: table, matched_id: rowId, ...extra }
  if (DATE_TABLES.has(table)) {
    const { data: r } = await db.from(table).update({ payment_date: line.date }).eq('id', rowId).is('payment_date', null).select('id')
    if (r && r.length) changed.push(`${table}.payment_date=${line.date}`)
  } else if (table === 'invoice_payments') {
    const { data: r } = await db.from('invoice_payments').update({ paid_at: paidAtFor(line.date) }).eq('id', rowId).is('paid_at', null).select('id')
    if (r && r.length) changed.push(`invoice_payments.paid_at=${line.date}`)
  } else if (table === 'purchase_group') {
    for (const t of GROUP_TABLES) {
      let q = db.from(t).update({ payment_date: line.date }).eq('purchase_group', rowId).is('payment_date', null)
      if (t === 'inventory') q = q.eq('source_type', 'PURCHASED')
      const { data: r } = await q.select('id')
      if (r && r.length) changed.push(`${t}×${r.length}.payment_date=${line.date}`)
    }
  }
  const { error } = await db.from('bank_transactions').update(update).eq('id', line.id).eq('match_status', 'NEW')
  if (error) throw new Error(error.message)
  return update
}

// Desfaz EXATAMENTE o que o MATCH escreveu: só campos iguais ao valor do banco
// (o .is(null) do backfill garante que valor preexistente nunca foi sobrescrito,
// então igual-ao-banco = escrito por nós). Linha criada pelo motor FEE é apagada.
export async function writeUnmatch(db: any, line: any, changed: string[]) {
  if (line.match_status === 'MATCHED' && line.matched_table && line.matched_id) {
    const t = line.matched_table as string, id = line.matched_id as string
    if (line.match_engine === 'FEE' && t === 'fixed_cost_expenses') {
      const { data: r } = await db.from('fixed_cost_expenses').delete().eq('id', id).eq('bank_transaction_id', line.id).select('id')
      if (r && r.length) changed.push('fixed_cost_expenses (tarifa criada pelo motor) apagada')
    }
    if (DATE_TABLES.has(t)) {
      const { data: r } = await db.from(t).update({ payment_date: null }).eq('id', id).eq('payment_date', line.date).select('id')
      if (r && r.length) changed.push(`${t}.payment_date→null`)
    } else if (t === 'invoice_payments') {
      const { data: r } = await db.from('invoice_payments').update({ paid_at: null }).eq('id', id).eq('paid_at', paidAtFor(line.date)).select('id')
      if (r && r.length) changed.push('invoice_payments.paid_at→null')
    } else if (t === 'purchase_group') {
      for (const g of GROUP_TABLES) {
        const { data: r } = await db.from(g).update({ payment_date: null }).eq('purchase_group', id).eq('payment_date', line.date).select('id')
        if (r && r.length) changed.push(`${g}×${r.length}.payment_date→null`)
      }
    }
  }
  const update = { match_status: 'NEW', matched_table: null, matched_id: null, matched_note: null, match_engine: null, match_batch: null, reviewed_at: null }
  const { error } = await db.from('bank_transactions').update(update).eq('id', line.id)
  if (error) throw new Error(error.message)
  return update
}

async function regionsSupplier(db: any): Promise<string> {
  const { data } = await db.from('fixed_cost_suppliers').select('id').ilike('company', 'Regions Bank%').limit(1).maybeSingle()
  if (data?.id) return data.id
  const { data: ins, error } = await db.from('fixed_cost_suppliers').insert({ company: 'Regions Bank', description: 'Tarifas da conta •9336 — wire fee, analysis charge, international service assessment (criado pelo motor FEE do Bank Link)', cost_type: 'FIXED', periodicity: 'MONTHLY' }).select('id').single()
  if (error || !ins) throw new Error('não consegui criar o fornecedor "Regions Bank": ' + (error?.message || '?'))
  return ins.id
}

export async function applyPlan(db: any, plan: Plan) {
  const batch = randomUUID()
  const fixes: any[] = []
  const res = { batch, fee_match: 0, fee_create: 0, exact: 0, errors: [] as string[] }
  const lineLabel = (l: any) => `${l.date} · ${l.merchant || l.name || ''} · ${num(l.amount)}`
  let supplierId: string | null = null
  for (const l of plan.fee_create) {
    try {
      supplierId = supplierId || await regionsSupplier(db)
      const desc = `${String(l.name || 'Tarifa bancária').trim()} — tarifa Regions •9336 (auto · Bank Link)`
      const { data: row, error } = await db.from('fixed_cost_expenses').insert({
        supplier_id: supplierId, type: 'SINGLE', description: desc.slice(0, 200), amount: Math.abs(num(l.amount)), source: 'GZ28US',
        expense_date: l.date, payment_date: l.date, paid_from: 'GZ28US', payment_method: 'DEBIT', bank_transaction_id: l.id,
      }).select('id').single()
      if (error || !row) throw new Error(error?.message || 'insert falhou')
      const changed: string[] = []
      await writeMatch(db, l, 'fixed_cost_expenses', row.id, { matched_note: 'AUTO · FEE · ' + desc.slice(0, 120), match_engine: 'FEE', match_batch: batch, reviewed_at: null }, changed)
      res.fee_create++
      fixes.push({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id: l.id, field: 'match_status', old_value: 'NEW', new_value: 'MATCHED', label: ('FEE criou tarifa · ' + lineLabel(l)).slice(0, 200) })
    } catch (e) { res.errors.push('FEE ' + lineLabel(l) + ': ' + String((e as Error).message || e)) }
  }
  for (const { line: l, cand: c } of plan.fee_match) {
    try {
      const changed: string[] = []
      await writeMatch(db, l, c.table, c.id, { matched_note: 'AUTO · FEE · ' + c.label.slice(0, 120), match_engine: 'FEE', match_batch: batch, reviewed_at: null }, changed)
      res.fee_match++
      fixes.push({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id: l.id, field: 'match_status', old_value: 'NEW', new_value: 'MATCHED', label: ('FEE · ' + lineLabel(l) + ' ⇄ ' + c.label + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200) })
    } catch (e) { res.errors.push('FEE ' + lineLabel(l) + ': ' + String((e as Error).message || e)) }
  }
  for (const { line: l, cand: c } of plan.exact) {
    try {
      const changed: string[] = []
      await writeMatch(db, l, c.table, c.id, { matched_note: 'AUTO · EXACT · ' + c.label.slice(0, 120), match_engine: 'EXACT', match_batch: batch, reviewed_at: null }, changed)
      res.exact++
      fixes.push({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id: l.id, field: 'match_status', old_value: 'NEW', new_value: 'MATCHED', label: ('EXACT · ' + lineLabel(l) + ' ⇄ ' + c.label + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200) })
    } catch (e) { res.errors.push('EXACT ' + lineLabel(l) + ': ' + String((e as Error).message || e)) }
  }
  for (let i = 0; i < fixes.length; i += 200) await db.from('data_fixes').insert(fixes.slice(i, i + 200)).then(() => undefined, () => undefined)
  return res
}

export const planSummary = (plan: Plan) => ({
  fee_create: plan.fee_create.length, fee_match: plan.fee_match.length, exact: plan.exact.length,
  total: plan.fee_create.length + plan.fee_match.length + plan.exact.length, skipped: plan.skipped,
  samples: {
    fee: plan.fee_create.slice(0, 5).map(l => `${l.date} · ${l.name} · $${Math.abs(num(l.amount)).toFixed(2)}`),
    exact: plan.exact.slice(0, 12).map(({ line: l, cand: c }) => `${l.date} · ${l.merchant || l.name} · ${num(l.amount) > 0 ? '−' : '+'}$${Math.abs(num(l.amount)).toFixed(2)} ⇄ ${c.label}`),
  },
})

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

