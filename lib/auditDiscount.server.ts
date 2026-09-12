// SERVER-ONLY — O DESCONTO ESTÁ NO PREÇO OU SÓ NO CAMPO? (Data Checker · auditoria, João, 10/set/2026)
//
// A régua, conferida no código (não suposta):
//   · `price` de invoice_expenses é o custo LÍQUIDO, o que saiu do caixa. O expLine (lib/financials.ts:16-17) soma
//     price × qtd + tax + extra e NÃO toca no desconto; a conferência do banco faz a mesma conta
//     (app/api/bank/reconcile/route.ts:28-33).
//   · `item_discount` é PERCENTUAL e só reconstrói o preço de mercado: sem MAP no Parts DB, o IMPORT de ITEMS usa
//     price ÷ (1 − %) (app/rides/[id]/invoices/edit/[invoiceId]/page.tsx:1437-1451; packs/edit/[id]/page.tsx:377-386).
//   · O leitor de recibo grava assim por construção: amount = total pago da linha ÷ qtd, % = 1 − pago/lista
//     (app/api/scan-receipt/route.ts:268-275). Regra 7.7 do livro do AUTO-BOOK (lib/autoBookLivro.ts, 10/set).
// O defeito que este módulo procura é o avesso da régua: linha gravada a preço de LISTA, com o % só no campo. O custo do
// carro fica acima do que o banco pagou (a margem parece menor) e, sem MAP no Parts DB, o IMPORT ainda cobra do cliente
// bruto ÷ (1 − %), acima do MAP. Caso real: O&J Woo199927 (US.022.2), 114,37 gravado × 97,21 no extrato, corrigido
// em 10/set com trilha em data_fixes (item-discount-bruto).
// NÃO se corrige aplicando o % no expLine: isso desconta DUAS vezes toda linha que segue a régua (RECADOS.md, 10/set).
// A correção é de DADO, linha a linha, com aval do Márcio. Por isso aqui é SÓ LEITURA: mostra a prova e pergunta.
//
// Onde o campo existe: só em invoice_expenses. inputs, goods, good_expenses e inventory não têm a coluna (conferido no
// banco em 10/set); packs.expenses é modelo, não compra. Linha de ORÇAMENTO (is_quote) não entra no DRE: é classificada
// e contada no resumo, mas não vira item.
//
// Cada linha com item_discount > 0 é julgada dentro da COMPRA (purchase_group → order_number → fornecedor + dia), depois
// na parte dessa compra que está na mesma invoice, depois sozinha:
//   gravado = Σ price × qtd + tax + extra        com desconto = Σ price × (1 − %) × qtd + tax + extra
//   BRUTA           prova de pagamento bate com o valor COM desconto: a linha da Regions casada com a linha ou o pedido; ou
//                   uma linha da Regions ainda solta, do mesmo fornecedor, a ±10 d; ou o total do pedido em supplier_orders.
//   LIQUIDA         a mesma prova bate com o GRAVADO; ou o MAP do Parts DB × (1 − %) ≈ price (±1%); ou a linha nasceu do
//                   leitor de recibo (grupo + recibo + pago no dia da nota) e o MAP não diz o contrário.
//   BRUTA_PROVAVEL  nenhuma prova de pagamento decide e price ≈ MAP do Parts DB (±1%) com % > 2: ou a linha está bruta,
//                   ou o % não vale para esta compra. É pergunta, não sentença.
//   SEM_PROVA       nada decide (pagou por fora da Regions, sem data de pagamento, antes do feed, sem MAP, % pequeno demais
//                   para separar as duas contas, banco casado com valor que não é nenhuma das duas).
// Prova de pagamento vence o MAP (MAP muda com o tempo); MAP dizendo BRUTA vence a assinatura do recibo (quem cala promete).
// Item só para BRUTA e BRUTA_PROVAVEL, com amount = gravado − com desconto (o custo a mais). A evidência diz também como o
// preço de ITEMS daquela peça foi montado (invoice_parts.base_cost × as contas do IMPORT); cobrança acima do MAP vai à
// parte no resumo.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchAll, num, nameHit, loadDbAliases, stmtMerchant, type Cand } from './bankReconcile.server'
import { supplierDirectoryFrom, matchSupplier, normSup } from './supplierMatch'

export type AuditRef = { table: string; id: string; label: string; href?: string | null }
export type AuditItem = { key: string; kind: string; title: string; amount: number; date: string | null; refs: AuditRef[]; evidence: string }
export type DiscountAudit = { items: AuditItem[]; summary: Record<string, number | string> }
export type DiscountClass = 'BRUTA' | 'BRUTA_PROVAVEL' | 'LIQUIDA' | 'SEM_PROVA'
export type DiscountProof = 'BANCO_CASADO' | 'BANCO_SOLTO' | 'PEDIDO' | 'MAP' | 'RECIBO'
// Como o preço de ITEMS daquela peça foi montado: bruto ÷ (1 − %), pelo MAP do Parts DB, a preço de custo, outra conta, ou não importada.
export type ItemsBuild = 'BRUTO_DIV' | 'MAP' | 'CUSTO' | 'OUTRO' | 'SEM_ITEM'
export type DiscountVerdict = {
  id: string; invoice_id: string; quote: boolean; cls: DiscountClass; proof: DiscountProof | null
  level: string | null                 // chave do nível que decidiu: pg:… · on:… · sd:… · …|inv:… · ln:…
  recorded: number; discounted: number // do nível que decidiu (da linha, quando nada decidiu)
  gap: number                          // gravado − com desconto, só desta linha
  paid: number | null                  // o valor da prova (banco ou pedido)
  bank_ids: string[]; order_id: string | null; part_id: string | null
  map_says: 'NET' | 'GROSS' | null; receipt: boolean
  shared: boolean                      // a linha solta da Regions que prova esta compra também bate com OUTRA compra lançada
  why: string                          // SEM_PROVA: o motivo; nos outros, a prova em código curto
  items_build: ItemsBuild; overcharge: number   // overcharge: cobrado do cliente acima do MAP SE a linha estiver bruta
  above_map: number                    // ITEMS montado com preço ÷ (1 − %) acima do MAP que o Parts DB tem hoje (o % maior que o desconto real)
}
export type DiscountData = { expenses: any[]; groupOthers: any[]; invoices: any[]; rides: any[]; bank: any[]; parts: any[]; invParts: any[]; orders: any[]; suppliers: any[] }

