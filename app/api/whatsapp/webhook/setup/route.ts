import { NextRequest, NextResponse } from 'next/server'

// Registra (ou confere) o webhook da instância UltraMsg — sem que o token saia
// daqui. Chamar uma vez depois do deploy:
//   POST /ca/api/whatsapp/webhook/setup  { key, url? }
//   GET  /ca/api/whatsapp/webhook/setup?key=…   → mostra as settings atuais
//
// Liga `webhook_message_received` (mensagem de terceiro) e
// `webhook_message_create` (mensagem nossa) — os dois importam no FINANCEIRO:
// o comprovante vem de terceiro, o report do app vem de nós.

export const dynamic = 'force-dynamic'

function creds() {
  return { instance: process.env.ULTRAMSG_INSTANCE, token: process.env.ULTRAMSG_TOKEN }
}

export async function GET(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (need && req.nextUrl.searchParams.get('key') !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { instance, token } = creds()
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/instance/settings?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, settings: data })
}

export async function POST(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  const body = await req.json().catch(() => ({}))
  if (need && body.key !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { instance, token } = creds()
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const url = String(body.url || `https://www.gz28us.com/ca/api/whatsapp/webhook?key=${need || ''}`)
  const r = await fetch(`https://api.ultramsg.com/${instance}/instance/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token,
      sendDelivery: 'false',
      webhook_url: url,
      webhook_message_received: 'true',
      webhook_message_create: 'true',
      webhook_message_ack: 'false',
      webhook_message_download_media: 'true',
    }),
  })
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, url, result: data })
}
