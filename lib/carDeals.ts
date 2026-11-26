// CAR DEALS (21/11/2026 — Márcio, via sessão CC Sidney; spec em docs/SPEC-CAR-DEALS-2026-11-21.md).
// Compra de carro separada das invoices de oficina. Três lados sobre o MESMO livro: Tripa Trading (Tripa & Edison),
// Sidney (Sidney & Antônio) e GZ28US. Regra de ouro: uma movimentação = um dinheiro real, lançado uma vez;
// a ALOCAÇÃO (em qual compra ele cai) é separada da referência fiscal (proforma / contrato de câmbio).

export type Party = 'CLIENT' | 'TRIPA_TRADING' | 'GZ28US' | 'DEALER'
export const PARTIES: Party[] = ['CLIENT', 'TRIPA_TRADING', 'GZ28US', 'DEALER']
// CLIENT = o cliente do deal (o da invoice de compra; senão o do ride) — Márcio, 21/11/2026: «todos os carros que envolvem
// o GZ28 e o Tripa têm que estar nesta área». A parte nasceu «SIDNEY» com o primeiro cliente e foi generalizada.
export const PARTY_LABEL: Record<string, string> = { CLIENT: 'Client', TRIPA_TRADING: 'Tripa Trading', GZ28US: 'GZ28US', DEALER: 'Dealer' }

