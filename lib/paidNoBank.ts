// PAGA NO APP, SEM LINHA NO BANCO — a régua do card do Data Checker (DC 1.55.1).
//
// A LEI (Márcio, 13/set/2026): «tudo que está no PLAID é PAID FROM GZ28US, o que não está no PLAID, não é, temos que
// designar» · «tudo que tem no Regions é PAID FROM (expenses) e PAID TO (incomes) GZ28US!». A conta da Regions (o feed do
// Plaid) abriu em 2025-11-10. Todo registro que diz que a GZ28US pagou — ou recebeu — depois disso tem de ter a linha da
// Regions atrás; o que não tem é casamento faltando ou pagador errado, e pagador errado se DESIGNA, não se adivinha.
//
// Módulo PURO (sem 'use client', sem import de tela): a página monta os itens a partir destas linhas, e quem mede roda a
// mesma régua. Nada aqui escreve. O que entra:
//   · as sete tabelas de gasto (invoice_expenses, inputs, inventory só PURCHASED, assets, assets_expenses, staff_expenses,
//     fixed_cost_expenses) com o pagador GZ28US — PAID FROM GZ28US, ou vazio onde a régua esconde o GZ28US (lib/payerRule:
//     inputs, inventory, fixed_cost_expenses); GZ28BR em PAID FROM ou PAID TO nunca entra;
//   · a renda (invoice_incomes) baixada (paid_at) com PAID TO GZ28US, que não seja espelho (mirror_expense_id);
//   · data entre `from` (a abertura da Regions) e `until` (o feed menos a postagem) — a data da renda é o paid_at EM ORLANDO
//     (timestamptz em UTC: depois das 20h de Orlando o UTC já é o dia seguinte);
//   · sem linha: nem par casado (tabela:id, o pedido purchase_group, o membro de misto — o sinal ?matched=1 já expande), nem elo
//     gravado no registro (bank_transaction_id, payment_reference ou order_number «bank:<id>»). Elo gravado conta sempre: a linha
//     pendente não vem no sinal (medido em 14/09: o T-Mobile de 10/set aponta pra linha ainda pendente) e o elo MORTO é pergunta
//     do ELO SOLTO / PONTEIRO MORTO do AUTO-LINK, não deste card (na mesma medição: 0 elos mortos — bank_transaction_id do custo fixo e da folha, order_number bank: dos 159 insumos).
// Quem filtra orçamento e o balde A ATRIBUIR é o loader (lib/financials: invExpenses e payments só de invoice real).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PAYER_RULE, HOUSE_PAYER } from './payerRule'

export type PnbLine = { d: string; a: number; id: string; n: string; s: string }   // a: valor ABSOLUTO; s: match_status
export const PNB_TABLES = ['invoice_expenses', 'inputs', 'inventory', 'assets', 'assets_expenses', 'staff_expenses', 'fixed_cost_expenses', 'invoice_incomes'] as const
export type PnbTable = typeof PNB_TABLES[number]
export type PnbRow = {
  table: PnbTable; id: string; r: any
  amount: number        // absoluto, ao centavo
  date: string          // YYYY-MM-DD: payment_date (gasto) · paid_at em Orlando (renda)
  dir: 'out' | 'in'     // o que a Regions teria de mostrar: saída (gasto) ou entrada (renda; valor negativo inverte = estorno)
  method: string        // payment_method (gasto) · source (renda), cru
  hint: string[]        // palavras do nome: fornecedor, staff, cliente/carro
  cands: PnbLine[]      // linhas NEW da mesma direção: valor exato, ±10 d, nome batendo
  one: PnbLine | null   // a candidata única que nenhum outro registro do card também tem como única
  shared: number        // quantos registros do card têm esta mesma candidata única (>1 = ninguém casa sozinho)
  cash: PnbLine[]       // CASH: saque ATM (saída) ou depósito (entrada) na Regions a ±10 d que cobre o valor
}
export type PnbInput = {
  rows: Partial<Record<PnbTable, any[]>>
  amountOf: Record<PnbTable, (r: any) => number>
  hintOf: Record<PnbTable, (r: any) => string>
  matched: Set<string>
  outLines: PnbLine[]
  inLines: PnbLine[] | null     // null = sem o sinal das entradas: a renda não é julgada
  from: string
  until: string
  tok: (s: unknown) => string[]
  skip?: (table: PnbTable, r: any) => boolean
}

