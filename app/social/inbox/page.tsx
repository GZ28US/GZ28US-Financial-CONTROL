'use client'

// ── SOCIAL INBOX (13/11/2026) ────────────────────────────────────────────────
// Márcio, 11/11 via FaceBook ROUND: «i want the app fully connected to facebook, do it, as deep as possible».
// Uma tela para tudo que chega no Facebook e no Instagram: mensagens (TODAS as pastas do Messenger — inbox, other, spam, done —
// e as DMs do Instagram), comentários, menções. O que é novo vem marcado NEW até alguém ver.
// ESCREVER é sempre em três passos: RASCUNHO (aqui ou por uma sessão do Claude) → um humano logado lê e clica APPROVE & SEND →
// só então sai. Responder, ocultar, apagar e publicar passam todos por essa fila. Sem social.publish.enabled nada sai.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

type Item = {
  id: number; platform: 'FACEBOOK' | 'INSTAGRAM'; kind: 'MESSAGE' | 'COMMENT' | 'MENTION' | 'LEAD'; external_id: string; account_id: number | null
  thread_id: string | null; thread_title: string | null; parent_id: string | null; folder: string | null; from_id: string | null; from_name: string | null
  from_me: boolean; body: string | null; attachments: number; permalink: string | null; hidden: boolean; happened_at: string; seen_at: string | null; gone_at: string | null
}
type Draft = { id: number; account_id: number; platform: string; action: string; body: string | null; link: string | null; context: string | null; status: string; created_by: string; created_at: string; approved_by: string | null; sent_at: string | null; error: string | null; item_id: number | null }
type Account = { id: number; kind: string; account: string | null; status: string }
type Data = { items: Item[]; counts: Record<string, number>; accounts: Account[]; switches: { meta: boolean; inbox: boolean; publish: boolean } }

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const when = (s: string | null) => (s ? fmt.format(new Date(s)).replace(',', '') : '—')
const ACTION: Record<string, string> = { MESSAGE_REPLY: 'REPLY TO MESSAGE', COMMENT_REPLY: 'REPLY TO COMMENT', COMMENT_HIDE: 'HIDE COMMENT', COMMENT_UNHIDE: 'UNHIDE COMMENT', COMMENT_DELETE: 'DELETE COMMENT', POST_PUBLISH: 'PUBLISH POST' }
const FOLDER: Record<string, string> = { inbox: 'INBOX', other: 'OTHER', spam: 'SPAM', page_done: 'DONE', instagram: 'IG DM' }

