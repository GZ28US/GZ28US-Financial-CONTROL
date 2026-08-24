import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth.server'
import { waDb } from '@/lib/waStore.server'

// WHATSAPP HUB — a janela da tela /whatsapp sobre o espelho (whatsapp_messages
// + whatsapp_chats, os DOIS números). Só sessão logada (requireUser): o espelho
// é a vida inteira do Márcio em mensagens — jamais aberto.
//
//   ?view=chats     &app=ALL|US|BR &q=            → chats + última mensagem
//   ?view=messages  &app=US|BR &chatId= &limit= &before=  → uma conversa (asc)
//   ?view=search    &q= &app= &limit=             → busca no corpo das mensagens
//
// POST { chatId, app, policy } muda a POLÍTICA do chat (ordem do Márcio,
// 24/ago/2026): há grupos em que só é pauta dele se ele for MARCADO.
//   ALL          tudo vira pauta (padrão)
//   MENTION_ONLY só vira pauta quando o Márcio é marcado na mensagem
//   IGNORE       nunca vira pauta

export const dynamic = 'force-dynamic'

const POLICIES = new Set(['ALL', 'MENTION_ONLY', 'IGNORE'])

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const chatId = String(b.chatId || '').trim()
  const app = String(b.app || '').toUpperCase()
  const policy = String(b.policy || '').toUpperCase()
  if (!chatId.includes('@') || (app !== 'US' && app !== 'BR') || !POLICIES.has(policy)) {
    return NextResponse.json({ error: 'chatId + app=US|BR + policy=ALL|MENTION_ONLY|IGNORE required' }, { status: 400 })
  }
  // O mesmo grupo existe nos 2 números — a política vale para os dois.
  const { error } = await waDb().from('whatsapp_chats').update({ policy }).eq('chat_id', chatId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, chatId, policy })
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = waDb()
  const p = req.nextUrl.searchParams
  const view = p.get('view') || 'chats'
  const app = (p.get('app') || 'ALL').toUpperCase()

  try {
    if (view === 'chats') {
      const q = (p.get('q') || '').trim()
      let sel = db.from('whatsapp_chats').select('*').neq('policy', 'IGNORE').order('last_at', { ascending: false, nullsFirst: false }).limit(120)
      if (app === 'US' || app === 'BR') sel = sel.eq('app', app)
      if (q) sel = sel.ilike('name', `%${q}%`)
      const { data: chats, error } = await sel
      if (error) throw error

      // Última mensagem por chat numa query só — reduz no servidor.
      const ids = (chats || []).map((c: any) => c.chat_id)
      const last: Record<string, any> = {}
      if (ids.length) {
        let msel = db.from('whatsapp_messages')
          .select('app, chat_id, from_me, type, body, media_url, sent_at')
          .in('chat_id', ids.slice(0, 120))
          .order('sent_at', { ascending: false })
          .limit(600)
        if (app === 'US' || app === 'BR') msel = msel.eq('app', app)
        const { data: msgs } = await msel
        for (const m of msgs || []) {
          const k = `${m.app}|${m.chat_id}`
          if (!last[k]) last[k] = m
        }
      }

      return NextResponse.json({
        chats: (chats || []).map((c: any) => {
          const lm = last[`${c.app}|${c.chat_id}`] || null
          return {
            app: c.app, chatId: c.chat_id, name: c.name, isGroup: c.is_group,
            lastAt: lm?.sent_at || c.last_at, unread: c.unread, policy: c.policy || 'ALL',
            lastFromMe: lm ? !!lm.from_me : null,
            lastType: lm?.type || null,
            lastBody: lm ? String(lm.body || (lm.media_url ? '[media]' : '')).slice(0, 140) : null,
          }
        }),
      })
    }

    if (view === 'messages') {
      const chatId = (p.get('chatId') || '').trim()
      if (!chatId.includes('@') || (app !== 'US' && app !== 'BR')) {
        return NextResponse.json({ error: 'chatId + app=US|BR required' }, { status: 400 })
      }
      const limit = Math.min(parseInt(p.get('limit') || '100') || 100, 300)
      const before = p.get('before')
      let sel = db.from('whatsapp_messages')
        .select('id, from_me, author, pushname, type, body, media_url, sent_at')
        .eq('app', app).eq('chat_id', chatId)
        .order('sent_at', { ascending: false }).limit(limit)
      if (before) sel = sel.lt('sent_at', before)
      const { data, error } = await sel
      if (error) throw error
      return NextResponse.json({ chatId, app, messages: (data || []).reverse() })
    }

    if (view === 'search') {
      const q = (p.get('q') || '').trim()
      if (q.length < 2) return NextResponse.json({ hits: [] })
      const limit = Math.min(parseInt(p.get('limit') || '40') || 40, 100)
      let sel = db.from('whatsapp_messages')
        .select('app, chat_id, from_me, pushname, type, body, media_url, sent_at')
        .ilike('body', `%${q}%`)
        .order('sent_at', { ascending: false }).limit(limit)
      if (app === 'US' || app === 'BR') sel = sel.eq('app', app)
      const { data, error } = await sel
      if (error) throw error
      // Nome do chat pra rotular o hit.
      const ids = Array.from(new Set((data || []).map((m: any) => m.chat_id)))
      const names: Record<string, string> = {}
      if (ids.length) {
        const { data: cs } = await db.from('whatsapp_chats').select('app, chat_id, name').in('chat_id', ids)
        for (const c of cs || []) names[`${c.app}|${c.chat_id}`] = c.name || ''
      }
      return NextResponse.json({
        hits: (data || []).map((m: any) => ({ ...m, chat_name: names[`${m.app}|${m.chat_id}`] || null })),
      })
    }

    return NextResponse.json({ error: 'unknown view' }, { status: 400 })
  } catch (e) {
    console.error('[whatsapp-inbox]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
