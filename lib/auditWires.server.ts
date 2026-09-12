// SERVER-ONLY — O WIRE TEM DONO? (auditoria dos wires da Regions, João, 10/set/2026)
//
// Decisão da noite de 10/set (João, depois do Márcio): TODO lançamento é do robô de e-mail do Márcio (AUTO-BOOK); o motor do
// banco (AUTO-LINK) só casa e audita; o Data Checker AUDITA — mostra a prova e pergunta a gente. Este módulo é SÓ LEITURA:
// nunca casa, nunca escreve, nunca tira taxa de registro nenhum (tirar a taxa do wire é decisão do AUTO-BOOK agora).
//
// Por que existe: o wire sai limpo da Regions ($35,000) e o registro da invoice carrega a taxa dentro ($35,023, extra 23).
// O casamento exato nunca acontece, a linha fica «DINHEIRO» / «É ESTA?» sem dono, e a taxa conta DUAS vezes no DRE: no custo
// do carro e na tarifa da Regions (FEE lança a tarifa em /costs/bank). O regime da taxa, medido no banco:
//   · até 2026-06-15: linha própria «WIRE TRANSFER DOMESTIC OUT F» de $30 no mesmo dia do wire (9 linhas, todas casadas FEE);
//   · desde 2026-06-17: nenhuma linha própria — $23 por wire dentro da «ANALYSIS CHARGE MM-AA» do mês (postada no mês seguinte):
//     jun $93 = 24 + 3×23 · jul $231 = 24 + 9×23 · ago $116 = 24 + 4×23. O módulo RE-CONFERE isso a cada leitura (item REGIME).
// Taxa esperada de um wire: linha OUT F a ±1 dia → o valor dela; senão $23 se a data ≥ 2026-06-17; senão nenhuma (null).
//
// O nome: a Regions escreve «WIRE TRANSFER » + o beneficiário cortado em 14 letras («PARK PLACE MOT», «JOSEPH SALVAGG»).
// Régua final da revisão adversarial (wire-rule-critique p6, 0 falso em 28 pares reais e em 18 beneficiários sintéticos):
// palavra do banco com 2+ letras; prefixo SÓ na última palavra, só quando o beneficiário tem 14+ letras e a palavra 5+; palavra
// genérica (marca de carro, AUTO, MOTORS, LLC, CITY…) não identifica ninguém; apelido do cadastro limpo como o supplierDirectoryFrom
// (corta em « — », descarta prosa com «:», domínio e pedaço > 40); vendedor (seller) só vale com nome E sobrenome.
//
// Tipos de item (amount = dólares em jogo; a prova sempre traz o valor do wire):
//   PAR            wire ⇄ UM registro: nome bate + diferença = taxa esperada + ≤1 dia + único nos dois sentidos → amount = a taxa em dobro
//   SO_TAXA        mesma coisa sem o nome (provável)                                                          → amount = a taxa
//   NOME_DIFERENCA nome bate, diferença de $0,01–$60 que NÃO é a taxa esperada (pergunta)                    → amount = a diferença
//   DIVIDIDO       2–4 registros com o nome (±1 d) somam o wire + taxa, ou o wire exato                      → taxa dentro? a taxa : o wire
//   SOMA_DIFERENTE wire(s) ao mesmo beneficiário (7 d) × registros com o nome (±7 d) com totais diferentes    → amount = a diferença
//   SOMA_IGUAL     idem, totais iguais (com ou sem a taxa dentro)                                             → taxa dentro? as taxas : o total
//   EXATO          registro de valor exato (≤3 d, ou com o nome ≤7 d / sem data) — a pergunta já é do card da Conciliação (informativo)
//   AMBIGUO        vários wires × vários registros com a taxa e o nome não desempata                          → amount = as taxas
//   REGISTRO_LONGE sem registro na data; há registro com o nome a 8–30 dias ou sem data                      → amount = o wire
//   OUTRO_REGISTRO sem registro de invoice; outra tabela (folha, fixo, assets, insumo, estoque, capital, empréstimo) tem o valor exato
//                  (≤3 d, ou com o nome ≤30 d / sem data)                                                    → amount = o wire
//   SEM_REGISTRO   nenhum registro com o nome em ±30 d, nenhum com a taxa do wire (±1 d), nada de mesmo valor nas outras tabelas → o wire
//   TAXA_DENTRO    wire JÁ casado cujo registro soma wire + $0,01–$60 (a taxa ficou dentro: dinheiro em dobro) → amount = a diferença
//   CASADO_DIFERENTE wire já casado cujo registro soma outro valor (alguém editou depois)                     → amount = a diferença
//   REGIME         a ANALYSIS CHARGE do mês não fecha em $24 + $23 × wires sem linha OUT F                   → amount = a diferença
// NÃO é dobro (fica no summary): registro casado EXATO com o wire cujo extra é a taxa (US.047.1: $4,977 + extra $23 = $5,000 ⇄
// wire de $5,000). O total é o que saiu para o vendedor; os $23 da Regions estão só na tarifa de agosto — só o rateio preço/extra
// está torto (o carro custou $5,000, não $4,977 + taxa).
// Registro livre = invoice real (não quote, não balde), não pago por fora da Regions, sem linha do banco viva apontando, não futuro,
// e sem outro meio de pagamento escrito no item (Zelle, PayPal, cartão, cash, cheque — sem a palavra wire). Par recusado (NÃO É ESSE) nunca volta.
// Datas: a do dinheiro é bank_transactions.date (postada); para wire a Regions autoriza e posta no mesmo dia (raw->>authorized_date).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchAll, num, isFee, twinKey, signedDays } from './bankReconcile.server'
import { supplierDirectoryFrom, matchSupplier, normSup } from './supplierMatch'

export type AuditRef = { table: string; id: string; label: string; href?: string | null }
export type AuditItem = { key: string; kind: string; title: string; amount: number; date: string | null; refs: AuditRef[]; evidence: string }
export type WireAudit = { items: AuditItem[]; summary: Record<string, number | string> }
// others = registros de OUTRAS tabelas com o valor exato de um wire ainda sem dono (segunda leitura, só quando precisa):
// { table, id, label, supplier, text, amount, date, href, paid_from, paid_to, bank_transaction_id, payment_reference }.
export type WireAuditData = { bank: any[]; ie: any[]; invoices: any[]; suppliers: any[]; aliases: any[]; fixed: any[]; fixedSuppliers: any[]; today: string; others?: any[]; othersChecked?: boolean }

export const WIRE_FEE_MAX = 60, WIRE_ROW_MIN = 500, WIRE_DAYS = 1, WIRE_SUM_DAYS = 7, WIRE_NAME_DAYS = 30, WIRE_EXACT_DAYS = 3
export const WIRE_FEE_FLAT_SINCE = '2026-06-17', WIRE_FEE_FLAT = 23, ANALYSIS_BASE = 24
export const WIRE_GENERIC = new Set(['AUTO', 'AUTOS', 'SALES', 'MOTOR', 'MOTORS', 'MOT', 'MOTORSPORT', 'MOTORSPORTS', 'AUTOMOTIVE', 'LLC', 'LL', 'INC', 'LTD', 'CORP', 'CO', 'GROUP', 'CITY', 'CENTER', 'CENTRAL', 'DODGE', 'CHRYSLER', 'JEEP', 'RAM', 'CDJR', 'FORD', 'CHEVROLET', 'CHEVY', 'TOYOTA', 'RACING', 'PERFORMANCE', 'PARTS', 'SPEED', 'SHOP', 'SERVICE', 'SERVICES', 'SUPPLY', 'DIST', 'DISTRIBUTORS', 'ENTERPRISES', 'HOLDINGS', 'INTERNATIONAL', 'INTL', 'USA', 'AMERICA', 'AMERICAN', 'CAR', 'CARS', 'DEALER', 'FINANCE', 'FINANCIAL', 'CAPITAL', 'BANK', 'TITLE', 'THE', 'AND', 'OF', 'GZ28', 'V8', 'SPEEDSHOP', 'TX', 'FL', 'CA', 'AZ', 'MA', 'NA', 'HIGH', 'BEST', 'FIRST', 'TOP', 'NEW', 'PRO', 'GREAT', 'BIG', 'ALL', 'ONE'])
const OUT_F_RE = /WIRE TRANSFER DOMESTIC OUT F/i
const CHARGE_RE = /ANALYSIS CHARGE\s*(\d{2})-(\d{2})/i
const OTHER_CHANNEL_RE = /\b(zelle|paypal|venmo|cash ?app|cash|cart[aã]o|card|cheque|check)\b/i   // registro que diz outro meio de pagamento
const BR_PAID = new Set(['GZ28BR'])   // a régua do candidatePool (brPaid): pagou por fora da Regions — sócio e cliente saíram do vocabulário em 11/set
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

