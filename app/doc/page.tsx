'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// /ca/doc — ACTION NEEDED (06/11/2026; blueprint §2.2). Every document with a portal revision, what needs the owner first:
// SIGNED · awaiting deposit → clearing → CHANGES / DECLINED → VIEWED → SENT → EXPIRED; then the open quotes not sent through the
// portal yet. ?code=US.QT.028.1 jumps straight to the document (live code, or a "formerly" code after hire).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { STAGE_LABEL, SUB_LABEL } from '@/lib/quoteStage'
import { fmtStamp } from '@/lib/orlando'

export default function DocIndex() {
  const router = useRouter()
  const [d, setD] = useState<{ docs: any[]; drafts: any[] } | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { (async () => {
    const code = new URLSearchParams(window.location.search).get('code')
    const h = await sessionHeaders()
    if (code) {
      const r = await fetch(`${BASE_PATH}/api/doc/index?code=${encodeURIComponent(code)}`, { headers: h })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.id) { router.replace(`/doc/${j.id}`); return }
      setErr(`${code}: not found`)
    }
    const r = await fetch(`${BASE_PATH}/api/doc/index`, { headers: h })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setErr(j.error || `HTTP ${r.status}`); else setD(j)
  })() }, [router])
  const m = (x: any) => !q || `${x.code} ${x.client} ${x.car} ${x.service}`.toLowerCase().includes(q.toLowerCase())
  const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
  return <div className="min-h-screen bg-black text-white"><Header />
    <div className="max-w-3xl mx-auto px-4 py-4">
      <div className="flex items-center gap-3"><h1 className="text-xl font-bold">ACTION NEEDED</h1>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 code, client, car" className="flex-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm" /></div>
      {err && <p className="text-red-400 mt-3">{err}</p>}
      {d && <>
        <div className="mt-4 grid gap-2">{d.docs.filter(m).map(x => <Link key={x.id} href={`/doc/${x.id}`} className="block bg-gray-950 border border-gray-800 rounded-xl p-3 hover:border-gray-600">
          <div className="flex justify-between text-sm"><span className="font-semibold">{x.code}{x.is_test ? ' · TEST' : ''} · {x.service}</span><span>{usd(x.grand)}</span></div>
          <div className="text-xs text-gray-400">{x.client} · {x.car}</div>
          <div className="text-xs mt-1"><span className="text-sky-300 font-semibold">{STAGE_LABEL[x.stage as keyof typeof STAGE_LABEL] || x.stage}{x.sub ? ' · ' + SUB_LABEL[x.sub as keyof typeof SUB_LABEL] : x.stage === 'SIGNED' ? ' · awaiting deposit' : ''}</span>
            {x.last_at && <span className="text-gray-500"> · {String(x.last_kind || '').toLowerCase().replace(/_/g, ' ')} {fmtStamp(x.last_at)}</span>}</div></Link>)}
          {!d.docs.length && <p className="text-sm text-gray-500">No document has been sent through the portal yet.</p>}</div>
        <h2 className="mt-6 text-sm font-bold text-gray-400">OPEN QUOTES NOT SENT THROUGH THE PORTAL ({d.drafts.length})</h2>
        <div className="mt-2 grid gap-1">{d.drafts.filter(m).map(x => <Link key={x.id} href={`/doc/${x.id}`} className="text-sm text-gray-300 hover:text-white py-1 border-b border-gray-900">
          {x.code} · {x.client} · {x.car} · {x.service}</Link>)}</div>
      </>}
    </div></div>
}
