// lib/bankDoubt.server.ts — A DÚVIDA DO MOTOR, DITA EM VOZ ALTA (BL 0.10.0, 4/set/2026).
//
// Lei do João («silence means right»): silêncio do app é PROMESSA de que está tudo
// certo. Linha que o motor não resolve não pode ficar parada calada — cada
// recusa vira uma PERGUNTA com o motivo e uma resposta de um clique. Este módulo
// é puro (sem cliente Supabase): recebe linhas, pool, regras e cadastros e devolve
// as perguntas já agrupadas do jeito que a tela e o Data Checker mostram.
//
// Três pilhas, três perguntas (medidas em 4/set: ~390 · ~130 · ~118):
//   TWIN      «é esta compra?»       — gêmeo no app, o motor viu e não teve certeza
//   SUPPLIER  «quem é X pra nós?»     — perguntada UMA vez por fornecedor, vira regra
//   MONEY     «qual invoice / sócio?» — dinheiro andando; o banco não sabe, o humano sabe
// E a deriva das três datas (X previsto · Y banco · Z registro): conta AGENDADA que o
// banco já pagou e o app ainda diz «a pagar» — a multa nasce dessa mentira.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { num, classify, supplierNameFor, type Classified, type Klass } from './bankReconcile.server'
import { normSup, type SupplierEntry } from './supplierMatch'

export type DoubtKind = 'TWIN' | 'SUPPLIER' | 'MONEY' | 'CAP' | 'MATURITY'
export type DoubtCand = { table: string; id: string; label: string; date: string | null; amount: number; href?: string; days?: number | null }
export type Doubt = { kind: DoubtKind; reason: string; klass: Klass; supplier: string; cands?: DoubtCand[]; rule_key?: string | null }

// Classes cuja pergunta é «quem é este fornecedor pra nós?» (não é dinheiro-movimento
// e não é peça pra carro — o balde é pra peça).
export const SUPPLIER_QUESTION_KLASSES = new Set<Klass>(['LODGING', 'RENT', 'UTILITY', 'INSURANCE', 'TELECOM', 'ACCOUNTING', 'RESTAURANT', 'CLOTHING', 'TRAVEL', 'ENTERTAINMENT', 'DRUGSTORE', 'DEPT_STORE', 'GOVERNMENT'])
export const MONEY_KLASSES = new Set<Klass>(['TRANSFER', 'INCOME', 'BANK_FEE'])

const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const dayDiff = (a: string, b: string) => Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 864e5)

// ── FORNECEDOR VIVO (prestador) casado pelo nome ────────────────────────────
// `date_conclusion` é FIM DO TERMO, não morte: a apólice da frota termina em jan/2027
// e está viva. Só conclusão no PASSADO tira o prestador do jogo (revisão de 4/set:
// o resolver antigo pulava a Progressive viva por isso).
export type FixedSupplier = { id: string; company: string | null; description?: string | null; cost_type?: string | null; date_conclusion?: string | null; mail_match?: string | null; aliases?: string | null }
export const supplierAlive = (s: FixedSupplier, today = todayNY()) => !s.date_conclusion || String(s.date_conclusion).slice(0, 10) >= today
const supKeys = (s: FixedSupplier) => [s.company, ...String(s.mail_match || '').split(/[\n,]/), ...String(s.aliases || '').split(/[\n,]/)].map(x => normSup(String(x || ''))).filter(k => k.length >= 4)
// Devolve o ÚNICO prestador vivo cujo nome/mail_match/alias casa com a linha; 2+ = ambíguo (lista); 0 = nenhum.
export function matchFixedSupplier(l: any, cls: Classified, sups: FixedSupplier[], dir: SupplierEntry[], today = todayNY()): { one: FixedSupplier | null; hits: FixedSupplier[] } {
  const name = supplierNameFor(l, cls, dir)
  const probes = [name, cls.counterparty, l.merchant, l.name].filter(Boolean).map(x => normSup(String(x))).filter(x => x.length >= 4)
  const hits = sups.filter(s => supplierAlive(s, today) && supKeys(s).some(k => probes.some(p => p === k || (k.length >= 6 && (p.startsWith(k) || k.startsWith(p) && p.length >= 5)))))
  return { one: hits.length === 1 ? hits[0] : null, hits }
}

