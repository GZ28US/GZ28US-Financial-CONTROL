// SERVER-ONLY — SOCIAL LINK core (09/11/2026). Márcio, 08/11: «i want to link deeply all the apps we need to link, all of them, I want
// Claude and the app to have deep access to them all» — YouTube, Instagram, Facebook, TikTok, Meta Business Suite.
//
// Same idea as the mailboxes (stream_mail_auth + /stream/connect): a logged-in human starts the OAuth at /ca/social/connect, the
// platform calls back here, the token goes straight into `social_auth` — never through a chat, a file, a screenshot or argv.
// Differences from the mail flow: tokens are SEALED (lib/socialCrypto.server.ts), the state is single-use in its own table, and each
// platform hides behind its own switch (social.<platform>.enabled, born OFF). Writes (post, reply, DM) are a separate switch,
// social.publish.enabled — and even ON, a write only happens on Márcio's order.
//
// Token lifetimes, and what keeps them alive:
//   META    user token: 60 days (long-lived). PAGE token derived from it: does not expire (dies only on password change / revoke /
//           role removed). Instagram Business is read through its page's token. → the daily cron only checks health (debug_token).
//   YOUTUBE access 1 h; refresh token long-lived (dies after 6 months unused, on revoke, or after 7 days if the Google consent screen
//           is still in "Testing"). → refreshed on demand + daily touch.
//   TIKTOK  access 24 h; refresh 365 days and ROTATES (each refresh may return a new one — always store it). → on demand + daily.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'node:crypto'
import { seal, unseal } from './socialCrypto.server'
import { settingOn } from './appSettings.server'

export type Platform = 'META' | 'YOUTUBE' | 'TIKTOK'
export type Kind = 'META_USER' | 'FB_PAGE' | 'IG_ACCOUNT' | 'YT_CHANNEL' | 'TT_ACCOUNT'

export const SWITCH: Record<Platform, string> = {
  META: 'social.meta.enabled',
  YOUTUBE: 'social.youtube.enabled',
  TIKTOK: 'social.tiktok.enabled',
}
export const PUBLISH_SWITCH = 'social.publish.enabled'

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

// What each connection asks for. Read + the write scopes Márcio wants available for when HE orders a post — asking now avoids a
// second consent later; the publish switch is what keeps writes off.
export const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_metadata', 'pages_manage_posts',
  'pages_manage_engagement', 'pages_messaging', 'read_insights', 'business_management',
  'instagram_basic', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_manage_messages', 'instagram_content_publish',
]
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',          // read + reply/moderate comments
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
]
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list', 'video.upload', 'video.publish']

export function socialDb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export async function platformOn(p: Platform): Promise<boolean> { return settingOn(SWITCH[p]) }

export function callbackUrl(origin: string, p: Platform): string {
  // Behind the www.gz28us.com proxy the request origin is the public one; SOCIAL_PUBLIC_ORIGIN pins it if it ever is not.
  const base = process.env.SOCIAL_PUBLIC_ORIGIN || origin
  return `${base}/ca/api/social/${p.toLowerCase()}/callback`
}

// ── OAuth state: random, single use, 30 minutes ─────────────────────────────
export async function mintState(db: SupabaseClient, p: Platform, by: string, withPkce = false): Promise<{ state: string; challenge?: string }> {
  const state = randomBytes(24).toString('base64url')
  const verifier = withPkce ? randomBytes(48).toString('base64url') : null
  const { error } = await db.from('social_oauth_states').insert({ state, platform: p, pkce_verifier: verifier, created_by: by })
  if (error) throw new Error(`state: ${error.message}`)
  await db.from('social_oauth_states').delete().lt('expires_at', new Date().toISOString())
  return { state, challenge: verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined }
}

export async function takeState(db: SupabaseClient, p: Platform, state: string | null): Promise<{ by: string | null; verifier: string | null } | null> {
  if (!state) return null
  const { data } = await db.from('social_oauth_states').delete().eq('state', state).eq('platform', p).select('created_by, pkce_verifier, expires_at')
  const row = data?.[0]
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null
  return { by: row.created_by, verifier: row.pkce_verifier }
}

