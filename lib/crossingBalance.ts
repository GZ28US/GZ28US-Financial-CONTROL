// ════════════════════════════════════════════════════════════════════════════
// lib/crossingBalance.ts · 14/set/2026 — QUANTO O BR DEVE AO US: A CONTA (MÓDULO NEUTRO)
//
// LEI SAGRADA (Márcio, 13/set/2026 — memory/shopping-invoice-toda-travessia-us-br.md):
//   «TODA E QUALQUER movimentação financeira entre o US e o BR tem que estar nas shopping invoices»
//   «EU PRECISO SABER QUANTO O BR DEVE PRO US, é o foco do momento!»
//
// O NÚMERO É UM SÓ, E SÓ LÊ SHOPPING INVOICE — nunca paid_from/paid_to solto:
//   brOwesUs = (o que a GZ28BR deve nas invoices DELA no app US, em US$)
//            − (o que a GZ28US deve nas invoices DELA no app BR, em US$)
//
//   LADO US — invoices do cliente 97c4a91e «GZ28 V8 SpeedShop BR Ltda» (série 006.N), fora QUOTE e fora
//     invoice de CARRO (ride_id). Direção 1 já traz o +10% dentro dos itens (o item US = o US$ gravado no BR).
//       total    = (Σ unit_price × (quantity || 1) + FL tax % + Σ serviços) × (1 − desconto %)
//       recebido = Σ amount das rendas COM paid_at (a linha «Pending balance» sem baixa não é dinheiro)
//   LADO BR — invoices do cliente 6d4264bc «GZ28 V8 SpeedShop USA LLC» (série 085.N), fora QUOTE. Sem markup.
//       total US$ = Σ unit_price_usd × (quantity || 1) — sem unit_price_usd: (unit_price × qtd) ÷ usd_rate da invoice
//       pago US$  = Σ amount_usd das rendas COM paid_at — sem amount_usd: amount ÷ usd_rate da invoice
//   Valor gravado em US$ PREVALECE e nunca é recalculado aqui; a taxa da invoice só entra onde falta o gravado,
//   e cada conversão é contada (convertedByInvoiceRate) e marcada linha a linha.
//
// É A MESMA DEFINIÇÃO DA MANCHETE DO MOTOR (lib/crossing.server.ts, função manchete(), escrita em 14/set pela
// sessão do motor): US = client GZ28BR && !is_quote && !ride_id, grandTotal(), rendas com paid_at; BR = client GZ28US
// && !is_quote, partes e pagamentos com paid_at, unit_price_usd/amount_usd ou ÷ usd_rate; r2 só no fim.
// Os totais são somados na MESMA ordem do motor (invoice por id, linha por id) e arredondados só no fim — é o que
// faz os dois números baterem ao centavo. Se o motor mudar a régua, esta muda junto (e vice-versa).
//
// POR QUE MÓDULO NEUTRO (sem 'use client', sem import de servidor): a conta pura mora aqui e é a mesma para a rota
// (lib/crossingBalance.server.ts lê os dois bancos com chave de serviço e chama computeCrossingBalance), para o script
// de medição e para as telas, que só importam tipos, as constantes e a régua countsOnUsSide (o Balanço tira as 006.N
// das Contas a receber: elas estão DENTRO da conta corrente — contar nos dois lugares seria o mesmo dinheiro duas vezes).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

export const US_CLIENT_GZ28BR = '97c4a91e-d1c2-48ca-9d05-8662fe324f27' // «GZ28 V8 SpeedShop BR Ltda» no app US
export const BR_CLIENT_GZ28US = '6d4264bc-9357-4190-94d8-bdc3a254d5bd' // «GZ28 V8 SpeedShop USA LLC» no app BR
export const BR_APP_BASE = 'https://www.gz28br.com/ca'

// ── as réguas do motor, copiadas ao pé da letra (lib/crossing.server.ts: num, r2, linhaItem) ─────
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0
const r2 = (n: number) => Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100
const qty = (r: Row) => num(r.quantity) || 1
const lineValue = (r: Row) => num(r.unit_price) * qty(r)
const recorded = (v: unknown) => v != null && String(v) !== ''

