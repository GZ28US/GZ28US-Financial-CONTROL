// ════════════════════════════════════════════════════════════════════════════
// lib/intercompanyLedger.server.ts · 23/out/2026 — A CONTA CORRENTE BR↔US, CALCULADA (SÓ SERVIDOR, SÓ LEITURA)
//
// Márcio, 23/10/2026: «there is no PAID TO feature anymore, if it's a BR expense, it should be in BR app, if it's an US expense,
// it should be in the US app. the only difference will be the paid from thing» · «to incomes the PAID TO exists, and it's right,
// it's the opposite of the paid from in expenses» · «let's make this BR vs US flow PERFECT».
//
// O MODELO: cada fato mora UMA vez, no app dele, com a prova dele. O saldo é uma CONTA sobre esses fatos — nunca uma cópia:
//   1. despesa no app US  PAID BY GZ28BR        → o BR pagou conta do US  → crédito do BR   (US_OWES)
//   2. renda   no app US  RECEIVED BY GZ28BR    → dinheiro do US caiu no BR → débito do BR  (BR_OWES)
//   3. despesa no app BR  PAID BY GZ28US        → o US pagou conta do BR  → débito do BR   (BR_OWES)
//   4. renda   no app BR  RECEIVED BY GZ28US    → dinheiro do BR caiu no US → crédito do BR (US_OWES)
//   5. TRANSFERÊNCIA (intercompany_transfers)   → BR→US = crédito do BR; US→BR = débito do BR — SÓ quando CHEGA (SENT fica fora)
//   BR deve ao US = Σ BR_OWES − Σ US_OWES, em US$.
//
// MOEDA: cada lançamento carrega o valor na moeda nativa e o par na outra, com a FONTE do câmbio:
//   · app US: US$ é a verdade; R$ = amount_brl gravado, senão US$ × bid do dia (fx_usd_brl_daily, o bid real, sem spread/IOF).
//   · app BR: R$ é a verdade; US$ = amount_usd gravado (×qtd + tax/extra pelo fator da linha), senão R$ ÷ bid do dia.
//   · transferência: as duas pernas gravadas; o câmbio REAL é a razão entre elas.
//   Sem bid e sem valor gravado: a linha conta US$ 0 e vai para as PONTAS SOLTAS (nunca inventa número).
//
// O QUE NÃO ENTRA (e é dito): quotes; as shopping invoices 006.N/085.N (cliente GZ28BR no US, cliente GZ28US no BR — histórico
// do espelho); invoice BUCKET (A ATRIBUIR); linha estornada (lib/estorno.ts); despesa do US sem payment_date (o dinheiro do BR
// ainda não saiu); linha PAID BY GZ28BR com PAID TO GZ28BR dentro do app US (conta interna do BR, não cruza); as linhas
// «Crédito com GZ28US — FL tax» do BR (crédito a decidir, não despesa).
//
// FALHA FECHA: leitura que falha lança erro — nunca um saldo parcial.

import type { SupabaseClient } from '@supabase/supabase-js'
import { crossingDbs, CrossingReadError, type CrossingDbs } from '@/lib/crossingBalance.server'
import { carregarCotacoes, type Cotacoes } from '@/lib/crossing.server'
import { US_CLIENT_GZ28BR, BR_CLIENT_GZ28US, BR_APP_BASE } from '@/lib/crossingBalance'
import { foraDoDinheiro, valorDespesa, valorItem } from '@/lib/estorno'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>
export type Side = 'BR_OWES' | 'US_OWES'
export type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER'
export type RateSource = 'recorded' | 'fx_daily' | 'transfer' | 'none'
export type LedgerEntry = {
  key: string; app: 'US' | 'BR'; table: string; id: string
  kind: Kind; side: Side
  date: string | null; month: string | null
  usd: number; brl: number | null; rate: number | null; rateSource: RateSource
  code: string | null; label: string; href: string | null; external: boolean
  payer: string | null; receiver: string | null
  receipts: string[]
  flags: string[]
}
export type LeftOut = { key: string; app: 'US' | 'BR'; table: string; id: string; code: string | null; label: string; usd: number | null; brl: number | null; reason: string; href: string | null; external: boolean }
export type Transfer = {
  id: string; code: string; direction: 'BR_TO_US' | 'US_TO_BR'; via: string | null
  sent_on: string | null; sent_amount: number | null; sent_currency: 'BRL' | 'USD' | null; sent_receipts: string[]
  arrived_on: string | null; arrived_amount: number | null; arrived_currency: 'BRL' | 'USD' | null; arrived_receipts: string[]
  bank_transaction_id: string | null; covers: { app: string; table: string; id: string }[]; legacy: Row
  description: string | null; status: 'SENT' | 'ARRIVED' | 'RECONCILED'; fx_diff_usd: number; needs_review: boolean
  usd: number; brl: number | null; rate: number | null
}
export type MonthLine = { month: string; brOwes: number; usOwes: number; net: number; running: number; n: number }
export type Ledger = {
  generatedAt: string
  brOwesUs: number
  totals: { brOwes: number; usOwes: number; byKind: Record<string, { brOwes: number; usOwes: number; n: number }>; byApp: Record<string, { brOwes: number; usOwes: number; n: number }> }
  eras: { E1: { brOwes: number; usOwes: number; net: number; n: number }; E2: { brOwes: number; usOwes: number; net: number; n: number } }
  months: MonthLine[]
  entries: LedgerEntry[]
  transfers: Transfer[]
  leftOut: LeftOut[]
  looseEnds: { kind: string; key: string; label: string; usd: number | null; href: string | null; external: boolean }[]
  fx: { missingDays: string[]; failure: string | null }
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r4 = (v: number) => Math.round(v * 10000) / 10000
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0
const YMD = /^\d{4}-\d{2}-\d{2}/
const ymd = (v: unknown): string | null => { const s = String(v || ''); return YMD.test(s) ? s.slice(0, 10) : null }
// O DIA de um instante, no fuso do assunto. Meia-noite UTC exata é data de calendário gravada crua (régua de lib/paidNoBank.ts).
function dayIn(ts: unknown, timeZone: string): string | null {
  if (!ts) return null
  const d = new Date(String(ts)); if (isNaN(d.getTime())) return null
  const iso = d.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone })
}
function addDias(d: string, n: number): string { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
// Quem pagou: PAID BY (paid_from) primeiro, depois o SOURCE legado; REGIONS é GZ28US. Só os dois nomes contam.
const PAYERS = ['GZ28US', 'GZ28BR']
const norm = (v: unknown): string | null => { const s = String(v || '').trim().toUpperCase(); if (!s) return null; if (s === 'REGIONS') return 'GZ28US'; return PAYERS.includes(s) ? s : null }
const payerOf = (r: Row): string | null => norm(r.paid_from) || norm(r.source)
const receiverOf = (r: Row): string | null => norm(r.paid_to)
const receiptsOf = (v: unknown): string[] => {
  if (!v) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  const s = String(v).trim()
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String).filter(Boolean) : [] } catch { return [] } }
  return s ? [s] : []
}

