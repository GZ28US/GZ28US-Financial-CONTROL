// CONTA-CORRENTE DO CLIENTE (21/11/2026 — Márcio, via CC Sidney; spec docs/SPEC-CAR-DEALS-2026-11-21.md, ADENDO + E-bis).
// «nos 3 formatos atuais: o nosso, onde damos destino pra cada centavo no nosso controle das invoices; o do Sidney, onde
// as entradas compartilhadas entram só como entradas; e o do Antônio, a planilha de excel dele».
//
// UM CAMPO PRO INFO (lei de 21/11): a conta-corrente NÃO tem tabela nem coluna própria. É uma LEITURA do que já existe:
//   DÉBITO  = a invoice do cliente (data de contratação, serviço, total faturado pela mesma régua da tela da invoice)
//   CRÉDITO = (a) movimento CONFIRMED do livro que sai do cliente, na data em que ELE pagou — mesmo que o dinheiro
//                 ainda esteja com terceiro; e
//             (b) renda recebida da invoice (invoice_incomes com paid_at) que nenhum movimento do livro cobre.
//             Renda ligada a QUALQUER alocação não conta sozinha: quem a representa é o movimento do cliente.
//   carro   = model + color do ride da invoice;  código = «Compra N» (compra de carro) ou o código da invoice
//   cliente do movimento = o das invoices das suas alocações;  pessoal = invoice de origem PERSONAL
// As três versões:
//   GZ28        uma linha de crédito por DESTINO (cada alocação / cada renda)
//   CLIENT      uma linha por PAGAMENTO; pagamento rateado em mais de um carro sai «DEPÓSITO / DEPÓSITO / PAGAMENTO»
//   ACCOUNTANT  a do cliente sem as linhas pessoais
// O saldo é o mesmo nas três, por construção. Débito sai NEGATIVO, como na planilha do contador.
// Na versão do cliente/contador só sai o texto feito para ele (deal_movements.statement_note); a nota interna nunca sai.

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
  brl: number | null; obs: string; personal: boolean; rideId: string | null; invoiceId: string | null
}
// invoices: [{ id, invoice_code, service, kind, origin, date, grand, ride: {id, model, color}, dealNo }]
// incomes:  [{ id, invoice_id, amount, date, description, amount_brl, paid }]
export type StatementData = { invoices: any[]; incomes: any[]; movements: any[]; allocations: any[]; deals: any[] }
export type Statement = { rows: StatementRow[]; debit: number; credit: number; balance: number; brl: number; cars: { id: string; name: string }[] }

const cents = (n: number) => Math.round(n * 100) / 100
const txt = (v: unknown) => String(v ?? '').trim()
const DEPOSIT = 'DEPÓSITO'

