import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { requireStaff } from '@/lib/auth.server'
import { socialDb, rowsOf } from '@/lib/social.server'
import { sendOutbox } from '@/lib/socialInbox.server'

// SOCIAL OUTBOX — RASCUNHO → APROVAÇÃO → ENVIO (13/11/2026). A lei da casa («NUNCA ENVIE NADA PRA NINGUÉM SEM QUE EU APROVE O
// RASCUNHO») vira mecanismo: toda escrita em rede social nasce aqui como DRAFT e só sai quando um HUMANO LOGADO clica APPROVE & SEND
// na tela — e só com social.publish.enabled ligado.
//
// GET  ?status=DRAFT|SENT|FAILED|CANCELLED               → a fila (tela logada ou x-read-key)
// POST { action: 'draft', kind, item_id?, account_id?, target_id?, body?, link?, context? }
//        → cria o RASCUNHO. Tela logada OU sessão com x-read-key (o Claude pode redigir; nunca enviar).
//        kind: MESSAGE_REPLY | COMMENT_REPLY | COMMENT_HIDE | COMMENT_UNHIDE | COMMENT_DELETE | POST_PUBLISH
//        com item_id, a conta, a plataforma e o destinatário saem do item — quem redige não escolhe para onde vai.
// POST { action: 'edit', id, body, link? }   → muda o texto de um rascunho (humano logado)
// POST { action: 'cancel', id }              → cancela um rascunho (humano logado)
// POST { action: 'approve_send', id }        → SÓ humano logado (requireStaff: robôs e chave de leitura recusados)
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const KINDS = new Set(['MESSAGE_REPLY', 'COMMENT_REPLY', 'COMMENT_HIDE', 'COMMENT_UNHIDE', 'COMMENT_DELETE', 'POST_PUBLISH'])

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const st = req.nextUrl.searchParams.get('status')
  let q = socialDb().from('social_outbox').select('*').order('created_at', { ascending: false }).limit(300)
  if (st && /^(DRAFT|SENT|FAILED|CANCELLED)$/.test(st)) q = q.eq('status', st)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ outbox: data || [] })
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const db = socialDb()

  if (b.action === 'draft') {
    const staff = await requireStaff(req)
    if (!staff && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const kind = String(b.kind || '')
    if (!KINDS.has(kind)) return NextResponse.json({ error: 'unknown kind', kinds: [...KINDS] }, { status: 400 })
    const body = typeof b.body === 'string' ? b.body.trim().slice(0, 8000) : ''
    const link = typeof b.link === 'string' && /^https:\/\/[^\s]{4,500}$/.test(b.link.trim()) ? b.link.trim() : null
    let account_id: number | null = null, platform: string | null = null, target_id: string | null = null, context: string | null = typeof b.context === 'string' ? b.context.slice(0, 500) : null
    let item_id: number | null = null
    if (kind === 'POST_PUBLISH') {
      const rows = await rowsOf(db, 'META')
      const conta = rows.find(r => r.kind === 'FB_PAGE' && (String(r.id) === String(b.account_id) || !b.account_id))
      if (!conta) return NextResponse.json({ error: 'no connected Facebook page', pages: rows.filter(r => r.kind === 'FB_PAGE').map(r => ({ id: r.id, account: r.account })) }, { status: 404 })
      if (!body && !link) return NextResponse.json({ error: 'a post needs a text or a link' }, { status: 400 })
      account_id = conta.id; platform = 'FACEBOOK'; context = context || `New post on ${conta.account}`
    } else {
      const { data: it } = await db.from('social_items').select('*').eq('id', Number(b.item_id) || 0).maybeSingle()
      if (!it) return NextResponse.json({ error: 'item_id not found — a reply or a moderation action always points to an inbox item' }, { status: 404 })
      const msg = kind === 'MESSAGE_REPLY'
      if (msg !== (it.kind === 'MESSAGE')) return NextResponse.json({ error: `${kind} does not fit a ${it.kind}` }, { status: 400 })
      if (!msg && it.kind !== 'COMMENT') return NextResponse.json({ error: 'only comments can be replied to or moderated' }, { status: 400 })
      if ((kind === 'MESSAGE_REPLY' || kind === 'COMMENT_REPLY') && !body) return NextResponse.json({ error: 'a reply needs a text' }, { status: 400 })
      if (!it.account_id) return NextResponse.json({ error: 'the item has no connected account any more' }, { status: 409 })
      // mensagem → a PESSOA do outro lado; comentário → o próprio comentário (resposta num comentário-filho vai para o pai no Instagram)
      target_id = msg ? it.from_id : (it.platform === 'INSTAGRAM' && kind === 'COMMENT_REPLY' && it.parent_id ? it.parent_id : it.external_id)
      if (!target_id) return NextResponse.json({ error: 'this item has no one to answer (the other side has no id)' }, { status: 409 })
      account_id = it.account_id; platform = it.platform; item_id = it.id
      context = context || `${msg ? 'To' : 'On a comment by'} ${it.from_me ? it.thread_title || 'the other side' : it.from_name || 'unknown'}: «${String(it.body || '').slice(0, 200)}»`
    }
    const { data, error } = await db.from('social_outbox').insert([{ account_id, platform, action: kind, target_id, item_id, body: body || null, link, context, created_by: staff?.email || 'session' }]).select('*').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, draft: data, note: 'DRAFT only. It leaves when a logged-in person clicks APPROVE & SEND at /ca/social/inbox.' })
  }

  // daqui para baixo: só humano logado
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'only a logged-in person can do this' }, { status: 401 })
  const id = Number(b.id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'bad id' }, { status: 400 })
  if (b.action === 'edit') {
    const patch: Record<string, unknown> = { body: typeof b.body === 'string' ? b.body.trim().slice(0, 8000) : null }
    if (typeof b.link === 'string') patch.link = /^https:\/\/[^\s]{4,500}$/.test(b.link.trim()) ? b.link.trim() : null
    const { data, error } = await db.from('social_outbox').update(patch).eq('id', id).eq('status', 'DRAFT').is('approved_at', null).select('id').maybeSingle()
    return NextResponse.json(error || !data ? { error: error?.message || 'not a draft any more' } : { ok: true }, { status: error || !data ? 409 : 200 })
  }
  if (b.action === 'cancel') {
    const { data, error } = await db.from('social_outbox').update({ status: 'CANCELLED', error: `cancelled by ${staff.email}` }).eq('id', id).eq('status', 'DRAFT').is('approved_at', null).select('id').maybeSingle()
    return NextResponse.json(error || !data ? { error: error?.message || 'not a draft any more' } : { ok: true }, { status: error || !data ? 409 : 200 })
  }
  if (b.action === 'approve_send') {
    const r = await sendOutbox(db, id, staff.email)
    return NextResponse.json(r, { status: r.ok ? 200 : 409 })
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