// ── the token rows ──────────────────────────────────────────────────────────
export type SocialRow = {
  id: number; platform: Platform; kind: Kind; external_id: string; account: string | null
  access_token_enc: string | null; refresh_token_enc: string | null
  access_expires_at: string | null; refresh_expires_at: string | null
  scopes: string[]; parent_id: number | null; meta: Record<string, unknown>
  status: string; last_error: string | null; last_ok_at: string | null; last_refresh_at: string | null
  connected_by: string | null; updated_at: string
}

const inSecs = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(Date.now() + s * 1000).toISOString() : null)

export async function upsertRow(db: SupabaseClient, r: {
  platform: Platform; kind: Kind; external_id: string; account?: string | null
  access_token?: string | null; refresh_token?: string | null; access_expires_in?: number | null; refresh_expires_in?: number | null
  access_expires_at?: string | null
  scopes?: string[]; parent_id?: number | null; meta?: Record<string, unknown>; connected_by?: string | null
}): Promise<number> {
  const row: Record<string, unknown> = {
    platform: r.platform, kind: r.kind, external_id: r.external_id, account: r.account ?? null,
    access_token_enc: seal(r.access_token), status: 'CONNECTED', last_error: null, last_ok_at: new Date().toISOString(),
    access_expires_at: r.access_expires_at !== undefined ? r.access_expires_at : inSecs(r.access_expires_in),
    updated_at: new Date().toISOString(),
  }
  // A reconnect that did not bring a refresh token (Google does that on a second consent without prompt) keeps the one we have.
  if (r.refresh_token) { row.refresh_token_enc = seal(r.refresh_token); row.refresh_expires_at = inSecs(r.refresh_expires_in) }
  if (r.scopes) row.scopes = r.scopes
  if (r.parent_id !== undefined) row.parent_id = r.parent_id
  if (r.meta) row.meta = r.meta
  if (r.connected_by) row.connected_by = r.connected_by
  const { data, error } = await db.from('social_auth').upsert(row, { onConflict: 'platform,kind,external_id' }).select('id').single()
  if (error) throw new Error(`social_auth: ${error.message}`)
  return data.id as number
}

export async function rowsOf(db: SupabaseClient, p?: Platform): Promise<SocialRow[]> {
  let q = db.from('social_auth').select('*').order('id')
  if (p) q = q.eq('platform', p)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data || []) as SocialRow[]
}

async function mark(db: SupabaseClient, id: number, patch: Record<string, unknown>) {
  await db.from('social_auth').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
}

// The public view of a row: everything except the tokens.
export function publicRow(r: SocialRow) {
  const { access_token_enc, refresh_token_enc, ...rest } = r
  return { ...rest, has_access_token: !!access_token_enc, has_refresh_token: !!refresh_token_enc }
}

// ── refresh ─────────────────────────────────────────────────────────────────
const SKEW_MS = 5 * 60 * 1000

async function refreshGoogle(rt: string) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', refresh_token: rt, grant_type: 'refresh_token' }),
  })
  return r.json()
}

async function refreshTiktok(rt: string) {
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || '', client_secret: process.env.TIKTOK_CLIENT_SECRET || '', refresh_token: rt, grant_type: 'refresh_token' }),
  })
  return r.json()
}

