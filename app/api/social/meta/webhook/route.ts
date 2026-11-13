import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { socialDb, rowsOf } from '@/lib/social.server'
import { saveItems } from '@/lib/socialInbox.server'

// WEBHOOK DA META (13/11/2026) — a porta por onde Facebook/Instagram EMPURRAM mensagem, comentário e menção na hora.
//   GET  = a verificação do painel da Meta: devolve hub.challenge só se hub.verify_token == META_WEBHOOK_VERIFY_TOKEN.
//   POST = o evento. A assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo cru com META_APP_SECRET) é conferida; evento com
//          assinatura errada é RECUSADO (401) e não vira item. O cru de todo evento aceito fica em social_webhook_events.
// Sem as duas variáveis no ambiente a porta fica FECHADA (falha fechada). Não responde nada a ninguém, não envia nada.
// LIMITE: com o app em modo Development a Meta só entrega eventos de quem tem papel no app. Até o app ficar Live, quem alimenta
// o inbox é a leitura periódica (/api/cron/social-inbox); isto aqui já fica pronto para o dia.
export const dynamic = 'force-dynamic'
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams, need = process.env.META_WEBHOOK_VERIFY_TOKEN
  const got = sp.get('hub.verify_token') || ''
  if (!need || sp.get('hub.mode') !== 'subscribe' || got.length !== need.length || !timingSafeEqual(Buffer.from(got), Buffer.from(need))) return new NextResponse('forbidden', { status: 403 })
  return new NextResponse(sp.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

export async function POST(req: NextRequest) {
  const secret = process.env.META_APP_SECRET
  if (!secret || !process.env.META_WEBHOOK_VERIFY_TOKEN) return new NextResponse('closed', { status: 503 })
  const raw = await req.text()
  const sig = req.headers.get('x-hub-signature-256') || ''
  const want = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  if (!ok) return new NextResponse('bad signature', { status: 401 })
  let j: any
  try { j = JSON.parse(raw) } catch { return new NextResponse('bad json', { status: 400 }) }
  const db = socialDb()
  await db.from('social_webhook_events').insert([{ object: String(j?.object || '').slice(0, 40), signature_ok: true, raw: j }])

  try {
    const rows = await rowsOf(db, 'META')
    const items: any[] = []
    const iso = (t: any) => new Date(typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(String(t)) || Date.now()).toISOString()
    for (const e of j?.entry || []) {
      const conta = rows.find(r => r.external_id === String(e.id))
      if (!conta) continue
      const plataforma = conta.kind === 'IG_ACCOUNT' || j.object === 'instagram' ? 'INSTAGRAM' : 'FACEBOOK'
      // mensagens (Messenger e IG DMs)
      for (const m of e.messaging || []) {
        if (!m.message?.mid) continue
        const meu = !!m.message.is_echo
        items.push({
          platform: plataforma, kind: 'MESSAGE', external_id: String(m.message.mid), account_id: conta.id, thread_id: `t:${meu ? m.recipient?.id : m.sender?.id}`,
          folder: plataforma === 'INSTAGRAM' ? 'instagram' : 'inbox', from_id: String((meu ? m.recipient?.id : m.sender?.id) || ''), from_me: meu,
          body: m.message.text ? String(m.message.text).slice(0, 8000) : null, attachments: (m.message.attachments || []).length, happened_at: iso(m.timestamp), raw: m,
        })
      }
      // feed da página e comentários/menções do IG
      for (const c of e.changes || []) {
        const v = c.value || {}
        if (c.field === 'feed' && v.item === 'comment' && v.comment_id && v.verb !== 'remove') items.push({
          platform: 'FACEBOOK', kind: 'COMMENT', external_id: String(v.comment_id), account_id: conta.id, thread_id: v.post_id ? String(v.post_id) : null, parent_id: v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : null,
          from_id: v.from?.id ? String(v.from.id) : null, from_name: v.from?.name || null, from_me: String(v.from?.id || '') === conta.external_id, body: v.message ? String(v.message).slice(0, 8000) : null,
          permalink: v.post?.permalink_url || null, happened_at: iso(v.created_time), raw: v,
        })
        if (c.field === 'mention' && v.post_id) items.push({ platform: 'FACEBOOK', kind: 'MENTION', external_id: String(v.post_id), account_id: conta.id, thread_id: String(v.post_id), from_id: v.sender_id ? String(v.sender_id) : null, from_name: v.sender_name || null, body: v.message || null, happened_at: iso(v.created_time), raw: v })
        if (c.field === 'comments' && v.id) items.push({
          platform: 'INSTAGRAM', kind: 'COMMENT', external_id: String(v.id), account_id: conta.id, thread_id: v.media?.id ? String(v.media.id) : null, parent_id: v.parent_id ? String(v.parent_id) : null,
          from_id: v.from?.id ? String(v.from.id) : null, from_name: v.from?.username ? '@' + v.from.username : null, from_me: String(v.from?.id || '') === conta.external_id, body: v.text ? String(v.text).slice(0, 8000) : null, happened_at: iso(e.time), raw: v,
        })
        if (c.field === 'mentions' && v.media_id) items.push({ platform: 'INSTAGRAM', kind: 'MENTION', external_id: String(v.comment_id || v.media_id), account_id: conta.id, thread_id: String(v.media_id), happened_at: iso(e.time), raw: v })
      }
    }
    if (items.length) await saveItems(db, items, 'WEBHOOK')
  } catch (e) { console.error('[meta-webhook]', e) }
  return NextResponse.json({ ok: true })   // sempre 200 para evento assinado: a Meta reenvia em erro, e o cru já está guardado
}
