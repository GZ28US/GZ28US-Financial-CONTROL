'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// Routes that are PUBLIC by design — no login. The client self-service form
// (/clients/self/[id]) is sent to clients so they fill in their own info;
// /rides/self/[id] lets a client upload their car photo. They are not app users,
// so these must render outside the auth gate.
const PUBLIC_PREFIXES = ['/clients/self/', '/rides/self/', '/costs/fixed/self/', '/duties/self/', '/staff/self/']

// Wraps the whole app. When signed out it shows a login screen; when signed in
// it renders the app. No public sign-up — accounts are created in the Supabase
// dashboard. No roles yet: any signed-in user has full access.
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [status, setStatus] = useState<'loading' | 'in' | 'out'>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let mounted = true
    // SEM PONTE PARA O BR (11/set/2026). Aqui o login pendurava uma sessão do banco
    // do BR no navegador (ensureBRBridgeSession) — que nunca subiu: a rota da ponte
    // respondia 503 e os espelhos US→BR morriam calados. Decisão do dono: escrita
    // entre projetos é do SERVIDOR (/api/br-mirror/*, chave de serviço do BR), e
    // nenhuma sessão do BR chega à tela. O portão só cuida da sessão do US.
    const onSession = (session: unknown) => {
      if (mounted) setStatus(session ? 'in' : 'out')
    }
    // SESSÃO QUE PARECE VIVA E NÃO ESTÁ (08/set/2026). `getSession()` devolve o
    // que está guardado no navegador; quando o refresh token também morre, ela
    // continua devolvendo a sessão velha e a tela abre LOGADA — enquanto toda
    // rota com `requireUser` responde 401. Foi o que escondeu por 33 dias que a
    // sessão tinha vencido em 06/ago: o Flow renderizava os valores, o menu
    // mostrava SIGN OUT, e só as rotas de API recusavam. Mais um que morria
    // calado.
    //
    // Quem sabe se o token vale é o SERVIDOR, e é `getUser()` que pergunta.
    // Resposta de autenticação (4xx) manda para a tela de login; erro de rede
    // NÃO desloga ninguém — internet ruim não é sessão vencida.
    // A pergunta certa é "isto é falha de REDE?", não "veio 4xx?". A primeira
    // versão testava `status >= 400 && < 500`, e erro sem status numérico —
    // refresh token morto costuma estourar ANTES da resposta HTTP — escapava
    // pela peneira e o portão abria logado do mesmo jeito (visto pela sessão
    // PESCA/AutoBook). Invertido: rede mantém a sessão, QUALQUER outro erro
    // manda para o login, que é o lado recuperável do engano.
    const ehFalhaDeRede = (e: unknown) => {
      const x = e as { name?: string; status?: number; isRetryable?: boolean; message?: string } | null
      if (!x) return false
      if (x.isRetryable === true) return true
      if (x.name === 'AuthRetryableFetchError' || x.name === 'TypeError') return true
      if (typeof x.status === 'number' && (x.status === 0 || x.status >= 500)) return true
      return /fetch|network|timeout|offline/i.test(String(x.message || ''))
    }
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return onSession(null)
      try {
        const { error } = await supabase.auth.getUser()
        if (error && !ehFalhaDeRede(error)) return onSession(null)
      } catch (e) {
        if (!ehFalhaDeRede(e)) return onSession(null)
      }
      onSession(data.session)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      onSession(session)
    })
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [])

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(error.message)
    setSubmitting(false)
    // onAuthStateChange flips status to 'in' on success.
  }

  // Public routes skip the gate entirely (e.g. the client self-service form).
  if (pathname && PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return <>{children}</>
  }

  if (status === 'loading') {
    return <div className="min-h-screen bg-black" />
  }

  if (status === 'out') {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <form onSubmit={login} className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-3xl p-8 flex flex-col gap-5">
          <div className="text-center mb-2">
            <h1 className="text-3xl font-bold">GZ28US</h1>
            <p className="text-gray-400 mt-1">Control App</p>
          </div>
          <div>
            <label className="block mb-2 text-sm font-bold text-gray-400">EMAIL</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <label className="block mb-2 text-sm font-bold text-gray-400">PASSWORD</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
              placeholder="••••••••"
              required
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold"
          >
            {submitting ? 'SIGNING IN…' : 'SIGN IN'}
          </button>
        </form>
      </main>
    )
  }

  return <>{children}</>
}
