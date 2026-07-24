import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

// Read-only mailbox queries for the assistant's daily sweeps — the service key
// and Graph tokens stay server-side; callers authenticate with the same read
// key as the WhatsApp read routes. slot picks the stream_mail_auth row.
//   op=folders                  → folder tree (3 levels) with item counts
//   op=list&folder=<id|name>    → newest messages in a folder
//   op=search&q=<text>          → $search across the mailbox
//   op=msg&id=<messageId>       → one message with its full text body

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

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const need = process.env.WHATSAPP_READ_KEY
  if (!need || p.get('key') !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const slot = Math.max(1, parseInt(p.get('slot') || '1') || 1)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth) return NextResponse.json({ error: `no auth row for slot ${slot}` }, { status: 404 })
  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'token refresh failed' }, { status: 502 })

  const op = p.get('op') || 'folders'

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

  return NextResponse.json({ error: `unknown op ${op}` }, { status: 400 })
}
