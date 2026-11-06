'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// /ca/doc — QUOTES v2 (06/11/2026; blueprint §2.2 + M2 §6.6 A). What needs the owner first. Groups: NEEDS ME (signed · clearing ·
// changes · declined · renewal asked · expiring) · WAITING (sent · viewed) · DONE/OLD (expired · void · hired); zero-count chips
// hidden. Card line: «SENT 2h (Messenger) · 👁 opened 2h ago · last seen 12m ago · ✍ —». Below, the open quotes not sent through
// the portal yet. ?code=US.QT.028.1 jumps straight to the document (live code, or a "formerly" code after hire).
// The legacy /quotes page is untouched (the owner's order: old pages stay).
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { STAGE_LABEL, SUB_LABEL } from '@/lib/quoteStage'

type Group = 'ALL' | 'NEEDS' | 'WAITING' | 'DONE'
function groupOf(x: any): Exclude<Group, 'ALL'> {
  if (x.stage === 'SIGNED' || x.stage === 'CHANGES' || x.stage === 'DECLINED' || x.last_kind === 'RENEWAL_REQUESTED') return 'NEEDS'
  if ((x.stage === 'SENT' || x.stage === 'VIEWED') && x.days_left != null && x.days_left <= 7) return 'NEEDS'
  if (x.stage === 'SENT' || x.stage === 'VIEWED' || x.stage === 'DRAFT') return 'WAITING'
  return 'DONE'
}
function ago(iso: string | null) {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })

export default function DocIndex() {
  const router = useRouter()
  const [d, setD] = useState<{ docs: any[]; drafts: any[] } | null>(null)
  const [q, setQ] = useState('')
  const [g, setG] = useState<Group>('ALL')
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
  const counts = useMemo(() => {
    const c: Record<Group, number> = { ALL: 0, NEEDS: 0, WAITING: 0, DONE: 0 }
    for (const x of d?.docs || []) { c.ALL++; c[groupOf(x)]++ }
    return c
  }, [d])
  const list = (d?.docs || []).filter(m).filter(x => g === 'ALL' || groupOf(x) === g)
  const chip = (k: Group, label: string) => counts[k] > 0 || k === 'ALL'
    ? <button key={k} onClick={() => setG(k)} className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${g === k ? 'bg-white text-black' : 'bg-gray-900 text-gray-300'}`}>{label} {counts[k]}</button> : null
  return <div className="min-h-screen bg-black text-white"><Header />
    <div className="max-w-3xl mx-auto px-4 py-4">
      <div className="flex items-center gap-3"><h1 className="text-xl font-bold shrink-0">QUOTES v2 ({counts.ALL})</h1>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 code, client, car" className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm" /></div>
      <div className="flex gap-2 overflow-x-auto mt-3 pb-1">{chip('ALL', 'ALL')}{chip('NEEDS', 'NEEDS ME')}{chip('WAITING', 'WAITING')}{chip('DONE', 'DONE/OLD')}</div>
      {err && <p className="text-red-400 mt-3">{err}</p>}
      {d && <>
        <div className="mt-3 grid gap-2">{list.map(x => <Link key={x.id} href={`/doc/${x.id}`} className="block bg-gray-950 border border-gray-800 rounded-xl p-3 hover:border-gray-600">
          <div className="flex justify-between gap-3 text-sm"><span className="font-semibold">{x.code}{x.rev ? ` · rev ${x.rev}` : ''}{x.is_test ? ' · TEST' : ''} · {x.service}</span><span className="shrink-0">{usd(x.grand)}</span></div>
          <div className="text-xs text-gray-400">{x.client}{x.client_number ? ` #${x.client_number}` : ''}{x.car ? ` · ${x.car}` : ''}{x.channel ? ` · ${String(x.channel).toLowerCase()}` : ''}{x.language === 'pt' ? ' · PT' : ''}{x.rails?.includes('PIX_BR') ? ' · PIX GZ28BR' : ''}</div>
          <div className="text-xs mt-1">
            <span className="text-sky-300 font-semibold">{STAGE_LABEL[x.stage as keyof typeof STAGE_LABEL] || x.stage}{x.sub ? ' · ' + SUB_LABEL[x.sub as keyof typeof SUB_LABEL] : x.stage === 'SIGNED' ? ' · awaiting deposit' : ''}</span>
            <span className="text-gray-500">{x.sent_at ? ` · SENT ${ago(x.sent_at)}` : ''}{x.first_viewed_at ? ` · 👁 opened ${ago(x.first_viewed_at)} ago` : ' · 👁 —'}{x.last_viewed_at && x.last_viewed_at !== x.first_viewed_at ? ` · last seen ${ago(x.last_viewed_at)} ago` : ''}{x.signed_at ? ` · ✍ ${ago(x.signed_at)}` : ' · ✍ —'}</span>
            {(x.stage === 'SENT' || x.stage === 'VIEWED') && x.days_left != null && x.days_left <= 7 && <span className="text-amber-300"> · ⚠ expires in {x.days_left} d</span>}
          </div></Link>)}
          {!list.length && <p className="text-sm text-gray-500">Nothing here.</p>}</div>
        <h2 className="mt-6 text-sm font-bold text-gray-400">OPEN QUOTES NOT SENT THROUGH THE PORTAL ({d.drafts.length})</h2>
        <div className="mt-2 grid gap-1">{d.drafts.filter(m).map(x => <Link key={x.id} href={`/doc/${x.id}`} className="text-sm text-gray-300 hover:text-white py-2 border-b border-gray-900">
          {x.code} · {x.client} · {x.car} · {x.service}</Link>)}</div>
      </>}
    </div></div>
}
