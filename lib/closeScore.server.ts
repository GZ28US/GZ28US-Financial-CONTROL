// SERVER-ONLY — O PLACAR DO FECHAMENTO DO MÊS (João, 10/set/2026 — a meta: DRE, DFC e Balanço perfeitos)
//
// Um mês só fecha quando o dinheiro dele está provado dos dois lados. O placar diz, mês a mês — da primeira linha da
// Regions (nov/2025) até o mês corrente de Orlando —, quanto falta para cada mês poder fechar. SÓ LEITURA: não casa, não
// cria, não apaga, não chama o Plaid. Quem REGISTRA é o AUTO-BOOK do Márcio (robô de e-mail); o AUTO-LINK (motor do Bank
// Link) só casa e audita; o Data Checker mostra a prova e pergunta. O placar só conta.
//   · BANCO — pela data POSTADA (bank_transactions.date; pendente e REMOVED ficam fora): quanto saiu e entrou, e quanto disso
//     tem dono (MATCHED / TRANSFER / IGNORED) contra sem dono (NEW / QUEUED). Linha casada com registro que não existe mais
//     conta como sem dono (ELO MORTO).
//   · BALDE — a compra que caiu em «A ATRIBUIR» tem linha casada, mas o dinheiro ainda não tem carro, estoque ou custo fixo:
//     conta no mês da LINHA do banco.
//   · APP — pago pela GZ28US (whoPaid, payment_date) sem nenhuma linha viva da Regions atrás, pela régua do «tomado» do
//     candidatePool (matched_table/matched_id, purchase_group, bank_transaction_id, bank:<id>); e recebimento que entrou na
//     GZ28US (paid_at, a data do DFC) sem linha. Os últimos 5 dias antes da última linha postada não se julgam (o banco posta
//     em 1–5 dias). Quando a Regions tem linha ABERTA que explica o registro (mesmo valor; wire com a taxa; soma de registros
//     do mesmo dia) é casamento faltando — o mesmo dinheiro da linha sem dono: o placar mostra à parte e não soma duas vezes.
//   · EXTRATO — a âncora MANUAL de cash_balances (saldo do extrato lançado em LEDGERS) tem de bater ao centavo com o saldo
//     anterior − Σ linhas do período. Sem o Plaid, é a única prova de que o feed trouxe TODAS as linhas do mês.
// O «caixa bate» AO VIVO não é recalculado aqui: /api/plaid/balance chama o Plaid e GRAVA cash_balances (é o card cash-match
// do Data Checker). Quem sabe que ele está verde passa `liveProofUntil`.
// A conta corrente GZ28BR (brAccount) também não: lib/financials.ts é 'use client' (e cria o cliente anon do navegador) — uma
// rota do App Router que importa esse arquivo recebe referência de cliente, não a função. Enquanto a régua não morar num
// módulo neutro, o placar devolve null e a conta segue no card «Conta corrente GZ28BR» do Data Checker e no Balanço.
// Erro de leitura NÃO é engolido: só tabela opcional ausente (migration) vira null.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchAll, num, expensesRows, BUCKET_ORIGIN, BUCKET_CODE } from './bankReconcile.server'

export type AuditRef = { table: string; id: string; label: string; href?: string | null }
export type AuditItem = { key: string; kind: string; title: string; amount: number; date: string | null; refs: AuditRef[]; evidence: string }
export type MonthStatus = 'FECHAVEL' | 'QUASE' | 'ABERTO'

// Doutrina do placar — números conservadores de propósito (FECHÁVEL só com tudo zerado e o extrato provando o mês).
export const CLOSE_RULES = {
  REGIONS_OPENED: '2025-11-10',   // a conta abriu com $0 (rota ?matched=1 do Bank Link; REGIONS_OPENED do Data Checker)
  FIRST_MONTH: '2025-11',
  FEED_LAG_DAYS: 5,               // ausência no banco só se julga até a última linha postada − 5 d
  OPEN_LINE_DAYS: 15,             // linha aberta que explica o registro: até 15 d (a janela do enginesAudit)
  SAME_DAY_SUM_DAYS: 3,           // soma de registros de fornecedores diferentes no mesmo dia: só até 3 d e só valor exato
  WIRE_FEE_MAX: 60,               // wire: o registro traz a taxa, a linha não (a régua do match_wire)
  CENT: 0.011,
  DAY_SUM_TOLERANCE: 0.02,
  STMT_TOLERANCE: 0.01,           // extrato bate ao centavo
  QUASE_MAX_USD: 500,             // QUASE = mês completo, extrato sem quebra, até $500 e até 10 pendências
  QUASE_MAX_ITEMS: 10,
} as const
// Métodos que por definição não passam na Regions (crédito de loja, meio brasileiro). CASH NÃO entra: é o padrão do
// formulário (components/PaymentFields.tsx defaultPayment / paymentFromRow) e há wire de carro gravado como CASH.
const NON_BANK_METHODS = new Set(['TEMU CREDIT', 'PIX'])
const BR_PAID = new Set(['GZ28BR'])   // a régua brPaid do candidatePool: nunca passa na Regions — sócio e cliente saíram do vocabulário em 11/set
const OWNED = new Set(['MATCHED', 'TRANSFER', 'IGNORED'])

// QUEM PAGOU — CÓPIA LITERAL de whoPaid (lib/financials.ts, FIN 0.15.0). Copiada, não importada, porque lib/financials.ts é
// 'use client'. Mexeu lá, mexe aqui: o teste do placar compara as duas em todas as linhas de produção.
// São dois pagadores desde 11/set (CLIENT, RAFA, BETO e HERALDO saíram do app US; nenhuma linha os usava).
const PAYERS = ['GZ28US', 'GZ28BR']
export function whoPaidCopy(r: { paid_from?: string | null; source?: string | null }): string | null {
  const norm = (v: unknown) => { const s = String(v || '').trim().toUpperCase(); if (!s) return null; if (s === 'REGIONS') return 'GZ28US'; return PAYERS.includes(s) ? s : null }
  return norm(r.paid_from) || norm(r.source)
}