/** A invoice do US entra no lado US da conta? (a régua do motor: cliente GZ28BR, não é QUOTE, não é de carro) */
export function countsOnUsSide(inv: { client_id?: string | null; is_quote?: boolean | null; ride_id?: string | null }): boolean {
  return inv.client_id === US_CLIENT_GZ28BR && !inv.is_quote && !inv.ride_id
}
/** A invoice do BR entra no lado BR da conta? (cliente GZ28US, não é QUOTE — carro não sai, como no motor) */
export function countsOnBrSide(inv: { client_id?: string | null; is_quote?: boolean | null }): boolean {
  return inv.client_id === BR_CLIENT_GZ28US && !inv.is_quote
}

// ── o que a rota devolve ────────────────────────────────────────────────────
// Motivo e aviso vão ESTRUTURADOS: a tela GZ-FLOW fala inglês e o Data Checker português — cada uma escreve o seu texto.
export type NotCountedReason = 'QUOTE' | 'CAR_INVOICE'
export type CrossingWarning =
  | { kind: 'not_counted_with_money'; side: 'US' | 'BR'; code: string; reason: NotCountedReason; total: number; received: number }
  | { kind: 'br_outside_engine_rule'; code: string; servicesBrl: number; flTaxPct: number; discountPct: number }
  | { kind: 'br_no_usd'; code: string; lines: number }
  | { kind: 'br_converted_by_invoice_rate'; lines: number }

