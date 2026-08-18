import { NextRequest, NextResponse } from 'next/server'
import { plaid, bankDb, syncBankItem } from '@/lib/plaid.server'

// Depois do consentimento no Plaid Link: troca o public_token pelo access_token
// permanente, registra a conexão em bank_accounts (com as sub-contas no jsonb) e
// já dispara a PRIMEIRA sincronização — a tela BANK abre com as transações na hora.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const publicToken = String(body.public_token || '')
  if (!publicToken) return NextResponse.json({ error: 'Missing public_token.' }, { status: 400 })
  try {
    const ex = await plaid('/item/public_token/exchange', { public_token: publicToken })
    const accessToken = ex.access_token as string
    const itemId = ex.item_id as string

    // Nome da instituição + sub-contas (corrente, cartão…) pra exibição.
    const acc = await plaid('/accounts/get', { access_token: accessToken })
    const institution = String(body.institution_name || acc.item?.institution_name || 'BANK').toUpperCase()
    const accounts: Record<string, { name: string; mask: string | null; type: string }> = {}
    for (const a of acc.accounts || []) {
      accounts[a.account_id] = { name: a.name || a.official_name || 'Account', mask: a.mask || null, type: `${a.type}/${a.subtype}` }
    }
    const label = `${institution}${acc.accounts?.[0]?.mask ? ' •' + acc.accounts[0].mask : ''}`

    const db = bankDb()
    const { data: row, error } = await db.from('bank_accounts').upsert([{
      institution,
      display_name: label,
      plaid_item_id: itemId,
      plaid_access_token: accessToken,
      accounts,
      status: 'ACTIVE',
      sync_cursor: null,
    }], { onConflict: 'plaid_item_id' }).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Primeira carga — o Link pede 90 dias; o cursor assume daqui em diante.
    const first = await syncBankItem(db, row).catch((e) => ({ error: String(e).slice(0, 200) }))
    return NextResponse.json({ ok: true, account: label, first })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 })
  }
}
