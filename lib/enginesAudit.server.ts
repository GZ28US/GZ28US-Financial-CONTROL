// SERVER-ONLY — OS DOIS MOTORES CONCORDAM? (DC 1.49.0, João, 10/set/2026)
//
// Dois robôs registram compra no app: o AUTO-BOOK (e-mail, de hora em hora — lib/autoBookMail.server.ts) e o motor do
// BANK LINK (linhas da Regions, 6/6 h + webhook — lib/bankReconcile.server.ts). Um lê o e-mail, o outro lê o banco;
// nenhum lê o outro. O Data Checker é quem confere se os dois contam a mesma história — SÓ LEITURA das tabelas dos
// dois, nunca escreve nelas. Este módulo devolve o que o card mostra:
//   · o robô de e-mail está vivo? (rodadas, caixa sem token, rodada em erro, fila de dúvidas parada)
//   · compra lançada pela fila do e-mail que o banco nunca cobrou (o dinheiro não saiu? cartão de outro bolso?)
//   · DUPLA entre motores: o banco criou o que o e-mail já tinha lançado
//   · compra online que o banco viu e a fila do e-mail não tem nem pergunta nem lançamento
//   · dúvida aberta do e-mail cuja compra o banco já pôs no balde (responder lançaria em dobro)
// Erro de leitura NÃO é engolido: tabela ausente vira erro (a rota traduz em «rode a migration»), nunca «robô nunca rodou».
/* eslint-disable @typescript-eslint/no-explicit-any */
import { supplierDirectoryFrom, matchSupplier, normSup } from './supplierMatch'

export type EngineRun = { started_at: string; finished_at: string | null; status: string; trigger: string; counts: Record<string, number>; errors: string[]; caixas: string[] }
export type EnginesAudit = {
  mail: {
    live_since: string | null            // primeira rodada registrada (o robô existe desde então)
    last: EngineRun | null
    hours_since_last: number | null
    running_minutes: number | null       // rodada RUNNING há quantos minutos (null se não está rodando)
    zero_read_streak: number             // rodadas seguidas lendo 0 e-mails (contando da última fechada)
    boxes_failing: { box: string; reason: string }[]   // caixa marcada :sem-token / :erro na última rodada fechada
    runs_7d: { done: number; error: number; running: number }
    doubts: { open: number; older_48h: number; oldest_days: number | null }   // idade pela entrada na fila (created_at), não pela data do e-mail
    rules: number
    booked: number                       // linhas em auto_book_mail com booked_id (regra ou resposta humana)
  }
  feed_until: string | null              // última linha POSTADA da Regions (até onde a ausência é prova)
  booked_no_bank: { table: string; id: string; label: string; vendor: string; amount: number; date: string; days: number; href: string; bank_line: { date: string; pending: boolean; status: string } | null }[]
  dups: { auto_table: string; auto_id: string; auto_label: string; bank_id: string; bank_date: string; twin_table: string; twin_id: string; twin_label: string; amount: number; twin_amount: number; days: number; exact: boolean; assigned: boolean }[]
  no_mail: { bank_id: string; date: string; amount: number; name: string; supplier: string; row_table: string; row_id: string; row_label: string }[]
  doubt_dup: { doubt_id: string; vendor: string; amount: number; received_at: string; bucket_row_id: string; bucket_label: string; bucket_date: string }[]
}

