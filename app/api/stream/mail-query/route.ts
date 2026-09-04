import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, mailProvider } from '@/lib/streamMail.server'

// Read-only mailbox queries for the assistant's daily sweeps — the service key
// and Graph tokens stay server-side; callers authenticate with the same read
// key as the WhatsApp read routes. slot picks the stream_mail_auth row.
//   op=folders                  → folder tree (3 levels) with item counts
//   op=list&folder=<id|name>    → newest messages in a folder
//   op=search&q=<text>          → $search across the mailbox
//   op=msg&id=<messageId>       → one message with its full text body
//   op=attachments&id=<msgId>   → the message's attachments (name, type, size)
//   op=attach&id=<msgId>&att=<attachmentId> → one attachment as base64, ready to
//                                 hand to /api/read-doc (o documento anexado é a
//                                 verdade — nota, invoice, boleto, contrato)

export const dynamic = 'force-dynamic'

const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const G = 'https://graph.microsoft.com/v1.0'

const slim = (m: any) => ({
  id: m.id,
  received: m.receivedDateTime || m.sentDateTime || null,
  from: m.from?.emailAddress?.address || null,
  to: (m.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean),
  subject: m.subject || '',
  isRead: m.isRead,
  folderId: m.parentFolderId || null,
})

// Gmail branch — same ops (folders/list/search/msg), same slim shape, so the
// assistant's sweeps work identically across providers.
async function gmail(db: any, auth: any, op: string, p: URLSearchParams): Promise<NextResponse> {
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
  const hdr = (m: any, name: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || null
  const meta = async (id: string) => {
    const m = await (await fetch(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers: GH })).json()
    return {
      id: m.id,
      received: m.internalDate ? new Date(+m.internalDate).toISOString() : null,
      from: (hdr(m, 'From') || '').replace(/^.*<|>.*$/g, '') || hdr(m, 'From'),
      to: [(hdr(m, 'To') || '').replace(/^.*<|>.*$/g, '')].filter(Boolean),
      subject: hdr(m, 'Subject') || '',
      isRead: !(m.labelIds || []).includes('UNREAD'),
      folderId: (m.labelIds || []).filter((l: string) => !['UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'].includes(l)).join(','),
    }
  }
  if (op === 'folders') {
    const data = await (await fetch(`${API}/labels`, { headers: GH })).json()
    const folders = []
    for (const l of data.labels || []) {
      const d = await (await fetch(`${API}/labels/${l.id}`, { headers: GH })).json()
      folders.push({ id: l.id, name: l.name, total: d.messagesTotal ?? null, unread: d.messagesUnread ?? null })
    }
    return NextResponse.json({ account: auth.account, provider: 'gmail', folders })
  }
  if (op === 'list' || op === 'search') {
    const top = Math.min(50, parseInt(p.get('limit') || '25') || 25)
    const qs = new URLSearchParams({ maxResults: String(top) })
    if (op === 'list') qs.set('labelIds', (p.get('folder') || 'INBOX').toUpperCase() === 'INBOX' ? 'INBOX' : (p.get('folder') || 'INBOX'))
    if (op === 'search') { const q = p.get('q'); if (!q) return NextResponse.json({ error: 'missing q' }, { status: 400 }); qs.set('q', q) }
    const data = await (await fetch(`${API}/messages?${qs}`, { headers: GH })).json()
    const out = []
    for (const m of (data.messages || []).slice(0, top)) out.push(await meta(m.id))
    return NextResponse.json({ account: auth.account, provider: 'gmail', messages: out })
  }
  if (op === 'msg') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const m = await (await fetch(`${API}/messages/${id}?format=full`, { headers: GH })).json()
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'not found' }, { status: 404 })
    const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    let text = ''
    const walk = (part: any) => {
      if (!part) return
      if (part.mimeType === 'text/plain' && part.body?.data) text += b64(part.body.data) + '\n'
      else if (part.mimeType === 'text/html' && part.body?.data && !text) text += b64(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      for (const sp of part.parts || []) walk(sp)
    }
    walk(m.payload)
    const base = await meta(id)
    return NextResponse.json({ account: auth.account, provider: 'gmail', message: { ...base, hasAttachments: JSON.stringify(m.payload || {}).includes('"filename":"') && /"filename":"[^"]/.test(JSON.stringify(m.payload)), text: text.replace(/\s+/g, ' ').trim() } })
  }
  // O e-mail EM SI é o comprovante (regra 31/jul) — corpo HTML original intacto.
  if (op === 'msghtml') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const m = await (await fetch(`${API}/messages/${id}?format=full`, { headers: GH })).json()
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'not found' }, { status: 404 })
    const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    let html = ''
    const walkH = (part: any) => {
      if (!part) return
      if (part.mimeType === 'text/html' && part.body?.data && !html) html = b64(part.body.data)
      for (const sp of part.parts || []) walkH(sp)
    }
    walkH(m.payload)
    const base = await meta(id)
    return NextResponse.json({ account: auth.account, provider: 'gmail', id: m.id, subject: base.subject, from: base.from, received: base.received, contentType: 'html', html })
  }
  // ── ANEXOS no Gmail (26/ago/2026) ─────────────────────────────────────────
  // Só o Graph tinha attachments/attach, então documento que chegava pelo Gmail
  // era invisível para o app — e a lei do PRINTABLE INVOICE ("sempre a nota do
  // vendedor na expense E na pasta Purchases do carro") não tinha como ser
  // cumprida. Caso que revelou: a sales order #178871-D da TAG Motorsports das
  // rodas do SublimeHell veio anexa num e-mail do gz28us@gmail.
  if (op === 'attachments' || op === 'attach') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const m = await (await fetch(`${API}/messages/${id}?format=full`, { headers: GH })).json()
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'not found' }, { status: 404 })
    const found: { id: string; name: string; contentType: string; size: number | null }[] = []
    const walkA = (part: any) => {
      if (!part) return
      if (part.filename && part.body?.attachmentId) {
        found.push({ id: String(part.body.attachmentId), name: String(part.filename), contentType: String(part.mimeType || 'application/octet-stream'), size: part.body.size ?? null })
      }
      for (const sp of part.parts || []) walkA(sp)
    }
    walkA(m.payload)
    if (op === 'attachments') return NextResponse.json({ account: auth.account, provider: 'gmail', attachments: found })
    const att = p.get('att')
    if (!att) return NextResponse.json({ error: 'missing att' }, { status: 400 })
    const one = await (await fetch(`${API}/messages/${id}/attachments/${encodeURIComponent(att)}`, { headers: GH })).json()
    if (!one?.data) return NextResponse.json({ error: one?.error?.message || 'attachment not found' }, { status: 404 })
    const meta2 = found.find(f => f.id === att)
    // base64url → base64 padrão, pro chamador tratar igual ao Graph.
    const contentBytes = String(one.data).replace(/-/g, '+').replace(/_/g, '/')
    return NextResponse.json({ account: auth.account, provider: 'gmail', attachment: { id: att, name: meta2?.name || 'attachment', contentType: meta2?.contentType || 'application/octet-stream', size: one.size ?? null, contentBytes } })
  }
  return NextResponse.json({ error: `unknown op ${op}` }, { status: 400 })
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const need = process.env.WHATSAPP_READ_KEY
  if (!need || p.get('key') !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const slot = Math.max(1, parseInt(p.get('slot') || '1') || 1)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth) return NextResponse.json({ error: `no auth row for slot ${slot}` }, { status: 404 })

  const op = p.get('op') || 'folders'

  // ── Caixa Google (Gmail API em vez do Graph) — provedor pela LINHA, não
  // pelo número do slot (04/set/2026: 5ª caixa gz28speedshop@gmail.com) ────
  if (mailProvider(auth) === 'gmail') return gmail(db, auth, op, p)

  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'token refresh failed' }, { status: 502 })

  if (op === 'folders') {
    const walk = async (base: string, depth: number): Promise<any[]> => {
      const r = await fetch(`${base}?$top=200&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`, { headers: gh(token) })
      const data = await r.json().catch(() => null)
      const out: any[] = []
      for (const f of data?.value || []) {
        const node: any = { id: f.id, name: f.displayName, total: f.totalItemCount, unread: f.unreadItemCount }
        if (depth > 0 && f.childFolderCount > 0) node.children = await walk(`${G}/me/mailFolders/${f.id}/childFolders`, depth - 1)
        out.push(node)
      }
      return out
    }
    return NextResponse.json({ account: auth.account, folders: await walk(`${G}/me/mailFolders`, 2) })
  }

  if (op === 'list') {
    const folder = p.get('folder') || 'inbox'
    const top = Math.min(100, parseInt(p.get('limit') || '25') || 25)
    const r = await fetch(`${G}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=id,subject,from,toRecipients,receivedDateTime,isRead,parentFolderId&$orderby=receivedDateTime desc`, { headers: gh(token) })
    const data = await r.json().catch(() => null)
    if (!Array.isArray(data?.value)) return NextResponse.json({ error: data?.error?.message || 'list failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, messages: data.value.map(slim) })
  }

  if (op === 'search') {
    const q = p.get('q') || ''
    if (!q) return NextResponse.json({ error: 'missing q' }, { status: 400 })
    const r = await fetch(`${G}/me/messages?$search=${encodeURIComponent(`"${q}"`)}&$top=${Math.min(100, parseInt(p.get('limit') || '25') || 25)}&$select=id,subject,from,toRecipients,receivedDateTime,isRead,parentFolderId`, { headers: gh(token) })
    const data = await r.json().catch(() => null)
    if (!Array.isArray(data?.value)) return NextResponse.json({ error: data?.error?.message || 'search failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, messages: data.value.map(slim) })
  }

  if (op === 'msg') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const r = await fetch(`${G}/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,isRead,parentFolderId,body,hasAttachments`, { headers: gh(token) })
    const m = await r.json().catch(() => null)
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'not found' }, { status: 404 })
    const text = String(m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim()
    return NextResponse.json({ account: auth.account, message: { ...slim(m), hasAttachments: m.hasAttachments, text } })
  }

  // O e-mail EM SI é o comprovante (regra 31/jul: "use always the email as the
  // proof") — devolve o corpo HTML original intacto pra virar o arquivo de
  // receipt no bucket expense-receipts.
  if (op === 'msghtml') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const r = await fetch(`${G}/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,receivedDateTime,body`, { headers: gh(token) })
    const m = await r.json().catch(() => null)
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'not found' }, { status: 404 })
    return NextResponse.json({ account: auth.account, id: m.id, subject: m.subject, from: m.from?.emailAddress?.address, received: m.receivedDateTime, contentType: m.body?.contentType, html: m.body?.content || '' })
  }

  // O anexo é o documento REAL — invoice, boleto, contrato. Devolvido em base64
  // pra seguir direto pro /api/read-doc sem passar por download manual.
  if (op === 'attachments' || op === 'attach') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const att = p.get('att')
    const url = att
      ? `${G}/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(att)}`
      : `${G}/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size`
    const r = await fetch(url, { headers: gh(token) })
    const d = await r.json().catch(() => null)
    if (!d || d.error) return NextResponse.json({ error: d?.error?.message || 'attachments failed' }, { status: 502 })
    if (!att) {
      return NextResponse.json({
        account: auth.account,
        attachments: (d.value || []).map((a: any) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size })),
      })
    }
    return NextResponse.json({
      account: auth.account,
      attachment: { id: d.id, name: d.name, contentType: d.contentType, size: d.size, base64: d.contentBytes || null },
    })
  }

  // Cria (ou encontra) uma pasta de caso pelo nome — idempotente, pra rodada
  // poder arquivar sem checar antes se a pasta já existe.
  if (op === 'mkdir') {
    const name = (p.get('name') || '').trim()
    if (!name) return NextResponse.json({ error: 'missing name' }, { status: 400 })
    const ex = await fetch(`${G}/me/mailFolders?$top=200&$select=id,displayName`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    const hit = (ex?.value || []).find((f: any) => String(f.displayName).toLowerCase() === name.toLowerCase())
    if (hit) return NextResponse.json({ account: auth.account, folder: { id: hit.id, name: hit.displayName }, existed: true })
    const c = await fetch(`${G}/me/mailFolders`, { method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) }).then(r => r.json()).catch(() => null)
    if (!c?.id) return NextResponse.json({ error: c?.error?.message || 'mkdir failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, folder: { id: c.id, name: c.displayName }, existed: false })
  }

  if (op === 'move') {
    const id = p.get('id')
    const dest = p.get('dest')
    if (!id || !dest) return NextResponse.json({ error: 'missing id or dest' }, { status: 400 })
    const r = await fetch(`${G}/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: dest }) })
    const m = await r.json().catch(() => null)
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'move failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, moved: m.id })
  }

  // rmdir — apaga pasta VAZIA (2/set/2026: o Luma tinha duas pastas, "Businesses/
  // LUMA Headwaters" e "Apartment - Luma 01-306"; consolidamos na segunda e a
  // casca vazia precisava sumir). Só existia mkdir; sem isto a arrumação parava
  // no meio e dependia da mão dele no Outlook ([[claudinha-is-an-interface]]).
  //
  // SÓ apaga se estiver VAZIA. No Graph, DELETE numa pasta leva junto tudo que
  // há dentro, sem confirmação — e-mail não pode evaporar por descuido de quem
  // chamou. Esvazie antes com op=move; aqui a recusa é 409 com a contagem.
  if (op === 'rmdir') {
    const id = p.get('id')
    if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
    const info = await fetch(`${G}/me/mailFolders/${encodeURIComponent(id)}?$select=id,displayName,totalItemCount,childFolderCount`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    if (!info?.id) return NextResponse.json({ error: info?.error?.message || 'folder not found' }, { status: 404 })
    if (info.totalItemCount > 0 || info.childFolderCount > 0) {
      return NextResponse.json({ error: `"${info.displayName}" não está vazia: ${info.totalItemCount} mensagem(ns), ${info.childFolderCount} subpasta(s). Esvazie com op=move antes.` }, { status: 409 })
    }
    const r = await fetch(`${G}/me/mailFolders/${encodeURIComponent(id)}`, { method: 'DELETE', headers: gh(token) })
    if (!r.ok) return NextResponse.json({ error: `rmdir falhou (HTTP ${r.status})` }, { status: 502 })
    return NextResponse.json({ account: auth.account, deleted: info.displayName })
  }

  return NextResponse.json({ error: `unknown op ${op}` }, { status: 400 })
}
