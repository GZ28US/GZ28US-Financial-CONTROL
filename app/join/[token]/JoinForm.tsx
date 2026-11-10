'use client'
import { useState } from 'react'
import { BASE_PATH } from '@/lib/utils'

// the form of /ca/join/<token>: the e-mail is the invite's (fixed), the person chooses the password
export default function JoinForm({ token, email }: { token: string; email: string }) {
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState('')
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (pw.length < 10) return setErr('The password needs at least 10 characters.')
    if (pw !== pw2) return setErr('The two passwords are different.')
    setBusy(true)
    try {
      const r = await fetch(`${BASE_PATH}/api/viewer/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: pw }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok) setDone(true)
      else setErr(r.status === 404 ? 'This invite is no longer valid. Ask GZ28 for a new one.' : (j.error || `Error ${r.status}`))
    } catch { setErr('No connection. Try again.') } finally { setBusy(false) }
  }
  const box = 'w-full max-w-sm bg-gray-900 border border-gray-700 rounded-3xl p-8 flex flex-col gap-5'
  const inp = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      {done ? <div className={box}>
        <div className="text-center"><h1 className="text-3xl font-bold">GZ28US</h1><p className="text-gray-400 mt-1">Control App</p></div>
        <p className="text-emerald-300 font-semibold">✓ Your account is ready.</p>
        <p className="text-gray-300 text-sm">Sign in with <b>{email}</b> and the password you just chose. Your access is <b>view only</b>: you can open every screen, nothing can be changed.</p>
        <a href={`${BASE_PATH}/`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold text-center">OPEN www.gz28us.com/ca</a>
      </div> : <form onSubmit={submit} className={box}>
        <div className="text-center mb-2"><h1 className="text-3xl font-bold">GZ28US</h1><p className="text-gray-400 mt-1">Create your view-only account</p></div>
        <div><label className="block mb-2 text-sm font-bold text-gray-400">EMAIL</label>
          <input type="email" value={email} readOnly autoComplete="username" className={`${inp} text-gray-400`} /></div>
        <div><label className="block mb-2 text-sm font-bold text-gray-400">PASSWORD (10+ characters)</label>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" className={inp} required minLength={10} /></div>
        <div><label className="block mb-2 text-sm font-bold text-gray-400">REPEAT THE PASSWORD</label>
          <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" className={inp} required minLength={10} /></div>
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <button type="submit" disabled={busy} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{busy ? 'CREATING…' : 'CREATE ACCOUNT'}</button>
        <p className="text-xs text-gray-500">After this, sign in at www.gz28us.com/ca. View-only access: every screen is visible, nothing can be changed.</p>
      </form>}
    </main>
  )
}
