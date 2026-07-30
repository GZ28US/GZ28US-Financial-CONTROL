import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// BR BRIDGE — mints a short-lived BR-project session for a signed-in US admin.
// Mirror of the BR app's /api/us-bridge. The BR tables the US app writes
// cross-project (suppliers mirror, PAID mirror, common-ride rename) are behind
// RLS after BR Phase 1 (supabase/rls_phase1_br.sql in the BR repo), so the
// `supabaseBR` client can no longer write them with the public anon key. This
// route signs in as a dedicated BR "bridge" auth account SERVER-SIDE — its
// credentials live only in server env, never in the browser bundle — and hands
// the session back so the US client can attach it to supabaseBR. Gated: the
// caller must present a valid US user token, so only signed-in US admins can
// obtain it.

export const dynamic = 'force-dynamic'

const US_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const US_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BR_URL = process.env.NEXT_PUBLIC_SUPABASE_BR_URL || 'https://saaowriaptbvfoqoykrh.supabase.co'
const BR_ANON = process.env.NEXT_PUBLIC_SUPABASE_BR_ANON_KEY || 'sb_publishable_Y35Mic14DUJODqz_LG6LxA_3kWXuUMz'
const BRIDGE_EMAIL = process.env.BR_BRIDGE_EMAIL
const BRIDGE_PASSWORD = process.env.BR_BRIDGE_PASSWORD

export async function POST(req: Request) {
  if (!BRIDGE_EMAIL || !BRIDGE_PASSWORD) {
    return NextResponse.json({ error: 'BR bridge not configured' }, { status: 503 })
  }
  // 1) Caller must be a signed-in US user.
  const auth = req.headers.get('authorization') || ''
  const usToken = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!usToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const us = createClient(US_URL, US_ANON, { auth: { persistSession: false } })
  const { data: u, error: ue } = await us.auth.getUser(usToken)
  if (ue || !u?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 2) Sign in to the BR project as the bridge account (server-side only).
  const br = createClient(BR_URL, BR_ANON, { auth: { persistSession: false } })
  const { data, error } = await br.auth.signInWithPassword({ email: BRIDGE_EMAIL, password: BRIDGE_PASSWORD })
  if (error || !data?.session) {
    return NextResponse.json({ error: 'Bridge sign-in failed' }, { status: 500 })
  }
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
}
