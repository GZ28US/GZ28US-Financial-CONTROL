import { NextRequest, NextResponse } from 'next/server'
import { readKeyOk } from '@/lib/apiAuth.server'

// Marca um chat como LIDO na instância UltraMsg (?key=&chatId=) — usado pela
// Claudinha nas rondas: thread tratada e dada como DONE pelo Márcio → some o
// badge de não lida no celular (ordem 27/jul/2026). Mirror no app BR.

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  // Chave no corpo, em ?key= ou no header x-read-key — falha fechada: sem
  // WHATSAPP_READ_KEY no ambiente, ninguém marca nada (11/set/2026).
  if (!readKeyOk(req, { allowQuery: true, bodyKey: body.key })) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const chatId = String(body.chatId || '').trim()
  if (!chatId.includes('@')) return NextResponse.json({ error: 'invalid chatId' }, { status: 400 })
  const r = await fetch(`https://api.ultramsg.com/${instance}/chats/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, chatId }),
  })
  const data = await r.json().catch(() => null)
  return NextResponse.json({ ok: r.ok, result: data })
}
