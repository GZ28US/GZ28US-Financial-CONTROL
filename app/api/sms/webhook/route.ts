import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { smsKeyOk } from '@/lib/apiAuth.server'

// ── SMS DO iPHONE US → SISTEMA (Márcio, 02/ago/2026) ─────────────────────────
// "Muitos americanos não usam WhatsApp, é tudo por msg de texto. É importante
// que vc tenha acesso total a isso também."
// Uma automação de Atalhos do iOS ("Quando receber uma mensagem" → Obter
// conteúdo de URL) POSTa aqui cada texto que chega no iPhone do número US —
// SMS E iMessage. Guardamos em sms_messages (RLS on, só service role), e o
// vault (#86) indexa a partir daí. Aceita GET com query params também, porque
// o Atalhos monta requisições GET com mais facilidade pra iniciantes.
//   POST /ca/api/sms/webhook?key=<SMS_WEBHOOK_SECRET>  body JSON {sender, body}
//   GET  /ca/api/sms/webhook?key=...&sender=...&body=...

export const dynamic = 'force-dynamic'

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function save(sender: string, body: string) {
  if (!body) return { error: 'empty body' }
  const { error } = await db().from('sms_messages').insert({
    sender: (sender || '').slice(0, 200) || null,
    body: body.slice(0, 8000),
    received_at: new Date().toISOString(),
    source: 'IOS_SHORTCUT',
  })
  return { error: error?.message }
}

export async function POST(req: NextRequest) {
  // O Atalhos do iPhone manda o segredo em ?key=. Desde 11/set é segredo PRÓPRIO
  // (SMS_WEBHOOK_SECRET): a URL guardada no telefone não abre mais o resto do app, e
  // trocar a chave de leitura não pede mexer no Atalhos. A chave de leitura ainda
  // vale enquanto o atalho estiver na URL velha. Falha fechada.
  if (!smsKeyOk(req)) {
    return NextResponse.json({ error: 'bad key' }, { status: 401 })
  }
  const b = await req.json().catch(() => null) as { sender?: string; body?: string } | null
  const r = await save(String(b?.sender || ''), String(b?.body || ''))
  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  if (!smsKeyOk(req)) return NextResponse.json({ error: 'bad key' }, { status: 401 })
  // Sem sender/body é só um ping de teste.
  if (!p.get('body')) return NextResponse.json({ ok: true, ping: true })
  const r = await save(String(p.get('sender') || ''), String(p.get('body') || ''))
  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
