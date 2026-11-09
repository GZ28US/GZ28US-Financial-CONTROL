// SERVER-ONLY — SOCIAL LINK token sealing (09/11/2026).
// A social token is a key to the brand: a Page token can post on the Facebook page, a TikTok token can publish. So the row in
// `social_auth` never holds a usable token on its own: AES-256-GCM with SOCIAL_TOKEN_KEY (32 random bytes, base64), which lives only
// in Vercel env. Format 'v1:<iv b64>.<tag b64>.<ciphertext b64>'. No key → seal/open throw, and the routes answer 503 instead of
// writing a plain token "just this once".

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function key(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY || ''
  const k = Buffer.from(raw, 'base64')
  if (k.length !== 32) throw new Error('SOCIAL_TOKEN_KEY missing or not 32 bytes (base64)')
  return k
}

export function sealingReady(): boolean {
  try { key(); return true } catch { return false }
}

export function seal(plain: string | null | undefined): string | null {
  if (!plain) return null
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `v1:${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`
}

export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null
  const m = /^v1:([^.]+)\.([^.]+)\.(.+)$/.exec(sealed)
  if (!m) throw new Error('sealed token in an unknown format')
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(m[1], 'base64'))
  d.setAuthTag(Buffer.from(m[2], 'base64'))
  return Buffer.concat([d.update(Buffer.from(m[3], 'base64')), d.final()]).toString('utf8')
}
