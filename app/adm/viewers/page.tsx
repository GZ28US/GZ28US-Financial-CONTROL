'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// /ca/adm/viewers — VIEW-ONLY ACCOUNTS (10/11/2026, Drummond Advisors). Create an invite (one per person, tied to the e-mail,
// single use, 7 days), copy its link, revoke it, block / unblock an account. The link shows ONCE here; nothing is sent from
// this screen.
import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { fmtStamp } from '@/lib/orlando'

export default function ViewersAdmin() {
  const [d, setD] = useState<any | null>(null)
  const [err, setErr] = useState(''), [msg, setMsg] = useState('')
  const [email, setEmail] = useState(''), [label, setLabel] = useState('')
  const [link, setLink] = useState('')
  const load = useCallback(async () => {
    const r = await fetch(`${BASE_PATH}/api/adm/viewers`, { headers: await sessionHeaders(), cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return }
    setErr(''); setD(j)
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])
  const post = async (body: Record<string, unknown>) => {
    setMsg('')
    const r = await fetch(`${BASE_PATH}/api/adm/viewers`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setMsg('✖ ' + (j.error || r.status))
    load()
    return r.ok ? j : null
  }
  const invite = async () => {
    setLink('')
    const j = await post({ action: 'invite', email, label })
    if (j?.link) { setLink(j.link); setEmail(''); setLabel('') }
  }
  const state = (i: any) => i.revoked_at ? 'REVOKED' : i.uses >= i.max_uses ? 'USED' : new Date(i.expires_at).getTime() <= Date.now() ? 'EXPIRED' : 'OPEN'
  const inp = 'bg-gray-900 border border-gray-700 rounded-xl px-3 py-2'
  return <div className="min-h-screen bg-black text-white"><Header />
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold">VIEW-ONLY ACCOUNTS</h1>
      <p className="text-sm text-gray-400 mt-1">Every screen visible, nothing can be changed, nothing goes out. The account is created by the invited person on the invite link (one per e-mail, single use, 7 days). Sign-in: {d?.app_url || 'https://www.gz28us.com/ca'}</p>
      {err && <p className="text-red-400 mt-3">{err}</p>}

      <div className="mt-5 bg-gray-950 border border-gray-800 rounded-xl p-4">
        <div className="font-bold mb-2">NEW INVITE</div>
        <div className="flex flex-wrap gap-2">
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="person@drummondadvisors.com" className={`${inp} flex-1 min-w-[240px]`} />
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Name — Drummond" className={`${inp} flex-1 min-w-[180px]`} />
          <button onClick={invite} className="bg-green-700 hover:bg-green-600 px-4 py-2 rounded-xl font-bold">CREATE INVITE</button>
        </div>
        {link && <div className="mt-3 text-sm"><div className="text-amber-300">Invite link — shown only now. It goes in the e-mail you approve; nothing was sent.</div>
          <div className="mt-1 flex gap-2 items-center"><code className="break-all bg-black border border-gray-800 rounded px-2 py-1 flex-1">{link}</code>
            <button onClick={() => { navigator.clipboard?.writeText(link); setMsg('✓ link copied') }} className="border border-gray-600 px-3 py-1 rounded-lg">COPY</button></div></div>}
        {msg && <p className="text-sm mt-2">{msg}</p>}
      </div>

      <div className="mt-6 font-bold">ACCOUNTS</div>
      {(d?.viewers || []).length === 0 && <p className="text-gray-500 text-sm mt-1">none yet</p>}
      {(d?.viewers || []).map((v: any) => <div key={v.email} className="mt-2 bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm flex justify-between items-center gap-3">
        <div><div className="font-semibold">{v.label || v.email} {v.blocked_at ? <span className="text-red-400">· BLOCKED</span> : <span className="text-emerald-400">· VIEW ONLY</span>}</div>
          <div className="text-gray-400">{v.email} · created {fmtStamp(v.created_at)}{v.blocked_at ? ` · blocked ${fmtStamp(v.blocked_at)}` : ''}</div></div>
        {v.blocked_at
          ? <button onClick={() => post({ action: 'unblock', email: v.email })} className="border border-gray-600 px-3 py-2 rounded-lg">UNBLOCK</button>
          : <button onClick={() => { if (confirm(`Block ${v.email}? The account stops seeing anything and cannot sign in.`)) post({ action: 'block', email: v.email }) }} className="bg-red-800 hover:bg-red-700 px-3 py-2 rounded-lg font-bold">BLOCK</button>}
      </div>)}

      <div className="mt-6 font-bold">INVITES</div>
      {(d?.invites || []).length === 0 && <p className="text-gray-500 text-sm mt-1">none yet</p>}
      {(d?.invites || []).map((i: any) => <div key={i.id} className="mt-2 bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm flex justify-between items-center gap-3">
        <div><div className="font-semibold">{i.label} · {state(i)}</div><div className="text-gray-400">{i.email} · created {fmtStamp(i.created_at)} · valid until {fmtStamp(i.expires_at)}</div></div>
        {state(i) === 'OPEN' && <button onClick={() => { if (confirm(`Revoke the invite for ${i.email}?`)) post({ action: 'revoke-invite', id: i.id }) }} className="border border-gray-600 px-3 py-2 rounded-lg">REVOKE</button>}
      </div>)}
    </div>
  </div>
}