// ── PERGUNTAS POR FORNECEDOR ────────────────────────────────────────────────
export type SupplierQuestion = { key: string; name: string; klass: Klass; n: number; total: number; sample: string[]; oldest: string; newest: string; line_ids: string[]; suggested: { supplier_id: string | null; company: string | null; cost_type: string | null; ambiguous: { id: string; company: string | null; cost_type: string | null }[] } }
// Agrupa as linhas NEW/QUEUED cuja classe pede «quem é X pra nós?» por fornecedor
// canônico. Uma resposta = uma regra HUMANA = todas as linhas do grupo, pra sempre.
export function groupSupplierDoubts(lines: any[], sups: FixedSupplier[], dir: SupplierEntry[]): SupplierQuestion[] {
  const groups = new Map<string, SupplierQuestion>()
  for (const l of lines) {
    if (!(num(l.amount) > 0)) continue
    const cls = classify(l)
    if (!SUPPLIER_QUESTION_KLASSES.has(cls.klass)) continue
    const name = supplierNameFor(l, cls, dir)
    const key = normSup(name) || 'x'
    const existing = groups.get(key)
    const g: SupplierQuestion = existing || (() => {
      const m = matchFixedSupplier(l, cls, sups, dir)
      const fresh: SupplierQuestion = { key, name, klass: cls.klass, n: 0, total: 0, sample: [], oldest: l.date, newest: l.date, line_ids: [], suggested: { supplier_id: m.one?.id || null, company: m.one?.company || null, cost_type: m.one?.cost_type || null, ambiguous: m.one ? [] : m.hits.map(h => ({ id: h.id, company: h.company ?? null, cost_type: h.cost_type ?? null })) } }
      groups.set(key, fresh)
      return fresh
    })()
    g.n++; g.total = Math.round((g.total + Math.abs(num(l.amount))) * 100) / 100; g.line_ids.push(String(l.id))
    if (g.sample.length < 3 && !g.sample.includes(String(l.name || '').slice(0, 60))) g.sample.push(String(l.name || '').slice(0, 60))
    if (l.date < g.oldest) g.oldest = l.date; if (l.date > g.newest) g.newest = l.date
  }
  return [...groups.values()].sort((a, b) => b.total - a.total)
}

// ── DINHEIRO ANDANDO ────────────────────────────────────────────────────────
export function moneyDoubts(lines: any[]): { id: string; date: string; amount: number; name: string; klass: Klass; reason: string }[] {
  return lines.filter(l => MONEY_KLASSES.has(classify(l).klass)).map(l => { const k = classify(l).klass; return { id: String(l.id), date: l.date, amount: num(l.amount), name: l.merchant || l.name || '', klass: k, reason: k === 'INCOME' ? 'entrada — qual invoice (recebimento) ou sócio?' : k === 'BANK_FEE' ? 'tarifa — o motor FEE cuida; ficou por ambiguidade' : 'transferência/wire/Zelle — qual invoice, sócio ou conta?' } })
}