const BR_PAID = new Set(['GZ28BR'])   // a régua do candidatePool (bankReconcile.server.ts:176): pagou por fora da Regions — sócio e cliente saíram do vocabulário em 11/set
const brPaid = (r: any) => BR_PAID.has(String(r.paid_from || '')) || String(r.paid_to || '') === 'GZ28BR'
const NOT_LOOSE = new Set(['MATCHED', 'IGNORED', 'TRANSFER', 'REMOVED'])   // linha «solta» = ninguém decidiu o que ela é
const DAYS = 10          // janela da linha solta (data postada OU autorização do cartão × data da compra)
const FEED_LAG = 5       // a Regions posta em lotes de 1 a 5 dias: compra mais nova que isso ainda pode não ter chegado
const MAP_TOL = 0.01     // ±1% no confronto com o MAP
const MIN_DISC = 2       // abaixo disso «igual ao MAP» e «MAP × (1 − %)» ficam dentro da mesma tolerância
const day = (s: any) => String(s || '').slice(0, 10)
const okDay = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(day(s))
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(day(a)) - Date.parse(day(b))) / 864e5))
const shiftDay = (d: string, n: number) => new Date(Date.parse(day(d)) + n * 864e5).toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100
// en-US com centavos, como os outros cards do Data Checker (revisão de 10/set: «US$ 17,88» ao lado de «$18» confundia).
const money = (n: number) => (n < -0.004 ? '-$' : '$') + Math.abs(r2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (d: number) => String(Math.round(d * 100) / 100).replace('.', ',') + '%'
const short = (s: any, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const compact = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const lower = (s: any) => String(s || '').trim().toLowerCase()
const qtyOf = (e: any) => num(e.quantity) || 1
const discOf = (e: any) => { const d = num(e.item_discount); return d > 0 && d < 100 ? d : 0 }   // a mesma faixa do IMPORT (invoices/edit:1445)
// Cópia de expLine (lib/financials.ts:16-17): aquele módulo é 'use client' e puxa o cliente do browser.
const recLine = (e: any) => num(e.price) * qtyOf(e) + num(e.tax) + num(e.extra)
const netLine = (e: any) => num(e.price) * (1 - discOf(e) / 100) * qtyOf(e) + num(e.tax) + num(e.extra)
const orderKey = (s: any) => { const o = String(s || '').trim(); return o && !/^bank:/i.test(o) ? o.toUpperCase().replace(/[^A-Z0-9]/g, '') : '' }
const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]) }

// Cópia de normPN (lib/partsDb.ts:58-80) — o IMPORT chaveia o MAP por ela; lá o módulo arrasta o cliente do browser.
function normPN(pn?: string | null): string {
  const cru = String(pn || '').trim()
  const semLoja = cru.replace(/^[a-z]{2,4}(?=[A-Z0-9])/, '')
  const base = semLoja.replace(/[^A-Za-z0-9]/g, '').length >= 6 ? semLoja : cru
  let x = base.toUpperCase().replace(/\s+X\s*\d+\s*$/, '').replace(/[^A-Z0-9]/g, '')
  x = x.replace(/^(GATES|GAT|DODGE|DOD|MOPAR|NGK|ADO|IND)(?=[A-Z0-9])/, '')
  return x
}

type Level = { key: string; kind: 'PEDIDO' | 'DIA' | 'INVOICE' | 'LINHA'; rows: any[]; others: any[]; pg: string | null; rec: number; net: number; tolR: number; tolD: number; disc: any[]; outside: boolean }
// divergent: banco casado com valor que não é nenhuma das duas contas — não decide, só vira motivo (BANCO_DIVERGE).
type Decision = { cls: 'BRUTA' | 'LIQUIDA'; proof: 'BANCO_CASADO' | 'BANCO_SOLTO' | 'PEDIDO'; lv: Level; paid: number; lines: any[]; days: number | null; order: any | null; divergent?: boolean }

export async function loadDiscountData(db: any): Promise<DiscountData> {
  await loadDbAliases(db)   // apelidos do banco (bank_aliases) pro nameHit — só leitura
  const pgOnly = (q: any) => q.not('purchase_group', 'is', null)
  const [expenses, invoices, rides, bank, parts, invParts, orders, suppliers, goods, inputs, inventory] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, part_number, price, quantity, tax, extra, item_discount, order_number, purchase_group, payment_date, expense_date, paid_from, paid_to, receipt_url'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote, origin'),
    fetchAll(db, 'rides', 'id, project_name'),
    fetchAll(db, 'bank_transactions', 'id, date, amount, name, merchant, pending, match_status, matched_table, matched_id, authorized_date:raw->>authorized_date'),
    fetchAll(db, 'parts_database', 'id, item, part_number, map_price, shipping, handling, unit_price, part_discount, currency'),
    fetchAll(db, 'invoice_parts', 'id, invoice_id, description, unit_price, quantity, base_cost, source_item'),
    fetchAll(db, 'supplier_orders', 'id, supplier_id, supplier_name, order_number, order_date, total, paid_total'),
    fetchAll(db, 'suppliers', 'id, name, aliases, is_dealership'),
    // Membros de pedido nas outras tabelas: o banco cobra o pedido inteiro (candidatePool soma goods/inputs/inventory no grupo).
    fetchAll(db, 'goods', 'id, purchase_group, unit_price, quantity, paid_from, paid_to', pgOnly),
    fetchAll(db, 'inputs', 'id, purchase_group, unit_price, quantity, paid_from, paid_to', pgOnly),
    fetchAll(db, 'inventory', 'id, purchase_group, unit_price, quantity, paid_from, paid_to, source_type', pgOnly),
  ])
  const groupOthers = [...goods.map((r: any) => ({ ...r, table: 'goods' })), ...inputs.map((r: any) => ({ ...r, table: 'inputs' })), ...inventory.map((r: any) => ({ ...r, table: 'inventory' }))]
  return { expenses, groupOthers, invoices, rides, bank, parts, invParts, orders, suppliers }
}