const r2 = (v: number) => Math.round(v * 100) / 100 || 0   // «|| 0» tira o -0
const day = (s: unknown) => String(s ?? '').slice(0, 10)
const okDay = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(day(s))
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(day(a)) - Date.parse(day(b))) / 864e5))
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10)
const nextMonth = (m: string) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}` }
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
export const monthLabel = (m: string) => MES[Number(m.slice(5, 7)) - 1] + '/' + m.slice(0, 4)
const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cut = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const expLine = (r: any) => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra)   // a conta do app inteiro (lib/financials expLine)
const qtyLine = (r: any) => num(r.unit_price) * (num(r.quantity) || 1)
const isWire = (b: any) => /WIRE/i.test(String(b.merchant || '') + ' ' + String(b.name || ''))
const bankName = (b: any) => cut(b.merchant || b.name, 50)
const absAmt = (b: any) => Math.abs(num(b.amount))
const normKey = (s: unknown) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)
// Hoje em Orlando, calculado pela máquina (lei O RELÓGIO): o fuso segue o sujeito — a GZ28US.
export const todayOrlando = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

// ── QUAL LINHA ABERTA EXPLICA ESTE REGISTRO? — só para CLASSIFICAR (nada é gravado). Uma linha serve a um registro (ou a um
// grupo) só, o mais perto primeiro:
//   1) 1:1 — mesmo valor (±$0,01) ou wire com a taxa (até $60) no registro, ±15 d;
//   2) soma → uma linha — registros do mesmo fornecedor no mesmo dia (±15 d, wire vale), ou do mesmo dia (±3 d, só exato);
//   3) soma do dia — os registros sem linha de um dia somam exatamente as linhas abertas daquele dia (dois wires pagando duas notas).
export type Want = { key: string; amount: number; date: string; group: string }
export type Pairing = { lines: any[]; fee: number; how: 'EXATA' | 'WIRE' | 'SOMA' | 'SOMA DO DIA'; n: number; sum: number }
export function pairOpenLines(wants: Want[], pool: any[]): Map<string, Pairing> {
  const R = CLOSE_RULES
  const res = new Map<string, Pairing>()
  const free = new Set(pool.map(b => String(b.id)))
  const fit = (amount: number, b: any): number | null => { const diff = r2(amount - absAmt(b)); if (Math.abs(diff) < R.CENT) return 0; return isWire(b) && diff > 0 && diff <= R.WIRE_FEE_MAX ? diff : null }
  const pairs: { w: Want; b: any; fee: number; score: number }[] = []
  for (const w of wants) for (const b of pool) {
    const dd = dayDiff(b.date, w.date); if (dd > R.OPEN_LINE_DAYS) continue
    const fee = fit(w.amount, b); if (fee === null) continue
    pairs.push({ w, b, fee, score: (fee ? 100 : 0) + dd })
  }
  pairs.sort((x, y) => x.score - y.score || y.w.amount - x.w.amount || x.w.key.localeCompare(y.w.key) || String(x.b.id).localeCompare(String(y.b.id)))
  for (const p of pairs) {
    if (res.has(p.w.key) || !free.has(String(p.b.id))) continue
    res.set(p.w.key, { lines: [p.b], fee: p.fee, how: p.fee ? 'WIRE' : 'EXATA', n: 1, sum: r2(p.w.amount) })
    free.delete(String(p.b.id))
  }
  const groupsOf = (keyOf: (w: Want) => string) => {
    const m = new Map<string, Want[]>()
    for (const w of wants) { if (res.has(w.key)) continue; const k = keyOf(w); if (!k) continue; const g = m.get(k); if (g) g.push(w); else m.set(k, [w]) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]).filter(g => g.length >= 2)
  }
  const passes: [(w: Want) => string, number, boolean][] = [[w => (w.group ? w.date + '|' + w.group : ''), R.OPEN_LINE_DAYS, true], [w => w.date, R.SAME_DAY_SUM_DAYS, false]]
  for (const [keyOf, maxDays, wireOk] of passes) {
    for (const g of groupsOf(keyOf)) {
      if (g.some(w => res.has(w.key))) continue
      const sum = r2(g.reduce((s, w) => s + w.amount, 0))
      let best: { b: any; fee: number; score: number } | null = null
      for (const b of pool) {
        if (!free.has(String(b.id))) continue
        const dd = dayDiff(b.date, g[0].date); if (dd > maxDays) continue
        const fee = fit(sum, b); if (fee === null || (fee && !wireOk)) continue
        const score = (fee ? 100 : 0) + dd
        if (!best || score < best.score) best = { b, fee, score }
      }
      if (best) { for (const w of g) res.set(w.key, { lines: [best.b], fee: best.fee, how: 'SOMA', n: g.length, sum }); free.delete(String(best.b.id)) }
    }
  }
  const byDay = new Map<string, Want[]>()
  for (const w of wants) if (!res.has(w.key)) { const g = byDay.get(w.date); if (g) g.push(w); else byDay.set(w.date, [w]) }
  for (const [date, g] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = pool.filter(b => free.has(String(b.id)) && day(b.date) === date)
    if (!lines.length || (g.length < 2 && lines.length < 2)) continue
    const sumW = r2(g.reduce((s, w) => s + w.amount, 0)), sumL = r2(lines.reduce((s, b) => s + absAmt(b), 0))
    if (Math.abs(sumW - sumL) > R.DAY_SUM_TOLERANCE) continue
    for (const w of g) res.set(w.key, { lines, fee: 0, how: 'SOMA DO DIA', n: g.length, sum: sumW })
    for (const b of lines) free.delete(String(b.id))
  }
  return res
}

export type StatementTie = { account: string; opening: string; closing: string; open_balance: number | null; close_balance: number; lines: number; pending: number; diff: number | null }
export type CloseMonth = {
  month: string                          // YYYY-MM
  label: string                          // «ago/2026»
  era: 'EXTRATO' | 'PLAID' | 'MISTO' | 'SEM LINHAS'   // de onde vieram as linhas: extrato importado (plaid_id stmt:) ou feed do Plaid
  complete: boolean                      // o feed já passou do fim do mês + 5 d (mês julgável)
  lines: number
  bank_out: number; bank_in: number      // linhas postadas, data do banco
  linked_out: number; linked_in: number
  unlinked_out: number; unlinked_in: number; unlinked_n: number   // NEW/QUEUED + elo morto
  linked_pct_out: number | null; linked_pct_in: number | null      // % em dólar (null = sem movimento)
  dead_links: number; dead_links_n: number                         // já dentro de unlinked_*
  bucket_open: number; bucket_open_n: number                       // balde A ATRIBUIR pelo mês da linha do banco
  paid_no_bank: number; paid_no_bank_n: number                     // pago pela GZ28US, nenhuma linha viva aponta — TOTAL
  paid_line_open: number; paid_line_open_n: number                 // …dos quais uma linha ABERTA explica (casamento faltando: o mesmo dinheiro de unlinked_out)
  received_no_bank: number; received_no_bank_n: number             // recebido na GZ28US sem linha — TOTAL
  received_line_open: number; received_line_open_n: number         // …dos quais uma entrada aberta explica
  blind_no_bank: number; blind_no_bank_n: number                   // pago sem pagador nenhum e sem linha (o DFC conta como Regions): trava o mês; a pergunta é do card «Quem pagou esta conta?»
  statement: StatementTie | null                                   // extrato cujo fechamento cai neste mês
  bank_proof: 'EXTRATO' | 'AO VIVO' | null                          // a soma das linhas está provada até o fim do mês?
  findings: number; findings_n: number                             // preenchido pelo integrador (outras auditorias)
  open_usd: number; open_items: number
  status: MonthStatus
  reasons: string[]
}
export type CloseScore = {
  items: AuditItem[]
  summary: Record<string, number | string>
  months: CloseMonth[]
  global: {
    today: string; month_now: string
    feed_until: string | null; judge_until: string | null; proven_until: string | null
    pending: { n: number; out: number; in: number }
    open_lines: { n: number; n_out: number; out: number; n_in: number; in: number; statement_era_n: number; plaid_era_n: number }
    statements: StatementTie[]
    skipped: Record<string, { n: number; usd: number }>
    findings_skipped_as_counted: number
    br_account: null; br_account_reason: string
    cash_match: null; cash_match_reason: string
  }
}
export type CloseData = {
  today: string
  bank: any[]; accounts: any[]
  invoiceExpenses: any[]; fixedExpenses: any[]; expenses: any[]; goods: any[]; goodExpenses: any[]; inputs: any[]; inventory: any[]
  payments: any[]; invoices: any[]; fixedSuppliers: any[]
  cashBalances: any[] | null; financingEvents: any[] | null; capitalEvents: any[] | null
}
export type CloseOpts = {
  findings?: AuditItem[]                 // itens das outras auditorias (duplicatas, wires, pagador, desconto) — somam por mês, sem contar duas vezes o que o placar já conta
  liveProofUntil?: string | null         // o card cash-match está verde até esta data (Plaid ao vivo × extrato + linhas): prova os meses sem extrato
  dismissed?: Set<string>                // chaves de item (paid_no_bank|tabela:id, received_no_bank|invoice_incomes:id) marcadas VISTO no card do dinheiro sem linha: saem do placar
  // Item por registro que uma linha ABERTA explica (paid_line_open / received_line_open). Desligado por padrão, a doutrina do
  // enginesAudit (booked_no_bank): a pergunta é da linha do banco, no card Conciliação bancária — listar aqui seria a mesma
  // pendência duas vezes. Os meses e o summary contam de qualquer jeito.
  lineOpenItems?: boolean
}

// ── STATUS — explícito e conservador ──
//   FECHÁVEL: mês completo, soma do banco provada (extrato ou cash-match), e ZERO em tudo: linha sem dono, balde, pago sem
//             banco (com ou sem linha aberta), pago sem pagador e sem linha, recebido sem banco, findings, quebra de extrato.
//   QUASE:    mês completo, sem quebra de extrato, até $500 em aberto e até 10 pendências (sem prova do extrato o melhor é QUASE).
//   ABERTO:   o resto — inclusive o mês que ainda corre.
// open_usd = sem dono (saída+entrada) + balde + pago sem banco SEM linha aberta + pago sem pagador e sem linha + recebido sem banco
//            SEM linha aberta + findings + |quebra do extrato|. O que uma linha aberta explica é o mesmo dinheiro da linha sem dono: não
//            soma de novo. Soma BRUTA (saída e entrada sem compensar): pendência, não saldo.
export function monthStatus(m: CloseMonth, feedUntil: string | null): { status: MonthStatus; reasons: string[]; open_usd: number; open_items: number } {
  const reasons: string[] = []
  const stmtBreak = !!m.statement && m.statement.diff != null && Math.abs(m.statement.diff) > CLOSE_RULES.STMT_TOLERANCE
  const paidNoLine = r2(m.paid_no_bank - m.paid_line_open), paidNoLineN = m.paid_no_bank_n - m.paid_line_open_n
  const recNoLine = r2(m.received_no_bank - m.received_line_open), recNoLineN = m.received_no_bank_n - m.received_line_open_n
  const open_usd = r2(m.unlinked_out + m.unlinked_in + m.bucket_open + paidNoLine + m.blind_no_bank + recNoLine + m.findings + (stmtBreak ? Math.abs(m.statement!.diff!) : 0))
  const open_items = m.unlinked_n + m.bucket_open_n + paidNoLineN + m.blind_no_bank_n + recNoLineN + m.findings_n + (stmtBreak ? 1 : 0)
  if (!m.complete) reasons.push(`mês ainda não julgável: o feed vai até ${feedUntil || '—'} e o mês só se julga 5 dias depois do fim`)
  if (stmtBreak) reasons.push(`extrato de ${m.statement!.closing} não bate com as linhas: diferença ${usd(m.statement!.diff!)}`)
  if (!m.bank_proof) reasons.push('sem extrato lançado cobrindo o mês inteiro (âncora MANUAL em LEDGERS) nem cash-match verde: a soma das linhas não está provada')
  if (m.unlinked_n) reasons.push(`${m.unlinked_n} linha(s) da Regions sem dono: saídas ${usd(m.unlinked_out)} · entradas ${usd(m.unlinked_in)}${m.dead_links_n ? ` (${m.dead_links_n} com elo morto)` : ''}`)
  if (m.bucket_open_n) reasons.push(`${m.bucket_open_n} compra(s) no balde A ATRIBUIR: ${usd(m.bucket_open)}`)
  if (paidNoLineN) reasons.push(`${paidNoLineN} pagamento(s) da GZ28US sem linha nenhuma na Regions: ${usd(paidNoLine)}`)
  if (m.blind_no_bank_n) reasons.push(`${m.blind_no_bank_n} pagamento(s) sem pagador nenhum e sem linha na Regions (o DFC conta como Regions): ${usd(m.blind_no_bank)} — card «Quem pagou esta conta?»`)
  if (m.paid_line_open_n) reasons.push(`${m.paid_line_open_n} pagamento(s) que uma linha aberta explica — falta casar: ${usd(m.paid_line_open)}`)
  if (recNoLineN) reasons.push(`${recNoLineN} recebimento(s) sem entrada na Regions: ${usd(recNoLine)}`)
  if (m.received_line_open_n) reasons.push(`${m.received_line_open_n} recebimento(s) que uma entrada aberta explica — falta casar: ${usd(m.received_line_open)}`)
  if (m.findings_n) reasons.push(`${m.findings_n} achado(s) das outras auditorias: ${usd(m.findings)}`)
  const zero = open_items === 0 && m.paid_line_open_n === 0 && m.received_line_open_n === 0 && open_usd === 0
  const status: MonthStatus = m.complete && !!m.bank_proof && zero ? 'FECHAVEL'
    : m.complete && !stmtBreak && open_usd <= CLOSE_RULES.QUASE_MAX_USD && open_items <= CLOSE_RULES.QUASE_MAX_ITEMS ? 'QUASE' : 'ABERTO'
  return { status, reasons, open_usd, open_items }
}

// Soma por mês (YYYY-MM da data do item) os achados das outras auditorias. Não deduplica: para não contar duas vezes o que o
// placar já conta, passe os itens em closeScore(db, { findings }) — lá o placar tem as linhas e os registros na mão.
export function findingsByMonth(items: { amount: number; date: string | null }[]): Record<string, { usd: number; n: number }> {
  const out: Record<string, { usd: number; n: number }> = {}
  for (const it of items || []) {
    if (!it || !(num(it.amount) > 0) || !okDay(it.date)) continue
    const m = day(it.date).slice(0, 7)
    out[m] = out[m] || { usd: 0, n: 0 }
    out[m].usd = r2(out[m].usd + num(it.amount)); out[m].n++
  }
  return out
}
// Recalcula status e totais com os achados já somados por mês (substitui findings/findings_n de cada mês).
export function withFindings(score: CloseScore, byMonth: Record<string, { usd: number; n: number }>): CloseScore {
  const months = score.months.map(m => { const f = byMonth[m.month] || { usd: 0, n: 0 }; const x = { ...m, findings: r2(f.usd), findings_n: f.n }; return { ...x, ...monthStatus(x, score.global.feed_until) } })
  return { ...score, months, summary: { ...score.summary, ...statusCounts(months) } }
}
const statusCounts = (months: CloseMonth[]) => ({
  months_fechavel: months.filter(m => m.status === 'FECHAVEL').length,
  months_quase: months.filter(m => m.status === 'QUASE').length,
  months_aberto: months.filter(m => m.status === 'ABERTO').length,
  open_usd_total: r2(months.reduce((s, m) => s + m.open_usd, 0)),
})

// ── O CÁLCULO (puro, exportado para teste) ──
export function computeCloseScore(d: CloseData, opts: CloseOpts = {}): CloseScore {
  const R = CLOSE_RULES
  const monthNow = d.today.slice(0, 7)
  const live = d.bank.filter(b => b.match_status !== 'REMOVED')
  const posted = live.filter(b => !b.pending && okDay(b.date))
  const feedUntil = posted.map(b => day(b.date)).sort().pop() || null
  const judgeUntil = feedUntil ? addDays(feedUntil, -R.FEED_LAG_DAYS) : null
  const invById = new Map<string, any>(d.invoices.map(i => [String(i.id), i]))
  const supById = new Map<string, any>(d.fixedSuppliers.map(s => [String(s.id), s]))
  const bucketIds = new Set(d.invoices.filter(i => i.origin === BUCKET_ORIGIN).map(i => String(i.id)))
  const invHref = (invoiceId: unknown) => { const i = invById.get(String(invoiceId)); if (i && i.origin === BUCKET_ORIGIN) return '/adm/bank#a-atribuir'; return i && i.ride_id ? `/rides/${i.ride_id}/invoices/${invoiceId}` : '/adm/reports' }   // a régua do candidatePool
  const invCode = (invoiceId: unknown) => String(invById.get(String(invoiceId))?.invoice_code || '—')
  const realInv = (invoiceId: unknown) => { const i = invById.get(String(invoiceId)); return !!i && !i.is_quote && i.origin !== BUCKET_ORIGIN }

  // ── elos: quem aponta pra quem, e o elo morto (casada com registro que não existe mais) ──
  const idSet = (rows: any[] | null) => rows ? new Set(rows.map(r => String(r.id))) : null
  const exists: Record<string, Set<string> | null> = { invoice_expenses: idSet(d.invoiceExpenses), fixed_cost_expenses: idSet(d.fixedExpenses), staff_expenses: idSet(d.expenses), assets: idSet(d.goods), assets_expenses: idSet(d.goodExpenses), inputs: idSet(d.inputs), inventory: idSet(d.inventory), invoice_incomes: idSet(d.payments), financing_events: idSet(d.financingEvents), capital_events: idSet(d.capitalEvents) }
  const groups = new Set<string>()
  for (const rows of [d.invoiceExpenses, d.goods, d.inputs, d.inventory]) for (const r of rows) if (r.purchase_group) groups.add(String(r.purchase_group))
  const deadWhy = (b: any): string | null => {
    if (b.match_status !== 'MATCHED') return null
    if (!b.matched_id || !b.matched_table) return 'casada sem registro apontado (matched_id vazio)'
    if (b.matched_table === 'purchase_group') return groups.has(String(b.matched_id)) ? null : 'o pedido (purchase_group) apontado não tem mais nenhum item'
    const set = exists[String(b.matched_table)]
    if (!set) return null   // tabela que o placar não lê: não julga
    return set.has(String(b.matched_id)) ? null : `o registro ${b.matched_table} apontado não existe mais`
  }
  const dead = new Map<string, string>()
  const pointed = new Map<string, any>()      // 'tabela:id' | 'purchase_group:<uuid>' → linha casada viva
  const linkedLine = new Map<string, any>()   // id da linha casada viva → linha
  for (const b of live) {
    const why = deadWhy(b)
    if (why) { dead.set(String(b.id), why); continue }
    if (b.match_status === 'MATCHED') { pointed.set(b.matched_table + ':' + b.matched_id, b); linkedLine.set(String(b.id), b) }
  }
  // A régua do «tomado» (candidatePool + enginesAudit.lineOf): ponteiro da linha, grupo casado, elo gravado no registro.
  const lineFor = (table: string, r: any): any => pointed.get(table + ':' + r.id)
    || (r.purchase_group ? pointed.get('purchase_group:' + r.purchase_group) : null)
    || (r.bank_transaction_id ? linkedLine.get(String(r.bank_transaction_id)) : null)
    || (String(r.payment_reference || '').startsWith('bank:') ? linkedLine.get(String(r.payment_reference).slice(5)) : null)
    || (String(r.order_number || '').startsWith('bank:') ? linkedLine.get(String(r.order_number).slice(5)) : null)
    || null
  const ownedLine = (b: any) => OWNED.has(String(b.match_status)) && !dead.has(String(b.id))
  const openOut = posted.filter(b => !ownedLine(b) && num(b.amount) > 0)
  const openIn = posted.filter(b => !ownedLine(b) && num(b.amount) < 0)
  const ownedOut = posted.filter(b => ownedLine(b) && num(b.amount) > 0)
  const ownedIn = posted.filter(b => ownedLine(b) && num(b.amount) < 0)

  // ── acumuladores por mês ──
  const months: string[] = []
  for (let m: string = R.FIRST_MONTH; m <= monthNow; m = nextMonth(m)) months.push(m)
  type Acc = { stmt: number; plaid: number; lines: number; out: number; inn: number; lout: number; lin: number; uout: number; uin: number; un: number; dead: number; deadN: number; bucket: number; bucketN: number; paid: number; paidN: number; paidOpen: number; paidOpenN: number; rec: number; recN: number; recOpen: number; recOpenN: number; blind: number; blindN: number; fnd: number; fndN: number; outs: any[]; ins: any[]; bucketRows: { r: any; line: any; v: number }[] }
  const acc = new Map<string, Acc>()
  for (const m of months) acc.set(m, { stmt: 0, plaid: 0, lines: 0, out: 0, inn: 0, lout: 0, lin: 0, uout: 0, uin: 0, un: 0, dead: 0, deadN: 0, bucket: 0, bucketN: 0, paid: 0, paidN: 0, paidOpen: 0, paidOpenN: 0, rec: 0, recN: 0, recOpen: 0, recOpenN: 0, blind: 0, blindN: 0, fnd: 0, fndN: 0, outs: [], ins: [], bucketRows: [] })
  const items: AuditItem[] = []
  const counted = new Set<string>()   // 'tabela:id' que o placar já conta — achado das outras auditorias sobre eles não soma de novo
  const lineRef = (b: any): AuditRef => ({ table: 'bank_transactions', id: String(b.id), label: `${day(b.date)} · ${usd(absAmt(b))} · ${bankName(b)}`, href: '/adm/bank' })
  const lineTxt = (b: any) => `${day(b.date)} ${usd(absAmt(b))} «${bankName(b)}» (${b.match_status})`

  // ── 1 · BANCO ──
  for (const b of posted) {
    const a = acc.get(day(b.date).slice(0, 7)); if (!a) continue
    const amt = num(b.amount), abs = Math.abs(amt)
    a.lines++; if (String(b.plaid_id || '').startsWith('stmt:')) a.stmt++; else a.plaid++
    const owned = ownedLine(b)
    if (amt > 0) { a.out += amt; if (owned) a.lout += amt } else { a.inn += abs; if (owned) a.lin += abs }
    if (owned) continue
    a.un++; counted.add('bank_transactions:' + b.id)
    if (amt > 0) { a.uout += amt; a.outs.push(b) } else { a.uin += abs; a.ins.push(b) }
    const why = dead.get(String(b.id))
    if (why) {
      a.dead += abs; a.deadN++
      items.push({ key: 'dead_link|bank_transactions:' + b.id, kind: 'dead_link', title: `A linha da Regions de ${day(b.date)} (${usd(abs)} · ${bankName(b)}) está casada com um registro que não existe mais.`, amount: r2(abs), date: day(b.date), refs: [lineRef(b)], evidence: `match_status MATCHED, ${why} (matched_table «${b.matched_table || '—'}», matched_id «${b.matched_id || '—'}»). Para o DFC e o DRE esse dinheiro não tem dono.` })
    }
  }

  // ── 2 · BALDE A ATRIBUIR (mês da linha do banco) ──
  for (const r of d.invoiceExpenses) {
    if (!bucketIds.has(String(r.invoice_id))) continue
    const line = lineFor('invoice_expenses', r)
    const when = line ? day(line.date) : day(r.payment_date || r.expense_date)
    const a = acc.get(when.slice(0, 7)); if (!a) continue
    const v = expLine(r)
    a.bucket += v; a.bucketN++; a.bucketRows.push({ r, line, v })
    counted.add('invoice_expenses:' + r.id)
  }

  const skipped: Record<string, { n: number; usd: number }> = {}
  const skip = (k: string, v: number) => { const s = skipped[k] || (skipped[k] = { n: 0, usd: 0 }); s.n++; s.usd = r2(s.usd + v) }
  // Texto da prova de uma linha aberta que explica o registro (1:1, wire, soma, soma do dia).
  const pairTitle = (pr: Pairing) => pr.how === 'SOMA DO DIA' ? `as ${pr.lines.length} linha(s) aberta(s) de ${day(pr.lines[0].date)} somam este e os outros registros sem linha do dia: falta casar.`
    : pr.how === 'SOMA' ? `a Regions tem a linha de ${day(pr.lines[0].date)} de ${usd(absAmt(pr.lines[0]))} aberta, que soma este e mais ${pr.n - 1} registro(s): falta casar.`
      : `a Regions tem a linha de ${day(pr.lines[0].date)} de ${usd(absAmt(pr.lines[0]))} aberta: falta casar.`
  const pairEvidence = (pr: Pairing, date: string, out: boolean) => pr.how === 'EXATA' ? `Linha aberta de mesmo valor: ${lineTxt(pr.lines[0])}, ${dayDiff(pr.lines[0].date, date)} dia(s) ${out ? 'do pagamento' : 'da baixa'}.`
    : pr.how === 'WIRE' ? `Linha aberta: ${lineTxt(pr.lines[0])} — wire: a diferença de ${usd(pr.fee)} é a taxa.`
      : pr.how === 'SOMA' ? `A linha aberta ${lineTxt(pr.lines[0])} é a soma deste com mais ${pr.n - 1} registro(s) sem linha ${out ? 'do mesmo fornecedor/dia' : 'do mesmo dia'} (${usd(pr.sum)}${pr.fee ? `; wire: ${usd(pr.fee)} de taxa` : ''}).`
        : `As ${pr.lines.length} linha(s) aberta(s) de ${day(pr.lines[0].date)} somam ${usd(pr.sum)} — exatamente os ${pr.n} registro(s) sem linha desse dia: ${pr.lines.slice(0, 3).map(lineTxt).join('; ')}${pr.lines.length > 3 ? '…' : ''}.`
  // Pistas para quem vai decidir o que nenhuma linha aberta explica: gêmeo já casado (duplicata?) e linha parecida.
  const hints = (amount: number, date: string, owned: any[], open: any[], pointedLabel: (b: any) => string) => {
    const twin = owned.find(b => Math.abs(absAmt(b) - amount) < R.CENT && dayDiff(b.date, date) <= R.OPEN_LINE_DAYS)
    const tol = Math.max(1, amount * 0.01)
    const near = open.filter(b => dayDiff(b.date, date) <= R.OPEN_LINE_DAYS && Math.abs(absAmt(b) - amount) <= tol).sort((x, y) => Math.abs(absAmt(x) - amount) - Math.abs(absAmt(y) - amount))[0]
    return [twin ? ` Há uma linha de mesmo valor já casada com outro registro (${lineTxt(twin)} → ${pointedLabel(twin)}): este pode ser duplicata.` : '', near ? ` Linha aberta parecida: ${lineTxt(near)}.` : ''].join('')
  }
  const pointedLabel = (b: any) => `${b.matched_table || '—'}`

  // ── 3 · APP: pago pela GZ28US sem linha viva ──
  type Paid = { key: string; table: string; r: any; amount: number; date: string; label: string; href: string; group: string }
  const paidRows: Paid[] = []
  const P = (table: string, r: any, amount: number, label: string, href: string, group: unknown) => paidRows.push({ key: table + ':' + r.id, table, r, amount, date: day(r.payment_date), label, href, group: normKey(group) })
  for (const r of d.invoiceExpenses) if (realInv(r.invoice_id)) P('invoice_expenses', r, expLine(r), ['EXPENSE', invCode(r.invoice_id), cut(r.item, 60), cut(r.supplier, 30)].filter(Boolean).join(' · '), invHref(r.invoice_id), r.supplier)
  for (const r of d.fixedExpenses) { const s = supById.get(String(r.supplier_id)); const tarifa = s?.cost_type === 'BANK'; P('fixed_cost_expenses', r, num(r.amount), [tarifa ? 'TARIFA' : 'FIXO', cut(s?.company, 30), cut(r.description, 60)].filter(Boolean).join(' · '), tarifa ? '/costs/bank' : r.supplier_id ? '/costs/fixed/' + r.supplier_id : '/costs/fixed', s?.company) }
  for (const r of d.expenses) P('staff_expenses', r, num(r.amount), [r.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA', cut(r.description || r.type, 60)].filter(Boolean).join(' · '), '/staff', '')
  for (const r of d.goods) P('assets', r, qtyLine(r), ['GOODS', cut(r.description, 60), cut(r.supplier, 30)].filter(Boolean).join(' · '), '/goods', r.supplier)
  for (const r of d.goodExpenses) P('assets_expenses', r, num(r.amount), ['GOODS', cut(r.description, 60)].filter(Boolean).join(' · '), '/goods', '')
  for (const r of d.inputs) P('inputs', r, qtyLine(r), ['SUPPLY', cut(r.description, 60), cut(r.supplier, 30)].filter(Boolean).join(' · '), '/supplies', r.supplier)
  for (const r of d.inventory) if (r.source_type === 'PURCHASED') P('inventory', r, qtyLine(r), ['STOCK', cut(r.description, 60), cut(r.supplier, 30)].filter(Boolean).join(' · '), '/inventory', r.supplier)
  const paidOpen: Paid[] = []
  for (const p of paidRows) {
    if (!okDay(p.date)) continue
    const who = whoPaidCopy(p.r)
    const inWindow = p.date >= R.REGIONS_OPENED && !!judgeUntil && p.date <= judgeUntil
    if (who !== 'GZ28US') {
      // Sem pagador nenhum e sem linha: o DFC assume Regions. A pergunta é do card «Quem pagou esta conta?»; aqui trava o mês (blind_no_bank).
      if (!who && p.amount > 0.005 && inWindow && !lineFor(p.table, p.r)) { const a = acc.get(p.date.slice(0, 7)); if (a) { a.blind += p.amount; a.blindN++ } }
      continue
    }
    if (p.amount <= 0.005) { if (p.amount < -0.005) skip('refund_paid', -p.amount); continue }
    if (BR_PAID.has(String(p.r.paid_from || '')) || p.r.paid_to === 'GZ28BR') { skip('br_bill_paid', p.amount); continue }
    if (p.date < R.REGIONS_OPENED) { skip('pre_open_paid', p.amount); continue }
    if (!judgeUntil || p.date > judgeUntil) { if (!lineFor(p.table, p.r)) skip('fresh_paid', p.amount); continue }
    if (NON_BANK_METHODS.has(String(p.r.payment_method || '').toUpperCase())) { skip('non_bank_method_paid', p.amount); continue }
    if (lineFor(p.table, p.r) || !acc.has(p.date.slice(0, 7))) continue
    paidOpen.push(p)
  }
  const paidPair = pairOpenLines(paidOpen, openOut)
  for (const p of paidOpen) {
    const a = acc.get(p.date.slice(0, 7))!
    const pr = paidPair.get(p.key) || null
    // VISTO no card do dinheiro sem linha (revisão de 10/set): «está certo» sai do placar — fica em global.skipped.visto_paid.
    if (!pr && opts.dismissed && opts.dismissed.has('paid_no_bank|' + p.key)) { counted.add(p.key); skip('visto_paid', p.amount); continue }
    a.paid += p.amount; a.paidN++
    if (pr) { a.paidOpen += p.amount; a.paidOpenN++ }
    counted.add(p.key)
    const method = String(p.r.payment_method || '')
    const who1 = `Quem pagou = GZ28US (paid_from «${p.r.paid_from || '—'}» · source «${cut(p.r.source, 40) || '—'}» · método «${method || '—'}»${method.toUpperCase() === 'CASH' ? ' — CASH é o padrão do formulário, não prova dinheiro vivo' : ''}). Nenhuma linha viva aponta para o registro (matched_id, purchase_group, bank_transaction_id, bank:<id>).`
    const refs: AuditRef[] = [{ table: p.table, id: String(p.r.id), label: p.label, href: p.href }]
    if (pr) {
      if (!opts.lineOpenItems) continue
      refs.push(...pr.lines.slice(0, 3).map(lineRef))
      items.push({ key: 'paid_line_open|' + p.key, kind: 'paid_line_open', title: `Pago pela GZ28US em ${p.date}: ${usd(p.amount)} · ${p.label} — ${pairTitle(pr)}`, amount: r2(p.amount), date: p.date, refs, evidence: `${who1} ${pairEvidence(pr, p.date, true)}` })
    } else {
      items.push({ key: 'paid_no_bank|' + p.key, kind: 'paid_no_bank', title: `Pago pela GZ28US em ${p.date}: ${usd(p.amount)} · ${p.label} — nenhuma linha da Regions prova este pagamento.`, amount: r2(p.amount), date: p.date, refs, evidence: `${who1} Nenhuma linha aberta explica ${usd(p.amount)} em ±${R.OPEN_LINE_DAYS} dias (nem 1:1, nem wire com taxa até ${usd(R.WIRE_FEE_MAX)}, nem soma do mesmo dia).${hints(p.amount, p.date, ownedOut, openOut, pointedLabel)} Ou pagou outro bolso (sócio? BR? cliente?), ou o valor/data do registro está errado.` })
    }
  }

  // ── 4 · APP: recebido na GZ28US sem linha viva (data do caixa = paid_at, como o DFC: lib/financials buildCashEvents) ──
  type Rec = { key: string; p: any; amount: number; date: string; group: string }
  const recOpen: Rec[] = []
  for (const p of d.payments) {
    if (!p.paid_at || !realInv(p.invoice_id) || p.mirror_expense_id) continue   // espelho não é caixa
    // Renda não tem PAID FROM (quem paga é o cliente): o que tira a linha da Regions é o dinheiro ter caído na
    // GZ28BR. O paid_from da renda saiu do select e sai do banco na onda 9 — nunca teve GZ28BR em nenhuma das 220
    // (medido em 12/set: 22 GZ28US, 1 nome de cliente, 197 vazios), então o placar não muda um centavo.
    if (p.paid_to === 'GZ28BR') continue
    const date = day(p.paid_at), amount = num(p.amount)
    if (!okDay(date)) continue
    if (amount <= 0.005) { if (amount < -0.005) skip('refund_received', -amount); continue }
    if (date < R.REGIONS_OPENED) { skip('pre_open_received', amount); continue }
    if (!judgeUntil || date > judgeUntil) { if (!pointed.has('invoice_incomes:' + p.id)) skip('fresh_received', amount); continue }
    if (pointed.has('invoice_incomes:' + p.id) || !acc.has(date.slice(0, 7))) continue
    recOpen.push({ key: 'invoice_incomes:' + p.id, p, amount, date, group: '' })
  }
  const recPair = pairOpenLines(recOpen, openIn)
  for (const x of recOpen) {
    const { p, amount, date } = x
    const a = acc.get(date.slice(0, 7))!
    const pr = recPair.get(x.key) || null
    if (!pr && opts.dismissed && opts.dismissed.has('received_no_bank|' + x.key)) { counted.add(x.key); skip('visto_received', amount); continue }
    a.rec += amount; a.recN++
    if (pr) { a.recOpen += amount; a.recOpenN++ }
    counted.add(x.key)
    const label = ['INCOME', invCode(p.invoice_id), cut(p.description, 50), cut(p.source, 20)].filter(Boolean).join(' · ')
    const refs: AuditRef[] = [{ table: 'invoice_incomes', id: String(p.id), label, href: invHref(p.invoice_id) }]
    const src = String(p.source || '')
    const base = `Baixado (paid_at ${day(p.paid_at)}) para a GZ28US (paid_to «${p.paid_to || '—'}», via «${src || '—'}»${src.toUpperCase() === 'CASH' ? ' — dinheiro vivo só aparece no banco se foi depositado' : ''}). Nenhuma linha viva da Regions aponta para este recebimento.`
    if (pr) {
      if (!opts.lineOpenItems) continue
      refs.push(...pr.lines.slice(0, 3).map(lineRef))
      items.push({ key: 'received_line_open|' + x.key, kind: 'received_line_open', title: `Recebido em ${date}: ${usd(amount)} · ${label} — ${pairTitle(pr)}`, amount: r2(amount), date, refs, evidence: `${base} ${pairEvidence(pr, date, false)}` })
    } else {
      items.push({ key: 'received_no_bank|' + x.key, kind: 'received_no_bank', title: `Recebido em ${date}: ${usd(amount)} · ${label} — nenhuma entrada da Regions mostra este dinheiro.`, amount: r2(amount), date, refs, evidence: `${base} Nenhuma entrada aberta explica ${usd(amount)} em ±${R.OPEN_LINE_DAYS} dias (nem 1:1, nem wire, nem soma do dia).${hints(amount, date, ownedIn, openIn, pointedLabel)} Ou entrou em outra conta (BR? sócio?), ou a baixa está errada.` })
    }
  }

  // ── 5 · EXTRATO: âncora MANUAL × linhas do período (cumulativo por conta, a régua da rota /api/plaid/balance) ──
  const statements: StatementTie[] = []
  if (d.cashBalances) {
    for (const acct of d.accounts) {
      const name = String(acct.display_name || acct.institution || '')
      const anchors = d.cashBalances.filter(c => c.source === 'MANUAL' && String(c.account) === name && okDay(c.balance_date)).sort((x, y) => day(x.balance_date).localeCompare(day(y.balance_date)))
      const lines = live.filter(b => String(b.item_id) === String(acct.id))
      const regions = /REGIONS/i.test(String(acct.institution || '') + ' ' + name)
      let prevD: string | null = regions ? addDays(R.REGIONS_OPENED, -1) : null, prevB: number | null = regions ? 0 : null
      for (const c of anchors) {
        const end = day(c.balance_date)
        if (prevD === null || prevB === null) { prevD = end; prevB = num(c.balance); continue }   // conta sem saldo de abertura conhecido: a 1ª âncora só abre
        const from = prevD
        const inP = lines.filter(b => day(b.date) > from && day(b.date) <= end)
        const net = -inP.reduce((s, b) => s + num(b.amount), 0)
        statements.push({ account: name, opening: from, closing: end, open_balance: r2(prevB), close_balance: r2(num(c.balance)), lines: inP.length, pending: inP.filter(b => b.pending).length, diff: r2(num(c.balance) - prevB - net) })
        prevD = end; prevB = num(c.balance)
      }
    }
  }
  const tie = (s: StatementTie) => s.diff != null && Math.abs(s.diff) <= R.STMT_TOLERANCE
  // Provado até: a última âncora de uma cadeia sem quebra desde a abertura (uma conta só hoje; com várias, a menor delas).
  const accountsWithLines = d.accounts.filter(acct => live.some(b => String(b.item_id) === String(acct.id)))
  const untilOf = (acct: any): string => {
    const name = String(acct.display_name || acct.institution || '')
    let until = ''
    for (const s of statements.filter(x => x.account === name)) { if (!tie(s)) break; until = s.closing }
    return until
  }
  const untils = accountsWithLines.map(untilOf)
  const provenUntil: string | null = untils.length && untils.every(u => !!u) ? untils.sort()[0] : null
  for (const s of statements) if (!tie(s)) {
    items.push({ key: 'stmt_break|' + s.account + '|' + s.closing, kind: 'stmt_break', title: `O extrato de ${s.closing} (${s.account}) não bate com as linhas do banco: diferença de ${usd(s.diff || 0)}.`, amount: r2(Math.abs(s.diff || 0)), date: s.closing, refs: [{ table: 'cash_balances', id: s.closing, label: `extrato ${s.opening} → ${s.closing}`, href: '/adm/financials/ledgers' }], evidence: `Saldo de abertura ${usd(s.open_balance || 0)} (${s.opening}) − Σ ${s.lines} linha(s) com data em (${s.opening}, ${s.closing}] ≠ saldo do extrato ${usd(s.close_balance)}${s.pending ? `; ${s.pending} linha(s) ainda pendente(s) no período` : ''}. Falta ou sobra linha no feed, ou o saldo foi digitado errado.` })
  }

  // ── 6 · achados das outras auditorias (sem contar duas vezes) ──
  let findingsSkipped = 0
  for (const it of opts.findings || []) {
    if (!it || !(num(it.amount) > 0) || !okDay(it.date)) continue
    if ((it.refs || []).some(x => counted.has(x.table + ':' + x.id))) { findingsSkipped++; continue }
    const a = acc.get(day(it.date).slice(0, 7)); if (!a) continue
    a.fnd += num(it.amount); a.fndN++
  }

  // ── 7 · monta os meses ──
  const stmtByMonth = new Map<string, StatementTie>()
  for (const s of statements) stmtByMonth.set(s.closing.slice(0, 7), s)   // uma conta hoje; com várias, a última gravada
  const top = (rows: any[], n: number) => [...rows].sort((x, y) => absAmt(y) - absAmt(x)).slice(0, n)
  const out: CloseMonth[] = months.map(m => {
    const a = acc.get(m)!
    const mEnd = monthEnd(m), mStart = m + '-01'
    const overlapping = statements.filter(s => s.closing >= mStart && s.opening < mEnd)
    const brokenHere = overlapping.some(s => !tie(s))
    const bank_proof: CloseMonth['bank_proof'] = !brokenHere && provenUntil && provenUntil >= mEnd ? 'EXTRATO'
      : !brokenHere && opts.liveProofUntil && day(opts.liveProofUntil) >= mEnd ? 'AO VIVO' : null
    const row: CloseMonth = {
      month: m, label: monthLabel(m),
      era: a.lines === 0 ? 'SEM LINHAS' : a.stmt && a.plaid ? 'MISTO' : a.stmt ? 'EXTRATO' : 'PLAID',
      complete: !!judgeUntil && mEnd <= judgeUntil,
      lines: a.lines,
      bank_out: r2(a.out), bank_in: r2(a.inn), linked_out: r2(a.lout), linked_in: r2(a.lin),
      unlinked_out: r2(a.uout), unlinked_in: r2(a.uin), unlinked_n: a.un,
      linked_pct_out: a.out > 0 ? Math.floor((a.lout / a.out) * 1000) / 10 : null,
      linked_pct_in: a.inn > 0 ? Math.floor((a.lin / a.inn) * 1000) / 10 : null,
      dead_links: r2(a.dead), dead_links_n: a.deadN,
      bucket_open: r2(a.bucket), bucket_open_n: a.bucketN,
      paid_no_bank: r2(a.paid), paid_no_bank_n: a.paidN, paid_line_open: r2(a.paidOpen), paid_line_open_n: a.paidOpenN,
      received_no_bank: r2(a.rec), received_no_bank_n: a.recN, received_line_open: r2(a.recOpen), received_line_open_n: a.recOpenN,
      blind_no_bank: r2(a.blind), blind_no_bank_n: a.blindN,
      statement: stmtByMonth.get(m) || null, bank_proof,
      findings: r2(a.fnd), findings_n: a.fndN,
      open_usd: 0, open_items: 0, status: 'ABERTO', reasons: [],
    }
    Object.assign(row, monthStatus(row, feedUntil))
    const L = monthLabel(m)
    // Itens agregados por mês (a pendência linha a linha mora no Bank Link e no card do balde; aqui é o placar dizendo onde está).
    for (const [dir, rows, total] of [['out', a.outs, a.uout], ['in', a.ins, a.uin]] as const) {
      if (!rows.length) continue
      const big = top(rows, 5)
      items.push({ key: `unlinked_${dir}|${m}`, kind: `unlinked_${dir}`, title: dir === 'out' ? `${L}: ${rows.length} saída(s) da Regions sem dono, ${usd(total)} — o DFC e o DRE ainda não sabem para onde foi esse dinheiro.` : `${L}: ${rows.length} entrada(s) da Regions sem dono, ${usd(total)} — receita, aporte ou transferência ainda não dita.`, amount: r2(total), date: day(big[0].date), refs: big.map(lineRef), evidence: `Linhas postadas com data do banco em ${L} e match_status NEW/QUEUED${rows.some((b: any) => dead.has(String(b.id))) ? ' (ou casadas com registro que não existe mais)' : ''}. Maiores: ${big.slice(0, 3).map((b: any) => `${day(b.date)} ${usd(absAmt(b))} «${bankName(b)}»`).join('; ')}.` })
    }
    if (a.bucketRows.length) {
      const big = [...a.bucketRows].sort((x, y) => y.v - x.v).slice(0, 5)
      const orphans = a.bucketRows.filter(x => !x.line).length
      items.push({ key: 'bucket_open|' + m, kind: 'bucket_open', title: `${L}: ${a.bucketN} compra(s) no balde ${BUCKET_CODE}, ${usd(a.bucket)} — o banco pagou, mas o dinheiro ainda não tem carro, estoque ou custo fixo.`, amount: r2(a.bucket), date: day(big[0].line ? big[0].line.date : big[0].r.payment_date), refs: big.map(x => ({ table: 'invoice_expenses', id: String(x.r.id), label: `${day(x.line ? x.line.date : x.r.payment_date)} · ${usd(x.v)} · ${cut(x.r.supplier, 40)}`, href: '/adm/bank#a-atribuir' })), evidence: `Linhas da invoice ${BUCKET_CODE} (origin ${BUCKET_ORIGIN}) cuja linha do banco é de ${L}${orphans ? `; ${orphans} sem linha apontando (órfã — a purga do motor apaga)` : ''}. Maiores: ${big.slice(0, 3).map(x => `${usd(x.v)} ${cut(x.r.supplier, 30)}`).join('; ')}.` })
    }
    if (row.complete && !row.bank_proof && !brokenHere && a.lines) {
      items.push({ key: 'stmt_missing|' + m, kind: 'stmt_missing', title: `${L}: extrato não lançado — ${usd(a.out + a.inn)} de movimento sem prova de que o feed trouxe todas as linhas.`, amount: r2(a.out + a.inn), date: mEnd, refs: [{ table: 'cash_balances', id: m, label: 'LEDGERS · saldo do extrato', href: '/adm/financials/ledgers' }], evidence: `A última âncora MANUAL que bate é ${provenUntil || '—'}; ${L} termina em ${mEnd}. Lance o saldo do extrato do mês em LEDGERS (ou confirme o card cash-match verde) para o mês poder fechar.` })
    }
    return row
  })

  const openLines = posted.filter(b => !ownedLine(b))
  const pendingLines = live.filter(b => b.pending)
  const sumAbs = (rows: any[]) => r2(rows.reduce((s, b) => s + absAmt(b), 0))
  const kinds: Record<string, number> = {}
  for (const it of items) kinds['items_' + it.kind] = (kinds['items_' + it.kind] || 0) + 1
  items.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || y.amount - x.amount)
  const sum = (f: (m: CloseMonth) => number) => r2(out.reduce((s, m) => s + f(m), 0))
  const oOut = openLines.filter(b => num(b.amount) > 0), oIn = openLines.filter(b => num(b.amount) < 0)
  return {
    items,
    months: out,
    summary: {
      month_first: R.FIRST_MONTH, month_now: monthNow, months: out.length,
      ...statusCounts(out),
      feed_until: feedUntil || '', judge_until: judgeUntil || '', proven_until: provenUntil || '',
      open_lines_n: openLines.length, open_lines_out: sumAbs(oOut), open_lines_in: sumAbs(oIn),
      bucket_open_usd: sum(m => m.bucket_open), paid_no_bank_usd: sum(m => m.paid_no_bank), paid_line_open_usd: sum(m => m.paid_line_open), paid_line_open_n: sum(m => m.paid_line_open_n),
      received_no_bank_usd: sum(m => m.received_no_bank), received_line_open_usd: sum(m => m.received_line_open), received_line_open_n: sum(m => m.received_line_open_n),
      blind_no_bank_usd: sum(m => m.blind_no_bank), dead_links_n: sum(m => m.dead_links_n), stmt_breaks_n: statements.filter(s => !tie(s)).length,
      ...kinds,
    },
    global: {
      today: d.today, month_now: monthNow, feed_until: feedUntil, judge_until: judgeUntil, proven_until: provenUntil,
      pending: { n: pendingLines.length, out: sumAbs(pendingLines.filter(b => num(b.amount) > 0)), in: sumAbs(pendingLines.filter(b => num(b.amount) < 0)) },
      open_lines: {
        n: openLines.length, n_out: oOut.length, out: sumAbs(oOut), n_in: oIn.length, in: sumAbs(oIn),
        statement_era_n: openLines.filter(b => String(b.plaid_id || '').startsWith('stmt:')).length, plaid_era_n: openLines.filter(b => !String(b.plaid_id || '').startsWith('stmt:')).length,
      },
      statements, skipped, findings_skipped_as_counted: findingsSkipped,
      br_account: null,
      br_account_reason: "lib/financials.ts começa com 'use client' e importa o cliente anon do navegador (@/lib/supabase): numa rota do App Router (camada rsc do Next) o import vira referência de cliente e brAccount não pode ser chamada no servidor. Os dados existem no servidor; a régua não. A conta segue calculada no navegador — app/adm/check/page.tsx (card «Conta corrente GZ28BR», brAccount(d)) e app/adm/financials/balance/page.tsx (brAccount(d)). Para o placar mostrar GOT/PAID/net/BLIND, whoPaid/brAccount/expLine/qtyLine precisam morar num módulo neutro (sem 'use client') que lib/financials.ts reexporte.",
      cash_match: null,
      cash_match_reason: "O «caixa bate» ao vivo é o card cash-match do Data Checker (app/adm/check/page.tsx, 9c): lê /api/plaid/balance, que chama o Plaid (teto de consultas pagas) e GRAVA o saldo do dia em cash_balances (syncBalances). Uma auditoria que só lê não pode refazer isso. O placar prova os meses pelos extratos MANUAL (statements) e aceita liveProofUntil de quem já tem o cash-match verde.",
    },
  }
}

// ── ENTRADA: carrega (paginado, só leitura) e calcula ──
export async function closeScore(db: any, opts: CloseOpts = {}): Promise<CloseScore> {
  const missing = (e: any) => /does not exist|relation|schema cache|PGRST205|42P01/.test(String(e?.message || e))
  const opt = (p: Promise<any[]>): Promise<any[] | null> => p.catch((e: any) => (missing(e) ? null : Promise.reject(e)))
  const [bank, accounts, invoiceExpenses, fixedExpenses, expenses, goods, goodExpenses, inputs, inventory, payments, invoices, fixedSuppliers, cashBalances, financingEvents, capitalEvents] = await Promise.all([
    fetchAll(db, 'bank_transactions', 'id, item_id, date, amount, name, merchant, pending, plaid_id, match_status, match_engine, matched_table, matched_id'),
    fetchAll(db, 'bank_accounts', 'id, institution, display_name, status'),   // NUNCA o token
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, source, payment_method, purchase_group, order_number'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, expense_date, payment_date, paid_from, paid_to, source, payment_method, bank_transaction_id'),
    expensesRows(db, 'id, description, type, amount, expense_date, payment_date, origin, paid_from, paid_to, source, payment_method, payment_reference'),   // + bank_transaction_id quando a migration rodou
    fetchAll(db, 'assets', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, payment_method, purchase_group'),
    fetchAll(db, 'assets_expenses', 'id, good_id, description, amount, expense_date, payment_date, paid_from, paid_to, source, payment_method'),
    fetchAll(db, 'inputs', 'id, description, supplier, category, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, payment_method, purchase_group, order_number'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, source, payment_method, purchase_group'),
    fetchAll(db, 'invoice_incomes', 'id, invoice_id, amount, payment_date, paid_at, source, paid_to, description, mirror_expense_id'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote, origin'),
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, cost_type'),
    opt(fetchAll(db, 'cash_balances', 'id, account, balance_date, balance, source')),
    opt(fetchAll(db, 'financing_events', 'id')),
    opt(fetchAll(db, 'capital_events', 'id')),
  ])
  return computeCloseScore({ today: todayOrlando(), bank, accounts, invoiceExpenses, fixedExpenses, expenses, goods, goodExpenses, inputs, inventory, payments, invoices, fixedSuppliers, cashBalances, financingEvents, capitalEvents }, opts)
}
