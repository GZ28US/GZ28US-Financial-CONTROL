// SERVER-ONLY — exige sessão Supabase válida (JWT do usuário logado no /ca).
// As rotas que leem/escrevem as tabelas do banco (só-service-key) não podem
// ficar abertas: sem isto, qualquer um que achasse a URL levava o extrato
// inteiro e disparava sync cobrado no Plaid (achado da revisão de 21/ago).
import { createClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import { viewerGate } from './viewer.server'

export async function requireUser(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false
  try {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const { data, error } = await anon.auth.getUser(token)
    if (error || !data.user) return false
    // VIEWER (10/11/2026): read-only account — no non-GET, no paid/outside-service GET, nothing when blocked
    return await viewerGate(String(data.user.email || ''), req.method, req.nextUrl?.pathname || '')
  } catch { return false }
}

// STAFF (06/11/2026, quote portal — security R2-05): a HUMAN logged into /ca. Same JWT check as requireUser, plus the user's
// e-mail, and MACHINE accounts refused (the BR bridge logs in with a real JWT but is a robot). Env MACHINE_ACCOUNTS (comma list)
// adds to the built-in list. Every /api/doc/[id]/* route uses this and records the returned e-mail as the actor — never a body field.
const MACHINE_DEFAULT = ['br-bridge@gz28us.com']
export function machineAccounts(): string[] {
  const env = String(process.env.MACHINE_ACCOUNTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return [...new Set([...MACHINE_DEFAULT, ...env])]
}
export async function requireStaff(req: NextRequest): Promise<{ email: string } | null> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null
  try {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const { data, error } = await anon.auth.getUser(token)
    const email = String(data?.user?.email || '').toLowerCase()
    if (error || !email) return null
    if (machineAccounts().includes(email)) return null
    if (!(await viewerGate(email, req.method, req.nextUrl?.pathname || ''))) return null
    return { email }
  } catch { return null }
}
