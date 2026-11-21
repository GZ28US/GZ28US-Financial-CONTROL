// CAR DEALS (21/11/2026 — Márcio, via sessão CC Sidney; spec em docs/SPEC-CAR-DEALS-2026-11-21.md).
// Compra de carro separada das invoices de oficina. Três lados sobre o MESMO livro: Tripa Trading (Tripa & Edison),
// Sidney (Sidney & Antônio) e GZ28US. Regra de ouro: uma movimentação = um dinheiro real, lançado uma vez;
// a ALOCAÇÃO (em qual compra ele cai) é separada da referência fiscal (proforma / contrato de câmbio).

export type Party = 'SIDNEY' | 'TRIPA_TRADING' | 'GZ28US' | 'DEALER'
export const PARTIES: Party[] = ['SIDNEY', 'TRIPA_TRADING', 'GZ28US', 'DEALER']
export const PARTY_LABEL: Record<string, string> = { SIDNEY: 'Sidney', TRIPA_TRADING: 'Tripa Trading', GZ28US: 'GZ28US', DEALER: 'Dealer' }

// As 4 direções do relatório POSIÇÕES pedido pelo Márcio.
export const DIRECTIONS: { key: string; from: Party; to: Party; label: string }[] = [
  { key: 'SIDNEY>TRIPA_TRADING', from: 'SIDNEY', to: 'TRIPA_TRADING', label: 'Sidney → Tripa Trading' },
  { key: 'SIDNEY>GZ28US', from: 'SIDNEY', to: 'GZ28US', label: 'Sidney → GZ28US' },
  { key: 'TRIPA_TRADING>GZ28US', from: 'TRIPA_TRADING', to: 'GZ28US', label: 'Tripa Trading → GZ28US' },
  { key: 'GZ28US>TRIPA_TRADING', from: 'GZ28US', to: 'TRIPA_TRADING', label: 'GZ28US → Tripa Trading' },
]

export const MILESTONES: { kind: string; label: string }[] = [
  { kind: 'PURCHASED', label: 'Purchased' },
  { kind: 'DEALER_PAID', label: 'Dealer paid' },
  { kind: 'TITLE_RECEIVED', label: 'Title received' },
  { kind: 'DELIVERED_MIAMI', label: 'Delivered in Miami' },
  { kind: 'EXPORTED', label: 'Exported' },
  { kind: 'ARRIVED_BR', label: 'Arrived in Brazil' },
  { kind: 'NATIONALIZED', label: 'Nationalized' },
]
export const MILESTONE_LABEL: Record<string, string> = Object.fromEntries(MILESTONES.map(m => [m.kind, m.label]))

// «Compra 15»: o número pode ter sido gravado com ou sem a palavra — a tela mostra sempre uma vez só.
export const dealNumber = (dealNo: string | null | undefined) => String(dealNo || '').replace(/^s*compras*/i, '').trim()
export const dealLabel = (dealNo: string | null | undefined) => { const n = dealNumber(dealNo); return n ? `Compra ${n}` : 'no number' }

// IDENTIFICAÇÃO DO CARRO (Márcio, 21/11/2026): «use sempre o VIN dos carros nesta área como referência PRINCIPAL, também
// mostre o COMPRA XX, e os dados do carro, como: Charger HellCat RedEye JailBreak PlumCrazy». Ordem em toda a área:
// 1º o VIN completo (4 finais em destaque) · 2º COMPRA XX · 3º modelo + versão + edição + cor. O apelido interno
// (Joker, Dracula…) e o US.0xx ficam só como secundário, na visão GZ28.
export const carDescription = (ride: any) => {
  const ed = String(ride?.special_edition || '').trim()
  return [ride?.model, ride?.version, /^none$/i.test(ed) ? '' : ed, ride?.color].map(x => String(x || '').trim()).filter(Boolean).join(' ')
}
export const vinTail = (vin: string | null | undefined) => String(vin || '').trim().slice(-4)
export const carInternal = (ride: any) => [ride?.project_code, ride?.project_name].filter(Boolean).join(' ')
// uma linha só, para listas, selects e PDFs: «VIN 2C3CDZL91MH657802 · Compra 15 · Challenger SRT Hellcat Pitch Black»
export const dealLine = (deal: any) => [deal?.rides?.vin ? `VIN ${deal.rides.vin}` : 'no VIN', dealLabel(deal?.deal_no), carDescription(deal?.rides)].filter(Boolean).join(' · ')

