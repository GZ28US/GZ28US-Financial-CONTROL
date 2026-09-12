// SERVER-ONLY — BALDE EM DOBRO: A COBRANÇA QUE O AUTO-LINK PÔS NO BALDE JÁ ESTAVA LANÇADA EM VÁRIAS LINHAS (proposta DC 1.51.0, João, 10/set/2026)
//
// DECISÃO DE 10/SET (João, depois do Márcio): todo LANÇAMENTO é do robô de e-mail AUTO-BOOK (lib/autoBookMail.server.ts, o livro
// dele em lib/autoBookLivro.ts — mãos fora); o AUTO-LINK do Bank Link (lib/bankReconcile.server.ts) só CASA e AUDITA; o Data Checker
// AUDITA: mostra a prova e pergunta a gente. Este módulo é SÓ LEITURA — lê as tabelas, nunca escreve, nunca chama writer do motor.
//
// O QUE ELE PROCURA. Linha do banco que o AUTO-LINK lançou no balde «A ATRIBUIR» (invoice origin BUCKET; a linha do balde é
// invoice_expenses com purchase_group = id da linha do banco, e a linha do banco fica match_engine BUCKET pra vida toda) enquanto a
// MESMA compra já estava lançada por gente em VÁRIAS linhas. O motor só enxerga candidato de UMA linha ou de um purchase_group
// (candidatePool, lib/bankReconcile.server.ts:232-247) e as guardas de criação comparam UMA linha (:829 twin0, :847 nearTwin):
// pedido digitado linha a linha, sem purchase_group (HHP 382525 em 8 linhas na US.022.2; 382528 dividido entre US.031.4 e US.032.4),
// passa invisível, a cobrança cai no balde e o custo entra DUAS vezes — o balde tem linha própria no DRE (CPV) e no DFC
// (lib/financials.ts:31-36, :353-356). Balde já atribuído (CARRO, ESTOQUE, SUPPLIES, DIVIDIR, FIXO, PESSOAL) continua contando: o elo
// purchase_group / bank_transaction_id / payment_reference «bank:» segue a linha do banco (app/api/bank/reconcile/route.ts:935-1046).
//
// CANDIDATO HUMANO = a régua do candidatePool (lib/bankReconcile.server.ts:124-249), nas tabelas de compra que têm order_number:
// invoice_expenses de invoice REAL (existe, não é quote, não é o balde), inputs, goods, inventory PURCHASED; valor > 0; não pago por
// fora da Regions (só GZ28BR desde 11/set, :176); LIVRE — nenhuma linha viva do banco aponta pra ela nem pro grupo dela
// (:143-149, :184); e não nasceu do motor (purchase_group = id de linha do banco, marcador «Bank Link)», order_number «bank:»). O nome
// bate (nameHit / shortNameHit, :296 / :365) e a data (payment_date, senão a da compra — :190, :210, :212, :213) fica a até 10 dias
// da data POSTADA do banco (bank_transactions.date) ou da AUTORIZAÇÃO do cartão (raw->>authorized_date, só quando vem 0 a 10 dias
// antes da postada — a régua proposta do payDateOf).
//
// A PROVA, da mais forte pra mais fraca. Cada linha humana serve a UMA cobrança: a prova mais forte escolhe primeiro e, na mesma
// força, ganha a soma mais exata e depois a data mais perto.
//   PEDIDO        o pedido inteiro — as linhas livres do MESMO order_number (só letras e dígitos, sem zeros à esquerda) somam o valor
//                 do banco (±$0,02). Pedido de 7, 8 ou 9 linhas conta igual (HHP 382525, 382420, 382415 — além do limite da réplica).
//   PEDIDO PARTE  o pedido inteiro não fecha, mas UM destino dele fecha (as linhas do ESTOQUE, dos SUPPLIES, dos GOODS ou de uma
//                 invoice), e só uma combinação de destinos fecha. HHP 382349: as 4 linhas de estoque somam a cobrança; a 5ª, na
//                 US.044.1, repete o NGK que já estava no estoque. Exige o nome do FORNECEDOR batendo com o banco.
//   DIA           sem número de pedido — TODAS as linhas livres do mesmo fornecedor (o nome do fornecedor bate com o banco) no mesmo dia
//                 somam o valor (a nota AZ 02484201271 da 029.2, digitada item a item).
//   DIA PARTE     sem número de pedido — 2 a 6 linhas de um grupo de até 8 do mesmo fornecedor e dia fecham, e é a ÚNICA combinação de
//                 valores que fecha. Grupo maior ou duas combinações = coincidência de centavos, não prova: na nota AZ 02484201271
//                 (16 linhas), SEIS combinações diferentes de 2 a 6 linhas davam os $185.56 da cobrança de 31/jul (±$0,02) — e a
//                 nota inteira é a cobrança de $517.39 de 22/jul.
// order_number que é CÓDIGO DE INVOICE («US.022.1» na correia Gates do estoque) não é pedido do fornecedor: vale como sem número.
//
// FICA FORA DOS ITENS (conta no summary, pra ninguém confundir silêncio com prova): a mesma soma bate com OUTRA linha do banco ainda sem
// casamento (o pedido pode ser dela — duas compras de mesmo total, e o livro não está em dobro); combinação ambígua; pedido igual a UMA
// linha só (gêmeo simples: é das guardas do motor e dos cards de duplicata).
//
// ESTORNADO: a cobrança do balde tem, no mesmo dia ou até 30 dias DEPOIS (data postada), uma ENTRADA do mesmo valor (±$0,01) do mesmo
// comerciante (palavra em comum, a régua do wordHit, :260) que ninguém casou — o balde registraria custo de dinheiro que voltou. Entrada
// já casada = o estorno está no livro; entrada ANTES da cobrança não é estorno dela. Outra cobrança igual do mesmo comerciante, antes da
// entrada e FORA do balde (sem casamento ou casada com registro humano), pode ser a devolvida: fica fora dos itens (summary). Réplica de
// 10/set: a cobrança DELAWAR de $5,349.65 (13/ago) e o crédito de −$5,349.65 (19/ago) — a cobrança ainda estava NEW, fora do balde.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchAll, num, nameHit, shortNameHit, words, signedDays, stmtMerchant, loadDbAliases, BUCKET_ORIGIN, ENGINE_BUCKET, MARKER_BUCKET } from './bankReconcile.server'
import { supplierDirectoryFrom, matchSupplier, normSup } from './supplierMatch'

