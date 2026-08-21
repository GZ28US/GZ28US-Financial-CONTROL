import { NextRequest, NextResponse } from 'next/server'
import { plaid, plaidConfigured, bankDb } from '@/lib/plaid.server'

// Cria o link_token que abre o Plaid Link (a telinha de consentimento OAuth do
// banco). É o ÚNICO momento humano de toda a integração: o dono da conta autoriza
// uma vez, e daí em diante o app lê a Regions sozinho.
//
// HISTÓRICO (ordem do Márcio, 21/ago): o app precisa de TUDO desde o começo.
// days_requested é o máximo do Plaid — 730 dias (24 meses). A conexão
// original (20/ago) pediu 90 e por isso a Regions começa em 26/mai/2026.
//
// UPDATE MODE: com { item_id } no corpo, o token abre o Link em modo
// atualização da conexão existente (mesmo access_token, sem exchange) pedindo
// os 730 dias — o Plaid busca o histórico antigo em segundo plano e avisa
// pelo webhook (HISTORICAL_UPDATE), que sincroniza sozinho.
const DAYS = 730

export async function POST(req: NextRequest) {
  if (!plaidConfigured()) {
    return NextResponse.json({ error: 'Plaid keys not set (PLAID_CLIENT_ID / PLAID_SECRET).' }, { status: 501 })
  }
  const body = await req.json().catch(() => ({}))
  const itemId = String(body?.item_id || '')
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
    if (itemId) {
      const { data: item } = await bankDb().from('bank_accounts').select('plaid_access_token').eq('id', itemId).maybeSingle()
      if (!item?.plaid_access_token) return NextResponse.json({ error: 'Connection not found.' }, { status: 404 })
      const r = await plaid('/link/token/create', { ...base, access_token: item.plaid_access_token })
      return NextResponse.json({ link_token: r.link_token, update: true })
    }
    const r = await plaid('/link/token/create', { ...base, products: ['transactions'] })
    return NextResponse.json({ link_token: r.link_token })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 })
  }
}
