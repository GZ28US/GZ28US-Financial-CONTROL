import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, mailProvider } from '@/lib/streamMail.server'
import { watchBounce, findBounce, isOutboundSpamBlock, type Bounce } from '@/lib/mailBounce.server'

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
//
// DEVOLUÇÃO (25/11/2026, caixas Outlook/Hotmail — ver lib/mailBounce.server.ts): depois de enviar, a rota espera ~16 s por uma
// devolução daquela mensagem. Não voltou nada → `ok:true, bounce_checked:true`. Voltou a recusa de SAÍDA da Microsoft
// («5.7.501 Spam abuse detected from IP range») para TODOS os destinatários → ninguém recebeu, então a MESMA mensagem é
// reenviada uma vez (`resent:true`) e vigiada de novo. Qualquer devolução que sobre sai na resposta em `bounced`; se ninguém
// recebeu, a rota responde 502 com o motivo — `ok:true` deixou de significar «o Graph aceitou» e passou a significar «saiu e
// não voltou». Devolução parcial ou de outro tipo (endereço inexistente) NÃO é reenviada: reenviar duplicaria para quem recebeu.
// `bounceWait:false` no corpo pula a espera. Caixa Google não passa por aqui.
// SÓ CONFERIR, SEM ENVIAR: POST { key, slot, checkBounce: { since, until?, recipients[], subject? } } → { bounce } (ou null).

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

