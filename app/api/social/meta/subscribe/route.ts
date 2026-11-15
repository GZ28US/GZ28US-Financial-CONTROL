import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { socialDb, rowsOf, accessToken, platformOn, GRAPH, metaWebhookVerifyToken } from '@/lib/social.server'

// INSCRIÇÃO NO WEBHOOK DA META (14/11/2026, Márcio: «I need it as connected as they can be»).
// A lista de conversas do Instagram da conta de 78,7k é recusada pela Meta («Please reduce the amount of data»), então a mensagem
// tem de CHEGAR empurrada. Isto pede à Meta, de servidor para servidor, que entregue os eventos em /api/social/meta/webhook:
//   1. o APP assina os objetos `instagram` (messages, comments, mentions…) e `page` (messages, feed, mention) — com o token do app;
//   2. cada PÁGINA conectada instala o app (subscribed_apps) — com o token da página. O Instagram ligado à página vem junto.
// Nenhum segredo passa por tela, chat ou arquivo: o token de verificação é o de metaWebhookVerifyToken().
//   GET  = o que está inscrito hoje.      POST = inscreve (pode repetir: é idempotente).
// Não envia mensagem a ninguém; só muda para onde a Meta entrega os NOSSOS eventos.
// LIMITE conhecido: com o app em modo Development a Meta só entrega evento causado por quem tem papel no app.
export const dynamic = 'force-dynamic'
export const maxDuration = 60
/* eslint-disable @typescript-eslint/no-explicit-any */

const IG_FIELDS = ['messages', 'messaging_postbacks', 'messaging_seen', 'message_reactions', 'comments', 'live_comments', 'mentions']
const PAGE_FIELDS = ['messages', 'messaging_postbacks', 'message_reactions', 'feed', 'mention']
const PAGE_APP_FIELDS = ['messages', 'messaging_postbacks', 'message_reactions', 'feed', 'mention']

const call = async (method: 'GET' | 'POST', path: string, q: Record<string, string>) => {
  const u = new URL(`${GRAPH}/${path}`)
  const init: RequestInit = { method, signal: AbortSignal.timeout(25000) }
  if (method === 'GET') for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  else init.body = new URLSearchParams(q)
  try {
    const r = await fetch(u, init)
    const j: any = await r.json().catch(() => ({}))
    return { ok: r.ok && !j?.error, data: j?.error ? undefined : j, error: j?.error ? String(j.error.message || '').slice(0, 300) : r.ok ? undefined : `HTTP ${r.status}` }
  } catch (e) { return { ok: false, data: undefined, error: (e as Error)?.name || 'error' } }
}

export async function GET(req: NextRequest) { return run(req, false) }
export async function POST(req: NextRequest) { return run(req, true) }

async function run(req: NextRequest, write: boolean) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await platformOn('META'))) return NextResponse.json({ error: 'social.meta.enabled is OFF' }, { status: 403 })
  const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET, verify = metaWebhookVerifyToken()
  if (!appId || !secret || !verify) return NextResponse.json({ error: 'META_APP_ID / META_APP_SECRET not configured' }, { status: 503 })
  const appToken = `${appId}|${secret}`
  const callback = `${process.env.SOCIAL_PUBLIC_ORIGIN || req.nextUrl.origin}/ca/api/social/meta/webhook`
  const out: any = { callback, app: {}, pages: [] }

  if (write) {
    out.app.instagram = await call('POST', `${appId}/subscriptions`, { object: 'instagram', callback_url: callback, fields: IG_FIELDS.join(','), verify_token: verify, access_token: appToken })
    out.app.page = await call('POST', `${appId}/subscriptions`, { object: 'page', callback_url: callback, fields: PAGE_FIELDS.join(','), verify_token: verify, access_token: appToken })
  }
  const subs = await call('GET', `${appId}/subscriptions`, { access_token: appToken })
  out.app.now = subs.ok ? (subs.data?.data || []).map((s: any) => ({ object: s.object, active: s.active, callback_url: s.callback_url, fields: (s.fields || []).map((f: any) => f.name) })) : { error: subs.error }

  const db = socialDb()
  const rows = await rowsOf(db, 'META')
  for (const page of rows.filter(r => r.kind === 'FB_PAGE' && r.status === 'CONNECTED')) {
    const p: any = { page: page.account, id: page.external_id, instagram: rows.filter(r => r.kind === 'IG_ACCOUNT' && r.parent_id === page.id && r.status === 'CONNECTED').map(r => r.account) }
    let token: string
    try { token = await accessToken(db, page) } catch (e) { p.error = String((e as Error)?.message || e); out.pages.push(p); continue }
    if (write) p.subscribe = await call('POST', `${page.external_id}/subscribed_apps`, { subscribed_fields: PAGE_APP_FIELDS.join(','), access_token: token })
    const now = await call('GET', `${page.external_id}/subscribed_apps`, { access_token: token })
    p.now = now.ok ? (now.data?.data || []).map((a: any) => ({ app: a.name, id: a.id, fields: a.subscribed_fields })) : { error: now.error }
    out.pages.push(p)
  }
  return NextResponse.json({ ok: true, wrote: write, ...out })
}
