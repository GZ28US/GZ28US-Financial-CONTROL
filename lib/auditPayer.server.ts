// SERVER-ONLY — QUEM PAGOU DE VERDADE? (auditoria da conta corrente GZ28BR, João, 10/set/2026)
//
// A conta corrente com a GZ28BR (lib/financials.ts brAccount) lê QUEM PAGOU cada linha (whoPaid), e o DRE soma cada
// custo uma vez por linha. Três defeitos distorcem os dois em silêncio — nenhum motor os vê:
//   · PAGO_REGIONS — a linha diz que a GZ28BR (ou um sócio) pagou, mas a Regions tem a saída AO CENTAVO a ≤3 dias
//     (data postada OU autorização do cartão). O Bank Link tira do pool toda linha paga por fora (brPaid em
//     lib/bankReconcile.server.ts), a linha do banco fica NEW pra sempre, e a conta corrente lança «a BR pagou conta
//     nossa» — o contrário do que houve. Caso real: 006.25 · Cesar Tellez $1,440.90 × Regions «Cesar t 4829 Visa
//     Direct…», autorizada 2026-07-24, postada 2026-07-27, paid_from GZ28BR.
//   · COBRADO_DUAS_VEZES — a mesma compra em DUAS invoices do cliente intercompany (US.006, GZ28 V8 SpeedShop BR Ltda):
//     mesmo PayPal ou mesmo texto, a ≤3 dias. Caso real: 006.25 × 006.34, espelho do BR.180.1 inflado pela convenção
//     antiga «+10% + FL Tax» (lib/brPaidMirror.ts): custo $1,534.55 × $1,440.90, cobrança $1,688.01 × $1,584.99.
//   · FORNECEDOR_GZ28 — linha US cujo fornecedor é a própria GZ28US: fornecedor circular esconde o vendedor real
//     (006.12: 18 linhas criadas em 2026-08-18; US.030.1: compra da Highline).
// SÓ LEITURA. Mostra a prova e pergunta a gente; nunca escreve. Quem lança é o AUTO-BOOK do Márcio; o AUTO-LINK só casa.
//
// RÉGUA DO PAGO_REGIONS — medida em 10/set/2026 na produção. Grupo de controle: os 1.311 registros com casamento vivo
// (para eles, qualquer OUTRA saída do mesmo valor a ≤3 dias é coincidência por construção):
//   valor ao centavo + ≤3 dias ....................................................... 161 coincidências (12,3%)
//   + linha do banco AINDA SEM DONO (NEW / QUEUED) ...................................... 10 (0,76%)
//   + nome bate (nameHit) OU valor distinto (≥ $100, não múltiplo de $50, única saída desse valor em ±45 dias) ... 1 (0,08%)
// Linha já CASADA com outro registro é quase sempre compra gêmea (Walmart 2× $141.73, Montway 2× $229, United 2× $288):
// 14 coincidências mesmo com nome + valor distinto. Por isso ela só vira item quando (a) a linha está casada com ESTE
// registro — o banco e o pagador se contradizem na mesma linha — ou (b) o dono foi CRIADO pelo motor do banco
// (RULE/LEARN/FEE/BUCKET: ninguém afirmou uma compra separada) E o nome bate E o valor é distinto (a unicidade conta a
// própria linha casada — gêmea não passa). Pendente não entra: a data só vale depois de postar.
// Nos 219 registros com pagador GZ28BR de 10/set a régua devolve 1 item: o Cesar Tellez. A 4 dias entraria a Copa
// ($379.75, linha já casada com o balde) — fora da janela pedida, fica de fora.
//
// RÉGUA DO COBRADO_DUAS_VEZES — pedido sozinho NÃO prova: pedido de N itens se reparte entre carros (T1 #122017: injetores
// diferentes pra 006.10/006.11). Medido: dos 5 pares com mesmo PayPal, pedido ou texto, 3 eram pedido de 2 unidades
// provado pelo banco (eBay $122.58, HHP $5,298.75, BSS $1,848.15 = a soma do pedido numa cobrança só). Então: mesmo texto
// OU mesmo PayPal; datas a ≤3 dias; nenhum identificador contradizendo; custos iguais OU a maior = a menor × 1,065 /
// 1,10 / 1,1715 (a convenção antiga); e, com custos iguais, nenhuma saída da Regions somando o par ou o pedido. Resultado: 1 par.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchAll, num, nameHit, expensesRows } from './bankReconcile.server'
import { normSup } from './supplierMatch'