// TEXTO PURO VIRAVA UM PARÁGRAFO SÓ (Parts Chasing, 02/nov/2026 — e-mails ao Trevor/Earth Motorcars): os 3 caminhos mandam
// o corpo como HTML, e HTML ignora \n. Corpo sem tag HTML é escapado (&, <, >) e cada quebra vira <br>; corpo já em HTML
// segue como está.
function asHtml(body: string): string {
  const s = String(body || '')
  if (/<(p|br|div|ul|ol|li|table|html|body|h[1-6]|a|span|strong|b|i|em)\b[^>]*>/i.test(s)) return s
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')
}

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
  const htmlPart = ['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(asHtml(b.body), 'utf8').toString('base64')].join('\r\n')
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
  // «esse e-mail voltou?» — só lê a caixa (Outlook/Hotmail), não envia nada
  if (b.checkBounce) {
    const c = b.checkBounce, iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    const recips: string[] = Array.isArray(c.recipients) ? c.recipients.map(String) : []
    if (!iso.test(String(c.since || '')) || (c.until && !iso.test(String(c.until))) || !recips.length) return NextResponse.json({ error: 'checkBounce: since (YYYY-MM-DDTHH:MM:SSZ) e recipients[] são obrigatórios' }, { status: 400 })
    const db0 = streamDb(), auth0 = await getMailAuth(db0, Number(b.slot) || 1)
    if (!auth0) return NextResponse.json({ error: 'slot sem autenticação' }, { status: 404 })
    if (mailProvider(auth0) === 'gmail') return NextResponse.json({ error: 'checkBounce só existe para caixa Outlook/Hotmail' }, { status: 400 })
    const t0 = await freshAccessToken(db0, auth0)
    if (!t0) return NextResponse.json({ error: 'token expirado' }, { status: 502 })
    try { return NextResponse.json({ ok: true, account: auth0.account, bounce: await findBounce(t0, String(c.since), recips, [], String(c.subject || ''), String(c.until || '')) }) }
    catch (e) { return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 502 }) }
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
  // cc NORMALIZADO igual ao caminho do Gmail: string virava .map de string e quebrava
  // a rota com 500. Aqui vinha `b.cc || []` cru — array funcionava, string não.
  const cc: string[] = Array.isArray(b.cc) ? b.cc : b.cc ? [b.cc] : []
  const atts = (b.attachments || []).map((a: any) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.name,
    contentType: a.contentType || 'application/octet-stream',
    contentBytes: a.base64,
  }))

  const sendOnce = async (): Promise<{ error?: string; threaded: boolean; subject?: string }> => {
  // Resposta na thread original
  if (b.replyTo) {
    const r = await fetch(`${G}/me/messages/${encodeURIComponent(b.replyTo)}/createReply`, { method: 'POST', headers: gh(token) })
    const draft = await r.json().catch(() => null)
    if (!draft?.id) return { error: draft?.error?.message || 'createReply falhou', threaded: true }

    const patch = await fetch(`${G}/me/messages/${draft.id}`, {
      method: 'PATCH', headers: gh(token),
      body: JSON.stringify({ toRecipients: rec(to), ccRecipients: rec(cc), body: { contentType: 'HTML', content: asHtml(b.body) } }),
    })
    if (!patch.ok) return { error: (await patch.text()).slice(0, 300), threaded: true }

    for (const a of atts) {
      const up = await fetch(`${G}/me/messages/${draft.id}/attachments`, { method: 'POST', headers: gh(token), body: JSON.stringify(a) })
      if (!up.ok) return { error: `anexo ${a.name}: ${(await up.text()).slice(0, 300)}`, threaded: true }
    }

    const sent = await fetch(`${G}/me/messages/${draft.id}/send`, { method: 'POST', headers: gh(token) })
    if (!sent.ok) return { error: (await sent.text()).slice(0, 300), threaded: true }
    return { threaded: true, subject: String(draft.subject || '') }
  }

  // Mensagem nova
  const r = await fetch(`${G}/me/sendMail`, {
    method: 'POST', headers: gh(token),
    body: JSON.stringify({
      message: {
        subject: b.subject,
        body: { contentType: 'HTML', content: asHtml(b.body) },
        toRecipients: rec(to),
        ccRecipients: rec(cc),
        attachments: atts,
      },
      saveToSentItems: true,
    }),
  })
  if (!r.ok) return { error: (await r.text()).slice(0, 400), threaded: false }
  return { threaded: false, subject: String(b.subject || '') }
  }

  const everyone = [...to, ...cc]
  const pub = (x: Bounce) => ({ reason: x.reason, code: x.code, failed: x.failed, all: x.all, received: x.received })
  // 5 s para trás: o relógio daqui e o do Exchange não são o mesmo
  const stamp = () => new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z')
  let since = stamp()
  const first = await sendOnce()
  if (first.error) return NextResponse.json({ error: first.error }, { status: 502 })
  const base = { account: auth.account, threaded: first.threaded, attachments: atts.length, to, cc }
  if (b.bounceWait === false) return NextResponse.json({ ok: true, ...base, bounce_checked: false })

  const w1 = await watchBounce(token, since, everyone, { subject: first.subject })
  // não conseguiu olhar a caixa: o envio saiu, mas ninguém conferiu — diz isso, não diz «não voltou»
  if (!w1.checked) return NextResponse.json({ ok: true, ...base, bounce_checked: false, warning: 'sent, but the bounce check could not read the mailbox: ' + w1.error })
  const b1 = w1.bounce
  if (!b1) return NextResponse.json({ ok: true, ...base, bounce_checked: true })
  if (!(isOutboundSpamBlock(b1) && b1.all)) {
    // devolução parcial ou de outro tipo: não se reenvia. Ninguém recebeu = falha; alguém recebeu = ok com o aviso.
    if (b1.all) return NextResponse.json({ error: 'bounced — nobody received it: ' + b1.reason, ...base, bounce_checked: true, bounced: [pub(b1)] }, { status: 502 })
    return NextResponse.json({ ok: true, ...base, bounce_checked: true, bounced: [pub(b1)], warning: 'delivery failed for: ' + b1.failed.join(', ') + ' — ' + b1.reason })
  }

  // recusa de saída da Microsoft para todos: a mesma mensagem, mais uma vez
  await new Promise(res => setTimeout(res, 6000))
  since = stamp()
  const second = await sendOnce()
  if (second.error) return NextResponse.json({ error: 'bounced (' + b1.reason + ') and the resend failed: ' + second.error, ...base, bounce_checked: true, bounced: [pub(b1)], resent: false }, { status: 502 })
  const w2 = await watchBounce(token, since, everyone, { exclude: [b1.id], subject: second.subject })
  if (!w2.checked) return NextResponse.json({ ok: true, ...base, bounce_checked: false, resent: true, first_bounce: pub(b1), warning: 'resent after a bounce, but the second bounce check could not read the mailbox: ' + w2.error })
  const b2 = w2.bounce
  if (!b2) return NextResponse.json({ ok: true, ...base, bounce_checked: true, resent: true, first_bounce: pub(b1) })
  if (b2.all) return NextResponse.json({ error: 'bounced twice — nobody received it: ' + b2.reason, ...base, bounce_checked: true, resent: true, bounced: [pub(b1), pub(b2)] }, { status: 502 })
  return NextResponse.json({ ok: true, ...base, bounce_checked: true, resent: true, bounced: [pub(b2)], first_bounce: pub(b1), warning: 'delivery failed for: ' + b2.failed.join(', ') + ' — ' + b2.reason })
}
