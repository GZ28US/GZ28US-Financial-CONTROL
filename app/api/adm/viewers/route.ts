// /api/adm/viewers — the READ-ONLY accounts and their invites (10/11/2026). Staff only (requireStaff; a viewer is refused here
// even on GET — lib/viewer.server VIEWER_DENY_GET).
//   GET                                    → { viewers, invites }
//   POST { action:'invite', email, label } → { link } — the raw token appears ONCE, in this answer; the table keeps its sha256
//   POST { action:'revoke-invite', id }    → an invite not used yet stops opening (404)
//   POST { action:'block', email }         → the account stops reading anything and cannot sign in (Supabase ban)
//   POST { action:'unblock', email }
// Nothing here sends anything: the link goes to Márcio on screen; the e-mail to the accountant is a separate, approved draft.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/viewer.server'
import { APP_URL, hashToken, newToken } from '@/lib/viewerInvite.server'

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

async function userIdOf(db: NonNullable<ReturnType<typeof serviceDb>>, email: string): Promise<string | null> {
  const { data: v } = await db.from('app_viewers').select('user_id').eq('email', email).maybeSingle()
  if (v?.user_id) return v.user_id
  for (let page = 1; page <= 20; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 })
    const hit = data?.users?.find(u => String(u.email || '').toLowerCase() === email)
    if (hit) return hit.id
    if (!data?.users?.length || data.users.length < 200) break
  }
  return null
}

export async function GET(req: NextRequest) {
  if (!(await requireStaff(req))) return bad('unauthorized', 401)
  const db = serviceDb()
  if (!db) return bad('SUPABASE_SERVICE_ROLE_KEY missing', 500)
  const [v, i] = await Promise.all([
    db.from('app_viewers').select('email, label, created_at, blocked_at, user_id').order('created_at', { ascending: false }),
    db.from('app_viewer_invites').select('id, email, label, uses, max_uses, expires_at, revoked_at, created_at').order('created_at', { ascending: false }).limit(100),
  ])
  if (v.error || i.error) return bad((v.error || i.error)!.message, 500)
  return NextResponse.json({ viewers: v.data, invites: i.data, app_url: APP_URL })
}

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return bad('unauthorized', 401)
  const db = serviceDb()
  if (!db) return bad('SUPABASE_SERVICE_ROLE_KEY missing', 500)
  const b = await req.json().catch(() => ({}))
  const email = String(b.email || '').trim().toLowerCase()

  if (b.action === 'invite') {
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return bad('e-mail?')
    if (email === staff.email) return bad('that is your own e-mail')
    const id = await userIdOf(db, email)
    if (id) return bad('this e-mail already has an account in the app')
    const token = newToken()
    const { error } = await db.from('app_viewer_invites').insert({ token_hash: hashToken(token), email, label: String(b.label || email).slice(0, 80) })
    if (error) return bad(error.message, 500)
    return NextResponse.json({ ok: true, link: `${APP_URL}/join/${token}`, login: APP_URL })
  }
  if (b.action === 'revoke-invite') {
    const { error } = await db.from('app_viewer_invites').update({ revoked_at: new Date().toISOString() }).eq('id', String(b.id || '')).is('revoked_at', null)
    return error ? bad(error.message, 500) : NextResponse.json({ ok: true })
  }
  if (b.action === 'block' || b.action === 'unblock') {
    const { data: row } = await db.from('app_viewers').select('email').eq('email', email).maybeSingle()
    if (!row) return bad('not a view-only account', 404)   // staff accounts are never blocked from here
    const block = b.action === 'block'
    const { error } = await db.from('app_viewers').update({ blocked_at: block ? new Date().toISOString() : null }).eq('email', email)
    if (error) return bad(error.message, 500)
    const id = await userIdOf(db, email)
    if (id) await db.auth.admin.updateUserById(id, { ban_duration: block ? '876000h' : 'none' })
    return NextResponse.json({ ok: true })
  }
  return bad('action?')
}
