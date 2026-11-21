// CONTA-CORRENTE DO CLIENTE (21/11/2026 — Márcio, via CC Sidney; spec docs/SPEC-CAR-DEALS-2026-11-21.md, ADENDO + E-bis).
// «nos 3 formatos atuais: o nosso, onde damos destino pra cada centavo no nosso controle das invoices; o do Sidney, onde
// as entradas compartilhadas entram só como entradas; e o do Antônio, a planilha de excel dele».
//
// UM CAMPO PRO INFO (lei de 21/11): a conta-corrente NÃO tem tabela nem coluna própria. É uma LEITURA do que já existe:
//   DÉBITO  = a invoice do cliente (data de contratação, serviço, total faturado pela mesma régua da tela da invoice)
//   CRÉDITO = cada renda PAGA das invoices do cliente, uma vez (venha de onde vier), mais a renda ainda aberta que
//             um movimento confirmado do cliente já cobriu («pago, ainda não chegou»). Alocação só com deal NÃO entra:
//             é a conta Cliente×Exportador, outro saldo sobre o mesmo dinheiro.
//   carro   = model + color do ride da invoice;  código = «Compra N» (compra de carro) ou o código da invoice
//   pessoal = invoice de origem PERSONAL
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
// thirdParty = o que o cliente já pagou a terceiro por conta de renda que ainda está aberta no app (a receber de terceiros)
export type Statement = { rows: StatementRow[]; debit: number; credit: number; balance: number; brl: number; thirdParty: number; cars: { id: string; name: string }[] }

const cents = (n: number) => Math.round(n * 100) / 100
const txt = (v: unknown) => String(v ?? '').trim()
const DEPOSIT = 'DEPÓSITO'

