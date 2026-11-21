// CONTA-CORRENTE DO CLIENTE (21/11/2026 — Márcio, via CC Sidney; spec docs/SPEC-CAR-DEALS-2026-11-21.md, ADENDO A–F).
// «nos 3 formatos atuais: o nosso, onde damos destino pra cada centavo no nosso controle das invoices; o do Sidney, onde
// as entradas compartilhadas entram só como entradas; e o do Antônio, a planilha de excel dele».
//
// NÃO é um segundo livro: as três versões são três leituras de statement_charges (débitos) + deal_movements /
// deal_allocations (créditos). O saldo é o mesmo nas três, por construção.
//   GZ28        uma linha de crédito por ALOCAÇÃO (carro, código e destino de cada centavo)
//   CLIENT      uma linha por MOVIMENTO; movimento rateado em mais de um carro sai «DEPÓSITO / DEPÓSITO / PAGAMENTO»
//   ACCOUNTANT  a versão do cliente sem as linhas pessoais
// Regra de exibição: na versão do cliente/contador só sai o texto feito para ele (statement_label / statement_note).
// A nota interna do movimento NUNCA sai, e nada cita o exportador como dono ou destino (caso RedHot).
// Crédito = o cliente pagou (movimento CONFIRMED que sai dele), na data em que ELE pagou — mesmo que o dinheiro ainda
// não tenha chegado ao GZ28. Débito sai NEGATIVO, como na planilha do Antônio.

export type StatementView = 'GZ28' | 'CLIENT' | 'ACCOUNTANT'
export const STATEMENT_VIEWS: { key: StatementView; label: string }[] = [
  { key: 'GZ28', label: 'GZ28US (every cent with its destination)' },
  { key: 'CLIENT', label: 'Client' },
  { key: 'ACCOUNTANT', label: 'Accountant (no personal lines)' },
]
export const CLIENT_PARTY = 'SIDNEY'   // a parte «cliente» do livro (o enum nasceu com o primeiro cliente)

export type StatementRow = {
  key: string; kind: 'DEBIT' | 'CREDIT'; date: string; car: string; code: string; item: string
  debit: number | null; credit: number | null; balance: number
  nf: string; brl: number | null; obs: string; personal: boolean; rideId: string | null
}
export type StatementData = { charges: any[]; movements: any[]; allocations: any[]; rides: any[]; deals: any[] }
export type Statement = { rows: StatementRow[]; debit: number; credit: number; balance: number; brl: number; cars: { id: string; name: string }[] }

const cents = (n: number) => Math.round(n * 100) / 100
const txt = (v: unknown) => String(v ?? '').trim()
const DEPOSIT = 'DEPÓSITO'