export type AuditRef = { table: string; id: string; label: string; href?: string | null }
export type AuditItem = { key: string; kind: string; title: string; amount: number; date: string | null; refs: AuditRef[]; evidence: string }
export type BucketOrdersResult = { items: AuditItem[]; summary: Record<string, number | string> }
export type BucketOrdersData = {
  bank: any[]             // bank_transactions — todas, com authorized_date:raw->>authorized_date
  invoices: any[]
  rides: any[]
  invoiceExpenses: any[]
  inputs: any[]
  goods: any[]
  inventory: any[]
  fixed: any[]            // fixed_cost_expenses com bank_transaction_id (balde atribuído a FIXO)
  expenses: any[]         // expenses com payment_reference «bank:» (balde atribuído a PESSOAL)
  suppliers: any[]        // suppliers (name, aliases, is_dealership) — UM FORNECEDOR, UM NOME (lib/supplierMatch.ts)
  mailBooked: any[]       // auto_book_mail (booked_table, booked_id) — só pra dizer «esta linha veio do AUTO-BOOK»
}

export const SUM_TOL = 0.02              // soma do pedido × valor do banco
export const WINDOW_DAYS = 10            // data da linha humana × data postada / autorização
export const AUTH_LAG_MAX_DAYS = 10      // autorização só vale se vier 0 a 10 dias antes da postada
export const REFUND_WINDOW_DAYS = 30     // cobrança → entrada igual do mesmo comerciante (mesmo dia ou depois)
const SUBSET_MIN = 2, SUBSET_MAX = 6, SUBSET_GROUP_MAX = 8, PART_MAX = 6
const BR_PAID = new Set(['GZ28BR'])   // a régua do candidatePool (brPaid, :176); sócio e cliente saíram do vocabulário em 11/set

type Via = 'PEDIDO' | 'PEDIDO_PARTE' | 'DIA' | 'DIA_PARTE'
const VIA_RANK: Record<Via, number> = { PEDIDO: 0, PEDIDO_PARTE: 1, DIA: 2, DIA_PARTE: 3 }
type HRow = { table: string; id: string; key: string; label: string; text: string; supplier: string; sup: string; date: string; dn: number; amount: number; order: string | null; okey: string | null; dest: string; destLabel: string; href: string; mail: boolean; refunded: boolean }
type ORow = { key: string; destLabel: string; text: string; amount: number; status: string }
type Made = { table: string; id: string; label: string; amount: number; href: string; inBucket: boolean; where: string }
type Prop = { line: any; amt: number; via: Via; rows: HRow[]; sum: number; diff: number; dist: number; order: string | null; group: HRow[]; combos: number }

const day = (s: any) => String(s ?? '').slice(0, 10)
const okDay = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(day(s)) && !Number.isNaN(Date.parse(day(s)))
const dayNum = (s: any) => Math.round(Date.parse(day(s)) / 864e5)
const cents = (v: number) => Math.round(v * 100) / 100
export const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const clip = (s: any, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many)
const sumOf = (rs: { amount: number }[]) => rs.reduce((s, r) => s + r.amount, 0)
// wordHit de lib/bankReconcile.server.ts:260 (não exportado) — a mesma régua, copiada: palavra útil igual ou prefixo de 5.
const wordHit = (a: string[], b: string[]) => a.some(w => b.some(x => x === w || (w.length >= 5 && x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))))
const bankWords = (b: any) => words(`${b.merchant || ''} ${b.name || ''}`)

