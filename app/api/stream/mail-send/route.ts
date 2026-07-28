import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

// Envio de e-mail pelas caixas do Márcio, com anexo. Mesma chave de leitura das
// outras rotas de correio; o token do Graph nunca sai do servidor.
//
// POST { key, slot?, to[], cc?[], subject, body, replyTo?, attachments?[{name,contentType,base64}] }
//
// Com `replyTo` (id da mensagem) a resposta entra na MESMA thread — o Graph cria
// o rascunho de resposta, a gente troca o corpo, pendura os anexos e envia.
// Sem ele, é uma mensagem nova.
//
// REGRA DE OURO: esta rota só é chamada com o "manda" explícito do Márcio.

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  if (!b?.key || b.key !== process.env.WHATSAPP_READ_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const to: string[] = Array.isArray(b.to) ? b.to : b.to ? [b.to] : []
  if (!to.length || !b.subject || !b.body) {
    return NextResponse.json({ error: 'to, subject e body são obrigatórios' }, { status: 400 })
  }

  const db = streamDb()
  const auth = await getMailAuth(db, Number(b.slot) || 1)
  if (!auth) return NextResponse.json({ error: 'slot sem autenticação' }, { status: 404 })
  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'token expirado' }, { status: 502 })

  const rec = (list: string[]) => list.map((address) => ({ emailAddress: { address } }))
  const atts = (b.attachments || []).map((a: any) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.name,
    contentType: a.contentType || 'application/octet-stream',
    contentBytes: a.base64,
  }))

  // Resposta na thread original
  if (b.replyTo) {
    const r = await fetch(`${G}/me/messages/${encodeURIComponent(b.replyTo)}/createReply`, { method: 'POST', headers: gh(token) })
    const draft = await r.json().catch(() => null)
    if (!draft?.id) return NextResponse.json({ error: draft?.error?.message || 'createReply falhou' }, { status: 502 })

    const patch = await fetch(`${G}/me/messages/${draft.id}`, {
      method: 'PATCH', headers: gh(token),
      body: JSON.stringify({ toRecipients: rec(to), ccRecipients: rec(b.cc || []), body: { contentType: 'HTML', content: b.body } }),
    })
    if (!patch.ok) return NextResponse.json({ error: (await patch.text()).slice(0, 300) }, { status: 502 })

    for (const a of atts) {
      const up = await fetch(`${G}/me/messages/${draft.id}/attachments`, { method: 'POST', headers: gh(token), body: JSON.stringify(a) })
      if (!up.ok) return NextResponse.json({ error: `anexo ${a.name}: ${(await up.text()).slice(0, 300)}` }, { status: 502 })
    }

    const sent = await fetch(`${G}/me/messages/${draft.id}/send`, { method: 'POST', headers: gh(token) })
    if (!sent.ok) return NextResponse.json({ error: (await sent.text()).slice(0, 300) }, { status: 502 })
    return NextResponse.json({ ok: true, account: auth.account, threaded: true, attachments: atts.length })
  }

  // Mensagem nova
  const r = await fetch(`${G}/me/sendMail`, {
    method: 'POST', headers: gh(token),
    body: JSON.stringify({
      message: {
        subject: b.subject,
        body: { contentType: 'HTML', content: b.body },
        toRecipients: rec(to),
        ccRecipients: rec(b.cc || []),
        attachments: atts,
      },
      saveToSentItems: true,
    }),
  })
  if (!r.ok) return NextResponse.json({ error: (await r.text()).slice(0, 400) }, { status: 502 })
  return NextResponse.json({ ok: true, account: auth.account, threaded: false, attachments: atts.length })
}
