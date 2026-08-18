import { NextRequest, NextResponse } from 'next/server'
import { syncAllBankItems } from '@/lib/plaid.server'

// REDE DE SEGURANÇA (cron 6/6h): mesmo que um webhook do Plaid se perca, o sync
// por cursor pega tudo que ficou pra trás. Idempotente — rodar em cima do webhook
// não duplica nada (dedupe físico pelo UNIQUE em plaid_id).
export const maxDuration = 120

export async function GET(_req: NextRequest) {
  const results = await syncAllBankItems()
  return NextResponse.json({ ok: true, at: new Date().toISOString(), results })
}
