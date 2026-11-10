// POST /api/viewer/join { token, password } — the invited person creates their own READ-ONLY account (10/11/2026).
// Public on purpose (the person has no account yet); the invite token is the key. The e-mail is the invite's — never the body's.
// Order matters: claim the invite (uses+1, conditional) → viewer row → auth user. There is no instant in which the account
// exists without its viewer row, so it never has full access. Anything wrong = 404, like the page.
import { NextRequest, NextResponse } from 'next/server'
import { liveInvite } from '@/lib/viewerInvite.server'
import { serviceDb } from '@/lib/viewer.server'

const nf = () => NextResponse.json({ error: 'not found' }, { status: 404 })

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || ''), password = String(body.password || '')
  const inv = await liveInvite(token)
  if (!inv) return nf()
  if (password.length < 10 || password.length > 72) return NextResponse.json({ error: 'The password needs 10 to 72 characters.' }, { status: 400 })
  const db = serviceDb()
  if (!db) return nf()

  // an e-mail that already has an account (staff or a viewer) is not created again here — and staff are never downgraded
  const { data: had } = await db.from('app_viewers').select('email').eq('email', inv.email).maybeSingle()
  if (had) return NextResponse.json({ error: 'This e-mail already has an account. Sign in at www.gz28us.com/ca.' }, { status: 409 })

  // claim the invite (single use, race-safe)
  const { data: claimed } = await db.from('app_viewer_invites').update({ uses: 1 }).eq('id', inv.id).eq('uses', 0).is('revoked_at', null).select('id')
  if (!claimed?.length) return nf()

  const { error: vErr } = await db.from('app_viewers').insert({ email: inv.email, label: inv.label, invite_id: inv.id })
  if (vErr) return NextResponse.json({ error: 'Could not create the account. Ask GZ28 for a new invite.' }, { status: 500 })

  const { data: u, error: uErr } = await db.auth.admin.createUser({ email: inv.email, password, email_confirm: true, app_metadata: { app_role: 'viewer' } })
  if (uErr || !u?.user) {
    // the e-mail is already a (staff) user, or Supabase refused: undo the viewer row so nobody is downgraded by accident
    await db.from('app_viewers').delete().eq('email', inv.email).eq('invite_id', inv.id)
    const exists = /already|registered|exists/i.test(uErr?.message || '')
    return NextResponse.json({ error: exists ? 'This e-mail already has an account. Sign in at www.gz28us.com/ca.' : 'Could not create the account. Ask GZ28 for a new invite.' }, { status: exists ? 409 : 500 })
  }
  await db.from('app_viewers').update({ user_id: u.user.id }).eq('email', inv.email)
  return NextResponse.json({ ok: true, email: inv.email })
}
