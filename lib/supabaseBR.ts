import { createClient } from '@supabase/supabase-js'

// GZ28BR project client (cross-project writes from the US app: the suppliers
// mirror, the PAID mirror and the common-ride rename — see lib/suppliersMirror,
// lib/brPaidMirror and rides/edit). The value below is BR's PUBLISHABLE anon
// key (safe in browser code, like any NEXT_PUBLIC_* var); overridable via env.
const BR_URL = process.env.NEXT_PUBLIC_SUPABASE_BR_URL || 'https://saaowriaptbvfoqoykrh.supabase.co'
const BR_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_BR_ANON_KEY || 'sb_publishable_Y35Mic14DUJODqz_LG6LxA_3kWXuUMz'

export const supabaseBR = createClient(BR_URL, BR_ANON_KEY)

// The BR tables are behind RLS (BR Phase 1), so supabaseBR must act as an
// authenticated user, not bare anon. This mints a BR "bridge" session (server
// route /api/br-bridge, authorized by the current US admin's token) and attaches
// it. Idempotent: if a BR session is already present (persisted + auto-refreshed)
// it returns immediately, so only the first login per browser hits the route.
// Best-effort — returns false on failure so callers can still render.
// Mirror of BR's ensureUSBridgeSession (lib/supabaseUS.ts in the BR repo).
let bridgePromise: Promise<boolean> | null = null
export function ensureBRBridgeSession(): Promise<boolean> {
  if (bridgePromise) return bridgePromise
  bridgePromise = (async () => {
    try {
      const { data: existing } = await supabaseBR.auth.getSession()
      if (existing.session) return true
      const { supabase } = await import('@/lib/supabase')
      const { BASE_PATH } = await import('@/lib/utils')
      const { data: usSess } = await supabase.auth.getSession()
      const usToken = usSess.session?.access_token
      if (!usToken) return false
      const res = await fetch(`${BASE_PATH}/api/br-bridge`, {
        method: 'POST', headers: { Authorization: `Bearer ${usToken}` },
      })
      if (!res.ok) return false
      const { access_token, refresh_token } = await res.json()
      const { error } = await supabaseBR.auth.setSession({ access_token, refresh_token })
      return !error
    } catch {
      return false
    } finally {
      bridgePromise = null // allow a fresh attempt next time if this one failed
    }
  })()
  return bridgePromise
}

// Drop the BR bridge session (call when the US admin signs out).
export async function clearBRBridgeSession(): Promise<void> {
  try { await supabaseBR.auth.signOut() } catch { /* ignore */ }
}