export function buildStatement(d: StatementData, view: StatementView, opts: { rideId?: string } = {}): Statement {
  const invById = new Map<string, any>(d.invoices.map(i => [i.id, i]))
  const carOf = (inv: any) => inv?.ride ? [inv.ride.model, inv.ride.color].map(txt).filter(Boolean).join(' ') : ''
  const codeOf = (inv: any) => inv ? (inv.dealNo ? `Compra ${txt(inv.dealNo).replace(/^compra\s*/i, '')}` : txt(inv.invoice_code)) : ''
  const isPersonal = (inv: any) => txt(inv?.origin).toUpperCase() === 'PERSONAL'

  type Raw = Omit<StatementRow, 'balance'> & { seq: number }
  const raw: Raw[] = []
  for (const inv of d.invoices) {
    const grand = Number(inv.grand) || 0
    if (!grand) continue
    raw.push({ key: `i:${inv.id}`, kind: 'DEBIT', date: txt(inv.date).slice(0, 10), car: carOf(inv), code: codeOf(inv), item: txt(inv.service) || 'Invoice',
      debit: -Math.abs(grand), credit: null, brl: null, obs: '', personal: isPersonal(inv), rideId: inv.ride?.id || null, invoiceId: inv.id, seq: 0 })
  }
  // CRÉDITO — regra de 21/11 (CC Sidney, depois de conferir contra a planilha): a conta Cliente×GZ28 é feita das RENDAS
  // das invoices do cliente, cada uma UMA vez, venha o dinheiro de onde vier (direto dele, ou por terceiro por conta dele).
  //   1. renda PAGA                                   → crédito do valor da renda
  //   2. renda ABERTA com alocação de movimento CONFIRMED que sai do cliente → «pago pelo cliente, ainda não chegou»:
  //      credita o que o movimento alocou nela e soma no quadro «a receber de terceiros»
  //   3. alocação SÓ com deal (sem renda) NUNCA entra aqui: é dinheiro da conta Cliente×Exportador (planilha Tripa)
  //   4. data = a do movimento do cliente, quando a renda tem um; senão a data de pagamento da renda
  //   5. versão cliente/contador: rendas do MESMO movimento viram uma linha (mais de um carro = DEPÓSITO)
  const movById = new Map<string, any>(d.movements.map(m => [m.id, m]))
  const allocsOfIncome = new Map<string, any[]>()
  for (const al of d.allocations) {
    if (!al.invoice_income_id || movById.get(al.movement_id)?.status !== 'CONFIRMED') continue
    if (!allocsOfIncome.has(al.invoice_income_id)) allocsOfIncome.set(al.invoice_income_id, [])
    allocsOfIncome.get(al.invoice_income_id)!.push(al)
  }
  type Credit = { inc: any; inv: any; amount: number; date: string; mov: any | null; brl: number | null }
  const credits: Credit[] = []
  let thirdParty = 0
  for (const inc of d.incomes) {
    const inv = invById.get(inc.invoice_id)
    if (!inv) continue
    const linked = allocsOfIncome.get(inc.id) || []
    const fromClient = linked.filter(al => movById.get(al.movement_id).from_party === CLIENT_PARTY)
    const clientMov = fromClient.length ? movById.get(fromClient[0].movement_id) : null
    let amount = 0
    if (inc.paid) amount = Number(inc.amount) || 0
    else if (fromClient.length) { amount = Math.min(Number(inc.amount) || 0, fromClient.reduce((t, al) => t + (Number(al.amount_usd) || 0), 0)); thirdParty += amount }
    if (!amount) continue
    const mov = clientMov || (linked.length ? movById.get(linked[0].movement_id) : null)
    const movTotal = Number(clientMov?.amount_usd) || 0
    const brl = inc.amount_brl != null ? Number(inc.amount_brl) : clientMov?.amount_brl != null && movTotal ? cents(Number(clientMov.amount_brl) * amount / movTotal) : null
    credits.push({ inc, inv, amount, date: txt(clientMov?.occurred_on || inc.date).slice(0, 10), mov, brl })
  }
  if (view === 'GZ28') {
    for (const c of credits) raw.push({ key: `r:${c.inc.id}`, kind: 'CREDIT', date: c.date, car: carOf(c.inv) || DEPOSIT, code: codeOf(c.inv) || DEPOSIT, item: txt(c.inc.description) || 'PAGAMENTO',
      debit: null, credit: c.amount, brl: c.brl, obs: txt(c.mov?.statement_note), personal: isPersonal(c.inv), rideId: c.inv.ride?.id || null, invoiceId: c.inv.id, seq: 1 })
  } else {
    const groups = new Map<string, Credit[]>()
    for (const c of credits) { const k = c.mov ? `m:${c.mov.id}` : `r:${c.inc.id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(c) }
    for (const [k, g] of groups) {
      // pessoal e não-pessoal nunca se misturam numa linha (a versão do contador tira só as pessoais)
      for (const part of [g.filter(c => !isPersonal(c.inv)), g.filter(c => isPersonal(c.inv))]) {
        if (!part.length) continue
        const rideIds = [...new Set(part.map(c => c.inv.ride?.id || null))], invIds = [...new Set(part.map(c => c.inv.id))]
        const one = rideIds.length === 1 ? part[0].inv : null
        const anyBrl = part.some(c => c.brl != null)
        raw.push({ key: `${k}${isPersonal(part[0].inv) ? ':p' : ''}`, kind: 'CREDIT', date: part.map(c => c.date).sort()[0], car: one ? (carOf(one) || DEPOSIT) : DEPOSIT,
          code: one ? (invIds.length === 1 ? codeOf(one) || DEPOSIT : DEPOSIT) : DEPOSIT, item: 'PAGAMENTO', debit: null, credit: cents(part.reduce((t, c) => t + c.amount, 0)),
          brl: anyBrl ? cents(part.reduce((t, c) => t + (c.brl || 0), 0)) : null, obs: txt(part[0].mov?.statement_note), personal: isPersonal(part[0].inv),
          rideId: one?.ride?.id || null, invoiceId: invIds.length === 1 ? invIds[0] : null, seq: 1 })
      }
    }
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
  return { rows, debit: cents(debit), credit: cents(credit), balance: cents(bal), brl: cents(brl), thirdParty: cents(thirdParty), cars }
}
