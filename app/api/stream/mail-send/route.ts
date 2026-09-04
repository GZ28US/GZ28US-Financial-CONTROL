import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, mailProvider } from '@/lib/streamMail.server'

// Envio de e-mail pelas caixas do Márcio, com anexo. Mesma chave de leitura das
// outras rotas de correio; o token do Graph nunca sai do servidor.
//
// POST { key, slot?, to[], cc?[], subject, body, replyTo?, attachments?[{name,contentType,base64}] }
//
// Com `replyTo` (id da mensagem) a resposta entra na MESMA thread — o Graph cria
// o rascunho de resposta, a gente troca o corpo, pendura os anexos e envia.
// Sem ele, é uma mensagem nova.
//
// Caixa Google: refresh próprio do Google (mesmo fluxo do mail-query) e envio
// via users.messages.send com MIME cru em base64url; replyTo vira threadId +
// In-Reply-To/References pra resposta cair na mesma thread.
//
// REGRA DE OURO: esta rota só é chamada com o "manda" explícito do Márcio.

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

async function gmailSend(auth: any, b: any, to: string[], cc: string[]): Promise<NextResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return NextResponse.json({ error: 'GOOGLE_CLIENT_ID/SECRET not configured' }, { status: 503 })
  if (!auth.refresh_token) return NextResponse.json({ error: 'gmail not connected (run /api/stream/gmail-auth)' }, { status: 404 })
  const tk = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: auth.refresh_token, grant_type: 'refresh_token' }),
  })).json()
  if (!tk?.access_token) return NextResponse.json({ error: 'gmail token refresh failed: ' + (tk?.error || '?') }, { status: 502 })
  const GH = { Authorization: `Bearer ${tk.access_token}` }
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

  // Resposta na thread: puxa Message-ID/References/Subject do original
  let threadId: string | undefined, replyHeaders: string[] = [], subject: string = b.subject
  if (b.replyTo) {
    const m = await (await fetch(`${API}/messages/${encodeURIComponent(b.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`, { headers: GH })).json()
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'replyTo não encontrado' }, { status: 502 })
    const hdr = (name: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
    threadId = m.threadId
    const mid = hdr('Message-ID')
    if (mid) replyHeaders = [`In-Reply-To: ${mid}`, `References: ${[hdr('References'), mid].filter(Boolean).join(' ')}`]
    // Assunto explícito do chamador VENCE o herdado. Herdar às cegas propaga
    // lixo de charset: o travessão do assunto original voltou do cliente do
    // destinatário como "Ã¢Â€Â”", nós devolvemos aquilo, ele remoeu de novo, e
    // em 3 rodadas virou "ÃƒÂƒÃ‚Â¢ÃƒÂ‚Ã¢Â‚Â¬ÃƒÂ‚Ã¢Â€Â" (thread TAG Motorsports,
    // 21→24/ago/2026). Sem assunto do chamador, herda como antes.
    const orig = hdr('Subject')
    if (!b.subject && orig) subject = /^re:/i.test(orig) ? orig : `Re: ${orig}`
  }

  const encSubject = /[^\x20-\x7e]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=` : subject
  const headers = [
    `From: ${auth.account}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encSubject}`,
    ...replyHeaders,
    'MIME-Version: 1.0',
  ]
  const htmlPart = ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(b.body, 'utf8').toString('base64')].join('\r\n')
  const atts = b.attachments || []
  const boundary = 'gz28-' + Math.random().toString(36).slice(2)
  const mime = atts.length
    ? [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, htmlPart,
       ...atts.flatMap((a: any) => [`--${boundary}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.name}"`, '', a.base64]),
       `--${boundary}--`].join('\r\n')
    : [...headers, htmlPart].join('\r\n')
  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const r = await fetch(`${API}/messages/send`, {
    method: 'POST', headers: { ...GH, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  })
  const sent = await r.json().catch(() => null)
  if (!r.ok || !sent?.id) return NextResponse.json({ error: sent?.error?.message || 'gmail send falhou' }, { status: 502 })
  return NextResponse.json({ ok: true, account: auth.account, provider: 'gmail', threaded: !!threadId, attachments: atts.length, id: sent.id, threadId: sent.threadId })
}

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
  const slot = Number(b.slot) || 1
  const auth = await getMailAuth(db, slot)
  if (!auth) return NextResponse.json({ error: 'slot sem autenticação' }, { status: 404 })

  // ── Caixa Google (Gmail API em vez do Graph) — provedor pela LINHA, não
  // pelo número do slot (04/set/2026) ──────────────────────────────────────
  if (mailProvider(auth) === 'gmail') return gmailSend(auth, b, to, Array.isArray(b.cc) ? b.cc : b.cc ? [b.cc] : [])

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
