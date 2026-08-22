// SERVER-ONLY — exige sessão Supabase válida (JWT do usuário logado no /ca).
// As rotas que leem/escrevem as tabelas do banco (só-service-key) não podem
// ficar abertas: sem isto, qualquer um que achasse a URL levava o extrato
// inteiro e disparava sync cobrado no Plaid (achado da revisão de 21/ago).
import { createClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'

export async function requireUser(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false
  try {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const { data, error } = await anon.auth.getUser(token)
    return !error && !!data.user
  } catch { return false }
}
