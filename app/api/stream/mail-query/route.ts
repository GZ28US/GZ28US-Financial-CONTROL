import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, mailProvider, listGmailIds } from '@/lib/streamMail.server'
import { pastaDoProvedor, termoDeBuscaGraph } from '@/lib/mailFolders'

// Read-only mailbox queries for the assistant's daily sweeps — the service key
// and Graph tokens stay server-side; callers authenticate with the same read
// key as the WhatsApp read routes. slot picks the stream_mail_auth row.
//   op=folders                  → folder tree (3 levels) with item counts
//   op=list&folder=<id|name>    → newest messages in a folder
//   op=search&q=<text>          → $search across the mailbox (+ phrase=1 tenta a
//                                 frase exata, ver o bloco do op=search)
//   op=msg&id=<messageId>       → one message with its full text body
//   op=attachments&id=<msgId>   → the message's attachments (name, type, size)
//   op=attach&id=<msgId>&att=<attachmentId> → one attachment as base64, ready to
//                                 hand to /api/read-doc (o documento anexado é a
//                                 verdade — nota, invoice, boleto, contrato)
//
// PEDIDO MAL FEITO DEVOLVE 400 COM O MOTIVO, NUNCA 502 (11/set/2026, ordem dele
// no PACOTE): 502 é "o app quebrou" e script que não confere erro lê como "zero
// resultados". `folder` é traduzido por provedor (spam ↔ junkemail ↔ SPAM) e as
// aspas saem do `q` do Graph — as duas regras moram em lib/mailFolders.ts.
// O CONTRÁRIO TAMBÉM É LEI: recusa de INFRA do provedor (401/403 de token e
// consentimento, 429 de throttle) continua saindo 5xx — ver `culpaDoChamador`.
// Vale nos dois ramos, Graph e Gmail; fora do `list`/`search` (msg, attach,
// mkdir, move, rmdir) o contrato de erro é o antigo, não foi mexido.
// Sem as aspas a busca é por PALAVRA, não por frase exata: a resposta diz
// (`quotesRemoved` + `warning`) e `phrase=1` tenta a frase.

export const dynamic = 'force-dynamic'

const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const G = 'https://graph.microsoft.com/v1.0'

