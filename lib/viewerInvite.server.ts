// VIEWER INVITES (10/11/2026, Márcio: «só pra quem mandamos o link»). One invite per person, tied to the e-mail we invited,
// single use, 7 days. The raw token lives only in the link; the table keeps its sha256. Bad / used / expired / revoked = 404.
import { createHash, randomBytes } from 'crypto'
import { serviceDb } from './viewer.server'

export const APP_URL = 'https://www.gz28us.com/ca'
export const hashToken = (t: string) => createHash('sha256').update(String(t || '')).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')

export type LiveInvite = { id: string; email: string; label: string; expires_at: string }

/** the invite this token opens, or null (→ 404). Never says WHY. */
export async function liveInvite(token: string): Promise<LiveInvite | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''))) return null
  const db = serviceDb()
  if (!db) return null
  const { data, error } = await db.from('app_viewer_invites').select('id, email, label, expires_at, uses, max_uses, revoked_at')
    .eq('token_hash', hashToken(token)).maybeSingle()
  if (error || !data) return null
  if (data.revoked_at || data.uses >= data.max_uses || new Date(data.expires_at).getTime() <= Date.now()) return null
  return { id: data.id, email: data.email, label: data.label, expires_at: data.expires_at }
}
