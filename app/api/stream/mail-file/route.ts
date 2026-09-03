import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

// ARQUIVAR / MARCAR LIDO — as 4 caixas, um contrato só.
//
// O Graph (slots 1-3) já sabia mover e marcar como lida em scripts avulsos; o
// Gmail (slot 4) não sabia nada — a mail-query é read-only. Resultado: toda
// mensagem do Gmail tratada numa rodada ficava encalhada na inbox, e a lei do
// INBOX ZERO nas 4 caixas não fechava nunca (25/ago/2026).
//
// POST { key, slot, ids[]|id, read?: boolean, folder?: string, archive?: true, copy?: true }
//   read    — marca lida (true) ou não-lida (false)
//   folder  — pasta/label de destino; CRIA se não existir. Aceita caminho com
//             barra ("Rides/US.043 - GZ28US Trailer"): no Graph vira pasta
//             aninhada, no Gmail vira label aninhada (que é o mesmo desenho).
//   archive — tira da caixa de entrada sem escolher pasta (Gmail: remove o
//             label INBOX; Graph: manda pro Arquivo Morto).
//   copy    — DEIXA o original onde está e coloca uma cópia na pasta. Existe
//             porque um e-mail pode ser de DOIS carros ao mesmo tempo (compra
//             casada: "Demon 170 stock CL37674 & CL37676") e a lei manda que
//             ele esteja na pasta de cada um. Fluxo: copy nos carros extras,
//             move no último — aí ninguém fica com a pasta vazia.
//
//   note      — o que foi feito, em uma linha ("lançado na US.030.4")
//   ref_table / ref_id — no que o e-mail VIROU no app (ex.: invoice_expenses + id)
//
// `folder` e `archive` juntos: vale a pasta, que é mais específica.
// Devolve { ok, moved, read, done, marcados } — e erra alto, nunca em silêncio.
//
// TODO ARQUIVAMENTO GRAVA MARCA D'ÁGUA em `mail_processed` (02/set/2026): conta,
// id antes e depois do move, assunto, remetente, data, pasta, ação e — quando o
// chamador informa — a linha do app que aquele e-mail virou. É o que responde
// "cadê esse e-mail e o que foi feito com ele" depois, mesmo que a mensagem
// tenha sido movida de novo por outra sessão.

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

// ── MARCA D'ÁGUA (Márcio, 02/set/2026) ──────────────────────────────────────
// "todos os emails processados devem ir pra sua pasta e marcados como
// processados". O WhatsApp já tinha marca d'água por conversa; o e-mail não
// tinha nada — "processado" era só "sumiu da inbox", que não diz o que foi
// feito, nem por quem, e evapora se alguém mover a mensagem outra vez.
//
// Grava AQUI, na rota, e não no script de quem chama: assim QUALQUER sessão que
// arquive um e-mail deixa rastro, sem depender de quem está no teclado.
// Falhar a gravação NUNCA desfaz o arquivamento — o e-mail já se moveu, e um
// registro perdido é menos grave que uma exceção que esconde o move.
type Marca = {
  account: string; slot: number
  origin_message_id: string; message_id?: string | null
  subject?: string | null; from_addr?: string | null; received_at?: string | null
  folder?: string | null; action: string
  ref_table?: string | null; ref_id?: string | null; note?: string | null
}
async function registrar(db: ReturnType<typeof streamDb>, linhas: Marca[]) {
  if (!linhas.length) return
  try {
    await db.from('mail_processed').upsert(linhas, { onConflict: 'account,origin_message_id' })
  } catch (e) {
    console.error('[mail-file] marca d\'água falhou (o e-mail JÁ foi arquivado):', e)
  }
}

// O Graph tem nomes BEM-CONHECIDOS (inbox, archive, sentitems, drafts...) que
// resolvem em qualquer idioma. `graphFolderId` procura por displayName e CRIA se
// não achar — numa caixa em português a inbox se chama "Caixa de Entrada", então
// pedir "inbox" criava uma pasta FANTASMA e o e-mail sumia de vista. Já prendeu
// 65 e-mails uma vez e repetiu com 2 da HP Tuners em 02/set/2026.
const BEM_CONHECIDAS: Record<string, string> = {
  inbox: 'inbox', 'caixa de entrada': 'inbox',
  archive: 'archive', 'arquivo morto': 'archive',
  sent: 'sentitems', sentitems: 'sentitems', 'itens enviados': 'sentitems',
  drafts: 'drafts', rascunhos: 'drafts',
  deleteditems: 'deleteditems', 'itens excluídos': 'deleteditems',
  junkemail: 'junkemail', 'lixo eletrônico': 'junkemail',
}