export type UsItemLine = { id: string; description: string; unitPrice: number; quantity: number; usd: number }
export type UsServiceLine = { id: string; description: string; usd: number }
export type UsIncomeLine = { id: string; description: string; usd: number; paidAt: string | null; paymentDate: string | null; counted: boolean }
export type UsInvoice = {
  id: string; code: string; path: string; label: string; status: string | null
  counted: boolean; reason: NotCountedReason | null
  parts: number; services: number; flTaxPct: number; discountPct: number
  total: number; received: number; open: number
  pending: number; pendingN: number        // «Pending balance» sem baixa — informativo, FORA da conta
  items: UsItemLine[]; serviceLines: UsServiceLine[]; incomes: UsIncomeLine[]
}
export type UsdFrom = 'recorded' | 'invoice_usd_rate' | 'none'
export type BrPartLine = { id: string; description: string; brl: number; usd: number; usdFrom: UsdFrom }
export type BrPaymentLine = { id: string; description: string; brl: number; usd: number; usdFrom: UsdFrom; paidAt: string | null; paymentDate: string | null; counted: boolean }
export type BrInvoice = {
  id: string; code: string; url: string; label: string; usdRate: number | null
  counted: boolean; reason: NotCountedReason | null
  totalBrl: number; totalUsd: number; receivedBrl: number; receivedUsd: number; open: number
  pendingBrl: number; convertedByInvoiceRate: number
  servicesBrl: number; flTaxPct: number; discountPct: number   // FORA da régua do motor — aviso quando ≠ 0
  lines: BrPartLine[]; payments: BrPaymentLine[]
}
// ════════════════════════════════════════════════════════════════════════════
// DECISÕES PENDENTES (14/set/2026 — auditoria adversarial do lado de leitura da travessia)
// ════════════════════════════════════════════════════════════════════════════
// O número acima é a régua do motor, sem remendo. O que ainda espera o Márcio NÃO entra nem sai dele calado:
// fica listado À PARTE, cada item com o US$ em jogo e se esse dinheiro está DENTRO ou FORA de brOwesUs hoje.
// A LISTA é fixa (decisão é de gente); o VALOR é lido ao vivo das mesmas linhas, e o item some sozinho quando
// deixa de valer (invoice apagada, linha do BR ligada a uma 006.N por us_expense_id/mirror_src).
// Quando o Márcio decidir, o item sai daqui no mesmo commit que aplica a decisão.
// O motor tem as travas dele (lib/crossing.server.ts: FORA_DE_ESCOPO_BR / _US, RENDAS_US_SEGURAS) — esta lista é
// o espelho LEGÍVEL delas na tela, não uma segunda régua.
export type PendingKind = 'duplicate_in_us' | 'br_lines_without_006' | 'on_hold_invoice' | 'on_hold_line' | 'possible_double_count'
export type PendingDecisionDef = {
  key: string; since: string; kind: PendingKind
  note: string                     // em inglês: é texto da tela GZ-FLOW
  usInvoiceCodes?: string[]        // 006.N da conta — US$ = total ao vivo
  brInvoiceCodes?: string[]        // 085.N da conta — US$ = aberto ao vivo; código que ainda não existe aparece como «not created yet»
  originUsInvoiceIds?: string[]    // invoice de ORIGEM no app US (só o link)
  brPartIds?: string[]             // linha de 085.N em jogo — US$ ao vivo
  brExpenseIds?: string[]          // linha do BR PAID FROM GZ28US ainda sem 006.N — US$ ao vivo; ligada = sai da lista
}
export const PENDING_DECISIONS: readonly PendingDecisionDef[] = [
  { key: 'dup-006.6-006.21', since: '2026-09-14', kind: 'duplicate_in_us', usInvoiceCodes: ['006.6', '006.21'],
    note: 'Possible duplicate inside the US total: the same US$ 936.50 billed on two 006.N. If confirmed, one of them comes out.' },
  { key: 'dup-006.25-006.34', since: '2026-09-14', kind: 'duplicate_in_us', usInvoiceCodes: ['006.25', '006.34'],
    note: 'Possible duplicate inside the US total: 006.25 (no description) × 006.34. If confirmed, one of them comes out — the smaller amount is shown as at stake.' },
  { key: 'hold-kit-motor-085.6', since: '2026-09-14', kind: 'on_hold_line', brInvoiceCodes: ['085.6'], brPartIds: ['c679605d-ec7f-4c2f-9d28-095705841f22'], originUsInvoiceIds: ['39da0374-af2c-4d01-b8bc-9dd6cc1ef5c1'],
    note: '085.6 «kit motor» (US.003.1 Colossus) has no origin in the US app. It is inside the number; if GZ28US does not owe it, it comes out.' },
  { key: 'br-lines-BR.1009.1', since: '2026-09-14', kind: 'br_lines_without_006',
    brExpenseIds: ['8caedd50-0754-483c-b15b-500a543562f1', '5dfe9b67-a4cd-40b5-8ad7-3363262d3b31', 'f49a878a-1790-417c-9a8e-b390eca57c00', '0f8222c1-1b20-4c80-af9c-33ceee5d5cf1'],
    note: 'BR.1009.1 ScatPack NOVO BR: 4 of its 5 lines paid by GZ28US are in no 006.N yet (006.28 carries only 1). If they belong, GZ28BR owes this too.' },
  { key: 'br-lines-eibach', since: '2026-09-14', kind: 'br_lines_without_006',
    brExpenseIds: ['83ae1eb9-1447-4aba-a7c2-262c38e47fcf', '7cd8dcb1-048c-481b-a2e9-292b283a67ea', 'c33f9a33-385a-42c9-87b2-99d6b72b00f2'],
    note: 'Eibach Pro-Kits paid by GZ28US on BR invoices US.004.1, US.005.1 and US.006.2 — in no 006.N yet. If they belong, GZ28BR owes this too.' },
  { key: 'hold-sidney-085.2', since: '2026-09-14', kind: 'on_hold_invoice', brInvoiceCodes: ['085.2'], originUsInvoiceIds: ['982ccd2b-0e1f-49a7-af1d-08239a0d05cc'],
    note: 'US.001.1 GoldenEye (Sidney Penna): his income paid to GZ28BR has no R$ recorded, so it is not deducted from 085.2 yet. Waiting for Márcio on which R$ is right.' },
  // A US.007.1 Panther ainda NÃO tem 085.N (travada no motor): o código que ela vai ganhar só existe quando o Márcio liberar — o
  // 085.21 que o plano de 14/set 01:47 previa foi para uma season do Jeferson na aplicação de 14/set 10:30. Referência por id, nunca por código futuro.
  { key: 'hold-085.1-panther', since: '2026-09-14', kind: 'possible_double_count', brInvoiceCodes: ['085.1'], originUsInvoiceIds: ['15b95131-0e21-4b01-b7bf-504b2448af9f', '828e9c2f-6d48-4beb-aef4-e7f8b9050d82'],
    note: 'US.009.1 Poltergeist → 085.1 × US.007.1 Panther (no 085.N yet): possible double count of the same Poltergeist Pack. On hold.' },
]
export type PendingRef = { side: 'US' | 'BR'; code: string; label: string; href: string; external: boolean; usd: number | null; exists: boolean }
export type PendingDecision = {
  key: string; since: string; kind: PendingKind; note: string
  refs: PendingRef[]
  atStake: number | null                          // US$ em jogo (null = sem valor gravado para decidir)
  position: 'inside' | 'outside' | 'undetermined' // o dinheiro em jogo está DENTRO ou FORA de brOwesUs hoje
  effectIfConfirmed: number | null                // quanto brOwesUs muda se a suspeita se confirmar (com sinal)
}

