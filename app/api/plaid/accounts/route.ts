import { NextRequest, NextResponse } from 'next/server'
import { bankDb, plaidConfigured, plaidEnv, syncAllBankItems } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// Alimenta a tela ADM ▸ BANK: conexões, placar do universo e as últimas transações.
// As tabelas têm RLS trancado (só service key), então a tela lê por aqui — o token
// de acesso NUNCA sai deste servidor (o select da tela não o inclui).
export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // ?limit= — a tela pede 300 por padrão e 5000 no SHOW ALL. O teto antigo de 60
  // parava em 17/ago com 277 transações só em agosto (susto do Márcio, 21/ago).
  const limit = Math.min(5000, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '300', 10) || 300))
  const db = bankDb()
  const { data: accounts } = await db
    .from('bank_accounts')
    .select('id, institution, display_name, accounts, status, last_synced_at, created_at')
    .order('created_at')
  // PostgREST devolve no máximo 1.000 por request — pagina até o limit pedido
  // (SHOW ALL com 1.662 linhas parava em 1.000, susto do Márcio 21/ago).
  const recent: any[] = []   // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let from = 0; from < limit; from += 1000) {
    const { data } = await db
      .from('bank_transactions')
      .select('id, plaid_account_id, item_id, date, amount, name, merchant, pending, check_number, match_status')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, Math.min(from + 999, limit - 1))
    recent.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  // Saldo: último cash_balances por conexão (chave = display_name). Vem do Plaid
  // (syncBalances, diário) ou do extrato importado — a tela mostra de onde veio.
  const balances: Record<string, { balance: number; date: string; source: string; notes: string | null }> = {}
  for (const a of accounts || []) {
    const key = a.display_name || a.institution
    const { data: b } = await db.from('cash_balances').select('balance, balance_date, source, notes').eq('account', key).order('balance_date', { ascending: false }).limit(1).maybeSingle()
    if (b) balances[a.id] = { balance: Number(b.balance) || 0, date: b.balance_date, source: b.source, notes: b.notes }
  }
  const counts: Record<string, number> = {}
  const { data: all } = await db.from('bank_transactions').select('match_status')
  for (const r of all || []) counts[r.match_status || 'NEW'] = (counts[r.match_status || 'NEW'] || 0) + 1
  return NextResponse.json({
    configured: plaidConfigured(),
    env: plaidEnv(),
    accounts: accounts || [],
    recent: recent || [],
    counts,
    balances,
  })
}

// SYNC NOW da tela — mesma rotina do cron, sob demanda.
export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const results = await syncAllBankItems()
  return NextResponse.json({ ok: true, results })
}