// As 4 direções do relatório POSIÇÕES pedido pelo Márcio.
export const DIRECTIONS: { key: string; from: Party; to: Party; label: string }[] = [
  { key: 'CLIENT>TRIPA_TRADING', from: 'CLIENT', to: 'TRIPA_TRADING', label: 'Client → Tripa Trading' },
  { key: 'CLIENT>GZ28US', from: 'CLIENT', to: 'GZ28US', label: 'Client → GZ28US' },
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
// «Compra 15» para número; nome próprio («Tripa 041») sai como está
export const dealLabel = (dealNo: string | null | undefined) => { const n = dealNumber(dealNo); return !n ? 'no number' : /^\d/.test(n) ? `Compra ${n}` : n }

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
export const RIDE_COLS = 'id, client_id, project_code, project_name, vin, color, year, brand, model, version, special_edition'
// Carro que o exportador vendeu ao cliente SEM compra do GZ28 não tem invoice de compra: aí (e só aí) o deal aponta
// direto para o ride (car_deals.ride_id). Uma fonte ou a outra, nunca as duas — o banco recusa.
export const DEAL_SELECT = `*, invoices:purchase_invoice_id(id, invoice_code, service, client_id, ride_id, clients(name), rides(${RIDE_COLS})), rides(${RIDE_COLS})`
export const flatDeal = (d: any) => {
  if (!d) return d
  const ride = d.invoices?.rides || d.rides || null
  // carro do PRÓPRIO exportador comprado pelo GZ28: o cliente do deal é a Tripa Trading — o que ela nos manda é pagamento DELA
  const client_is_exporter = /tripa/i.test(String(d.invoices?.clients?.name || ''))
  return { ...d, rides: ride, ride_id: d.invoices?.ride_id || d.ride_id || null, client_id: d.invoices?.client_id || ride?.client_id || null, client_is_exporter }
}

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
//   («invoice de compra» abaixo = a do deal + as de cobrança do mesmo carro e cliente, kind CAR_PURCHASE — withPurchaseInvoices)
//   Client → GZ28US         rendas ABERTAS da invoice de compra que nenhum movimento do cliente cobre (data = payment_date)
//   Tripa Trading → GZ28US  rendas abertas já cobertas por movimento CONFIRMED Sidney→Tripa Trading (o dinheiro está com eles)
//                           + rendas abertas de invoice do MESMO carro cujo cliente é o exportador (frete a reembolsar…)
//   GZ28US → Tripa Trading  despesas em aberto da invoice de compra para o fornecedor Tripa
//   Client → Tripa Trading  Tripa só exportadora: taxas dela + max(0, o que ela nos repassou − o que ele mandou a ela);
//                           Tripa vendedora: custos do deal − o que ele mandou a ela − o aberto em GZ28US → Tripa Trading;
//                           nunca negativo; a DATA ou CONDIÇÃO vem de deal_obligations (única info que só existe lá)
export type PositionCtx = { charges: any[]; obligations: any[]; movements: any[]; allocations: any[]; milestones: any[]; incomes: any[]; expenses: any[]; exporterIncomes?: any[] }

// O que o EXPORTADOR nos deve fora da compra (Márcio 21/11/2026, caso RedHot: «ponha o frete que pagamos pra Genesis, a
// Tripa Trading nos deve 1.5k disso»): rendas ABERTAS de qualquer invoice do MESMO carro cujo cliente é o exportador.
// Nada é copiado — lê-se a renda que já existe. Devolve as rendas com o ride_id da invoice delas.
export async function loadExporterIncomes(db: any, deals: any[]): Promise<any[]> {
  const rideIds = [...new Set(deals.filter(d => d.exporter === 'TRIPA_TRADING').map(d => d.ride_id).filter(Boolean))]
  if (!rideIds.length) return []
  const { data: cls } = await db.from('clients').select('id').ilike('name', '%tripa%')
  const clientIds = (cls || []).map((c: any) => c.id)
  if (!clientIds.length) return []
  const { data: invs } = await db.from('invoices').select('id, ride_id').in('ride_id', rideIds).in('client_id', clientIds).eq('is_quote', false)
  const rideOf = new Map<string, string>((invs || []).map((i: any) => [i.id, i.ride_id]))
  if (!rideOf.size) return []
  const { data: incs } = await db.from('invoice_incomes').select(POSITION_INCOME_COLS).in('invoice_id', [...rideOf.keys()]).is('paid_at', null)
  return (incs || []).map((i: any) => ({ ...i, ride_id: rideOf.get(i.invoice_id) }))
}
// AS INVOICES DE COMPRA DE UM DEAL (25/11/2026, CC Sidney por ordem do Márcio: «uma invoice de cobrança por carro»).
// O saldo em aberto da compra pode sair da invoice de compra para uma invoice de COBRANÇA do mesmo carro (RedHot:
// US.042.2 → US.042.3, as duas kind CAR_PURCHASE). O deal continua apontando para UMA (purchase_invoice_id, a fonte do
// carro e do cliente); para as posições ele lê também as irmãs: kind CAR_PURCHASE, MESMO ride, MESMO cliente, não-quote,
// e que não sejam a invoice de compra de OUTRO deal (carro revendido tem dois deals no mesmo ride). Sem campo novo.
// Devolve os deals com `purchase_invoice_ids` (a principal primeiro); deal sem invoice de compra fica com [].
export async function withPurchaseInvoices(db: any, deals: any[]): Promise<any[]> {
  const main = deals.filter(d => d?.purchase_invoice_id && d.ride_id)
  const rideIds = [...new Set(main.map(d => d.ride_id))]
  let sibs: any[] = [], claimed = new Set<string>()
  if (rideIds.length) {
    const { data } = await db.from('invoices').select('id, ride_id, client_id').in('ride_id', rideIds).eq('kind', 'CAR_PURCHASE').eq('is_quote', false)
    sibs = data || []
    if (sibs.length) {
      const { data: cl } = await db.from('car_deals').select('purchase_invoice_id').in('purchase_invoice_id', sibs.map((s: any) => s.id))
      claimed = new Set((cl || []).map((x: any) => x.purchase_invoice_id))
    }
  }
  return deals.map(d => {
    if (!d) return d
    if (!d.purchase_invoice_id) return { ...d, purchase_invoice_ids: [] }
    const extra = sibs.filter(s => s.ride_id === d.ride_id && s.id !== d.purchase_invoice_id && !claimed.has(s.id) && (s.client_id || null) === (d.invoices?.client_id || null)).map(s => s.id)
    return { ...d, purchase_invoice_ids: [d.purchase_invoice_id, ...extra] }
  })
}
export const dealInvoiceIds = (deal: any): string[] => deal?.purchase_invoice_ids?.length ? deal.purchase_invoice_ids : deal?.purchase_invoice_id ? [deal.purchase_invoice_id] : []

export const POSITION_INCOME_COLS ='id, invoice_id, amount, payment_date, paid_at, description'
export const POSITION_EXPENSE_COLS = 'id, invoice_id, supplier, price, quantity, tax, extra, payment_date, cancel_status'
const isTripa = (supplier: unknown) => /tripa/i.test(String(supplier || ''))
const expenseValue = (e: any) => (Number(e.price) || 0) * (Number(e.quantity) || 1) + (Number(e.tax) || 0) + (Number(e.extra) || 0)

export function dealPositions(deal: any, ctx: PositionCtx): Position[] {
  const movById = new Map<string, any>(ctx.movements.map(m => [m.id, m]))
  const clientToTripa = (a: any) => { const m = movById.get(a.movement_id); return !!m && m.status === 'CONFIRMED' && m.from_party === 'CLIENT' && m.to_party === 'TRIPA_TRADING' }
  const own = !!deal.client_is_exporter
  const fromClient = (a: any) => { const m = movById.get(a.movement_id); return !!m && m.status === 'CONFIRMED' && (m.from_party === 'CLIENT' || (own && m.from_party === 'TRIPA_TRADING')) }
  const sum = (xs: any[], f: (x: any) => number) => xs.reduce((t, x) => t + f(x), 0)
  // a invoice de compra + as de cobrança do mesmo carro (withPurchaseInvoices)
  const invs = new Set(dealInvoiceIds(deal))
  const incs = ctx.incomes.filter(i => invs.has(i.invoice_id))
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
  const exps = ctx.expenses.filter(e => invs.has(e.invoice_id) && isTripa(e.supplier) && !e.cancel_status)
  const gtOwed = sum(exps, expenseValue), gtOpen = sum(exps.filter(e => !e.payment_date), expenseValue)
  // SIDNEY → TRIPA TRADING — segue o DINHEIRO, não a planilha (CC Sidney, 21/11, depois de ler os grupos e o extrato):
  //   (a) a Tripa é só o canal/exportador (a invoice de compra NÃO tem despesa para a Tripa): o carro é comprado pelo
  //       GZ28 e pago a nós, então ele deve à Tripa só as TAXAS dela (custos de position > 0; a position 0 é o carro)
  //       + o que ela já nos repassou por conta dele − o que ele já mandou a ela.
  //   (b) a Tripa é a VENDEDORA (há despesa para a Tripa na invoice de compra, caso RedHot — ou o deal nem tem invoice de
//       compra do GZ28, Compras 12/23/24): todos os custos − o que
  //       ele já mandou a ela − o que ainda vai passar por nós (GZ28US → Tripa Trading).
  const tripaToGz = (a: any) => { const m = movById.get(a.movement_id); return !!m && m.status === 'CONFIRMED' && m.from_party === 'TRIPA_TRADING' && m.to_party === 'GZ28US' }
  const myCharges = ctx.charges.filter(c => c.deal_id === deal.id)
  const seller = exps.length > 0 || !deal.purchase_invoice_id   // sem compra do GZ28, o exportador é o vendedor
  const stPaid = sum(ctx.allocations.filter(a => a.deal_id === deal.id && clientToTripa(a)), a => Number(a.amount_usd) || 0)
  const advanced = seller ? 0 : sum(ctx.allocations.filter(a => a.deal_id === deal.id && tripaToGz(a)), a => Number(a.amount_usd) || 0)
  const stOwed = sum(seller ? myCharges : myCharges.filter(c => (Number(c.position) || 0) > 0), c => Number(c.amount_usd) || 0) + advanced
  const dues = ctx.obligations.filter(o => o.deal_id === deal.id && !o.cancelled && o.from_party === 'CLIENT' && o.to_party === 'TRIPA_TRADING').map(o => obligationDue(o, ctx.milestones))
  const dated = dues.filter(x => x.date).sort((x, y) => String(x.date).localeCompare(String(y.date)))
  // frete e afins: o exportador é o CLIENTE de outra invoice do mesmo carro
  // (quando o cliente do deal é a própria Tripa, as rendas da invoice de compra já estão em Client → GZ28US)
  // o «paid» do cliente desconta só o dinheiro DELE parado na Tripa — o frete que a Tripa nos deve não é pagamento dele a menos
  const tgFromClient = tgOpen
  tgOpen += sum((ctx.exporterIncomes || []).filter(i => deal.ride_id && i.ride_id === deal.ride_id && !(own && invs.has(i.invoice_id))), i => Number(i.amount) || 0)
  // exportadora: o piso é POR TERMO — quando a Tripa ainda SEGURA dinheiro dele (repassou menos do que recebeu), esse
  // saldo já aparece em Tripa Trading → GZ28US e não pode abater as taxas (Compra 25: taxas 14.000 continuam 14.000).
  const stOpen = own ? 0 : seller ? Math.max(0, stOwed - stPaid - gtOpen) : (stOwed - advanced) + Math.max(0, advanced - stPaid)
  const stNext = dated.length ? dated[0].label : (dues[0]?.label && dues[0].label !== 'no date' ? dues[0].label : null)
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const byKey: Record<string, Omit<Position, 'key' | 'label'>> = {
    'CLIENT>TRIPA_TRADING': { owed: cents(stOwed), paid: cents(stPaid), open: cents(stOpen), next: stNext },
    'CLIENT>GZ28US': { owed: cents(sgOwed), paid: cents(sgOwed - sgOpen - tgFromClient), open: cents(sgOpen), next: sgNext ? `${sgNext <= hoje ? 'DUE ' : ''}${dealDate(sgNext)}` : null },
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