export function auditDiscountFrom(d: DiscountData): DiscountAudit & { verdicts: DiscountVerdict[] } {
  const dir = supplierDirectoryFrom(d.suppliers)
  const canonMemo = new Map<string, string>()
  const canon = (s: any) => { const raw = String(s || ''); let c = canonMemo.get(raw); if (c === undefined) { const m = matchSupplier(raw, dir); c = m ? normSup(m.name) : normSup(raw); canonMemo.set(raw, c) } return c }
  const invById = new Map<string, any>(d.invoices.map((i: any) => [String(i.id), i]))
  const rideById = new Map<string, any>(d.rides.map((r: any) => [String(r.id), r]))
  const invOf = (e: any) => invById.get(String(e.invoice_id)) || null
  const invCode = (e: any) => invOf(e)?.invoice_code || '—'
  // Rótulo e link iguais aos do candidatePool (bankReconcile.server.ts:162, :165).
  const invLabel = (invoiceId: any) => { const i = invById.get(String(invoiceId)); const r = i ? rideById.get(String(i.ride_id)) : null; return i ? `${i.origin === 'BUCKET' ? 'A ATRIBUIR · ' : ''}${i.invoice_code || '—'} ${r?.project_name || ''}`.trim() : '—' }
  const invHref = (invoiceId: any) => { const i = invById.get(String(invoiceId)); if (i && i.origin === 'BUCKET') return '/adm/bank#a-atribuir'; return i && i.ride_id ? `/rides/${i.ride_id}/invoices/${invoiceId}` : '/adm/reports' }
  const expRef = (e: any): AuditRef => ({ table: 'invoice_expenses', id: String(e.id), label: `EXPENSE · ${invLabel(e.invoice_id)} · ${short(e.item)}${e.supplier ? ' · ' + e.supplier : ''}`, href: invHref(e.invoice_id) })

  // ── banco: o que está casado com o quê, o que está solto, até onde o feed vai ──
  const live = d.bank.filter((b: any) => b.match_status !== 'REMOVED')
  const postedDays = live.filter((b: any) => !b.pending && okDay(b.date)).map((b: any) => day(b.date)).sort()
  const feedFrom = postedDays[0] || null, feedUntil = postedDays[postedDays.length - 1] || null
  const pointed = new Map<string, any[]>()
  for (const b of live) if (b.match_status === 'MATCHED' && b.matched_table && b.matched_id) push(pointed, b.matched_table + ':' + b.matched_id, b)
  // Pendente vale como solta: valor ao centavo + mesmo fornecedor + data perto; o texto da evidência diz «pendente».
  const loose = live.filter((b: any) => num(b.amount) > 0 && !NOT_LOOSE.has(String(b.match_status || '')))
  const authOf = (b: any) => okDay(b.authorized_date) ? day(b.authorized_date) : null
  const bankRef = (b: any): AuditRef => ({ table: 'bank_transactions', id: String(b.id), label: `REGIONS · ${day(b.date)} · ${money(num(b.amount))} · ${short(b.merchant || b.name, 40)}`, href: '/adm/bank' })
  const bankTxt = (b: any) => `${day(b.date)}${authOf(b) && authOf(b) !== day(b.date) ? ` (cartão autorizado em ${authOf(b)})` : ''}, ${money(num(b.amount))}${b.pending ? ' (pendente)' : ''}, «${short(b.name || b.merchant, 50)}»`

  // Mesmo fornecedor? nameHit do motor; senão o cadastro resolve os dois lados; senão um nome compacto começa pelo outro (6+).
  const hitMemo = new Map<string, boolean>()
  const vendorHit = (line: any, supplier: any): boolean => {
    const s = String(supplier || '').trim(); if (!s) return false
    const mk = line.id + '|' + s; const got = hitMemo.get(mk); if (got !== undefined) return got
    let hit = nameHit(line, { table: 'invoice_expenses', id: '', label: s, date: null, amount: 0, undated: true } as Cand)
    if (!hit) {
      const bankNames = [String(line.merchant || ''), stmtMerchant(line.name)].filter(Boolean)
      const regS = matchSupplier(s, dir), regB = bankNames.map(n => matchSupplier(n, dir)).find(Boolean) || null
      if (regS && regB) hit = regS.name === regB.name
      else {
        const keys = [compact(s), ...(regS ? regS.keys : [])].filter(k => k.length >= 6)
        const bks = bankNames.map(compact).filter(k => k.length >= 6)
        hit = keys.some(k => bks.some(b => k.startsWith(b) || b.startsWith(k)))
      }
    }
    hitMemo.set(mk, hit)
    return hit
  }
  const sameSup = (a: any, b: any) => { const x = canon(a), y = canon(b); if (!x || !y) return false; if (x === y) return true; const p = compact(a), q = compact(b); return (p.length >= 6 && q.startsWith(p)) || (q.length >= 6 && p.startsWith(q)) }

  // ── Parts DB: a leitura do IMPORT (invoices/edit:653-673 — .neq('currency','BRL') também deixa de fora moeda nula) ──
  const partByPN = new Map<string, any>(), partByName = new Map<string, any>()
  const mapFinalPN = new Map<string, number>(), mapFinalName = new Map<string, number>()
  for (const p of d.parts) {
    if (p.currency == null || String(p.currency) === 'BRL') continue
    const pn = normPN(p.part_number), nm = lower(p.item)
    const mf = num(p.map_price) + num(p.shipping) + num(p.handling)
    if (pn && mf > 0) mapFinalPN.set(pn, mf)
    if (nm && mf > 0 && !mapFinalName.has(nm)) mapFinalName.set(nm, mf)
    if (num(p.map_price) > 0) { if (pn) partByPN.set(pn, p); if (nm && !partByName.has(nm)) partByName.set(nm, p) }
  }
  const partOf = (e: any) => { const pn = normPN(e.part_number); return (pn && partByPN.get(pn)) || partByName.get(lower(e.item)) || null }
  const mapFinalOf = (e: any) => { const pn = normPN(e.part_number); return (pn ? (mapFinalPN.get(pn) || 0) : 0) || mapFinalName.get(lower(e.item)) || 0 }
  const mapTest = (e: any): { p: any; m: number; v: 'NET' | 'GROSS' | null } | null => {
    const p = partOf(e); if (!p) return null
    const m = num(p.map_price), price = num(e.price), dd = discOf(e)
    if (!(price > 0) || dd <= MIN_DISC) return { p, m, v: null }
    const netT = m * (1 - dd / 100)
    const isNet = Math.abs(price - netT) <= netT * MAP_TOL + 0.01, isGross = Math.abs(price - m) <= m * MAP_TOL + 0.01
    return { p, m, v: isNet && !isGross ? 'NET' : isGross && !isNet ? 'GROSS' : null }
  }
  // Assinatura do leitor de recibo (invoices/edit:1119-1133): grupo novo, recibo anexado, pago no dia da nota.
  const fromReceipt = (e: any) => !!String(e.receipt_url || '').trim() && !!e.purchase_group && okDay(e.payment_date) && day(e.payment_date) === day(e.expense_date)

  // ── ITEMS: como a peça foi precificada pro cliente (base_cost × as três contas do IMPORT, invoices/edit:1437-1451) ──
  const partsByInv = new Map<string, any[]>(); for (const p of d.invParts) push(partsByInv, String(p.invoice_id), p)
  const itemsOf = (e: any): { build: ItemsBuild; part: any | null; overcharge: number; aboveMap: number } => {
    const cands = (partsByInv.get(String(e.invoice_id)) || []).filter((p: any) => lower(p.source_item) === lower(e.item))
    if (!cands.length) return { build: 'SEM_ITEM', part: null, overcharge: 0, aboveMap: 0 }
    const qty = qtyOf(e), price = num(e.price), dd = discOf(e) / 100, mf = mapFinalOf(e)
    const per = (mb: number) => (mb * qty + num(e.tax) + num(e.extra)) / qty
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.01)
    const tests: [ItemsBuild, number | null][] = [['BRUTO_DIV', dd > 0 ? per(price / (1 - dd)) : null], ['MAP', mf > 0 ? per(mf) : null], ['CUSTO', per(price)]]
    for (const [build, target] of tests) {
      if (target == null) continue
      const part = cands.find((p: any) => near(num(p.base_cost), target))
      if (!part) continue
      // Se a linha está bruta, a base certa seria o próprio preço (líquido ÷ (1 − %)); o IMPORT cobrou price ÷ (1 − %).
      const factor = num(part.base_cost) > 0 ? num(part.unit_price) / num(part.base_cost) : 1
      // Montado pelo ÷ com MAP conhecido HOJE e acima dele: o % gravado é maior que o desconto real contra o MAP.
      const excess = build === 'BRUTO_DIV' && mf > 0 ? num(part.base_cost) - per(mf) : 0
      return { build, part, overcharge: build === 'BRUTO_DIV' ? r2(price * dd / (1 - dd) * factor * qty) : 0, aboveMap: excess > per(mf) * 0.02 ? r2(excess * factor * qty) : 0 }
    }
    return { build: 'OUTRO', part: cands[0], overcharge: 0, aboveMap: 0 }
  }

  // ── compras: o mesmo pedido que o banco cobra de uma vez ──
  const keyOf = (e: any) => {
    if (e.purchase_group) return 'pg:' + e.purchase_group
    const sup = canon(e.supplier), ok = orderKey(e.order_number)
    if (ok) return 'on:' + ok + '|' + sup
    const dt = day(e.payment_date || e.expense_date)
    return sup && okDay(dt) ? 'sd:' + sup + '|' + dt : 'ln:' + e.id
  }
  const groups = new Map<string, any[]>()
  for (const e of d.expenses) { const i = invOf(e); if (i && i.is_quote !== true) push(groups, keyOf(e), e) }   // orçamento fica fora da soma (candidatePool: realInvoice)
  const others = new Map<string, any[]>()
  for (const o of d.groupOthers) { if (!o.purchase_group || brPaid(o) || (o.table === 'inventory' && o.source_type !== 'PURCHASED')) continue; push(others, String(o.purchase_group), o) }
  const mkLevel = (key: string, kind: Level['kind'], rows: any[], oth: any[], pg: string | null): Level => {
    const inside = rows.filter(r => !brPaid(r))
    let rec = 0, net = 0, q = 0, gross = 0
    for (const r of inside) { rec += recLine(r); net += netLine(r); q += qtyOf(r); if (discOf(r) > 0) gross += num(r.price) * qtyOf(r) }
    for (const o of oth) { const a = num(o.unit_price) * (num(o.quantity) || 1); rec += a; net += a; q += num(o.quantity) || 1 }
    // Centavos: o preço unitário é arredondado a 2 casas (scan-receipt:280) — até meio centavo por unidade; o % impresso a
    // 1 casa (scan-receipt:274) desloca o valor com desconto em até 0,05% do bruto.
    const tolR = Math.min(1, Math.max(0.05, 0.005 * q + 0.01))
    return { key, kind, rows, others: oth, pg, rec, net, tolR, tolD: Math.max(tolR, Math.min(2, gross * 0.0006)), disc: inside.filter(r => discOf(r) > 0), outside: inside.length < rows.length }
  }
  const levelMemo = new Map<string, Level[]>()
  const levelsOf = (e: any): Level[] => {
    const k = keyOf(e), g = groups.get(k) || [e], pg = e.purchase_group ? String(e.purchase_group) : null, oth = pg ? (others.get(pg) || []) : []
    const mk = k + '#' + e.invoice_id + '#' + e.id
    const cached = levelMemo.get(mk); if (cached) return cached
    const out: Level[] = [mkLevel(k, k.startsWith('sd:') ? 'DIA' : k.startsWith('ln:') ? 'LINHA' : 'PEDIDO', g, oth, pg)]
    const inv = g.filter(r => String(r.invoice_id) === String(e.invoice_id))
    if (inv.length < g.length || (oth.length && inv.length > 1)) out.push(mkLevel(k + '|inv:' + e.invoice_id, 'INVOICE', inv, [], null))
    const lastLv = out[out.length - 1]
    if (lastLv.rows.length > 1 || lastLv.others.length) out.push(mkLevel('ln:' + e.id, 'LINHA', [e], [], null))
    levelMemo.set(mk, out)
    return out
  }
  const splittable = (lv: Level) => lv.rec - lv.net > lv.tolR + lv.tolD
  const judge = (amt: number, lv: Level): 'NET' | 'GROSS' | null => {
    if (!splittable(lv)) return null
    const n = Math.abs(amt - lv.rec) <= lv.tolR, g = Math.abs(amt - lv.net) <= lv.tolD
    return n && !g ? 'NET' : g && !n ? 'GROSS' : null
  }
  // (a) banco casado: toda linha do nível coberta por casamento (dela ou do pedido); soma das linhas do banco.
  const linkedOf = (lv: Level): any[] | null => {
    const inside = lv.rows.filter(r => !brPaid(r)); if (!inside.length) return null
    const grp = lv.pg ? (pointed.get('purchase_group:' + lv.pg) || []) : []
    const seen = new Map<string, any>(); for (const b of grp) seen.set(String(b.id), b)
    for (const r of inside) { const own = pointed.get('invoice_expenses:' + r.id) || []; if (!own.length && !grp.length) return null; for (const b of own) seen.set(String(b.id), b) }
    for (const o of lv.others) { const own = pointed.get(o.table + ':' + o.id) || []; if (!own.length && !grp.length) return null; for (const b of own) seen.set(String(b.id), b) }
    return seen.size ? [...seen.values()] : null
  }
  // (b) banco solto: mesmo fornecedor, ±10 d, valor de um lado só — e nenhuma solta do outro lado (senão é empate).
  const looseOf = (lv: Level, supplier: any): { b: any; side: 'NET' | 'GROSS'; days: number } | null => {
    if (lv.outside || !splittable(lv)) return null
    const dates = lv.rows.map(r => day(r.payment_date || r.expense_date)).filter(okDay)
    if (!dates.length) return null
    let best: { b: any; side: 'NET' | 'GROSS'; days: number } | null = null
    const sides = new Set<string>()
    for (const b of loose) {
      const amt = num(b.amount), n = Math.abs(amt - lv.rec) <= lv.tolR, g = Math.abs(amt - lv.net) <= lv.tolD
      if (n === g) continue
      const a = authOf(b)
      let dd = Infinity
      for (const dt of dates) { dd = Math.min(dd, dayDiff(b.date, dt)); if (a) dd = Math.min(dd, dayDiff(a, dt)) }
      if (dd > DAYS || !vendorHit(b, supplier)) continue
      const side = n ? 'NET' : 'GROSS'
      sides.add(side)
      if (!best || dd < best.days) best = { b, side, days: dd }
    }
    return best && sides.size === 1 ? best : null
  }
  // (e) o pedido registrado (supplier_orders): mesmo número, mesmo fornecedor, total ou pago de um lado só.
  const ordersByKey = new Map<string, any[]>(); for (const o of d.orders) { const k = orderKey(o.order_number); if (k) push(ordersByKey, k, o) }
  const orderOf = (lv: Level): { o: any; amt: number; side: 'NET' | 'GROSS' } | null => {
    const ks = new Set(lv.rows.map(r => orderKey(r.order_number)))
    if (ks.size !== 1 || lv.outside) return null
    const k = [...ks][0]; if (!k) return null
    for (const o of ordersByKey.get(k) || []) {
      if (o.supplier_name && !sameSup(o.supplier_name, lv.rows[0].supplier)) continue
      const amts = [num(o.total), num(o.paid_total)].filter((x, i, arr) => x > 0 && arr.indexOf(x) === i)
      for (const amt of amts) { const side = judge(amt, lv); if (side) return { o, amt, side } }
    }
    return null
  }
  const decMemo = new Map<string, Decision | null>()
  const decide = (tag: string, lv: Level, fn: () => Decision | null) => { const k = tag + '|' + lv.key; if (!decMemo.has(k)) decMemo.set(k, fn()); return decMemo.get(k) || null }

  // ── cada linha com desconto ──
  const all = d.expenses.filter((e: any) => num(e.item_discount) > 0)
  const scoped = all.filter((e: any) => discOf(e) > 0)
    .sort((a: any, b: any) => day(a.payment_date || a.expense_date).localeCompare(day(b.payment_date || b.expense_date)) || String(a.id).localeCompare(String(b.id)))
  const verdicts: DiscountVerdict[] = []
  const decisionOf = new Map<string, Decision>()   // id da linha → decisão do nível (pra montar o item uma vez só)
  let orphan = 0, diverged = 0
  const mirror = new Set<string>()   // o Parts DB espelha a linha (mesmo custo, mesmo %): o MAP concorda, mas não é prova independente
  for (const e of scoped) {
    const inv = invOf(e)
    if (!inv) { orphan++; continue }
    const quote = inv.is_quote === true
    const mt = mapTest(e), receipt = fromReceipt(e), it = itemsOf(e)
    if (mt && Math.abs(num(mt.p.unit_price) - num(e.price)) < 0.011 && Math.abs(num(mt.p.part_discount) - discOf(e)) < 0.25) mirror.add(String(e.id))
    const v: DiscountVerdict = {
      id: String(e.id), invoice_id: String(e.invoice_id), quote, cls: 'SEM_PROVA', proof: null, level: null,
      recorded: r2(recLine(e)), discounted: r2(netLine(e)), gap: r2(recLine(e) - netLine(e)), paid: null,
      bank_ids: [], order_id: null, part_id: mt ? String(mt.p.id) : null, map_says: mt?.v || null, receipt, shared: false, why: '',
      items_build: it.build, overcharge: it.overcharge, above_map: it.aboveMap,
    }
    let dec: Decision | null = null, divergent = false, canSplit = false
    if (!quote && !brPaid(e)) {
      const lvs = levelsOf(e)
      canSplit = lvs.some(splittable)
      for (const lv of lvs) {
        const got = decide('a', lv, () => {
          const ls = linkedOf(lv); if (!ls) return null
          const paid = ls.reduce((s, b) => s + num(b.amount), 0), side = judge(paid, lv)
          if (!side) return splittable(lv) ? { cls: 'LIQUIDA', proof: 'BANCO_CASADO', lv, paid, lines: ls, days: null, order: null, divergent: true } : null
          return { cls: side === 'GROSS' ? 'BRUTA' : 'LIQUIDA', proof: 'BANCO_CASADO', lv, paid, lines: ls, days: null, order: null }
        })
        if (got?.divergent) { divergent = true; continue }
        if (got) { dec = got; break }
      }
      if (!dec) for (const lv of lvs) {
        dec = decide('b', lv, () => { const h = looseOf(lv, e.supplier); return h ? { cls: h.side === 'GROSS' ? 'BRUTA' : 'LIQUIDA', proof: 'BANCO_SOLTO', lv, paid: num(h.b.amount), lines: [h.b], days: h.days, order: null } : null })
        if (dec) break
      }
      if (!dec) for (const lv of lvs) {
        dec = decide('e', lv, () => { const h = orderOf(lv); return h ? { cls: h.side === 'GROSS' ? 'BRUTA' : 'LIQUIDA', proof: 'PEDIDO', lv, paid: h.amt, lines: [], days: null, order: h.o } : null })
        if (dec) break
      }
    }
    if (dec) {
      Object.assign(v, { cls: dec.cls, proof: dec.proof, level: dec.lv.key, recorded: r2(dec.lv.rec), discounted: r2(dec.lv.net), paid: r2(dec.paid), bank_ids: dec.lines.map((b: any) => String(b.id)), order_id: dec.order ? String(dec.order.id) : null, why: dec.proof })
      decisionOf.set(v.id, dec)
    } else if (mt?.v === 'GROSS') Object.assign(v, { cls: 'BRUTA_PROVAVEL', proof: 'MAP', why: 'MAP' })
    else if (mt?.v === 'NET') Object.assign(v, { cls: 'LIQUIDA', proof: 'MAP', why: 'MAP' })
    else if (receipt) Object.assign(v, { cls: 'LIQUIDA', proof: 'RECIBO', why: 'RECIBO' })
    else {
      const pay = day(e.payment_date)
      v.why = num(e.price) <= 0 ? 'PRECO_ZERO'
        : quote ? 'ORCAMENTO'
        : brPaid(e) ? 'PAGO_FORA_REGIONS'
        : !okDay(pay) ? 'SEM_PAGAMENTO'
        : !canSplit ? 'DESCONTO_PEQUENO'
        : divergent ? 'BANCO_DIVERGE'
        : feedFrom && pay < shiftDay(feedFrom, -DAYS) ? 'ANTES_DO_FEED'
        : feedUntil && pay > shiftDay(feedUntil, -FEED_LAG) ? 'FEED_AINDA_NAO_CHEGOU'
        : 'NADA_BATE'
    }
    if (divergent && !dec) diverged++
    verdicts.push(v)
  }

  // Uma linha solta, duas compras: o pagamento prova UMA delas — a outra pode ser a mesma compra lançada duas vezes.
  const looseUse = new Map<string, Set<string>>()
  for (const v of verdicts) if (v.proof === 'BANCO_SOLTO' && v.level) for (const b of v.bank_ids) { const s = looseUse.get(b) || new Set<string>(); s.add(v.level); looseUse.set(b, s) }
  for (const v of verdicts) if (v.proof === 'BANCO_SOLTO' && v.bank_ids.some(b => (looseUse.get(b)?.size || 0) > 1)) v.shared = true

  // ── itens: BRUTA por compra (a prova é do pedido), BRUTA_PROVAVEL por linha ──
  const byId = new Map<string, any>(d.expenses.map((e: any) => [String(e.id), e]))
  const itemsText = (rows: any[], iff: boolean) => {
    const bs = rows.map(r => itemsOf(r)), n = (k: ItemsBuild) => bs.filter(b => b.build === k).length
    const over = r2(bs.reduce((s, b) => s + b.overcharge, 0)), parts: string[] = []
    const one = rows.length === 1
    if (n('BRUTO_DIV')) parts.push(`${one ? 'montado' : n('BRUTO_DIV') + ' montada(s)'} com preço ÷ (1 − %)${iff ? ' — se a linha está bruta, o cliente foi cobrado' : ' — cliente cobrado'} ${money(over)} acima do MAP`)
    if (n('MAP')) parts.push(`${one ? 'montado' : n('MAP') + ' montada(s)'} pelo MAP do Parts DB (sem cobrança acima do MAP)`)
    if (n('CUSTO')) parts.push(`${one ? 'montado' : n('CUSTO') + ' montada(s)'} a preço de custo, sem reconstruir o MAP`)
    if (n('OUTRO')) parts.push(`${one ? 'com' : n('OUTRO') + ' com'} base que não sai de nenhuma conta do IMPORT (editada à mão?)`)
    if (n('SEM_ITEM')) parts.push(`${one ? 'peça ainda não importada' : n('SEM_ITEM') + ' ainda não importada(s)'}`)
    return 'ITENS: ' + parts.join('; ') + '.'
  }
  const itemRefs = (rows: any[]) => rows.map(r => itemsOf(r)).filter(x => x.build === 'BRUTO_DIV' && x.part).map(x => ({ table: 'invoice_parts', id: String(x.part.id), label: `ITEM · ${invLabel(x.part.invoice_id)} · ${short(x.part.description)}`, href: invHref(x.part.invoice_id) }))
  const items: AuditItem[] = []
  const doneLevels = new Set<string>()
  for (const v of verdicts) {
    if (v.cls === 'BRUTA') {
      if (!v.level || doneLevels.has(v.level)) continue
      doneLevels.add(v.level)
      const dec = decisionOf.get(v.id)!, lv = dec.lv
      const rows = verdicts.filter(x => x.level === v.level && x.cls === 'BRUTA').map(x => byId.get(x.id)).filter(Boolean)
      const gap = r2(lv.rec - lv.net)
      const first = rows[0], orderNo = String(first.order_number || '').trim()
      const pcts = [...new Set(rows.map(discOf))].map(pct).join(' / ')
      const codes = [...new Set(rows.map(invCode))].join(', ')
      const who = dec.proof === 'PEDIDO' ? 'o pedido registrado soma' : 'a Regions cobrou'
      const dates = lv.rows.map(r => day(r.payment_date || r.expense_date)).filter(okDay).sort()
      const title = `${first.supplier || 'Fornecedor sem nome'}${orderNo ? ', pedido ' + orderNo : ''} (${codes}): ${rows.length === 1 ? 'a linha' : `as ${rows.length} linhas`} com ${pcts} de desconto ${rows.length === 1 ? 'entrou' : 'entraram'} a preço de lista — o app soma ${money(lv.rec)} e ${who} ${money(dec.paid)}; o custo está ${money(gap)} acima do pago.`
      const proofTxt = dec.proof === 'BANCO_CASADO' ? `Linha da Regions ${dec.lines.map(bankTxt).join(' + ')}, casada com ${lv.pg ? 'o pedido' : 'a linha'}`
        : dec.proof === 'BANCO_SOLTO' ? `Linha da Regions ${bankTxt(dec.lines[0])}, ainda sem casamento — mesmo fornecedor, ${dec.days} d da compra`
        : `Pedido ${dec.order.order_number} em supplier_orders (${dec.order.supplier_name || 'fornecedor'}), ${money(dec.paid)}`
      const evidence = `${proofTxt}: bate com o valor COM desconto (${money(lv.net)}), não com o gravado (${money(lv.rec)}).${v.shared ? ' A mesma linha do banco também bate com outra compra lançada: confira se não é a mesma compra duas vezes.' : ''} ${itemsText(rows, false)}`
      const refs: AuditRef[] = [...rows.map(expRef), ...dec.lines.map(bankRef), ...(dec.order ? [{ table: 'supplier_orders', id: String(dec.order.id), label: `PEDIDO · ${dec.order.supplier_name || ''} · ${dec.order.order_number}`, href: dec.order.supplier_id ? `/suppliers/orders/${dec.order.supplier_id}` : null }] : []), ...itemRefs(rows)]
      items.push({ key: 'BRUTA|' + v.level, kind: 'BRUTA', title, amount: gap, date: dates[0] || (dec.lines[0] ? (authOf(dec.lines[0]) || day(dec.lines[0].date)) : null), refs, evidence })
    } else if (v.cls === 'BRUTA_PROVAVEL' && !v.quote) {
      const e = byId.get(v.id), mt = mapTest(e)!
      const price = num(e.price), dd = discOf(e)
      const why = brPaid(e) ? `pagou ${e.paid_from || e.paid_to}, fora da Regions` : !okDay(e.payment_date) ? 'a linha não tem data de pagamento' : feedFrom && day(e.payment_date) < shiftDay(feedFrom, -DAYS) ? `paga em ${day(e.payment_date)}, antes do feed da Regions (${feedFrom})` : 'nenhuma linha da Regions nem pedido registrado bate com um dos dois valores'
      const paidYet = okDay(e.payment_date)
      const title = `«${short(e.item, 50)}» (${invCode(e)}, ${e.supplier || 'sem fornecedor'}): preço ${money(price)} igual ao MAP do Parts DB com ${pct(dd)} de desconto — se a compra ${paidYet ? 'saiu' : 'sair'} com o desconto, o custo está ${money(v.gap)} acima do ${paidYet ? 'pago' : 'que vai ser pago'}.`
      const pdbCost = num(mt.p.unit_price) > 0 ? `, custo registrado ${money(num(mt.p.unit_price))}${mt.p.part_discount != null ? ` (${pct(num(mt.p.part_discount))})` : ''}` : ''
      const evidence = `Parts DB «${short(mt.p.item, 50)}»${mt.p.part_number ? ` (PN ${mt.p.part_number})` : ''}: MAP ${money(mt.m)}${pdbCost}; a linha grava ${money(price)} × ${qtyOf(e)} com ${pct(dd)} — o líquido seria ${money(price * (1 - dd / 100))} por unidade. Sem prova de pagamento: ${why}.${v.receipt ? ' A linha tem a assinatura do leitor de recibo (que grava o pago): pode ser o % que não vale para esta compra.' : ' Ou o preço está bruto, ou o % não vale para esta compra.'} ${itemsText([e], true)}`
      const refs: AuditRef[] = [expRef(e), { table: 'parts_database', id: String(mt.p.id), label: `PARTS DB · ${short(mt.p.item)}${mt.p.part_number ? ' · ' + mt.p.part_number : ''}`, href: '/parts' }, ...itemRefs([e])]
      items.push({ key: 'BRUTA_PROVAVEL|invoice_expenses:' + v.id, kind: 'BRUTA_PROVAVEL', title, amount: v.gap, date: okDay(e.payment_date || e.expense_date) ? day(e.payment_date || e.expense_date) : null, refs, evidence })
    }
  }
  items.sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key))

  // ── resumo: a classificação inteira, não só os itens ──
  const real = verdicts.filter(v => !v.quote), quotes = verdicts.filter(v => v.quote)
  const cnt = (arr: DiscountVerdict[], f: (v: DiscountVerdict) => boolean) => arr.filter(f).length
  const usd = (arr: DiscountVerdict[], f: (v: DiscountVerdict) => boolean) => r2(arr.filter(f).reduce((s, v) => s + v.gap, 0))
  const summary: Record<string, number | string> = {
    regua: 'price = custo LÍQUIDO; item_discount = % que só reconstrói o MAP (invoices/edit:1444-1446 · scan-receipt:268-275 · expLine sem desconto)',
    linhas_com_desconto: all.length, fora_da_regua_100: all.length - scoped.length, sem_invoice: orphan,
    reais: real.length, orcamento: quotes.length,
    BRUTA: cnt(real, v => v.cls === 'BRUTA'), BRUTA_PROVAVEL: cnt(real, v => v.cls === 'BRUTA_PROVAVEL'), LIQUIDA: cnt(real, v => v.cls === 'LIQUIDA'), SEM_PROVA: cnt(real, v => v.cls === 'SEM_PROVA'),
    usd_se_todas_brutas: usd(real, () => true),
    usd_BRUTA: usd(real, v => v.cls === 'BRUTA'), usd_BRUTA_PROVAVEL: usd(real, v => v.cls === 'BRUTA_PROVAVEL'),
    usd_LIQUIDA_que_o_desconto_no_expLine_tiraria: usd(real, v => v.cls === 'LIQUIDA'), usd_SEM_PROVA: usd(real, v => v.cls === 'SEM_PROVA'),
    compras_BRUTA: doneLevels.size,
    prova_banco_casado: cnt(real, v => v.proof === 'BANCO_CASADO'), prova_banco_solto: cnt(real, v => v.proof === 'BANCO_SOLTO'), prova_pedido: cnt(real, v => v.proof === 'PEDIDO'),
    prova_map: cnt(real, v => v.proof === 'MAP'), prova_recibo: cnt(real, v => v.proof === 'RECIBO'),
    liquida_banco: cnt(real, v => v.cls === 'LIQUIDA' && (v.proof === 'BANCO_CASADO' || v.proof === 'BANCO_SOLTO')), liquida_pedido: cnt(real, v => v.cls === 'LIQUIDA' && v.proof === 'PEDIDO'),
    liquida_map: cnt(real, v => v.cls === 'LIQUIDA' && v.proof === 'MAP'), liquida_recibo: cnt(real, v => v.cls === 'LIQUIDA' && v.proof === 'RECIBO'),
    liquida_map_espelho: cnt(real, v => v.cls === 'LIQUIDA' && v.proof === 'MAP' && mirror.has(v.id)),
    sem_prova_pago_fora_regions: cnt(real, v => v.why === 'PAGO_FORA_REGIONS'), sem_prova_sem_pagamento: cnt(real, v => v.why === 'SEM_PAGAMENTO'),
    sem_prova_antes_do_feed: cnt(real, v => v.why === 'ANTES_DO_FEED'), sem_prova_desconto_pequeno: cnt(real, v => v.why === 'DESCONTO_PEQUENO'),
    sem_prova_banco_diverge: cnt(real, v => v.why === 'BANCO_DIVERGE'), sem_prova_nada_bate: cnt(real, v => v.why === 'NADA_BATE'),
    sem_prova_feed_ainda_nao_chegou: cnt(real, v => v.why === 'FEED_AINDA_NAO_CHEGOU'), sem_prova_preco_zero: cnt(real, v => v.why === 'PRECO_ZERO'),
    prova_solta_compartilhada: cnt(real, v => v.shared),
    banco_casado_sem_nenhuma_das_duas_contas: diverged,
    map_diz_bruta_prova_diz_liquida: cnt(real, v => v.map_says === 'GROSS' && v.cls === 'LIQUIDA' && v.proof !== 'MAP' && v.proof !== 'RECIBO'),
    map_diz_liquida_prova_diz_bruta: cnt(real, v => v.map_says === 'NET' && v.cls === 'BRUTA'),
    recibo_x_map_bruta: cnt(real, v => v.receipt && v.cls === 'BRUTA_PROVAVEL'),
    cobranca_acima_map_linhas: cnt(real, v => v.cls === 'BRUTA' && v.items_build === 'BRUTO_DIV'),
    cobranca_acima_map_usd: r2(real.filter(v => v.cls === 'BRUTA' && v.items_build === 'BRUTO_DIV').reduce((s, v) => s + v.overcharge, 0)),
    cobranca_acima_map_se_bruta_linhas: cnt(real, v => v.cls === 'BRUTA_PROVAVEL' && v.items_build === 'BRUTO_DIV'),
    cobranca_acima_map_se_bruta_usd: r2(real.filter(v => v.cls === 'BRUTA_PROVAVEL' && v.items_build === 'BRUTO_DIV').reduce((s, v) => s + v.overcharge, 0)),
    itens_div_acima_do_map_atual_linhas: cnt(real, v => v.above_map > 0),
    itens_div_acima_do_map_atual_usd: r2(real.reduce((s, v) => s + v.above_map, 0)),
    orc_BRUTA_PROVAVEL: cnt(quotes, v => v.cls === 'BRUTA_PROVAVEL'), orc_LIQUIDA: cnt(quotes, v => v.cls === 'LIQUIDA'), orc_SEM_PROVA: cnt(quotes, v => v.cls === 'SEM_PROVA'),
    usd_orc_BRUTA_PROVAVEL: usd(quotes, v => v.cls === 'BRUTA_PROVAVEL'),
    feed_desde: feedFrom || '', feed_ate: feedUntil || '',
    itens: items.length,
  }
  return { items, summary, verdicts }
}

export async function auditDiscount(db: any): Promise<DiscountAudit> {
  const { items, summary } = auditDiscountFrom(await loadDiscountData(db))
  return { items, summary }
}
