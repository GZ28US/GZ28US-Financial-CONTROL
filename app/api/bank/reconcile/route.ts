import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { num, candidatePool, rank, isFee, nameHit, buildPlan, applyPlan, planSummary, newLines, writeMatch, writeUnmatch, writeStatus, logMatchEvent, fetchAll, loadDbAliases, loadRules, itemTwinKeys, acquireRun, finishRun, learnFromMatch, AUTO_BOOK_FLOOR } from '@/lib/bankReconcile.server'

// Rota fina da CONCILIAÇÃO BANCÁRIA — regras, pool e motores vivem em
// lib/bankReconcile.server.ts (v0.3.0). Tudo exige sessão (JWT no header).
// 300 s: o lote roda em fatias de 150 com paralelismo 6 (revisão #12).
export const maxDuration = 300

/* eslint-disable @typescript-eslint/no-explicit-any */
const MIGRATION_RE = /match_engine|match_batch|reviewed_at|backfill|bank_transaction_id|match_rule|bank_auto_runs|pfc_/

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
      if (runsQ.error) return NextResponse.json({ ok: true, needs_migration: true, floor: AUTO_BOOK_FLOOR, runs: [], booked_24h: {}, booked_7d: {}, remaining: 0, errors: [], orphans: [], dups: [] })
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
      return NextResponse.json({ ok: true, floor: AUTO_BOOK_FLOOR, runs: runs.slice(0, 10), booked_24h: by(since1), booked_7d: by(since7), remaining: remaining || 0, errors, orphans, dups })
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
      const grab = async (t: string, sel: string) => { const ids = want(t); if (!ids.length) return []; const { data } = await db.from(t).select(sel).in('id', ids); return data || [] }
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
      if (invIds.length) { const { data } = await db.from('invoices').select('id, ride_id').in('id', invIds); for (const i of data || []) if (i.ride_id) rideOf.set(i.id, i.ride_id) }
      invNeed.forEach((inv, key) => { const ride = rideOf.get(inv); if (ride) hrefOf.set(key, `/rides/${ride}/invoices/${inv}`) })
      const fxSupIds = [...new Set((hFx as any[]).map((r: any) => r.supplier_id).filter(Boolean))]
      const bankSups = new Set<string>()
      if (fxSupIds.length) { const { data: bs } = await db.from('fixed_cost_suppliers').select('id, cost_type').in('id', fxSupIds); for (const s of bs || []) if (s.cost_type === 'BANK') bankSups.add(s.id) }
      for (const r of hFx as any[]) hrefOf.set('fixed_cost_expenses:' + r.id, r.supplier_id ? (bankSups.has(r.supplier_id) ? '/costs/bank' : '/costs/fixed/' + r.supplier_id) : '/costs/fixed')
      const staticHref: Record<string, string> = { goods: '/goods', good_expenses: '/goods', inputs: '/supplies', inventory: '/inventory', expenses: '/staff', capital_events: '/adm/financials', financing_events: '/adm/financials' }
      for (const r of pend) { const k = r.matched_table + ':' + r.matched_id; if (!hrefOf.has(k) && staticHref[r.matched_table]) hrefOf.set(k, staticHref[r.matched_table]) }
      const batches = new Map<string, { batch: string; n: number; pending: number; fee: number; exact: number; name: number; rule: number; learn: number; transfer: number; from: string; to: string; trigger?: string | null; started_at?: string | null }>()
      for (const r of autoRows || []) {
        const b = batches.get(r.match_batch) || { batch: r.match_batch, n: 0, pending: 0, fee: 0, exact: 0, name: 0, rule: 0, learn: 0, transfer: 0, from: r.date, to: r.date }
        b.n++; if (!r.reviewed_at) b.pending++
        if (r.match_status === 'TRANSFER') b.transfer++
        else if (r.match_engine === 'FEE') b.fee++; else if (r.match_engine === 'NAME') b.name++; else if (r.match_engine === 'RULE') b.rule++; else if (r.match_engine === 'LEARN') b.learn++; else b.exact++
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
          note: String(r.matched_note || '').replace(/^AUTO · (FEE|EXACT|NAME|RULE|LEARN) · /, ''), source: String(r.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID',
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
      await loadDbAliases(db)
      const [rules, itemTwins] = await Promise.all([loadRules(db), itemTwinKeys(db)])
      const [lines, pool] = await Promise.all([newLines(db, 5000), candidatePool(db)])
      const plan = buildPlan(lines, pool, rules, { itemTwins })
      const summary = planSummary(plan)
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
      const done = res.fee_create + res.fee_match + res.exact + res.name + res.rule_create + res.rule_adopt + res.transfer
      // Mesma condição do loop do card: enquanto ele vai mandar outra fatia, a rodada fica RUNNING (trava mantida).
      const cont = res.remaining > 0 && !res.errors.length
      await finishRun(db, batch, { status: cont ? 'RUNNING' : (res.remaining ? 'PARTIAL' : 'DONE'), counts: { fee_create: res.fee_create, fee_match: res.fee_match, exact: res.exact, name: res.name, rule_create: res.rule_create, rule_adopt: res.rule_adopt, learn: res.learn, transfer: res.transfer }, errors: res.errors, remaining: res.remaining, note: `APLICAR humano · ${done} nesta fatia` })
      return NextResponse.json({ ok: true, applied: res, plan: summary })
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
              const { data: tgt } = await db.from(r.matched_table).select('id').eq('id', r.matched_id).maybeSingle()
              if (!tgt) { gone++; continue }
            }
            await writeMatch(db, l, { table: r.matched_table, id: r.matched_id, members: Array.isArray(r.members) ? r.members : [] }, { matched_note: r.note || null, match_engine: r.engine || null, match_batch: r.batch || null, reviewed_at: null })
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
      const { data: rows, error } = await db.from('bank_transactions').select('id, date, amount, name, merchant, match_status, matched_table, matched_id, match_engine, match_rule, backfill').eq('match_batch', batch).in('match_status', ['MATCHED', 'TRANSFER'])
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
        const { data: leftFx } = await db.from('fixed_cost_expenses').select('id').in('bank_transaction_id', ids).ilike('description', '%Bank Link)%').not('description', 'ilike', '%agendada)%')
        const { data: leftIn } = await db.from('inputs').select('id').in('order_number', ids.map((i: string) => ('bank:' + i).slice(0, 120)))
        const left = (leftFx?.length || 0) + (leftIn?.length || 0)
        if (left) errors.push(`sobrou lançamento criado pelo motor: ${left} linha(s) — veja o card AUTO-BOOK no Data Checker`)
      }
      for (let i = 0; i < fixes.length; i += 100) await db.from('data_fixes').insert(fixes.slice(i, i + 100)).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true, undone: n, errors })
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
      if (!['fixed_cost_expenses', 'inputs'].includes(table) || !rowId) return NextResponse.json({ error: 'table/row_id inválidos' }, { status: 400 })
      const { data: row } = await db.from(table).select('*').eq('id', rowId).maybeSingle()
      if (!row) return NextResponse.json({ error: 'linha não existe mais' }, { status: 404 })
      const bankRef = table === 'fixed_cost_expenses' ? String(row.bank_transaction_id || '') : String(row.order_number || '').slice(5)
      if (!bankRef || !/Bank Link\)/.test(String(row.description || ''))) return NextResponse.json({ error: 'não é lançamento do motor — nunca apago linha de gente' }, { status: 409 })
      const { data: l } = await db.from('bank_transactions').select('match_status, matched_table, matched_id').eq('id', bankRef).maybeSingle()
      if (l && l.match_status === 'MATCHED' && l.matched_table === table && String(l.matched_id) === rowId) return NextResponse.json({ error: 'a linha do banco ainda aponta pra este lançamento — não é órfão' }, { status: 409 })
      const { error } = await db.from(table).delete().eq('id', rowId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await db.from('data_fixes').insert({ check_key: 'auto-book', table_name: table, row_id: rowId, field: 'DELETED', old_value: String(row.description || '').slice(0, 180), new_value: null, label: ('ÓRFÃO do motor apagado · ' + String(row.description || '')).slice(0, 200) }).then(() => undefined, () => undefined)
      return NextResponse.json({ ok: true })
    }

    /* ── ações por linha ── */
    const bankId = String(body.bank_id || '')
    if (!bankId || !['match', 'transfer', 'ignore', 'explain', 'unmatch', 'review', 'rematch'].includes(action)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
    const LINE_SEL = 'id, date, amount, name, merchant, pending, match_status, matched_table, matched_id, match_engine, match_rule, backfill, category, entity:raw->>merchant_entity_id, pfc_detailed:raw->personal_finance_category->>detailed, processor:raw->payment_meta->>payment_processor'
    const { data: line, error: lineErr } = await db.from('bank_transactions').select(LINE_SEL).eq('id', bankId).maybeSingle()
    if (lineErr) return NextResponse.json({ error: lineErr.message, needs_migration: MIGRATION_RE.test(lineErr.message) }, { status: 500 })
    if (!line) return NextResponse.json({ error: 'bank line not found' }, { status: 404 })
    const label = `${line.date} · ${line.merchant || line.name || ''} · ${num(line.amount)}`
    let status = ''
    let learned: string | null = null
    const changed: string[] = []
    if (action === 'review') {
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
      if (line.match_status !== 'MATCHED' || !['RULE', 'LEARN', 'FEE'].includes(String(line.match_engine))) return NextResponse.json({ error: 'só linha casada pelo motor pode ser trocada' }, { status: 409 })
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
    return NextResponse.json({ error: msg.slice(0, 300), needs_migration: MIGRATION_RE.test(msg) }, { status: /já decidida|mudou|recarregue/.test(msg) ? 409 : 500 })
  }
}