export function buildStatement(d: StatementData, view: StatementView, opts: { rideId?: string } = {}): Statement {
  const rideById = new Map<string, any>(d.rides.map(r => [r.id, r]))
  const dealById = new Map<string, any>(d.deals.map(x => [x.id, x]))
  // o nome do carro PARA O CLIENTE: o que está na linha, senão rides.statement_name, senão modelo + cor (nunca o apelido)
  const carOf = (rideId: string | null | undefined, override?: string | null) => {
    if (txt(override)) return txt(override)
    const r = rideId ? rideById.get(rideId) : null
    return r ? (txt(r.statement_name) || [r.model, r.color].map(txt).filter(Boolean).join(' ')) : ''
  }
  const dealNo = (dealId: string | null | undefined) => { const x = dealId ? dealById.get(dealId) : null; return x ? `Compra ${txt(x.deal_no).replace(/^compra\s*/i, '')}` : '' }
  const rideOfAlloc = (a: any): string | null => a.ride_id || (a.deal_id ? dealById.get(a.deal_id)?.ride_id : null) || null

  type Raw = Omit<StatementRow, 'balance'> & { pos: number }
  const raw: Raw[] = []
  for (const c of d.charges) {
    raw.push({
      key: `c:${c.id}`, kind: 'DEBIT', date: txt(c.charged_on).slice(0, 10), car: carOf(c.ride_id, c.car_name), code: txt(c.code), item: txt(c.label),
      debit: -Math.abs(Number(c.amount_usd) || 0), credit: null, nf: txt(c.nf_number), brl: c.amount_brl != null ? Number(c.amount_brl) : null, obs: txt(c.note),
      personal: !!c.personal, rideId: c.ride_id || null, pos: c.position ?? 1e6,
    })
  }
  const allocsOf = new Map<string, any[]>()
  for (const a of d.allocations) { if (!allocsOf.has(a.movement_id)) allocsOf.set(a.movement_id, []); allocsOf.get(a.movement_id)!.push(a) }
  for (const m of d.movements) {
    if (m.status !== 'CONFIRMED') continue
    const sign = m.from_party === CLIENT_PARTY ? 1 : m.to_party === CLIENT_PARTY ? -1 : 0
    if (!sign) continue
    const allocs = (allocsOf.get(m.id) || []).slice().sort((a, b) => (a.statement_position ?? 1e6) - (b.statement_position ?? 1e6) || txt(a.created_at).localeCompare(txt(b.created_at)))
    const date = txt(m.occurred_on).slice(0, 10)
    const total = Number(m.amount_usd) || 0
    if (view === 'GZ28') {
      for (const a of allocs) {
        const usd = Number(a.amount_usd) || 0
        const rideId = rideOfAlloc(a)
        const brl = a.amount_brl != null ? Number(a.amount_brl) : m.amount_brl != null && total ? cents(Number(m.amount_brl) * usd / total) : null
        raw.push({
          key: `a:${a.id}`, kind: 'CREDIT', date, car: carOf(rideId, a.car_name) || DEPOSIT, code: txt(a.statement_code) || dealNo(a.deal_id) || DEPOSIT,
          item: txt(a.statement_label) || txt(m.statement_label) || 'PAGAMENTO', debit: null, credit: sign * usd, nf: txt(a.nf_number) || txt(m.nf_number), brl,
          obs: txt(a.statement_note) || txt(m.statement_note), personal: !!m.personal, rideId, pos: a.statement_position ?? m.statement_position ?? 1e6,
        })
      }
    } else {
      const rideIds = [...new Set(allocs.map(rideOfAlloc))]
      const one = allocs.length > 0 && rideIds.length === 1 ? allocs[0] : null
      const rideId = one ? rideIds[0] : null
      raw.push({
        key: `m:${m.id}`, kind: 'CREDIT', date, car: one ? (carOf(rideId, one.car_name) || DEPOSIT) : DEPOSIT, code: one ? (txt(one.statement_code) || dealNo(one.deal_id) || DEPOSIT) : DEPOSIT,
        item: txt(m.statement_label) || (one && allocs.length === 1 ? txt(one.statement_label) : '') || 'PAGAMENTO', debit: null, credit: sign * total, nf: txt(m.nf_number) || (one ? txt(one.nf_number) : ''),
        brl: m.amount_brl != null ? Number(m.amount_brl) : null, obs: txt(m.statement_note), personal: !!m.personal, rideId, pos: m.statement_position ?? 1e6,
      })
    }
  }
  const visible = raw
    .filter(r => view !== 'ACCOUNTANT' || !r.personal)
    .sort((a, b) => a.date.localeCompare(b.date) || a.pos - b.pos || (a.kind === b.kind ? 0 : a.kind === 'DEBIT' ? -1 : 1) || a.key.localeCompare(b.key))
  // o filtro por carro só ESCOLHE linhas; o saldo corrido continua sendo o do conjunto mostrado
  const shown = opts.rideId ? visible.filter(r => r.rideId === opts.rideId) : visible
  let bal = 0, debit = 0, credit = 0, brl = 0
  const rows: StatementRow[] = shown.map(({ pos, ...r }) => {
    bal += (r.debit || 0) + (r.credit || 0); debit += r.debit || 0; credit += r.credit || 0; brl += r.brl || 0
    return { ...r, balance: cents(bal) }
  })
  const cars = [...new Map(visible.filter(r => r.rideId).map(r => [r.rideId!, { id: r.rideId!, name: carOf(r.rideId) || r.car }])).values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, debit: cents(debit), credit: cents(credit), balance: cents(bal), brl: cents(brl), cars }
}