export function buildStatement(d: StatementData, view: StatementView, opts: { rideId?: string } = {}): Statement {
  const invById = new Map<string, any>(d.invoices.map(i => [i.id, i]))
  const incById = new Map<string, any>(d.incomes.map(i => [i.id, i]))
  const dealInvoice = new Map<string, string>(d.deals.map(x => [x.id, x.purchase_invoice_id]))
  const carOf = (inv: any) => inv?.ride ? [inv.ride.model, inv.ride.color].map(txt).filter(Boolean).join(' ') : ''
  const codeOf = (inv: any) => inv ? (inv.dealNo ? `Compra ${txt(inv.dealNo).replace(/^compra\s*/i, '')}` : txt(inv.invoice_code)) : ''
  const isPersonal = (inv: any) => txt(inv?.origin).toUpperCase() === 'PERSONAL'
  // a invoice que uma alocação paga: a da renda ligada, senão a invoice de compra do deal
  const invOfAlloc = (a: any) => invById.get(incById.get(a.invoice_income_id)?.invoice_id) || invById.get(dealInvoice.get(a.deal_id) || '') || null

  type Raw = Omit<StatementRow, 'balance'> & { seq: number }
  const raw: Raw[] = []
  for (const inv of d.invoices) {
    const grand = Number(inv.grand) || 0
    if (!grand) continue
    raw.push({ key: `i:${inv.id}`, kind: 'DEBIT', date: txt(inv.date).slice(0, 10), car: carOf(inv), code: codeOf(inv), item: txt(inv.service) || 'Invoice',
      debit: -Math.abs(grand), credit: null, brl: null, obs: '', personal: isPersonal(inv), rideId: inv.ride?.id || null, invoiceId: inv.id, seq: 0 })
  }
  const allocsOf = new Map<string, any[]>()
  for (const a of d.allocations) { if (!allocsOf.has(a.movement_id)) allocsOf.set(a.movement_id, []); allocsOf.get(a.movement_id)!.push(a) }
  for (const m of d.movements) {
    if (m.status !== 'CONFIRMED') continue
    const sign = m.from_party === CLIENT_PARTY ? 1 : m.to_party === CLIENT_PARTY ? -1 : 0
    if (!sign) continue
    const allocs = (allocsOf.get(m.id) || []).filter(a => invOfAlloc(a)).sort((a, b) => (a.sheet_position ?? 1e6) - (b.sheet_position ?? 1e6) || txt(a.created_at).localeCompare(txt(b.created_at)))
    if (!allocs.length) continue                                    // movimento de outro cliente
    const date = txt(m.occurred_on).slice(0, 10), total = Number(m.amount_usd) || 0
    const mine = allocs.reduce((s, a) => s + (Number(a.amount_usd) || 0), 0)
    const personal = allocs.every(a => isPersonal(invOfAlloc(a)))
    if (view === 'GZ28') {
      for (const a of allocs) {
        const inv = invOfAlloc(a), usd = Number(a.amount_usd) || 0
        raw.push({ key: `a:${a.id}`, kind: 'CREDIT', date, car: carOf(inv) || DEPOSIT, code: codeOf(inv) || DEPOSIT, item: txt(incById.get(a.invoice_income_id)?.description) || 'PAGAMENTO',
          debit: null, credit: sign * usd, brl: m.amount_brl != null && total ? cents(Number(m.amount_brl) * usd / total) : null, obs: txt(m.statement_note),
          personal: isPersonal(inv), rideId: inv?.ride?.id || null, invoiceId: inv?.id || null, seq: 1 })
      }
    } else {
      const rideIds = [...new Set(allocs.map(a => invOfAlloc(a)?.ride?.id || null))]
      const inv = rideIds.length === 1 ? invOfAlloc(allocs[0]) : null
      raw.push({ key: `m:${m.id}`, kind: 'CREDIT', date, car: inv ? (carOf(inv) || DEPOSIT) : DEPOSIT, code: inv && allocs.length === 1 ? (codeOf(inv) || DEPOSIT) : inv ? codeOf(inv) || DEPOSIT : DEPOSIT, item: 'PAGAMENTO',
        debit: null, credit: sign * mine, brl: m.amount_brl != null && total ? cents(Number(m.amount_brl) * mine / total) : null, obs: txt(m.statement_note),
        personal, rideId: inv?.ride?.id || null, invoiceId: inv && allocs.length === 1 ? inv.id : null, seq: 1 })
    }
  }
  // rendas recebidas que o livro não cobre: uma linha cada, nas três versões
  const covered = new Set(d.allocations.map(a => a.invoice_income_id).filter(Boolean))
  for (const inc of d.incomes) {
    if (!inc.paid || covered.has(inc.id)) continue
    const inv = invById.get(inc.invoice_id)
    if (!inv) continue
    raw.push({ key: `r:${inc.id}`, kind: 'CREDIT', date: txt(inc.date).slice(0, 10), car: carOf(inv) || DEPOSIT, code: codeOf(inv) || DEPOSIT,
      item: view === 'GZ28' ? (txt(inc.description) || 'PAGAMENTO') : 'PAGAMENTO', debit: null, credit: Number(inc.amount) || 0,
      brl: inc.amount_brl != null ? Number(inc.amount_brl) : null, obs: '', personal: isPersonal(inv), rideId: inv.ride?.id || null, invoiceId: inv.id, seq: 1 })
  }
  const visible = raw
    .filter(r => view !== 'ACCOUNTANT' || !r.personal)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.key.localeCompare(b.key))
  // o filtro por carro só ESCOLHE linhas; o saldo corrido é o do conjunto mostrado
  const shown = opts.rideId ? visible.filter(r => r.rideId === opts.rideId) : visible
  let bal = 0, debit = 0, credit = 0, brl = 0
  const rows: StatementRow[] = shown.map(({ seq, ...r }) => {
    bal += (r.debit || 0) + (r.credit || 0); debit += r.debit || 0; credit += r.credit || 0; brl += r.brl || 0
    return { ...r, balance: cents(bal) }
  })
  const cars = [...new Map(d.invoices.filter(i => i.ride?.id).map(i => [i.ride.id, { id: i.ride.id, name: carOf(i) || txt(i.ride.project_code) }])).values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, debit: cents(debit), credit: cents(credit), balance: cents(bal), brl: cents(brl), cars }
}