// ── LEITURA (paginada; falha lança) ───────────────────────────────────────────
async function readAll(db: SupabaseClient, label: string, table: string, columns: string, filter: (q: any) => any = q => q): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order('id').range(from, from + 999)
    if (error) throw new CrossingReadError('db', `Falha ao ler ${label}.${table}: ${error.message}`)
    if (!Array.isArray(data)) throw new CrossingReadError('db', `A leitura de ${label}.${table} voltou sem lista.`)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}
async function readByIds(db: SupabaseClient, label: string, table: string, columns: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = []
  const uniq = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < uniq.length; i += 100) out.push(...await readAll(db, label, table, columns, q => q.in('id', uniq.slice(i, i + 100))))
  return out
}
// Linhas que podem cruzar: PAID BY / SOURCE / PAID TO citando a outra empresa (a leitura é larga; a régua decide depois).
const citaBR = 'paid_from.ilike.gz28br,source.ilike.gz28br,paid_to.ilike.gz28br'
const citaUS = 'paid_from.ilike.gz28us,source.ilike.gz28us,paid_from.ilike.regions,source.ilike.regions,paid_to.ilike.gz28us'

// ── O CÂMBIO: o bid real do dia (ou o último pregão até 10 dias antes) ─────────
function bidAte(cot: Cotacoes, dia: string): { dia: string; bid: number } | null {
  for (let k = 0; k <= 10; k++) {
    const d = addDias(dia, -k), bid = cot.bids.get(d)
    if (bid) return { dia: d, bid }
    if (cot.lidos && !cot.lidos.has(d)) return null
  }
  return null
}

