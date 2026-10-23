// ════════════════════════════════════════════════════════════════════════════
// lib/intercompanyReconcile.server.ts · 23/out/2026 — A CONTA NOVA CONTRA O ESPELHO VELHO, LINHA A LINHA (SÓ LEITURA)
//
// Enquanto o espelho (006.N/085.N, lib/crossing.server.ts) existir como histórico, esta conferência diz, item por item, de onde
// vem cada centavo de diferença entre o saldo CALCULADO (lib/intercompanyLedger.server.ts) e o saldo do espelho
// (lib/crossingBalance.ts). Cada lançamento do ledger procura o seu espelho pelo elo que o motor gravou (mirror_src =
// '<BANCO>:<tabela>:<id>'); cada linha de 006.N/085.N que não tem lançamento no ledger é listada com o motivo.
// Nada aqui escreve. O objetivo é chegar a diferença ZERO explicada — ou a um saldo novo que o dono aceite.

import type { SupabaseClient } from '@supabase/supabase-js'
import { crossingDbs, crossingBalance, CrossingReadError, type CrossingDbs } from '@/lib/crossingBalance.server'
import { US_CLIENT_GZ28BR, BR_CLIENT_GZ28US } from '@/lib/crossingBalance'
import { intercompanyLedger, type Ledger } from '@/lib/intercompanyLedger.server'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>
const r2 = (v: number) => Math.round(v * 100) / 100
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0

export type Pair = { key: string; code: string | null; label: string; ledgerUsd: number; mirrorUsd: number; diff: number; where: string }
export type Orphan = { side: 'US' | 'BR'; code: string; table: string; id: string; label: string; usd: number; why: string }
export type Reconcile = {
  generatedAt: string
  ledger: { brOwesUs: number; brOwes: number; usOwes: number }
  engine: { brOwesUs: number; usOpen: number; brOpen: number; usTotal: number; usReceived: number; brTotalUsd: number; brReceivedUsd: number }
  difference: number           // engine − ledger
  buckets: { name: string; usd: number; note: string }[]
  pairsOff: Pair[]             // lançamento com espelho de valor diferente
  noMirror: Pair[]             // lançamento do ledger sem espelho no outro app
  orphans: Orphan[]            // linha de 006.N/085.N sem lançamento no ledger
  transfersNotInEngine: { code: string; usd: number; status: string }[]
}