const num = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const day = (s: any) => String(s || '').slice(0, 10)
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(day(a)) - Date.parse(day(b))) / 864e5))
const hoursAgo = (iso: string) => (Date.now() - Date.parse(iso)) / 3600e3
const BR_PAID = new Set(['GZ28BR'])   // a mesma régua do candidatePool (brPaid): pagou por fora da Regions — sócio e cliente saíram do vocabulário em 11/set
const MAIL_ENGINES = new Set(['RULE', 'LEARN', 'FEE', 'BUCKET'])          // o que o motor do banco CRIA (o rematch da rota só aceita estes)
// Vendedores que MANDAM e-mail de compra — a lista de domínios do AUTO-BOOK (lib/autoBookMail.server.ts DOM_VENDOR) em nomes
// normalizados. Copiada, não importada: o auditor não pode depender do auditado. Fora da lista de propósito: Titan e Wurth
// (também vendem no balcão / na van), Apple e assinaturas (são da varredura APPS, não do AUTO-BOOK), Uber.
const ONLINE_VENDORS = ['temu', 'whaleco', 'amazon', 'ebay', 'paypal', 'hptuners', 'hhp', 'highhorse', 'summitracing', 'rockauto', 'holley', 'kooks', 'halltech', 'mercadolivre', 'tirerack', 'homedepot', 'lowes', 'samsclub', 'walmart', 'harborfreight', 'oreilly', 'napa']
// Famílias: grafias diferentes do MESMO vendedor nas duas fontes (e-mail × banco × cadastro).
const FAMILY: [RegExp, string][] = [[/^hhp\b|highhorse/, 'highhorse'], [/whaleco|^temu/, 'temu'], [/^summitracing/, 'summitracing'], [/^hptuners/, 'hptuners'], [/^amazon(?!prime)/, 'amazon'], [/^ebay/, 'ebay'], [/^paypal/, 'paypal'], [/^rockauto/, 'rockauto'], [/^tirerack/, 'tirerack']]

