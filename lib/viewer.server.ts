// APP VIEWER — the read-only user (10/11/2026, Márcio: Drummond Advisors, fechamento contábil 2025).
// «entra em absolutamente todas as telas, inclusive nas de edição, mas não consegue editar nada».
// The database refuses a viewer's writes by itself (MIGRATION_app_viewer_readonly.sql: restrictive policies on every table
// + storage). This file is the API side: lib/auth.server requireUser / requireStaff ask `viewerGate` and refuse
//   · a BLOCKED viewer on every route;
//   · a viewer on every non-GET (POST/PUT/PATCH/DELETE = something changes or something goes out of the house);
//   · a viewer even on GET for routes that call paid / outside services (Plaid, carriers, PayPal, social, WhatsApp webhook).
// Unknown table (migration not run yet) = nobody is a viewer — there are no viewer accounts without the table.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let admin: SupabaseClient | null = null
export function serviceDb(): SupabaseClient | null {
  if (admin) return admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  admin = createClient(url, key, { auth: { persistSession: false } })
  return admin
}

export type ViewerRole = 'viewer' | 'blocked' | null

export async function viewerRole(email: string): Promise<ViewerRole> {
  const db = serviceDb()
  const e = String(email || '').trim().toLowerCase()
  if (!db || !e) return null
  const { data, error } = await db.from('app_viewers').select('blocked_at').eq('email', e).maybeSingle()
  if (error) {
    // table not created yet → there are no viewers. Any OTHER failure fails CLOSED (read-only), never open.
    const missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message || '')
    return missing ? null : 'viewer'
  }
  if (!data) return null
  return data.blocked_at ? 'blocked' : 'viewer'
}

// GET routes a viewer cannot call either: they spend on (or talk to) outside services
const VIEWER_DENY_GET = ['/api/plaid/', '/api/integrations/', '/api/social/', '/api/whatsapp/webhook', '/api/adm/viewers']

export function viewerMayCall(method: string, pathname: string): boolean {
  const m = String(method || 'GET').toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  const p = String(pathname || '').replace(/^\/ca(?=\/)/, '')
  return !VIEWER_DENY_GET.some(d => p.startsWith(d))
}

/** true = this caller may go on. Staff (no viewer row) always may. */
export async function viewerGate(email: string, method: string, pathname: string): Promise<boolean> {
  const role = await viewerRole(email)
  if (!role) return true
  if (role === 'blocked') return false
  return viewerMayCall(method, pathname)
}