async function readAll(db: SupabaseClient, label: string, table: string, columns: string, filter: (q: any) => any = q => q): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order('id').range(from, from + 999)
    if (error) throw new CrossingReadError('db', `Falha ao ler ${label}.${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

export async function intercompanyReconcile(dbs: CrossingDbs = crossingDbs(), pre?: { ledger?: Ledger }): Promise<Reconcile> {
  const generatedAt = new Date().toISOString()
  const [ledger, engine] = await Promise.all([pre?.ledger ? Promise.resolve(pre.ledger) : intercompanyLedger(dbs), crossingBalance(dbs)])
  const { us, br } = dbs
  // As linhas das shopping invoices, com os elos
  const usInv = await readAll(us, 'US', 'invoices', 'id, invoice_code, ride_id, is_quote', q => q.eq('client_id', US_CLIENT_GZ28BR))
  const brInv = await readAll(br, 'BR', 'invoices', 'id, invoice_code, ride_id, is_quote, usd_rate', q => q.eq('client_id', BR_CLIENT_GZ28US))
  const usIds = usInv.filter(i => !i.is_quote && !i.ride_id).map(i => i.id), brIds = brInv.filter(i => !i.is_quote).map(i => i.id)
  const inChunks = async (db: SupabaseClient, label: string, table: string, cols: string, ids: string[]) => { const out: Row[] = []; for (let i = 0; i < ids.length; i += 100) out.push(...await readAll(db, label, table, cols, q => q.in('invoice_id', ids.slice(i, i + 100)))); return out }
  const [usItems, , usIncomes, usServices, brParts, , brPay] = await Promise.all([
    inChunks(us, 'US', 'invoice_items', 'id, invoice_id, description, unit_price, quantity, mirror_src, cancel_status', usIds),
    inChunks(us, 'US', 'invoice_expenses', 'id, invoice_id, item, price, quantity, tax, extra, mirror_src, br_expense_id, cancel_status', usIds),
    inChunks(us, 'US', 'invoice_incomes', 'id, invoice_id, amount, paid_at, mirror_src, description', usIds),
    inChunks(us, 'US', 'invoice_services', 'id, invoice_id, description, price', usIds),
    inChunks(br, 'BR', 'invoice_parts', 'id, invoice_id, description, unit_price, quantity, unit_price_usd, mirror_src', brIds),
    inChunks(br, 'BR', 'invoice_expenses', 'id, invoice_id, item, price, quantity, tax, extra, amount_usd, mirror_src, us_expense_id', brIds),
    inChunks(br, 'BR', 'invoice_payments', 'id, invoice_id, amount, amount_usd, paid_at, mirror_src, us_income_id, description', brIds),
  ])
  const usCode = new Map(usInv.map(i => [i.id, i.invoice_code])), brCode = new Map(brInv.map(i => [i.id, i.invoice_code])), brRate = new Map(brInv.map(i => [i.id, num(i.usd_rate)]))

  // O US$ que o MOTOR conta em cada linha espelho (as mesmas fórmulas de lib/crossingBalance.ts)
  const usItemUsd = (i: Row) => num(i.unit_price) * (num(i.quantity) || 1)
  const brPartUsd = (p: Row) => (num(p.unit_price_usd) > 0 ? num(p.unit_price_usd) * (num(p.quantity) || 1) : brRate.get(p.invoice_id) ? num(p.unit_price) * (num(p.quantity) || 1) / brRate.get(p.invoice_id)! : 0)
  const brPayUsd = (p: Row) => (num(p.amount_usd) > 0 ? num(p.amount_usd) : brRate.get(p.invoice_id) ? num(p.amount) / brRate.get(p.invoice_id)! : 0)

  // Índices por elo
  const usItemBySrc = new Map<string, Row>(); for (const i of usItems) if (i.mirror_src) usItemBySrc.set(i.mirror_src, i)
  const usIncomeBySrc = new Map<string, Row>(); for (const i of usIncomes) if (i.mirror_src) usIncomeBySrc.set(i.mirror_src, i)
  const brPartBySrc = new Map<string, Row>(); for (const p of brParts) if (p.mirror_src) brPartBySrc.set(p.mirror_src, p)
  const brPayBySrc = new Map<string, Row>(); for (const p of brPay) if (p.mirror_src) brPayBySrc.set(p.mirror_src, p)
  const brPayByUsIncome = new Map<string, Row>(); for (const p of brPay) if (p.us_income_id) brPayByUsIncome.set(p.us_income_id, p)

  const pairsOff: Pair[] = [], noMirror: Pair[] = []
  const matchedMirrors = new Set<string>()
  const tol = 0.02
  for (const e of ledger.entries) {
    if (e.kind === 'TRANSFER') continue
    let mirror: Row | undefined, mirrorUsd = 0, where = ''
    if (e.app === 'US' && e.kind === 'EXPENSE') { mirror = brPartBySrc.get(e.key); if (mirror) { mirrorUsd = brPartUsd(mirror); where = `085 · ${brCode.get(mirror.invoice_id)}`; matchedMirrors.add('BRpart:' + mirror.id) } }
    else if (e.app === 'US' && e.kind === 'INCOME') { mirror = brPayBySrc.get(e.key) || brPayByUsIncome.get(e.id); if (mirror) { mirrorUsd = brPayUsd(mirror); where = `085 · ${brCode.get(mirror.invoice_id)}`; matchedMirrors.add('BRpay:' + mirror.id) } }
    else if (e.app === 'BR' && e.kind === 'EXPENSE') { mirror = usItemBySrc.get(e.key); if (mirror) { mirrorUsd = usItemUsd(mirror); where = `006 · ${usCode.get(mirror.invoice_id)}`; matchedMirrors.add('USitem:' + mirror.id) } }
    else if (e.app === 'BR' && e.kind === 'INCOME') { mirror = usIncomeBySrc.get(e.key); if (mirror) { mirrorUsd = num(mirror.amount); where = `006 · ${usCode.get(mirror.invoice_id)}`; matchedMirrors.add('USinc:' + mirror.id) } }
    const row: Pair = { key: e.key, code: e.code, label: e.label, ledgerUsd: e.usd, mirrorUsd: r2(mirrorUsd), diff: r2(e.usd - mirrorUsd), where }
    if (!mirror) noMirror.push(row)
    else if (Math.abs(row.diff) > tol) pairsOff.push(row)
  }
  // Linhas das shopping invoices sem lançamento no ledger (ou não casadas por elo)
  const orphans: Orphan[] = []
  for (const i of usItems) { if (i.cancel_status) continue; if (!matchedMirrors.has('USitem:' + i.id)) orphans.push({ side: 'US', code: usCode.get(i.invoice_id) || '', table: 'invoice_items', id: i.id, label: i.description || '', usd: r2(usItemUsd(i)), why: i.mirror_src ? `elo ${i.mirror_src} sem lançamento no ledger (origem fora da régua ou apagada)` : 'item sem elo (lançado à mão na 006.N)' }) }
  for (const s of usServices) orphans.push({ side: 'US', code: usCode.get(s.invoice_id) || '', table: 'invoice_services', id: s.id, label: s.description || '', usd: r2(num(s.price)), why: 'serviço na 006.N — não existe no modelo novo' })
  for (const i of usIncomes) { if (!i.paid_at) continue; if (String(i.mirror_src || '').startsWith('BR:') && !matchedMirrors.has('USinc:' + i.id)) orphans.push({ side: 'US', code: usCode.get(i.invoice_id) || '', table: 'invoice_incomes', id: i.id, label: i.description || '', usd: r2(num(i.amount)), why: `renda espelho ${i.mirror_src} sem lançamento no ledger` }) }
  for (const p of brParts) if (!matchedMirrors.has('BRpart:' + p.id)) orphans.push({ side: 'BR', code: brCode.get(p.invoice_id) || '', table: 'invoice_parts', id: p.id, label: p.description || '', usd: r2(brPartUsd(p)), why: p.mirror_src ? `elo ${p.mirror_src} sem lançamento no ledger (origem fora da régua: sem data, estornada, bucket…)` : 'parte sem elo (lançada à mão na 085.N)' })
  for (const p of brPay) { if (!p.paid_at) continue; if (!matchedMirrors.has('BRpay:' + p.id)) orphans.push({ side: 'BR', code: brCode.get(p.invoice_id) || '', table: 'invoice_payments', id: p.id, label: p.description || '', usd: r2(brPayUsd(p)), why: p.mirror_src ? `pagamento espelho ${p.mirror_src} sem lançamento no ledger` : 'pagamento sem elo na 085.N' }) }
  // Transferências que o motor não vê (sem renda 006.N — em trânsito, ou criadas já no modelo novo)
  const transfersNotInEngine = ledger.transfers.filter(t => !(Array.isArray(t.legacy?.arrival_income_ids) && t.legacy.arrival_income_ids.length) && !(Array.isArray(t.legacy?.income_ids) && t.legacy.income_ids.length)).map(t => ({ code: t.code, usd: t.usd, status: t.status }))

  const eng = engine as any
  // A DIFERENÇA DECOMPOSTA (motor − ledger), em quatro parcelas que somam exatamente a diferença:
  //   A = itens das 006.N (o que o motor diz que o BR deve)        − despesas do BR pagas pelo US (ledger)
  //   B = transferências + rendas do BR recebidas no US (ledger)    − recebido nas 006.N (motor)
  //   C = despesas do US pagas pelo BR (ledger)                     − linhas das 085.N (motor)
  //   D = pago nas 085.N (motor)                                     − rendas do US recebidas no BR (ledger)
  const k = (kind: string) => ledger.totals.byKind[kind] || { brOwes: 0, usOwes: 0, n: 0 }
  const A = r2(eng.usSide.totals.total - k('EXPENSE').brOwes)
  const B = r2(k('TRANSFER').usOwes + k('INCOME').usOwes - eng.usSide.totals.received)
  const C = r2(k('EXPENSE').usOwes - eng.brSide.totals.totalUsd)
  const D = r2(eng.brSide.totals.receivedUsd - k('INCOME').brOwes)
  const buckets: Reconcile['buckets'] = [
    { name: 'A · itens das 006.N (motor) − despesas do BR pagas pelo US (ledger)', usd: A, note: 'itens/serviços lançados à mão nas 006.N, markup remanescente, linhas do BR fora da régua (quote, estorno)' },
    { name: 'B · transferências + rendas do BR no US (ledger) − recebido nas 006.N (motor)', usd: B, note: 'transferência em trânsito (o BR já pagou o Allan, a Regions ainda não recebeu) conta no ledger e não no motor' },
    { name: 'C · despesas do US pagas pelo BR (ledger) − linhas das 085.N (motor)', usd: C, note: 'linha estornada/sem data/bucket que o motor ainda espelha; despesa nova sem espelho (Alcatraz, PESSOAL)' },
    { name: 'D · pago nas 085.N (motor) − rendas do US recebidas no BR (ledger)', usd: D, note: 'zero quando toda renda RECEIVED BY GZ28BR tem o seu espelho' },
  ]
  return {
    generatedAt,
    ledger: { brOwesUs: ledger.brOwesUs, brOwes: ledger.totals.brOwes, usOwes: ledger.totals.usOwes },
    engine: { brOwesUs: eng.brOwesUs, usOpen: eng.usSide.totals.open, brOpen: eng.brSide.totals.open, usTotal: eng.usSide.totals.total, usReceived: eng.usSide.totals.received, brTotalUsd: eng.brSide.totals.totalUsd, brReceivedUsd: eng.brSide.totals.receivedUsd },
    difference: r2(eng.brOwesUs - ledger.brOwesUs),
    buckets, pairsOff: pairsOff.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)), noMirror: noMirror.sort((a, b) => Math.abs(b.ledgerUsd) - Math.abs(a.ledgerUsd)), orphans: orphans.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)), transfersNotInEngine,
  }
}
