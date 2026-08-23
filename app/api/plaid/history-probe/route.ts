import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth.server'
import { plaid, plaidConfigured, bankDb } from '@/lib/plaid.server'

// SONDA DE HISTÓRICO (21/ago): pergunta ao Plaid o que ele GUARDA da conexão,
// independente do que já sincronizamos. Responde a pergunta "a Regions serviu
// mais que 90 dias?" sem adivinhar: conta transações anteriores ao piso que
// temos no banco (floor) e acha a mais antiga disponível. Nunca devolve token.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!plaidConfigured()) return NextResponse.json({ error: 'Plaid not configured' }, { status: 501 })
  const db = bankDb()
  const { data: items } = await db.from('bank_accounts').select('id, display_name, plaid_access_token, status').eq('status', 'ACTIVE')
  const out: Record<string, unknown>[] = []
  for (const it of items || []) {
    const tok = it.plaid_access_token as string
    const row: Record<string, unknown> = { account: it.display_name }
    try {
      const info = await plaid('/item/get', { access_token: tok })
      row.item_error = info.item?.error || null
      row.consented = info.item?.consented_products || info.item?.products || null
      row.transactions_status = info.status?.transactions || null
    } catch (e) { row.item_get_error = String(e).slice(0, 200) }
    try {
      // Piso atual no nosso banco: a transação mais antiga já sincronizada.
      const { data: first } = await db.from('bank_transactions').select('date').eq('item_id', it.id).order('date', { ascending: true }).limit(1).maybeSingle()
      const floor = first?.date || '2026-05-26'
      row.our_floor = floor
      const beforeFloor = await plaid('/transactions/get', {
        access_token: tok, start_date: '2024-01-01', end_date: floor, options: { count: 1, offset: 0 },
      })
      row.plaid_has_before_floor = beforeFloor.total_transactions
      const all = await plaid('/transactions/get', {
        access_token: tok, start_date: '2024-01-01', end_date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), options: { count: 1, offset: 0 },
      })
      row.plaid_total = all.total_transactions
      if (all.total_transactions > 0) {
        const oldest = await plaid('/transactions/get', {
          access_token: tok, start_date: '2024-01-01', end_date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
          options: { count: 1, offset: Math.max(0, all.total_transactions - 1) },
        })
        row.plaid_oldest_date = oldest.transactions?.[0]?.date || null
      }
    } catch (e) { row.transactions_get_error = String(e).slice(0, 200) }
    out.push(row)
  }
  const { count } = await db.from('bank_transactions').select('id', { count: 'exact', head: true })
  return NextResponse.json({ ok: true, synced_rows: count, probes: out })
}
