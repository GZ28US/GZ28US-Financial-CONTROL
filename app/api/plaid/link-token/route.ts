import { NextResponse } from 'next/server'
import { plaid, plaidConfigured } from '@/lib/plaid.server'

// Cria o link_token que abre o Plaid Link (a telinha de consentimento OAuth do
// banco). É o ÚNICO momento humano de toda a integração: o dono da conta autoriza
// uma vez, e daí em diante o app lê a Regions sozinho.
export async function POST() {
  if (!plaidConfigured()) {
    return NextResponse.json({ error: 'Plaid keys not set (PLAID_CLIENT_ID / PLAID_SECRET).' }, { status: 501 })
  }
  try {
    const r = await plaid('/link/token/create', {
      user: { client_user_id: 'gz28us-llc' },
      client_name: 'GZ28US Control App',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      webhook: 'https://www.gz28us.com/ca/api/plaid/webhook',
      // OAuth (Regions) volta pra cá depois do consentimento no site do banco.
      redirect_uri: 'https://www.gz28us.com/ca/adm/bank',
      transactions: { days_requested: 90 },
    })
    return NextResponse.json({ link_token: r.link_token })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 })
  }
}