async function fetchAll(db: any, table: string, sel: string, mod?: (q: any) => any): Promise<any[]> {
  const acc: any[] = []
  for (let from = 0; ; from += 1000) {
    let q: any = db.from(table).select(sel).range(from, from + 999)
    if (mod) q = mod(q)
    const { data, error } = await q
    if (error) throw new Error(table + ': ' + error.message)
    acc.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return acc
}

export async function enginesAudit(db: any): Promise<EnginesAudit> {
  const nowIso = new Date().toISOString()
  const sevenAgoIso = new Date(Date.now() - 7 * 864e5).toISOString()
  // ── 1 · o robô de e-mail (só leitura de auto_book_mail_runs / auto_book_mail / auto_book_mail_rules; erro sobe) ──
  const toRun = (r: any): EngineRun => ({ started_at: String(r.started_at), finished_at: r.finished_at ? String(r.finished_at) : null, status: String(r.status || ''), trigger: String(r.trigger || ''), counts: r.counts && typeof r.counts === 'object' ? r.counts : {}, errors: Array.isArray(r.errors) ? r.errors.map(String) : [], caixas: Array.isArray(r.caixas) ? r.caixas.map(String) : [] })
  const [recentRaw, weekRaw, firstRaw] = await Promise.all([
    fetchAll(db, 'auto_book_mail_runs', '*', (q: any) => q.order('started_at', { ascending: false }).limit(60)),
    fetchAll(db, 'auto_book_mail_runs', 'status, started_at', (q: any) => q.gte('started_at', sevenAgoIso)),
    fetchAll(db, 'auto_book_mail_runs', 'started_at', (q: any) => q.order('started_at', { ascending: true }).limit(1)),
  ])
  const recent = recentRaw.map(toRun)
  const last = recent[0] || null
  const lastClosed = recent.find(r => r.status !== 'RUNNING') || null
  const boxes_failing = (lastClosed ? lastClosed.caixas : []).map(c => { const i = c.lastIndexOf(':'); const box = i > 0 ? c.slice(0, i) : c, tail = i > 0 ? c.slice(i + 1) : ''; return /^\d+$/.test(tail) ? null : { box, reason: tail || '?' } }).filter((x): x is { box: string; reason: string } => !!x)
  let zero = 0; for (const r of recent) { if (r.status === 'RUNNING') continue; if (num(r.counts.lidos) === 0) zero++; else break }
  const runs_7d = { done: 0, error: 0, running: 0 }
  for (const r of weekRaw) { if (r.status === 'DONE') runs_7d.done++; else if (r.status === 'RUNNING') runs_7d.running++; else runs_7d.error++ }
  const live_since = firstRaw[0] ? String(firstRaw[0].started_at) : null
  const mailRows = await fetchAll(db, 'auto_book_mail', 'id, status, kind, vendor, amount, received_at, from_addr, booked_table, booked_id, answered_at, created_at')
  const open = mailRows.filter((m: any) => m.status === 'DOUBT')
  const ageOf = (m: any) => hoursAgo(String(m.created_at || m.received_at || nowIso))
  const oldestOpenH = open.length ? Math.max(...open.map(ageOf)) : null
  const rulesRes = await db.from('auto_book_mail_rules').select('id', { count: 'exact', head: true })
  if (rulesRes.error) throw new Error('auto_book_mail_rules: ' + rulesRes.error.message)
  const booked = mailRows.filter((m: any) => m.booked_id && m.booked_table)

  // ── 2 · o que cada motor escreveu, e as linhas do banco que apontam pra cada registro ──
  const expensesSel = 'id, description, amount, expense_date, payment_date, paid_from, paid_to, payment_reference, order_number'
  const [ie, inputs, fixed, expenses, suppliers, invoices, bank] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, expense_date, payment_date, paid_from, paid_to, purchase_group, order_number'),
    fetchAll(db, 'inputs', 'id, description, supplier, unit_price, quantity, purchase_date, payment_date, paid_from, paid_to, purchase_group, order_number'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, expense_date, payment_date, paid_from, paid_to, bank_transaction_id'),
    // expenses.bank_transaction_id vem da MIGRATION_expenses_bank_link — sem ela, lê sem a coluna (o elo então é só o payment_reference).
    fetchAll(db, 'staff_expenses', expensesSel + ', bank_transaction_id').catch((e: any) => /bank_transaction_id/.test(String(e.message)) ? fetchAll(db, 'staff_expenses', expensesSel) : Promise.reject(e)),
    fetchAll(db, 'suppliers', 'name, aliases, is_dealership'),
    fetchAll(db, 'invoices', 'id, invoice_code, origin'),
    fetchAll(db, 'bank_transactions', 'id, date, amount, name, merchant, pending, match_status, match_engine, matched_table, matched_id, reviewed_at', (q: any) => q.or('match_status.is.null,match_status.neq.REMOVED')),
  ])
  const dir = supplierDirectoryFrom(suppliers)
  const canonCache = new Map<string, string>()
  const canon = (s: any) => { const raw = String(s || ''); if (canonCache.has(raw)) return canonCache.get(raw)!; const m = matchSupplier(raw, dir); const c = m ? normSup(m.name) : normSup(raw); canonCache.set(raw, c); return c }
  const fam = (s: any) => { const n = canon(s); for (const [re, k] of FAMILY) if (re.test(n)) return k; return n }
  // Mesmo vendedor: mesma família, mesmo cadastro resolvido, ou um nome contido no outro com 6+ letras (a régua do matchSupplier).
  const sameVendor = (a: any, b: any) => {
    const x = fam(a), y = fam(b); if (!x || !y) return false
    if (x === y) return true
    const da = matchSupplier(String(a || ''), dir), dbm = matchSupplier(String(b || ''), dir)
    if (da && dbm) return da.name === dbm.name
    return (x.length >= 6 && y.startsWith(x)) || (y.length >= 6 && x.startsWith(y))
  }
  const isOnlineVendor = (s: any) => { const n = canon(s); return !!n && ONLINE_VENDORS.some(v => n.startsWith(v)) }
  const brPaid = (r: any) => BR_PAID.has(String(r.paid_from || '')) || String(r.paid_to || '') === 'GZ28BR'
  const invById = new Map(invoices.map((i: any) => [String(i.id), i]))
  const bucketInvoice = invoices.find((i: any) => i.origin === 'BUCKET')
  const invCode = (id: any) => invById.get(String(id))?.invoice_code || '?'
  const posted = bank.filter((b: any) => !b.pending)
  const feed_until = posted.map((b: any) => day(b.date)).sort().reverse()[0] || null
  const matched = bank.filter((b: any) => b.match_status === 'MATCHED')
  const pointed = new Map<string, any>()   // 'table:id' → linha do banco que aponta
  for (const b of matched) if (b.matched_table && b.matched_id) pointed.set(b.matched_table + ':' + b.matched_id, b)
  const byLineId = new Map(bank.map((b: any) => [String(b.id), b]))
  const lineOf = (table: string, row: any): any => pointed.get(table + ':' + row.id) || (row.purchase_group ? pointed.get('purchase_group:' + row.purchase_group) : null)
    || ((table === 'fixed_cost_expenses' || table === 'staff_expenses') && row.bank_transaction_id ? byLineId.get(String(row.bank_transaction_id)) : null)
    || (table === 'staff_expenses' && String(row.payment_reference || '').startsWith('bank:') ? byLineId.get(String(row.payment_reference).slice(5)) : null)
    || (table === 'inputs' && String(row.order_number || '').startsWith('bank:') ? byLineId.get(String(row.order_number).slice(5)) : null) || null
  const ieAmt = (r: any) => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra)
  const rowsOf: Record<string, Map<string, any>> = { invoice_expenses: new Map(ie.map((r: any) => [String(r.id), r])), inputs: new Map(inputs.map((r: any) => [String(r.id), r])), fixed_cost_expenses: new Map(fixed.map((r: any) => [String(r.id), r])), staff_expenses: new Map(expenses.map((r: any) => [String(r.id), r])) }
  const shape = (table: string, r: any) => table === 'invoice_expenses' ? { label: [invCode(r.invoice_id), r.supplier, r.item].filter(Boolean).join(' · '), vendor: String(r.supplier || ''), amount: ieAmt(r), date: day(r.payment_date || r.expense_date), href: invById.get(String(r.invoice_id))?.origin === 'BUCKET' ? '/adm/bank#a-atribuir' : '/invoices' }
    : table === 'inputs' ? { label: ['SUPPLY', r.supplier, r.description].filter(Boolean).join(' · '), vendor: String(r.supplier || ''), amount: num(r.unit_price) * (num(r.quantity) || 1), date: day(r.payment_date || r.purchase_date), href: '/supplies' }
    : table === 'fixed_cost_expenses' ? { label: ['FIXO', r.description].filter(Boolean).join(' · '), vendor: String(r.description || ''), amount: num(r.amount), date: day(r.payment_date || r.expense_date), href: '/costs/fixed' }
    : { label: ['FOLHA', r.description].filter(Boolean).join(' · '), vendor: String(r.description || ''), amount: num(r.amount), date: day(r.payment_date || r.expense_date), href: '/staff' }

  // ── 3 · lançado pela fila do e-mail, sem linha do banco casada (o feed já viu a data: 5 d de folga pra postar) ──
  const booked_no_bank: EnginesAudit['booked_no_bank'] = []
  const mailRowsById = new Map<string, any>()
  for (const m of booked) {
    const table = String(m.booked_table), r = rowsOf[table]?.get(String(m.booked_id))
    if (!r) continue
    mailRowsById.set(table + ':' + r.id, { m, r, s: shape(table, r) })
    if (lineOf(table, r)) continue
    if (brPaid(r)) continue   // pagou por fora da Regions (BR, sócio, cliente): não tem linha mesmo — a resposta já foi dada
    const s = shape(table, r)
    if (!s.date || !feed_until || s.date > new Date(Date.parse(feed_until) - 5 * 864e5).toISOString().slice(0, 10)) continue
    // A cobrança pode EXISTIR e não ter casado (pendente, >3 dias, dúvida): aí o caminho é o Bank Link, não «Quem pagou?».
    const loose = bank.find((b: any) => b.match_status !== 'MATCHED' && num(b.amount) > 0 && Math.abs(num(b.amount) - s.amount) < 0.011 && dayDiff(b.date, s.date) <= 15) || null
    if (loose) continue   // a cobrança existe e não casou: essa pergunta é da linha do banco (card Conciliação bancária) — aqui seria a mesma pendência duas vezes (revisão BL 1.5.0)
    booked_no_bank.push({ table, id: String(r.id), label: s.label, vendor: String(m.vendor || s.vendor), amount: s.amount, date: s.date, days: dayDiff(feed_until, s.date), href: s.href, bank_line: loose ? { date: day(loose.date), pending: !!loose.pending, status: String(loose.match_status || 'NEW') } : null })
  }

  // ── 4 · DUPLA entre motores: registro que o motor do banco CRIOU (marcador «Bank Link» + linha do banco de motor criador) ⇄ registro da fila do e-mail ──
  const bankMade: { table: string; r: any; line: any }[] = []
  const madeBy = (table: string, r: any, text: string) => { if (!/Bank Link\)/.test(text)) return; const line = lineOf(table, r); if (line && MAIL_ENGINES.has(String(line.match_engine))) bankMade.push({ table, r, line }) }
  for (const r of ie) madeBy('invoice_expenses', r, String(r.item || ''))
  for (const r of inputs) madeBy('inputs', r, String(r.description || ''))
  for (const r of fixed) madeBy('fixed_cost_expenses', r, String(r.description || ''))
  const dups: EnginesAudit['dups'] = []
  const usedTwin = new Set<string>()
  for (const bm of bankMade) {
    const a = shape(bm.table, bm.r)
    for (const [key, { r: tw, s: t, m }] of mailRowsById) {
      if (usedTwin.has(key) || tw.id === bm.r.id) continue
      if (lineOf(String(m.booked_table), tw)) continue   // a linha do e-mail já tem a sua própria cobrança: são duas compras
      const band = t.amount >= a.amount / 1.10 - 0.011 && t.amount <= a.amount + 2
      if (!band || !a.date || !t.date || dayDiff(a.date, t.date) > 14) continue
      if (!sameVendor(a.vendor, m.vendor || t.vendor)) continue
      usedTwin.add(key)
      dups.push({ auto_table: bm.table, auto_id: String(bm.r.id), auto_label: a.label, bank_id: String(bm.line.id), bank_date: day(bm.line.date), twin_table: String(m.booked_table), twin_id: String(tw.id), twin_label: t.label, amount: a.amount, twin_amount: t.amount, days: dayDiff(a.date, t.date), exact: Math.abs(t.amount - a.amount) < 0.011, assigned: String(bm.line.match_engine) === 'BUCKET' && !!bm.line.reviewed_at })
      break
    }
  }

  // ── 5 · compra online que o banco pôs no balde/insumos (desde que o robô existe) e a fila do e-mail não tem pergunta nem lançamento ──
  //        Só balde e insumos: assinatura (custo fixo) é da varredura APPS, não do AUTO-BOOK. Janela larga (15 d): PayPal e pré-venda demoram.
  const no_mail: EnginesAudit['no_mail'] = []
  if (live_since) {
    const liveDay = day(live_since)
    for (const bm of bankMade) {
      if (bm.table === 'fixed_cost_expenses' || day(bm.line.date) < liveDay) continue
      const a = shape(bm.table, bm.r)
      const bankName = String(bm.line.merchant || bm.line.name || '')
      const vendor = a.vendor || bankName
      if (!isOnlineVendor(vendor) && !isOnlineVendor(bankName)) continue
      const seen = mailRows.some((m: any) => m.received_at && dayDiff(m.received_at, bm.line.date) <= 15 && (sameVendor(m.vendor, vendor) || sameVendor(m.vendor, bankName) || Math.abs(num(m.amount) - a.amount) < 0.011))
      if (seen) continue
      no_mail.push({ bank_id: String(bm.line.id), date: day(bm.line.date), amount: Math.abs(num(bm.line.amount)), name: bankName, supplier: vendor, row_table: bm.table, row_id: String(bm.r.id), row_label: a.label })
    }
  }

  // ── 6 · dúvida aberta do e-mail (compra, não estorno) cuja compra o banco já pôs no balde ──
  const doubt_dup: EnginesAudit['doubt_dup'] = []
  if (bucketInvoice) {
    const bucketRows = ie.filter((r: any) => String(r.invoice_id) === String(bucketInvoice.id))
    for (const m of open) {
      if (String(m.kind) === 'REFUND') continue
      const amt = num(m.amount); if (!(amt > 0)) continue
      const hit = bucketRows.find((r: any) => Math.abs(ieAmt(r) - amt) < 0.011 && r.payment_date && m.received_at && dayDiff(r.payment_date, m.received_at) <= 10 && sameVendor(r.supplier, m.vendor))
      if (hit) doubt_dup.push({ doubt_id: String(m.id), vendor: String(m.vendor || ''), amount: amt, received_at: String(m.received_at), bucket_row_id: String(hit.id), bucket_label: [hit.supplier, hit.item].filter(Boolean).join(' · '), bucket_date: day(hit.payment_date) })
    }
  }

  return {
    mail: {
      live_since, last, hours_since_last: last ? Math.round(hoursAgo(last.started_at) * 10) / 10 : null,
      running_minutes: last && last.status === 'RUNNING' ? Math.round(hoursAgo(last.started_at) * 60) : null,
      zero_read_streak: zero, boxes_failing, runs_7d,
      doubts: { open: open.length, older_48h: open.filter((m: any) => ageOf(m) > 48).length, oldest_days: oldestOpenH != null ? Math.floor(oldestOpenH / 24) : null },
      rules: num(rulesRes.count), booked: booked.length,
    },
    feed_until, booked_no_bank, dups, no_mail, doubt_dup,
  }
}
