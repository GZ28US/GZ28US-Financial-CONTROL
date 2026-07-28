import { NextRequest, NextResponse } from 'next/server'

// Reage a UMA mensagem do WhatsApp (UltraMsg /messages/reaction).
// Lei do Márcio (27/jul/2026): no grupo FINANCEIRO NADA é apagado — post
// absorvido pelo sistema é marcado com ✅ em vez de sumir. O robô do FINANCEIRO
// chama esta rota depois de lançar o comprovante no app.

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  const body = await req.json().catch(() => ({}))
  if (need && body.key !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const msgId = String(body.msgId || '').trim()
  if (!msgId) return NextResponse.json({ error: 'msgId required' }, { status: 400 })
  const emoji = String(body.emoji || '✅')
  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/reaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, msgId, emoji }),
  })
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, result: data })
}
