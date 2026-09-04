import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { num, candidatePool, rank, isFee, nameHit, buildPlan, applyPlan, planSummary, newLines, writeMatch, writeUnmatch, writeStatus, logMatchEvent, fetchAll, loadDbAliases, loadRules, itemTwinKeys, acquireRun, finishRun, learnFromMatch, AUTO_BOOK_FLOOR, classify, bucketInvoiceId, createBucketRow, bucketReach, seedDefaultRules, supplierNameFor, signedDays, MARKER_BUCKET, MARKER_ASSIGNED, MARKER_ADOPTED, ENGINE_BUCKET, BUCKET_ORIGIN, INPUT_CATEGORIES, ATTRIB_REPORT_DAYS, ADOPT_WINDOW_DAYS, RULE_AGE_DAYS } from '@/lib/bankReconcile.server'
import { supplierDirectoryFrom } from '@/lib/supplierMatch'

// Rota fina da CONCILIAÇÃO BANCÁRIA — regras, pool e motores vivem em
// lib/bankReconcile.server.ts (v0.3.0). Tudo exige sessão (JWT no header).
// 300 s: o lote roda em fatias de 150 com paralelismo 6 (revisão #12).
export const maxDuration = 300

/* eslint-disable @typescript-eslint/no-explicit-any */
const MIGRATION_RE = /match_engine|match_batch|reviewed_at|backfill|bank_transaction_id|match_rule|bank_auto_runs|pfc_|klass|priority|invoices_bucket|bank_merchant_rules_key/
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
// Valor de uma linha de despesa de invoice (mesma conta do lib/financials).
const expLine = (r: any) => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra) - num(r.item_discount)
// Linha do banco com tudo que o balde precisa (raw do Plaid em aliases PostgREST).
// Marcador nunca é cortado pelo limite de 200 (revisão 16): corta o rótulo, não a marca.
const mark = (label: string, m: string) => String(label || '').slice(0, 200 - m.length - 1).trim() + ' ' + m
const BSEL = 'id, date, amount, name, merchant, pending, plaid_id, match_status, matched_table, matched_id, matched_note, match_engine, match_rule, match_batch, reviewed_at, backfill, category, entity:raw->>merchant_entity_id, pfc_detailed:raw->personal_finance_category->>detailed, processor:raw->payment_meta->>payment_processor, cps:raw->counterparties'

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    // ?matched=1 — só os pares (tabela, id) do app já casados com linha da Regions.
    // O Data Checker usa pra cravar paid_from = GZ28US: o banco provou quem pagou.
    if (req.nextUrl.searchParams.get('matched') === '1') {
      // Só pares SÓLIDOS viram "certo" no Data Checker: decisão humana (engine null)
      // ou casamento de motor JÁ conferido (reviewed_at) — revisão #20. O valor do
      // banco acompanha pra conferir grupos (total mudou = não é mais certo).
      const acc: { table: string; id: string; amount: number }[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('bank_transactions').select('matched_table, matched_id, amount, match_engine, reviewed_at').eq('match_status', 'MATCHED').not('matched_id', 'is', null).order('id').range(from, from + 999)
        if (error) throw new Error(error.message)
        for (const r of data || []) if (!r.match_engine || r.reviewed_at) acc.push({ table: r.matched_table, id: r.matched_id, amount: Math.abs(num(r.amount)) })
        if (!data || data.length < 1000) break
      }
      // Saídas da Regions (data, valor) — o Data Checker testa "consta na Regions?"
      // pra sugerir quem pagou. A conta abriu em 2025-11-10 com $0: antes disso,
      // nada foi GZ28US.
      const outs: { d: string; a: number }[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('bank_transactions').select('date, amount').gt('amount', 0).neq('match_status', 'REMOVED').order('id').range(from, from + 999)
        if (error) throw new Error(error.message)
        for (const r of data || []) outs.push({ d: r.date, a: Math.round(num(r.amount) * 100) / 100 })
        if (!data || data.length < 1000) break
      }
      return NextResponse.json({ ok: true, matched: acc, outflows: outs, account_opened: '2025-11-10' })
    }
    // AUTO-BOOK (BL 0.8.0) — sinal pro Data Checker: rodadas, registradas por
    // motor (24h/7d), NEW restantes desde o piso, erros, ÓRFÃOS (lançamento do
    // motor sem linha casada apontando) e DUPLAS (lançamento do motor com gêmeo
    // humano de mesmo valor até 14 dias — o humano lançou depois do banco).
    if (req.nextUrl.searchParams.get('autobook') === '1') {
      const runsQ = await db.from('bank_auto_runs').select('*').order('started_at', { ascending: false }).limit(20)
      if (runsQ.error) return NextResponse.json({ ok: true, needs_migration: true, floor: AUTO_BOOK_FLOOR, runs: [], booked_24h: {}, booked_7d: {}, remaining: 0, errors: [], orphans: [], dups: [], bucket: { total: 0, balance: 0, older_7d: 0 }, dead_pointers: [], amount_drift: [], seed: { skipped: [] } })
      const runs = runsQ.data || []
      const since7 = new Date(Date.now() - 7 * 864e5).toISOString(), since1 = new Date(Date.now() - 864e5).toISOString()
      const logs = await fetchAll(db, 'bank_match_log', 'at, action, engine', (q: any) => q.gte('at', since7).not('engine', 'is', null).in('action', ['MATCH', 'TRANSFER']))
      const by = (since: string) => logs.filter((r: any) => r.at >= since).reduce((m: Record<string, number>, r: any) => { m[r.engine] = (m[r.engine] || 0) + 1; return m }, {})
      const { count: remaining } = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('match_status', 'NEW').eq('pending', false).gte('date', AUTO_BOOK_FLOOR)
      const errors = [...new Set(runs.filter((r: any) => r.started_at >= since7).flatMap((r: any) => Array.isArray(r.errors) ? r.errors : []))].slice(0, 10)
      // órfãos: linha criada pelo motor (marcador + elo) sem linha MATCHED apontando pra ela
      const fxAuto = await fetchAll(db, 'fixed_cost_expenses', 'id, description, amount, bank_transaction_id, payment_date, supplier_id', (q: any) => q.not('bank_transaction_id', 'is', null).ilike('description', '%Bank Link)%'))
      const inAuto = await fetchAll(db, 'inputs', 'id, description, unit_price, quantity, order_number, payment_date, category', (q: any) => q.like('order_number', 'bank:%'))
      const bankIds = [...new Set([...fxAuto.map((r: any) => String(r.bank_transaction_id)), ...inAuto.map((r: any) => String(r.order_number).slice(5))])]
      const lineById = new Map<string, any>()
      for (let i = 0; i < bankIds.length; i += 200) { const { data } = await db.from('bank_transactions').select('id, name, merchant, amount, match_status, matched_table, matched_id').in('id', bankIds.slice(i, i + 200)); for (const l of data || []) lineById.set(String(l.id), l) }
      const pointsAt = (bankId: string, table: string, id: string) => { const l = lineById.get(bankId); return !!l && l.match_status === 'MATCHED' && l.matched_table === table && String(l.matched_id) === String(id) }
      // Linha REMOVED pelo Plaid (pending → posted com outro id): a linha do app
      // não é órfã de verdade — a substituta vai casá-la (o pool a solta). Sai
      // como SUBSTITUÍDA, sem PURGAR.
      const codeFor = (bankId: string) => (lineById.get(bankId)?.match_status === 'REMOVED' ? 'SUBSTITUÍDA' : 'ÓRFÃO')
      const orphans = [
        ...fxAuto.filter((r: any) => !pointsAt(String(r.bank_transaction_id), 'fixed_cost_expenses', r.id)).map((r: any) => ({ table: 'fixed_cost_expenses', id: r.id, label: r.description, amount: num(r.amount), bank_id: r.bank_transaction_id, code: codeFor(String(r.bank_transaction_id)) })),
        ...inAuto.filter((r: any) => !pointsAt(String(r.order_number).slice(5), 'inputs', r.id)).map((r: any) => ({ table: 'inputs', id: r.id, label: r.description, amount: num(r.unit_price) * (num(r.quantity) || 1), bank_id: String(r.order_number).slice(5), code: codeFor(String(r.order_number).slice(5)) })),
      ]
      // DUPLAS (revisão do diff: prova no nível dos motores, não menos): só
      // lançamentos criados por REGRA (tarifas fora), gêmeo na MESMA tabela e
      // com afinidade (mesmo fornecedor / mesma categoria), mesmo valor, ±14d,
      // e o NOME do banco batendo no rótulo — igual ao EXACT exige.
      const pool = await candidatePool(db)
      const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 864e5))
      const isRule = (desc: any) => /\(regra · Bank Link/.test(String(desc || ''))
      const autoRows = [
        ...fxAuto.filter((r: any) => isRule(r.description) && pointsAt(String(r.bank_transaction_id), 'fixed_cost_expenses', r.id)).map((r: any) => ({ table: 'fixed_cost_expenses', id: r.id, amount: num(r.amount), date: r.payment_date, bank_id: String(r.bank_transaction_id), label: r.description, supplier_id: r.supplier_id || null, category: null as string | null })),
        ...inAuto.filter((r: any) => isRule(r.description) && pointsAt(String(r.order_number).slice(5), 'inputs', r.id)).map((r: any) => ({ table: 'inputs', id: r.id, amount: num(r.unit_price) * (num(r.quantity) || 1), date: r.payment_date, bank_id: String(r.order_number).slice(5), label: r.description, supplier_id: null as string | null, category: r.category || null })),
      ]
      const dups = autoRows.flatMap(a => {
        const line = lineById.get(a.bank_id); if (!line) return []
        return pool.out.filter(c => c.table === a.table && c.id !== a.id && Math.abs(c.amount - a.amount) < 0.011 && c.date && a.date && dayDiff(c.date, a.date) <= 14
            && (a.table !== 'fixed_cost_expenses' || (c.supplier_id || null) === a.supplier_id)
            && (a.table !== 'inputs' || !a.category || new RegExp('SUPPLY · ' + a.category + ' ·', 'i').test(c.label))
            && nameHit(line, c))
          .slice(0, 1).map(c => ({ auto_table: a.table, auto_id: a.id, auto_label: a.label, bank_id: a.bank_id, twin_table: c.table, twin_id: c.id, twin_label: c.label, amount: a.amount, days: dayDiff(c.date!, a.date) }))
      })
      // ── BALDE (fase B): saldo, órfãos do balde, duplas do balde, ponteiro morto, valor mudado, PADRÃO pulado ──
      let bucketSig: any = { total: 0, balance: 0, older_7d: 0 }
      const deadPointers: any[] = [], amountDrift: any[] = []
      let seedSkipped: string[] = []
      try {
        const bucketId = await bucketInvoiceId(db)
        const brows = await fetchAll(db, 'invoice_expenses', 'id, item, supplier, price, quantity, tax, extra, item_discount, payment_date, purchase_group', (q: any) => q.eq('invoice_id', bucketId))
        const today = todayNY()
        bucketSig = { total: brows.length, balance: Math.round(brows.reduce((a: number, r: any) => a + expLine(r), 0) * 100) / 100, older_7d: brows.filter((r: any) => r.payment_date && signedDays(String(r.payment_date), today) > 7).length }
        // linhas do banco do balde (por id e por grupo) — pra órfão, dupla, ponteiro morto e valor
        const blines = await fetchAll(db, 'bank_transactions', 'id, name, merchant, amount, match_status, matched_table, matched_id, reviewed_at, match_engine', (q: any) => q.eq('match_status', 'MATCHED').in('matched_table', ['invoice_expenses', 'purchase_group']))
        // Órfão = NENHUMA linha casada apontando, de qualquer motor (a substituta do Plaid casa por EXACT — revisão 19).
        const byRow = new Map<string, any>(), byGroup = new Map<string, any>()
        for (const l of blines) { if (l.matched_table === 'invoice_expenses') byRow.set(String(l.matched_id), l); else if (l.matched_table === 'purchase_group') byGroup.set(String(l.matched_id), l) }
        for (const r of brows) {
          const l = byRow.get(String(r.id)) || (r.purchase_group ? byGroup.get(String(r.purchase_group)) : null)
          if (!l) { if (/Bank Link\)/.test(String(r.item || ''))) orphans.push({ table: 'invoice_expenses', id: r.id, label: [r.supplier, r.item].filter(Boolean).join(' · '), amount: expLine(r), bank_id: r.purchase_group || null, code: 'ÓRFÃO' }); continue }
          if (Math.abs(expLine(r) - Math.abs(num(l.amount))) >= 0.011) amountDrift.push({ bank_id: l.id, row_id: r.id, bank_amount: Math.abs(num(l.amount)), row_amount: expLine(r), label: [r.supplier, r.item].filter(Boolean).join(' · ') })
          // dupla do balde: gêmeo humano em QUALQUER tabela, valor na faixa do imposto, ±14d, nome batendo
          if (!l.reviewed_at && r.payment_date) {
            const tw = pool.out.filter(c => !(c.table === 'invoice_expenses' && c.id === r.id) && c.amount >= expLine(r) / 1.10 && c.amount <= expLine(r) + 2 && c.date && dayDiff(c.date, r.payment_date) <= 14 && nameHit(l, c)).slice(0, 1)
            for (const c of tw) dups.push({ auto_table: 'invoice_expenses', auto_id: r.id, auto_label: [r.supplier, r.item].filter(Boolean).join(' · '), bank_id: l.id, twin_table: c.table, twin_id: c.id, twin_label: c.label, amount: expLine(r), days: dayDiff(c.date!, r.payment_date) })
          }
        }
        // insumo/estoque atribuído pelo balde (elo purchase_group = id do banco) sem ponteiro
        for (const t of ['inputs', 'inventory'] as const) {
          const rows = await fetchAll(db, t, 'id, description, unit_price, quantity, purchase_group', (q: any) => q.ilike('description', '%' + MARKER_ASSIGNED + '%').not('purchase_group', 'is', null))
          const ids = [...new Set(rows.map((r: any) => String(r.purchase_group)))]
          const ptr = new Map<string, any>()
          for (let i = 0; i < ids.length; i += 200) { const { data } = await db.from('bank_transactions').select('id, match_status, matched_table, matched_id').in('id', ids.slice(i, i + 200)); for (const l of data || []) ptr.set(String(l.id), l) }
          for (const r of rows) { const l = ptr.get(String(r.purchase_group)); const ok = l && l.match_status === 'MATCHED' && ((l.matched_table === t && String(l.matched_id) === String(r.id)) || (l.matched_table === 'purchase_group' && String(l.matched_id) === String(r.purchase_group))); if (!ok) orphans.push({ table: t, id: r.id, label: r.description, amount: num(r.unit_price) * (num(r.quantity) || 1), bank_id: r.purchase_group, code: l && l.match_status === 'REMOVED' ? 'SUBSTITUÍDA' : 'ÓRFÃO' }) }
        }
        // ponteiro morto: linha do banco (BUCKET) apontando pra registro que sumiu
        const rowIds = new Set(brows.map((r: any) => String(r.id)))
        for (const l of blines) {
          if (l.match_engine !== ENGINE_BUCKET) continue   // ponteiro morto: só das linhas do balde
          if (l.matched_table === 'invoice_expenses') {
            if (rowIds.has(String(l.matched_id))) continue
            const { data } = await db.from('invoice_expenses').select('id').eq('id', l.matched_id).maybeSingle()
            if (!data) deadPointers.push({ bank_id: l.id, table: 'invoice_expenses', id: l.matched_id, label: l.merchant || l.name || '', amount: Math.abs(num(l.amount)) })
          } else if (['inputs', 'inventory', 'fixed_cost_expenses'].includes(String(l.matched_table))) {
            const { data } = await (db.from(l.matched_table) as any).select('id').eq('id', l.matched_id).maybeSingle()
            if (!data) deadPointers.push({ bank_id: l.id, table: l.matched_table, id: l.matched_id, label: l.merchant || l.name || '', amount: Math.abs(num(l.amount)) })
          } else if (l.matched_table === 'purchase_group') {
            const cnt = (await Promise.all(['invoice_expenses', 'inputs', 'inventory'].map(async t => { const { count } = await (db.from(t) as any).select('id', { count: 'exact', head: true }).eq('purchase_group', l.matched_id); return count || 0 }))).reduce((a, b) => a + b, 0)
            if (!cnt) deadPointers.push({ bank_id: l.id, table: 'purchase_group', id: l.matched_id, label: l.merchant || l.name || '', amount: Math.abs(num(l.amount)) })
          }
        }
        try { seedSkipped = (await seedDefaultRules(db, { dryRun: true })).skipped } catch { /* sem migration */ }
      } catch { /* balde sem migration: sinal vazio, o card avisa */ }
      return NextResponse.json({ ok: true, floor: AUTO_BOOK_FLOOR, runs: runs.slice(0, 10), booked_24h: by(since1), booked_7d: by(since7), remaining: remaining || 0, errors, orphans, dups, bucket: bucketSig, dead_pointers: deadPointers, amount_drift: amountDrift, seed: { skipped: seedSkipped } })
    }
    // A ATRIBUIR (fase B): a fila do balde — o saldo da conta de suspensão É a
    // lista de linhas; cada uma vem com classe, idade, gêmeo (guarda contra
    // duplicata) e sugestões de carro (fornecedor, última atribuição, data, job único).
    if (req.nextUrl.searchParams.get('bucket') === '1') {
      let bucketId = ''
      try { bucketId = await bucketInvoiceId(db) } catch (e) { return NextResponse.json({ ok: true, needs_migration: true, error: String((e as Error).message || e).slice(0, 200), total: 0, balance: 0, older_7d: 0, rows: [], attributed: [], invoices: [], fixed_suppliers: [], invariants: null }) }
      const today = todayNY()
      const [brows, invRow] = await Promise.all([
        fetchAll(db, 'invoice_expenses', 'id, item, supplier, price, quantity, tax, extra, item_discount, payment_date, expense_date, purchase_group, created_at', (q: any) => q.eq('invoice_id', bucketId)),
        db.from('invoices').select('id, invoice_code, ride_id, client_id, is_quote, live_status, origin').eq('id', bucketId).maybeSingle().then((x: any) => x.data),
      ])
      const rowIds = brows.map((r: any) => String(r.id)), groups = [...new Set(brows.map((r: any) => r.purchase_group).filter(Boolean).map(String))]
      const byRow = new Map<string, any>(), byGroup = new Map<string, any>()
      for (let i = 0; i < rowIds.length; i += 200) { const { data } = await db.from('bank_transactions').select(BSEL).eq('match_engine', ENGINE_BUCKET).eq('match_status', 'MATCHED').eq('matched_table', 'invoice_expenses').in('matched_id', rowIds.slice(i, i + 200)); for (const l of data || []) byRow.set(String(l.matched_id), l) }
      for (let i = 0; i < groups.length; i += 200) { const { data } = await db.from('bank_transactions').select(BSEL).eq('match_engine', ENGINE_BUCKET).eq('match_status', 'MATCHED').eq('matched_table', 'purchase_group').in('matched_id', groups.slice(i, i + 200)); for (const l of data || []) byGroup.set(String(l.matched_id), l) }
      const since60 = new Date(Date.now() - 60 * 864e5).toISOString()
      const attribLines = await fetchAll(db, 'bank_transactions', BSEL, (q: any) => q.eq('match_engine', ENGINE_BUCKET).eq('match_status', 'MATCHED').gte('reviewed_at', since60))
      const pool = await candidatePool(db)
      const [invoices, rides, fixedSups] = await Promise.all([
        fetchAll(db, 'invoices', 'id, invoice_code, ride_id, live_status, is_quote, origin', (q: any) => q.eq('is_quote', false).not('ride_id', 'is', null).neq('origin', BUCKET_ORIGIN).in('live_status', ['REALTIME', 'INCOMPLETE', 'CLOSED'])),
        fetchAll(db, 'rides', 'id, project_code, project_name'),
        fetchAll(db, 'fixed_cost_suppliers', 'id, company, cost_type', (q: any) => q.neq('cost_type', 'BANK').is('date_conclusion', null)),
      ])
      const rideById = new Map(rides.map((r: any) => [r.id, r]))
      const invList = invoices.map((i: any) => { const r = rideById.get(i.ride_id); return { id: i.id, code: i.invoice_code, ride_id: i.ride_id, ride_code: r?.project_code || '', ride_name: r?.project_name || '', closed: i.live_status === 'CLOSED' } })
        .sort((a: any, b: any) => Number(a.closed) - Number(b.closed) || String(a.ride_code).localeCompare(String(b.ride_code)) || String(a.code).localeCompare(String(b.code)))
      const openIds = invList.filter((i: any) => !i.closed).map((i: any) => i.id)
      // afinidade por fornecedor + última atribuição + mesma data — só invoices abertas
      const normSup = (x: string) => String(x || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '').replace(/[^a-z0-9]/g, '')
      const openExp: any[] = []
      for (let i = 0; i < openIds.length; i += 100) openExp.push(...await fetchAll(db, 'invoice_expenses', 'invoice_id, supplier, payment_date, expense_date, item, updated_at', (q: any) => q.in('invoice_id', openIds.slice(i, i + 100))))
      const bySup = new Map<string, Map<string, number>>()
      const lastAssign = new Map<string, { invoice_id: string; at: string }>()
      const byDate = new Map<string, Set<string>>()
      for (const e of openExp) {
        const k = normSup(e.supplier); if (k) { if (!bySup.has(k)) bySup.set(k, new Map()); const m = bySup.get(k)!; m.set(e.invoice_id, (m.get(e.invoice_id) || 0) + 1) }
        if (k && String(e.item || '').includes(MARKER_ASSIGNED)) { const prev = lastAssign.get(k); if (!prev || String(e.updated_at || '') > prev.at) lastAssign.set(k, { invoice_id: e.invoice_id, at: String(e.updated_at || '') }) }
        const d = String(e.payment_date || e.expense_date || '').slice(0, 10); if (d) { if (!byDate.has(d)) byDate.set(d, new Set()); byDate.get(d)!.add(e.invoice_id) }
      }
      const invMeta = new Map(invList.map((i: any) => [i.id, i]))
      const dayDiff2 = (a: string, b: string) => Math.abs(Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 864e5))
      const suggest = (row: any, line: any) => {
        const sug: any[] = []
        if (line && row.payment_date) {
          const tw = pool.out.filter(c => !(c.table === 'invoice_expenses' && c.id === row.id) && c.amount >= expLine(row) / 1.10 && c.amount <= expLine(row) + 2 && c.date && dayDiff2(c.date, row.payment_date) <= 14 && nameHit(line, c)).slice(0, 1)
          for (const c of tw) sug.push({ kind: 'TWIN', table: c.table, id: c.id, label: c.label, days: dayDiff2(c.date!, row.payment_date) })
        }
        const scores = new Map<string, { score: number; why: string }>()
        const bump = (inv: string, score: number, why: string) => { const cur = scores.get(inv); if (!cur || cur.score < score) scores.set(inv, { score, why }) }
        const k = normSup(row.supplier)
        const m = k ? bySup.get(k) : null
        if (m) m.forEach((n, inv) => bump(inv, Math.min(90, 60 + 10 * n), 'já comprou ' + n + '× deste fornecedor'))
        const la = k ? lastAssign.get(k) : null
        if (la && invMeta.has(la.invoice_id)) bump(la.invoice_id, 70, 'você atribuiu aqui da última vez')
        const d = String(row.payment_date || '').slice(0, 10)
        if (d && Number.isFinite(Date.parse(d))) for (const dd of [-1, 0, 1]) { const dt = new Date(Date.parse(d) + dd * 864e5).toISOString().slice(0, 10); const set = byDate.get(dt); if (set) set.forEach(inv => bump(inv, 8, 'compras do mesmo dia')) }
        if (openIds.length === 1) bump(openIds[0], 50, 'único job aberto')
        const cars = [...scores.entries()].filter(([inv]) => invMeta.has(inv)).sort((a, b) => b[1].score - a[1].score).slice(0, 3)
          .map(([inv, x]) => { const i = invMeta.get(inv)!; return { kind: 'CAR', invoice_id: inv, code: i.code, car: (i.ride_code + ' ' + i.ride_name).trim(), why: x.why, score: x.score } })
        return [...sug, ...cars]
      }
      const dir = supplierDirectoryFrom(await fetchAll(db, 'suppliers', 'id, name, aliases, is_dealership'))
      void dir
      const batchIds = [...new Set([...byRow.values(), ...byGroup.values()].map((l: any) => l.match_batch).filter(Boolean))]
      const runMeta = new Map<string, any>()
      for (let i = 0; i < batchIds.length; i += 200) { const { data } = await db.from('bank_auto_runs').select('id, trigger, started_at').in('id', batchIds.slice(i, i + 200)).then((x: any) => x, () => ({ data: [] })); for (const r of data || []) runMeta.set(r.id, r) }
      const rowsOut = brows.map((r: any) => {
        const l = byRow.get(String(r.id)) || (r.purchase_group ? byGroup.get(String(r.purchase_group)) : null)
        const cls = l ? classify(l) : null
        const run = l ? runMeta.get(l.match_batch) : null
        return {
          row_id: r.id, bank_id: l?.id || null, date: r.payment_date, amount: expLine(r), name: l ? (l.merchant || l.name || '') : (r.supplier || ''), raw_name: l?.name || '', source: l ? (String(l.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID') : '—',
          supplier: r.supplier || '', item: String(r.item || '').replace(MARKER_BUCKET, '').trim(), klass: cls?.klass || null, via: cls?.via || null, mcc: cls?.mcc || null,
          age_days: r.payment_date ? signedDays(String(r.payment_date), today) : null, batch: l?.match_batch || null, trigger: run?.trigger || null, started_at: run?.started_at || null,
          orphan: !l, suggestions: suggest(r, l),
        }
      }).sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.row_id).localeCompare(String(a.row_id))).slice(0, 2000)
      // ATRIBUÍDAS (60 dias): destino pelo ponteiro
      const carRowIds = attribLines.filter((l: any) => l.matched_table === 'invoice_expenses').map((l: any) => String(l.matched_id))
      const carInv = new Map<string, string>()
      for (let i = 0; i < carRowIds.length; i += 200) { const { data } = await db.from('invoice_expenses').select('id, invoice_id').in('id', carRowIds.slice(i, i + 200)); for (const r of data || []) carInv.set(String(r.id), r.invoice_id) }
      const invAll = new Map(invoices.map((i: any) => [i.id, i]))
      const attributed = attribLines.sort((a: any, b: any) => String(b.reviewed_at).localeCompare(String(a.reviewed_at))).map((l: any) => {
        const t = String(l.matched_table || '')
        const dest = t === 'invoice_expenses' ? 'CAR' : t === 'inventory' ? 'STOCK' : t === 'inputs' ? 'SUPPLIES' : t === 'fixed_cost_expenses' ? 'FIXO' : t === 'purchase_group' ? 'SPLIT' : '?'
        const inv = t === 'invoice_expenses' ? invAll.get(carInv.get(String(l.matched_id)) || '') : null
        const href = inv && inv.ride_id ? '/rides/' + inv.ride_id + '/invoices/' + inv.id : dest === 'STOCK' ? '/inventory' : dest === 'SUPPLIES' ? '/supplies' : dest === 'FIXO' ? '/costs/fixed' : '/adm/bank#a-atribuir'
        return { bank_id: l.id, date: l.date, amount: Math.abs(num(l.amount)), name: l.merchant || l.name || '', dest, label: String(l.matched_note || ''), href, reviewed_at: l.reviewed_at }
      })
      const balance = Math.round(brows.reduce((a: number, r: any) => a + expLine(r), 0) * 100) / 100
      return NextResponse.json({ ok: true, total: brows.length, balance, older_7d: rowsOut.filter((r: any) => (r.age_days || 0) > 7).length,
        invariants: invRow ? { id: invRow.id, invoice_code: invRow.invoice_code, ride_id: invRow.ride_id, client_id: invRow.client_id, is_quote: invRow.is_quote, live_status: invRow.live_status } : null,
        invoices: invList, fixed_suppliers: fixedSups.sort((a: any, b: any) => String(a.company).localeCompare(String(b.company))).map((x: any) => ({ id: x.id, company: x.company, cost_type: x.cost_type })),
        rows: rowsOut, attributed })
    }
    // TO BOOK (João, 31/ago): a fila da TRIAGEM inteira, com nota — pra ver só
    // o que está marcado "a lançar" e destriar linha a linha.
    if (req.nextUrl.searchParams.get('queued') === '1') {
      const rows = await fetchAll(db, 'bank_transactions', 'id, date, amount, name, merchant, matched_note', (q: any) => q.eq('match_status', 'QUEUED').order('date', { ascending: false }))
      return NextResponse.json({ ok: true, queued: rows.map((r: any) => ({ id: r.id, date: r.date, amount: num(r.amount), name: r.merchant || r.name || '', note: r.matched_note || '' })) })
    }
    const limit = Math.min(5000, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '3000', 10) || 3000))
    await loadDbAliases(db)
    const [lines, pool] = await Promise.all([newLines(db, limit), candidatePool(db)])
    const { count: totalNew } = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('match_status', 'NEW')
    const enriched = lines.map((l: any) => ({
      id: l.id, date: l.date, amount: num(l.amount), name: l.merchant || l.name || '', raw_name: l.name || '', pending: !!l.pending,
      source: String(l.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID', fee: isFee(l), candidates: rank(l, pool),
    }))
    // A CONFERIR: o que o motor casou e o Márcio ainda não viu. Sem a migration
    // (colunas match_engine/match_batch/reviewed_at/backfill) o card avisa e segue vivo.
    let auto: any = null, needsMigration = false
    const { data: autoRows, error: autoErr } = await db.from('bank_transactions')
      .select('id, date, amount, name, merchant, match_status, matched_table, matched_id, matched_note, match_engine, match_batch, match_rule, reviewed_at, plaid_id, backfill')
      .not('match_engine', 'is', null).in('match_status', ['MATCHED', 'TRANSFER']).order('date', { ascending: false }).range(0, 1999)
    if (autoErr) needsMigration = MIGRATION_RE.test(autoErr.message)
    else {
      // CONFERIR também no A CONFERIR (UX #1, João 25/ago): cada casamento do motor
      // ganha o link que abre o registro real — conferir sem link é obstáculo.
      const pend = (autoRows || []).filter((r: any) => !r.reviewed_at)
      const hrefOf = new Map<string, string>()
      const want = (t: string) => [...new Set(pend.filter((r: any) => r.matched_table === t).map((r: any) => String(r.matched_id)))]
      const grab = async (t: string, sel: string) => { const ids = want(t); if (!ids.length) return []; const { data } = await (db.from(t) as any).select(sel).in('id', ids); return data || [] }
      const [hIe, hIp, hPay, hFx, hKg] = await Promise.all([
        grab('invoice_expenses', 'id, invoice_id'), grab('invoice_parts', 'id, invoice_id'), grab('invoice_payments', 'id, invoice_id'),
        grab('fixed_cost_expenses', 'id, supplier_id'),
        (async () => { const ids = want('kit_group'); if (!ids.length) return []; const { data } = await db.from('invoice_parts').select('kit_group, invoice_id').in('kit_group', ids); return data || [] })(),
      ])
      const invNeed = new Map<string, string>()
      for (const r of hIe as any[]) invNeed.set('invoice_expenses:' + r.id, r.invoice_id)
      for (const r of hIp as any[]) invNeed.set('invoice_parts:' + r.id, r.invoice_id)
      for (const r of hPay as any[]) invNeed.set('invoice_payments:' + r.id, r.invoice_id)
      for (const r of hKg as any[]) if (!invNeed.has('kit_group:' + r.kit_group)) invNeed.set('kit_group:' + r.kit_group, r.invoice_id)
      const invIds = [...new Set([...invNeed.values()])].filter(Boolean)
      const rideOf = new Map<string, string>()
      const bucketInvs = new Set<string>()
      if (invIds.length) { const { data } = await db.from('invoices').select('id, ride_id, origin').in('id', invIds); for (const i of data || []) { if (i.origin === BUCKET_ORIGIN) bucketInvs.add(i.id); else if (i.ride_id) rideOf.set(i.id, i.ride_id) } }
      invNeed.forEach((inv, key) => { if (bucketInvs.has(inv)) { hrefOf.set(key, '/adm/bank#a-atribuir'); return } const ride = rideOf.get(inv); if (ride) hrefOf.set(key, `/rides/${ride}/invoices/${inv}`) })
      for (const r of pend) if (r.match_engine === ENGINE_BUCKET && r.matched_table === 'purchase_group') hrefOf.set(r.matched_table + ':' + r.matched_id, '/adm/bank#a-atribuir')
      const fxSupIds = [...new Set((hFx as any[]).map((r: any) => r.supplier_id).filter(Boolean))]
      const bankSups = new Set<string>()
      if (fxSupIds.length) { const { data: bs } = await db.from('fixed_cost_suppliers').select('id, cost_type').in('id', fxSupIds); for (const s of bs || []) if (s.cost_type === 'BANK') bankSups.add(s.id) }
      for (const r of hFx as any[]) hrefOf.set('fixed_cost_expenses:' + r.id, r.supplier_id ? (bankSups.has(r.supplier_id) ? '/costs/bank' : '/costs/fixed/' + r.supplier_id) : '/costs/fixed')
      const staticHref: Record<string, string> = { goods: '/goods', good_expenses: '/goods', inputs: '/supplies', inventory: '/inventory', expenses: '/staff', capital_events: '/adm/financials', financing_events: '/adm/financials' }
      for (const r of pend) { const k = r.matched_table + ':' + r.matched_id; if (!hrefOf.has(k) && staticHref[r.matched_table]) hrefOf.set(k, staticHref[r.matched_table]) }
      const batches = new Map<string, { batch: string; n: number; pending: number; fee: number; exact: number; name: number; rule: number; learn: number; transfer: number; bucket: number; from: string; to: string; trigger?: string | null; started_at?: string | null }>()
      for (const r of autoRows || []) {
        if (!r.match_batch) continue   // atribuída pela fila (batch nulo): trabalho humano, fora dos lotes
        const b = batches.get(r.match_batch) || { batch: r.match_batch, n: 0, pending: 0, fee: 0, exact: 0, name: 0, rule: 0, learn: 0, transfer: 0, bucket: 0, from: r.date, to: r.date }
        b.n++; if (!r.reviewed_at) b.pending++
        if (r.match_status === 'TRANSFER') b.transfer++
        else if (r.match_engine === 'FEE') b.fee++; else if (r.match_engine === 'NAME') b.name++; else if (r.match_engine === 'RULE') b.rule++; else if (r.match_engine === 'LEARN') b.learn++; else if (r.match_engine === ENGINE_BUCKET) b.bucket++; else b.exact++
        if (r.date < b.from) b.from = r.date; if (r.date > b.to) b.to = r.date
        batches.set(r.match_batch, b)
      }
      // Rodadas do AUTO-BOOK: o lote da rodada automática vira "AUTO · cron 03/09" no card.
      let runs: any[] = []
      try {
        const ids = [...batches.keys()].filter(Boolean)
        const { data: rr } = ids.length ? await db.from('bank_auto_runs').select('id, trigger, status, started_at, finished_at, counts, errors, remaining').in('id', ids) : { data: [] }
        for (const r of rr || []) { const b = batches.get(r.id); if (b) { b.trigger = r.trigger; b.started_at = r.started_at } }
        const { data: last } = await db.from('bank_auto_runs').select('id, trigger, status, started_at, finished_at, counts, errors, remaining').order('started_at', { ascending: false }).limit(10)
        runs = last || []
      } catch { /* sem migration do AUTO-BOOK ainda */ }
      auto = {
        pending: pend.map((r: any) => ({
          id: r.id, date: r.date, amount: num(r.amount), name: r.merchant || r.name || '', raw_name: r.name || '', engine: r.match_engine, batch: r.match_batch,
          status: r.match_status, rule: r.match_rule || null,
          note: String(r.matched_note || '').replace(/^AUTO · (FEE|EXACT|NAME|RULE|LEARN|BUCKET) · /, ''), source: String(r.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID',
          backfilled: Array.isArray(r.backfill) && r.backfill.length > 0, href: r.matched_table ? (hrefOf.get(r.matched_table + ':' + r.matched_id) || null) : null,
        })),
        reviewed: (autoRows || []).filter((r: any) => r.reviewed_at).length,
        batches: [...batches.values()],
        runs,
      }
    }
    // Plano a seco (GET ?plan=1): quantas linhas os motores casariam agora.
    const plan = req.nextUrl.searchParams.get('plan') === '1' ? planSummary(buildPlan(lines, pool, await loadRules(db), { itemTwins: await itemTwinKeys(db) })) : null
    return NextResponse.json({ ok: true, total_new: totalNew || 0, lines: enriched, auto, needs_migration: needsMigration, plan })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || '')
  const db = bankDb()
  try {
    /* ── ações de lote (motores) ── */
    if (action === 'auto') {
      // Sem a migration o motor não roda (revisão #17): sonda barata antes de qualquer escrita.
      const { error: probe } = await db.from('bank_transactions').select('match_engine, backfill, match_rule').limit(1)
      if (probe) return NextResponse.json({ error: 'rode MIGRATION_bank_reconcile_v030.sql antes: ' + probe.message, needs_migration: true }, { status: 409 })
      // BL 0.7.0/0.8.0: apelidos do banco (desempate NAME) + regras (humanas e
      // aprendidas) + assinatura do feed duplicado — o MESMO plano do autoBook,
      // só que sem maturidade: o humano vê o plano antes de aplicar.
      // Fase B: semeia as regras PADRÃO que faltam antes de planejar — o PLANEJAR já mostra o balde.
      let seedNote: string | null = null
      try { const sd = await seedDefaultRules(db); if (sd.inserted.length || sd.skipped.length) seedNote = sd.inserted.length + ' padrão(ões) semeado(s)' + (sd.skipped.length ? ' · pulados: ' + sd.skipped.join(' · ').slice(0, 200) : '') } catch (e) { seedNote = 'semear PADRÃO: ' + String((e as Error).message || e).slice(0, 120) }
      await loadDbAliases(db)
      const [rules, itemTwins] = await Promise.all([loadRules(db), itemTwinKeys(db)])
      const [lines, pool] = await Promise.all([newLines(db, 5000), candidatePool(db)])
      const plan = buildPlan(lines, pool, rules, { itemTwins })
      const summary = { ...planSummary(plan), seed: seedNote }
      if (body.plan) return NextResponse.json({ ok: true, plan: summary })
      // APLICAR roda o plano que foi MOSTRADO (hash); continuação de fatia passa batch.
      if (!body.batch && body.hash !== summary.hash) return NextResponse.json({ error: 'o plano mudou desde o PLANEJAR — planeje de novo', plan: summary }, { status: 409 })
      // Trava de rodada única (bank_auto_runs): APLICAR humano não corre junto com
      // o motor automático. Continuação de fatia reaproveita a rodada (batch = id).
      let batch = body.batch ? String(body.batch) : ''
      if (!batch) {
        let run: string | null = null
        try { run = await acquireRun(db, 'human') } catch (e) { return NextResponse.json({ error: 'trava de rodada falhou: ' + String((e as Error).message || e).slice(0, 200), needs_migration: MIGRATION_RE.test(String((e as Error).message || e)) }, { status: 500 }) }
        if (!run) return NextResponse.json({ error: 'motor automático rodando — tente em 1 min', plan: summary }, { status: 409 })
        batch = run
      } else {
        // Continuação de fatia: a rodada tem que estar VIVA (RUNNING) — a trava
        // segue nossa entre fatias; encerrada pelo tempo (15 min) ou por outro
        // motor ⇒ replaneje. Também rejeita batch forjado/velho.
        const { data: r } = await db.from('bank_auto_runs').select('status').eq('id', batch).maybeSingle()
        if (!r || r.status !== 'RUNNING') return NextResponse.json({ error: 'rodada encerrada (tempo ou outro motor) — planeje de novo', plan: summary }, { status: 409 })
      }
      let res
      try { res = await applyPlan(db, plan, { max: 150, batch }) }
      catch (e) { await finishRun(db, batch, { status: 'ERROR', errors: [String((e as Error).message || e).slice(0, 300)], note: 'APLICAR humano · exceção' }); throw e }
      const done = res.fee_create + res.fee_match + res.exact + res.name + res.rule_create + res.rule_adopt + res.transfer + res.bucket
      // Mesma condição do loop do card: enquanto ele vai mandar outra fatia, a rodada fica RUNNING (trava mantida).
      const cont = res.remaining > 0 && !res.errors.length
      await finishRun(db, batch, { status: cont ? 'RUNNING' : (res.remaining ? 'PARTIAL' : 'DONE'), counts: { fee_create: res.fee_create, fee_match: res.fee_match, exact: res.exact, name: res.name, rule_create: res.rule_create, rule_adopt: res.rule_adopt, learn: res.learn, transfer: res.transfer, bucket: res.bucket }, errors: res.errors, remaining: res.remaining, note: `APLICAR humano · ${done} nesta fatia` })
      return NextResponse.json({ ok: true, applied: res, plan: summary })
    }
    // SEMEAR PADRÕES (⚙, fase B): semeia o que falta; desligada nunca renasce.
    if (action === 'seed_defaults') {
      const r = await seedDefaultRules(db)
      await db.from('data_fixes').insert({ check_key: 'bank-bucket', table_name: 'bank_merchant_rules', row_id: 'seed', field: 'PADRÃO', old_value: null, new_value: String(r.inserted.length), label: ('SEMEAR PADRÕES · ' + r.inserted.length + ' novas · ' + r.skipped.length + ' puladas').slice(0, 200) }).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true, ...r })
    }
    // ── A FILA DO BALDE (fase B): atribuir / desatribuir ──
    if (action === 'assign' || action === 'assign_bulk' || action === 'unassign') {
      const bucketId = await bucketInvoiceId(db)
      const nowIso = () => new Date().toISOString()
      const today = todayNY()
      // A linha do banco do balde: por bank_id ou pelo row_id (caminho do Data Checker).
      const bucketLine = async (b: any) => {
        let bankId2 = String(b.bank_id || '')
        if (!bankId2 && b.row_id) { const { data } = await db.from('bank_transactions').select('id').eq('matched_table', 'invoice_expenses').eq('matched_id', String(b.row_id)).eq('match_engine', ENGINE_BUCKET).maybeSingle(); bankId2 = data?.id || '' }
        if (!bankId2) throw new Error('linha não está no balde — recarregue')
        const { data: line, error } = await db.from('bank_transactions').select(BSEL).eq('id', bankId2).maybeSingle()
        if (error) throw new Error(error.message)
        if (!line) throw new Error('linha não está no balde — recarregue')
        return line
      }
      const fixRow = (line: any, field: string, oldV: string | null, newV: string | null, label: string) => db.from('data_fixes').insert({ check_key: 'bank-bucket', table_name: 'bank_transactions', row_id: line.id, field, old_value: oldV, new_value: newV, label: label.slice(0, 200) }).then(() => undefined, () => undefined)
      const dir = supplierDirectoryFrom(await fetchAll(db, 'suppliers', 'id, name, aliases, is_dealership'))
      // Balão «EXPENSE PAID» só pra compra recente; backlog em silêncio (marca).
      const report = async (line: any, invoice: any, row: any): Promise<boolean> => {
        try {
          const mod: any = await import('@/lib/expenseReportNet.server')
          if (typeof mod.reportAttributedExpense !== 'function') return false
          const recent = signedDays(String(line.date), today) <= ATTRIB_REPORT_DAYS
          if (!recent) { if (typeof mod.markAttributedExpenseSilently === 'function' && row?.id) await mod.markAttributedExpenseSilently(db, row.id); return false }
          const r = await mod.reportAttributedExpense(db, { invoice, row, line })
          return !!(r && r.reported)
        } catch { return false }
      }

      const doAssign = async (b: any, bulk: boolean) => {
        const line = await bucketLine(b)
        if (line.match_status !== 'MATCHED' || line.match_engine !== ENGINE_BUCKET || line.reviewed_at || line.matched_table !== 'invoice_expenses') throw new Error('linha não está no balde — recarregue')
        const { data: row } = await db.from('invoice_expenses').select('*').eq('id', line.matched_id).maybeSingle()
        if (!row || row.invoice_id !== bucketId || String(row.purchase_group) !== String(line.id) || !String(row.item || '').includes(MARKER_BUCKET)) throw new Error('linha não está no balde — recarregue')
        const amt = Math.abs(num(line.amount))
        if (Math.abs(expLine(row) - amt) >= 0.011) throw new Error('valor da linha mudou (Plaid) — DESFAZER e deixe o motor recriar')
        const clean = String(row.item || '').replace(MARKER_BUCKET, '').trim()
        const label = String(b.item || '').trim() || clean
        const supplier = String(b.supplier || '').trim() || row.supplier || supplierNameFor(line, classify(line), dir)
        const dest = String(b.dest || '')
        const lineLabel = line.date + ' · ' + (line.merchant || line.name || '') + ' · ' + amt
        // Re-aponta a linha do banco (guardado pelo ponteiro atual e por reviewed_at nulo).
        const repoint = async (table: string, id: string, note: string, extra: Record<string, unknown> = {}) => {
          const { data } = await db.from('bank_transactions').update({ matched_table: table, matched_id: id, matched_note: note.slice(0, 150), reviewed_at: nowIso(), match_batch: null, ...extra })
            .eq('id', line.id).eq('match_status', 'MATCHED').eq('matched_table', 'invoice_expenses').eq('matched_id', row.id).is('reviewed_at', null).select('id')
          return !!(data && data.length)
        }
        const unpoint = async (table: string, id: string) => { await db.from('bank_transactions').update({ matched_table: 'invoice_expenses', matched_id: row.id, reviewed_at: null, match_batch: line.match_batch || null }).eq('id', line.id).eq('matched_table', table).eq('matched_id', id) }
        // Apaga a linha do balde (marcador + elo); 0 linhas = alguém mexeu.
        const dropBucketRow = async () => {
          const { data } = await db.from('invoice_expenses').delete().eq('id', row.id).eq('invoice_id', bucketId).eq('purchase_group', line.id).ilike('item', '%Bank Link)%').select('id')
          if (data && data.length) return true
          // 0 linhas: alguém mexeu (volta) ou a purga levou a linha no meio (o dinheiro já está no destino — segue).
          const { data: still } = await db.from('invoice_expenses').select('id').eq('id', row.id).maybeSingle()
          return !still
        }
        let learned: string | null = null, reported = false, href = '/adm/bank#a-atribuir', newId = ''
        if (dest === 'CAR') {
          const target = String(b.invoice_id || '')
          // rides/clients embutidos: o balão «EXPENSE PAID» diz o DONO do carro (revisão).
          const qi: any = db.from('invoices')
          const { data: inv } = await qi.select('id, invoice_code, ride_id, live_status, is_quote, origin, rides(project_name, project_code), clients(name)').eq('id', target).maybeSingle()
          if (!inv || inv.is_quote || inv.origin === BUCKET_ORIGIN) throw new Error('invoice de destino inválida')
          const closed = inv.live_status === 'CLOSED'
          if (closed && !b.force_closed) throw new Error('invoice fechada — confirme «reabre o período» ou escolha outra')
          const { data: moved } = await db.from('invoice_expenses').update({ invoice_id: target, item: mark(label, MARKER_ASSIGNED), supplier: supplier.slice(0, 120), position: null, updated_at: nowIso() }).eq('id', row.id).eq('invoice_id', bucketId).select('id')
          if (!moved || !moved.length) throw new Error('linha não está no balde — recarregue')
          const note = 'ATRIBUÍDA · CARRO ' + (inv.invoice_code || '') + (closed ? ' · JOB FECHADO · reabre período' : '') + ' · ' + label
          const ok = await repoint('invoice_expenses', row.id, note, { backfill: [{ t: 'invoice_expenses', id: row.id, f: 'invoice_id', v: target, o: bucketId }] })
          if (!ok) { await db.from('invoice_expenses').update({ invoice_id: bucketId, item: row.item, supplier: row.supplier, position: row.position }).eq('id', row.id).eq('invoice_id', target); throw new Error('linha do banco já decidida — recarregue') }
          await logMatchEvent(db, line, 'MATCH', { matched_table: 'invoice_expenses', matched_id: row.id, note, engine: ENGINE_BUCKET })
          if (!bulk) reported = await report(line, inv, { ...row, invoice_id: target, item: label, supplier })
          href = inv.ride_id ? '/rides/' + inv.ride_id + '/invoices/' + inv.id : '/adm/reports'
          newId = row.id
          await fixRow(line, 'assign', 'A ATRIBUIR', 'CAR ' + (inv.invoice_code || ''), 'CARRO · ' + lineLabel + ' → ' + (inv.invoice_code || '') + (closed ? ' (FECHADA)' : ''))
        } else if (dest === 'STOCK' || dest === 'SUPPLIES') {
          const table = dest === 'STOCK' ? 'inventory' : 'inputs'
          const category = dest === 'STOCK' ? 'STOCK' : (INPUT_CATEGORIES.includes(String(b.category)) ? String(b.category) : 'CONSUMPTION')
          const ins: any = { description: mark(label, MARKER_ASSIGNED), category, quantity: 1, unit_price: amt, supplier: supplier.slice(0, 120), purchase_date: line.date, payment_date: line.date, paid_from: 'GZ28US', paid_to: null, payment_method: 'BANK ACCOUNT', source: 'GZ28US', purchase_group: line.id, order_number: b.order_number ? String(b.order_number).slice(0, 120) : null, picked_up: false }
          if (dest === 'STOCK') { ins.source_type = 'PURCHASED'; ins.part_id = null }
          const { data: created, error } = await (db.from(table) as any).insert(ins).select('id').single()
          if (error || !created) throw new Error(table + ': ' + (error?.message || 'insert falhou'))
          newId = created.id
          const note = 'ATRIBUÍDA · ' + (dest === 'STOCK' ? 'ESTOQUE' : 'SUPPLIES ' + category) + ' · ' + label
          if (!await repoint(table, newId, note)) { await (db.from(table) as any).delete().eq('id', newId).eq('purchase_group', line.id); throw new Error('linha do banco já decidida — recarregue') }
          if (!await dropBucketRow()) { await unpoint(table, newId); await (db.from(table) as any).delete().eq('id', newId).eq('purchase_group', line.id); throw new Error('linha não está no balde — recarregue') }
          await logMatchEvent(db, line, 'MATCH', { matched_table: table, matched_id: newId, note, engine: ENGINE_BUCKET })
          if (dest === 'SUPPLIES') learned = await learnFromMatch(db, line, { table: 'inputs', id: newId })
          href = dest === 'STOCK' ? '/inventory' : '/supplies'
          await fixRow(line, 'assign', 'A ATRIBUIR', dest, (dest === 'STOCK' ? 'ESTOQUE' : 'SUPPLIES ' + category) + ' · ' + lineLabel)
        } else if (dest === 'FIXO') {
          const supplierId = String(b.supplier_id || '')
          const { data: sup } = await db.from('fixed_cost_suppliers').select('id, company, cost_type').eq('id', supplierId).maybeSingle()
          if (!sup || sup.cost_type === 'BANK') throw new Error('fornecedor de custo fixo inválido')
          // ADOTA a agendada do mês (±20 d, ±50% ou ≤ $100) ou cria SINGLE paga.
          const { data: open } = await db.from('fixed_cost_expenses').select('id, expense_date, amount, description, paid_from').eq('supplier_id', supplierId).is('payment_date', null).is('bank_transaction_id', null)
          const near = (open || []).filter((a: any) => a.expense_date && Math.abs(signedDays(String(a.expense_date), String(line.date))) <= ADOPT_WINDOW_DAYS && Math.abs(num(a.amount) - amt) <= Math.max(100, 0.5 * num(a.amount)))
            .sort((a: any, x: any) => Math.abs(signedDays(String(a.expense_date), String(line.date))) - Math.abs(signedDays(String(x.expense_date), String(line.date))))
          let backfill: any[] | null = null
          if (near.length) {
            const a = near[0]
            const newDesc = (String(a.description || label) + ' ' + MARKER_ADOPTED).slice(0, 200)
            const { data: claimed } = await db.from('fixed_cost_expenses').update({ amount: amt, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: line.id, description: newDesc, payment_date: line.date }).eq('id', a.id).is('payment_date', null).is('bank_transaction_id', null).select('id')
            if (claimed && claimed.length) {
              newId = a.id
              backfill = [
                { t: 'fixed_cost_expenses', id: a.id, f: 'amount', v: String(amt), o: String(a.amount) }, { t: 'fixed_cost_expenses', id: a.id, f: 'paid_from', v: 'GZ28US', o: a.paid_from ?? null },
                { t: 'fixed_cost_expenses', id: a.id, f: 'payment_method', v: 'BANK ACCOUNT', o: null }, { t: 'fixed_cost_expenses', id: a.id, f: 'bank_transaction_id', v: String(line.id), o: null },
                { t: 'fixed_cost_expenses', id: a.id, f: 'description', v: newDesc, o: a.description ?? null }, { t: 'fixed_cost_expenses', id: a.id, f: 'payment_date', v: String(line.date), o: null },
              ]
            }
          }
          if (!newId) {
            const { data: created, error } = await db.from('fixed_cost_expenses').insert({ supplier_id: supplierId, type: 'SINGLE', description: mark(label, MARKER_ASSIGNED), amount: amt, source: 'GZ28US', expense_date: line.date, payment_date: line.date, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: line.id }).select('id').single()
            if (error || !created) throw new Error('fixed_cost_expenses: ' + (error?.message || 'insert falhou'))
            newId = created.id
          }
          const note = 'ATRIBUÍDA · FIXO ' + (sup.company || '') + (backfill ? ' · ADOTOU agendada' : '') + ' · ' + label
          const revertFixed = async () => { if (backfill) { for (const x of backfill) await (db.from('fixed_cost_expenses') as any).update({ [x.f]: x.o ?? null }).eq('id', x.id).eq(x.f, x.v) } else await db.from('fixed_cost_expenses').delete().eq('id', newId).eq('bank_transaction_id', line.id) }
          if (!await repoint('fixed_cost_expenses', newId, note, backfill ? { backfill } : {})) { await revertFixed(); throw new Error('linha do banco já decidida — recarregue') }
          if (!await dropBucketRow()) { await unpoint('fixed_cost_expenses', newId); await revertFixed(); throw new Error('linha não está no balde — recarregue') }
          await logMatchEvent(db, line, 'MATCH', { matched_table: 'fixed_cost_expenses', matched_id: newId, note, engine: ENGINE_BUCKET })
          learned = await learnFromMatch(db, line, { table: 'fixed_cost_expenses', id: newId, supplier_id: supplierId })
          if (!bulk) reported = await report(line, { invoice_code: 'FIXO', owner: sup.company }, { id: newId, item: label, supplier: sup.company, price: amt, payment_date: line.date })
          href = '/costs/fixed/' + supplierId
          await fixRow(line, 'assign', 'A ATRIBUIR', 'FIXO', 'FIXO ' + (sup.company || '') + ' · ' + lineLabel)
        } else if (dest === 'SPLIT') {
          const parts = Array.isArray(b.parts) ? b.parts : []
          if (parts.length < 2 || parts.length > 10) throw new Error('DIVIDIR pede de 2 a 10 partes')
          const sum = parts.reduce((a: number, x: any) => a + num(x.amount), 0)
          if (parts.some((x: any) => !(num(x.amount) > 0)) || Math.abs(sum - amt) >= 0.011) throw new Error('as partes têm que somar exatamente o valor da linha')
          const invCache = new Map<string, any>()
          for (const x of parts) {
            if (x.dest === 'CAR') { const { data: inv } = await db.from('invoices').select('id, invoice_code, ride_id, live_status, is_quote, origin').eq('id', String(x.invoice_id || '')).maybeSingle(); if (!inv || inv.is_quote || inv.origin === BUCKET_ORIGIN) throw new Error('invoice de destino inválida numa parte'); if (inv.live_status === 'CLOSED' && !x.force_closed) throw new Error('invoice fechada numa parte — confirme «reabre o período»'); invCache.set(inv.id, inv) }
            else if (!['STOCK', 'SUPPLIES'].includes(String(x.dest))) throw new Error('parte só pode ir pra CARRO, ESTOQUE ou SUPPLIES (FIXO é ação da linha inteira — revisão C7: custo fixo não tem purchase_group)')
          }
          const members: { table: string; id: string }[] = []
          const undoParts = async () => { for (const m of members) await (db.from(m.table) as any).delete().eq('id', m.id).eq(m.table === 'fixed_cost_expenses' ? 'bank_transaction_id' : 'purchase_group', line.id) }
          try {
            for (const x of parts) {
              const pl = String(x.item || '').trim() || label
              const pa = Math.round(num(x.amount) * 100) / 100
              if (x.dest === 'CAR') {
                const { data: c, error } = await db.from('invoice_expenses').insert({ invoice_id: String(x.invoice_id), item: mark(pl, MARKER_ASSIGNED), supplier: supplier.slice(0, 120), price: pa, quantity: 1, tax: 0, extra: 0, item_discount: 0, expense_date: line.date, payment_date: line.date, paid_from: 'GZ28US', paid_to: 'GZ28US', payment_method: 'BANK ACCOUNT', source: 'GZ28US', purchase_group: line.id, export_status: 'FRESH', picked_up: false, receipt_proves_payment: false }).select('id').single()
                if (error || !c) throw new Error('invoice_expenses: ' + (error?.message || 'insert falhou')); members.push({ table: 'invoice_expenses', id: c.id })
              } else if (x.dest === 'STOCK' || x.dest === 'SUPPLIES') {
                const table = x.dest === 'STOCK' ? 'inventory' : 'inputs'
                const category = x.dest === 'STOCK' ? 'STOCK' : (INPUT_CATEGORIES.includes(String(x.category)) ? String(x.category) : 'CONSUMPTION')
                const ins: any = { description: mark(pl, MARKER_ASSIGNED), category, quantity: 1, unit_price: pa, supplier: supplier.slice(0, 120), purchase_date: line.date, payment_date: line.date, paid_from: 'GZ28US', paid_to: null, payment_method: 'BANK ACCOUNT', source: 'GZ28US', purchase_group: line.id, picked_up: false }
                if (x.dest === 'STOCK') { ins.source_type = 'PURCHASED'; ins.part_id = null }
                const { data: c, error } = await (db.from(table) as any).insert(ins).select('id').single()
                if (error || !c) throw new Error(table + ': ' + (error?.message || 'insert falhou')); members.push({ table, id: c.id })
              } else {
                const { data: c, error } = await db.from('fixed_cost_expenses').insert({ supplier_id: String(x.supplier_id), type: 'SINGLE', description: mark(pl, MARKER_ASSIGNED), amount: pa, source: 'GZ28US', expense_date: line.date, payment_date: line.date, paid_from: 'GZ28US', payment_method: 'BANK ACCOUNT', bank_transaction_id: line.id }).select('id').single()
                if (error || !c) throw new Error('fixed_cost_expenses: ' + (error?.message || 'insert falhou')); members.push({ table: 'fixed_cost_expenses', id: c.id })
              }
            }
            const note = 'ATRIBUÍDA · DIVIDIDA em ' + parts.length + ' · ' + label
            if (!await repoint('purchase_group', String(line.id), note)) throw new Error('linha do banco já decidida — recarregue')
            if (!await dropBucketRow()) { await unpoint('purchase_group', String(line.id)); throw new Error('linha não está no balde — recarregue') }
            await logMatchEvent(db, line, 'MATCH', { matched_table: 'purchase_group', matched_id: String(line.id), note, engine: ENGINE_BUCKET, members })
            await fixRow(line, 'assign', 'A ATRIBUIR', 'SPLIT ' + parts.length, 'DIVIDIR ' + parts.length + ' · ' + lineLabel)
          } catch (e) { await undoParts(); throw e }
          newId = String(line.id)
        } else throw new Error('destino inválido')
        return { dest, row_id: newId, href, learned, reported }
      }

      if (action === 'assign_bulk') {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map((x: any) => String(x)).filter(Boolean).slice(0, 400)
        let n = 0; const errors: string[] = []
        for (const id of ids) { try { await doAssign({ ...body, bank_id: id, ids: undefined }, true); n++ } catch (e) { errors.push(id.slice(0, 8) + ': ' + String((e as Error).message || e).slice(0, 120)) } }
        return NextResponse.json({ ok: true, n, errors })
      }
      if (action === 'assign') {
        const r = await doAssign(body, false)
        return NextResponse.json({ ok: true, ...r })
      }
      // DESATRIBUIR (nível 1): a atribuição volta; o dinheiro continua lançado no balde.
      const line = await bucketLine(body)
      if (line.match_status !== 'MATCHED' || line.match_engine !== ENGINE_BUCKET || !line.reviewed_at) throw new Error('linha não está atribuída — recarregue')
      const reach = await bucketReach(db, line, bucketId)
      const dirty = reach.filter(r => !/Bank Link/.test(r.text))
      if (dirty.length) throw new Error('parte editada por gente — desfaça na invoice (' + [...new Set(dirty.map(r => r.table))].join(', ') + ')')
      const changed: string[] = []
      const bf: any[] = Array.isArray(line.backfill) ? line.backfill : []
      const carEntry = bf.find((x: any) => x.t === 'invoice_expenses' && x.f === 'invoice_id')
      let supplierBack = ''
      if (line.matched_table === 'invoice_expenses' && carEntry) {
        const { data: cur } = await db.from('invoice_expenses').select('id, item, supplier').eq('id', carEntry.id).maybeSingle()
        const clean = String(cur?.item || '').replace(MARKER_ASSIGNED, '').trim()
        const { data: r } = await db.from('invoice_expenses').update({ invoice_id: bucketId, item: mark(clean, MARKER_BUCKET), order_number: null, updated_at: nowIso() }).eq('id', carEntry.id).eq('invoice_id', carEntry.v).select('id')
        if (!r || !r.length) throw new Error('a linha já mudou de carro — desfaça lá')
        // PESCA desfeita: a linha do balde não é pedido vivo — solta o elo com o STREAM.
        await db.from('part_stream_items').delete().eq('source_table', 'invoice_expenses').eq('source_id', carEntry.id).then(() => undefined, () => undefined)
        supplierBack = cur?.supplier || ''
        changed.push('voltou pro balde')
        const { data: ok } = await db.from('bank_transactions').update({ reviewed_at: null, match_batch: null, backfill: null, matched_note: ('A ATRIBUIR (devolvida) · ' + supplierBack).slice(0, 150) }).eq('id', line.id).eq('matched_table', 'invoice_expenses').eq('matched_id', carEntry.id).not('reviewed_at', 'is', null).select('id')
        if (!ok || !ok.length) { await db.from('invoice_expenses').update({ invoice_id: carEntry.v, item: cur?.item || null }).eq('id', carEntry.id).eq('invoice_id', bucketId); throw new Error('linha do banco já decidida — recarregue') }
        await logMatchEvent(db, line, 'MATCH', { matched_table: 'invoice_expenses', matched_id: carEntry.id, note: 'DESATRIBUÍDA · ' + supplierBack, engine: ENGINE_BUCKET })
      } else {
        // ESTOQUE/SUPPLIES/FIXO/DIVIDIDA: nasce uma linha nova no balde, o ponteiro
        // volta pra ela, e os destinos (marcador + elo) morrem; adotada volta pelo backfill.
        const made = await createBucketRow(db, line, dir)
        supplierBack = made.supplier
        const { data: ok } = await db.from('bank_transactions').update({ matched_table: 'invoice_expenses', matched_id: made.id, reviewed_at: null, match_batch: null, backfill: null, matched_note: ('A ATRIBUIR (devolvida) · ' + made.supplier).slice(0, 150) })
          .eq('id', line.id).eq('match_status', 'MATCHED').eq('matched_table', line.matched_table).eq('matched_id', line.matched_id).not('reviewed_at', 'is', null).select('id')
        if (!ok || !ok.length) { await db.from('invoice_expenses').delete().eq('id', made.id).eq('invoice_id', bucketId); throw new Error('linha do banco já decidida — recarregue') }
        for (const x of bf) { if (x.t === 'fixed_cost_expenses') { const q1: any = db.from('fixed_cost_expenses'); const { data: r } = await q1.update({ [x.f]: x.o ?? null }).eq('id', x.id).eq(x.f, x.v).select('id'); if (r && r.length) changed.push(x.f + '→' + (x.o ?? 'null')) } }
        const del = async (table: string, col: string, f: (q: any) => any, msg: string) => { const q0: any = (db.from(table) as any).delete().eq('purchase_group', line.id).ilike(col, '%' + MARKER_ASSIGNED + '%'); const { data: r } = await f(q0).select('id'); if (r && r.length) changed.push(msg + (r.length > 1 ? ' ×' + r.length : '')) }
        await del('inputs', 'description', q => q, 'insumo apagado'); await del('inventory', 'description', q => q, 'estoque apagado'); await del('invoice_expenses', 'item', q => q.neq('invoice_id', bucketId), 'parte apagada')
        { const { data: r } = await db.from('fixed_cost_expenses').delete().eq('bank_transaction_id', line.id).ilike('description', '%' + MARKER_ASSIGNED + '%').select('id'); if (r && r.length) changed.push('custo fixo apagado') }
        await logMatchEvent(db, line, 'MATCH', { matched_table: 'invoice_expenses', matched_id: made.id, note: 'DESATRIBUÍDA · ' + made.supplier, engine: ENGINE_BUCKET })
      }
      await fixRow(line, 'unassign', String(line.matched_table), 'A ATRIBUIR', ('DESATRIBUIR · ' + line.date + ' · ' + (line.merchant || line.name || '') + (changed.length ? ' → ' + changed.join(', ') : '')))
      return NextResponse.json({ ok: true, changed })
    }
    // TRIAGEM POR FAMÍLIA (João, 25/ago): EXPLAIN em massa — NEW → QUEUED (TO
    // BOOK) com a nota da família. Guarda NEW+não-pendente no WHERE: linha já
    // decidida ou pendente não é tocada. Reverter: unqueue (abaixo).
    if (action === 'bulk_explain') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x: any) => String(x)).filter(Boolean).slice(0, 800)
      const note = String(body.note || '').trim().slice(0, 120)
      if (!ids.length || !note) return NextResponse.json({ error: 'ids e note obrigatórios' }, { status: 400 })
      const { data, error } = await db.from('bank_transactions').update({ match_status: 'QUEUED', matched_note: 'TRIAGEM · ' + note, matched_table: null, matched_id: null }).in('id', ids).eq('match_status', 'NEW').eq('pending', false).select('id, date, name, merchant, amount')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      for (const r of data || []) await logMatchEvent(db, r, 'QUEUE', { note: 'TRIAGEM · ' + note })
      await db.from('data_fixes').insert({
        check_key: 'bank-reconcile', table_name: 'bank_transactions', row_id: ids[0], field: 'match_status',
        old_value: 'NEW', new_value: 'QUEUED', label: ('TRIAGEM · ' + note + ' · ' + (data || []).length + ' linhas').slice(0, 200),
      }).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true, n: (data || []).length })
    }
    if (action === 'unqueue') {
      const bankId2 = String(body.bank_id || '')
      if (!bankId2) return NextResponse.json({ error: 'bank_id required' }, { status: 400 })
      const { data, error } = await db.from('bank_transactions').update({ match_status: 'NEW', matched_note: null }).eq('id', bankId2).eq('match_status', 'QUEUED').select('id, date, name, merchant, amount')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data || !data.length) return NextResponse.json({ error: 'linha não está em TO BOOK — recarregue' }, { status: 409 })
      await logMatchEvent(db, data[0], 'UNQUEUE', {})
      return NextResponse.json({ ok: true })
    }
    // RESTAURAR DIÁRIO (31/ago, pós-reset do Márcio): reencena o ESTADO FINAL
    // de cada linha NEW a partir do bank_match_log — MATCH refaz o casamento
    // (com backfill) se o alvo ainda existe; TRANSFER/IGNORE/QUEUE reescrevem o
    // status. UNMATCH/UNQUEUE como último registro = linha fica NEW mesmo.
    // Idempotente: rodar duas vezes não muda nada.
    if (action === 'restore_log') {
      const { error: probeL } = await db.from('bank_match_log').select('id').limit(1)
      if (probeL) return NextResponse.json({ error: 'rode MIGRATION_bank_match_log.sql antes: ' + probeL.message, needs_migration: true }, { status: 409 })
      const logs = await fetchAll(db, 'bank_match_log', '*', (q: any) => q.order('at', { ascending: false }))
      const latest = new Map<string, any>()
      for (const r of logs) if (!latest.has(r.bank_id)) latest.set(r.bank_id, r)
      const lines2 = await fetchAll(db, 'bank_transactions', '*', (q: any) => q.eq('match_status', 'NEW'))
      let matched = 0, statused = 0, gone = 0, errors2 = 0
      for (const l of lines2) {
        const r = latest.get(String(l.id)); if (!r) continue
        try {
          if (r.action === 'MATCH' && r.matched_table && r.matched_id) {
            if (!['purchase_group', 'kit_group'].includes(r.matched_table)) {
              const { data: tgt } = await (db.from(r.matched_table) as any).select('id').eq('id', r.matched_id).maybeSingle()
              if (!tgt) { gone++; continue }
            }
            // Linha do balde ATRIBUÍDA volta atribuída (reviewed_at = quando foi) — senão fica presa em A CONFERIR sem ação (revisão 23).
            const attributed = r.engine === ENGINE_BUCKET && /^ATRIBUÍDA/.test(String(r.note || ''))
            await writeMatch(db, l, { table: r.matched_table, id: r.matched_id, members: Array.isArray(r.members) ? r.members : [] }, { matched_note: r.note || null, match_engine: r.engine || null, match_batch: attributed ? null : (r.batch || null), reviewed_at: attributed ? r.at : null })
            matched++
          } else if (['TRANSFER', 'IGNORE', 'QUEUE'].includes(r.action)) {
            const st = r.action === 'QUEUE' ? 'QUEUED' : r.action === 'IGNORE' ? 'IGNORED' : 'TRANSFER'
            await writeStatus(db, l, st, { note: r.note || null, engine: r.engine || null, batch: r.batch || null })
            statused++
          }
        } catch { errors2++ }
      }
      await db.from('data_fixes').insert({
        check_key: 'bank-reconcile', table_name: 'bank_transactions', row_id: 'restore_log', field: 'match_status',
        old_value: 'NEW', new_value: 'RESTORED', label: `RESTAURAR DIÁRIO · ${matched} casadas · ${statused} status · ${gone} alvos sumidos · ${errors2} erros`.slice(0, 200),
      }).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true, matched, statused, gone, errors: errors2 })
    }
    if (action === 'undo_batch') {
      const batch = String(body.batch || '')
      if (!batch) return NextResponse.json({ error: 'batch required' }, { status: 400 })
      // Rodada ainda VIVA não se desfaz (a próxima fatia recasaria em silêncio).
      const { data: runRow } = await db.from('bank_auto_runs').select('status').eq('id', batch).maybeSingle().then((x: any) => x, () => ({ data: null }))
      if (runRow && runRow.status === 'RUNNING') return NextResponse.json({ error: 'rodada em andamento — espere terminar (ou 15 min) antes de desfazer' }, { status: 409 })
      // Fase B: lotes de centenas de linhas — desfaz em fatias de 200 (o card repete enquanto remaining > 0).
      const { data: rows, error } = await db.from('bank_transactions').select('id, date, amount, name, merchant, match_status, matched_table, matched_id, match_engine, match_rule, backfill, reviewed_at, match_batch').eq('match_batch', batch).in('match_status', ['MATCHED', 'TRANSFER']).order('date').limit(200)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const { count: totalInBatch } = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('match_batch', batch).in('match_status', ['MATCHED', 'TRANSFER'])
      let n = 0; const errors: string[] = []; const fixes: any[] = []; const undone: string[] = []
      for (const r of rows || []) {
        try {
          const changed: string[] = []; await writeUnmatch(db, r, changed, { unlearn: false }); n++; undone.push(String(r.id))
          await logMatchEvent(db, r, 'UNMATCH', { batch })
          fixes.push({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id: r.id, field: 'match_status', old_value: r.match_status, new_value: 'NEW', label: (`DESFAZER LOTE · ${r.date} · ${r.merchant || r.name || ''} · ${num(r.amount)}` + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200) })
        } catch (e) { errors.push(`${r.date} ${r.merchant || r.name}: ` + String((e as Error).message || e)) }
      }
      // AFIRMA que nada criado pelo motor sobrou pendurado no lote (revisão #2) —
      // só nas linhas de fato desfeitas (as que falharam continuam casadas, de propósito).
      const ids = undone
      if (ids.length) {
        // Afirmação em blocos de 200 (revisão 22): erro de consulta é FALHA da afirmação, nunca «zero sobras».
        let left = 0, probeErr = 0
        const cnt = async (table: string, f: (q: any, chunk: string[]) => any) => { for (let i = 0; i < ids.length; i += 200) { const q0: any = db.from(table).select('id'); const { data, error: e2 } = await f(q0, ids.slice(i, i + 200)); if (e2) probeErr++; else left += (data || []).length } }
        await cnt('fixed_cost_expenses', (q, c) => q.in('bank_transaction_id', c).ilike('description', '%Bank Link)%').not('description', 'ilike', '%agendada)%'))
        await cnt('inputs', (q, c) => q.in('order_number', c.map((i: string) => ('bank:' + i).slice(0, 120))))
        try { const bId = await bucketInvoiceId(db); await cnt('invoice_expenses', (q, c) => q.in('purchase_group', c).eq('invoice_id', bId)); await cnt('inputs', (q, c) => q.in('purchase_group', c).ilike('description', '%Bank Link)%')); await cnt('inventory', (q, c) => q.in('purchase_group', c).ilike('description', '%Bank Link)%')) } catch { /* sem balde */ }
        if (left) errors.push(`sobrou lançamento criado pelo motor: ${left} linha(s) — veja o card AUTO-BOOK no Data Checker`)
        if (probeErr) errors.push(`afirmação de sobras falhou em ${probeErr} consulta(s) — confira o card AUTO-BOOK`)
      }
      for (let i = 0; i < fixes.length; i += 100) await db.from('data_fixes').insert(fixes.slice(i, i + 100)).then(() => undefined, () => undefined)
      const remaining = Math.max(0, (totalInBatch || 0) - n)
      return NextResponse.json({ ok: true, undone: n, errors, remaining })
    }
    if (action === 'review_all') {
      // OK TODOS: só tarifas (FEE) — o que o motor EXACT casou passa linha a linha.
      const batch = body.batch ? String(body.batch) : null
      let q = db.from('bank_transactions').update({ reviewed_at: new Date().toISOString() }).eq('match_engine', 'FEE').eq('match_status', 'MATCHED').is('reviewed_at', null)
      if (batch) q = q.eq('match_batch', batch)
      const { data, error } = await q.select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, reviewed: (data || []).length })
    }

    // PURGE ÓRFÃO (Data Checker · card AUTO-BOOK): apaga lançamento criado pelo
    // motor (marcador obrigatório) que ficou sem linha casada apontando pra ele.
    if (action === 'purge_orphan') {
      const table = String(body.table || ''), rowId = String(body.row_id || '')
      if (!['fixed_cost_expenses', 'inputs', 'inventory', 'invoice_expenses'].includes(table) || !rowId) return NextResponse.json({ error: 'table/row_id inválidos' }, { status: 400 })
      const { data: row } = await (db.from(table) as any).select('*').eq('id', rowId).maybeSingle()
      if (!row) return NextResponse.json({ error: 'linha não existe mais' }, { status: 404 })
      const marker = String(table === 'invoice_expenses' ? row.item : row.description || '')
      const bankRef = table === 'fixed_cost_expenses' ? String(row.bank_transaction_id || '') : table === 'inputs' && String(row.order_number || '').startsWith('bank:') ? String(row.order_number || '').slice(5) : String(row.purchase_group || '')
      if (!bankRef || !/Bank Link\)/.test(marker)) return NextResponse.json({ error: 'não é lançamento do motor — nunca apago linha de gente' }, { status: 409 })
      if (table === 'invoice_expenses') { const bId = await bucketInvoiceId(db); if (row.invoice_id !== bId) return NextResponse.json({ error: 'linha de invoice fora do balde — nunca apago linha de gente' }, { status: 409 }) }
      // QUALQUER linha casada apontando (motor ou humano, por id ou por grupo) = não é órfão (revisão 19).
      const { data: ptr } = await db.from('bank_transactions').select('id').eq('match_status', 'MATCHED').or('and(matched_table.eq.' + table + ',matched_id.eq.' + rowId + ')' + (row.purchase_group ? ',and(matched_table.eq.purchase_group,matched_id.eq.' + String(row.purchase_group) + ')' : '')).limit(1)
      if (ptr && ptr.length) return NextResponse.json({ error: 'uma linha do banco ainda aponta pra este lançamento — não é órfão' }, { status: 409 })
      const { data: l } = await db.from('bank_transactions').select('match_status, matched_table, matched_id').eq('id', bankRef).maybeSingle()
      if (l && l.match_status === 'MATCHED' && ((l.matched_table === table && String(l.matched_id) === rowId) || (l.matched_table === 'purchase_group' && String(l.matched_id) === String(row.purchase_group || '')))) return NextResponse.json({ error: 'a linha do banco ainda aponta pra este lançamento — não é órfão' }, { status: 409 })
      const { error } = await (db.from(table) as any).delete().eq('id', rowId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await db.from('data_fixes').insert({ check_key: 'auto-book', table_name: table, row_id: rowId, field: 'DELETED', old_value: marker.slice(0, 180), new_value: null, label: ('ÓRFÃO do motor apagado · ' + marker).slice(0, 200) }).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true })
    }

    /* ── ações por linha ── */
    const bankId = String(body.bank_id || '')
    if (!bankId || !['match', 'transfer', 'ignore', 'explain', 'unmatch', 'review', 'rematch'].includes(action)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
    const LINE_SEL = BSEL
    const { data: line, error: lineErr } = await db.from('bank_transactions').select(LINE_SEL).eq('id', bankId).maybeSingle()
    if (lineErr) return NextResponse.json({ error: lineErr.message, needs_migration: MIGRATION_RE.test(lineErr.message) }, { status: 500 })
    if (!line) return NextResponse.json({ error: 'bank line not found' }, { status: 404 })
    const label = `${line.date} · ${line.merchant || line.name || ''} · ${num(line.amount)}`
    let status = ''
    let learned: string | null = null
    const changed: string[] = []
    if (action === 'review') {
      if (line.match_engine === ENGINE_BUCKET) return NextResponse.json({ error: 'linha do balde se revisa atribuindo — use a fila A ATRIBUIR' }, { status: 409 })
      const { error } = await db.from('bank_transactions').update({ reviewed_at: new Date().toISOString() }).eq('id', bankId).in('match_status', ['MATCHED', 'TRANSFER'])
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }
    // Casa a linha com o candidato (table,row_id) re-derivado no servidor: cobre
    // linha do app já casada por outra linha do banco, valor alterado, sinal
    // trocado, item de grupo já casado. Decisão HUMANA ⇒ o motor APRENDE.
    const humanMatch = async (cur: any) => {
      if (cur.pending) throw new Error('linha ainda PENDING no banco — espere postar (o Plaid troca o id ao postar)')
      const table = String(body.table || ''), rowId = String(body.row_id || '')
      if (!table || !rowId) throw new Error('table/row_id required')
      const pool = await candidatePool(db)
      const arr = num(cur.amount) > 0 ? pool.out : pool.inn
      const cand = arr.find(c => c.table === table && c.id === rowId)
      if (!cand || Math.abs(cand.amount - Math.abs(num(cur.amount))) >= 0.011) throw new Error('candidato não vale mais (já casado, valor mudou ou direção errada) — recarregue')
      const { backfill } = await writeMatch(db, cur, cand, { matched_note: String(body.note || '') || null, match_engine: null, match_batch: null, match_rule: null, reviewed_at: null })
      for (const b of backfill) changed.push(`${b.t}.${b.f}=${b.v.slice(0, 10)}`)
      learned = await learnFromMatch(db, cur, cand)
    }
    if (action === 'unmatch') {
      await writeUnmatch(db, line, changed, { unlearn: true }); status = 'NEW'
      await logMatchEvent(db, line, 'UNMATCH', {})
    } else if (action === 'rematch') {
      // TROCAR (Data Checker · DUPLA): desfaz o lançamento do motor e casa a linha
      // com o registro humano — um clique, com trilha dos dois passos.
      if (line.match_status !== 'MATCHED' || !['RULE', 'LEARN', 'FEE', ENGINE_BUCKET].includes(String(line.match_engine))) return NextResponse.json({ error: 'só linha casada pelo motor pode ser trocada' }, { status: 409 })
      if (line.match_engine === ENGINE_BUCKET && line.reviewed_at) return NextResponse.json({ error: 'linha já atribuída por gente — DESATRIBUIR primeiro' }, { status: 409 })
      // Valida o registro humano ANTES de desfazer o do motor (revisão do diff):
      // se o gêmeo não vale mais, nada é tocado.
      {
        const table = String(body.table || ''), rowId = String(body.row_id || '')
        const pool0 = await candidatePool(db)
        const arr0 = num(line.amount) > 0 ? pool0.out : pool0.inn
        const c0 = arr0.find(c => c.table === table && c.id === rowId)
        if (!c0 || Math.abs(c0.amount - Math.abs(num(line.amount))) >= 0.011) return NextResponse.json({ error: 'registro humano não vale mais (já casado, valor mudou ou direção errada) — recarregue' }, { status: 409 })
      }
      await writeUnmatch(db, line, changed, { unlearn: false })
      await logMatchEvent(db, line, 'UNMATCH', { note: 'REMATCH · troca por registro humano' })
      const { data: fresh } = await db.from('bank_transactions').select(LINE_SEL).eq('id', bankId).maybeSingle()
      await humanMatch(fresh || { ...line, match_status: 'NEW' })
      status = 'MATCHED'
    } else {
      // Toda decisão humana parte de NEW (revisão #9/#20): linha já casada precisa de DESFAZER antes.
      if (line.match_status !== 'NEW') return NextResponse.json({ error: 'linha do banco já decidida — recarregue' }, { status: 409 })
      if (action === 'match') {
        await humanMatch(line)
        status = 'MATCHED'
      } else {
        const st = action === 'transfer' ? 'TRANSFER' : action === 'ignore' ? 'IGNORED' : 'QUEUED'
        const note = action === 'transfer' ? String(body.note || 'transferência') : action === 'ignore' ? (String(body.note || '') || null) : (String(body.note || '').trim() || 'a lançar')
        await writeStatus(db, line, st, { note })
        status = st
      }
    }
    await db.from('data_fixes').insert({
      check_key: 'bank-reconcile', table_name: 'bank_transactions', row_id: bankId, field: 'match_status',
      old_value: line.match_status, new_value: status, label: (label + (changed.length ? ' → ' + changed.join(', ') : '') + (action === 'rematch' ? ' · REMATCH' : '')).slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true, status, changed, learned })
  } catch (e) {
    const msg = String((e as Error).message || e)
    return NextResponse.json({ error: msg.slice(0, 300), needs_migration: MIGRATION_RE.test(msg) }, { status: /já decidida|mudou|recarregue|editada por gente|fechada|inválid|somar exatamente|pede de 2|parte só pode|não é órfão/.test(msg) ? 409 : 500 })
  }
}
