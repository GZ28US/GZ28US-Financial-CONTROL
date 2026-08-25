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
// POST { key, slot, ids[]|id, read?: boolean, folder?: string, archive?: true }
//   read    — marca lida (true) ou não-lida (false)
//   folder  — pasta/label de destino; CRIA se não existir. Aceita caminho com
//             barra ("Rides/US.043 - GZ28US Trailer"): no Graph vira pasta
//             aninhada, no Gmail vira label aninhada (que é o mesmo desenho).
//   archive — tira da caixa de entrada sem escolher pasta (Gmail: remove o
//             label INBOX; Graph: manda pro Arquivo Morto).
//
// `folder` e `archive` juntos: vale a pasta, que é mais específica.
// Devolve { ok, moved, read, folder } — e erra alto, nunca em silêncio.

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

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

async function gmailApply(auth: any, ids: string[], b: any): Promise<NextResponse> {
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
    remove.push('INBOX')            // filed = out of the inbox, same as Graph
  } else if (b.archive === true) {
    remove.push('INBOX')
  }
  if (!add.length && !remove.length) return NextResponse.json({ error: 'nada a fazer: informe read, folder ou archive' }, { status: 400 })

  const done: string[] = [], failed: { id: string; error: string }[] = []
  for (const id of ids) {
    const r = await fetch(`${GM}/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    })
    if (r.ok) done.push(id)
    else failed.push({ id, error: (await r.text()).slice(0, 200) })
  }
  return NextResponse.json({ ok: !failed.length, provider: 'gmail', account: auth.account, moved: b.folder || (b.archive ? 'ARCHIVE' : null), read: b.read ?? null, done: done.length, failed })
}

// ── Graph ───────────────────────────────────────────────────────────────────
// Pasta por caminho, criando o que faltar. "Rides/US.043 - X" → filha de Rides.
async function graphFolderId(token: string, path: string): Promise<string | null> {
  const parts = path.split('/').map(s => s.trim()).filter(Boolean)
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

  if (slot === 4) return gmailApply(auth, ids, b)

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
  for (const id0 of ids) {
    let id = id0
    if (destId) {
      const mv = await fetch(`${G}/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: gh(token), body: JSON.stringify({ destinationId: destId }) })
      const j = await mv.json().catch(() => null)
      // O move devolve uma mensagem NOVA: o id antigo morre, e marcar lida no id
      // velho depois do move dá 404 — por isso o id é trocado aqui.
      if (!j?.id) { failed.push({ id, error: (j?.error?.message || 'move falhou').slice(0, 200) }); continue }
      id = j.id
    }
    if (b.read !== undefined) {
      const pt = await fetch(`${G}/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', headers: gh(token), body: JSON.stringify({ isRead: b.read === true }) })
      if (!pt.ok) { failed.push({ id, error: (await pt.text()).slice(0, 200) }); continue }
    }
    done.push(id)
  }
  return NextResponse.json({ ok: !failed.length, provider: 'graph', account: auth.account, moved: b.folder || (b.archive ? 'ARCHIVE' : null), read: b.read ?? null, done: done.length, failed })
}