export type CrossingBalance = {
  generatedAt: string
  brOwesUs: number
  usSide: { clientId: string; invoices: UsInvoice[]; notCounted: UsInvoice[]; totals: { invoices: number; total: number; received: number; open: number } }
  brSide: { clientId: string; invoices: BrInvoice[]; notCounted: BrInvoice[]; totals: { invoices: number; totalBrl: number; totalUsd: number; receivedBrl: number; receivedUsd: number; open: number; convertedByInvoiceRate: number } }
  warnings: CrossingWarning[]
  pending: { decisions: PendingDecision[]; couldLower: number; couldRaise: number; undetermined: number }   // couldLower/couldRaise: quanto brOwesUs pode descer/subir se as suspeitas se confirmarem
}

/** As linhas cruas dos dois bancos — cada lista ORDENADA POR id (a ordem do motor, que faz a soma bater ao centavo). */
export type CrossingRows = {
  readAt: string
  us: { invoices: Row[]; rides: Row[]; items: Row[]; services: Row[]; incomes: Row[] }
  br: { invoices: Row[]; rides: Row[]; parts: Row[]; services: Row[]; payments: Row[] }
  // Só para as DECISÕES PENDENTES (fora da conta): as invoices de origem no US e as linhas do BR em jogo, com as invoices delas.
  pending: { usOrigins: Row[]; brExpenses: Row[]; brExpenseInvoices: Row[] }
}

/** Os ids que a leitura precisa buscar para as decisões pendentes. */
export function pendingIds() {
  const uniq = (a: (string | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))]
  return {
    usOrigins: uniq(PENDING_DECISIONS.flatMap(p => p.originUsInvoiceIds || [])),
    brExpenses: uniq(PENDING_DECISIONS.flatMap(p => p.brExpenseIds || [])),
  }
}
// usdBR() do motor: amount_usd é UNITÁRIO; tax/extra são R$ da linha, convertidos pelo fator da própria linha (price ÷ amount_usd).
function usdBrExpense(e: Row, invoiceRate: unknown): number | null {
  if (!recorded(e.amount_usd)) return null
  const te = num(e.tax) + num(e.extra), au = num(e.amount_usd), p = num(e.price)
  const f = au > 0 && p > 0 ? p / au : num(invoiceRate)
  if (te && !(f > 0)) return null
  return au * qty(e) + (te ? te / f : 0)
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>()
  for (const r of rows) { const k = String(r[key]); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]) }
  return m
}
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, 'en', { numeric: true })
const ownerPath = (inv: Row) => inv.ride_id ? `/rides/${inv.ride_id}/invoices/${inv.id}` : `/clients/${inv.client_id}/invoices/${inv.id}`
const rideLabel = (rides: Map<string, Row>, inv: Row) => {
  const r = inv.ride_id ? rides.get(inv.ride_id) : null
  return r ? [r.project_code, r.project_name].filter(Boolean).join(' — ') : ''
}
// grandTotal() do motor: (base + base × FL% + serviços) − desconto%, somando na ordem das linhas.
function grandTotal(items: Row[], services: Row[], inv: Row) {
  const base = items.reduce((s, i) => s + lineValue(i), 0)
  const serv = services.reduce((s, x) => s + num(x.price), 0)
  const pAndS = base + base * (num(inv.florida_taxes) / 100) + serv
  return { base, serv, grand: pAndS - pAndS * (num(inv.global_discount) / 100) }
}

