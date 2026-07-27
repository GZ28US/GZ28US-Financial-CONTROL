import { NextRequest, NextResponse } from 'next/server'

// Messages of ONE chat on the US UltraMsg instance (?chatId=&limit=&key=) —
// text/metadata only, for the assistant to consult a history when Márcio asks.
// Read access requires WHATSAPP_READ_KEY. Mirror of the BR route.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (need && req.nextUrl.searchParams.get('key') !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })
  const chatId = (req.nextUrl.searchParams.get('chatId') || '').trim()
  if (!chatId.includes('@')) return NextResponse.json({ error: 'invalid chatId (expected ...@c.us / ...@g.us)' }, { status: 400 })
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50') || 50, 200)
  // ?log=1 lê do log da instância (/messages) em vez do histórico do chat —
  // é o único endpoint da UltraMsg que traz o LINK DE MÍDIA das imagens/docs.
  const useLog = req.nextUrl.searchParams.get('log') === '1'
  const url = useLog
    ? `https://api.ultramsg.com/${instance}/messages?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(chatId)}&limit=${limit}&status=all&sort=desc&page=1`
    : `https://api.ultramsg.com/${instance}/chats/messages?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(chatId)}&limit=${limit}`
  const r = await fetch(url)
  let data = await r.json().catch(() => null)
  if (useLog && data && Array.isArray(data.messages)) data = data.messages.filter((m: any) => (m.chatId || m.from || m.to || '').includes(chatId.split('@')[0]))
  if (!Array.isArray(data)) return NextResponse.json({ error: 'unexpected UltraMsg response', raw: data }, { status: 502 })
  // ?raw=1 devolve os objetos completos da UltraMsg (chave exigida) — usado pra
  // achar links de mídia de tipos que o mapeamento enxuto abaixo não carrega.
  if (req.nextUrl.searchParams.get('raw') === '1') return NextResponse.json({ chatId, count: data.length, messages: data })
  const messages = data.map((m: any) => ({
    fromMe: !!m.fromMe,
    time: (m.time ?? m.timestamp) ? new Date((m.time ?? m.timestamp) * 1000).toISOString() : null,
    type: m.type || 'chat',
    body: typeof m.body === 'string' ? m.body.slice(0, 2000) : '',
    media: m.media || null,
  }))
  return NextResponse.json({ chatId, count: messages.length, messages })
}
