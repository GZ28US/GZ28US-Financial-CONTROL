import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { requireStaff } from '@/lib/auth.server'
import { readSetting, writeSetting } from '@/lib/appSettings.server'
import { socialDb, rowsOf, publicRow, healthPass, SWITCH, PUBLISH_SWITCH, type Platform } from '@/lib/social.server'
import { sealingReady } from '@/lib/socialCrypto.server'

// SOCIAL LINK — status (09/11/2026). GET: the switches, which app keys exist in Vercel (yes/no only), and the connected accounts
// WITHOUT tokens. POST { key, value }: a logged-in HUMAN flips one of the four social switches (written with his e-mail).
// POST { check: true }: run the health pass now (same as the daily cron). Never returns a token.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const KEYS = [...Object.values(SWITCH), PUBLISH_SWITCH, 'social.inbox.enabled', 'social.meta.leads.enabled', 'paypal.read.enabled', 'carriers.track.enabled']
const ENVS: Record<Platform | 'APP_CREDS', string[]> = {
  META: ['META_APP_ID', 'META_APP_SECRET'],
  YOUTUBE: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  TIKTOK: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  GOOGLE: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN'],
  EBAY: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'],
  APP_CREDS: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'UPS_CLIENT_ID', 'UPS_CLIENT_SECRET', 'FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'USPS_CLIENT_ID', 'USPS_CLIENT_SECRET'],
}

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const switches: Record<string, boolean> = {}
  for (const k of KEYS) switches[k] = (await readSetting(k)) === true
  const env: Record<string, boolean> = { SOCIAL_TOKEN_KEY: sealingReady() }
  for (const list of Object.values(ENVS)) for (const e of list) env[e] = !!process.env[e]
  const rows = await rowsOf(socialDb())
  return NextResponse.json({ switches, env, accounts: rows.map(publicRow) })
}

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  if (b?.check === true) return NextResponse.json({ results: await healthPass(socialDb()) })
  const key = String(b?.key || '')
  if (!KEYS.includes(key) || typeof b?.value !== 'boolean') return NextResponse.json({ error: 'key must be a social switch, value true|false' }, { status: 400 })
  const err = await writeSetting(key, b.value, staff.email)
  if (err) return NextResponse.json({ error: err }, { status: 500 })
  return NextResponse.json({ ok: true, key, value: b.value })
}