export async function intercompanyLedger(dbs: CrossingDbs = crossingDbs()): Promise<Ledger> {
  const generatedAt = new Date().toISOString()
  const { us, br } = dbs

  // ── US ──
  const [usInvoices, usExp, usStaff, usAssets, usAssetsExp, usInputs, usInventory, usFixed, usFixedSup, usIncomes, transfersRaw] = await Promise.all([
    readAll(us, 'US', 'invoices', 'id, invoice_code, ride_id, client_id, is_quote, origin, service'),
    readAll(us, 'US', 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, source, amount_brl, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'staff_expenses', 'id, season_id, type, description, supplier, amount, amount_brl, expense_date, payment_date, paid_from, paid_to, source, origin, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'assets', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'assets_expenses', 'id, good_id, description, supplier, amount, expense_date, payment_date, paid_from, paid_to, source, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'inputs', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, amount_brl, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'inventory', 'id, description, supplier, source_type, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, amount_brl, receipt_url, cancel_status, order_number', q => q.or(citaBR)),
    readAll(us, 'US', 'fixed_cost_expenses', 'id, supplier_id, description, amount, amount_brl, expense_date, payment_date, paid_from, paid_to, source, receipt_url', q => q.or(citaBR)),
    readAll(us, 'US', 'fixed_cost_suppliers', 'id, company, description, cost_type'),
    readAll(us, 'US', 'invoice_incomes', 'id, invoice_id, amount, amount_brl, payment_date, paid_at, paid_to, description, receipt_url, receipt_kinds, mirror_expense_id, mirror_src', q => q.ilike('paid_to', 'gz28br')),
    readAll(us, 'US', 'intercompany_transfers', '*'),
  ])
  const usInvById = new Map(usInvoices.map(i => [i.id, i]))
  const usRideIds = [...new Set(usInvoices.map(i => i.ride_id).filter(Boolean))] as string[]
  const usRides = new Map((await readByIds(us, 'US', 'rides', 'id, project_code, project_name', usRideIds)).map(r => [r.id, r]))
  const usSeasons = new Map((await readByIds(us, 'US', 'seasons', 'id, season_code, staff_id', [...new Set(usStaff.map(s => s.season_id).filter(Boolean))] as string[]).catch(() => [] as Row[])).map(s => [s.id, s]))
  const usFixedName = new Map(usFixedSup.map(s => [s.id, s.company || s.description || '']))

  // ── BR ──
  const [brInvoices, brExp, brStaff, brFixed, brFixedSup, brPayments, brInputs, brInventory] = await Promise.all([
    readAll(br, 'BR', 'invoices', 'id, invoice_code, ride_id, client_id, is_quote, usd_rate, service'),
    readAll(br, 'BR', 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, amount_usd, expense_date, payment_date, paid_from, paid_to, source, receipt_url, cancel_status, order_number, nature', q => q.or(citaUS)),
    readAll(br, 'BR', 'expenses', 'id, season_id, staff_id, type, description, supplier, amount, amount_usd, expense_date, payment_date, paid_from, paid_to, source, origin, receipt_url', q => q.or(citaUS)),
    readAll(br, 'BR', 'fixed_cost_expenses', 'id, supplier_id, description, amount, amount_usd, expense_date, payment_date, paid_from, paid_to, source, receipt_url', q => q.or(citaUS)),
    readAll(br, 'BR', 'fixed_cost_suppliers', 'id, company, description, cost_type'),
    readAll(br, 'BR', 'invoice_payments', 'id, invoice_id, amount, amount_usd, payment_date, paid_at, paid_to, paid_from, description, receipt_url, mirror_src', q => q.ilike('paid_to', 'gz28us')),
    // SUPPLIES e ESTOQUE do BR pagos pelo US (AutoBook BR, 23/10: frete dos motores Maurão, tie downs Ace) — amount_usd por unidade (MIGRATION_inputs_inventory_amount_usd.sql no BR)
    readAll(br, 'BR', 'inputs', 'id, description, supplier, unit_price, quantity, amount_usd, purchase_date, payment_date, paid_from, paid_to, source, receipt_url, cancel_status, order_number', q => q.or(citaUS)),
    readAll(br, 'BR', 'inventory', 'id, description, supplier, source_type, unit_price, quantity, amount_usd, purchase_date, payment_date, paid_from, paid_to, source, receipt_url, cancel_status, order_number', q => q.or(citaUS)),
  ])
  const brInvById = new Map(brInvoices.map(i => [i.id, i]))
  const brRideIds = [...new Set(brInvoices.map(i => i.ride_id).filter(Boolean))] as string[]
  const brRides = new Map((await readByIds(br, 'BR', 'rides', 'id, project_code, project_name', brRideIds)).map(r => [r.id, r]))
  const brFixedName = new Map(brFixedSup.map(s => [s.id, s.company || s.description || '']))
  const brStaffName = new Map((await readByIds(br, 'BR', 'staff', 'id, name, nickname', [...new Set(brStaff.map(s => s.staff_id).filter(Boolean))] as string[]).catch(() => [] as Row[])).map(s => [s.id, s.nickname || s.name || '']))

  // ── o câmbio de cada dia que precisa dele ──
  const diasFx = new Set<string>()
  const entries: LedgerEntry[] = []
  const leftOut: LeftOut[] = []
  const looseEnds: Ledger['looseEnds'] = []

  const usHref = (inv: Row | undefined, table: string, row: Row): string | null => {
    if (inv && inv.ride_id) return `/rides/${inv.ride_id}/invoices/${inv.id}`
    if (table === 'staff_expenses') return row.season_id ? `/staff` : '/staff'
    if (table === 'assets' || table === 'assets_expenses') return '/goods'
    if (table === 'inputs') return '/inputs'
    if (table === 'inventory') return '/inventory'
    if (table === 'fixed_cost_expenses') return row.supplier_id ? `/costs/fixed/${row.supplier_id}` : '/costs/fixed'
    return null
  }
  const brHref = (inv: Row | undefined, table: string, row: Row): string | null => {
    if (inv && inv.ride_id) return `${BR_APP_BASE}/rides/${inv.ride_id}/invoices/${inv.id}`
    if (table === 'expenses') return row.staff_id ? `${BR_APP_BASE}/staff/${row.staff_id}/expenses` : `${BR_APP_BASE}/staff`
    if (table === 'fixed_cost_expenses') return row.supplier_id ? `${BR_APP_BASE}/costs/fixed/${row.supplier_id}` : `${BR_APP_BASE}/costs/fixed`
    if (table === 'inputs') return `${BR_APP_BASE}/inputs`
    if (table === 'inventory') return `${BR_APP_BASE}/inventory`
    return null
  }
  const usCode = (inv: Row | undefined) => { if (!inv) return null; const r = inv.ride_id ? usRides.get(inv.ride_id) : null; return `${inv.invoice_code}${r ? ' · ' + r.project_name : ''}` }
  const brCode = (inv: Row | undefined) => { if (!inv) return null; const r = inv.ride_id ? brRides.get(inv.ride_id) : null; return `${inv.invoice_code}${r ? ' · ' + r.project_name : ''}` }

  // ── 1. despesas do US pagas pelo BR (crédito do BR) ──
  type UsSrc = { table: string; rows: Row[]; valor: (r: Row) => number; dia: (r: Row) => string | null; label: (r: Row) => string; grupo?: (r: Row) => unknown }
  const usSources: UsSrc[] = [
    { table: 'invoice_expenses', rows: usExp, valor: valorDespesa, dia: r => ymd(r.payment_date), label: r => [r.supplier, r.item].filter(Boolean).join(' · '), grupo: r => r.invoice_id },
    { table: 'staff_expenses', rows: usStaff, valor: r => num(r.amount), dia: r => ymd(r.payment_date), label: r => `${r.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${usSeasons.get(r.season_id)?.season_code || ''} · ${r.description || r.type || ''}`.replace(/ ·  · /g, ' · ') },
    { table: 'assets', rows: usAssets, valor: valorItem, dia: r => ymd(r.payment_date), label: r => `ASSET · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
    { table: 'assets_expenses', rows: usAssetsExp, valor: r => num(r.amount), dia: r => ymd(r.payment_date), label: r => `ASSET · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
    { table: 'inputs', rows: usInputs, valor: valorItem, dia: r => ymd(r.payment_date), label: r => `SUPPLY · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
    { table: 'inventory', rows: usInventory.filter(r => r.source_type !== 'DONATED'), valor: valorItem, dia: r => ymd(r.payment_date), label: r => `STOCK · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
    { table: 'fixed_cost_expenses', rows: usFixed, valor: r => num(r.amount), dia: r => ymd(r.payment_date), label: r => `FIXO · ${usFixedName.get(r.supplier_id) || ''} · ${r.description || ''}` },
  ]
  for (const src of usSources) {
    const fora = src.table === 'fixed_cost_expenses' ? new Set<Row>() : foraDoDinheiro(src.rows, src.valor, src.grupo)
    for (const r of src.rows) {
      const key = `US:${src.table}:${r.id}`
      const inv = src.table === 'invoice_expenses' ? usInvById.get(r.invoice_id) : undefined
      const code = usCode(inv), href = usHref(inv, src.table, r), label = src.label(r)
      const payer = payerOf(r), receiver = receiverOf(r)
      const usd = r2(src.valor(r))
      const out = (reason: string) => leftOut.push({ key, app: 'US', table: src.table, id: r.id, code, label, usd, brl: r.amount_brl != null ? num(r.amount_brl) : null, reason, href, external: false })
      if (payer !== 'GZ28BR') continue                                   // cita o BR só no PAID TO: não é o BR pagando
      if (src.table === 'invoice_expenses') {
        if (!inv) { out('invoice não encontrada'); continue }
        if (inv.is_quote) { out('quote — não é dinheiro'); continue }
        if (inv.client_id === US_CLIENT_GZ28BR) { out('shopping invoice 006.N (histórico do espelho)'); continue }
        if (inv.origin === 'BUCKET') { out('A ATRIBUIR (BUCKET) — ainda sem dono'); continue }
      }
      if (fora.has(r)) { out('estornada (lib/estorno.ts) — fora do dinheiro'); continue }
      if (receiver === 'GZ28BR') { out('PAID BY GZ28BR com PAID TO GZ28BR dentro do app US — conta interna do BR, não cruza'); continue }
      const dia = src.dia(r)
      if (!dia) { out('sem data de pagamento — o dinheiro do BR ainda não saiu (ou a data não foi gravada)'); looseEnds.push({ kind: 'SEM_DATA', key, label: `${code ? code + ' · ' : ''}${label}`, usd, href, external: false }); continue }
      if (Math.abs(usd) < 0.005) { out('valor zero'); continue }
      const brl: number | null = r.amount_brl != null && num(r.amount_brl) !== 0 ? r2(num(r.amount_brl)) : null
      const rateSource: RateSource = brl != null ? 'recorded' : 'fx_daily'
      if (brl == null) diasFx.add(dia)
      entries.push({ key, app: 'US', table: src.table, id: r.id, kind: 'EXPENSE', side: 'US_OWES', date: dia, month: dia.slice(0, 7), usd, brl, rate: brl != null ? r4(brl / usd) : null, rateSource, code, label, href, external: false, payer, receiver, receipts: receiptsOf(r.receipt_url), flags: [] })
    }
  }

  // ── 2. rendas do US recebidas no BR (débito do BR) ──
  for (const p of usIncomes) {
    const key = `US:invoice_incomes:${p.id}`
    const inv = usInvById.get(p.invoice_id)
    const code = usCode(inv), href = inv ? usHref(inv, 'invoice_incomes', p) : null, label = `RENDA · ${p.description || ''}`
    const usd = r2(num(p.amount))
    const out = (reason: string) => leftOut.push({ key, app: 'US', table: 'invoice_incomes', id: p.id, code, label, usd, brl: p.amount_brl != null ? num(p.amount_brl) : null, reason, href, external: false })
    if (!inv) { out('invoice não encontrada'); continue }
    if (inv.is_quote) { out('quote'); continue }
    if (inv.client_id === US_CLIENT_GZ28BR) { out('shopping invoice 006.N (histórico do espelho)'); continue }
    if (p.mirror_expense_id) { out('espelho de despesa paga pelo cliente — não é caixa'); continue }
    if (!p.paid_at) { out('renda ainda não recebida'); continue }
    const dia = ymd(p.payment_date) || dayIn(p.paid_at, 'America/New_York')
    if (!dia) { out('sem dia da baixa'); continue }
    const brl: number | null = p.amount_brl != null && num(p.amount_brl) !== 0 ? r2(num(p.amount_brl)) : null
    if (brl == null) diasFx.add(dia)
    entries.push({ key, app: 'US', table: 'invoice_incomes', id: p.id, kind: 'INCOME', side: 'BR_OWES', date: dia, month: dia.slice(0, 7), usd, brl, rate: brl != null ? r4(brl / usd) : null, rateSource: brl != null ? 'recorded' : 'fx_daily', code, label, href, external: false, payer: null, receiver: 'GZ28BR', receipts: receiptsOf(p.receipt_url), flags: [] })
  }

  // ── 3. despesas do BR pagas pelo US (débito do BR) ──
  // O US$ da linha do BR: amount_usd é POR UNIDADE; tax/extra são R$ totais e voltam a US$ pelo fator da própria linha (price/amount_usd).
  const usdBR = (r: Row): number | null => {
    const au = num(r.amount_usd); if (!(au > 0)) return null
    const q = num(r.quantity) || 1, price = num(r.price)
    const fator = price > 0 ? price / au : 0
    const extras = num(r.tax) + num(r.extra)
    return r2(au * q + (fator > 0 ? extras / fator : 0))
  }
  type BrSrc = { table: string; rows: Row[]; brl: (r: Row) => number; usdRec: (r: Row) => number | null; dia: (r: Row) => string | null; label: (r: Row) => string; grupo?: (r: Row) => unknown }
  const brSources: BrSrc[] = [
    { table: 'invoice_expenses', rows: brExp, brl: valorDespesa, usdRec: usdBR, dia: r => ymd(r.expense_date) || ymd(r.payment_date), label: r => [r.supplier, r.item].filter(Boolean).join(' · '), grupo: r => r.invoice_id },
    { table: 'expenses', rows: brStaff, brl: r => num(r.amount), usdRec: r => (num(r.amount_usd) > 0 ? r2(num(r.amount_usd)) : null), dia: r => ymd(r.payment_date) || ymd(r.expense_date), label: r => `FOLHA · ${brStaffName.get(r.staff_id) || ''} · ${r.description || r.type || ''}` },
    { table: 'fixed_cost_expenses', rows: brFixed, brl: r => num(r.amount), usdRec: r => (num(r.amount_usd) > 0 ? r2(num(r.amount_usd)) : null), dia: r => ymd(r.payment_date) || ymd(r.expense_date), label: r => `FIXO · ${brFixedName.get(r.supplier_id) || ''} · ${r.description || ''}` },
    { table: 'inputs', rows: brInputs, brl: valorItem, usdRec: r => (num(r.amount_usd) > 0 ? r2(num(r.amount_usd) * (num(r.quantity) || 1)) : null), dia: r => ymd(r.payment_date) || ymd(r.purchase_date), label: r => `SUPPLY · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
    { table: 'inventory', rows: brInventory.filter(r => r.source_type !== 'DONATED'), brl: valorItem, usdRec: r => (num(r.amount_usd) > 0 ? r2(num(r.amount_usd) * (num(r.quantity) || 1)) : null), dia: r => ymd(r.payment_date) || ymd(r.purchase_date), label: r => `STOCK · ${[r.supplier, r.description].filter(Boolean).join(' · ')}` },
  ]
  for (const src of brSources) {
    const fora = src.table === 'invoice_expenses' || src.table === 'inputs' || src.table === 'inventory' ? foraDoDinheiro(src.rows, src.brl, src.grupo) : new Set<Row>()
    for (const r of src.rows) {
      const key = `BR:${src.table}:${r.id}`
      const inv = src.table === 'invoice_expenses' ? brInvById.get(r.invoice_id) : undefined
      const code = brCode(inv), href = brHref(inv, src.table, r), label = src.label(r)
      const payer = payerOf(r), receiver = receiverOf(r)
      const brl = r2(src.brl(r))
      const out = (reason: string) => leftOut.push({ key, app: 'BR', table: src.table, id: r.id, code, label, usd: src.usdRec(r), brl, reason, href, external: true })
      if (payer !== 'GZ28US') {
        // «Crédito com GZ28US — FL tax» (BR.526/530/535): PAID BY GZ28BR → PAID TO GZ28US = crédito do BR contra o US, a decidir.
        if (receiver === 'GZ28US' && payer === 'GZ28BR') { out('crédito do BR contra o US (linha PAID BY GZ28BR → PAID TO GZ28US) — decisão pendente, não é despesa'); looseEnds.push({ kind: 'CREDITO_A_DECIDIR', key, label: `${code ? code + ' · ' : ''}${label}`, usd: src.usdRec(r), href, external: true }) }
        continue
      }
      if (src.table === 'invoice_expenses') {
        if (!inv) { out('invoice não encontrada'); continue }
        if (inv.is_quote) { out('quote — não é dinheiro'); continue }
        if (inv.client_id === BR_CLIENT_GZ28US) { out('shopping invoice 085.N (histórico do espelho)'); continue }
        if (/florida\s*tax/i.test(String(r.item || ''))) { out('linha de Florida tax — tratada à parte'); continue }
      }
      if (fora.has(r)) { out('estornada — fora do dinheiro'); continue }
      const dia = src.dia(r)
      if (!dia) { out('sem data'); looseEnds.push({ kind: 'SEM_DATA', key, label: `${code ? code + ' · ' : ''}${label}`, usd: src.usdRec(r), href, external: true }); continue }
      if (Math.abs(brl) < 0.005 && !(num(r.amount_usd) > 0)) { out('valor zero'); continue }
      const rec = src.usdRec(r)
      if (rec == null) diasFx.add(dia)
      const flags: string[] = []
      if (!r.payment_date && src.table === 'invoice_expenses') flags.push('BR_NAO_BAIXOU')   // o BR ainda não deu baixa na linha (o US já pagou): informativo
      entries.push({ key, app: 'BR', table: src.table, id: r.id, kind: 'EXPENSE', side: 'BR_OWES', date: dia, month: dia.slice(0, 7), usd: rec ?? 0, brl, rate: rec != null && rec > 0 ? r4(brl / rec) : null, rateSource: rec != null ? 'recorded' : 'fx_daily', code, label, href, external: true, payer, receiver, receipts: receiptsOf(r.receipt_url), flags })
    }
  }

  // ── 4. rendas do BR recebidas no US (crédito do BR) ──
  for (const p of brPayments) {
    const key = `BR:invoice_payments:${p.id}`
    const inv = brInvById.get(p.invoice_id)
    const code = brCode(inv), href = inv ? brHref(inv, 'invoice_payments', p) : null, label = `RENDA · ${p.description || ''}`
    const brl = r2(num(p.amount))
    const out = (reason: string) => leftOut.push({ key, app: 'BR', table: 'invoice_payments', id: p.id, code, label, usd: num(p.amount_usd) > 0 ? num(p.amount_usd) : null, brl, reason, href, external: true })
    if (!inv) { out('invoice não encontrada'); continue }
    if (inv.is_quote) { out('quote'); continue }
    if (inv.client_id === BR_CLIENT_GZ28US) { out('shopping invoice 085.N (histórico do espelho)'); continue }
    if (!p.paid_at) { out('renda ainda não recebida'); continue }
    const dia = ymd(p.payment_date) || dayIn(p.paid_at, 'America/Sao_Paulo')
    if (!dia) { out('sem dia da baixa'); continue }
    const rec = num(p.amount_usd) > 0 ? r2(num(p.amount_usd)) : null
    if (rec == null) diasFx.add(dia)
    entries.push({ key, app: 'BR', table: 'invoice_payments', id: p.id, kind: 'INCOME', side: 'US_OWES', date: dia, month: dia.slice(0, 7), usd: rec ?? 0, brl, rate: rec ? r4(brl / rec) : null, rateSource: rec != null ? 'recorded' : 'fx_daily', code, label, href, external: true, payer: null, receiver: 'GZ28US', receipts: receiptsOf(p.receipt_url), flags: [] })
  }

  // ── 5. transferências ──
  const transfers: Transfer[] = []
  for (const t of transfersRaw) {
    const sentUsd = t.sent_currency === 'USD' ? num(t.sent_amount) : null, arrUsd = t.arrived_currency === 'USD' ? num(t.arrived_amount) : null
    const sentBrl = t.sent_currency === 'BRL' ? num(t.sent_amount) : null, arrBrl = t.arrived_currency === 'BRL' ? num(t.arrived_amount) : null
    const usd = r2(arrUsd ?? sentUsd ?? 0), brl = sentBrl ?? arrBrl
    const rate = usd > 0 && brl != null && brl > 0 ? r4(brl / usd) : null
    const tr: Transfer = { id: t.id, code: t.code, direction: t.direction, via: t.via, sent_on: ymd(t.sent_on), sent_amount: t.sent_amount == null ? null : num(t.sent_amount), sent_currency: t.sent_currency, sent_receipts: receiptsOf(t.sent_receipts), arrived_on: ymd(t.arrived_on), arrived_amount: t.arrived_amount == null ? null : num(t.arrived_amount), arrived_currency: t.arrived_currency, arrived_receipts: receiptsOf(t.arrived_receipts), bank_transaction_id: t.bank_transaction_id, covers: Array.isArray(t.covers) ? t.covers : [], legacy: t.legacy || {}, description: t.description, status: t.status, fx_diff_usd: num(t.fx_diff_usd), needs_review: !!t.needs_review, usd, brl: brl == null ? null : r2(brl), rate }
    transfers.push(tr)
    const dia = tr.arrived_on || tr.sent_on
    const key = `US:intercompany_transfers:${t.id}`
    const label = `${tr.direction === 'BR_TO_US' ? 'BR → US' : 'US → BR'} · ${tr.via || ''} · ${tr.description || ''}`.replace(/ ·  · /g, ' · ')
    // EM TRÂNSITO NÃO CONTA (Márcio, 20/10/2026, cheque do Sidney: «quando o Allan mandar o comprovante, entra a parte do US paid from
    // BR, e zera a operação»): a transferência só abate a conta quando CHEGA. Até lá é ponta solta, fora do número.
    if (tr.status === 'SENT') { leftOut.push({ key, app: 'US', table: 'intercompany_transfers', id: t.id, code: tr.code, label, usd, brl: tr.brl, reason: 'transferência em trânsito — só conta quando chegar', href: '/gz-flow', external: false }); continue }
    if (!dia) { leftOut.push({ key, app: 'US', table: 'intercompany_transfers', id: t.id, code: tr.code, label, usd, brl: tr.brl, reason: 'transferência sem data', href: '/gz-flow', external: false }); continue }
    if (usd <= 0) {
      // Só R$ gravado (ainda sem a chegada em US$): conta pelo bid do dia, marcado
      if (brl != null && brl > 0) diasFx.add(dia)
      else { leftOut.push({ key, app: 'US', table: 'intercompany_transfers', id: t.id, code: tr.code, label, usd, brl: tr.brl, reason: 'transferência sem valor', href: '/gz-flow', external: false }); continue }
    }
    const flags: string[] = []
    if (tr.needs_review) flags.push('REVISAR')
    if (tr.fx_diff_usd) flags.push('DIF_CAMBIO')
    entries.push({ key, app: 'US', table: 'intercompany_transfers', id: t.id, kind: 'TRANSFER', side: tr.direction === 'BR_TO_US' ? 'US_OWES' : 'BR_OWES', date: dia, month: dia.slice(0, 7), usd, brl: tr.brl, rate, rateSource: usd > 0 ? 'transfer' : 'fx_daily', code: tr.code, label, href: '/gz-flow', external: false, payer: tr.direction === 'BR_TO_US' ? 'GZ28BR' : 'GZ28US', receiver: tr.direction === 'BR_TO_US' ? 'GZ28US' : 'GZ28BR', receipts: [...tr.sent_receipts, ...tr.arrived_receipts], flags })
    // A diferença de câmbio declarada ao fechar: lançamento próprio, no mesmo dia, do lado que ela favorece
    if (tr.fx_diff_usd) entries.push({ key: key + ':fx', app: 'US', table: 'intercompany_transfers', id: t.id, kind: 'TRANSFER', side: tr.fx_diff_usd > 0 ? 'US_OWES' : 'BR_OWES', date: dia, month: dia.slice(0, 7), usd: r2(Math.abs(tr.fx_diff_usd)), brl: null, rate: null, rateSource: 'none', code: tr.code, label: `diferença de câmbio declarada · ${tr.code}`, href: '/gz-flow', external: false, payer: null, receiver: null, receipts: [], flags: ['DIF_CAMBIO'] })
  }

  // ── o câmbio que falta ──
  const cot = diasFx.size ? await carregarCotacoes([...diasFx], us) : { bids: new Map<string, number>(), falha: null as string | null, lidos: new Set<string>() }
  const missingDays = new Set<string>()
  for (const e of entries) {
    if (e.rateSource !== 'fx_daily' || !e.date) continue
    const b = bidAte(cot, e.date)
    if (!b) { missingDays.add(e.date); e.rateSource = 'none'; if (e.app === 'BR' || (e.kind === 'TRANSFER' && e.usd <= 0)) { e.usd = 0; e.flags.push('SEM_CAMBIO') } continue }
    e.rate = r4(b.bid)
    if (e.app === 'US') e.brl = r2(e.usd * b.bid)
    else if (e.kind === 'TRANSFER') e.usd = r2((e.brl || 0) / b.bid)
    else e.usd = r2((e.brl || 0) / b.bid)
  }
  for (const e of entries) if (e.flags.includes('SEM_CAMBIO')) looseEnds.push({ kind: 'SEM_CAMBIO', key: e.key, label: `${e.code ? e.code + ' · ' : ''}${e.label} — R$ ${e.brl ?? '?'} sem cotação do dia ${e.date}`, usd: null, href: e.href, external: e.external })

  // ── pontas soltas: renda recebida no BR sem transferência que a cubra há mais de 30 dias; transferência em trânsito; a revisar ──
  const covered = new Set(transfers.flatMap(t => t.covers.map(c => `${c.app}:${c.table}:${c.id}`)))
  const hoje = new Date().toISOString().slice(0, 10)
  for (const e of entries) {
    // AVISO, não erro (AutoBook US, 23/10): em 2025 o BR gastou esse dinheiro pagando conta do US direto (cartões, folha, SEMA) — isso já
    // está na conta como despesa PAID BY GZ28BR. Só vira transferência o que de fato foi ao Allan. A lista mostra o que ainda não tem cobertura.
    if (e.kind === 'INCOME' && e.app === 'US' && !covered.has(e.key) && e.date && addDias(e.date, 30) < hoje) looseEnds.push({ kind: 'RENDA_NO_BR_SEM_REMESSA', key: e.key, label: `${e.code ? e.code + ' · ' : ''}${e.label} — recebida no BR em ${e.date}; nenhuma transferência declara cobri-la (pode ter sido gasta pelo BR pagando conta do US)`, usd: e.usd, href: e.href, external: e.external })
  }
  for (const t of transfers) {
    if (t.status === 'SENT' && (t.usd > 0 || (t.brl || 0) > 0)) looseEnds.push({ kind: 'TRANSFERENCIA_EM_TRANSITO', key: `US:intercompany_transfers:${t.id}`, label: `${t.code} — saiu ${t.sent_on || '?'} e ainda não chegou (fora do número até chegar)`, usd: t.usd, href: '/gz-flow', external: false })
    // Zerada (anulada ou consolidada noutra, valores null) não é ponta solta: é história com descrição.
    if (t.needs_review && (t.sent_amount != null || t.arrived_amount != null)) looseEnds.push({ kind: 'TRANSFERENCIA_A_REVISAR', key: `US:intercompany_transfers:${t.id}`, label: `${t.code} — ${t.description || ''} (falta o lado ${t.brl == null ? 'R$' : 'US$'} / o comprovante)`, usd: t.usd, href: '/gz-flow', external: false })
    // Saque em espécie (via CASH) nunca passa na Regions: não é ponta solta sem linha do banco.
    if (t.direction === 'BR_TO_US' && t.status !== 'SENT' && !t.bank_transaction_id && String(t.via || '').toUpperCase() !== 'CASH') looseEnds.push({ kind: 'TRANSFERENCIA_SEM_REGIONS', key: `US:intercompany_transfers:${t.id}`, label: `${t.code} — chegada sem linha da Regions casada`, usd: t.usd, href: '/gz-flow', external: false })
  }

  // ── a conta ──
  entries.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.key.localeCompare(b.key))
  let brOwes = 0, usOwes = 0
  const byKind: Ledger['totals']['byKind'] = {}, byApp: Ledger['totals']['byApp'] = {}
  const eras = { E1: { brOwes: 0, usOwes: 0, net: 0, n: 0 }, E2: { brOwes: 0, usOwes: 0, net: 0, n: 0 } }
  const monthsMap = new Map<string, MonthLine>()
  for (const e of entries) {
    const k = byKind[e.kind] || (byKind[e.kind] = { brOwes: 0, usOwes: 0, n: 0 })
    const a = byApp[e.app] || (byApp[e.app] = { brOwes: 0, usOwes: 0, n: 0 })
    const era = (e.date || '9999') < '2026-01-01' ? eras.E1 : eras.E2
    const m = e.month || '—'
    const ml = monthsMap.get(m) || { month: m, brOwes: 0, usOwes: 0, net: 0, running: 0, n: 0 }
    if (e.side === 'BR_OWES') { brOwes += e.usd; k.brOwes += e.usd; a.brOwes += e.usd; era.brOwes += e.usd; ml.brOwes += e.usd }
    else { usOwes += e.usd; k.usOwes += e.usd; a.usOwes += e.usd; era.usOwes += e.usd; ml.usOwes += e.usd }
    k.n++; a.n++; era.n++; ml.n++
    monthsMap.set(m, ml)
  }
  eras.E1.net = r2(eras.E1.brOwes - eras.E1.usOwes); eras.E2.net = r2(eras.E2.brOwes - eras.E2.usOwes)
  const months = [...monthsMap.values()].sort((a, b) => a.month.localeCompare(b.month))
  let running = 0
  for (const ml of months) { ml.brOwes = r2(ml.brOwes); ml.usOwes = r2(ml.usOwes); ml.net = r2(ml.brOwes - ml.usOwes); running = r2(running + ml.net); ml.running = running }
  for (const k of Object.values(byKind)) { k.brOwes = r2(k.brOwes); k.usOwes = r2(k.usOwes) }
  for (const a of Object.values(byApp)) { a.brOwes = r2(a.brOwes); a.usOwes = r2(a.usOwes) }
  return {
    generatedAt, brOwesUs: r2(brOwes - usOwes),
    totals: { brOwes: r2(brOwes), usOwes: r2(usOwes), byKind, byApp },
    eras: { E1: { ...eras.E1, brOwes: r2(eras.E1.brOwes), usOwes: r2(eras.E1.usOwes) }, E2: { ...eras.E2, brOwes: r2(eras.E2.brOwes), usOwes: r2(eras.E2.usOwes) } },
    months, entries, transfers: transfers.sort((a, b) => (b.arrived_on || b.sent_on || '').localeCompare(a.arrived_on || a.sent_on || '')), leftOut, looseEnds,
    fx: { missingDays: [...missingDays].sort(), failure: cot.falha },
  }
}
