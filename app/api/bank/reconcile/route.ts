import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { bankDb } from '@/lib/plaid.server'

// CONCILIAÇÃO BANCÁRIA (Data Checker · card "Banco sem casamento", 21/ago):
// cada linha NEW do banco é uma pendência. Este servidor (as tabelas do banco
// são só-service-key) acha CANDIDATOS no app — mesmo valor (±$0,01), data a
// ±7 dias, ou grupo de compra somado (um pedido Amazon de 3 itens = uma
// cobrança) — e aplica a decisão humana: MATCH (e backfill do payment_date
// do app quando falta), TRANSFER, IGNORE ou EXPLAIN ("o que foi", fica
// QUEUED com a nota). Tudo exige sessão Supabase válida (JWT no header) e
// vai pra trilha data_fixes.
// Convenção Plaid: amount > 0 = saiu, < 0 = entrou.
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown) => parseFloat(String(v)) || 0
const okDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)
const daysBetween = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))

async function requireUser(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.getUser(token)
  return !error && !!data.user
}

async function fetchAll(db: any, table: string, select: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).order('id').range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; score?: number }

// Monta o pool de candidatos do app: saídas (OUT) e entradas (IN), já sem o
// que outra linha do banco casou.
async function candidatePool(db: any) {
  const [invExp, fixed, suppliers, expenses, goods, goodExp, inputs, inventory, payments, invoices, rides, capital, finEv, financing, matched] = await Promise.all([
    fetchAll(db, 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date'),
    fetchAll(db, 'fixed_cost_expenses', 'id, supplier_id, description, amount, payment_date, expense_date'),
    fetchAll(db, 'fixed_cost_suppliers', 'id, company, description'),
    fetchAll(db, 'expenses', 'id, description, type, amount, payment_date, expense_date, origin'),
    fetchAll(db, 'goods', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group'),
    fetchAll(db, 'good_expenses', 'id, good_id, description, supplier, amount, payment_date, expense_date'),
    fetchAll(db, 'inputs', 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, purchase_group'),
    fetchAll(db, 'inventory', 'id, description, supplier, source_type, unit_price, quantity, payment_date, purchase_date, purchase_group'),
    fetchAll(db, 'invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, source, description'),
    fetchAll(db, 'invoices', 'id, invoice_code, ride_id, is_quote'),
    fetchAll(db, 'rides', 'id, project_name'),
    fetchAll(db, 'capital_events', 'id, event_date, kind, member, amount, description').catch(() => []),
    fetchAll(db, 'financing_events', 'id, financing_id, event_date, kind, amount, description').catch(() => []),
    fetchAll(db, 'financing', 'id, lender').catch(() => []),
    fetchAll(db, 'bank_transactions', 'matched_table, matched_id, match_status'),
  ])
  const taken = new Set(matched.filter((m: any) => m.match_status === 'MATCHED' && m.matched_id).map((m: any) => m.matched_table + ':' + m.matched_id))
  const invById = new Map(invoices.map((i: any) => [i.id, i]))
  const rideName = new Map(rides.map((r: any) => [r.id, r.project_name || '']))
  const supName = new Map(suppliers.map((s: any) => [s.id, s.company || s.description || '']))
  const lender = new Map(financing.map((f: any) => [f.id, f.lender]))
  const invLabel = (invoiceId: string) => { const i = invById.get(invoiceId); return i ? `${i.invoice_code || '—'} ${rideName.get(i.ride_id) || ''}`.trim() : '—' }
  const out: Cand[] = [], inn: Cand[] = []
  const push = (arr: Cand[], c: Cand) => { if (!taken.has(c.table + ':' + c.id) && c.amount > 0.005) arr.push(c) }

  for (const e of invExp) { if (!invById.get(e.invoice_id) || invById.get(e.invoice_id).is_quote) continue
    push(out, { table: 'invoice_expenses', id: e.id, label: `${invLabel(e.invoice_id)} · ${e.item || ''}${e.supplier ? ' · ' + e.supplier : ''}`, date: e.payment_date || e.expense_date || null, amount: num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra), undated: !okDate(e.payment_date) }) }
  for (const f of fixed) push(out, { table: 'fixed_cost_expenses', id: f.id, label: `FIXO · ${supName.get(f.supplier_id) || ''} · ${f.description || ''}`, date: f.payment_date || f.expense_date || null, amount: num(f.amount), undated: !okDate(f.payment_date) })
  for (const x of expenses) push(x.origin === 'PERSONAL' ? out : out, { table: 'expenses', id: x.id, label: `${x.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA'} · ${x.description || x.type || ''}`, date: x.payment_date || x.expense_date || null, amount: num(x.amount), undated: !okDate(x.payment_date) })
  for (const g of goods) push(out, { table: 'goods', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.purchase_date || null, amount: num(g.unit_price) * (num(g.quantity) || 1), undated: !okDate(g.payment_date) })
  for (const g of goodExp) push(out, { table: 'good_expenses', id: g.id, label: `GOODS · ${g.description || ''}${g.supplier ? ' · ' + g.supplier : ''}`, date: g.payment_date || g.expense_date || null, amount: num(g.amount), undated: !okDate(g.payment_date) })
  for (const x of inputs) push(out, { table: 'inputs', id: x.id, label: `INPUT · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const x of inventory) if (x.source_type === 'PURCHASED') push(out, { table: 'inventory', id: x.id, label: `STOCK · ${x.description || ''}${x.supplier ? ' · ' + x.supplier : ''}`, date: x.payment_date || x.purchase_date || null, amount: num(x.unit_price) * (num(x.quantity) || 1), undated: !okDate(x.payment_date) })
  for (const e of finEv) {
    const c = { table: 'financing_events', id: e.id, label: `EMPRÉSTIMO · ${lender.get(e.financing_id) || ''} · ${e.kind}${e.description ? ' · ' + e.description : ''}`, date: e.event_date, amount: num(e.amount), undated: false }
    push(e.kind === 'DISBURSEMENT' ? inn : out, c)
  }
  for (const c of capital) push(c.kind === 'CONTRIBUTION' ? inn : out, { table: 'capital_events', id: c.id, label: `CAPITAL · ${c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'} · ${c.member || ''}${c.description ? ' · ' + c.description : ''}`, date: c.event_date, amount: num(c.amount), undated: false })
  for (const p of payments) { if (!invById.get(p.invoice_id) || invById.get(p.invoice_id).is_quote) continue
    push(inn, { table: 'invoice_payments', id: p.id, label: `INCOME · ${invLabel(p.invoice_id)}${p.description ? ' · ' + p.description : ''}${p.source ? ' · ' + p.source : ''}`, date: p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || null), amount: num(p.amount), undated: !p.paid_at }) }
  // Grupos de compra: um pedido com vários itens vira UMA cobrança no banco.
  const groups = new Map<string, { amount: number; date: string | null; label: string; n: number; undated: boolean }>()
  for (const [tbl, rows] of [['goods', goods], ['inputs', inputs], ['inventory', inventory]] as const) {
    for (const r of rows) {
      if (!r.purchase_group || (tbl === 'inventory' && r.source_type !== 'PURCHASED')) continue
      if (taken.has(tbl + ':' + r.id)) continue
      const g = groups.get(r.purchase_group) || { amount: 0, date: null, label: `PEDIDO · ${r.supplier || tbl.toUpperCase()}`, n: 0, undated: false }
      g.amount += num(r.unit_price) * (num(r.quantity) || 1); g.n++
      const d = r.payment_date || r.purchase_date || null
      if (d && (!g.date || d < g.date)) g.date = d
      if (!okDate(r.payment_date)) g.undated = true
      groups.set(r.purchase_group, g)
    }
  }
  groups.forEach((g, id) => { if (g.n > 1) push(out, { table: 'purchase_group', id, label: `${g.label} · ${g.n} itens`, date: g.date, amount: g.amount, undated: g.undated }) })
  return { out, inn }
}

function tokens(s: string) { return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4)) }

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const limit = Math.min(3000, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '2000', 10) || 2000))
  const [lines, pool] = await Promise.all([
    db.from('bank_transactions').select('id, date, amount, name, merchant, pending, check_number, plaid_id').eq('match_status', 'NEW').order('date', { ascending: false }).limit(limit).then((r: any) => r.data || []),
    candidatePool(db),
  ])
  const { count: totalNew } = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('match_status', 'NEW')
  const enriched = lines.map((l: any) => {
    const amt = Math.abs(num(l.amount))
    const arr = num(l.amount) > 0 ? pool.out : pool.inn
    const bankTok = tokens((l.merchant || '') + ' ' + (l.name || ''))
    const cands = arr.filter(c => Math.abs(c.amount - amt) < 0.011).map(c => {
      let score = 50
      const dd = c.date ? daysBetween(c.date, l.date) : null
      if (dd === null) score += 5
      else if (dd === 0) score += 30
      else if (dd <= 3) score += 20
      else if (dd <= 7) score += 10
      else if (dd <= 30) score += 2
      else score -= 40
      if (c.undated) score += 5
      const lt = tokens(c.label); let hit = 0; bankTok.forEach(t => { if (lt.has(t)) hit++ })
      score += Math.min(15, hit * 5)
      return { ...c, score, dd }
    }).filter(c => (c.score || 0) > 20).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)
    return { id: l.id, date: l.date, amount: num(l.amount), name: l.merchant || l.name || '', raw_name: l.name || '', pending: !!l.pending, source: String(l.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID', candidates: cands }
  })
  return NextResponse.json({ ok: true, total_new: totalNew || 0, lines: enriched })
}