export const PNB_WINDOW_DAYS = 10
// Palavras que aparecem no extrato de qualquer um — não identificam quem recebeu o dinheiro (a régua do nome é por palavra inteira).
const HINT_STOP = new Set(['ZELLE', 'REGIONS', 'BANK', 'PAYMENT', 'PAYMENTS', 'DEBIT', 'CREDIT', 'CARD', 'PURCHASE', 'TRANSFER', 'WIRE', 'CASH', 'CHECK', 'DEPOSIT', 'ACCOUNT', 'SENT', 'POSTED', 'INSIDE', 'FROM', 'WEEKLY', 'MONTHLY', 'DAILY', 'WEEK', 'MONTH', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY', 'SALARY', 'ORLANDO'])
const CENT = 0.011
const up = (v: unknown) => String(v ?? '').trim().toUpperCase()
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
const bankRef = (v: unknown) => { const s = String(v || ''); return s.startsWith('bank:') ? s.slice(5) : '' }

// O dia de Orlando de um timestamptz (lei O RELÓGIO: a GZ28US vive em America/New_York). Data pura passa como está.
export const orlandoDay = (ts: unknown): string => {
  const s = String(ts || '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return ''
  // Meia-noite UTC EXATA é data de calendário gravada crua (seletor de data → 'AAAA-MM-DDT00:00:00Z'), não instante: medido em
  // 14/set, 21 das 166 rendas baixadas estão assim (129 ao meio-dia UTC, o resto com hora de verdade). Converter essas para
  // Orlando jogaria o recebimento para o dia ANTERIOR; o dia é o que está escrito.
  if (new Date(t).toISOString().endsWith('T00:00:00.000Z')) return new Date(t).toISOString().slice(0, 10)
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Quem pagou é a GZ28US? (renda: quem recebeu.) A régua de lib/payerRule decide onde o vazio é GZ28US escondido.
export function payerIsHouse(table: PnbTable, r: any): boolean {
  if (table === 'invoice_incomes') return up(r.paid_to) === HOUSE_PAYER
  if (up(r.paid_from) === 'GZ28BR' || up(r.paid_to) === 'GZ28BR') return false
  if (up(r.paid_from) === HOUSE_PAYER) return true
  return !up(r.paid_from) && (PAYER_RULE[table] as { paidFrom: string }).paidFrom === 'house'
}

// Já tem linha? Par casado (o sinal ?matched=1 expande pedido e misto) ou elo gravado no próprio registro.
export function linkedToBank(table: PnbTable, r: any, matched: Set<string>): boolean {
  if (matched.has(table + ':' + r.id)) return true
  if (r.purchase_group && matched.has('purchase_group:' + r.purchase_group)) return true
  return [r.bank_transaction_id, bankRef(r.payment_reference), bankRef(r.order_number)].some(x => !!x)
}

export function paidNoBank(inp: PnbInput): PnbRow[] {
  const out: PnbRow[] = []
  for (const table of PNB_TABLES) {
    const income = table === 'invoice_incomes'
    if (income && !inp.inLines) continue
    for (const r of inp.rows[table] || []) {
      if (income ? (!r.paid_at || r.mirror_expense_id) : !r.payment_date) continue
      if (table === 'inventory' && r.source_type !== 'PURCHASED') continue   // estoque DOADO não foi comprado
      const date = income ? orlandoDay(r.paid_at) : String(r.payment_date).slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < inp.from || date > inp.until) continue
      if (inp.skip && inp.skip(table, r)) continue
      if (!payerIsHouse(table, r)) continue
      if (linkedToBank(table, r, inp.matched)) continue
      const raw = Math.round((Number(inp.amountOf[table](r)) || 0) * 100) / 100
      if (Math.abs(raw) < 0.005) continue
      const dir: 'out' | 'in' = (income ? raw > 0 : raw < 0) ? 'in' : 'out'
      const amount = Math.abs(raw)
      // Fora do custo fixo o nome vem de texto livre (descrição da folha, da despesa de GOODS): palavra de MEIO ou de agenda casa
      // com metade do extrato («ZELLE», «REGIONS», «WEEKLY», o final 7666 do cartão, o ano). O custo fixo fica com a régua de antes.
      const hint = [...new Set(inp.tok(inp.hintOf[table](r)))].filter(t => table === 'fixed_cost_expenses' || (!HINT_STOP.has(t) && (/[A-Z]/.test(t) || t.length >= 6)))
      const pool = dir === 'out' ? inp.outLines : (inp.inLines || [])
      // Nome por PALAVRA INTEIRA (APPLE não é APPLEBEES; DUKE não é DUKES BBQ) — a régua de sempre do card.
      const cands = hint.length ? pool.filter(x => {
        if (x.s !== 'NEW' || Math.abs(x.a - amount) >= CENT || dayDiff(x.d, date) > PNB_WINDOW_DAYS) return false
        const lt = new Set(inp.tok(x.n))
        return hint.some(t => lt.has(t))
      }) : []
      const method = String((income ? r.source : r.payment_method) || '')
      const cashRx = dir === 'out' ? /\bATM\b|WITHDRAWAL/i : /DEPOSIT/i
      const cash = /CASH/i.test(method) ? pool.filter(x => cashRx.test(x.n) && !/\bFEE\b/i.test(x.n) && dayDiff(x.d, date) <= PNB_WINDOW_DAYS && x.a + CENT >= amount) : []
      out.push({ table, id: String(r.id), r, amount, date, dir, method, hint, cands, one: null, shared: 0, cash })
    }
  }
  // Uma linha paga um registro: se dois registros têm a MESMA candidata única, nenhum casa sozinho — escolher é de gente.
  const claims = new Map<string, number>()
  for (const p of out) if (p.cands.length === 1) claims.set(p.cands[0].id, (claims.get(p.cands[0].id) || 0) + 1)
  for (const p of out) if (p.cands.length === 1) { p.shared = claims.get(p.cands[0].id) || 0; p.one = p.shared === 1 ? p.cands[0] : null }
  return out
}
