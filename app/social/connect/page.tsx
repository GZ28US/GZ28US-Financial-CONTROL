'use client'

// ── SOCIAL CONNECT (09/11/2026) ─────────────────────────────────────────────
// Márcio, 08/11: «i want to link deeply all the apps we need to link, all of them, I want Claude and the app to have deep access to
// them all». One card per platform (Meta = Facebook + Instagram + DMs + Business Suite · YouTube · TikTok):
//   • its switch (social.<platform>.enabled) — OFF until Márcio flips it here; the flip is recorded with his e-mail;
//   • which app keys exist in Vercel (yes/no — never the value);
//   • the connected accounts and their token health;
//   • CONNECT: POST with the logged-in session → the route returns the platform's consent URL → the browser goes there → the
//     callback stores the sealed token and shows a result page.
// Writes (post / reply / DM) have their own switch, social.publish.enabled, and are not built yet — this screen only links.
// Behind the AuthGate (app/layout.tsx), like the whole app.

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

type Account = {
  id: number; platform: string; kind: string; account: string | null; external_id: string; status: string
  last_error: string | null; last_ok_at: string | null; access_expires_at: string | null; scopes: string[]; has_refresh_token: boolean
}
type Status = { switches: Record<string, boolean>; env: Record<string, boolean>; accounts: Account[] }

const CARDS = [
  { p: 'META', label: 'META — FACEBOOK · INSTAGRAM · DMs · BUSINESS SUITE', sw: 'social.meta.enabled', env: ['META_APP_ID', 'META_APP_SECRET'], route: '/api/social/meta/auth',
    hint: 'Sign in as the admin of the GZ28 V8 SpeedShop USA page. Tick every page and the @gz28us Instagram when Meta asks.' },
  { p: 'YOUTUBE', label: 'YOUTUBE', sw: 'social.youtube.enabled', env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], route: '/api/social/youtube/auth',
    hint: 'On the Google screen choose the @gz28us channel (not the personal account).' },
  { p: 'TIKTOK', label: 'TIKTOK', sw: 'social.tiktok.enabled', env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], route: '/api/social/tiktok/auth',
    hint: 'Sign in as @gz28.v8.speedshop.' },
] as const

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const when = (s: string | null) => (s ? fmt.format(new Date(s)) + ' ET' : '—')

export default function SocialConnectPage() {
  const [st, setSt] = useState<Status | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`${BASE_PATH}/api/social/status`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => null)
    if (!r.ok) { setMsg(j?.error || `HTTP ${r.status}`); return }
    setSt(j)
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  async function post(path: string, body: unknown) {
    const r = await fetch(`${BASE_PATH}${path}`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    return { r, j: await r.json().catch(() => null) }
  }

  async function flip(key: string, value: boolean) {
    if (!confirm(`${value ? 'TURN ON' : 'TURN OFF'} ${key}?`)) return
    setBusy(key); setMsg('')
    const { r, j } = await post('/api/social/status', { key, value })
    if (!r.ok) setMsg(j?.error || `HTTP ${r.status}`)
    setBusy(''); load()
  }

  async function connect(route: string, p: string) {
    setBusy(p); setMsg('')
    const { r, j } = await post(route, {})
    if (!r.ok || typeof j?.url !== 'string') { setMsg(j?.error || `HTTP ${r.status}`); setBusy(''); return }
    window.location.href = j.url
  }

  async function check() {
    setBusy('check'); setMsg('')
    const { r, j } = await post('/api/social/status', { check: true })
    setMsg(r.ok ? (j.results || []).map((x: { platform: string; account: string; ok: boolean; note: string }) => `${x.ok ? '✅' : '❌'} ${x.platform} ${x.account || ''} — ${x.note}`).join('\n') || 'No accounts yet.' : (j?.error || `HTTP ${r.status}`))
    setBusy(''); load()
  }

  return (
    <main className="min-h-screen bg-black text-white p-4 sm:p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">SOCIAL CONNECT</h1>
      <p className="text-gray-400 mb-6 max-w-3xl">
        Links the brand accounts to the app (and to Claude) through each platform&apos;s official API. Reading only for now —
        posting, replying and DMs stay off behind <code>social.publish.enabled</code> and always need Márcio&apos;s order.
      </p>

      {msg && <pre className="mb-6 max-w-3xl whitespace-pre-wrap text-sm bg-gray-900 border border-gray-700 rounded-2xl p-4">{msg}</pre>}
      {!st && !msg && <p className="text-gray-400">Loading…</p>}

      {st && (
        <div className="flex flex-col gap-6 max-w-3xl">
          {CARDS.map(c => {
            const on = !!st.switches[c.sw]
            const missing = [...c.env, 'SOCIAL_TOKEN_KEY'].filter(e => !st.env[e])
            const accts = st.accounts.filter(a => a.platform === c.p)
            return (
              <section key={c.p} className="bg-gray-900 border border-gray-700 rounded-3xl p-6 flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">{c.label}</h2>
                  <button onClick={() => flip(c.sw, !on)} disabled={!!busy}
                    className={`px-4 py-2 rounded-xl font-bold text-sm ${on ? 'bg-green-700' : 'bg-gray-700'}`}>{c.sw}: {on ? 'ON' : 'OFF'}</button>
                </div>
                {missing.length > 0 && <p className="text-amber-400 text-sm">Missing in Vercel: {missing.join(', ')}</p>}
                {accts.length === 0 ? <p className="text-gray-500 text-sm">No account connected.</p> : (
                  <ul className="text-sm flex flex-col gap-1">
                    {accts.map(a => (
                      <li key={a.id} className="flex flex-wrap gap-x-3">
                        <span className={a.status === 'CONNECTED' ? 'text-green-400' : 'text-red-400'}>{a.status}</span>
                        <span className="font-bold">{a.kind}</span><span>{a.account}</span>
                        <span className="text-gray-500">ok {when(a.last_ok_at)}{a.access_expires_at ? ` · token until ${when(a.access_expires_at)}` : ''}</span>
                        {a.last_error && <span className="text-red-400 w-full">{a.last_error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-gray-500 text-sm">{c.hint}</p>
                <button onClick={() => connect(c.route, c.p)} disabled={!on || missing.length > 0 || !!busy}
                  className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-6 py-3 rounded-2xl text-lg font-bold">
                  {busy === c.p ? 'STARTING…' : accts.length ? 'RECONNECT' : 'CONNECT'}
                </button>
              </section>
            )
          })}
          <div className="flex flex-wrap items-center gap-4">
            <button onClick={check} disabled={!!busy} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">
              {busy === 'check' ? 'CHECKING…' : 'CHECK TOKENS NOW'}
            </button>
            <button onClick={() => flip('social.publish.enabled', !st.switches['social.publish.enabled'])} disabled={!!busy}
              className={`px-4 py-2 rounded-xl font-bold text-sm ${st.switches['social.publish.enabled'] ? 'bg-red-700' : 'bg-gray-700'}`}>
              social.publish.enabled: {st.switches['social.publish.enabled'] ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
