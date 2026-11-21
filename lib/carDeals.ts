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

export const MOVEMENT_KINDS = ['FX_CONTRACT', 'PIX', 'WIRE', 'ZELLE', 'STRIPE', 'CASH', 'OFFSET']

export type Position = { key: string; label: string; owed: number; paid: number; open: number; next: string | null }

const cents = (n: number) => Math.round(n * 100) / 100

// 2026-11-21 -> 21/11/2026 (data pura, sem fuso: é dia de calendário)
export const dealDate = (d: string | null | undefined) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// Posição de UM deal nas 4 direções.
//   devido = soma das obrigações não canceladas daquela direção
//   pago   = soma das alocações, neste deal, de movimentos CONFIRMADOS daquela direção (proposta não conta)
//   aberto = devido − pago
// «next» = a próxima obrigação em aberto: a data, ou a condição (o marco) que a dispara.
export function dealPositions(dealId: string, obligations: any[], movements: any[], allocations: any[]): Position[] {
  const movById = new Map<string, any>(movements.map(m => [m.id, m]))
  return DIRECTIONS.map(d => {
    const obs = obligations.filter(o => o.deal_id === dealId && o.from_party === d.from && o.to_party === d.to && o.status !== 'CANCELLED')
    const owed = obs.reduce((s, o) => s + (Number(o.amount_usd) || 0), 0)
    const paid = allocations.reduce((s, a) => {
      if (a.deal_id !== dealId) return s
      const m = movById.get(a.movement_id)
      if (!m || m.status !== 'CONFIRMED' || m.from_party !== d.from || m.to_party !== d.to) return s
      return s + (Number(a.amount_usd) || 0)
    }, 0)
    const pend = obs.filter(o => o.status !== 'PAID')
    const dated = pend.filter(o => o.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    const cond = pend.find(o => !o.due_date && o.trigger_milestone)
    const next = dated.length
      ? `${dated[0].status === 'DUE' ? 'DUE ' : ''}${dealDate(dated[0].due_date)}`
      : cond ? `when ${MILESTONE_LABEL[cond.trigger_milestone] || cond.trigger_milestone}${cond.trigger_offset_days ? ` + ${cond.trigger_offset_days}d` : ''}` : null
    return { key: d.key, label: d.label, owed: cents(owed), paid: cents(paid), open: cents(owed - paid), next }
  })
}

// Quanto de um movimento ainda não foi alocado.
export function movementUnallocated(movement: any, allocations: any[]): number {
  const sum = allocations.filter(a => a.movement_id === movement.id).reduce((s, a) => s + (Number(a.amount_usd) || 0), 0)
  return cents((Number(movement.amount_usd) || 0) - sum)
}