// ── Gmail ───────────────────────────────────────────────────────────────────
async function gmailToken(auth: any): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret || !auth?.refresh_token) return null
  const tk = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: auth.refresh_token, grant_type: 'refresh_token' }),
  })).json()
  return tk?.access_token || null
}

// Label por nome, criando a árvore inteira se faltar ("A/B" cria "A" e "A/B").
async function gmailLabelId(token: string, path: string): Promise<string | null> {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const all = await (await fetch(`${GM}/labels`, { headers: H })).json()
  const byName = new Map<string, string>((all?.labels || []).map((l: any) => [String(l.name), String(l.id)]))
  const parts = path.split('/').map(s => s.trim()).filter(Boolean)
  let acc = '', id: string | null = null
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    const hit = byName.get(acc)
    if (hit) { id = hit; continue }
    const made = await (await fetch(`${GM}/labels`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: acc, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    })).json()
    if (!made?.id) return null
    byName.set(acc, made.id)
    id = made.id
  }
  return id
}

async function gmailApply(db: ReturnType<typeof streamDb>, slot: number, auth: any, ids: string[], b: any): Promise<NextResponse> {
  const token = await gmailToken(auth)
  if (!token) return NextResponse.json({ error: 'gmail não conectado (GOOGLE_CLIENT_ID/SECRET ou refresh_token)' }, { status: 503 })
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const add: string[] = [], remove: string[] = []
  if (b.read === true) remove.push('UNREAD')
  if (b.read === false) add.push('UNREAD')
  let folderId: string | null = null
  if (b.folder) {
    folderId = await gmailLabelId(token, String(b.folder))
    if (!folderId) return NextResponse.json({ error: `não consegui criar/achar o label "${b.folder}"` }, { status: 502 })
    add.push(folderId)
    // copy = só rotula; o original continua na inbox pro move seguinte levá-lo.
    if (b.copy !== true) remove.push('INBOX')   // filed = out of the inbox, same as Graph
  } else if (b.archive === true) {
    remove.push('INBOX')
  }
  if (!add.length && !remove.length) return NextResponse.json({ error: 'nada a fazer: informe read, folder ou archive' }, { status: 400 })

  const done: string[] = [], failed: { id: string; error: string }[] = []
  const marcas: Marca[] = []
  for (const id of ids) {
    const r = await fetch(`${GM}/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    })
    if (!r.ok) { failed.push({ id, error: (await r.text()).slice(0, 200) }); continue }
    done.push(id)
    // No Gmail o id SOBREVIVE ao label (não há move de verdade), então o
    // metadado pode ser lido depois, sem correr contra o relógio.
    let hdr: Record<string, string> = {}, recebido: string | null = null
    try {
      const m = await (await fetch(`${GM}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers: H })).json()
      for (const h of (m?.payload?.headers || [])) hdr[String(h.name).toLowerCase()] = String(h.value)
      if (m?.internalDate) recebido = new Date(Number(m.internalDate)).toISOString()
    } catch { /* metadado é bônus */ }
    marcas.push({
      account: String(auth.account), slot,
      origin_message_id: id, message_id: id,
      subject: hdr.subject ?? null,
      from_addr: (hdr.from || '').match(/<([^>]+)>/)?.[1] || hdr.from || null,
      received_at: recebido,
      folder: b.folder ? String(b.folder) : (b.archive === true ? 'ARCHIVE' : null),
      action: b.copy === true ? 'COPIED' : b.folder ? 'FILED' : b.archive === true ? 'ARCHIVED' : 'READ',
      ref_table: b.ref_table ? String(b.ref_table) : null,
      ref_id: b.ref_id ? String(b.ref_id) : null,
      note: b.note ? String(b.note).slice(0, 400) : null,
    })
  }
  await registrar(db, marcas)
  return NextResponse.json({ ok: !failed.length, provider: 'gmail', account: auth.account, moved: b.folder || (b.archive ? 'ARCHIVE' : null), read: b.read ?? null, done: done.length, marcados: marcas.length, failed })
}

