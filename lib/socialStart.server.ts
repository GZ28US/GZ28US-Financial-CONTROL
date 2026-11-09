// SERVER-ONLY — the common gate of every SOCIAL LINK start route (09/11/2026): POST only, a HUMAN logged into /ca (requireStaff —
// robots refused), the platform switch ON, the app keys present, the sealing key present. Any miss → JSON error, nothing minted.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from './auth.server'
import { platformOn, SWITCH, type Platform } from './social.server'
import { sealingReady } from './socialCrypto.server'

export async function startGate(req: NextRequest, p: Platform, envs: string[]): Promise<{ by: string } | NextResponse> {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await platformOn(p))) return NextResponse.json({ error: `${SWITCH[p]} is OFF — Márcio turns it on at /ca/social/connect` }, { status: 403 })
  const missing = envs.filter(e => !process.env[e])
  if (missing.length) return NextResponse.json({ error: `not configured in Vercel: ${missing.join(', ')}` }, { status: 503 })
  if (!sealingReady()) return NextResponse.json({ error: 'SOCIAL_TOKEN_KEY not configured in Vercel' }, { status: 503 })
  return { by: staff.email }
}