export type AuditRef = { table: string; id: string; label: string; href?: string | null }
export type AuditItem = { key: string; kind: string; title: string; amount: number; date: string | null; refs: AuditRef[]; evidence: string }
export type PayerAudit = { items: AuditItem[]; summary: Record<string, number | string> }
export type PayerAuditData = {
  invoiceExpenses: any[]; fixedExpenses: any[]; fixedSuppliers: any[]; expenses: any[]; goods: any[]; goodExpenses: any[]
  inputs: any[]; inventory: any[]; invoices: any[]; invoiceParts: any[]; rides: any[]; clients: any[]; bank: any[]
}

export const PAYER_WINDOW_DAYS = 3        // registro × linha do banco (postada ou autorizada)
export const UNIQUE_WINDOW_DAYS = 45      // «valor distinto»: única saída desse valor nesta janela
export const SPLIT_WINDOW_DAYS = 5        // pedido de N unidades: a cobrança somada a ±5 dias
const OTHER_PAYERS = new Set(['GZ28BR'])   // só a BR paga conta nossa por fora desde 11/set: sócio saiu do vocabulário
const CREATOR_ENGINES = new Set(['RULE', 'LEARN', 'FEE', 'BUCKET'])   // a mesma lista do enginesAudit (MAIL_ENGINES): o motor que CRIA registro
const UNDECIDED = new Set(['NEW', 'QUEUED', ''])
const INTERCOMPANY_CLIENT_NUMBER = 6      // US.006 — lib/brPaidMirror.ts: «client US.006 — GZ28 V8 SpeedShop BR Ltda»
const RATIOS: { k: number; text: string }[] = [
  { k: 1, text: 'mesmo valor' },
  { k: 1.065, text: 'a maior é a menor + 6,5% — o FL tax da convenção antiga «+10% + FL Tax»' },
  { k: 1.1, text: 'a maior é a menor + 10% — a margem da revenda' },
  { k: 1.1715, text: 'a maior é a menor + 10% + 6,5% — a convenção antiga inteira' },
]

// QUEM PAGOU — cópia FIEL de whoPaid (lib/financials.ts). Não se importa de lá: financials.ts é 'use client' (L1)
// e importa o cliente do browser; numa rota do App Router (camada RSC) o import vira referência de cliente e a chamada
// explode («Attempted to call whoPaid() from the server»). O teste compara as duas, linha a linha, nas 7 tabelas.
// São dois pagadores desde 11/set (CLIENT, RAFA, BETO e HERALDO saíram do app US; nenhuma linha os usava).
const PAYERS = ['GZ28US', 'GZ28BR']
export function whoPaidOf(r: { paid_from?: string | null; source?: string | null }): string | null {
  const norm = (v: unknown) => { const s = String(v || '').trim().toUpperCase(); if (!s) return null; if (s === 'REGIONS') return 'GZ28US'; return PAYERS.includes(s) ? s : null }
  return norm(r.paid_from) || norm(r.source)
}

const day = (s: unknown) => { const v = String(s || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '' }
const dd = (a: string, b: string) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 864e5))
const cents = (n: number) => Math.round(n * 100)
const r2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cut = (s: unknown, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many)

// Fornecedor = a própria GZ28US ('GZ28US', 'GZ28 V8 SPEEDSHOP USA LLC', 'GZ28 V8 SpeedShop USA LLC'…). A BR não é a
// própria empresa: fornecedor GZ28BR numa linha US é intercompany, não circular.
export const isSelfSupplier = (s: unknown) => { const n = normSup(String(s || '')); return n.startsWith('gz28') && !/^gz28(v8)?(speed(shop)?)?br/.test(n) }
// Cliente intercompany: US.006 não-orçamento, ou o nome «GZ28 … BR». clients.client_number NÃO é único (há um #6 orçamento).
export const isIntercompanyClient = (c: any) => !c?.is_quote && (/^gz28(v8)?(speed(shop)?)?br/.test(normSup(String(c?.name || ''))) || (Number(c?.client_number) === INTERCOMPANY_CLIENT_NUMBER && /^BRA[SZ]IL$/i.test(String(c?.country || ''))))

