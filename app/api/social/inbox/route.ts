import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { requireStaff } from '@/lib/auth.server'
import { socialDb, rowsOf, platformOn } from '@/lib/social.server'
import { settingOn } from '@/lib/appSettings.server'
import { pollMeta, INBOX_SWITCH } from '@/lib/socialInbox.server'

// SOCIAL INBOX — a tela e as sessões leem daqui (13/11/2026).
// GET  ?platform=FACEBOOK|INSTAGRAM &kind=MESSAGE|COMMENT|MENTION|LEAD &folder= &new=1 &thread=<id> &q= &limit=
//      → { items, counts (novos por plataforma/tipo/pasta), accounts, switches }. Tela logada ou x-read-key.
// POST { action: 'seen', ids: [..] } | { action: 'seen_thread', thread } | { action: 'unseen', ids } → marca visto (humano logado).
// POST { action: 'refresh' } → roda a leitura agora (humano logado; precisa de social.meta.enabled).
// Nada aqui escreve em rede social: isso é /api/social/outbox.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const COLS = 'id, platform, kind, external_id, account_id, thread_id, thread_title, parent_id, folder, from_id, from_name, from_me, body, attachments, permalink, hidden, happened_at, first_seen_at, seen_at, gone_at'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sp = req.nextUrl.searchParams
  const db = socialDb()
  const limit = Math.min(Math.max(Number(sp.get('limit')) || 200, 1), 1000)
  let q = db.from('social_items').select(COLS).order('happened_at', { ascending: false }).limit(limit)
  const eq = (col: string, v: string | null, ok: RegExp) => { if (v && ok.test(v)) q = q.eq(col, v) }
  eq('platform', sp.get('platform'), /^(FACEBOOK|INSTAGRAM)$/)
  eq('kind', sp.get('kind'), /^(MESSAGE|COMMENT|MENTION|LEAD)$/)
  eq('folder', sp.get('folder'), /^[a-z_]{1,20}$/)
  eq('thread_id', sp.get('thread'), /^[A-Za-z0-9_.:=-]{1,200}$/)
  if (sp.get('new') === '1') q = q.is('seen_at', null).eq('from_me', false)
  const term = (sp.get('q') || '').replace(/[%,()]/g, ' ').trim().slice(0, 80)
  if (term) q = q.or(`body.ilike.%${term}%,from_name.ilike.%${term}%,thread_title.ilike.%${term}%`)
  const [{ data, error }, novos, rows] = await Promise.all([
    q,
    db.from('social_items').select('platform, kind, folder').is('seen_at', null).eq('from_me', false).is('gone_at', null).limit(5000),
    rowsOf(db, 'META'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const counts: Record<string, number> = { total: 0 }
  for (const n of novos.data || []) {
    counts.total++
    for (const k of [n.platform, n.kind, `${n.platform}:${n.kind}`, n.folder ? `folder:${n.folder}` : '']) if (k) counts[k] = (counts[k] || 0) + 1
  }
  return NextResponse.json({
    items: data || [], counts,
    accounts: rows.filter(r => r.kind !== 'META_USER').map(r => ({ id: r.id, kind: r.kind, account: r.account, status: r.status })),
    switches: { meta: await platformOn('META'), inbox: await settingOn(INBOX_SWITCH), publish: await settingOn('social.publish.enabled') },
  })
}

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const db = socialDb()
  if (b.action === 'refresh') {
    if (!(await platformOn('META'))) return NextResponse.json({ error: 'social.meta.enabled is OFF' }, { status: 403 })
    const r = await pollMeta(db)
    return NextResponse.json({ ok: r.errors.length === 0, ...r })
  }
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 2000) : []
  const agora = new Date().toISOString()
  if (b.action === 'seen' && ids.length) { const { error } = await db.from('social_items').update({ seen_at: agora, seen_by: staff.email }).in('id', ids).is('seen_at', null); return NextResponse.json({ ok: !error, error: error?.message }) }
  if (b.action === 'unseen' && ids.length) { const { error } = await db.from('social_items').update({ seen_at: null, seen_by: null }).in('id', ids).eq('from_me', false); return NextResponse.json({ ok: !error, error: error?.message }) }
  if (b.action === 'seen_thread' && typeof b.thread === 'string' && /^[A-Za-z0-9_.:=-]{1,200}$/.test(b.thread)) { const { error } = await db.from('social_items').update({ seen_at: agora, seen_by: staff.email }).eq('thread_id', b.thread).is('seen_at', null); return NextResponse.json({ ok: !error, error: error?.message }) }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
