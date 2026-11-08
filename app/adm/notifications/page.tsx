'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// /ca/adm/notifications — the switchboard of the quote portal's robot messages (QUOTE PORTAL M4, 06/11/2026; blueprint §8.1).
// One row per key, grouped CLIENT · MONEY · QUOTE FLOW (not money) · OWNER ALERTS; every key starts OFF. A key whose sender is not
// wired yet says so — turning it ON only logs "sender not wired", it never sends. Below: the last decisions the robots took.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { fmtStamp } from '@/lib/orlando'

// 08/11/2026: WhatsApp senders wired (client · REPORTS · owner → the REPORTS group); SIGNING = quote_portal.sign_otp (the 6-digit code
// before the e-signature); TEST = SEND TEST TO ME, which goes ONLY to the TEST TARGETS below (e-mails and WhatsApp numbers).
const GROUPS = ['CLIENT', 'MONEY', 'QUOTE FLOW (not money)', 'OWNER ALERTS', 'SIGNING']

export default function NotificationsPage() {
  const [d, setD] = useState<any | null>(null)
  const [err, setErr] = useState('')
  const [targets, setTargets] = useState('')
  const load = useCallback(async () => {
    const r = await fetch(`${BASE_PATH}/api/adm/notifications`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return }
    setD(j); setTargets((j.test_targets || []).join(', '))
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`${BASE_PATH}/api/adm/notifications`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error || r.status); return }
    load()
  }
  const flip = (k: any) => {
    const msg = k.on ? `Turn OFF ${k.key}?` : k.channel === 'otp' ? `Turn ON ${k.key}?\n\nFrom now on a client must type a 6-digit code — sent by the app on the quote's channel (WhatsApp, or e-mail when there is no phone) — before the e-signature.` : k.wired ? `Turn ON ${k.key}?\n\nFrom now on the app SENDS this message by itself (${k.channel}).` : `Turn ON ${k.key}?\n\nIts sender is not wired yet — it will only log "sender not wired", nothing is sent.`
    if (confirm(msg)) post({ key: k.key, on: !k.on })
  }
  const sendTestTap = async (k: any) => {
    if (!confirm(`SEND TEST TO ME — ${k.key}\n\nOne test message by ${k.channel === 'email' ? 'e-mail' : 'WhatsApp'} to the TEST TARGETS only (never a client, never the REPORTS group). Send?`)) return
    const r = await fetch(`${BASE_PATH}/api/adm/notifications`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ test_key: k.key }) })
    const j = await r.json().catch(() => ({}))
    alert(r.ok ? (j.results || []).map((x: any) => `${x.sent ? '✓' : '✖'} ${x.to} — ${x.reason}`).join('\n') : (j.error || r.status))
  }
  if (err) return <div className="min-h-screen bg-black text-white"><Header /><div className="p-6 text-red-400">{err}</div></div>
  return <div className="min-h-screen bg-black text-white pb-20"><Header />
    <div className="max-w-3xl mx-auto px-4 py-4">
      <h1 className="text-xl font-bold">NOTIFICATIONS — quote portal robots</h1>
      <p className="text-xs text-gray-400 mt-1">Every key starts OFF. A human SEND BY APP in /doc is never a key. Every robot decision leaves a line on the document&apos;s ACTIVITY.</p>
      {!d ? <p className="mt-4 text-gray-400">Loading…</p> : <>
        {GROUPS.map(g => <section key={g} className="mt-5">
          <h2 className="text-sm font-bold text-gray-300">{g}</h2>
          <div className="mt-2 grid gap-1">{d.keys.filter((k: any) => k.group === g).map((k: any) => <div key={k.key} className="flex items-center justify-between gap-3 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
            <div className="min-w-0"><div className="text-sm">{k.label}</div>
              <div className="text-[11px] text-gray-500">{k.key} · {k.channel}{!k.wired ? ' · sender not wired' : ''}{k.note ? ' · ' + k.note : ''}{k.updated_by ? ` · last change ${k.updated_by} ${fmtStamp(k.updated_at)}` : ''}</div></div>
            {k.wired && k.channel !== 'otp' && <button onClick={() => sendTestTap(k)} className="shrink-0 min-h-[36px] px-2 rounded-full text-[11px] border border-gray-700 text-gray-300">TEST</button>}
            <button onClick={() => flip(k)} className={`shrink-0 w-16 min-h-[36px] rounded-full text-xs font-bold ${k.on ? 'bg-emerald-500 text-black' : 'bg-gray-800 text-gray-400'}`}>{k.on ? 'ON' : 'OFF'}</button>
          </div>)}</div>
        </section>)}
        <section className="mt-6">
          <h2 className="text-sm font-bold text-gray-300">TEST TARGETS</h2>
          <p className="text-[11px] text-gray-500">The only destinations a TEST document (and SEND TEST TO ME) may ever reach — e-mails and WhatsApp numbers with country code, comma separated.</p>
          <div className="flex gap-2 mt-1"><input value={targets} onChange={e => setTargets(e.target.value)} className="flex-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm" placeholder="you@example.com, 14075550123" />
            <button onClick={() => post({ test_targets: targets.split(',').map(x => x.trim()).filter(Boolean) })} className="px-3 py-2 rounded bg-white text-black text-sm font-semibold">SAVE</button></div>
        </section>
        <section className="mt-6">
          <h2 className="text-sm font-bold text-gray-300">LAST DECISIONS ({d.decisions.length})</h2>
          <div className="mt-2 text-xs">{d.decisions.map((e: any) => <div key={e.id} className="flex justify-between gap-3 py-1 border-b border-gray-900">
            <span className={e.kind === 'NOTIFIED' ? 'text-emerald-300' : 'text-gray-400'}>{e.kind === 'NOTIFIED' ? '✓ sent' : '· skipped'} {e.key}{e.reason ? ` (${e.reason})` : ''}{e.to ? ` → ${e.to}` : ''}{e.test ? ' · TEST' : ''}</span>
            <span className="shrink-0 text-gray-500"><Link href={`/doc/${e.invoice_id}`} className="underline">{e.code}</Link> · {fmtStamp(e.at)}</span></div>)}
            {!d.decisions.length && <p className="text-gray-500">None yet.</p>}</div>
        </section>
      </>}
    </div></div>
}