export default function SocialInboxPage() {
  const [d, setD] = useState<Data | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [f, setF] = useState({ platform: '', kind: '', folder: '', onlyNew: true, q: '' })
  const [open, setOpen] = useState<Item | null>(null)
  const [thread, setThread] = useState<Item[]>([])
  const [reply, setReply] = useState('')
  const [post, setPost] = useState<{ account: string; body: string; link: string } | null>(null)
  const [edit, setEdit] = useState<Record<number, string>>({})
  const [queue, setQueue] = useState('DRAFT')

  const api = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(`${BASE_PATH}${path}`, body === undefined ? { headers: await sessionHeaders() } : { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok && !j.error) j.error = `error ${r.status}`
    return j
  }, [])

  const load = useCallback(async () => {
    const p = new URLSearchParams()
    if (f.platform) p.set('platform', f.platform); if (f.kind) p.set('kind', f.kind); if (f.folder) p.set('folder', f.folder)
    if (f.onlyNew) p.set('new', '1'); if (f.q.trim()) p.set('q', f.q.trim())
    const [a, b] = await Promise.all([api(`/api/social/inbox?${p}`), api(`/api/social/outbox?status=${queue}`)])
    if (a.error) setErro(a.error); else { setErro(''); setD(a) }
    setDrafts(b.outbox || [])
  }, [api, f, queue])
  useEffect(() => { void load() }, [load])

  async function openThread(it: Item) {
    setOpen(it); setReply(''); setThread([])
    if (!it.thread_id) { setThread([it]); return }
    const a = await api(`/api/social/inbox?thread=${encodeURIComponent(it.thread_id)}&limit=300`)
    setThread(((a.items || [it]) as Item[]).slice().reverse())
  }
  async function act(label: string, fn: () => Promise<{ error?: string; ok?: boolean; note?: string }>, done?: string) {
    setBusy(label); setMsg('')
    const r = await fn()
    setBusy('')
    if (r.error) { setMsg('✖ ' + r.error); return false }
    setMsg(done || '✓ done'); await load(); return true
  }
  const markSeen = (ids: number[]) => act('seen', () => api('/api/social/inbox', { action: 'seen', ids }), '✓ marked as seen')
  const draft = (kind: string, it: Item, body?: string) => act('draft', () => api('/api/social/outbox', { action: 'draft', kind, item_id: it.id, body }), '✓ DRAFT created — it is in the queue above, waiting for APPROVE & SEND')
  async function sendDraft(x: Draft) {
    if (!confirm(`${ACTION[x.action] || x.action}\n\n${x.context || ''}\n\n${x.body ? '«' + x.body + '»' : ''}${x.link ? '\n' + x.link : ''}\n\nThis goes out NOW, in the name of the page. Send?`)) return
    await act('send' + x.id, () => api('/api/social/outbox', { action: 'approve_send', id: x.id }), '✓ SENT')
  }

  const items = d?.items || []
  const conta = (id: number | null) => d?.accounts.find(a => a.id === id)?.account || ''
  const c = d?.counts || {}
  const last = useMemo(() => thread.filter(t => !t.from_me).slice(-1)[0] || open, [thread, open])
  const chip = (on: boolean, warn = false) => `px-3 py-1 rounded-full text-xs font-bold ${on ? 'bg-blue-700 text-white' : warn ? 'bg-red-900 text-red-200' : 'bg-gray-800 text-gray-400'}`
  const btn = 'bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-3 py-1 rounded-xl text-sm font-bold'
  const sw = d?.switches

  return (
    <main className="min-h-screen bg-black text-white p-6 pb-28">
      <Header />
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h1 className="text-3xl font-bold mr-auto">SOCIAL INBOX <span className="text-gray-500">({items.length})</span>{c.total ? <span className="ml-3 px-3 py-1 rounded-full text-base bg-fuchsia-800 text-fuchsia-100">{c.total} NEW</span> : null}</h1>
        <input value={f.q} onChange={e => setF({ ...f, q: e.target.value })} placeholder="Search: name, text, post" className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-base w-full md:w-80" />
        <button disabled={!!busy} onClick={() => act('refresh', () => api('/api/social/inbox', { action: 'refresh' }), '✓ read from Facebook and Instagram just now')} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold">{busy === 'refresh' ? 'READING…' : '⟳ READ NOW'}</button>
        <button onClick={() => setPost({ account: String(d?.accounts.find(a => a.kind === 'FB_PAGE')?.id || ''), body: '', link: '' })} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold">+ NEW POST DRAFT</button>
        <a href={`${BASE_PATH}/social/insights`} className="bg-gray-900 border border-gray-700 hover:bg-gray-800 px-5 py-3 rounded-2xl font-bold">INSIGHTS</a>
      </div>
      <div className="flex flex-wrap gap-2 mb-2 items-center">
        <button onClick={() => setF({ ...f, onlyNew: !f.onlyNew })} className={chip(f.onlyNew)}>{f.onlyNew ? 'NEW ONLY' : 'ALL (seen too)'}</button>
        <span className="text-gray-700">|</span>
        {[['', 'ALL'], ['FACEBOOK', 'FACEBOOK'], ['INSTAGRAM', 'INSTAGRAM']].map(([v, l]) => <button key={v} onClick={() => setF({ ...f, platform: v })} className={chip(f.platform === v)}>{l}{v && c[v] ? ` · ${c[v]}` : ''}</button>)}
        <span className="text-gray-700">|</span>
        {[['', 'ALL'], ['MESSAGE', 'MESSAGES'], ['COMMENT', 'COMMENTS'], ['MENTION', 'MENTIONS'], ['LEAD', 'LEADS']].map(([v, l]) => <button key={v} onClick={() => setF({ ...f, kind: v, folder: v === 'MESSAGE' || !v ? f.folder : '' })} className={chip(f.kind === v)}>{l}{v && c[v] ? ` · ${c[v]}` : ''}</button>)}
        <span className="text-gray-700">|</span>
        {[['', 'ANY FOLDER'], ['inbox', 'INBOX'], ['other', 'OTHER'], ['spam', 'SPAM'], ['page_done', 'DONE'], ['instagram', 'IG DM']].map(([v, l]) => <button key={v} onClick={() => setF({ ...f, folder: v })} className={chip(f.folder === v, (v === 'spam' || v === 'other') && !!c[`folder:${v}`])}>{l}{v && c[`folder:${v}`] ? ` · ${c[`folder:${v}`]}` : ''}</button>)}
      </div>
      {sw && (!sw.meta || !sw.inbox || !sw.publish) && <p className="text-sm text-amber-300 mb-2">{!sw.meta ? 'social.meta.enabled is OFF — nothing can be read. ' : ''}{sw.meta && !sw.inbox ? 'social.inbox.enabled is OFF — the app is not reading by itself every 15 minutes; READ NOW still works. ' : ''}{!sw.publish ? 'social.publish.enabled is OFF — drafts can be written and read, but nothing can be sent. ' : ''}<a className="underline" href={`${BASE_PATH}/social/connect`}>Switches at SOCIAL CONNECT</a></p>}
      {erro && <p className="text-red-400 mb-2">{erro}</p>}
      {msg && <p className={`mb-2 font-bold ${msg.startsWith('✖') ? 'text-red-400' : 'text-green-400'}`}>{msg}</p>}

      {/* a fila: rascunho → aprovação → envio */}
      <section className="bg-gray-900 border border-amber-700/60 rounded-3xl p-5 mb-5">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <p className="text-sm font-bold text-amber-400 mr-auto">OUTBOX — nothing leaves without APPROVE &amp; SEND by a logged-in person</p>
          {['DRAFT', 'SENT', 'FAILED', 'CANCELLED'].map(s => <button key={s} onClick={() => setQueue(s)} className={chip(queue === s)}>{s}</button>)}
        </div>
        {drafts.length === 0 ? <p className="text-gray-500">{queue === 'DRAFT' ? 'No draft waiting.' : 'Nothing here.'}</p> : drafts.map(x => (
          <div key={x.id} className="border-t border-gray-800 py-3">
            <div className="flex items-start gap-3 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${x.action.includes('DELETE') ? 'bg-red-800 text-red-100' : 'bg-gray-700 text-gray-100'}`}>{ACTION[x.action] || x.action}</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-800 text-gray-400">{x.platform} · {conta(x.account_id)}</span>
              <span className="text-sm text-gray-400 flex-1 min-w-48">{x.context}</span>
              <span className="text-xs text-gray-500">drafted by {x.created_by} · {when(x.created_at)} ET{x.approved_by ? ` · approved by ${x.approved_by}` : ''}{x.sent_at ? ` · sent ${when(x.sent_at)} ET` : ''}</span>
            </div>
            {x.status === 'DRAFT' && (x.action === 'MESSAGE_REPLY' || x.action === 'COMMENT_REPLY' || x.action === 'POST_PUBLISH')
              ? <textarea value={edit[x.id] ?? x.body ?? ''} onChange={e => setEdit({ ...edit, [x.id]: e.target.value })} rows={3} className="mt-2 w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-2" />
              : x.body ? <p className="mt-2 whitespace-pre-wrap bg-gray-800 rounded-2xl px-4 py-2">{x.body}</p> : null}
            {x.link && <p className="text-sm text-blue-400 mt-1 break-all">{x.link}</p>}
            {x.error && <p className="text-sm text-red-400 mt-1">{x.error}</p>}
            {x.status === 'DRAFT' && (
              <div className="flex gap-2 mt-2 flex-wrap">
                <button disabled={!!busy || !sw?.publish} onClick={async () => { if (edit[x.id] != null && edit[x.id] !== (x.body ?? '')) { const ok = await act('edit', () => api('/api/social/outbox', { action: 'edit', id: x.id, body: edit[x.id] }), '✓ text saved'); if (!ok) return; x = { ...x, body: edit[x.id] } } await sendDraft(x) }} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm" title={sw?.publish ? '' : 'social.publish.enabled is OFF'}>{busy === 'send' + x.id ? 'SENDING…' : '✓ APPROVE & SEND'}</button>
                {edit[x.id] != null && edit[x.id] !== (x.body ?? '') && <button disabled={!!busy} className={btn} onClick={() => act('edit', () => api('/api/social/outbox', { action: 'edit', id: x.id, body: edit[x.id] }), '✓ text saved')}>SAVE TEXT</button>}
                <button disabled={!!busy} className={btn} onClick={() => act('cancel', () => api('/api/social/outbox', { action: 'cancel', id: x.id }), '✓ draft cancelled')}>CANCEL DRAFT</button>
              </div>
            )}
          </div>
        ))}
      </section>

      {d == null && !erro ? <p className="text-gray-400 text-xl">Loading…</p> : items.length === 0 ? <p className="text-gray-400 text-lg">{f.onlyNew ? 'Nothing new. Switch to ALL to see what was already seen.' : 'Nothing here yet — READ NOW brings the first load.'}</p> : (
        <div className="space-y-2">
          {f.onlyNew && items.length > 1 && <button disabled={!!busy} className={btn} onClick={() => { if (confirm(`Mark the ${items.length} items on screen as seen?`)) void markSeen(items.map(i => i.id)) }}>MARK ALL {items.length} AS SEEN</button>}
          {items.map(it => (
            <div key={it.id} className={`bg-gray-900 border rounded-2xl p-4 ${!it.seen_at && !it.from_me ? 'border-fuchsia-700' : 'border-gray-800'} ${it.gone_at ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-2 flex-wrap">
                <span className="w-36 text-gray-400 text-sm shrink-0">{when(it.happened_at)} ET</span>
                {!it.seen_at && !it.from_me && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-fuchsia-800 text-fuchsia-100">NEW</span>}
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${it.platform === 'FACEBOOK' ? 'bg-blue-900 text-blue-200' : 'bg-pink-900 text-pink-200'}`}>{it.platform}</span>
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-700 text-gray-200">{it.kind}</span>
                {it.folder && <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${it.folder === 'spam' || it.folder === 'other' ? 'bg-red-900 text-red-200' : 'bg-gray-800 text-gray-400'}`}>{FOLDER[it.folder] || it.folder}</span>}
                {it.hidden && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-700 text-gray-300">HIDDEN</span>}
                {it.gone_at && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-700 text-gray-300">DELETED</span>}
                <span className="font-bold">{it.from_me ? `${conta(it.account_id)} → ${it.thread_title || ''}` : it.from_name || it.thread_title || 'unknown'}</span>
                <span className="text-xs text-gray-500 ml-auto">{conta(it.account_id)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-gray-200">{it.body || <span className="text-gray-600">{it.attachments ? `[${it.attachments} attachment${it.attachments > 1 ? 's' : ''}]` : '[no text]'}</span>}{it.body && it.attachments ? <span className="text-gray-500"> [+{it.attachments} attachment{it.attachments > 1 ? 's' : ''}]</span> : null}</p>
              {it.kind !== 'MESSAGE' && it.thread_title && <p className="text-xs text-gray-500 mt-1 truncate">on: {it.thread_title}</p>}
              <div className="flex gap-2 mt-2 flex-wrap">
                <button className={btn} onClick={() => openThread(it)}>{it.kind === 'MESSAGE' ? 'OPEN CONVERSATION' : 'OPEN THREAD'}</button>
                {it.kind === 'COMMENT' && !it.from_me && !it.gone_at && <>
                  <button disabled={!!busy} className={btn} onClick={() => draft(it.hidden ? 'COMMENT_UNHIDE' : 'COMMENT_HIDE', it)}>DRAFT: {it.hidden ? 'UNHIDE' : 'HIDE'}</button>
                  <button disabled={!!busy} className="bg-gray-800 hover:bg-red-900 disabled:opacity-50 px-3 py-1 rounded-xl text-sm font-bold" onClick={() => draft('COMMENT_DELETE', it)}>DRAFT: DELETE</button>
                </>}
                {it.permalink && <a href={it.permalink} target="_blank" rel="noreferrer" className={btn}>OPEN THERE ↗</a>}
                {!it.seen_at && !it.from_me ? <button disabled={!!busy} className={btn} onClick={() => markSeen([it.id])}>MARK SEEN</button> : !it.from_me && <button disabled={!!busy} className="text-xs text-gray-500 hover:text-white" onClick={() => act('unseen', () => api('/api/social/inbox', { action: 'unseen', ids: [it.id] }), '✓ back to NEW')}>back to new</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setOpen(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <h2 className="text-2xl font-bold">{open.kind === 'MESSAGE' ? open.thread_title || 'Conversation' : 'Thread'} <span className="text-sm font-normal text-gray-400">{open.platform} · {conta(open.account_id)}{open.folder ? ' · ' + (FOLDER[open.folder] || open.folder) : ''}</span></h2>
            {open.kind !== 'MESSAGE' && open.thread_title && <p className="text-sm text-gray-400 mt-1">{open.thread_title}</p>}
            <div className="overflow-y-auto flex-1 my-3 space-y-2">
              {thread.map(t => (
                <div key={t.id} className={`max-w-[85%] rounded-2xl px-4 py-2 ${t.from_me ? 'ml-auto bg-blue-900' : 'bg-gray-800'} ${t.parent_id ? 'ml-8' : ''} ${t.id === open.id ? 'ring-2 ring-fuchsia-600' : ''}`}>
                  <p className="text-xs text-gray-400">{t.from_me ? conta(t.account_id) : t.from_name || '—'} · {when(t.happened_at)} ET{t.hidden ? ' · hidden' : ''}{t.gone_at ? ' · deleted' : ''}</p>
                  <p className="whitespace-pre-wrap">{t.body || (t.attachments ? `[${t.attachments} attachment(s)]` : '[no text]')}</p>
                </div>
              ))}
            </div>
            {(open.kind === 'MESSAGE' || open.kind === 'COMMENT') && last && (
              <div>
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3} placeholder={open.kind === 'MESSAGE' ? 'Write the reply — it becomes a DRAFT, it is not sent from here' : 'Write the reply to this comment — it becomes a DRAFT'} className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-2" />
                {open.kind === 'MESSAGE' && <p className="text-xs text-gray-500 mt-1">Meta only lets a page answer within 24 hours of the person&apos;s last message; after that the send is refused and the draft shows the reason.</p>}
              </div>
            )}
            <div className="flex justify-end gap-3 mt-3 flex-wrap">
              <button disabled={!!busy} onClick={() => { if (open.thread_id) void act('seen', () => api('/api/social/inbox', { action: 'seen_thread', thread: open.thread_id }), '✓ thread marked as seen') }} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">MARK THREAD SEEN</button>
              <button onClick={() => setOpen(null)} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">CLOSE</button>
              {(open.kind === 'MESSAGE' || open.kind === 'COMMENT') && last && <button disabled={!!busy || !reply.trim()} onClick={async () => { const alvo = open.kind === 'MESSAGE' ? last : open; if (await draft(open.kind === 'MESSAGE' ? 'MESSAGE_REPLY' : 'COMMENT_REPLY', alvo, reply)) setOpen(null) }} className="bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-5 py-3 rounded-2xl font-bold">SAVE AS DRAFT</button>}
            </div>
          </div>
        </div>
      )}

      {post && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setPost(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl space-y-3" onClick={e => e.stopPropagation()}>
            <h2 className="text-2xl font-bold">+ NEW POST DRAFT <span className="text-sm font-normal text-gray-400">Facebook page · text and link</span></h2>
            <select value={post.account} onChange={e => setPost({ ...post, account: e.target.value })} className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-2 w-full">{(d?.accounts || []).filter(a => a.kind === 'FB_PAGE').map(a => <option key={a.id} value={a.id}>{a.account}</option>)}</select>
            <textarea value={post.body} onChange={e => setPost({ ...post, body: e.target.value })} rows={6} placeholder="Text of the post" className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-2" />
            <input value={post.link} onChange={e => setPost({ ...post, link: e.target.value })} placeholder="Link (optional, https://…)" className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-2" />
            <p className="text-xs text-gray-500">Photos, videos and Instagram posts are not published from here yet. This saves a DRAFT; it goes out only with APPROVE &amp; SEND.</p>
            <div className="flex justify-end gap-3"><button onClick={() => setPost(null)} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">CANCEL</button><button disabled={!!busy || (!post.body.trim() && !post.link.trim())} onClick={async () => { if (await act('draft', () => api('/api/social/outbox', { action: 'draft', kind: 'POST_PUBLISH', account_id: post.account, body: post.body, link: post.link || undefined }), '✓ DRAFT created — waiting for APPROVE & SEND')) setPost(null) }} className="bg-amber-700 hover:bg-amber-600 disabled:opacity-40 px-5 py-3 rounded-2xl font-bold">SAVE AS DRAFT</button></div>
          </div>
        </div>
      )}
    </main>
  )
}
