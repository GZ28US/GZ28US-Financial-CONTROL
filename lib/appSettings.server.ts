// SERVER-ONLY — the switches Márcio flips (06/11/2026). Table `app_settings` (key text, value jsonb).
//
// Every new client-facing surface and every NEW automatic notification is born OFF behind a key here (law of 06/11/2026:
// «don't send anything to anyone, you can never, in any occasion, do that without my approval»). Code asks
// `settingOn('notify.client.quote_sent')` and gets `false` until the row says `true`. A missing row is OFF — never a default
// that sends. Reads go through the service key (RLS keeps anon out); a 30-second in-memory cache per lambda keeps the
// webhook and the public page from hammering the table.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const SETTINGS = {
  QUOTE_PORTAL: 'quote_portal.enabled',
} as const

function db(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

const TTL_MS = 30 * 1000
const cache = new Map<string, { at: number; value: unknown }>()

export async function readSetting<T = unknown>(key: string): Promise<T | undefined> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T | undefined
  const d = db()
  if (!d) return undefined
  const { data, error } = await d.from('app_settings').select('value').eq('key', key).maybeSingle()
  if (error) { console.error('[app_settings] read', key, error.message); return undefined }
  const value = data ? (data.value as T) : undefined
  cache.set(key, { at: Date.now(), value })
  return value
}

// OFF unless the row is exactly `true`.
export async function settingOn(key: string): Promise<boolean> {
  return (await readSetting<unknown>(key)) === true
}

export async function writeSetting(key: string, value: unknown, by: string, note?: string): Promise<string | null> {
  const d = db()
  if (!d) return 'SUPABASE_SERVICE_ROLE_KEY missing'
  const row: Record<string, unknown> = { key, value, updated_at: new Date().toISOString(), updated_by: by }
  if (note !== undefined) row.note = note
  const { error } = await d.from('app_settings').upsert(row, { onConflict: 'key' })
  cache.delete(key)
  return error ? error.message : null
}

export function forgetSettingsCache() { cache.clear() }
