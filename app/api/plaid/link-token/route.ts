import { NextResponse } from 'next/server'
import { plaid, plaidConfigured } from '@/lib/plaid.server'

// Cria o link_token que abre o Plaid Link (a telinha de consentimento OAuth do
// banco). É o ÚNICO momento humano de toda a integração: o dono da conta autoriza
// uma vez, e daí em diante o app lê a Regions sozinho.
//
// HISTÓRICO: days_requested no máximo do Plaid (730 dias) — mas a Regions
// só serve 90 dias online (conferido no app do banco, 21/ago), então o que
// vem antes de 26/mai/2026 entra por EXTRATO, não pela API. O update mode
// pra estender histórico foi testado e removido: o Plaid não estende item
// existente (sonda /api/plaid/history-probe provou).
const DAYS = 730

export async function POST() {
  if (!plaidConfigured()) {
    return NextResponse.json({ error: 'Plaid keys not set (PLAID_CLIENT_ID / PLAID_SECRET).' }, { status: 501 })
  }
  try {
    const base: Record<string, unknown> = {
      user: { client_user_id: 'gz28us-llc' },
      client_name: 'GZ28US Control App',
      country_codes: ['US'],
      language: 'en',
      webhook: 'https://www.gz28us.com/ca/api/plaid/webhook',
      // OAuth (Regions) volta pra cá depois do consentimento no site do banco.
      redirect_uri: 'https://www.gz28us.com/ca/adm/bank',
      transactions: { days_requested: DAYS },
    }
    const r = await plaid('/link/token/create', { ...base, products: ['transactions'] })
    return NextResponse.json({ link_token: r.link_token })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 })
  }
}
