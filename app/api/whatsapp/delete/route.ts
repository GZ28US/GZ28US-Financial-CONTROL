import { NextRequest, NextResponse } from 'next/server'

// Apaga UMA mensagem nossa no WhatsApp (UltraMsg /messages/delete) — usado pela
// Claudinha pra limpar o grupo dos reports do app já absorvidos pelo sistema
// (ordem 27/jul/2026). Só funciona em mensagens enviadas por esta instância e
// dentro da janela do WhatsApp; comprovantes de terceiros NUNCA são apagados.

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
  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, msgId }),
  })
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, result: data })
}