const DATE_TABLES = new Set(['invoice_expenses', 'fixed_cost_expenses', 'expenses', 'goods', 'good_expenses', 'inputs', 'inventory'])

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || ''), bankId = String(body.bank_id || '')
  if (!bankId || !['match', 'transfer', 'ignore', 'explain', 'unmatch'].includes(action)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const db = bankDb()
  const { data: line } = await db.from('bank_transactions').select('id, date, amount, name, merchant, match_status').eq('id', bankId).maybeSingle()
  if (!line) return NextResponse.json({ error: 'bank line not found' }, { status: 404 })
  const label = `${line.date} · ${line.merchant || line.name || ''} · ${num(line.amount)}`
  let update: Record<string, unknown> = {}
  const backfilled: string[] = []
  if (action === 'match') {
    const table = String(body.table || ''), rowId = String(body.row_id || '')
    if (!table || !rowId) return NextResponse.json({ error: 'table/row_id required' }, { status: 400 })
    update = { match_status: 'MATCHED', matched_table: table, matched_id: rowId, matched_note: String(body.note || '') || null }
    // Backfill: linha do app sem data de pagamento ganha a data do banco.
    if (DATE_TABLES.has(table)) {
      const { data: r } = await db.from(table).update({ payment_date: line.date }).eq('id', rowId).is('payment_date', null).select('id')
      if (r && r.length) backfilled.push(`${table}.payment_date=${line.date}`)
    } else if (table === 'invoice_payments') {
      const { data: r } = await db.from('invoice_payments').update({ paid_at: line.date + 'T12:00:00-04:00' }).eq('id', rowId).is('paid_at', null).select('id')
      if (r && r.length) backfilled.push(`invoice_payments.paid_at=${line.date}`)
    } else if (table === 'purchase_group') {
      for (const t of ['goods', 'inputs', 'inventory']) {
        const { data: r } = await db.from(t).update({ payment_date: line.date }).eq('purchase_group', rowId).is('payment_date', null).select('id')
        if (r && r.length) backfilled.push(`${t}×${r.length}.payment_date=${line.date}`)
      }
    }
  } else if (action === 'transfer') update = { match_status: 'TRANSFER', matched_table: null, matched_id: null, matched_note: String(body.note || 'transferência') }
  else if (action === 'ignore') update = { match_status: 'IGNORED', matched_table: null, matched_id: null, matched_note: String(body.note || '') || null }
  else if (action === 'explain') update = { match_status: 'QUEUED', matched_table: null, matched_id: null, matched_note: String(body.note || '').trim() || 'a lançar' }
  else if (action === 'unmatch') update = { match_status: 'NEW', matched_table: null, matched_id: null, matched_note: null }
  const { error } = await db.from('bank_transactions').update(update).eq('id', bankId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await db.from('data_fixes').insert({
    check_key: 'bank-reconcile', table_name: 'bank_transactions', row_id: bankId, field: 'match_status',
    old_value: line.match_status, new_value: String(update.match_status), label: (label + (backfilled.length ? ' → ' + backfilled.join(', ') : '')).slice(0, 200),
  }).then(() => undefined, () => undefined)
  return NextResponse.json({ ok: true, status: update.match_status, backfilled })
}