// ── Graph ───────────────────────────────────────────────────────────────────
// Pasta por caminho, criando o que faltar. "Rides/US.043 - X" → filha de Rides.
async function graphFolderId(token: string, path: string): Promise<string | null> {
  const parts = path.split('/').map(s => s.trim()).filter(Boolean)
  // Nome bem-conhecido sozinho NÃO vira pasta nova: devolve o id reservado do
  // Graph, que é o que o usuário quis dizer. Só um caminho com barra
  // ("Rides/US.048 - X") segue para a criação por displayName.
  if (parts.length === 1) {
    const bem = BEM_CONHECIDAS[parts[0].toLowerCase()]
    if (bem) return bem
  }
  let parent: string | null = null
  for (const p of parts) {
    const url: string = parent ? `${G}/me/mailFolders/${parent}/childFolders` : `${G}/me/mailFolders`
    const list: any = await (await fetch(`${url}?$top=250&$select=id,displayName`, { headers: gh(token) })).json()
    const hit: any = (list?.value || []).find((f: any) => String(f.displayName).toLowerCase() === p.toLowerCase())
    if (hit) { parent = String(hit.id); continue }
    const made: any = await (await fetch(url, { method: 'POST', headers: gh(token), body: JSON.stringify({ displayName: p }) })).json()
    if (!made?.id) return null
    parent = String(made.id)
  }
  return parent
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  if (!b?.key || b.key !== process.env.WHATSAPP_READ_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : b.id ? [String(b.id)] : []
  if (!ids.length) return NextResponse.json({ error: 'ids[] (ou id) é obrigatório' }, { status: 400 })
  if (b.read === undefined && !b.folder && b.archive !== true) {
    return NextResponse.json({ error: 'nada a fazer: informe read, folder ou archive' }, { status: 400 })
  }

  const db = streamDb()
  const slot = Number(b.slot) || 1
  const auth = await getMailAuth(db, slot)
  if (!auth) return NextResponse.json({ error: `slot ${slot} sem autenticação` }, { status: 404 })

  if (slot === 4) return gmailApply(db, slot, auth, ids, b)

  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'token expirado' }, { status: 502 })

  let destId: string | null = null
  if (b.folder) {
    destId = await graphFolderId(token, String(b.folder))
    if (!destId) return NextResponse.json({ error: `não consegui criar/achar a pasta "${b.folder}"` }, { status: 502 })
  } else if (b.archive === true) {
    destId = 'archive'              // pasta bem-conhecida do Graph
  }

  const done: string[] = [], failed: { id: string; error: string }[] = []
  const marcas: Marca[] = []
  for (const id0 of ids) {
    let id = id0
    // Metadados ANTES do move: depois dele o id velho morre e a mensagem não
    // responde mais. Sem isso a marca d'água nasceria sem assunto nem remetente,
    // que é justamente o que se precisa quando a mensagem some.
    let meta: any = null
    try {
      const mr = await fetch(`${G}/me/messages/${encodeURIComponent(id)}?$select=subject,from,receivedDateTime`, { headers: gh(token) })
      if (mr.ok) meta = await mr.json()
    } catch { /* metadado é bônus, não bloqueia o arquivamento */ }
    if (destId) {
      const verb = b.copy === true ? 'copy' : 'move'
      const mv = await fetch(`${G}/me/messages/${encodeURIComponent(id)}/${verb}`, { method: 'POST', headers: gh(token), body: JSON.stringify({ destinationId: destId }) })
      const j = await mv.json().catch(() => null)
      // O move devolve uma mensagem NOVA: o id antigo morre, e marcar lida no id
      // velho depois do move dá 404 — por isso o id é trocado aqui. No copy o
      // original sobrevive, e é NELE que o read tem de cair.
      if (!j?.id) { failed.push({ id, error: (j?.error?.message || `${verb} falhou`).slice(0, 200) }); continue }
      if (b.copy !== true) id = j.id
    }
    if (b.read !== undefined) {
      const pt = await fetch(`${G}/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', headers: gh(token), body: JSON.stringify({ isRead: b.read === true }) })
      if (!pt.ok) { failed.push({ id, error: (await pt.text()).slice(0, 200) }); continue }
    }
    done.push(id)
    marcas.push({
      account: String(auth.account), slot,
      origin_message_id: id0, message_id: id,
      subject: meta?.subject ?? null,
      from_addr: meta?.from?.emailAddress?.address ?? null,
      received_at: meta?.receivedDateTime ?? null,
      folder: b.folder ? String(b.folder) : (b.archive === true ? 'ARCHIVE' : null),
      action: b.copy === true ? 'COPIED' : b.folder ? 'FILED' : b.archive === true ? 'ARCHIVED' : 'READ',
      ref_table: b.ref_table ? String(b.ref_table) : null,
      ref_id: b.ref_id ? String(b.ref_id) : null,
      note: b.note ? String(b.note).slice(0, 400) : null,
    })
  }
  await registrar(db, marcas)
  return NextResponse.json({ ok: !failed.length, provider: 'graph', account: auth.account, moved: b.folder || (b.archive ? 'ARCHIVE' : null), copied: b.copy === true, read: b.read ?? null, done: done.length, marcados: marcas.length, failed })
}
