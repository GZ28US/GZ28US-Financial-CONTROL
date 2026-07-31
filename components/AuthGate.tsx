'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { ensureBRBridgeSession, clearBRBridgeSession } from '@/lib/supabaseBR'

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
    // The cross-project BR client (supabaseBR) must be authenticated before any
    // BR-backed write (suppliers/PAID mirrors, common-ride rename) — the BR
    // tables are behind RLS. Mint/attach the bridge session on login; drop it
    // on logout. Best-effort with a timeout so a bridge hiccup never blocks
    // the US app itself. (Mirror of the BR AuthGate's US-bridge wiring.)
    const onSession = async (session: unknown) => {
      if (session) {
        await Promise.race([ensureBRBridgeSession(), new Promise((r) => setTimeout(r, 8000))])
      } else {
        void clearBRBridgeSession()
      }
      if (mounted) setStatus(session ? 'in' : 'out')
    }
    supabase.auth.getSession().then(({ data }) => onSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void onSession(session)
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