export function computeCrossingBalance(rows: CrossingRows): CrossingBalance {
  const warnings: CrossingWarning[] = []

  // ════ LADO US: 006.N ════
  const usRides = new Map(rows.us.rides.map(r => [r.id, r]))
  const usAll = rows.us.invoices.filter(i => i.client_id === US_CLIENT_GZ28BR)
  const usIds = new Set(usAll.map(i => i.id))
  const itemsBy = groupBy(rows.us.items.filter(i => usIds.has(i.invoice_id)), 'invoice_id')
  const servBy = groupBy(rows.us.services.filter(s => usIds.has(s.invoice_id)), 'invoice_id')
  const incBy = groupBy(rows.us.incomes.filter(p => usIds.has(p.invoice_id)), 'invoice_id')
  const usRow = (inv: Row): UsInvoice => {
    const items = itemsBy.get(inv.id) || [], serv = servBy.get(inv.id) || [], inc = incBy.get(inv.id) || []
    const g = grandTotal(items, serv, inv)
    const received = inc.filter(p => p.paid_at).reduce((s, p) => s + num(p.amount), 0)
    const pend = inc.filter(p => !p.paid_at)
    const counted = countsOnUsSide(inv)
    return {
      id: inv.id, code: String(inv.invoice_code || '?'), path: ownerPath(inv),
      label: [rideLabel(usRides, inv), String(inv.service || '').trim()].filter(Boolean).join(' · '), status: inv.live_status ?? null,
      counted, reason: counted ? null : inv.is_quote ? 'QUOTE' : 'CAR_INVOICE',   // carro: a régua do motor conta só as 006.N sem ride
      parts: r2(g.base), services: r2(g.serv), flTaxPct: num(inv.florida_taxes), discountPct: num(inv.global_discount),
      total: r2(g.grand), received: r2(received), open: r2(g.grand - received),
      pending: r2(pend.reduce((s, p) => s + num(p.amount), 0)), pendingN: pend.length,
      items: items.map(i => ({ id: i.id, description: String(i.description || ''), unitPrice: num(i.unit_price), quantity: qty(i), usd: r2(lineValue(i)) })),
      serviceLines: serv.map(x => ({ id: x.id, description: String(x.description || ''), usd: r2(num(x.price)) })),
      incomes: inc.map(p => ({ id: p.id, description: String(p.description || ''), usd: r2(num(p.amount)), paidAt: p.paid_at ?? null, paymentDate: p.payment_date ?? null, counted: counted && !!p.paid_at })),
    }
  }
  // Os totais NA ORDEM DO MOTOR: grand por invoice (ordem de id), rendas pela lista global (ordem de id).
  const usCounted = usAll.filter(countsOnUsSide)
  const usCountedIds = new Set(usCounted.map(i => i.id))
  let gU = 0, rU = 0
  for (const inv of usCounted) gU += grandTotal(itemsBy.get(inv.id) || [], servBy.get(inv.id) || [], inv).grand
  for (const p of rows.us.incomes) if (usCountedIds.has(p.invoice_id) && p.paid_at) rU += num(p.amount)
  const usInvoices = usCounted.map(usRow).sort(byCode)
  const usNotCounted = usAll.filter(i => !countsOnUsSide(i)).map(usRow).sort(byCode)
  for (const u of usNotCounted) if (Math.abs(u.total) > 0.004 || Math.abs(u.received) > 0.004) warnings.push({ kind: 'not_counted_with_money', side: 'US', code: u.code, reason: u.reason as NotCountedReason, total: u.total, received: u.received })

  // ════ LADO BR: 085.N ════
  const brRides = new Map(rows.br.rides.map(r => [r.id, r]))
  const brAll = rows.br.invoices.filter(i => i.client_id === BR_CLIENT_GZ28US)
  const brIds = new Set(brAll.map(i => i.id))
  const partsBy = groupBy(rows.br.parts.filter(p => brIds.has(p.invoice_id)), 'invoice_id')
  const bServBy = groupBy(rows.br.services.filter(s => brIds.has(s.invoice_id)), 'invoice_id')
  const payBy = groupBy(rows.br.payments.filter(p => brIds.has(p.invoice_id)), 'invoice_id')
  const partUsd = (p: Row, rate: number) => recorded(p.unit_price_usd) ? num(p.unit_price_usd) * qty(p) : rate > 0 ? lineValue(p) / rate : 0
  const payUsd = (p: Row, rate: number) => recorded(p.amount_usd) ? num(p.amount_usd) : rate > 0 ? num(p.amount) / rate : 0
  const from = (rec: boolean, rate: number): UsdFrom => rec ? 'recorded' : rate > 0 ? 'invoice_usd_rate' : 'none'
  const brRow = (inv: Row): BrInvoice => {
    const rate = num(inv.usd_rate)
    const counted = countsOnBrSide(inv)
    const parts = partsBy.get(inv.id) || [], pays = payBy.get(inv.id) || [], paid = pays.filter(p => p.paid_at)
    // Somas cruas (sem arredondar linha a linha), como o motor; a conversão conta linha sem US$ e renda BAIXADA sem US$.
    const totalUsd = parts.reduce((s, p) => s + partUsd(p, rate), 0)
    const receivedUsd = paid.reduce((s, p) => s + payUsd(p, rate), 0)
    return {
      id: inv.id, code: String(inv.invoice_code || '?'), url: BR_APP_BASE + ownerPath(inv),
      label: [rideLabel(brRides, inv), String(inv.service || '').trim()].filter(Boolean).join(' · '), usdRate: rate > 0 ? rate : null,
      counted, reason: counted ? null : 'QUOTE',
      totalBrl: r2(parts.reduce((s, p) => s + lineValue(p), 0)), totalUsd: r2(totalUsd),
      receivedBrl: r2(paid.reduce((s, p) => s + num(p.amount), 0)), receivedUsd: r2(receivedUsd), open: r2(totalUsd - receivedUsd),
      pendingBrl: r2(pays.filter(p => !p.paid_at).reduce((s, p) => s + num(p.amount), 0)),
      convertedByInvoiceRate: parts.filter(p => !recorded(p.unit_price_usd)).length + paid.filter(p => !recorded(p.amount_usd)).length,
      servicesBrl: r2((bServBy.get(inv.id) || []).reduce((s, x) => s + num(x.price), 0)), flTaxPct: num(inv.florida_taxes), discountPct: num(inv.global_discount),
      lines: parts.map(p => ({ id: p.id, description: String(p.description || ''), brl: r2(lineValue(p)), usd: r2(partUsd(p, rate)), usdFrom: from(recorded(p.unit_price_usd), rate) })),
      payments: pays.map(p => ({ id: p.id, description: String(p.description || ''), brl: r2(num(p.amount)), usd: r2(payUsd(p, rate)), usdFrom: from(recorded(p.amount_usd), rate), paidAt: p.paid_at ?? null, paymentDate: p.payment_date ?? null, counted: counted && !!p.paid_at })),
    }
  }
  // Os totais NA ORDEM DO MOTOR: partes e pagamentos pela lista global (ordem de id).
  const brCounted = brAll.filter(countsOnBrSide)
  const bById = new Map(brCounted.map(i => [i.id, i]))
  let gB = 0, gBu = 0, pB = 0, pBu = 0, conv = 0
  for (const p of rows.br.parts) {
    const inv = bById.get(p.invoice_id); if (!inv) continue
    gB += lineValue(p)
    if (recorded(p.unit_price_usd)) gBu += num(p.unit_price_usd) * qty(p)
    else { conv++; gBu += num(inv.usd_rate) > 0 ? lineValue(p) / num(inv.usd_rate) : 0 }
  }
  for (const p of rows.br.payments) {
    const inv = bById.get(p.invoice_id); if (!inv || !p.paid_at) continue
    pB += num(p.amount)
    if (recorded(p.amount_usd)) pBu += num(p.amount_usd)
    else { conv++; pBu += num(inv.usd_rate) > 0 ? num(p.amount) / num(inv.usd_rate) : 0 }
  }
  const brInvoices = brCounted.map(brRow).sort(byCode)
  const brNotCounted = brAll.filter(i => !countsOnBrSide(i)).map(brRow).sort(byCode)
  for (const b of brNotCounted) if (Math.abs(b.totalUsd) > 0.004 || Math.abs(b.receivedUsd) > 0.004) warnings.push({ kind: 'not_counted_with_money', side: 'BR', code: b.code, reason: 'QUOTE', total: b.totalUsd, received: b.receivedUsd })
  for (const b of brInvoices) {
    // Serviço, FL tax e desconto numa 085.N ficam FORA da régua do motor (só linhas × quantidade) — zero em 14/set; se aparecer, a tela diz.
    if (b.servicesBrl || b.flTaxPct || b.discountPct) warnings.push({ kind: 'br_outside_engine_rule', code: b.code, servicesBrl: b.servicesBrl, flTaxPct: b.flTaxPct, discountPct: b.discountPct })
    const semTaxa = b.lines.filter(l => l.usdFrom === 'none').length + b.payments.filter(p => p.counted && p.usdFrom === 'none').length
    if (semTaxa) warnings.push({ kind: 'br_no_usd', code: b.code, lines: semTaxa })   // sem US$ gravado e sem usd_rate: conta US$ 0,00
  }
  if (conv) warnings.push({ kind: 'br_converted_by_invoice_rate', lines: conv })

  const usOpen = r2(gU - rU), brOpen = r2(gBu - pBu)
  return {
    generatedAt: rows.readAt,
    brOwesUs: r2(usOpen - brOpen),
    usSide: { clientId: US_CLIENT_GZ28BR, invoices: usInvoices, notCounted: usNotCounted, totals: { invoices: usCounted.length, total: r2(gU), received: r2(rU), open: usOpen } },
    brSide: { clientId: BR_CLIENT_GZ28US, invoices: brInvoices, notCounted: brNotCounted, totals: { invoices: brCounted.length, totalBrl: r2(gB), totalUsd: r2(gBu), receivedBrl: r2(pB), receivedUsd: r2(pBu), open: brOpen, convertedByInvoiceRate: conv } },
    warnings,
    pending: computePending(rows, usInvoices, brInvoices),
  }
}

