import { NextRequest, NextResponse } from 'next/server'
import { requireUser, sendKeyOk, webhookKeyValue } from '@/lib/apiAuth.server'

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

// ESTA ROTA APONTA O WEBHOOK DA INSTÂNCIA — quem entra aqui redireciona TODA mensagem
// que chega no WhatsApp da empresa pro servidor que quiser. Por isso ela não abre com
// a chave de LEITURA (11/set/2026): só tela logada (JWT) ou a chave de ENVIO no header
// x-send-key. Falha fechada.
export async function GET(req: NextRequest) {
  if (!sendKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { instance, token } = creds()
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/instance/settings?token=${encodeURIComponent(token)}`)
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, settings: data })
}

export async function POST(req: NextRequest) {
  if (!sendKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const { instance, token } = creds()
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  // A URL padrão leva o segredo PRÓPRIO do webhook; sem ele no ambiente a rota não
  // inventa URL com a chave de leitura (era o que fazia antes) — diz o que falta.
  const segredo = webhookKeyValue()
  if (!body.url && !segredo) return NextResponse.json({ error: 'falta ULTRAMSG_WEBHOOK_SECRET no ambiente (ou mande url no corpo)' }, { status: 503 })
  const url = String(body.url || `https://www.gz28us.com/ca/api/whatsapp/webhook?key=${segredo}`)
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