const r2 = (n: number) => Math.round(n * 100) / 100
const day = (s: any) => String(s || '').slice(0, 10)
const okDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)
const dd = (a: string, b: string) => Math.abs(signedDays(day(a), day(b)))
const usd = (n: number) => '$' + r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dm = (s: any) => { const d = day(s); return okDate(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : 'sem data' }
const mes = (ym: string) => `${MES[Number(ym.slice(5, 7)) - 1] || ym.slice(5, 7)}/${ym.slice(0, 4)}`
const cut = (s: any, n: number) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const ieAmt = (e: any) => num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)   // a conta do app inteiro (lib/financials expLine)
const nowrap = (xs: string[]) => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' e ' + xs[xs.length - 1]

export const payeeOf = (name: any) => String(name || '').replace(/^\s*wire transfer\s*/i, '').trim()
const toks = (s: string) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
export type WireReg = { id?: string; name: string; aliases: string | null; seller: string | null }

// O nome do banco bate com o registro? (régua final p6 — ver cabeçalho). aliasWords = palavras de bank_aliases cujo padrão casa o wire.
export function wireNameHit(wireName: string, row: { supplier?: string | null; item?: string | null }, reg: WireReg | null, aliasWords: string[] = []): { hit: boolean; hits: string[] } {
  const payee = payeeOf(wireName), wt = toks(payee).filter(t => t.length >= 2)
  const truncated = payee.length >= 14
  const pieces = reg?.aliases ? String(reg.aliases).split(/[\n,]/).map(x => x.split(' — ')[0].replace(/["[\]]/g, '')).filter(p => normSup(p).length <= 40 && !/:/.test(p) && !/\.(com|net|org)\b/i.test(p)) : []
  const main = toks([row.supplier, row.item, reg?.name, ...pieces, ...aliasWords].filter(Boolean).join(' '))
  const seller = toks(String(reg?.seller || '').replace(/\([^)]*\)/g, ' '))
  const bare = (x: string) => x.replace('…', '')
  const hitIn = (words: string[]) => {
    const set = new Set(words)
    return wt.map((t, i) => {
      if (set.has(t)) return t
      if (!(i === wt.length - 1 && truncated && t.length >= 5)) return null
      const comp = words.find(w => w.length > t.length && w.startsWith(t) && !WIRE_GENERIC.has(w)) || words.find(w => w.length > t.length && w.startsWith(t))
      return comp ? (WIRE_GENERIC.has(comp) ? comp : t) + '…' : null
    }).filter((x): x is string => !!x)
  }
  const judge = (h: string[]) => { const d = h.filter(x => !WIRE_GENERIC.has(bare(x))); return d.length > 0 && (d.some(x => bare(x).length >= 4) || h.length >= 2) }
  const hm = hitIn(main), hs = hitIn(seller)
  const sellerOk = hs.filter(x => !WIRE_GENERIC.has(bare(x))).length >= 2   // pessoa precisa de nome + sobrenome
  return { hit: judge(hm) || sellerOk, hits: [...hm, ...(sellerOk ? hs.map(x => 'seller:' + x) : [])] }
}

// Taxa esperada do wire: linha OUT F a ±1 dia (valor dela; valores diferentes = null) → senão $23 desde 17/jun → senão null.
export function wireExpectedFee(date: string, outF: any[]): { fee: number | null; src: 'OUT_F' | 'FLAT' | null; line: any | null } {
  const near = outF.filter(x => dd(x.date, date) <= WIRE_DAYS).sort((a, b) => dd(a.date, date) - dd(b.date, date))
  if (near.length) { const amts = new Set(near.map(x => r2(num(x.amount)))); return amts.size === 1 ? { fee: r2(num(near[0].amount)), src: 'OUT_F', line: near[0] } : { fee: null, src: null, line: null } }
  return day(date) >= WIRE_FEE_FLAT_SINCE ? { fee: WIRE_FEE_FLAT, src: 'FLAT', line: null } : { fee: null, src: null, line: null }
}

export async function auditWires(db: any): Promise<WireAudit> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const BSEL = 'id, item_id, plaid_id, date, amount, name, pending, match_status, matched_table, matched_id, match_engine, category, authorized_date:raw->>authorized_date'
  const notRemoved = (q: any) => q.neq('match_status', 'REMOVED')   // a mesma régua do itemTwinKeys
  const bankQ = fetchAll(db, 'bank_transactions', BSEL + ', doubt_answered', notRemoved)
    .catch((e: any) => /doubt_answered/.test(String(e?.message)) ? fetchAll(db, 'bank_transactions', BSEL, notRemoved) : Promise.reject(e))
  // bank_aliases pode não existir (o motor também segue sem ela — loadDbAliases); o resto sobe o erro.
  const aliasQ = Promise.resolve(db.from('bank_aliases').select('pattern, words, not_pattern')).then((r: any) => (r && !r.error && r.data) || [], () => [])
  const [bank, ie, invoices, suppliers, aliases, fixedSuppliers] = await Promise.all([
    bankQ,
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, paid_from, paid_to, purchase_group'),
    fetchAll(db, 'invoices', 'id, invoice_code, is_quote, origin, ride_id'),
    fetchAll(db, 'suppliers', 'id, name, aliases, seller'),
    aliasQ,
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, cost_type'),
  ])
  // Só as tarifas que as linhas de taxa apontam (prova de que a taxa JÁ está lançada) — segunda leitura, pequena.
  const feeIds = [...new Set(bank.filter((l: any) => l.matched_table === 'fixed_cost_expenses' && l.matched_id && (OUT_F_RE.test(String(l.name || '')) || CHARGE_RE.test(String(l.name || '')))).map((l: any) => String(l.matched_id)))]
  const fixed = feeIds.length ? await fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date', (q: any) => q.in('id', feeIds)) : []
  const base: WireAuditData = { bank, ie, invoices, suppliers, aliases, fixed, fixedSuppliers, today }
  const first = computeWireAudit(base)
  // «Sem dono» só depois de olhar as outras tabelas: wire sem registro de invoice pode ser folha, custo fixo, bem, insumo, estoque,
  // retirada de capital ou parcela de empréstimo. Busca pelo valor exato (só dos wires que sobraram) e recalcula.
  const loose = new Set(first.items.filter(i => i.kind === 'SEM_REGISTRO' || i.kind === 'REGISTRO_LONGE').flatMap(i => i.refs.filter(r => r.table === 'bank_transactions').map(r => r.id)))
  if (!loose.size) return first
  const amts = [...new Set(bank.filter((l: any) => loose.has(String(l.id))).map((l: any) => r2(num(l.amount))))]
  const others = await loadOthers(db, amts, fixedSuppliers)
  return computeWireAudit({ ...base, others, othersChecked: true })
}

async function loadOthers(db: any, amts: number[], fixedSuppliers: any[]): Promise<any[]> {
  const missing = (e: any) => /does not exist|schema cache|PGRST205|42P01/.test(String(e?.message || e))
  const q = (table: string, sel: string, col: string, fallback?: string): Promise<any[]> => fetchAll(db, table, sel, (x: any) => x.in(col, amts))
    .catch((e: any) => fallback && /bank_transaction_id/.test(String(e?.message)) ? fetchAll(db, table, fallback, (x: any) => x.in(col, amts)) : missing(e) ? [] : Promise.reject(e))
  const [ex, fx, gd, ge, inp, inv, capEv, finEv] = await Promise.all([
    q('staff_expenses', 'id, description, type, amount, payment_date, expense_date, paid_from, paid_to, origin, payment_reference, bank_transaction_id', 'amount', 'id, description, type, amount, payment_date, expense_date, paid_from, paid_to, origin, payment_reference'),
    q('fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date, expense_date, paid_from, bank_transaction_id', 'amount'),
    q('assets', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, paid_from', 'unit_price'),
    q('assets_expenses', 'id, description, supplier, amount, payment_date, expense_date, paid_from', 'amount'),
    q('inputs', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, paid_from', 'unit_price'),
    q('inventory', 'id, description, supplier, source_type, unit_price, quantity, payment_date, purchase_date, paid_from', 'unit_price'),
    q('capital_events', 'id, event_date, kind, member, amount, description', 'amount'),
    q('financing_events', 'id, event_date, kind, amount, description', 'amount'),
  ])
  const supName = new Map(fixedSuppliers.map((s: any) => [String(s.id), s]))
  const qty = (r: any) => num(r.unit_price) * (num(r.quantity) || 1)
  // hrefs e selos: os mesmos do candidatePool (lib/bankReconcile.server.ts)
  return [
    ...ex.map((x: any) => ({ table: 'staff_expenses', id: x.id, label: `${x.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${cut(x.description || x.type, 60)}`, supplier: null, text: x.description, amount: num(x.amount), date: x.payment_date, href: '/staff', paid_from: x.paid_from, paid_to: x.paid_to, bank_transaction_id: x.bank_transaction_id || null, payment_reference: x.payment_reference || null })),
    ...fx.map((f: any) => { const s: any = supName.get(String(f.supplier_id)); const tarifa = s?.cost_type === 'BANK'; return { table: 'fixed_cost_expenses', id: f.id, label: `${tarifa ? 'TARIFA' : 'FIXO'} · ${s?.company || ''} · ${cut(f.description, 50)}`, supplier: s?.company || null, text: f.description, amount: num(f.amount), date: f.payment_date, href: tarifa ? '/costs/bank' : f.supplier_id ? '/costs/fixed/' + f.supplier_id : '/costs/fixed', paid_from: f.paid_from, bank_transaction_id: f.bank_transaction_id || null } }),
    ...gd.map((g: any) => ({ table: 'assets', id: g.id, label: `GOODS · ${cut(g.description, 50)}${g.supplier ? ' · ' + g.supplier : ''}`, supplier: g.supplier, text: g.description, amount: qty(g), date: g.payment_date, href: '/goods', paid_from: g.paid_from })),
    ...ge.map((g: any) => ({ table: 'assets_expenses', id: g.id, label: `GOODS · ${cut(g.description, 50)}${g.supplier ? ' · ' + g.supplier : ''}`, supplier: g.supplier, text: g.description, amount: num(g.amount), date: g.payment_date, href: '/goods', paid_from: g.paid_from })),
    ...inp.map((x: any) => ({ table: 'inputs', id: x.id, label: `SUPPLY · ${cut(x.description, 50)}${x.supplier ? ' · ' + x.supplier : ''}`, supplier: x.supplier, text: x.description, amount: qty(x), date: x.payment_date, href: '/supplies', paid_from: x.paid_from })),
    ...inv.filter((x: any) => x.source_type === 'PURCHASED').map((x: any) => ({ table: 'inventory', id: x.id, label: `STOCK · ${cut(x.description, 50)}${x.supplier ? ' · ' + x.supplier : ''}`, supplier: x.supplier, text: x.description, amount: qty(x), date: x.payment_date, href: '/inventory', paid_from: x.paid_from })),
    ...capEv.filter((c: any) => c.kind !== 'CONTRIBUTION').map((c: any) => ({ table: 'capital_events', id: c.id, label: `CAPITAL · RETIRADA · ${c.member || ''}${c.description ? ' · ' + cut(c.description, 40) : ''}`, supplier: c.member, text: c.description, amount: num(c.amount), date: c.event_date, href: '/adm/financials' })),
    ...finEv.filter((e: any) => e.kind !== 'DISBURSEMENT').map((e: any) => ({ table: 'financing_events', id: e.id, label: `EMPRÉSTIMO · ${e.kind}${e.description ? ' · ' + cut(e.description, 40) : ''}`, supplier: null, text: e.description, amount: num(e.amount), date: e.event_date, href: '/adm/financials' })),
  ]
}

// PURO: calcula tudo dos dados já lidos (testável sem banco).
export function computeWireAudit(data: WireAuditData): WireAudit {
  const { bank, ie, invoices, suppliers, aliases, fixed, fixedSuppliers, today } = data
  const items: AuditItem[] = []
  const wiresBy = new Map<string, { n: number; usd: number }>()
  let dobroCerto = 0, dobroProvavel = 0, dobroPendente = 0   // pendente = a tarifa do mês ainda não postou (o dobro nasce quando postar)
  const push = (it: AuditItem, ws: any[] = []) => { items.push(it); const s = wiresBy.get(it.kind) || { n: 0, usd: 0 }; s.n += ws.length; s.usd = r2(s.usd + ws.reduce((a, w) => a + num(w.amount), 0)); wiresBy.set(it.kind, s) }
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  // ── índices: invoices, tarifas, gêmeas do feed, o que já está casado ──
  const invById = new Map<string, any>(invoices.map((i: any) => [String(i.id), i]))
  const realInv = (id: any) => { const i = invById.get(String(id)); return !!i && !i.is_quote && i.origin !== 'BUCKET' }
  const invHref = (id: any) => { const i = invById.get(String(id)); if (i && i.origin === 'BUCKET') return '/adm/bank#a-atribuir'; return i && i.ride_id ? `/rides/${i.ride_id}/invoices/${id}` : '/adm/reports' }   // o mesmo do candidatePool
  const code = (e: any) => invById.get(String(e.invoice_id))?.invoice_code || '—'
  const ieById = new Map<string, any>(ie.map((e: any) => [String(e.id), e]))
  const fixById = new Map<string, any>(fixed.map((f: any) => [String(f.id), f]))
  const bankSup = new Set(fixedSuppliers.filter((s: any) => s.cost_type === 'BANK').map((s: any) => String(s.id)))
  const seen = new Map<string, Set<string>>()   // gêmea do feed = mesma chave vista por duas fontes (a régua do itemTwinKeys)
  for (const l of bank) { const k = twinKey(l); const src = String(l.plaid_id || '').startsWith('stmt:') ? 'stmt' : String(l.item_id || '?'); if (!seen.has(k)) seen.set(k, new Set()); seen.get(k)!.add(src) }
  const twin = (l: any) => (seen.get(twinKey(l))?.size || 0) >= 2
  const taken = new Set<string>(bank.filter((l: any) => l.matched_id).map((l: any) => l.matched_table + ':' + l.matched_id))
  const takenGroups = new Set([...taken].filter(k => k.startsWith('purchase_group:')).map(k => k.slice('purchase_group:'.length)))
  const posted = bank.filter((l: any) => !l.pending && num(l.amount) > 0)
  const outF = posted.filter((l: any) => OUT_F_RE.test(String(l.name || '')))
  const byDate = (a: any, b: any) => day(a.date).localeCompare(day(b.date)) || num(a.amount) - num(b.amount)
  const wiresAll = posted.filter((l: any) => /WIRE TRANSFER/i.test(String(l.name || '')) && !isFee(l)).sort(byDate)
  const openAll = wiresAll.filter((l: any) => ['NEW', 'QUEUED'].includes(String(l.match_status)))
  // Gêmea do feed (a mesma linha por duas conexões): o motor pula as DUAS (buildPlan «gêmeo em outra conexão»); a auditoria não
  // pode calar o wire — confere UMA vez (a do Plaid antes da do extrato), e nenhuma se a gêmea já está casada (o dinheiro tem dono).
  const matchedKeys = new Set(wiresAll.filter((l: any) => l.match_status === 'MATCHED').map((l: any) => twinKey(l)))
  const twinKeep = new Map<string, any>()
  const stmtFirst = (a: any, b: any) => (String(a.plaid_id || '').startsWith('stmt:') ? 1 : 0) - (String(b.plaid_id || '').startsWith('stmt:') ? 1 : 0) || String(a.id).localeCompare(String(b.id))
  const open = openAll.filter((l: any) => { if (!twin(l)) return true; const k = twinKey(l); if (!matchedKeys.has(k) && (!twinKeep.has(k) || stmtFirst(l, twinKeep.get(k)) < 0)) twinKeep.set(k, l); return false })
  open.push(...twinKeep.values()); open.sort(byDate)
  const charges = new Map<string, any[]>()
  for (const l of posted) { const m = String(l.name || '').match(CHARGE_RE); if (m) { const ym = `20${m[2]}-${m[1]}`; charges.set(ym, [...(charges.get(ym) || []), l]) } }

  // ── cadastro e nome ──
  const dir = supplierDirectoryFrom(suppliers.map((s: any) => ({ name: s.name, aliases: s.aliases })))
  const regByName = new Map<string, any>(suppliers.map((s: any) => [s.name, s]))
  const regCache = new Map<string, any>()
  const regOf = (sup: any) => { const k = String(sup || ''); if (!regCache.has(k)) { const m = matchSupplier(k, dir); regCache.set(k, m ? regByName.get(m.name) || null : null) } return regCache.get(k) }
  const aliasRx = aliases.map((a: any) => { try { return { re: new RegExp(a.pattern, 'i'), words: String(a.words || '').split(','), not: a.not_pattern ? new RegExp(a.not_pattern, 'i') : null } } catch { return null } }).filter(Boolean) as any[]

  // ── registros livres: invoice real (não quote, não balde), não pago por fora, não casado por linha viva, não futuro ──
  const brPaid = (e: any) => BR_PAID.has(String(e.paid_from || '')) || e.paid_to === 'GZ28BR'
  type Row = { e: any; id: string; amount: number; date: string | null; label: string; tl: string; ref: AuditRef }
  const rows: Row[] = []
  for (const e of ie) {
    if (!realInv(e.invoice_id) || brPaid(e) || taken.has('invoice_expenses:' + e.id) || (e.purchase_group && takenGroups.has(String(e.purchase_group)))) continue
    const amount = r2(ieAmt(e)); if (amount < 0.005) continue
    const date = okDate(e.payment_date) ? day(e.payment_date) : null
    if (date && date > today) continue
    const label = `${code(e)} · ${cut(e.supplier, 40)} · ${cut(e.item, 60)}`
    rows.push({ e, id: String(e.id), amount, date, label, tl: `${code(e)} · ${cut(e.supplier, 28)} · ${cut(e.item, 48)}`, ref: { table: 'invoice_expenses', id: String(e.id), label: label + ' · ' + usd(amount), href: invHref(e.invoice_id) } })
  }
  const linkedLines = new Set<string>(bank.filter((l: any) => l.matched_id).map((l: any) => String(l.id)))
  const others = (data.others || []).filter((o: any) => !taken.has(o.table + ':' + o.id) && !brPaid(o) && !(o.bank_transaction_id && linkedLines.has(String(o.bank_transaction_id))) && !(String(o.payment_reference || '').startsWith('bank:') && linkedLines.has(String(o.payment_reference).slice(5))))
    .map((o: any) => ({ ...o, amount: r2(num(o.amount)), date: okDate(o.date) ? day(o.date) : null })).filter((o: any) => o.amount > 0.005 && !(o.date && o.date > today))
  const nameOther = (w: any, o: any) => wireNameHit(String(w.name || ''), { supplier: o.supplier, item: o.text }, regOf(o.supplier))
  const nameCache = new Map<string, { hit: boolean; hits: string[] }>()
  const nameOf = (w: any, r: Row) => {
    const k = w.name + '|' + r.id
    if (!nameCache.has(k)) { const txt = String(r.e.supplier || '') + ' ' + String(r.e.item || ''); const aw = aliasRx.filter(a => a.re.test(String(w.name || '')) && !(a.not && a.not.test(txt))).flatMap(a => a.words); nameCache.set(k, wireNameHit(String(w.name || ''), r.e, regOf(r.e.supplier), aw)) }
    return nameCache.get(k)!
  }

  // ── textos e provas ──
  const bankRef = (l: any): AuditRef => ({ table: 'bank_transactions', id: String(l.id), label: `${cut(l.name, 44)} · ${dm(l.date)} · ${usd(Math.abs(num(l.amount)))}`, href: '/adm/bank' })
  const recRef = (l: any): AuditRef | null => {
    if (!l || l.match_status !== 'MATCHED' || !l.matched_id) return null
    if (l.matched_table === 'fixed_cost_expenses') { const f = fixById.get(String(l.matched_id)); return { table: 'fixed_cost_expenses', id: String(l.matched_id), label: f ? `TARIFA · ${cut(f.description, 50)} · ${usd(num(f.amount))}` : 'TARIFA', href: f && bankSup.has(String(f.supplier_id)) ? '/costs/bank' : f?.supplier_id ? '/costs/fixed/' + f.supplier_id : '/costs/fixed' } }
    if (l.matched_table === 'invoice_expenses') { const e = ieById.get(String(l.matched_id)); return { table: 'invoice_expenses', id: String(l.matched_id), label: e ? `${code(e)} · ${cut(e.item, 50)} · ${usd(ieAmt(e))}` : 'registro da invoice', href: e ? invHref(e.invoice_id) : null } }
    return { table: String(l.matched_table), id: String(l.matched_id), label: String(l.matched_table), href: null }
  }
  const expMemo = new Map<string, ReturnType<typeof wireExpectedFee>>()
  const exp = (w: any) => { const k = String(w.id); if (!expMemo.has(k)) expMemo.set(k, wireExpectedFee(day(w.date), outF)); return expMemo.get(k)! }
  // Regime do mês: $24 + $23 × wires do mês sem linha OUT F (gêmeas contam uma vez).
  const monthWires = (ym: string) => { const ks = new Set<string>(); return wiresAll.filter((w: any) => { if (!day(w.date).startsWith(ym)) return false; const k = twinKey(w); if (ks.has(k)) return false; ks.add(k); return true }) }
  const regime = (ym: string) => { const ws = monthWires(ym); const n = ws.filter((w: any) => exp(w).src !== 'OUT_F').length; const lines = charges.get(ym) || []; const amts = [...new Set(lines.map((l: any) => r2(num(l.amount))))]; return { ws, n, expected: r2(ANALYSIS_BASE + WIRE_FEE_FLAT * n), line: lines[0] || null, amts, amount: amts.length === 1 ? amts[0] : null } }
  const feeProof = (w: any): { where: string; posted: boolean; refs: AuditRef[]; text: string } => {
    const x = exp(w)
    if (x.src === 'OUT_F') { const rec = recRef(x.line); return { where: `linha de tarifa «WIRE TRANSFER DOMESTIC OUT F» de ${dm(x.line.date)}`, posted: true, refs: [bankRef(x.line), ...(rec ? [rec] : [])], text: `A Regions cobrou ${usd(num(x.line.amount))} em linha própria em ${dm(x.line.date)}${x.line.match_status === 'MATCHED' ? ', já lançada' : ' (ainda sem casar)'}.` } }
    const ym = day(w.date).slice(0, 7), g = regime(ym)
    if (!g.line) return { where: `tarifa mensal de ${mes(ym)}`, posted: false, refs: [], text: `A tarifa mensal de ${mes(ym)} ainda não postou; o mês tem hoje ${g.n} wire(s) sem linha OUT F, então a Regions deve cobrar ${usd(g.expected)} (${usd(ANALYSIS_BASE)} + ${g.n} × ${usd(WIRE_FEE_FLAT)}).` }
    const rec = recRef(g.line), ok = g.amount != null && Math.abs(g.amount - g.expected) < 0.005
    return { where: `tarifa mensal de ${mes(ym)}`, posted: true, refs: [bankRef(g.line), ...(rec ? [rec] : [])], text: `A ${cut(g.line.name, 22)} (${dm(g.line.date)}) cobrou ${usd(num(g.line.amount))}${ok ? ` = ${usd(ANALYSIS_BASE)} + ${g.n} × ${usd(WIRE_FEE_FLAT)}, um deles este wire` : `, que não fecha em ${usd(ANALYSIS_BASE)} + ${g.n} × ${usd(WIRE_FEE_FLAT)} = ${usd(g.expected)} (ver REGIME)`}${g.line.match_status === 'MATCHED' ? ', já lançada como tarifa' : ''}.` }
  }
  const twice = (p: { where: string; posted: boolean }) => p.posted ? `também está na ${p.where} — contada duas vezes` : `vai entrar de novo na ${p.where} quando ela postar — contada duas vezes`
  const wLab = (w: any) => `o wire de ${usd(num(w.amount))} para «${payeeOf(w.name)}» (${dm(w.date)})`
  const keyOf = (kind: string, ws: any[], rs: { id: string }[] = []) => [kind, ws.map(w => String(w.id)).sort().join(','), rs.map(r => r.id).sort().join(',')].filter(Boolean).join('|')
  const short = (r: Row) => `«${r.label.split(' · ')[0]} · ${cut(r.e.item, 40)}»`
  const rowBreak = (r: Row) => { const q = num(r.e.quantity) || 1, parts = (q !== 1 ? ' × ' + q : '') + (num(r.e.tax) ? ' + tax ' + usd(num(r.e.tax)) : '') + (num(r.e.extra) ? ' + extra ' + usd(num(r.e.extra)) : ''); return `${r.label.split(' · ')[0]} = ${parts ? usd(num(r.e.price)) + parts + ' = ' : ''}${usd(r.amount)}, pago ${dm(r.date)}` }
  const wireTxt = (w: any) => `Banco: «${cut(w.name, 44)}» ${usd(num(w.amount))} postado em ${dm(w.date)}${w.authorized_date && day(w.authorized_date) !== day(w.date) ? ` (autorizado em ${dm(w.authorized_date)})` : ''}${w.match_status === 'QUEUED' ? ', na fila (QUEUED)' : ''}`
  const used = new Set<string>(), done = new Set<string>()
  // Registro que diz outro meio (Zelle, PayPal, cartão, cash, cheque) e não diz «wire» nunca é dono de wire (ensaio: o depósito
  // Zelle de $4,950 da R & A a 7 dias virava «soma diferente» do wire de $23,050). Só a lista do que o card da Conciliação oferece o mostra.
  const wireable = (r: Row) => { const t = String(r.e.item || ''); return !(OTHER_CHANNEL_RE.test(t) && !/\bwire\b/i.test(t)) }
  const exactRows = (w: any) => rows.filter(r => !used.has(r.id) && Math.abs(r.amount - r2(num(w.amount))) < 0.011)

  // ── 1 · arestas wire ⇄ registro: diferença de $0,01–$60, ±1 dia, par não recusado; só vale com nome OU a taxa esperada ──
  const refusedOf = (w: any) => { const da = w.doubt_answered && typeof w.doubt_answered === 'object' ? w.doubt_answered : {}; return new Set<string>([...(Array.isArray(da.cands) ? da.cands : []), ...(da.cand ? [da.cand] : [])].map(String)) }
  type Edge = { w: any; r: Row; fee: number; d: number; name: { hit: boolean; hits: string[] }; feeOk: boolean }
  const edges: Edge[] = [], coincid = new Map<string, Edge[]>()
  for (const w of open) {
    const wa = r2(num(w.amount)), rej = refusedOf(w), x = exp(w)
    for (const r of rows) {
      if (!r.date || r.amount < WIRE_ROW_MIN || rej.has('invoice_expenses:' + r.id) || !wireable(r)) continue
      const fee = r2(r.amount - wa), d = dd(r.date, w.date)
      if (!(fee > 0.009 && fee <= WIRE_FEE_MAX) || d > WIRE_DAYS) continue
      const e: Edge = { w, r, fee, d, name: nameOf(w, r), feeOk: x.fee != null && Math.abs(fee - x.fee) < 0.005 }
      if (e.name.hit || e.feeOk) edges.push(e); else coincid.set(String(w.id), [...(coincid.get(String(w.id)) || []), e])
    }
  }
  // ── 2 · componentes bipartidos: 1×1, ou k×k com casamento perfeito pelo nome; o resto é AMBIGUO ──
  const P = new Map<string, string>()
  const find = (k: string): string => { const p = P.get(k) ?? k; if (p === k) { P.set(k, k); return k } const q = find(p); P.set(k, q); return q }
  for (const e of edges) { const a = find('w' + e.w.id), b = find('r' + e.r.id); if (a !== b) P.set(a, b) }
  const comps = new Map<string, Edge[]>()
  for (const e of edges) { const k = find('w' + e.w.id); comps.set(k, [...(comps.get(k) || []), e]) }
  const pairs: Edge[] = []
  for (const E of comps.values()) {
    const W = [...new Map(E.map(e => [String(e.w.id), e.w])).values()].sort(byDate), R = [...new Map(E.map(e => [e.r.id, e.r])).values()]
    const ne = E.filter(e => e.name.hit)
    const one = (e: Edge) => ne.filter(x => x.w === e.w).length === 1 && ne.filter(x => x.r === e.r).length === 1
    if (W.length === 1 && R.length === 1) { pairs.push(E[0]); continue }
    if (W.length === R.length && ne.length === W.length && ne.every(one)) { pairs.push(...ne); continue }
    W.forEach(w => done.add(String(w.id))); R.forEach(r => used.add(r.id))
    const fees = r2(W.reduce((s, w) => s + (exp(w).fee ?? Math.max(...E.filter(e => e.w === w).map(e => e.fee))), 0))
    push({ key: keyOf('AMBIGUO', W, R), kind: 'AMBIGUO', title: `${W.length} wire(s) e ${R.length} registro(s) com a diferença da taxa no mesmo dia (${nowrap([...new Set(W.map(w => '«' + payeeOf(w.name) + '»'))])}): o nome não desempata qual registro é de qual wire.`, amount: fees, date: day(W[0].date), refs: [...W.map(bankRef), ...R.map(r => r.ref)], evidence: E.map(e => `${usd(num(e.w.amount))} de ${dm(e.w.date)} ⇄ ${short(e.r)} ${usd(e.r.amount)} (diferença ${usd(e.fee)}${e.name.hit ? ', nome ' + e.name.hits.join('+') : ', sem nome'})`).join('; ') + '.' }, W)
  }
  for (const e of pairs) { done.add(String(e.w.id)); used.add(e.r.id) }
  for (const e of pairs) {
    const w = e.w, x = exp(w), wa = r2(num(w.amount)), p = feeProof(w)
    const rivals = exactRows(w).filter(r => r.date && dd(r.date, w.date) <= WIRE_SUM_DAYS && nameOf(w, r).hit)
    const offered = exactRows(w).filter(r => !rivals.includes(r) && (!r.date || dd(r.date, w.date) <= WIRE_NAME_DAYS))   // o que o rank() do card oferece (valor exato, ≤30 d ou sem data)
    const list = (rs: Row[], named: boolean) => rs.slice(0, 2).map(r => `${short(r)} (${r.date ? dm(r.date) : 'sem data'}${named ? '' : nameOf(w, r).hit ? ', com o nome' : ', sem o nome'})`).join(' e ')
    const tail = (rivals.length ? ` Atenção: ${list(rivals, true)} tem o valor exato do wire e o mesmo nome a até ${WIRE_SUM_DAYS} dias — um dos dois registros pode estar em dobro.` : '') + (offered.length ? ` O card da Conciliação oferece ${list(offered, false)} com os mesmos ${usd(wa)}: a data não fecha com este wire.` : '')
    const base = `${wireTxt(w)}; registro ${rowBreak(e.r)} (${e.d} d).`
    if (e.name.hit && e.feeOk) {
      dobroCerto += e.fee; if (!p.posted) dobroPendente += e.fee
      push({ key: keyOf('PAR', [w], [e.r]), kind: 'PAR', title: `${cap(wLab(w))} é o registro «${e.r.tl}» (${usd(e.r.amount)}): a diferença de ${usd(e.fee)} é a taxa da Regions, que ${twice(p)}.`, amount: e.fee, date: day(w.date), refs: [bankRef(w), e.r.ref, ...p.refs], evidence: `${base} O nome bate em ${e.name.hits.join(', ')}. ${p.text}${tail}` }, [w])
    } else if (e.feeOk) {
      dobroProvavel += e.fee
      const reg = regOf(e.r.e.supplier)
      push({ key: keyOf('SO_TAXA', [w], [e.r]), kind: 'SO_TAXA', title: `${cap(wLab(w))} provavelmente é o registro «${e.r.tl}» (${usd(e.r.amount)}): a diferença de ${usd(e.fee)} é a taxa da Regions, mas o nome do banco não confirma o registro.`, amount: e.fee, date: day(w.date), refs: [bankRef(w), e.r.ref, ...p.refs], evidence: `${base} Nenhuma palavra de «${payeeOf(w.name)}» aparece no fornecedor, no item nem no cadastro${reg ? ' «' + reg.name + '»' : ' (fornecedor sem cadastro)'}; o par é único nos dois sentidos. ${p.text}${tail}` }, [w])
    } else {
      push({ key: keyOf('NOME_DIFERENCA', [w], [e.r]), kind: 'NOME_DIFERENCA', title: `${cap(wLab(w))} tem o nome do registro «${e.r.tl}» (${usd(e.r.amount)}), mas a diferença de ${usd(e.fee)} não é a taxa da Regions ${x.fee != null ? `(${usd(x.fee)} nesta data)` : '(nesta data não há taxa conhecida)'} — o que são esses ${usd(e.fee)}?`, amount: e.fee, date: day(w.date), refs: [bankRef(w), e.r.ref], evidence: `${base} O nome bate em ${e.name.hits.join(', ')}. ${x.src ? p.text : 'Antes de 17/06/2026 a taxa vinha em linha OUT F no mesmo dia, e não há nenhuma a ±1 dia deste wire.'}${tail}` }, [w])
    }
  }

  // ── 3 · EXATO: registro de valor exato (≤3 d; com o nome ≤7 d ou sem data). A pergunta é do card da Conciliação — aqui só informa. ──
  const exato = open.filter(w => !done.has(String(w.id))).map(w => ({ w, ex: exactRows(w).filter(r => !refusedOf(w).has('invoice_expenses:' + r.id)).filter(r => r.date ? dd(r.date, w.date) <= WIRE_EXACT_DAYS || (dd(r.date, w.date) <= WIRE_SUM_DAYS && nameOf(w, r).hit) : nameOf(w, r).hit) })).filter(x => x.ex.length)
  for (const { w, ex } of exato) {
    done.add(String(w.id)); ex.forEach(r => used.add(r.id))
    const x = exp(w)
    push({ key: keyOf('EXATO', [w], ex), kind: 'EXATO', title: `${cap(wLab(w))} tem ${ex.length === 1 ? 'um registro' : ex.length + ' registros'} de valor exato — ${ex.slice(0, 3).map(r => short(r)).join(' ou ')}: a pergunta já está no card da Conciliação.`, amount: r2(num(w.amount)), date: day(w.date), refs: [bankRef(w), ...ex.slice(0, 4).map(r => r.ref)], evidence: `${wireTxt(w)}; ${ex.slice(0, 4).map(r => `${short(r)} ${usd(r.amount)} ${r.date ? 'pago ' + dm(r.date) + ' (' + dd(r.date, w.date) + ' d)' : 'sem data'}, ${nameOf(w, r).hit ? 'nome bate (' + nameOf(w, r).hits.join('+') + ')' : 'sem o nome'}`).join('; ')}. A taxa ${x.src === 'OUT_F' ? `veio em linha própria (${usd(x.fee || 0)})` : x.src === 'FLAT' ? `de ${usd(WIRE_FEE_FLAT)} está na tarifa mensal` : 'não é conhecida nesta data'} e não está dentro desses registros: nada em dobro, falta só o dono.` }, [w])
  }

  // ── 4 · DIVIDIDO: 2–4 registros com o nome (±1 d) somam o wire + a taxa esperada, ou o wire exato ──
  for (const w of open) {
    if (done.has(String(w.id))) continue
    const wa = r2(num(w.amount)), x = exp(w)
    const rej = refusedOf(w), cands = rows.filter(r => !used.has(r.id) && !rej.has('invoice_expenses:' + r.id) && wireable(r) && r.date && dd(r.date, w.date) <= WIRE_DAYS && r.amount < wa + (x.fee || 0) && nameOf(w, r).hit).slice(0, 12)
    if (cands.length < 2) continue
    const targets = [...(x.fee != null ? [{ t: r2(wa + x.fee), fee: x.fee }] : []), { t: wa, fee: 0 }]
    const found: { rs: Row[]; fee: number }[] = []
    const walk = (i0: number, pick: Row[], sum: number) => {
      if (pick.length >= 2) for (const g of targets) if (Math.abs(sum - g.t) < 0.011) found.push({ rs: [...pick], fee: g.fee })
      if (pick.length === 4) return
      for (let i = i0; i < cands.length; i++) walk(i + 1, [...pick, cands[i]], r2(sum + cands[i].amount))
    }
    walk(0, [], 0)
    if (!found.length) continue
    done.add(String(w.id))
    if (found.length > 1) {
      const all = [...new Map(found.flatMap(f => f.rs).map(r => [r.id, r])).values()]; all.forEach(r => used.add(r.id))
      push({ key: keyOf('AMBIGUO', [w], all), kind: 'AMBIGUO', title: `${cap(wLab(w))} pode ser ${found.length} combinações diferentes de registros com o nome: o valor não desempata.`, amount: x.fee ?? wa, date: day(w.date), refs: [bankRef(w), ...all.slice(0, 6).map(r => r.ref)], evidence: `${wireTxt(w)}; ${found.slice(0, 3).map(f => f.rs.map(r => `${short(r)} ${usd(r.amount)}`).join(' + ')).join(' | ')}.` }, [w])
      continue
    }
    const f = found[0], sum = r2(f.rs.reduce((s, r) => s + r.amount, 0)); f.rs.forEach(r => used.add(r.id))
    const p = feeProof(w), feeRows = f.rs.filter(r => num(r.e.extra) > 0)
    const parts = nowrap(f.rs.map(r => `${short(r)} ${usd(r.amount)}`))
    if (f.fee > 0) { dobroCerto += f.fee; if (!p.posted) dobroPendente += f.fee }
    push({ key: keyOf('DIVIDIDO', [w], f.rs), kind: 'DIVIDIDO', title: f.fee > 0
      ? `${cap(wLab(w))} paga ${f.rs.length} registros juntos (${parts}), que somam ${usd(sum)}: a diferença de ${usd(f.fee)} é a taxa da Regions, que ${twice(p)}.`
      : `${cap(wLab(w))} paga ${f.rs.length} registros juntos (${parts}), que somam exatamente o wire — o valor bate, mas o Bank Link não casa um wire com vários registros.`,
    amount: f.fee > 0 ? f.fee : wa, date: day(w.date), refs: [bankRef(w), ...f.rs.map(r => r.ref), ...(f.fee > 0 ? p.refs : [])],
    evidence: `${wireTxt(w)}; ${f.rs.map(r => rowBreak(r)).join('; ')}. Todos citam «${payeeOf(w.name)}» (${nowrap([...new Set(f.rs.flatMap(r => nameOf(w, r).hits))])}).${f.fee > 0 ? ` A taxa está no extra de ${feeRows.map(r => r.label.split(' · ')[0] + ' ' + usd(num(r.e.extra))).join(', ') || 'algum registro'}. ${p.text}` : ''}` }, [w])
  }

  // ── 5 · SOMA: wire(s) ao mesmo beneficiário (encadeados em 7 d) × registros livres com o nome em ±7 d ──
  const payeeKey = (w: any) => { const t = toks(payeeOf(w.name)).filter(x => x.length >= 2 && !WIRE_GENERIC.has(x)); return t.length ? t.join(' ') : payeeOf(w.name).toUpperCase() }
  const byKey = new Map<string, any[]>()
  for (const w of open.filter(w => !done.has(String(w.id)))) byKey.set(payeeKey(w), [...(byKey.get(payeeKey(w)) || []), w])
  const clusters: any[][] = []
  for (const ws of byKey.values()) { let cur: any[] = []; for (const w of ws) { if (cur.length && dd(cur[cur.length - 1].date, w.date) > WIRE_SUM_DAYS) { clusters.push(cur); cur = [] } cur.push(w) } if (cur.length) clusters.push(cur) }
  const inWin = (r: Row, lo: string, hi: string, days: number) => !!r.date && signedDays(day(lo), r.date) >= -days && signedDays(day(hi), r.date) <= days
  for (const C of clusters) {
    const lo = C[0].date, hi = C[C.length - 1].date
    const rs = rows.filter(r => !used.has(r.id) && wireable(r) && inWin(r, lo, hi, WIRE_SUM_DAYS) && C.some(w => nameOf(w, r).hit) && !C.some(w => refusedOf(w).has('invoice_expenses:' + r.id)))
    if (!rs.length) continue
    const others = rows.filter(r => used.has(r.id) && inWin(r, lo, hi, WIRE_SUM_DAYS) && C.some(w => nameOf(w, r).hit))
    C.forEach(w => done.add(String(w.id))); rs.forEach(r => used.add(r.id))
    const wt = r2(C.reduce((s, w) => s + num(w.amount), 0)), rt = r2(rs.reduce((s, r) => s + r.amount, 0)), diff = r2(rt - wt)
    const fees = C.every(w => exp(w).fee != null) ? r2(C.reduce((s, w) => s + (exp(w).fee || 0), 0)) : null
    const wiresTxt = C.length === 1 ? wLab(C[0]) : `os ${C.length} wires para «${payeeOf(C[0].name)}» (${nowrap(C.map(w => usd(num(w.amount)) + ' em ' + dm(w.date)))})`
    const rowsTxt = rs.length === 1 ? `o registro «${cut(rs[0].label, 80)}» (${dm(rs[0].date)})` : `${rs.length} registros com o nome (${nowrap(rs.map(r => short(r)))})`
    const ev = `${C.map(w => wireTxt(w)).join('; ')}; ${rs.map(r => rowBreak(r)).join('; ')}.${fees ? ` Taxa esperada dos wires: ${usd(fees)} (${[...new Set(C.map(w => exp(w).src === 'OUT_F' ? 'linha OUT F própria' : 'dentro da tarifa mensal'))].join(' e ')}), fora do registro.` : ''}${others.length ? ` Já explicados por outro item: ${nowrap(others.map(r => short(r) + ' ' + usd(r.amount)))}.` : ''}`
    const equal = Math.abs(diff) < 0.011, withFee = !equal && fees != null && fees > 0 && Math.abs(diff - fees) < 0.011
    if (equal || withFee) {
      if (withFee) { dobroCerto += fees!; if (!C.every(w => feeProof(w).posted)) dobroPendente += fees! }
      push({ key: keyOf('SOMA_IGUAL', C, rs), kind: 'SOMA_IGUAL', title: `${cap(wiresTxt)} ${C.length === 1 ? 'saiu' : 'somam'} ${usd(wt)} e ${rowsTxt} ${rs.length === 1 ? 'tem' : 'somam'} ${usd(rt)}${withFee ? `: a diferença de ${usd(fees!)} é a taxa da Regions, contada duas vezes` : ': o valor bate, falta só o dono no Bank Link'}.`, amount: withFee ? fees! : wt, date: day(lo), refs: [...C.map(bankRef), ...rs.slice(0, 6).map(r => r.ref)], evidence: ev }, C)
    } else {
      push({ key: keyOf('SOMA_DIFERENTE', C, rs), kind: 'SOMA_DIFERENTE', title: `${cap(wiresTxt)} ${C.length === 1 ? 'saiu' : 'somam'} ${usd(wt)}, mas ${rowsTxt} ${rs.length === 1 ? 'tem' : 'somam'} ${usd(rt)}: ${diff < 0 ? `o banco pagou ${usd(-diff)} a mais do que o app registra` : `o app registra ${usd(diff)} a mais do que o banco pagou`}.`, amount: Math.abs(diff), date: day(lo), refs: [...C.map(bankRef), ...rs.slice(0, 6).map(r => r.ref)], evidence: ev }, C)
    }
  }

  // ── 6 · o que sobrou: registro com o nome longe (8–30 d ou sem data), ou SEM_REGISTRO ──
  for (const w of open) {
    if (done.has(String(w.id))) continue
    done.add(String(w.id))
    const wa = r2(num(w.amount)), x = exp(w)
    const far = (r: Row) => !r.date || dd(r.date, w.date) <= WIRE_NAME_DAYS
    const rejW = refusedOf(w)
    const named = rows.filter(r => !used.has(r.id) && !rejW.has('invoice_expenses:' + r.id) && wireable(r) && far(r) && nameOf(w, r).hit).sort((a, b) => (a.date ? dd(a.date, w.date) : 999) - (b.date ? dd(b.date, w.date) : 999))
    const usedNamed = rows.filter(r => used.has(r.id) && far(r) && nameOf(w, r).hit)
    const chan = rows.filter(r => !used.has(r.id) && !wireable(r) && far(r) && nameOf(w, r).hit)
    const feeTxt = x.src === 'OUT_F' ? ` A taxa do wire (${usd(x.fee || 0)}) veio em linha OUT F própria${x.line.match_status === 'MATCHED' ? ', já lançada' : ''}.` : x.src === 'FLAT' ? ` A taxa de ${usd(WIRE_FEE_FLAT)} deste wire está na tarifa mensal de ${mes(day(w.date).slice(0, 7))}.` : ''
    if (named.length) {
      const r = named[0]
      push({ key: keyOf('REGISTRO_LONGE', [w], named.slice(0, 3)), kind: 'REGISTRO_LONGE', title: `${cap(wLab(w))} não tem registro na data; o app tem «${cut(r.label, 80)}» (${usd(r.amount)}, ${r.date ? dd(r.date, w.date) + ' dias do wire' : 'sem data de pagamento'}) com o mesmo nome — é deste wire?`, amount: wa, date: day(w.date), refs: [bankRef(w), ...named.slice(0, 3).map(r => r.ref)], evidence: `${wireTxt(w)}; ${named.slice(0, 3).map(r => `${r.date ? rowBreak(r) : short(r) + ' ' + usd(r.amount) + ' sem data'} (nome ${nameOf(w, r).hits.join('+')})`).join('; ')}.${feeTxt}` }, [w])
      continue
    }
    const oth = others.filter(o => !rejW.has(o.table + ':' + o.id) && Math.abs(o.amount - wa) < 0.011 && (o.date ? dd(o.date, w.date) <= WIRE_EXACT_DAYS || (dd(o.date, w.date) <= WIRE_NAME_DAYS && nameOther(w, o).hit) : nameOther(w, o).hit))
    if (oth.length) {
      const o = oth[0]
      push({ key: keyOf('OUTRO_REGISTRO', [w], oth.slice(0, 3).map(x => ({ id: x.table + ':' + x.id }))), kind: 'OUTRO_REGISTRO', title: `${cap(wLab(w))} não tem registro de invoice, mas o app tem «${cut(o.label, 80)}» (${usd(o.amount)}, ${o.date ? dd(o.date, w.date) + ' dias do wire' : 'sem data'}) com o mesmo valor — é deste wire?`, amount: wa, date: day(w.date), refs: [bankRef(w), ...oth.slice(0, 3).map(x => ({ table: x.table, id: String(x.id), label: x.label + ' · ' + usd(x.amount), href: x.href }))], evidence: `${wireTxt(w)}; ${oth.slice(0, 3).map(x => `«${cut(x.label, 60)}» ${usd(x.amount)} ${x.date ? 'em ' + dm(x.date) + ' (' + dd(x.date, w.date) + ' d)' : 'sem data'}, ${nameOther(w, x).hit ? 'nome bate (' + nameOther(w, x).hits.join('+') + ')' : 'sem o nome'}`).join('; ')}. Nenhum registro de invoice cita «${payeeOf(w.name)}» em ±${WIRE_NAME_DAYS} dias.${feeTxt}` }, [w])
      continue
    }
    const co = coincid.get(String(w.id)) || []
    const offered = exactRows(w).filter(r => !r.date || dd(r.date, w.date) <= WIRE_NAME_DAYS)
    const ev = [`${wireTxt(w)}. Nenhum registro livre de invoice cita «${payeeOf(w.name)}» (fornecedor, item, cadastro, apelidos ou vendedor) em ±${WIRE_NAME_DAYS} dias, e nenhum soma o wire + a taxa em ±${WIRE_DAYS} dia.`,
      co.length ? ` Na janela da taxa só há coincidência: ${co.slice(0, 2).map(e => `${short(e.r)} ${usd(e.r.amount)} (diferença ${usd(e.fee)}, ${x.fee != null ? 'a taxa desta data é ' + usd(x.fee) : 'sem taxa conhecida nesta data'}, sem o nome)`).join('; ')}.` : '',
      offered.length ? ` O card da Conciliação oferece ${offered.slice(0, 2).map(r => `${short(r)} (mesmos ${usd(wa)}, ${r.date ? dd(r.date, w.date) + ' d' : 'sem data'}, sem o nome)`).join(' e ')}: coincidência de valor.` : '',
      usedNamed.length ? ` Os registros com o nome por perto já são de outros wires: ${nowrap(usedNamed.slice(0, 3).map(r => short(r)))}.` : '',
      chan.length ? ` ${nowrap(chan.slice(0, 2).map(r => short(r)))} cita o nome, mas diz outro meio de pagamento (Zelle, PayPal, cartão, cash ou cheque).` : '',
      data.othersChecked ? ` Nem registro livre de mesmo valor em folha, custos fixos, goods, insumos, estoque, capital ou empréstimos (±${WIRE_EXACT_DAYS} d, ou ±${WIRE_NAME_DAYS} d com o nome).` : '', feeTxt].join('')
    push({ key: keyOf('SEM_REGISTRO', [w]), kind: 'SEM_REGISTRO', title: `${cap(wLab(w))} não tem dono no app: nenhum registro livre com esse nome em ±${WIRE_NAME_DAYS} dias, nem registro com o valor do wire + a taxa em ±${WIRE_DAYS} dia.`, amount: wa, date: day(w.date), refs: [bankRef(w), ...co.slice(0, 2).map(e => e.r.ref), ...offered.slice(0, 2).map(r => r.ref)], evidence: ev }, [w])
  }

  // ── 7 · wires JÁ casados: a taxa ficou dentro do registro? (dinheiro em dobro) ──
  let splitOk = 0; const splitNotes: string[] = []; let matchedChecked = 0
  for (const w of wiresAll.filter((l: any) => l.match_status === 'MATCHED' && ['invoice_expenses', 'purchase_group'].includes(String(l.matched_table)))) {
    const grp = w.matched_table === 'purchase_group'
    const rs = grp ? ie.filter((e: any) => String(e.purchase_group) === String(w.matched_id)) : [ieById.get(String(w.matched_id))].filter(Boolean)
    if (!rs.length) continue
    matchedChecked++
    const total = r2(rs.reduce((s: number, e: any) => s + ieAmt(e), 0)), wa = r2(num(w.amount)), diff = r2(total - wa), x = exp(w)
    const lab = (e: any) => `${code(e)} · ${cut(e.supplier, 40)} · ${cut(e.item, 60)}`
    const refs: AuditRef[] = [bankRef(w), ...rs.slice(0, 6).map((e: any) => ({ table: 'invoice_expenses', id: String(e.id), label: lab(e) + ' · ' + usd(ieAmt(e)), href: invHref(e.invoice_id) }))]
    const rec = grp ? `o pedido de ${rs.length} itens «${lab(rs[0])}»` : `«${lab(rs[0])}»`
    if (Math.abs(diff) < 0.011) {
      const f = x.fee, r = f != null ? rs.find((e: any) => Math.abs(num(e.extra) - f) < 0.005) : null
      if (r) { splitOk++; splitNotes.push(`${code(r)} «${cut(r.item, 30)}» ${usd(num(r.price))} + extra ${usd(num(r.extra))} = wire de ${usd(wa)} (${dm(w.date)}, ${w.match_engine})`) }
      continue
    }
    if (grp && diff < 0) continue   // pedido pode ter membro fora de invoice_expenses (assets/inputs/inventory): só a sobra é prova
    const isTaxa = x.fee != null && Math.abs(diff - x.fee) < 0.005
    if (diff > 0.009 && diff <= WIRE_FEE_MAX) {
      if (isTaxa) { dobroCerto += diff; if (!feeProof(w).posted) dobroPendente += diff }
      push({ key: keyOf('TAXA_DENTRO', [w], rs.map((e: any) => ({ id: String(e.id) }))), kind: 'TAXA_DENTRO', title: `${cap(wLab(w))} já está casado com ${rec}, mas o registro soma ${usd(total)}: ${isTaxa ? `os ${usd(diff)} a mais são a taxa da Regions, que também está na tarifa — contada duas vezes` : `sobram ${usd(diff)} que não são a taxa conhecida desta data`}.`, amount: diff, date: day(w.date), refs, evidence: `${wireTxt(w)}, casado ${w.match_engine}; ${rs.slice(0, 4).map((e: any) => `${code(e)} = ${usd(num(e.price))}${(num(e.quantity) || 1) !== 1 ? ' × ' + num(e.quantity) : ''}${num(e.tax) ? ' + tax ' + usd(num(e.tax)) : ''}${num(e.extra) ? ' + extra ' + usd(num(e.extra)) : ''}`).join('; ')}. ${x.src ? feeProof(w).text : ''}` })
    } else {
      push({ key: keyOf('CASADO_DIFERENTE', [w], rs.map((e: any) => ({ id: String(e.id) }))), kind: 'CASADO_DIFERENTE', title: `${cap(wLab(w))} está casado com ${rec}, que hoje soma ${usd(total)} — ${usd(Math.abs(diff))} de diferença do banco (alguém editou depois do casamento?).`, amount: Math.abs(diff), date: day(w.date), refs, evidence: `${wireTxt(w)}, casado ${w.match_engine}; registro(s) somam ${usd(total)}.` })
    }
  }

  // ── 8 · o regime da taxa se confirma? ANALYSIS CHARGE do mês = $24 + $23 × wires sem linha OUT F ──
  const regimeTxt: Record<string, string> = {}
  const months = new Set<string>(charges.keys())
  for (const w of wiresAll) { const ym = day(w.date).slice(0, 7); if (day(w.date) >= WIRE_FEE_FLAT_SINCE) months.add(ym) }
  for (const ym of [...months].sort()) {
    const g = regime(ym)
    if (!g.line) { regimeTxt['tarifa_' + ym] = `não postou: ${g.n} wire(s) sem linha OUT F → ${usd(g.expected)} esperado`; continue }
    if (g.amount != null && Math.abs(g.amount - g.expected) < 0.005) { regimeTxt['tarifa_' + ym] = `ok: ${usd(g.amount)} = ${usd(ANALYSIS_BASE)} + ${g.n} × ${usd(WIRE_FEE_FLAT)}`; continue }
    const got = g.amount ?? g.amts[0]
    regimeTxt['tarifa_' + ym] = `NÃO FECHA: ${g.amts.map(usd).join(' / ')} × ${usd(g.expected)} esperado`
    push({ key: 'REGIME|' + g.line.id, kind: 'REGIME', title: `A tarifa mensal de ${mes(ym)} (${cut(g.line.name, 22)}) foi ${g.amts.map(usd).join(' / ')}, mas ${usd(ANALYSIS_BASE)} + ${g.n} × ${usd(WIRE_FEE_FLAT)} = ${usd(g.expected)}: a taxa por wire da Regions mudou?`, amount: r2(Math.abs(got - g.expected)), date: day(g.line.date), refs: [bankRef(g.line)], evidence: `Wires de ${mes(ym)}: ${g.ws.length ? g.ws.map((w: any) => `${usd(num(w.amount))} ${dm(w.date)}${exp(w).src === 'OUT_F' ? ' (com OUT F)' : ''}`).join('; ') : 'nenhum'}. Enquanto não fechar, a taxa esperada de ${usd(WIRE_FEE_FLAT)} dos itens PAR deste mês é hipótese, não prova.` })
  }

  // ── resumo ──
  const ORDER = ['REGIME', 'TAXA_DENTRO', 'PAR', 'DIVIDIDO', 'SOMA_IGUAL', 'SO_TAXA', 'NOME_DIFERENCA', 'SOMA_DIFERENTE', 'AMBIGUO', 'REGISTRO_LONGE', 'OUTRO_REGISTRO', 'SEM_REGISTRO', 'CASADO_DIFERENTE', 'EXATO']
  items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || String(b.date || '').localeCompare(String(a.date || '')) || a.key.localeCompare(b.key))
  const summary: Record<string, number | string> = {
    hoje: today, feed_ate: posted.map((l: any) => day(l.date)).sort().pop() || '',
    wires_saida: wiresAll.length, wires_abertos: open.length, wires_abertos_usd: r2(open.reduce((s: number, w: any) => s + num(w.amount), 0)), wires_gemeos_ignorados: openAll.length - open.length,
    wires_casados_conferidos: matchedChecked, registros_livres: rows.length, arestas_taxa: edges.length,
    dobro_certo_usd: r2(dobroCerto), dobro_quando_tarifa_postar_usd: r2(dobroPendente), dobro_provavel_usd: r2(dobroProvavel),
    outras_tabelas_conferidas: data.othersChecked ? 'sim' : 'não',
    linhas_out_f: outF.length, ultima_out_f: outF.map((l: any) => day(l.date)).sort().pop() || '', taxa_fixa_desde: WIRE_FEE_FLAT_SINCE,
    taxa_no_extra_sem_dobro: splitOk,
  }
  if (splitOk) summary.nota_taxa_no_extra = `${splitNotes.join('; ')} — NÃO é dobro: o registro soma exatamente o que saiu para o vendedor, e a taxa da Regions está só na tarifa; só o rateio preço/extra está torto.`
  for (const k of ORDER) { const n = items.filter(i => i.kind === k); if (!n.length) continue; summary['n_' + k] = n.length; summary['usd_' + k] = r2(n.reduce((s, i) => s + i.amount, 0)); const wb = wiresBy.get(k); if (wb && wb.n) { summary['wires_' + k] = wb.n; summary['wires_usd_' + k] = wb.usd } }
  Object.assign(summary, regimeTxt)
  return { items, summary }
}
