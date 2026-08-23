import { NextRequest, NextResponse } from 'next/server'
import { bankDb, plaidConfigured, syncBalances } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// SALDO REAL + INTEGRIDADE DO FEED (BANK LINK v0.4.0, pedido do João 22/ago):
// pra cada conexão, o saldo que o BANCO diz agora (Plaid /accounts/balance/get,
// gravado em cash_balances como o saldo do dia) e a conferência: âncora (último
// extrato lançado) + linhas do Bank Link desde então = saldo implícito. A
// diferença entre o real e o implícito é o "caixa não bate" — faltam ou sobram
// linhas no feed. O Data Checker alerta quando passa do que está pendente.
// Cache de 10 min por conexão: o Plaid cobra por chamada de saldo.
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown) => parseFloat(String(v)) || 0
const r2 = (v: number) => Math.round(v * 100) / 100
const CACHE = new Map<string, { at: number; data: any }>()
const TTL = 10 * 60 * 1000

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!plaidConfigured()) return NextResponse.json({ ok: true, configured: false, items: [] })
  const force = req.nextUrl.searchParams.get('force') === '1'
  try {
    const db = bankDb()
    const { data: items, error } = await db.from('bank_accounts').select('id, institution, display_name, status, plaid_access_token').order('created_at')
    if (error) throw new Error(error.message)
    const out: any[] = []
    for (const it of items || []) {
      const account = it.display_name || it.institution
      const cached = CACHE.get(it.id)
      let live: any = cached && !force && Date.now() - cached.at < TTL ? cached.data : null
      if (!live) {
        if (it.status !== 'ACTIVE') live = { error: 'conexão ' + it.status }
        else {
          const s = await syncBalances(db, it)
          live = s.balance ? { current: s.balance.current, available: s.balance.available, as_of: s.balance.as_of, realtime: s.balance.realtime, accounts: s.balance.accounts, written: s.written, error: s.error || null } : { error: s.error || s.skipped || 'sem saldo' }
        }
        if (!live.error) CACHE.set(it.id, { at: Date.now(), data: live })
      }
      // Âncora: último saldo MANUAL (extrato ou lançamento) desta conta.
      const { data: anchor } = await db.from('cash_balances').select('balance_date, balance, notes').eq('account', account).eq('source', 'MANUAL').order('balance_date', { ascending: false }).limit(1).maybeSingle()
      // Último saldo gravado de qualquer fonte (fallback da tela quando o Plaid não responde).
      const { data: last } = await db.from('cash_balances').select('balance_date, balance, source').eq('account', account).order('balance_date', { ascending: false }).limit(1).maybeSingle()
      let implied: number | null = null, netAfter = 0, linesAfter = 0, pendingOut = 0
      if (anchor) {
        for (let from = 0; ; from += 1000) {
          const { data, error: e2 } = await db.from('bank_transactions').select('amount, pending').eq('item_id', it.id).gt('date', anchor.balance_date).order('id').range(from, from + 999)
          if (e2) throw new Error(e2.message)
          for (const r of data || []) { netAfter -= num(r.amount); linesAfter++; if (r.pending && num(r.amount) > 0) pendingOut += num(r.amount) }
          if (!data || data.length < 1000) break
        }
        implied = r2(num(anchor.balance) + netAfter)
      }
      const current = live.error ? null : live.current
      out.push({
        id: it.id, account, status: it.status,
        live: live.error ? null : { current: live.current, available: live.available, as_of: live.as_of, realtime: !!live.realtime, accounts: live.accounts, cached: !!cached && !force && live === cached?.data },
        live_error: live.error || null,
        last: last ? { date: last.balance_date, balance: num(last.balance), source: last.source } : null,
        integrity: anchor ? {
          anchor_date: anchor.balance_date, anchor_balance: num(anchor.balance), anchor_note: anchor.notes, lines_after: linesAfter, net_after: r2(netAfter), implied,
          pending_out: r2(pendingOut), gap: current == null || implied == null ? null : r2(current - implied),
        } : null,
      })
    }
    const totals = {
      current: out.reduce((s, o) => s + (o.live ? o.live.current : 0), 0), available: out.reduce((s, o) => s + (o.live ? o.live.available : 0), 0),
      live_count: out.filter(o => o.live).length, n: out.length,
    }
    return NextResponse.json({ ok: true, configured: true, items: out, totals })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
