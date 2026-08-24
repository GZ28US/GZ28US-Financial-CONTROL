import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth.server'

// WHATSAPP HUB — resposta a um chat do número BR a partir da tela /whatsapp do
// app US. O navegador não pode falar com gz28br.com direto (CORS), então este
// relay server-side repassa {to, body, personal} pra rota de envio do app BR —
// que assina, formata e manda pela instância BR. Só sessão logada.

export const dynamic = 'force-dynamic'

const BR_SEND_URL = 'https://www.gz28br.com/ca/api/whatsapp'

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const payload = await req.json().catch(() => ({}))
  const to = String(payload.to || '').trim()
  const body = String(payload.body || '')
  if (!to.includes('@') || !body.trim()) return NextResponse.json({ error: 'to (chat id) + body required' }, { status: 400 })
  try {
    const r = await fetch(BR_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body, personal: payload.personal === true }),
    })
    const data = await r.json().catch(() => null)
    return NextResponse.json({ ok: r.ok, upstream: data }, { status: r.ok ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 502 })
  }
}