// Chave do pedido: só letras e dígitos, sem zeros à esquerda («#0382528» = «382528»). «bank:<id>» é elo do motor; código de invoice
// («US.022.1») é destino, não pedido do fornecedor; sem dígito ou curto demais («N/A», «TBD») não identifica nada.
export function orderKey(raw: any, invoiceCodes?: Set<string>): string | null {
  const s = String(raw ?? '').trim()
  if (!s || /^bank:/i.test(s)) return null
  const alnum = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (invoiceCodes && invoiceCodes.has(alnum)) return null
  const k = alnum.replace(/^0+/, '')
  return k.length >= 3 && /\d/.test(k) ? k : null
}

// Dia da AUTORIZAÇÃO do cartão quando ela é prova: data válida, 0 a 10 dias antes da postada. Sem isso, null (vale só a postada).
export function authDay(l: any): string | null {
  const bank = day(l?.date), a = day(l?.authorized_date ?? l?.raw?.authorized_date)
  if (!okDay(a) || !okDay(bank)) return null
  const lag = signedDays(a, bank)
  return lag >= 0 && lag <= AUTH_LAG_MAX_DAYS ? a : null
}

export function computeBucketOrders(d: BucketOrdersData): BucketOrdersResult {
  const bank = d.bank || []
  const live = bank.filter((b: any) => String(b.match_status || '') !== 'REMOVED')
  const lineIds = new Set<string>(bank.map((b: any) => String(b.id)))
  const taken = new Set<string>(), takenGroups = new Set<string>()
  for (const b of live) if (b.matched_id) { taken.add(String(b.matched_table) + ':' + String(b.matched_id)); if (b.matched_table === 'purchase_group') takenGroups.add(String(b.matched_id)) }
  const invById = new Map<string, any>((d.invoices || []).map((i: any) => [String(i.id), i]))
  const rideName = new Map<string, string>((d.rides || []).map((r: any) => [String(r.id), String(r.project_name || '')]))
  const invoiceCodes = new Set<string>((d.invoices || []).map((i: any) => String(i.invoice_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter((k: string) => k.length >= 3))
  const invCode = (id: any) => String(invById.get(String(id))?.invoice_code || '—')
  // Rótulo e link exatamente como o candidatePool (lib/bankReconcile.server.ts:162, :165): o nameHit lê o MESMO texto que o motor leu.
  const invLabel = (id: any) => { const i = invById.get(String(id)); return i ? `${i.origin === BUCKET_ORIGIN ? 'A ATRIBUIR · ' : ''}${i.invoice_code || '—'} ${rideName.get(String(i.ride_id)) || ''}`.trim() : '—' }
  const invHref = (id: any) => { const i = invById.get(String(id)); if (i && i.origin === BUCKET_ORIGIN) return '/adm/bank#a-atribuir'; return i && i.ride_id ? `/rides/${i.ride_id}/invoices/${id}` : '/adm/reports' }
  const dir = supplierDirectoryFrom(d.suppliers || [])
  const supCache = new Map<string, string>()
  const supKey = (s: any) => { const raw = String(s || ''); let k = supCache.get(raw); if (k == null) { const m = matchSupplier(raw, dir); k = m ? normSup(m.name) : normSup(raw); supCache.set(raw, k) } return k }
  const fromMail = new Set<string>((d.mailBooked || []).map((m: any) => String(m.booked_table) + ':' + String(m.booked_id)))
  const brPaid = (r: any) => BR_PAID.has(String(r.paid_from || '')) || String(r.paid_to || '') === 'GZ28BR'
  const ieAmt = (r: any) => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra)   // expLine (lib/financials.ts:16)
  const qtyAmt = (r: any) => num(r.unit_price) * (num(r.quantity) || 1)                          // qtyLine (lib/financials.ts:28)

  // ── 1 · linhas humanas: as LIVRES viram candidatas; toda linha com número de pedido entra no retrato do pedido (evidência) ──
  const humans: HRow[] = []
  const orderRows = new Map<string, ORow[]>()
  const consider = (table: string, r: any, amount: number, dateRaw: any, text: string, label: string, dest: string, destLabel: string, href: string, real: boolean) => {
    if ((r.purchase_group && lineIds.has(String(r.purchase_group))) || /Bank Link\)/.test(text) || /^bank:/i.test(String(r.order_number || ''))) return   // nasceu do motor
    const key = table + ':' + r.id
    const okey = orderKey(r.order_number, invoiceCodes)
    const date = day(dateRaw)
    const status = !real ? 'fora da conta' : brPaid(r) ? 'paga por fora da Regions' : (taken.has(key) || (r.purchase_group && takenGroups.has(String(r.purchase_group)))) ? 'já casada com outra linha do banco' : !(amount > 0.005) ? 'valor zero ou estorno' : !okDay(date) ? 'sem data' : 'livre'
    if (okey) orderRows.set(okey, [...(orderRows.get(okey) || []), { key, destLabel, text, amount, status }])
    if (status !== 'livre') return
    humans.push({ table, id: String(r.id), key, label, text, supplier: String(r.supplier || ''), sup: supKey(r.supplier), date, dn: dayNum(date), amount, order: r.order_number ? String(r.order_number) : null, okey, dest, destLabel, href, mail: fromMail.has(key), refunded: String(r.cancel_status || '') === 'REFUNDED' })
  }
  for (const e of d.invoiceExpenses || []) {
    const i = invById.get(String(e.invoice_id))
    consider('invoice_expenses', e, ieAmt(e), e.payment_date || e.expense_date, String(e.item || ''), `EXPENSE · ${invLabel(e.invoice_id)} · ${e.item || ''}${e.supplier ? ' · ' + e.supplier : ''}`, 'inv:' + e.invoice_id, invCode(e.invoice_id), invHref(e.invoice_id), !!i && !i.is_quote && i.origin !== BUCKET_ORIGIN)
  }
  for (const x of d.inputs || []) consider('inputs', x, qtyAmt(x), x.payment_date || x.purchase_date, String(x.description || ''), `SUPPLY · ${x.category ? x.category + ' · ' : ''}${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, 'inputs', 'SUPPLIES', '/supplies', true)
  for (const g of d.goods || []) consider('goods', g, qtyAmt(g), g.payment_date || g.purchase_date, String(g.description || ''), `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, 'goods', 'GOODS', '/goods', true)
  for (const x of d.inventory || []) consider('inventory', x, qtyAmt(x), x.payment_date || x.purchase_date, String(x.description || ''), `STOCK · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, 'inventory', 'ESTOQUE', '/inventory', x.source_type === 'PURCHASED')

  // ── 2 · o que o balde escreveu por linha do banco (no balde ou já atribuído) ──
  const made = new Map<string, Made[]>()
  const addMade = (lineId: any, m: Made) => { const k = String(lineId); const arr = made.get(k) || []; if (!arr.some(x => x.table === m.table && x.id === m.id)) arr.push(m); made.set(k, arr) }
  for (const e of d.invoiceExpenses || []) if (e.purchase_group && lineIds.has(String(e.purchase_group))) {
    const i = invById.get(String(e.invoice_id)), inB = !!i && i.origin === BUCKET_ORIGIN
    addMade(e.purchase_group, { table: 'invoice_expenses', id: String(e.id), label: clip(e.item, 70), amount: ieAmt(e), href: invHref(e.invoice_id), inBucket: inB && String(e.item || '').includes(MARKER_BUCKET), where: inB ? 'A ATRIBUIR' : invCode(e.invoice_id) })
  }
  for (const x of d.inputs || []) if (x.purchase_group && lineIds.has(String(x.purchase_group))) addMade(x.purchase_group, { table: 'inputs', id: String(x.id), label: clip(x.description, 70), amount: qtyAmt(x), href: '/supplies', inBucket: false, where: 'SUPPLIES' })
  for (const x of d.inventory || []) if (x.purchase_group && lineIds.has(String(x.purchase_group))) addMade(x.purchase_group, { table: 'inventory', id: String(x.id), label: clip(x.description, 70), amount: qtyAmt(x), href: '/inventory', inBucket: false, where: 'ESTOQUE' })
  for (const f of d.fixed || []) if (f.bank_transaction_id && lineIds.has(String(f.bank_transaction_id))) addMade(f.bank_transaction_id, { table: 'fixed_cost_expenses', id: String(f.id), label: clip(f.description, 70), amount: num(f.amount), href: f.supplier_id ? '/costs/fixed/' + f.supplier_id : '/costs/fixed', inBucket: false, where: 'FIXO' })
  for (const x of d.expenses || []) { const ref = String(x.payment_reference || ''); if (ref.startsWith('bank:') && lineIds.has(ref.slice(5))) addMade(ref.slice(5), { table: 'expenses', id: String(x.id), label: clip(x.description, 70), amount: num(x.amount), href: '/staff', inBucket: false, where: 'PESSOAL' }) }

  const isBucketLine = (b: any) => b.match_engine === ENGINE_BUCKET && b.match_status === 'MATCHED'
  const bucketLines = live.filter((b: any) => isBucketLine(b) && !b.pending && num(b.amount) > 0.005 && okDay(b.date))
  const distOf = (l: any) => { const pdn = dayNum(l.date), a = authDay(l), adn = a ? dayNum(a) : null; return (r: HRow) => Math.min(Math.abs(r.dn - pdn), adn == null ? Infinity : Math.abs(r.dn - adn)) }
  const hitOf = (l: any) => (r: HRow) => nameHit(l, r as any) || shortNameHit(l, r as any)

  // ── 3 · as provas de cada linha do balde ──
  const props: Prop[] = []
  let singleTwinLines = 0, ambiguousGroups = 0
  for (const l of bucketLines) {
    const amt = cents(num(l.amount))
    const dist = distOf(l), hit = hitOf(l)
    const supHitCache = new Map<string, boolean>()
    const supHit = (r: HRow) => { let v = supHitCache.get(r.supplier); if (v == null) { const c: any = { label: r.supplier }; v = !!r.supplier && (nameHit(l, c) || shortNameHit(l, c)); supHitCache.set(r.supplier, v) } return v }
    const inWin = humans.filter(r => dist(r) <= WINDOW_DAYS)
    if (inWin.some(r => Math.abs(r.amount - amt) < 0.011 && hit(r))) singleTwinLines++
    const near = inWin.filter(r => r.amount < amt - 0.011 && hit(r))
    if (near.length < 2) continue
    const mk = (via: Via, rows: HRow[], order: string | null, group: HRow[], combos: number): Prop => { const sum = sumOf(rows); return { line: l, amt, via, rows, sum, diff: Math.abs(sum - amt), dist: Math.max(...rows.map(dist)), order, group, combos } }
    // PEDIDO e PEDIDO PARTE
    const byOrder = new Map<string, HRow[]>()
    for (const r of near) if (r.okey) byOrder.set(r.okey, [...(byOrder.get(r.okey) || []), r])
    for (const rs of byOrder.values()) {
      if (rs.length < 2) continue
      if (Math.abs(sumOf(rs) - amt) <= SUM_TOL) { props.push(mk('PEDIDO', rs, rs[0].order, rs, 1)); continue }
      if (!rs.some(supHit)) continue
      const parts = new Map<string, HRow[]>()
      for (const r of rs) parts.set(r.dest, [...(parts.get(r.dest) || []), r])
      const P = [...parts.values()]
      if (P.length < 2 || P.length > PART_MAX) continue
      const hits: HRow[][] = []
      for (let mask = 1; mask < (1 << P.length) - 1; mask++) {
        const rows = P.filter((_, i) => (mask & (1 << i)) !== 0).flat()
        if (rows.length >= 2 && Math.abs(sumOf(rows) - amt) <= SUM_TOL) hits.push(rows)
      }
      if (hits.length === 1) props.push(mk('PEDIDO_PARTE', hits[0], rs[0].order, rs, 1))
      else if (hits.length > 1) ambiguousGroups++
    }
    // DIA e DIA PARTE (sem número de pedido; o nome do FORNECEDOR tem que bater com o banco)
    const byDay = new Map<string, HRow[]>()
    for (const r of near) if (!r.okey && r.sup && supHit(r)) { const k = r.sup + '|' + r.date; byDay.set(k, [...(byDay.get(k) || []), r]) }
    for (const rs of byDay.values()) {
      if (rs.length < 2) continue
      if (Math.abs(sumOf(rs) - amt) <= SUM_TOL) { props.push(mk('DIA', rs, null, rs, 1)); continue }
      if (rs.length > SUBSET_GROUP_MAX) continue
      const sigs = new Map<string, HRow[]>(); let combos = 0
      for (let mask = 1; mask < (1 << rs.length); mask++) {
        let k = 0, s = 0
        for (let i = 0; i < rs.length; i++) if (mask & (1 << i)) { k++; s += rs[i].amount }
        if (k < SUBSET_MIN || k > SUBSET_MAX || Math.abs(s - amt) > SUM_TOL) continue
        const pick = rs.filter((_, i) => (mask & (1 << i)) !== 0); combos++
        const sig = pick.map(r => r.amount.toFixed(2)).sort().join('+')
        if (!sigs.has(sig)) sigs.set(sig, pick)
      }
      if (sigs.size === 1) props.push(mk('DIA_PARTE', [...sigs.values()][0], null, rs, combos))
      else if (sigs.size > 1) ambiguousGroups++
    }
  }

  // ── 4 · cada linha humana serve a UMA cobrança: a prova mais forte escolhe primeiro ──
  props.sort((x, y) => VIA_RANK[x.via] - VIA_RANK[y.via] || x.diff - y.diff || x.dist - y.dist || day(x.line.date).localeCompare(day(y.line.date)) || String(x.line.id).localeCompare(String(y.line.id)))
  const usedRow = new Set<string>(), doneLine = new Set<string>()
  const accepted: Prop[] = []
  let lostToStronger = 0
  for (const p of props) {
    const lid = String(p.line.id)
    if (doneLine.has(lid)) continue
    if (p.rows.some(r => usedRow.has(r.key))) { lostToStronger++; continue }
    doneLine.add(lid); for (const r of p.rows) usedRow.add(r.key); accepted.push(p)
  }

  // ── 5 · a mesma soma bate com OUTRA cobrança ainda sem casamento? Então o pedido pode ser dela: pergunta de casamento, não dobra ──
  const openOut = live.filter((b: any) => ['NEW', 'QUEUED'].includes(String(b.match_status || 'NEW')) && !b.pending && num(b.amount) > 0.005 && okDay(b.date))
  const heldDisputed: string[] = []
  const items: AuditItem[] = []
  const lineRef = (l: any): AuditRef => { const a = authDay(l); return { table: 'bank_transactions', id: String(l.id), label: `BANCO · ${day(l.date)} · ${clip(l.merchant || l.name, 48)} · ${usd(Math.abs(num(l.amount)))}${a && a !== day(l.date) ? ' · autorizada ' + a : ''}${l.match_status && l.match_status !== 'MATCHED' ? ' · ' + l.match_status : ''}`, href: '/adm/bank' } }
  const madeOf = (l: any) => made.get(String(l.id)) || []
  const madeRefs = (l: any): AuditRef[] => madeOf(l).map(m => ({ table: m.table, id: m.id, label: `BALDE → ${m.where} · ${m.label} · ${usd(m.amount)}`, href: m.href }))
  const stateOf = (l: any) => { const ms = madeOf(l); if (!ms.length) return 'foi lançada pelo balde (a linha do balde não foi achada)'; if (ms.every(m => m.inBucket)) return 'está no balde A ATRIBUIR'; return 'foi lançada pelo balde e atribuída a ' + [...new Set(ms.map(m => m.where))].join(' + ') }
  const bucketTxt = (l: any) => { const ms = madeOf(l); return ms.length ? `o balde lançou ${usd(cents(sumOf(ms)))} (${[...new Set(ms.map(m => m.where))].join(' + ')})` : 'a linha do balde não foi achada' }
  const merchOf = (l: any) => clip(l.merchant || stmtMerchant(l.name) || l.name, 40)
  const rowLabel = (r: HRow) => `${r.destLabel} · ${clip(r.text, 60)}${r.supplier ? ' · ' + clip(r.supplier, 24) : ''} · ${usd(r.amount)} · ${r.date}${r.order ? ' · pedido ' + clip(r.order, 30) : ''}${r.mail ? ' · AUTO-BOOK' : ''}${r.refunded ? ' · REFUNDED' : ''}`
  const destTxt = (rs: HRow[]) => { const ds = [...new Set(rs.map(r => r.destLabel))]; return ds.length > 3 ? ds.slice(0, 3).join(' + ') + ' e mais ' + (ds.length - 3) : ds.join(' + ') }
  for (const p of accepted) {
    const l = p.line
    const rivals = openOut.filter((b: any) => {
      if (String(b.id) === String(l.id) || Math.abs(num(b.amount) - p.amt) > SUM_TOL) return false
      const bd = distOf(b), bh = hitOf(b)
      return p.rows.every(r => bd(r) <= WINDOW_DAYS) && p.rows.some(bh)
    })
    if (rivals.length) { heldDisputed.push(`${day(l.date)} ${usd(p.amt)} ${clip(merchOf(l), 24)} ⇄ ${rivals.map((b: any) => day(b.date) + ' ' + String(b.match_status || 'NEW')).join(', ')}`); continue }
    const dist = distOf(l), a = authDay(l)
    const ds = p.rows.map(dist), dmin = Math.min(...ds), dmax = Math.max(...ds)
    const dates = [...new Set(p.rows.map(r => r.date))].sort()
    const when = `banco ${day(l.date)}${a && a !== day(l.date) ? ', autorização ' + a : ''}`
    const sumTxt = `somam ${usd(cents(p.sum))} e o banco cobrou ${usd(p.amt)}${p.diff >= 0.005 ? ' (diferença de ' + usd(cents(p.diff)) + ')' : ''}`
    const nearTxt = `lançadas em ${dates.join(', ')}, a ${dmin === dmax ? dmin : dmin + '–' + dmax} dia(s) da compra (${when})`
    const supplier = clip(p.rows[0].supplier, 30)
    let ev = ''
    if (p.via === 'PEDIDO') ev = `PEDIDO INTEIRO — as ${p.rows.length} linhas livres do pedido ${p.order} (nenhuma casada com linha do banco) ${sumTxt}; ${nearTxt}; ${bucketTxt(l)}.`
    else if (p.via === 'PEDIDO_PARTE') { const left = p.group.filter(r => !p.rows.includes(r)); ev = `PARTE DO PEDIDO — o pedido ${p.order} tem ${p.group.length} linhas livres perto da cobrança (${usd(cents(sumOf(p.group)))}); só as de ${destTxt(p.rows)} (${p.rows.length}) ${sumTxt}, e nenhuma outra combinação de destinos fecha; fora da soma: ${left.map(r => r.destLabel + ' «' + clip(r.text, 40) + '» ' + usd(r.amount)).join('; ')} — confira se repete item do pedido; ${nearTxt}; ${bucketTxt(l)}.` }
    else if (p.via === 'DIA') ev = `SEM NÚMERO DE PEDIDO — todas as ${p.rows.length} linhas livres de ${supplier} de ${p.rows[0].date} ${sumTxt}; ${nearTxt}; ${bucketTxt(l)}.`
    else ev = `SEM NÚMERO DE PEDIDO — ${p.rows.length} das ${p.group.length} linhas livres de ${supplier} de ${p.rows[0].date} ${sumTxt}, e é a única combinação de valores (2 a 6 linhas) que fecha${p.combos > 1 ? ` (valores repetidos: ${p.combos} escolhas de linhas equivalentes)` : ''}; ${nearTxt}; ${bucketTxt(l)}.`
    if (p.rows[0].okey) {
      const inGroup = new Set(p.group.map(r => r.key))
      const others = (orderRows.get(p.rows[0].okey) || []).filter(o => !inGroup.has(o.key))
      if (others.length) { const by = new Map<string, number>(); for (const o of others) { const s = o.status === 'livre' ? 'livre, longe da data ou sem o nome' : o.status; by.set(s, (by.get(s) || 0) + 1) } ev += ` O pedido tem mais ${plural(others.length, 'linha', 'linhas')} fora desta conta (${[...by].map(([s, n]) => n + ' ' + s).join(', ')}).` }
    }
    const mailN = p.rows.filter(r => r.mail).length, refN = p.rows.filter(r => r.refunded).length
    if (mailN) ev += ` ${plural(mailN, 'linha veio', 'linhas vieram')} do AUTO-BOOK (e-mail).`
    if (refN) ev += ` ${plural(refN, 'linha está marcada', 'linhas estão marcadas')} REFUNDED.`
    const title = p.order
      ? `A cobrança de ${usd(p.amt)} de ${merchOf(l)} em ${day(l.date)} ${stateOf(l)}, mas o pedido ${clip(p.order, 30)} já está lançado em ${plural(p.rows.length, 'linha', 'linhas')} (${destTxt(p.rows)}) — o custo entra duas vezes.`
      : `A cobrança de ${usd(p.amt)} de ${merchOf(l)} em ${day(l.date)} ${stateOf(l)}, mas a mesma compra de ${supplier} já está lançada em ${plural(p.rows.length, 'linha', 'linhas')} de ${p.rows[0].date} (${destTxt(p.rows)}) — o custo entra duas vezes.`
    items.push({ key: 'DUPLICADO_PEDIDO|' + l.id, kind: 'DUPLICADO_PEDIDO', title, amount: cents(Math.min(p.amt, p.sum)), date: day(l.date), refs: [lineRef(l), ...madeRefs(l), ...p.rows.map(r => ({ table: r.table, id: r.id, label: rowLabel(r), href: r.href }))], evidence: ev })
  }

  // ── 6 · ESTORNADO: cobrança do balde com entrada igual do mesmo comerciante (mesmo dia ou depois), ainda sem casamento ──
  const outs = live.filter((b: any) => !b.pending && num(b.amount) > 0.005 && okDay(b.date))
  const inflows = live.filter((b: any) => !b.pending && num(b.amount) < -0.005 && okDay(b.date))
  const pairs: { l: any; i: any; gap: number }[] = []
  for (const l of bucketLines) {
    const amt = cents(num(l.amount)), lw = bankWords(l)
    if (!lw.length) continue
    for (const i of inflows) {
      if (Math.abs(Math.abs(num(i.amount)) - amt) >= 0.011) continue
      const gap = dayNum(i.date) - dayNum(l.date)   // com sinal: entrada ANTES da cobrança não é estorno dela
      if (gap < 0 || gap > REFUND_WINDOW_DAYS || !wordHit(lw, bankWords(i))) continue
      pairs.push({ l, i, gap })
    }
  }
  pairs.sort((x, y) => x.gap - y.gap || day(x.l.date).localeCompare(day(y.l.date)) || String(x.i.id).localeCompare(String(y.i.id)))
  // 1º casa cada entrada com UMA cobrança (a mais perto); só depois julga — assim a irmã que ganhou a própria entrada não vira dúvida.
  const usedIn = new Set<string>(), usedOut = new Set<string>()
  const chosen: { l: any; i: any; gap: number }[] = []
  for (const pr of pairs) {
    if (usedIn.has(String(pr.i.id)) || usedOut.has(String(pr.l.id))) continue
    usedIn.add(String(pr.i.id)); usedOut.add(String(pr.l.id)); chosen.push(pr)
  }
  let refundBooked = 0, refundHeld = 0
  for (const { l, i, gap } of chosen) {
    if (i.match_status === 'MATCHED') { refundBooked++; continue }   // a entrada já está no livro: o par se anula
    const amt = cents(num(l.amount)), iw = bankWords(i)
    // Irmãs: outra cobrança igual do mesmo comerciante, antes da entrada e na janela — qualquer uma pode ser a devolvida.
    const sibs = outs.filter((o: any) => { if (String(o.id) === String(l.id) || Math.abs(num(o.amount) - amt) >= 0.011) return false; const g = dayNum(i.date) - dayNum(o.date); return g >= 0 && g <= REFUND_WINDOW_DAYS && wordHit(bankWords(o), iw) })
    if (sibs.some((o: any) => !isBucketLine(o))) { refundHeld++; continue }   // a devolvida pode ser a que está fora do balde
    const loose = sibs.filter((o: any) => !usedOut.has(String(o.id)))     // irmã do balde que já ganhou a SUA entrada igual não disputa esta
    const sibTxt = loose.length ? ` Há mais ${plural(loose.length, 'cobrança igual', 'cobranças iguais')} do mesmo comerciante no balde antes da entrada, sem entrada própria (${loose.map((o: any) => day(o.date)).sort().join(', ')}) — o dinheiro voltou uma vez só: diga qual das compras foi devolvida.` : ''
    items.push({
      key: `ESTORNADO|${l.id}|${i.id}`, kind: 'ESTORNADO', amount: amt, date: day(l.date),
      title: `A cobrança de ${usd(amt)} de ${merchOf(l)} em ${day(l.date)} ${stateOf(l)}, mas o banco devolveu ${usd(amt)} do mesmo comerciante em ${day(i.date)} — o balde registra um custo cujo dinheiro voltou.`,
      refs: [lineRef(l), ...madeRefs(l), lineRef(i)],
      evidence: `Entrada de ${usd(Math.abs(num(i.amount)))} em ${day(i.date)} («${clip(i.merchant || i.name, 40)}», ${String(i.match_status || 'NEW')}, sem casamento) ${gap} dia(s) depois da cobrança de ${day(l.date)}: mesmo valor ao centavo e o nome do comerciante em comum; ${bucketTxt(l)}.${sibTxt} Se foi estorno desta compra, o custo do balde não existe; se a entrada é outra coisa, diga o quê.`,
    })
  }

  items.sort((x, y) => y.amount - x.amount || String(x.date).localeCompare(String(y.date)) || x.key.localeCompare(y.key))
  const dup = items.filter(i => i.kind === 'DUPLICADO_PEDIDO'), est = items.filter(i => i.kind === 'ESTORNADO')
  const perLine = new Map<string, number>()
  for (const it of items) { const lid = it.key.split('|')[1]; perLine.set(lid, Math.max(perLine.get(lid) || 0, it.amount)) }
  const emitted = new Set(dup.map(i => i.key.split('|')[1]))
  const shown = accepted.filter(p => emitted.has(String(p.line.id)))
  return {
    items,
    summary: {
      bucket_lines: bucketLines.length,
      bucket_dollars: cents(bucketLines.reduce((s: number, b: any) => s + num(b.amount), 0)),
      free_human_rows: humans.length,
      items: items.length,
      dollars_at_stake: cents([...perLine.values()].reduce((s, v) => s + v, 0)),
      dup_lines: dup.length,
      dup_dollars: cents(sumOf(dup)),
      via_pedido: shown.filter(p => p.via === 'PEDIDO').length,
      via_pedido_parte: shown.filter(p => p.via === 'PEDIDO_PARTE').length,
      via_dia: shown.filter(p => p.via === 'DIA').length,
      via_dia_parte: shown.filter(p => p.via === 'DIA_PARTE').length,
      proofs_7plus_rows: shown.filter(p => p.rows.length >= 7).length,
      estornado: est.length,
      estornado_dollars: cents(sumOf(est)),
      refund_already_booked: refundBooked,
      refund_held_other_charge: refundHeld,
      held_other_open_line: heldDisputed.length,
      held_other_open_line_detail: heldDisputed.join(' | ').slice(0, 1000),
      held_ambiguous_groups: ambiguousGroups,
      proofs_lost_to_stronger: lostToStronger,
      single_row_twin_lines: singleTwinLines,
      rule: `PEDIDO > PEDIDO PARTE > DIA > DIA PARTE · soma ±$${SUM_TOL.toFixed(2)} · ${WINDOW_DAYS} d da data postada ou da autorização · nome bate · estorno ±$0.01, 0 a ${REFUND_WINDOW_DAYS} d depois`,
    },
  }
}

export async function auditBucketOrders(db: any): Promise<BucketOrdersResult> {
  await loadDbAliases(db)   // apelidos do banco (bank_aliases) entram no nameHit, como no motor
  // auto_book_mail só enfeita o rótulo («veio do AUTO-BOOK»): sem a migration do robô, segue sem ele. Qualquer outro erro sobe.
  const optional = (p: Promise<any[]>, table: string) => p.catch((e: any) => { const m = String(e?.message || e); if (m.startsWith(table + ':') && /does not exist|schema cache|PGRST205|42P01/.test(m)) return []; throw e })
  const [bank, invoices, rides, invoiceExpenses, inputs, goods, inventory, fixed, expenses, suppliers, mailBooked] = await Promise.all([
    fetchAll(db, 'bank_transactions', 'id, date, amount, name, merchant, pending, match_status, match_engine, matched_table, matched_id, reviewed_at, authorized_date:raw->>authorized_date'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote, origin'),
    fetchAll(db, 'rides', 'id, project_name'),
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, purchase_group, order_number, paid_from, paid_to, cancel_status'),
    fetchAll(db, 'inputs', 'id, description, supplier, category, unit_price, quantity, purchase_date, payment_date, purchase_group, order_number, paid_from, paid_to, cancel_status'),
    fetchAll(db, 'goods', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, purchase_group, order_number, paid_from, paid_to, cancel_status'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, purchase_date, payment_date, purchase_group, order_number, paid_from, paid_to, cancel_status'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date, expense_date, bank_transaction_id', (q: any) => q.not('bank_transaction_id', 'is', null)),
    fetchAll(db, 'expenses', 'id, description, amount, payment_date, expense_date, payment_reference', (q: any) => q.like('payment_reference', 'bank:%')),
    fetchAll(db, 'suppliers', 'id, name, aliases, is_dealership'),
    optional(fetchAll(db, 'auto_book_mail', 'id, booked_table, booked_id', (q: any) => q.not('booked_id', 'is', null)), 'auto_book_mail'),
  ])
  return computeBucketOrders({ bank, invoices, rides, invoiceExpenses, inputs, goods, inventory, fixed, expenses, suppliers, mailBooked })
}