// Transação PayPal: 17 caracteres [0-9A-Z] com letra e dígito (37Y4419829942071E). VIN tem o mesmo formato — o dígito
// verificador separa (medido: os 3 VINs escritos em linhas do app passam no dígito, os 7 ids PayPal não).
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
const VIN_V: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 }
export const isVin = (s: string) => {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (/\d/.test(s[i]) ? Number(s[i]) : VIN_V[s[i]]) * VIN_W[i]
  const r = sum % 11
  return (r === 10 ? 'X' : String(r)) === s[8]
}
export const paypalIds = (...texts: unknown[]) => {
  const out = new Set<string>()
  for (const t of texts) for (const m of String(t || '').match(/\b[0-9A-Z]{17}\b/g) || []) if (/\d/.test(m) && /[A-Z]/.test(m) && !isVin(m)) out.add(m)
  return [...out]
}
// Pedido: pra LIGAR duas linhas (e somar o pedido) exige 4+ caracteres; pra SEPARAR duas compras qualquer pedido diferente basta.
const orderRaw = (s: unknown) => { const v = String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^#/, '').replace(/^ORDER#?/, ''); return v.startsWith('BANK:') ? '' : v }
const orderKey = (s: unknown) => { const v = orderRaw(s); return v.length >= 4 ? v : '' }
// O espelho da BR acrescenta « — via GZ28US (+10% + FL Tax)» ao item; o resto do texto é o da compra.
const MIRROR_TAIL = /\s*[—–-]\s*via\s+gz28\s*us\b.*$/i
// Acento sai pela decomposição (NFD) + corte de tudo que não é ASCII visível; depois só letras e dígitos contam.
const textKey = (s: unknown) => { const v = String(s || '').replace(MIRROR_TAIL, '').normalize('NFD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return v.length >= 8 ? v : '' }

type AppRow = { table: string; r: any; amount: number; date: string; label: string; matchLabel: string; vendor: string; href: string; inv: any | null }

export function computePayerAudit(d: PayerAuditData): PayerAudit {
  const items: AuditItem[] = []
  const summary: Record<string, number | string> = {}
  const invById = new Map<string, any>(d.invoices.map((i: any) => [String(i.id), i]))
  const rideById = new Map<string, any>(d.rides.map((r: any) => [String(r.id), r]))
  const supById = new Map<string, any>(d.fixedSuppliers.map((s: any) => [String(s.id), s]))
  // Link da invoice: balde e ride como o candidatePool (bankReconcile.server.ts invHref); invoice SEM ride (a 006.N) abre
  // pelo cliente, como o invoiceMeta do lib/financials.ts — o candidatePool mandaria pra /adm/reports.
  const invHref = (inv: any) => !inv ? '/invoices' : inv.origin === 'BUCKET' ? '/adm/bank#a-atribuir' : inv.ride_id ? `/rides/${inv.ride_id}/invoices/${inv.id}` : inv.client_id ? `/clients/${inv.client_id}/invoices/${inv.id}` : '/adm/reports'
  const invLabel = (inv: any) => inv ? [inv.invoice_code || '—', rideById.get(String(inv.ride_id))?.project_name || ''].filter(Boolean).join(' ') : '—'
  const expLine = (r: any) => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra)   // lib/financials.ts expLine
  const qtyLine = (r: any) => num(r.unit_price) * (num(r.quantity) || 1)                          // lib/financials.ts qtyLine

  // ── as linhas do app, com o MESMO rótulo que o candidatePool dá ao nameHit ──
  const rows: AppRow[] = []
  for (const r of d.invoiceExpenses) {
    const inv = invById.get(String(r.invoice_id))
    if (!inv || inv.is_quote) continue   // filha de orçamento fica fora de TUDO (lib/financials.ts loadFinancials)
    rows.push({ table: 'invoice_expenses', r, amount: expLine(r), date: day(r.payment_date) || day(r.expense_date), label: [inv.invoice_code, r.item, r.supplier].filter(Boolean).join(' · '), matchLabel: `EXPENSE · ${invLabel(inv)} · ${r.item || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: invHref(inv), inv })
  }
  for (const r of d.fixedExpenses) {
    const s = supById.get(String(r.supplier_id)); const company = String(s?.company || s?.description || '')
    rows.push({ table: 'fixed_cost_expenses', r, amount: num(r.amount), date: day(r.payment_date) || day(r.expense_date), label: ['FIXO', company, r.description].filter(Boolean).join(' · '), matchLabel: `FIXO · ${company} · ${r.description || ''}`, vendor: String(s?.company || ''), href: r.supplier_id ? '/costs/fixed/' + r.supplier_id : '/costs/fixed', inv: null })
  }
  for (const r of d.expenses) {
    const tag = r.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'
    rows.push({ table: 'expenses', r, amount: num(r.amount), date: day(r.payment_date) || day(r.expense_date), label: [tag, r.description || r.type, r.supplier].filter(Boolean).join(' · '), matchLabel: `${tag} · ${r.description || r.type || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: '/staff', inv: null })
  }
  for (const r of d.goods) rows.push({ table: 'goods', r, amount: qtyLine(r), date: day(r.payment_date) || day(r.purchase_date), label: ['GOODS', r.description, r.supplier].filter(Boolean).join(' · '), matchLabel: `GOODS · ${r.description || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: '/goods', inv: null })
  for (const r of d.goodExpenses) rows.push({ table: 'good_expenses', r, amount: num(r.amount), date: day(r.payment_date) || day(r.expense_date), label: ['GOODS', r.description, r.supplier].filter(Boolean).join(' · '), matchLabel: `GOODS · ${r.description || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: '/goods', inv: null })
  for (const r of d.inputs) rows.push({ table: 'inputs', r, amount: qtyLine(r), date: day(r.payment_date) || day(r.purchase_date), label: ['SUPPLY', r.description, r.supplier].filter(Boolean).join(' · '), matchLabel: `SUPPLY · ${r.description || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: '/supplies', inv: null })
  for (const r of d.inventory) rows.push({ table: 'inventory', r, amount: qtyLine(r), date: day(r.payment_date) || day(r.purchase_date), label: ['STOCK', r.description, r.supplier].filter(Boolean).join(' · '), matchLabel: `STOCK · ${r.description || ''}${r.supplier ? ' · ' + r.supplier : ''}`, vendor: String(r.supplier || ''), href: '/inventory', inv: null })
  const rowByKey = new Map<string, AppRow>(rows.map(x => [x.table + ':' + x.r.id, x]))

  // ── o banco: saídas POSTADAS (Plaid: amount > 0 = saiu), por centavo ──
  const bank = d.bank.filter((b: any) => String(b.match_status || '') !== 'REMOVED')
  const posted = bank.filter((b: any) => num(b.amount) > 0 && !b.pending)
  const byCents = new Map<number, any[]>()
  for (const b of posted) { const k = cents(num(b.amount)); if (!byCents.has(k)) byCents.set(k, []); byCents.get(k)!.push(b) }
  const near = (amount: number) => [-1, 0, 1].flatMap(o => byCents.get(cents(amount) + o) || [])
  const lineDay = (b: any) => day(b.authorized_date) || day(b.date)
  const gap = (date: string, b: any) => Math.min(dd(date, day(b.date)), day(b.authorized_date) ? dd(date, day(b.authorized_date)) : 99)
  const feedUntil = posted.map((b: any) => day(b.date)).filter(Boolean).sort().reverse()[0] || ''
  const suffixCount = new Map<string, number>()
  const suffixOf = (b: any) => { const m = String(b.name || '').match(/\b(\d{4})\s*$/); return m ? m[1] : '' }
  for (const b of bank) { const s = suffixOf(b); if (s) suffixCount.set(s, (suffixCount.get(s) || 0) + 1) }
  const pointed = new Map<string, any>()
  for (const b of bank) if (b.match_status === 'MATCHED' && b.matched_table && b.matched_id) pointed.set(b.matched_table + ':' + b.matched_id, b)
  const byLineId = new Map<string, any>(bank.map((b: any) => [String(b.id), b]))
  // A linha do banco que JÁ aponta pra este registro (a mesma régua do enginesAudit lineOf).
  const ownLine = (x: AppRow): any => pointed.get(x.table + ':' + x.r.id) || (x.r.purchase_group ? pointed.get('purchase_group:' + x.r.purchase_group) : null)
    || ((x.table === 'fixed_cost_expenses' || x.table === 'expenses') && x.r.bank_transaction_id ? byLineId.get(String(x.r.bank_transaction_id)) : null)
    || (x.table === 'expenses' && String(x.r.payment_reference || '').startsWith('bank:') ? byLineId.get(String(x.r.payment_reference).slice(5)) : null)
    || (x.table === 'inputs' && String(x.r.order_number || '').startsWith('bank:') ? byLineId.get(String(x.r.order_number).slice(5)) : null) || null

  // ═══ 1 · PAGO_REGIONS ═══
  const payerName: Record<string, string> = { GZ28BR: 'a GZ28BR' }   // o único pagador de fora desde 11/set
  const other = rows.filter(x => OTHER_PAYERS.has(String(whoPaidOf(x.r))))
  const drop = { casada_com_outro: 0, fraca: 0, decidida: 0, pendente: 0 }
  let pagoN = 0, pagoV = 0
  for (const x of other) {
    if (!(x.amount > 0.005) || !x.date) continue
    const mine = ownLine(x)
    const pend = bank.filter((b: any) => b.pending && num(b.amount) > 0 && Math.abs(num(b.amount) - x.amount) < 0.0101 && gap(x.date, b) <= PAYER_WINDOW_DAYS)
    const cands = near(x.amount).filter((b: any) => Math.abs(num(b.amount) - x.amount) < 0.0101 && gap(x.date, b) <= PAYER_WINDOW_DAYS)
    if (!cands.length) { if (pend.length) drop.pendente++; continue }
    const uniq = near(x.amount).filter((b: any) => Math.abs(num(b.amount) - x.amount) < 0.0101 && dd(x.date, lineDay(b)) <= UNIQUE_WINDOW_DAYS).length
    const round = Math.abs(x.amount % 50) < 0.005 || 50 - (x.amount % 50) < 0.005
    const distinct = x.amount >= 100 && !round && uniq === 1
    const scored = cands.map((b: any) => {
      const status = String(b.match_status || '')
      const self = !!mine && String(mine.id) === String(b.id)
      const hit = nameHit(b, { table: x.table, id: String(x.r.id), label: x.matchLabel, date: x.date, amount: x.amount, undated: false } as any)
      const owner = !self && status === 'MATCHED' ? rowByKey.get(b.matched_table + ':' + b.matched_id) || null : null
      const creator = CREATOR_ENGINES.has(String(b.match_engine || ''))
      const ok = self || (UNDECIDED.has(status) && (hit || distinct)) || (status === 'MATCHED' && creator && hit && distinct)
      const why = self ? 'self' : UNDECIDED.has(status) ? (hit || distinct ? 'ok' : 'fraca') : status === 'MATCHED' ? (ok ? 'ok' : 'casada_com_outro') : 'decidida'
      const rank = self ? 0 : UNDECIDED.has(status) ? (hit ? 1 : 2) : 3
      return { b, status, self, hit, owner, creator, ok, why, rank, gap: gap(x.date, b) }
    }).sort((a: any, c: any) => a.rank - c.rank || a.gap - c.gap)
    const best = scored.find((s: any) => s.ok)
    if (!best) { const w = scored[0].why as keyof typeof drop; if (w in drop) drop[w]++; continue }
    const b = best.b
    const who = String(whoPaidOf(x.r))
    const posted0 = day(b.date), auth = day(b.authorized_date)
    const suf = suffixOf(b), sufN = suf ? suffixCount.get(suf) || 0 : 0
    const byAuth = !!auth && dd(x.date, auth) <= dd(x.date, posted0)
    const lag = dd(x.date, byAuth ? auth : posted0)
    const when = lag === 0 ? `no mesmo dia ${byAuth ? 'da autorização' : 'da data postada'}` : `a ${plural(lag, 'dia', 'dias')} ${byAuth ? 'da autorização' : 'da data postada'}`
    const statusText = best.self ? 'já casada com ESTE registro — o banco e o pagador se contradizem'
      : best.status === 'MATCHED' ? `já casada com «${cut(best.owner ? best.owner.label : b.matched_table + ':' + b.matched_id, 60)}», que o motor do banco CRIOU (${b.match_engine}) — a mesma compra lançada duas vezes, ou coincidência`
      : best.status === 'QUEUED' ? 'na fila do Bank Link (QUEUED), sem dono' : 'sem dono no Bank Link (NEW)'
    const proof = [best.hit ? 'o nome bate' : `o nome não bate, mas o valor é único (nenhuma outra saída de ${usd(x.amount)} em ±${UNIQUE_WINDOW_DAYS} dias)`,
      sufN >= 10 ? `cartão final ${suf} (${sufN} linhas da Regions com o mesmo final)` : '', b.processor ? `processador ${b.processor}` : '',
      cands.length > 1 ? plural(cands.length, 'linha', 'linhas') + ' do mesmo valor na janela' : '', !day(x.r.payment_date) ? 'a linha do app não tem data de pagamento (usei a de lançamento)' : ''].filter(Boolean).join('; ')
    const refs: AuditRef[] = [{ table: x.table, id: String(x.r.id), label: cut(x.label, 90), href: x.href },
      { table: 'bank_transactions', id: String(b.id), label: `Regions ${posted0} ${usd(num(b.amount))} ${cut(b.name, 40)}`, href: '/adm/bank' }]
    if (best.owner) refs.push({ table: best.owner.table, id: String(best.owner.r.id), label: cut(best.owner.label, 90), href: best.owner.href })
    items.push({
      key: `PAGO_REGIONS|${x.table}:${x.r.id}|${b.id}`, kind: 'PAGO_REGIONS',
      title: `«${cut(x.label, 70)}» diz que ${payerName[who] || who} pagou ${usd(x.amount)}, mas a Regions tem essa saída ao centavo em ${auth || posted0}.`,
      amount: r2(x.amount), date: auth || posted0 || null, refs,
      evidence: `Regions postada ${posted0}${auth ? ', autorizada ' + auth : ''}, «${cut(b.name, 60)}» ${usd(num(b.amount))}, ${statusText}; o app diz pago em ${x.date}, ${when}. Prova: ${proof}.`,
    })
    pagoN++; pagoV += x.amount
  }
  const payerCount: Record<string, number> = {}
  for (const x of other) { const w = String(whoPaidOf(x.r)); payerCount[w] = (payerCount[w] || 0) + 1 }
  summary.pagador_outro_registros = other.length
  summary.pagador_outro_por_pagador = Object.entries(payerCount).map(([k, v]) => k + ' ' + v).join(' · ') || '—'
  summary.pago_regions_itens = pagoN
  summary.pago_regions_valor = r2(pagoV)
  summary.pago_regions_descartadas_casada_com_outro = drop.casada_com_outro
  summary.pago_regions_descartadas_fracas = drop.fraca
  summary.pago_regions_descartadas_decididas = drop.decidida
  summary.pago_regions_so_pendente = drop.pendente

  // ═══ 2 · COBRADO_DUAS_VEZES ═══
  const icClients = d.clients.filter(isIntercompanyClient)
  const icIds = new Set(icClients.map((c: any) => String(c.id)))
  // O carimbo da invoice manda; o dono do ride é só o reserva (app/rides/[id]/invoices/[invoiceId]/page.tsx: ownerClientId).
  const ownerOf = (inv: any) => String(inv?.client_id || rideById.get(String(inv?.ride_id))?.client_id || '')
  const icRows = rows.filter(x => x.table === 'invoice_expenses' && x.inv && icIds.has(ownerOf(x.inv)))
  type IcRow = AppRow & { ids: string[]; order: string; text: string }
  const ic: IcRow[] = icRows.map(x => ({ ...x, ids: paypalIds(x.r.item, x.r.order_number, x.r.source), order: orderKey(x.r.order_number), text: textKey(x.r.item) }))
  const orderSum = new Map<string, number>(), idSum = new Map<string, number>()
  for (const x of rows) {
    if (x.table !== 'invoice_expenses') continue
    const o = orderKey(x.r.order_number); if (o) orderSum.set(o, (orderSum.get(o) || 0) + x.amount)
    for (const id of paypalIds(x.r.item, x.r.order_number, x.r.source)) idSum.set(id, (idSum.get(id) || 0) + x.amount)
  }
  const billOf = (x: AppRow): number | null => {
    const parts = d.invoiceParts.filter((p: any) => String(p.invoice_id) === String(x.r.invoice_id))
    const hit = parts.find((p: any) => Math.abs(num(p.base_cost) - x.amount) < 0.021) || (parts.length === 1 ? parts[0] : null)
    return hit ? r2(num(hit.unit_price) * (num(hit.quantity) || 1)) : null
  }
  const seen = new Set<string>()
  let dupN = 0, dupV = 0, splitDrop = 0
  const buckets = new Map<string, IcRow[]>()
  const put = (k: string, x: IcRow) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k)!.push(x) }
  for (const x of ic) { if (x.text) put('t:' + x.text, x); for (const id of x.ids) put('p:' + id, x) }
  for (const group of buckets.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j]
    if (String(a.r.invoice_id) === String(b.r.invoice_id) || String(a.r.id) === String(b.r.id)) continue
    const pairKey = [String(a.r.id), String(b.r.id)].sort().join('|')
    if (seen.has(pairKey)) continue
    const sharedIds = a.ids.filter(id => b.ids.includes(id))
    const sameText = !!a.text && a.text === b.text
    if (!sameText && !sharedIds.length) continue
    if (!a.date || !b.date || dd(a.date, b.date) > PAYER_WINDOW_DAYS) continue
    const oa = orderRaw(a.r.order_number), ob = orderRaw(b.r.order_number)
    if ((a.ids.length && b.ids.length && !sharedIds.length) || (oa && ob && oa !== ob)) continue   // identificadores diferentes = duas compras
    const lo = a.amount <= b.amount ? a : b, hi = lo === a ? b : a
    if (!(lo.amount > 0.005)) continue
    const rel = RATIOS.find(q => Math.abs(hi.amount - lo.amount * q.k) <= 0.02 + lo.amount * 0.00001)
    if (!rel) continue
    seen.add(pairKey)
    const first = a.date <= b.date ? a.date : b.date
    if (rel.k === 1) {
      // Custos iguais: pode ser pedido de 2 unidades repartido entre carros. A Regions cobrando a SOMA prova isso.
      const sums = [a.amount + b.amount, a.order ? orderSum.get(a.order) || 0 : 0, ...sharedIds.map(id => idSum.get(id) || 0)].filter(s => s > lo.amount + 0.02)
      const split = posted.find((l: any) => sums.some(s => Math.abs(num(l.amount) - s) < 0.021) && gap(first, l) <= SPLIT_WINDOW_DAYS)
      if (split) { splitDrop++; continue }
    }
    const la = lo.inv?.invoice_code || '?', lb = hi.inv?.invoice_code || '?'
    const billLo = billOf(lo), billHi = billOf(hi)
    const links = [sharedIds.length ? 'mesmo PayPal ' + sharedIds.join(', ') : '', sameText ? 'mesmo texto' : '', a.order && a.order === b.order ? 'mesmo pedido ' + a.r.order_number : ''].filter(Boolean).join(' + ')
    items.push({
      key: `COBRADO_DUAS_VEZES|${pairKey}`, kind: 'COBRADO_DUAS_VEZES',
      title: `A mesma compra «${cut(String(lo.r.item || '').replace(MIRROR_TAIL, ''), 60)}» está cobrada da GZ28BR em duas invoices (${la} e ${lb}): custo duplicado de ${usd(lo.amount)}.`,
      amount: r2(lo.amount), date: first,
      refs: [{ table: 'invoice_expenses', id: String(lo.r.id), label: cut(lo.label, 90), href: lo.href }, { table: 'invoice_expenses', id: String(hi.r.id), label: cut(hi.label, 90), href: hi.href }],
      evidence: `${links.charAt(0).toUpperCase() + links.slice(1)}, pagas em ${lo.date} e ${hi.date}: custo ${usd(lo.amount)} na ${la} × ${usd(hi.amount)} na ${lb} (${rel.text})${billLo != null && billHi != null ? `; cobrança à GZ28BR ${usd(billLo)} × ${usd(billHi)}` : ''}.${rel.k === 1 ? ' Nenhuma saída da Regions soma o par ou o pedido — não é pedido de 2 unidades provado pelo banco.' : ''} O valor do item é o custo da compra (o menor): apagar a ${lb} tira ${usd(hi.amount)} de custo, apagar a ${la} tira ${usd(lo.amount)}.`,
    })
    dupN++; dupV += lo.amount
  }
  summary.intercompany_clientes = icClients.map((c: any) => (c.client_number != null ? String(c.client_number).padStart(3, '0') : '?') + ' ' + c.name).join(' · ') || '—'
  summary.intercompany_invoices_com_linhas = new Set(icRows.map(x => String(x.r.invoice_id))).size
  summary.intercompany_linhas = icRows.length
  summary.cobrado_duas_vezes_itens = dupN
  summary.cobrado_duas_vezes_custo = r2(dupV)
  summary.cobrado_descartados_pedido_somado = splitDrop

  // ═══ 3 · FORNECEDOR_GZ28 ═══
  const selfRows = rows.filter(x => isSelfSupplier(x.table === 'fixed_cost_expenses' ? x.vendor : x.r.supplier))
  const perGroup = new Map<string, { n: number; v: number; created: Set<string> }>()
  const groupOf = (x: AppRow) => x.table === 'invoice_expenses' ? String(x.inv?.invoice_code || '?') : x.table === 'fixed_cost_expenses' ? 'FIXO ' + cut(supById.get(String(x.r.supplier_id))?.description || x.vendor, 30) : x.table.toUpperCase()
  for (const x of selfRows) { const g = groupOf(x); const e = perGroup.get(g) || { n: 0, v: 0, created: new Set<string>() }; e.n++; e.v += x.amount; if (day(x.r.created_at)) e.created.add(day(x.r.created_at)); perGroup.set(g, e) }
  let selfN = 0, selfV = 0, selfZero = 0
  for (const x of selfRows) {
    if (!(x.amount > 0.005)) { selfZero++; continue }
    const sup = x.table === 'fixed_cost_expenses' ? x.vendor : String(x.r.supplier || '')
    const g = groupOf(x), e = perGroup.get(g)!
    const where = x.table === 'invoice_expenses'
      ? `${e.n > 1 ? `é 1 de ${e.n} linhas assim na ${g} (${usd(e.v)}, criadas em ${[...e.created].sort().join(', ')})` : `única linha assim na ${g}`}${/^GZ28BR Invoice/i.test(String(x.inv?.service || '')) ? `; a ${g} espelha «${cut(x.inv.service, 50)}»` : ''}`
      : x.table === 'fixed_cost_expenses' ? `o cadastro do custo fixo «${cut(supById.get(String(x.r.supplier_id))?.description, 60)}» tem company «${sup}»` : `linha de ${x.table}`
    // Defeito de CADASTRO (revisão de 10/set): fornecedor errado não muda o dinheiro do DRE, do DFC nem da conta corrente — o item vale
    // $0 (impacto do card e placar) e o valor da linha fica no título. A linha do banco casada, quando existe, diz quem vendeu.
    const mine = ownLine(x)
    items.push({
      key: `FORNECEDOR_GZ28|${x.table}:${x.r.id}`, kind: 'FORNECEDOR_GZ28',
      title: `«${cut(x.label, 70)}» tem como fornecedor a própria GZ28US: o vendedor real dos ${usd(x.amount)} some do cadastro.`,
      amount: 0, date: x.date || null,
      refs: [{ table: x.table, id: String(x.r.id), label: cut(x.label, 90), href: x.href }, ...(mine ? [{ table: 'bank_transactions', id: String(mine.id), label: `${day(mine.date)} · ${usd(Math.abs(Number(mine.amount) || 0))} · ${cut(mine.merchant || mine.name, 40)}`, href: '/adm/bank' }] : [])],
      evidence: `Fornecedor «${sup}» é a própria empresa; ${where}. O campo fornecedor não diz quem vendeu${mine ? `; a linha do banco casada com este registro diz «${cut(mine.merchant || mine.name, 40)}» (${day(mine.date)}) — ponha esse vendedor no fornecedor` : '; se o item ou a descrição citam a loja, é ela (e «GZ28» é palavra ignorada no casamento por nome do Bank Link)'}. Defeito de cadastro: não muda o dinheiro do DRE nem do DFC, por isso vale $0 no impacto e no placar.`,
    })
    selfN++; selfV += x.amount
  }
  summary.fornecedor_gz28_itens = selfN
  summary.fornecedor_gz28_valor = r2(selfV)
  summary.fornecedor_gz28_sem_valor = selfZero
  summary.fornecedor_gz28_por_grupo = [...perGroup.entries()].sort((a, b) => b[1].v - a[1].v).map(([g, e]) => `${g}: ${e.n} · ${usd(e.v)}`).join(' | ') || '—'

  summary.feed_ate = feedUntil || '—'
  summary.janela_dias = PAYER_WINDOW_DAYS
  summary.registros_lidos = rows.length
  summary.saidas_regions_postadas = posted.length
  const order: Record<string, number> = { PAGO_REGIONS: 0, COBRADO_DUAS_VEZES: 1, FORNECEDOR_GZ28: 2 }
  items.sort((a, b) => order[a.kind] - order[b.kind] || b.amount - a.amount || a.key.localeCompare(b.key))
  return { items, summary }
}

export async function auditPayer(db: any): Promise<PayerAudit> {
  const [invoiceExpenses, fixedExpenses, fixedSuppliers, expenses, goods, goodExpenses, inputs, inventory, invoices, invoiceParts, rides, clients, bank] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, source, order_number, purchase_group, created_at'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, expense_date, payment_date, paid_from, paid_to, source, bank_transaction_id, created_at'),
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, description'),
    // expenses.bank_transaction_id vem da MIGRATION_expenses_bank_link — expensesRows lê sem a coluna se ela faltar.
    expensesRows(db, 'id, description, type, supplier, amount, expense_date, payment_date, origin, paid_from, paid_to, source, payment_reference, created_at'),
    fetchAll(db, 'goods', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, purchase_group, created_at'),
    fetchAll(db, 'good_expenses', 'id, description, supplier, amount, expense_date, payment_date, paid_from, paid_to, source, created_at'),
    fetchAll(db, 'inputs', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, order_number, purchase_group, created_at'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, purchase_group, created_at'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, client_id, is_quote, origin, service'),
    fetchAll(db, 'invoice_parts', 'id, invoice_id, unit_price, quantity, base_cost'),
    fetchAll(db, 'rides', 'id, project_name, client_id'),
    fetchAll(db, 'clients', 'id, name, client_number, is_quote, country'),
    // authorized_date = data da autorização do cartão (raw do Plaid; nula nas linhas de extrato). date = data POSTADA.
    fetchAll(db, 'bank_transactions', 'id, date, amount, name, merchant, pending, match_status, matched_table, matched_id, match_engine, authorized_date:raw->>authorized_date, processor:raw->payment_meta->>payment_processor', (q: any) => q.or('match_status.is.null,match_status.neq.REMOVED')),
  ])
  return computePayerAudit({ invoiceExpenses, fixedExpenses, fixedSuppliers, expenses, goods, goodExpenses, inputs, inventory, invoices, invoiceParts, rides, clients, bank })
}
