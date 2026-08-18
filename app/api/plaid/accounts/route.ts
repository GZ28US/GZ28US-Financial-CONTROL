import { NextRequest, NextResponse } from 'next/server'
import { bankDb, plaidConfigured, plaidEnv, syncAllBankItems } from '@/lib/plaid.server'

// Alimenta a tela ADM ▸ BANK: conexões, placar do universo e as últimas transações.
// As tabelas têm RLS trancado (só service key), então a tela lê por aqui — o token
// de acesso NUNCA sai deste servidor (o select da tela não o inclui).
export async function GET(_req: NextRequest) {
  const db = bankDb()
  const { data: accounts } = await db
    .from('bank_accounts')
    .select('id, institution, display_name, accounts, status, last_synced_at, created_at')
    .order('created_at')
  const { data: recent } = await db
    .from('bank_transactions')
    .select('id, plaid_account_id, item_id, date, amount, name, merchant, pending, check_number, match_status')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(60)
  const counts: Record<string, number> = {}
  const { data: all } = await db.from('bank_transactions').select('match_status')
  for (const r of all || []) counts[r.match_status || 'NEW'] = (counts[r.match_status || 'NEW'] || 0) + 1
  return NextResponse.json({
    configured: plaidConfigured(),
    env: plaidEnv(),
    accounts: accounts || [],
    recent: recent || [],
    counts,
  })
}

// SYNC NOW da tela — mesma rotina do cron, sob demanda.
export async function POST(_req: NextRequest) {
  const results = await syncAllBankItems()
  return NextResponse.json({ ok: true, results })
}