// DOCUMENTOS do deal (21/11/2026): «tudo com comprovante, documento anexo, título» — a prova fica no carro.
export const DOC_KINDS: { kind: string; label: string }[] = [
  { kind: 'TITLE', label: 'Title' },
  { kind: 'BILL_OF_SALE', label: 'Bill of sale' },
  { kind: 'PROFORMA', label: 'Proforma' },
  { kind: 'FX_CONTRACT', label: 'Exchange contract' },
  { kind: 'SWIFT', label: 'SWIFT' },
  { kind: 'PAYMENT_PROOF', label: 'Payment proof' },
  { kind: 'BL', label: 'Bill of lading' },
  { kind: 'EXPORT', label: 'Export papers' },
  { kind: 'OTHER', label: 'Other' },
]
export const DOC_LABEL: Record<string, string> = Object.fromEntries(DOC_KINDS.map(d => [d.kind, d.label]))

export const MOVEMENT_KINDS = ['FX_CONTRACT', 'PIX', 'WIRE', 'ZELLE', 'STRIPE', 'CASH', 'OFFSET']

// UM CAMPO PRO INFO (lei do Márcio, 21/11/2026): o carro e o cliente de um deal NÃO são colunas do deal — vêm da
// invoice de compra. Toda tela busca com DEAL_SELECT e achata com flatDeal, que devolve d.rides / d.ride_id / d.client_id.
export const RIDE_COLS = 'id, project_code, project_name, vin, color, year, brand, model, version, special_edition'
export const DEAL_SELECT = `*, invoices:purchase_invoice_id(id, invoice_code, service, client_id, ride_id, rides(${RIDE_COLS}))`
export const flatDeal = (d: any) => d ? { ...d, rides: d.invoices?.rides || null, ride_id: d.invoices?.ride_id || null, client_id: d.invoices?.client_id || null } : d

// VENCIMENTO de uma obrigação — conta, não coluna: a data dela, ou a data do marco que a dispara + os dias.
// due = já venceu (data ≤ hoje). Sem data e com o marco ainda não feito: «when <marco>».
export function obligationDue(o: any, milestones: any[], today?: string): { date: string | null; due: boolean; label: string } {
  const hoje = today || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  let date: string | null = o.due_date || null
  if (!date && o.trigger_milestone) {
    const ms = milestones.find(m => m.deal_id === o.deal_id && m.kind === o.trigger_milestone && m.done_at)
    if (ms) { const t = new Date(String(ms.done_at).slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + (Number(o.trigger_offset_days) || 0)); date = t.toISOString().slice(0, 10) }
  }
  const due = !!date && date <= hoje
  const label = date ? `${due ? 'DUE ' : ''}${dealDate(date)}`
    : o.trigger_milestone ? `when ${MILESTONE_LABEL[o.trigger_milestone] || o.trigger_milestone}${o.trigger_offset_days ? ` + ${o.trigger_offset_days}d` : ''}` : 'no date'
  return { date, due, label }
}

export type Position = { key: string; label: string; owed: number; paid: number; open: number; next: string | null }

const cents = (n: number) => Math.round(n * 100) / 100

// 2026-11-21 -> 21/11/2026 (data pura, sem fuso: é dia de calendário)
export const dealDate = (d: string | null | undefined) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// AS 4 POSIÇÕES de um deal — cada direção tem UMA fonte, nada é gravado em dobro (lei «uma info, um campo», 21/11/2026):
//   Sidney → GZ28US         rendas ABERTAS da invoice de compra que nenhum movimento do cliente cobre (data = payment_date)
//   Tripa Trading → GZ28US  rendas abertas já cobertas por movimento CONFIRMED Sidney→Tripa Trading (o dinheiro está com eles)
//   GZ28US → Tripa Trading  despesas em aberto da invoice de compra para o fornecedor Tripa
//   Sidney → Tripa Trading  custos do deal (deal_charges) − alocações CONFIRMED Sidney→Tripa Trading no deal = o «Saldo a
//                           pagar» da planilha; a DATA ou CONDIÇÃO vem de deal_obligations (única info que só existe lá)
export type PositionCtx = { charges: any[]; obligations: any[]; movements: any[]; allocations: any[]; milestones: any[]; incomes: any[]; expenses: any[] }
export const POSITION_INCOME_COLS = 'id, invoice_id, amount, payment_date, paid_at, description'
export const POSITION_EXPENSE_COLS = 'id, invoice_id, supplier, price, quantity, tax, extra, payment_date, cancel_status'
const isTripa = (supplier: unknown) => /tripa/i.test(String(supplier || ''))
const expenseValue = (e: any) => (Number(e.price) || 0) * (Number(e.quantity) || 1) + (Number(e.tax) || 0) + (Number(e.extra) || 0)