// A usable access token for the row, refreshed when it is about to die (or when `force`). Errors are written on the row and thrown.
export async function accessToken(db: SupabaseClient, row: SocialRow, force = false): Promise<string> {
  if (row.kind === 'IG_ACCOUNT') {
    // Instagram Business speaks through its Facebook page's token.
    if (!row.parent_id) throw new Error(`IG ${row.account}: no parent page`)
    const { data } = await db.from('social_auth').select('*').eq('id', row.parent_id).single()
    if (!data) throw new Error(`IG ${row.account}: parent page row missing`)
    return accessToken(db, data as SocialRow, force)
  }
  const fresh = row.access_expires_at === null || new Date(row.access_expires_at).getTime() - Date.now() > SKEW_MS
  const current = unseal(row.access_token_enc)
  if (current && fresh && !force) return current
  if (row.platform === 'META') {
    if (current) return current      // Meta page/user tokens are not refreshable by API; the health check reports their death.
    throw new Error(`${row.kind} ${row.account}: no token — reconnect at /ca/social/connect`)
  }
  const rt = unseal(row.refresh_token_enc)
  if (!rt) { await mark(db, row.id, { status: 'EXPIRED', last_error: 'no refresh token' }); throw new Error(`${row.account}: no refresh token — reconnect`) }
  const j = row.platform === 'YOUTUBE' ? await refreshGoogle(rt) : await refreshTiktok(rt)
  if (!j?.access_token) {
    const why = String(j?.error_description || j?.error?.message || j?.error || j?.message || 'refresh failed')
    const dead = /invalid_grant|expired|revoked/i.test(why)
    await mark(db, row.id, { status: dead ? 'EXPIRED' : 'ERROR', last_error: why.slice(0, 500) })
    throw new Error(`${row.platform} ${row.account}: ${why}`)
  }
  const patch: Record<string, unknown> = {
    access_token_enc: seal(j.access_token), access_expires_at: inSecs(j.expires_in),
    status: 'CONNECTED', last_error: null, last_refresh_at: new Date().toISOString(), last_ok_at: new Date().toISOString(),
  }
  if (j.refresh_token && j.refresh_token !== rt) { patch.refresh_token_enc = seal(j.refresh_token); patch.refresh_expires_at = inSecs(j.refresh_expires_in) }
  await mark(db, row.id, patch)
  return j.access_token as string
}

// Meta: is the token alive, and with which scopes? (debug_token with the app token — server to Meta only.)
export async function metaDebug(token: string): Promise<{ valid: boolean; scopes: string[]; expires_at: number | null; error?: string }> {
  const app = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
  const u = new URL(`${GRAPH}/debug_token`)
  u.searchParams.set('input_token', token)
  u.searchParams.set('access_token', app)
  const j = await (await fetch(u)).json().catch(() => null)
  const d = j?.data
  if (!d) return { valid: false, scopes: [], expires_at: null, error: j?.error?.message || 'debug_token failed' }
  return { valid: !!d.is_valid, scopes: d.scopes || [], expires_at: d.expires_at ? d.expires_at : null, error: d.error?.message }
}

// Daily: touch every row, refresh what refreshes, report what died. Only platforms whose switch is ON.
export async function healthPass(db: SupabaseClient): Promise<{ id: number; platform: Platform; kind: Kind; account: string | null; ok: boolean; note: string }[]> {
  const out: { id: number; platform: Platform; kind: Kind; account: string | null; ok: boolean; note: string }[] = []
  for (const row of await rowsOf(db)) {
    if (!(await platformOn(row.platform))) { out.push({ id: row.id, platform: row.platform, kind: row.kind, account: row.account, ok: true, note: 'switch OFF — skipped' }); continue }
    try {
      if (row.platform === 'META') {
        if (row.kind === 'IG_ACCOUNT') { out.push({ id: row.id, platform: row.platform, kind: row.kind, account: row.account, ok: true, note: 'uses its page token' }); continue }
        const d = await metaDebug(await accessToken(db, row))
        await mark(db, row.id, d.valid ? { status: 'CONNECTED', last_error: null, last_ok_at: new Date().toISOString(), scopes: d.scopes } : { status: 'EXPIRED', last_error: d.error || 'token invalid' })
        out.push({ id: row.id, platform: row.platform, kind: row.kind, account: row.account, ok: d.valid, note: d.valid ? (d.expires_at ? `valid, expires ${new Date(d.expires_at * 1000).toISOString()}` : 'valid, never expires') : (d.error || 'invalid') })
      } else {
        await accessToken(db, row, true)
        out.push({ id: row.id, platform: row.platform, kind: row.kind, account: row.account, ok: true, note: 'refreshed' })
      }
    } catch (e) {
      out.push({ id: row.id, platform: row.platform, kind: row.kind, account: row.account, ok: false, note: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

// ── the HTML page every callback answers with (escaped: `error` comes from the URL) ──
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
export function resultPage(title: string, body: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title>
     <body style="background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
     <div style="text-align:center;max-width:720px"><p style="font-size:64px;margin:0">${ok ? '✅' : '❌'}</p>
     <h1>${esc(title)}</h1><p style="color:#9ca3af;font-size:18px;white-space:pre-wrap">${esc(body)}</p>
     <p><a style="color:#60a5fa" href="/ca/social/connect">Back to SOCIAL CONNECT</a></p></div>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}