// ── DE QUEM É A CULPA (11/set/2026, conserto depois da revisão) ─────────────
// 4xx do provedor NÃO é tudo "pedido mal feito". 400 (termo ou id torto) e 404
// (pasta que esta caixa não tem) são de quem chamou e viram 400 aqui. Já 401 e
// 403 (token revogado, consentimento caído) e 429 (throttle do Graph, que morde
// justamente o $search em varredura dia-a-dia) são falha de INFRA e continuam
// 502 — é o 5xx que acende o alerta da Vercel (foi ele que descobriu o bug das
// aspas em 10/set) e é nele que os scripts das rodadas tentam de novo. Carimbar
// throttle de "pedido errado" apagaria o alerta e faria a sessão concluir que
// não há e-mail quando a caixa só estava engasgada.
const culpaDoChamador = (status: number) => status === 400 || status === 404

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
    const q = p.get('q')
    if (op === 'search' && !q) return NextResponse.json({ error: 'missing q' }, { status: 400 })
    // `folder=junkemail` (nome do Outlook) numa caixa Google virava 502 desde o
    // commit `4e78812` — e antes dele era pior: 200 com lista vazia, calado.
    // Agora traduz ("spam" → `SPAM`) e, se não reconhecer, 400 com os válidos
    // DAQUELA caixa (o rótulo de usuário vai pelo id, e o 400 já traz a lista).
    // Só no `list`: a busca ignora `folder`, e quem já manda o parâmetro à toa
    // não pode passar a levar 400.
    let folder = 'INBOX', folderTraduzida = false
    if (op === 'list') {
      const alvo = pastaDoProvedor(p.get('folder') || '', 'gmail')
      if (!alvo.ok) {
        const r = await fetch(`${API}/labels`, { headers: GH }).catch(() => null)
        const rotulos = r ? await r.json().catch(() => null) : null
        return NextResponse.json({
          error: alvo.motivo, provider: 'gmail', account: auth.account,
          validFolders: alvo.validas,
          labels: (rotulos?.labels || []).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })),
        }, { status: 400 })
      }
      folder = alvo.folder
      folderTraduzida = alvo.traduzida
    }
    // Página por página (10/set/2026): o Gmail devolve página curta com mais
    // resultado atrás, e "veio menos que o limite" NÃO quer dizer janela completa
    // (caixa 5: 122 achadas por janela larga contra 349 dia a dia). `nextPageToken`
    // na resposta = tem mais; mande de volta em `pageToken` para continuar.
    const lista = await listGmailIds(tk.access_token, {
      max: top,
      pageToken: p.get('pageToken') || undefined,
      ...(op === 'list' ? { labelIds: folder } : { q: q as string }),
    })
    // Rótulo que passou pela tradução mas não existe nesta caixa (um `Label_99`
    // chutado) volta como "Invalid label" do Google: é pedido errado, 400. O
    // resto vai pelo HTTP do próprio Google (`lista.status`, novo na
    // `listGmailIds`): 400/404 é pedido — inclusive `pageToken` vencido, que
    // antes saía 502 e fazia caçar defeito de infra —, e 401/403/429 (token,
    // quota, throttle) segue 502, que é o que acende alerta e faz repetir.
    if (lista.error && !lista.ids.length) {
      const rotuloTorto = /invalid label/i.test(lista.error)
      const doChamador = rotuloTorto || (lista.status != null && culpaDoChamador(lista.status))
      return NextResponse.json({
        error: 'gmail list failed: ' + lista.error, provider: 'gmail', account: auth.account,
        ...(lista.status != null ? { providerStatus: lista.status } : {}),
        ...(op === 'list' ? { folder } : {}),
        hint: rotuloTorto ? 'pegue o id do rótulo em op=folders'
          : doChamador ? 'o Google recusou o PEDIDO (rótulo, q ou pageToken torto) — confira o parâmetro antes de repetir'
          : 'não foi o pedido: token, quota, throttle ou Google sem resposta — tente de novo',
      }, { status: doChamador ? 400 : 502 })
    }
    const out = []
    for (const m of lista.ids.slice(0, top)) out.push(await meta(m.id))
    return NextResponse.json({
      account: auth.account, provider: 'gmail', messages: out,
      // A pasta que valeu de verdade — quem pediu "spam" precisa ver `SPAM` na
      // resposta para saber em que pasta olhou.
      ...(op === 'list' ? { folder, ...(folderTraduzida ? { folderTranslated: true } : {}) } : {}),
      nextPageToken: lista.nextPageToken, more: !!lista.nextPageToken,
      ...(lista.error ? { partial: true, error: lista.error } : {}),
    })
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

  // mkdir / move NO GMAIL (04/set/2026) — a caixa da Chris (slot 5) podia ser
  // LIDA e nao podia ser ARRUMADA: os dois ops so existiam no lado Graph, entao
  // o inbox zero parava na porta dela. No Gmail nao ha "pasta": ha RoTULO, e
  // "mover" e adicionar o rotulo e tirar o INBOX — mesma semantica do move do
  // Graph (sai da caixa, passa a morar na pasta), mesma resposta, para quem
  // chama nao precisar saber de que provedor a caixa e ([[claudinha-is-an-interface]]).
  if (op === 'mkdir') {
    const name = (p.get('name') || '').trim()
    if (!name) return NextResponse.json({ error: 'missing name' }, { status: 400 })
    // Rotulo repetido devolve 409 no Gmail; procurar antes deixa o op idempotente.
    const ex = await (await fetch(`${API}/labels`, { headers: GH })).json()
    const hit = (ex?.labels || []).find((l: any) => String(l.name).toLowerCase() === name.toLowerCase())
    if (hit) return NextResponse.json({ account: auth.account, provider: 'gmail', folder: { id: hit.id, name: hit.name }, existed: true })
    const c = await (await fetch(`${API}/labels`, {
      method: 'POST', headers: { ...GH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    })).json()
    if (!c?.id) return NextResponse.json({ error: c?.error?.message || 'mkdir failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, provider: 'gmail', folder: { id: c.id, name: c.name }, existed: false })
  }

  if (op === 'move') {
    const id = p.get('id')
    const dest = p.get('dest')
    if (!id || !dest) return NextResponse.json({ error: 'missing id or dest' }, { status: 400 })
    const r = await fetch(`${API}/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST', headers: { ...GH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [dest], removeLabelIds: ['INBOX'] }),
    })
    const m = await r.json().catch(() => null)
    if (!m?.id) return NextResponse.json({ error: m?.error?.message || 'move failed' }, { status: 502 })
    return NextResponse.json({ account: auth.account, provider: 'gmail', moved: m.id })
  }
  return NextResponse.json({ error: `unknown op ${op}` }, { status: 400 })
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const need = process.env.WHATSAPP_READ_KEY
  // A chave também vale no header `x-read-key` (10/set/2026): na query string ela
  // fica gravada em todo log de acesso. Quem já chama com `?key=` continua igual.
  if (!need || (req.headers.get('x-read-key') || p.get('key')) !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

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
    // `folder=spam` numa caixa Outlook (aqui é `junkemail`) devolvia 502 — foi
    // assim na caixa 1 em 10/set 17:46 Orlando, dentro do alerta de 5xx. Traduz
    // o nome comum; nome que esta caixa não endereça sai como 400 com os
    // válidos, e pasta de caso continua indo pelo id do `op=folders`.
    // ⚠️ Para NOME DE PASTA DE CASO ("Market", "Rides/US.042 - SublimeHell") a
    // mudança é 200→400, não 502→400: a medida da casa ([[mail-processed-watermark]],
    // [[email-round-process]]) é que pasta customizada devolvia 0 mensagens EM
    // SILÊNCIO — leitura cega que não prova pasta vazia. Quem trata não-2xx como
    // fatal passa a parar aqui; é o preço de não mentir "vazio".
    const alvo = pastaDoProvedor(p.get('folder') || '', 'graph')
    if (!alvo.ok) return NextResponse.json({ error: alvo.motivo, account: auth.account, validFolders: alvo.validas }, { status: 400 })
    const folder = alvo.folder
    const top = Math.min(100, parseInt(p.get('limit') || '25') || 25)
    const r = await fetch(`${G}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=id,subject,from,toRecipients,receivedDateTime,isRead,parentFolderId&$orderby=receivedDateTime desc`, { headers: gh(token) })
    const data = await r.json().catch(() => null)
    // Recusa do Graph por causa do PEDIDO (pasta que a caixa não tem, id torto)
    // é 400/404 lá e passa a ser 400 aqui; throttle e token caído seguem 502
    // (ver `culpaDoChamador`). Mentir sobre de quem é a culpa — para qualquer um
    // dos dois lados — faz a sessão procurar defeito no lugar errado.
    if (!Array.isArray(data?.value)) {
      const doChamador = culpaDoChamador(r.status)
      const espera = r.headers.get('retry-after')
      return NextResponse.json({
        error: data?.error?.message || `list failed (HTTP ${r.status})`, account: auth.account, folder, providerStatus: r.status,
        ...(doChamador
          ? { hint: 'o Outlook não achou esta pasta na caixa — confira o id em op=folders' }
          : r.status >= 400
            ? { hint: `recusa de INFRA do Outlook (HTTP ${r.status}: token, consentimento ou throttle) — o pedido está de pé, tente de novo` }
            : {}),
        ...(espera ? { retryAfter: espera } : {}),
      }, { status: doChamador ? 400 : 502 })
    }
    return NextResponse.json({ account: auth.account, folder, ...(alvo.traduzida ? { folderTranslated: true } : {}), messages: data.value.map(slim) })
  }

  if (op === 'search') {
    const q = p.get('q') || ''
    if (!q) return NextResponse.json({ error: 'missing q' }, { status: 400 })
    // AS ASPAS (ordem dele, 11/set): o `$search` já embrulha o termo inteiro em
    // aspas, então aspa dentro do `q` quebra o KQL — medido em 10/set 20:53
    // Orlando, `q="Destroyer Grey"` deu 502 `An identifier was expected at
    // position 0.` e o mesmo termo sem aspas deu 200. Em vez de devolver erro de
    // servidor, tira as aspas e DIZ NA RESPOSTA que tirou — porque o resultado
    // muda: sem aspas a busca é pelas PALAVRAS, não pela frase, e pode voltar
    // e-mail a mais. A janela `received:` continua valendo.
    const { termo, aspasRemovidas } = termoDeBuscaGraph(q)
    if (!termo) return NextResponse.json({ error: 'q só tinha aspas: sobrou termo nenhum para buscar', q }, { status: 400 })
    // FRASE EXATA, OPT-IN (`phrase=1`): manda `$search="\"termo\""`, a forma com
    // aspa escapada. NÃO ESTÁ MEDIDA contra caixa de verdade — esta fatia não
    // chamou o Graph —, por isso não é o padrão; se ele recusar, vem 400 com a
    // mensagem dele e o chamador repete sem `phrase=1`. Com operador de campo
    // dentro do termo o embrulho não faz sentido, então recusa antes de mandar.
    const querFrase = /^(1|true|sim)$/i.test(p.get('phrase') || '')
    if (querFrase && termo.includes(':')) {
      return NextResponse.json({ error: 'phrase=1 é só para texto puro: tire o operador (from:, subject:, received:) do q, ou repita sem phrase=1', q: termo }, { status: 400 })
    }
    const expressaoDeBusca = querFrase ? `"\\"${termo}\\""` : `"${termo}"`
    const r = await fetch(`${G}/me/messages?$search=${encodeURIComponent(expressaoDeBusca)}&$top=${Math.min(100, parseInt(p.get('limit') || '25') || 25)}&$select=id,subject,from,toRecipients,receivedDateTime,isRead,parentFolderId`, { headers: gh(token) })
    const data = await r.json().catch(() => null)
    // Termo que o KQL não engole (400) é culpa de quem chamou; throttle e token
    // caído continuam 502 (ver `culpaDoChamador`) — o 429 morde justamente esta
    // busca quando a rodada varre 6 caixas dia a dia.
    if (!Array.isArray(data?.value)) {
      const doChamador = culpaDoChamador(r.status)
      const espera = r.headers.get('retry-after')
      return NextResponse.json({
        error: data?.error?.message || `search failed (HTTP ${r.status})`, account: auth.account, q: termo, providerStatus: r.status,
        ...(doChamador
          ? { hint: querFrase
              ? 'o KQL recusou a frase escapada do phrase=1 — repita sem phrase=1 (busca pelas palavras)'
              : 'o KQL do Outlook recusou o termo — palavra solta e `received:AAAA-MM-DD..AAAA-MM-DD` funcionam' }
          : r.status >= 400
            ? { hint: `recusa de INFRA do Outlook (HTTP ${r.status}: token, consentimento ou throttle) — o termo está de pé, tente de novo` }
            : {}),
        ...(espera ? { retryAfter: espera } : {}),
      }, { status: doChamador ? 400 : 502 })
    }
    return NextResponse.json({
      account: auth.account, q: termo,
      ...(querFrase ? { phrase: true } : {}),
      // O aviso vai em TEXTO, não só num campo booleano que ninguém lê: quem
      // procurou o fornecedor exato precisa saber que o conjunto pode ser maior
      // antes de pendurar o e-mail numa invoice.
      ...(aspasRemovidas && !querFrase ? {
        quotesRemoved: true,
        warning: 'as aspas saíram do q: busca pelas PALAVRAS, não pela frase exata — pode vir e-mail a mais, confira cada um antes de amarrar a uma compra. Frase: repita com phrase=1',
      } : {}),
      messages: data.value.map(slim),
    })
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