export function dealPositions(deal: any, ctx: PositionCtx): Position[] {
  const movById = new Map<string, any>(ctx.movements.map(m => [m.id, m]))
  const clientToTripa = (a: any) => { const m = movById.get(a.movement_id); return !!m && m.status === 'CONFIRMED' && m.from_party === 'SIDNEY' && m.to_party === 'TRIPA_TRADING' }
  const fromClient = (a: any) => { const m = movById.get(a.movement_id); return !!m && m.status === 'CONFIRMED' && m.from_party === 'SIDNEY' }
  const sum = (xs: any[], f: (x: any) => number) => xs.reduce((t, x) => t + f(x), 0)
  const inv = deal.purchase_invoice_id
  const incs = inv ? ctx.incomes.filter(i => i.invoice_id === inv) : []
  // quanto de cada renda aberta já foi pago pelo cliente (a nós, ou a terceiro por conta dele)
  let sgOpen = 0, tgOpen = 0, sgNext: string | null = null
  for (const i of incs) {
    if (i.paid_at) continue
    const amount = Number(i.amount) || 0
    const mine = ctx.allocations.filter(a => a.invoice_income_id === i.id)
    const viaTripa = Math.min(amount, sum(mine.filter(clientToTripa), a => Number(a.amount_usd) || 0))
    const covered = Math.min(amount, sum(mine.filter(fromClient), a => Number(a.amount_usd) || 0))
    tgOpen += viaTripa
    const rest = amount - covered
    if (rest > 0.004) { sgOpen += rest; if (i.payment_date && (!sgNext || i.payment_date < sgNext)) sgNext = i.payment_date }
  }
  const sgOwed = sum(incs, i => Number(i.amount) || 0)
  const exps = inv ? ctx.expenses.filter(e => e.invoice_id === inv && isTripa(e.supplier) && !e.cancel_status) : []
  const gtOwed = sum(exps, expenseValue), gtOpen = sum(exps.filter(e => !e.payment_date), expenseValue)
  const stOwed = sum(ctx.charges.filter(c => c.deal_id === deal.id), c => Number(c.amount_usd) || 0)
  const stPaid = sum(ctx.allocations.filter(a => a.deal_id === deal.id && clientToTripa(a)), a => Number(a.amount_usd) || 0)
  const dues = ctx.obligations.filter(o => o.deal_id === deal.id && !o.cancelled && o.from_party === 'SIDNEY' && o.to_party === 'TRIPA_TRADING').map(o => obligationDue(o, ctx.milestones))
  const dated = dues.filter(x => x.date).sort((x, y) => String(x.date).localeCompare(String(y.date)))
  const stNext = dated.length ? dated[0].label : (dues[0]?.label && dues[0].label !== 'no date' ? dues[0].label : null)
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const byKey: Record<string, Omit<Position, 'key' | 'label'>> = {
    'SIDNEY>TRIPA_TRADING': { owed: cents(stOwed), paid: cents(stPaid), open: cents(stOwed - stPaid), next: stNext },
    'SIDNEY>GZ28US': { owed: cents(sgOwed), paid: cents(sgOwed - sgOpen - tgOpen), open: cents(sgOpen), next: sgNext ? `${sgNext <= hoje ? 'DUE ' : ''}${dealDate(sgNext)}` : null },
    'TRIPA_TRADING>GZ28US': { owed: cents(tgOpen), paid: 0, open: cents(tgOpen), next: null },
    'GZ28US>TRIPA_TRADING': { owed: cents(gtOwed), paid: cents(gtOwed - gtOpen), open: cents(gtOpen), next: null },
  }
  return DIRECTIONS.map(d => ({ key: d.key, label: d.label, ...byKey[d.key] }))
}

// Quanto de um movimento ainda não foi alocado.
export function movementUnallocated(movement: any, allocations: any[]): number {
  const sum = allocations.filter(a => a.movement_id === movement.id).reduce((s, a) => s + (Number(a.amount_usd) || 0), 0)
  return cents((Number(movement.amount_usd) || 0) - sum)
}
