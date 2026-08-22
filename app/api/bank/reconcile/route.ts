import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { num, candidatePool, rank, isFee, buildPlan, applyPlan, planSummary, newLines, writeMatch, writeUnmatch } from '@/lib/bankReconcile.server'

// Rota fina da CONCILIAÇÃO BANCÁRIA — regras, pool e motores vivem em
// lib/bankReconcile.server.ts (v0.3.0). Tudo exige sessão (JWT no header).
// 300 s: o lote roda em fatias de 150 com paralelismo 6 (revisão #12).
export const maxDuration = 300

/* eslint-disable @typescript-eslint/no-explicit-any */
const MIGRATION_RE = /match_engine|match_batch|reviewed_at|backfill|bank_transaction_id/

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    // ?matched=1 — só os pares (tabela, id) do app já casados com linha da Regions.
    // O Data Checker usa pra cravar paid_from = GZ28US: o banco provou quem pagou.
    if (req.nextUrl.searchParams.get('matched') === '1') {
      const acc: { table: string; id: string }[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('bank_transactions').select('matched_table, matched_id').not('matched_id', 'is', null).order('id').range(from, from + 999)
        if (error) throw new Error(error.message)
        for (const r of data || []) acc.push({ table: r.matched_table, id: r.matched_id })
        if (!data || data.length < 1000) break
      }
      return NextResponse.json({ ok: true, matched: acc })
    }
    const limit = Math.min(5000, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '3000', 10) || 3000))
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
      .select('id, date, amount, name, merchant, matched_table, matched_id, matched_note, match_engine, match_batch, reviewed_at, plaid_id, backfill')
      .not('match_engine', 'is', null).eq('match_status', 'MATCHED').order('date', { ascending: false }).range(0, 1999)
    if (autoErr) needsMigration = MIGRATION_RE.test(autoErr.message)
    else {
      const batches = new Map<string, { batch: string; n: number; pending: number; fee: number; exact: number; from: string; to: string }>()
      for (const r of autoRows || []) {
        const b = batches.get(r.match_batch) || { batch: r.match_batch, n: 0, pending: 0, fee: 0, exact: 0, from: r.date, to: r.date }
        b.n++; if (!r.reviewed_at) b.pending++; if (r.match_engine === 'FEE') b.fee++; else b.exact++
        if (r.date < b.from) b.from = r.date; if (r.date > b.to) b.to = r.date
        batches.set(r.match_batch, b)
      }
      auto = {
        pending: (autoRows || []).filter((r: any) => !r.reviewed_at).map((r: any) => ({
          id: r.id, date: r.date, amount: num(r.amount), name: r.merchant || r.name || '', engine: r.match_engine, batch: r.match_batch,
          note: String(r.matched_note || '').replace(/^AUTO · (FEE|EXACT) · /, ''), source: String(r.plaid_id || '').startsWith('stmt:') ? 'STATEMENT' : 'PLAID',
          backfilled: Array.isArray(r.backfill) && r.backfill.length > 0,
        })),
        reviewed: (autoRows || []).filter((r: any) => r.reviewed_at).length,
        batches: [...batches.values()],
      }
    }
    // Plano a seco (GET ?plan=1): quantas linhas os motores casariam agora.
    const plan = req.nextUrl.searchParams.get('plan') === '1' ? planSummary(buildPlan(lines, pool)) : null
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
      const { error: probe } = await db.from('bank_transactions').select('match_engine, backfill').limit(1)
      if (probe) return NextResponse.json({ error: 'rode MIGRATION_bank_reconcile_v030.sql antes: ' + probe.message, needs_migration: true }, { status: 409 })
      const [lines, pool] = await Promise.all([newLines(db, 5000), candidatePool(db)])
      const plan = buildPlan(lines, pool)
      const summary = planSummary(plan)
      if (body.plan) return NextResponse.json({ ok: true, plan: summary })
      // APLICAR roda o plano que foi MOSTRADO (hash); continuação de fatia passa batch.
      if (!body.batch && body.hash !== summary.hash) return NextResponse.json({ error: 'o plano mudou desde o PLANEJAR — planeje de novo', plan: summary }, { status: 409 })
      const res = await applyPlan(db, plan, { max: 150, batch: body.batch ? String(body.batch) : undefined })
      return NextResponse.json({ ok: true, applied: res, plan: summary })
    }
    if (action === 'undo_batch') {
      const batch = String(body.batch || '')
      if (!batch) return NextResponse.json({ error: 'batch required' }, { status: 400 })
      const { data: rows, error } = await db.from('bank_transactions').select('id, date, amount, name, merchant, match_status, matched_table, matched_id, match_engine, backfill').eq('match_batch', batch).eq('match_status', 'MATCHED')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      let n = 0; const errors: string[] = []; const fixes: any[] = []
      for (const r of rows || []) {
        try {
          const changed: string[] = []; await writeUnmatch(db, r, changed); n++
          fixes.push({ check_key: 'bank-auto', table_name: 'bank_transactions', row_id: r.id, field: 'match_status', old_value: 'MATCHED', new_value: 'NEW', label: (`DESFAZER LOTE · ${r.date} · ${r.merchant || r.name || ''} · ${num(r.amount)}` + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200) })
        } catch (e) { errors.push(`${r.date} ${r.merchant || r.name}: ` + String((e as Error).message || e)) }
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

    /* ── ações por linha ── */
    const bankId = String(body.bank_id || '')
    if (!bankId || !['match', 'transfer', 'ignore', 'explain', 'unmatch', 'review'].includes(action)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
    const { data: line, error: lineErr } = await db.from('bank_transactions').select('id, date, amount, name, merchant, pending, match_status, matched_table, matched_id, match_engine, backfill').eq('id', bankId).maybeSingle()
    if (lineErr) return NextResponse.json({ error: lineErr.message, needs_migration: MIGRATION_RE.test(lineErr.message) }, { status: 500 })
    if (!line) return NextResponse.json({ error: 'bank line not found' }, { status: 404 })
    const label = `${line.date} · ${line.merchant || line.name || ''} · ${num(line.amount)}`
    let status = ''
    const changed: string[] = []
    if (action === 'review') {
      const { error } = await db.from('bank_transactions').update({ reviewed_at: new Date().toISOString() }).eq('id', bankId).eq('match_status', 'MATCHED')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }
    if (action === 'unmatch') {
      await writeUnmatch(db, line, changed); status = 'NEW'
    } else {
      // Toda decisão humana parte de NEW (revisão #9/#20): linha já casada precisa de DESFAZER antes.
      if (line.match_status !== 'NEW') return NextResponse.json({ error: 'linha do banco já decidida — recarregue' }, { status: 409 })
      if (action === 'match') {
        if (line.pending) return NextResponse.json({ error: 'linha ainda PENDING no banco — espere postar (o Plaid troca o id ao postar)' }, { status: 409 })
        const table = String(body.table || ''), rowId = String(body.row_id || '')
        if (!table || !rowId) return NextResponse.json({ error: 'table/row_id required' }, { status: 400 })
        // Re-deriva o candidato no servidor: cobre linha do app já casada por outra
        // linha do banco, valor alterado, sinal trocado, item de grupo já casado.
        const pool = await candidatePool(db)
        const arr = num(line.amount) > 0 ? pool.out : pool.inn
        const cand = arr.find(c => c.table === table && c.id === rowId)
        if (!cand || Math.abs(cand.amount - Math.abs(num(line.amount))) >= 0.011)
          return NextResponse.json({ error: 'candidato não vale mais (já casado, valor mudou ou direção errada) — recarregue' }, { status: 409 })
        const { backfill } = await writeMatch(db, line, cand, { matched_note: String(body.note || '') || null, match_engine: null, match_batch: null, reviewed_at: null })
        for (const b of backfill) changed.push(`${b.t}.${b.f}=${b.v.slice(0, 10)}`)
        status = 'MATCHED'
      } else {
        const update = action === 'transfer' ? { match_status: 'TRANSFER', matched_note: String(body.note || 'transferência') }
          : action === 'ignore' ? { match_status: 'IGNORED', matched_note: String(body.note || '') || null }
          : { match_status: 'QUEUED', matched_note: String(body.note || '').trim() || 'a lançar' }
        const { data, error } = await db.from('bank_transactions').update({ ...update, matched_table: null, matched_id: null }).eq('id', bankId).eq('match_status', 'NEW').select('id')
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data || !data.length) return NextResponse.json({ error: 'linha do banco já decidida — recarregue' }, { status: 409 })
        status = update.match_status
      }
    }
    await db.from('data_fixes').insert({
      check_key: 'bank-reconcile', table_name: 'bank_transactions', row_id: bankId, field: 'match_status',
      old_value: line.match_status, new_value: status, label: (label + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true, status, changed })
  } catch (e) {
    const msg = String((e as Error).message || e)
    return NextResponse.json({ error: msg.slice(0, 300), needs_migration: MIGRATION_RE.test(msg) }, { status: /já decidida|mudou|recarregue/.test(msg) ? 409 : 500 })
  }
}
