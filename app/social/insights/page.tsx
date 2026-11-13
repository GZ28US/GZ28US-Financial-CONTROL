'use client'

// ── SOCIAL INSIGHTS (13/11/2026) ─────────────────────────────────────────────
// O painel de números do Facebook e do Instagram, lido ao vivo pela rota de leitura (/api/social/read — nada é guardado aqui):
// seguidores, as métricas diárias da página e do @, e os últimos posts com reações e comentários.
// Cada bloco carrega sozinho; se a Meta recusar uma métrica, o bloco diz o erro e os outros seguem.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Block = { loading: boolean; error?: string; data?: any }
const dia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' })
const quando = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' })
const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : v == null ? '—' : String(v))
const LABEL: Record<string, string> = {
  page_media_view: 'Views', page_total_media_view_unique: 'Viewers (unique)', page_post_engagements: 'Post engagements', page_follows: 'Followers (total)',
  page_daily_follows_unique: 'New follows', page_views_total: 'Page visits', reach: 'Reach', follower_count: 'New followers',
}

export default function SocialInsightsPage() {
  const [b, setB] = useState<Record<string, Block>>({})
  const [accounts, setAccounts] = useState<{ pages: string[]; igs: string[] }>({ pages: [], igs: [] })
  const [page, setPage] = useState('')

  async function read(key: string, what: string, extra = '') {
    setB(p => ({ ...p, [key]: { loading: true } }))
    try {
      const r = await fetch(`${BASE_PATH}/api/social/read?what=${what}${extra}`, { headers: await sessionHeaders() })
      const j = await r.json().catch(() => ({}))
      const err = !r.ok ? (j?.data?.error?.message || j?.error || `error ${r.status}`) : j?.data?.error?.message
      setB(p => ({ ...p, [key]: { loading: false, error: err ? String(err) : undefined, data: j?.data } }))
    } catch (e) { setB(p => ({ ...p, [key]: { loading: false, error: String((e as Error)?.message || e) } })) }
  }
  useEffect(() => {
    (async () => {
      const r = await fetch(`${BASE_PATH}/api/social/inbox?limit=1`, { headers: await sessionHeaders() })
      const j = await r.json().catch(() => ({}))
      const acc = (j.accounts || []) as { kind: string; account: string | null }[]
      const pages = acc.filter(a => a.kind === 'FB_PAGE').map(a => String(a.account)), igs = acc.filter(a => a.kind === 'IG_ACCOUNT').map(a => String(a.account))
      setAccounts({ pages, igs }); setPage(pages[0] || '')
    })()
  }, [])
  useEffect(() => {
    if (!page) return
    const a = `&account=${encodeURIComponent(page)}`
    void read('fb_page', 'fb_page', a); void read('fb_insights', 'fb_insights', a + '&period=day'); void read('fb_posts', 'fb_posts', a)
  }, [page])
  useEffect(() => {
    if (!accounts.igs.length) return
    void read('ig_profile', 'ig_profile'); void read('ig_insights', 'ig_insights', '&period=day'); void read('ig_media', 'ig_media')
  }, [accounts.igs.length])

  const card = 'bg-gray-900 border border-gray-800 rounded-3xl p-5'
  const Estado = ({ k }: { k: string }) => b[k]?.loading ? <p className="text-gray-500">Loading…</p> : b[k]?.error ? <p className="text-amber-400 text-sm">Meta did not return this: {b[k]!.error}</p> : null
  // métricas diárias: uma linha por métrica, os últimos dias e a soma
  const Serie = ({ k }: { k: string }) => {
    const rows = (b[k]?.data?.data || []) as { name: string; values: { value: unknown; end_time: string }[] }[]
    if (!rows.length) return null
    return (
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-gray-500"><th className="text-left py-1">Metric</th>{(rows[0].values || []).slice(-7).map(v => <th key={v.end_time} className="text-right px-2">{dia.format(new Date(v.end_time))}</th>)}<th className="text-right px-2">Sum</th></tr></thead>
        <tbody>{rows.map(r => { const vs = (r.values || []).slice(-7), nums = vs.map(v => (typeof v.value === 'number' ? v.value : 0)); const max = Math.max(1, ...nums); return (
          <tr key={r.name} className="border-t border-gray-800"><td className="py-1 font-bold">{LABEL[r.name] || r.name}</td>
            {vs.map((v, i) => <td key={i} className="text-right px-2"><span className="inline-block align-bottom bg-blue-700 mr-1" style={{ width: 4, height: 2 + Math.round((nums[i] / max) * 16) }} />{n(v.value)}</td>)}
            <td className="text-right px-2 font-bold">{r.name === 'page_follows' ? '—' : n(nums.reduce((s, x) => s + x, 0))}</td></tr>) })}</tbody>
      </table></div>
    )
  }
  const fb = b.fb_page?.data, ig = b.ig_profile?.data

  return (
    <main className="min-h-screen bg-black text-white p-6 pb-28">
      <Header />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <h1 className="text-3xl font-bold mr-auto">SOCIAL INSIGHTS</h1>
        {accounts.pages.length > 1 && accounts.pages.map(p => <button key={p} onClick={() => setPage(p)} className={`px-3 py-1 rounded-full text-xs font-bold ${page === p ? 'bg-blue-700' : 'bg-gray-800 text-gray-400'}`}>{p}</button>)}
        <a href={`${BASE_PATH}/social/inbox`} className="bg-gray-900 border border-gray-700 hover:bg-gray-800 px-5 py-3 rounded-2xl font-bold">SOCIAL INBOX</a>
      </div>
      <p className="text-xs text-gray-500 mb-4">Read live from Meta each time this page opens. Days are Meta&apos;s reporting days, shown in Orlando time. Nothing here is stored or estimated.</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className={card}>
          <p className="text-sm font-bold text-blue-300 mb-2">FACEBOOK — {page || 'page'}</p>
          <Estado k="fb_page" />
          {fb && !b.fb_page?.error && <div className="grid grid-cols-2 gap-3 mb-3"><div><p className="text-xs text-gray-500">FOLLOWERS</p><p className="text-3xl font-bold">{n(fb.followers_count)}</p></div><div><p className="text-xs text-gray-500">PAGE LIKES</p><p className="text-3xl font-bold">{n(fb.fan_count)}</p></div></div>}
          <p className="text-xs text-gray-500 font-bold mt-2 mb-1">LAST 7 REPORTING DAYS</p>
          <Estado k="fb_insights" /><Serie k="fb_insights" />
        </section>
        <section className={card}>
          <p className="text-sm font-bold text-pink-300 mb-2">INSTAGRAM — {accounts.igs[0] || '@'}</p>
          <Estado k="ig_profile" />
          {ig && !b.ig_profile?.error && <div className="grid grid-cols-3 gap-3 mb-3"><div><p className="text-xs text-gray-500">FOLLOWERS</p><p className="text-3xl font-bold">{n(ig.followers_count)}</p></div><div><p className="text-xs text-gray-500">FOLLOWING</p><p className="text-3xl font-bold">{n(ig.follows_count)}</p></div><div><p className="text-xs text-gray-500">POSTS</p><p className="text-3xl font-bold">{n(ig.media_count)}</p></div></div>}
          <p className="text-xs text-gray-500 font-bold mt-2 mb-1">LAST 7 REPORTING DAYS</p>
          <Estado k="ig_insights" /><Serie k="ig_insights" />
        </section>
        <section className={card}>
          <p className="text-sm font-bold text-blue-300 mb-2">FACEBOOK — LATEST POSTS</p>
          <Estado k="fb_posts" />
          {((b.fb_posts?.data?.data || []) as any[]).slice(0, 12).map(p => (
            <a key={p.id} href={p.permalink_url} target="_blank" rel="noreferrer" className="flex gap-3 border-t border-gray-800 py-2 text-sm hover:bg-gray-800 rounded-xl px-2">
              <span className="w-20 text-gray-500 shrink-0">{quando.format(new Date(p.created_time))}</span><span className="flex-1 truncate">{p.message || '[no text]'}</span>
              <span className="text-gray-300 whitespace-nowrap">👍 {n(p.reactions?.summary?.total_count ?? 0)} · 💬 {n(p.comments?.summary?.total_count ?? 0)} · ↗ {n(p.shares?.count ?? 0)}</span>
            </a>))}
        </section>
        <section className={card}>
          <p className="text-sm font-bold text-pink-300 mb-2">INSTAGRAM — LATEST POSTS</p>
          <Estado k="ig_media" />
          {((b.ig_media?.data?.data || []) as any[]).slice(0, 12).map(m => (
            <a key={m.id} href={m.permalink} target="_blank" rel="noreferrer" className="flex gap-3 border-t border-gray-800 py-2 text-sm hover:bg-gray-800 rounded-xl px-2">
              <span className="w-20 text-gray-500 shrink-0">{quando.format(new Date(m.timestamp))}</span><span className="px-2 rounded-full text-xs bg-gray-700 self-center">{m.media_product_type || m.media_type}</span><span className="flex-1 truncate">{m.caption || '[no caption]'}</span>
              <span className="text-gray-300 whitespace-nowrap">♥ {n(m.like_count ?? 0)} · 💬 {n(m.comments_count ?? 0)}</span>
            </a>))}
        </section>
      </div>
    </main>
  )
}