// ── DERIVA DAS TRÊS DATAS ───────────────────────────────────────────────────
// Conta agendada EM ABERTO (sem payment_date, sem elo) com linha do banco do MESMO
// valor a ±25 dias: o banco pagou, o app diz «a pagar», a multa corre à toa.
// Duas contas iguais pra uma linha (dois aluguéis de $7.006,69) = AMBÍGUA: pergunta,
// nunca chute.
export type DriftRow = { row_id: string; supplier_id: string | null; supplier: string; amount: number; due: string; bank_id: string; bank_date: string; bank_status: string; days: number; overdue_days: number; ambiguous: boolean; late_fee: boolean }
export function driftRows(openFixed: any[], bankLines: any[], sups: FixedSupplier[], today = todayNY()): DriftRow[] {
  const byId = new Map(sups.map(s => [s.id, s]))
  const outs = bankLines.filter(b => num(b.amount) > 0 && ['NEW', 'QUEUED'].includes(String(b.match_status)))
  const out: DriftRow[] = []
  const usedBank = new Map<string, number>()
  for (const x of openFixed) {
    const amt = num(x.amount); if (!(amt > 0) || !x.expense_date) continue
    const s0: any = byId.get(x.supplier_id) || {}
    const keys = supKeys(s0)
    // Janela ASSIMÉTRICA: o banco paga no vencimento ou DEPOIS (até 40 dias — a parcela do
    // seguro vence no dia 30 e o banco paga no início do mês); antes do vencimento só 5 dias.
    // Medido em 4/set: com janela simétrica 6 de 7 «derivas» eram a cobrança do ciclo ANTERIOR
    // (Anthropic 19/ago × conta de 17/set) — cobrança extra, não conta futura paga cedo.
    // Candidato cujo NOME bate com o prestador vem primeiro — valor igual sozinho é fraco.
    // «Progressive Insurance» × «Progressive Express Ins Company»: prefixo comum de 8+ letras já é o nome.
    const prefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i }
    const nameOk = (b: any) => { const n = normSup(String(b.merchant || b.name || '')); return n.length >= 5 && keys.some(k => k.length >= 5 && (n.includes(k) || k.includes(n) || prefix(n, k) >= 8)) }
    const cands = outs.filter(b => Math.abs(num(b.amount) - amt) < 0.011 && dayDiff(b.date, x.expense_date) >= -5 && dayDiff(b.date, x.expense_date) <= 40)
      .sort((a, b) => (Number(nameOk(b)) - Number(nameOk(a))) || (Math.abs(dayDiff(a.date, x.expense_date)) - Math.abs(dayDiff(b.date, x.expense_date))))
    if (!cands.length) continue
    // Sem nome batendo e mais de 25 dias = coincidência de valor, não deriva.
    if (!nameOk(cands[0]) && dayDiff(cands[0].date, x.expense_date) > 25) continue
    const b = cands[0]
    usedBank.set(String(b.id), (usedBank.get(String(b.id)) || 0) + 1)
    const s: any = byId.get(x.supplier_id) || {}
    out.push({ row_id: x.id, supplier_id: x.supplier_id || null, supplier: s.company || String(x.description || '').slice(0, 40), amount: amt, due: String(x.expense_date).slice(0, 10), bank_id: String(b.id), bank_date: String(b.date).slice(0, 10), bank_status: String(b.match_status), days: dayDiff(b.date, x.expense_date), overdue_days: dayDiff(today, x.expense_date), ambiguous: false, late_fee: !!(s.late_fee_fixed || s.late_fee_percent || s.late_fee_daily) })
  }
  for (const r of out) if ((usedBank.get(r.bank_id) || 0) > 1) r.ambiguous = true   // uma linha do banco, duas contas iguais
  return out.sort((a, b) => b.amount - a.amount)
}

// ── FORA DO PADRÃO (o que hoje ninguém pegaria) ─────────────────────────────
// Gasto do mês corrente > 2× a média dos 3 meses anteriores (e > $100) por prestador.
export function spendAnomalies(fixedExpenses: any[], sups: FixedSupplier[], today = todayNY()): { supplier_id: string; supplier: string; month: string; current: number; avg3: number; ratio: number }[] {
  const ym = today.slice(0, 7)
  const prev = [1, 2, 3].map(k => { const d = new Date(Date.parse(today.slice(0, 7) + '-01T12:00:00Z')); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7) })
  const bySup = new Map<string, Map<string, number>>()
  for (const e of fixedExpenses) { const d = String(e.payment_date || e.expense_date || '').slice(0, 7); if (!d || !e.supplier_id) continue; if (!bySup.has(e.supplier_id)) bySup.set(e.supplier_id, new Map()); const m = bySup.get(e.supplier_id)!; m.set(d, (m.get(d) || 0) + num(e.amount)) }
  const name = new Map(sups.map(s => [s.id, s.company || '?']))
  const out: any[] = []
  bySup.forEach((m, sid) => { const cur = m.get(ym) || 0; const hist = prev.map(p => m.get(p) || 0).filter(v => v > 0); if (hist.length < 2 || cur < 100) return; const avg = hist.reduce((a, b) => a + b, 0) / hist.length; if (cur > 2 * avg) out.push({ supplier_id: sid, supplier: name.get(sid) || '?', month: ym, current: Math.round(cur * 100) / 100, avg3: Math.round(avg * 100) / 100, ratio: Math.round(cur / avg * 10) / 10 }) })
  return out.sort((a, b) => b.ratio - a.ratio)
}
// Linha do banco que trocou de dono ≥3× em 14 dias (o balde «quicando»).
export function bounceLines(diary: { bank_id: string; at: string; action: string }[], days = 14): { bank_id: string; n: number }[] {
  const since = Date.now() - days * 864e5
  const c = new Map<string, number>()
  for (const r of diary) if (r.action === 'MATCH' && Date.parse(r.at) >= since) c.set(String(r.bank_id), (c.get(String(r.bank_id)) || 0) + 1)
  return [...c.entries()].filter(([, n]) => n >= 3).map(([bank_id, n]) => ({ bank_id, n })).sort((a, b) => b.n - a.n)
}