// As decisões pendentes, com o US$ lido das mesmas linhas da conta. Nada daqui mexe em brOwesUs.
function computePending(rows: CrossingRows, usInvoices: UsInvoice[], brInvoices: BrInvoice[]): CrossingBalance['pending'] {
  const usByCode = new Map(usInvoices.map(i => [i.code, i]))
  const brByCode = new Map(brInvoices.map(i => [i.code, i]))
  const origins = new Map(rows.pending.usOrigins.map(i => [i.id, i]))
  const brExp = new Map(rows.pending.brExpenses.map(e => [e.id, e]))
  const brExpInv = new Map(rows.pending.brExpenseInvoices.map(i => [i.id, i]))
  const brPartOf = new Map(brInvoices.flatMap(inv => inv.lines.map(l => [l.id, { inv, line: l }] as const)))
  const originRefs = (ids: string[] = []): PendingRef[] => ids.map(id => {
    const o = origins.get(id)
    return { side: 'US', code: o ? String(o.invoice_code || '?') : '?', label: 'origin in the US app', href: o ? ownerPath(o) : '', external: false, usd: null, exists: !!o }
  })
  const out: PendingDecision[] = []
  for (const def of PENDING_DECISIONS) {
    const base = { key: def.key, since: def.since, kind: def.kind, note: def.note }
    if (def.kind === 'duplicate_in_us') {
      const invs = (def.usInvoiceCodes || []).map(c => usByCode.get(c))
      if (invs.some(i => !i)) continue   // uma das duas saiu da conta: a dúvida acabou
      const refs: PendingRef[] = invs.map(i => ({ side: 'US', code: i!.code, label: i!.label || '(no description)', href: i!.path, external: false, usd: i!.total, exists: true }))
      const atStake = r2(Math.min(...invs.map(i => i!.total)))
      out.push({ ...base, refs, atStake, position: 'inside', effectIfConfirmed: -atStake })
    } else if (def.kind === 'br_lines_without_006') {
      const soltas = (def.brExpenseIds || []).map(id => brExp.get(id)).filter((e): e is Row => !!e && !e.us_expense_id && !e.mirror_src)
      if (!soltas.length) continue       // todas ligadas a uma 006.N (ou apagadas): a dúvida acabou
      const refs: PendingRef[] = soltas.map(e => {
        const inv = brExpInv.get(e.invoice_id)
        const v = usdBrExpense(e, inv?.usd_rate)
        return { side: 'BR', code: inv ? String(inv.invoice_code || '?') : '?', label: String(e.item || '').slice(0, 80), href: inv ? BR_APP_BASE + ownerPath(inv) : '', external: true, usd: v == null ? null : r2(v), exists: true }
      })
      const semValor = refs.some(r => r.usd == null)
      const atStake = r2(refs.reduce((s, r) => s + (r.usd || 0), 0))
      out.push({ ...base, refs, atStake: semValor ? null : atStake, position: 'outside', effectIfConfirmed: semValor ? null : atStake })
    } else if (def.kind === 'on_hold_line') {
      const parts = (def.brPartIds || []).map(id => brPartOf.get(id)).filter((x): x is NonNullable<typeof x> => !!x)
      if (!parts.length) continue        // a linha saiu da 085.N: a dúvida acabou
      const refs: PendingRef[] = [...originRefs(def.originUsInvoiceIds), ...parts.map(({ inv, line }) => ({ side: 'BR' as const, code: inv.code, label: line.description, href: inv.url, external: true, usd: line.usd, exists: true }))]
      const atStake = r2(parts.reduce((s, x) => s + x.line.usd, 0))
      out.push({ ...base, refs, atStake, position: 'inside', effectIfConfirmed: atStake })   // se o US não deve, sai do lado BR: brOwesUs sobe
    } else {
      // on_hold_invoice / possible_double_count: o valor da decisão não está gravado — a tela mostra o aberto das 085.N envolvidas como contexto.
      const refs: PendingRef[] = [...originRefs(def.originUsInvoiceIds), ...(def.brInvoiceCodes || []).map(c => {
        const i = brByCode.get(c)
        return { side: 'BR' as const, code: c, label: i ? i.label || 'open' : 'not created yet', href: i ? i.url : '', external: true, usd: i ? i.open : null, exists: !!i }
      })]
      out.push({ ...base, refs, atStake: null, position: 'undetermined', effectIfConfirmed: null })
    }
  }
  return {
    decisions: out,
    couldLower: r2(out.reduce((s, d) => s + (d.effectIfConfirmed != null && d.effectIfConfirmed < 0 ? -d.effectIfConfirmed : 0), 0)),
    couldRaise: r2(out.reduce((s, d) => s + (d.effectIfConfirmed != null && d.effectIfConfirmed > 0 ? d.effectIfConfirmed : 0), 0)),
    undetermined: out.filter(d => d.effectIfConfirmed == null).length,
  }
}
