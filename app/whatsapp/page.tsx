'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Header from '@/components/Header'
import WaBadge from '@/components/WaBadge'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/components/BankReconcileCard'

// WHATSAPP HUB — the two numbers (US + BR) in ONE inbox, read from the
// permanent mirror (whatsapp_messages / whatsapp_chats in the US project).
// Times follow the subject's zone (Orlando for US, Brasília for BR) — never
// raw UTC. Replies go out from here: US via /api/whatsapp, BR via the relay.

type Policy = 'ALL' | 'MENTION_ONLY' | 'IGNORE'
type Chat = {
  app: 'US' | 'BR'; chatId: string; name: string | null; isGroup: boolean
  lastAt: string | null; unread: number | null; policy: Policy
  processedThrough: string | null; pending: boolean
  lastFromMe: boolean | null; lastType: string | null; lastBody: string | null
}

// POLÍTICA DE PAUTA por conversa (ordem do Márcio, 24/ago/2026): há grupos em
// que só interessa quando ELE é marcado — o resto é conversa da equipe.
const POLICY_LABEL: Record<Policy, string> = { ALL: 'TUDO', MENTION_ONLY: 'SÓ SE ME MARCAREM', IGNORE: 'IGNORAR' }
const POLICY_CHIP: Record<Policy, string> = {
  ALL: 'bg-gray-800 text-gray-400 border-gray-700',
  MENTION_ONLY: 'bg-amber-950 text-amber-300 border-amber-800',
  IGNORE: 'bg-red-950 text-red-400 border-red-900',
}
type Msg = {
  id: number; from_me: boolean; author: string | null; pushname: string | null
  type: string; body: string; media_url: string | null; sent_at: string
}
type Hit = {
  app: 'US' | 'BR'; chat_id: string; chat_name: string | null; from_me: boolean
  pushname: string | null; type: string; body: string; media_url: string | null; sent_at: string
}

const ZONE: Record<'US' | 'BR', string> = { US: 'America/New_York', BR: 'America/Sao_Paulo' }

function fmtTime(iso: string | null, app: 'US' | 'BR', withDate = true): string {
  if (!iso) return ''
  const d = new Date(iso)
  const opts: Intl.DateTimeFormatOptions = withDate
    ? { timeZone: ZONE[app], month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { timeZone: ZONE[app], hour: '2-digit', minute: '2-digit', hour12: false }
  return new Intl.DateTimeFormat('en-US', opts).format(d)
}

const APP_CHIP: Record<'US' | 'BR', string> = {
  US: 'bg-blue-950 text-blue-300 border-blue-800',
  BR: 'bg-green-950 text-green-300 border-green-800',
}

const isImage = (t: string | null) => t === 'image' || t === 'sticker'

export default function WhatsAppPage() {
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [appFilter, setAppFilter] = useState<'ALL' | 'US' | 'BR'>('ALL')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [active, setActive] = useState<{ app: 'US' | 'BR'; chatId: string; name: string | null } | null>(null)
  const [msgs, setMsgs] = useState<Msg[] | null>(null)
  const [reply, setReply] = useState('')
  const [personal, setPersonal] = useState(true)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const loadChats = useCallback(async (filter = appFilter) => {
    try {
      const r = await fetch(`${BASE_PATH}/api/whatsapp/inbox?view=chats&app=${filter}`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setChats(d.chats || [])
      setErr('')
    } catch (e) { setErr(String((e as Error).message || e)); setChats(prev => prev ?? []) }
  }, [appFilter])

  const loadMsgs = useCallback(async (c: { app: 'US' | 'BR'; chatId: string }, scroll = true) => {
    const r = await fetch(`${BASE_PATH}/api/whatsapp/inbox?view=messages&app=${c.app}&chatId=${encodeURIComponent(c.chatId)}&limit=100`, { headers: await sessionHeaders() })
    const d = await r.json().catch(() => ({}))
    if (r.ok) {
      setMsgs(d.messages || [])
      if (scroll) setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end' }), 50)
    }
  }, [])

  useEffect(() => { void loadChats() }, [loadChats])

  // Light polling: the mirror is webhook-fed, so 45s keeps the screen honest
  // without hammering anything (it reads our own DB, not UltraMsg).
  useEffect(() => {
    const t = setInterval(() => {
      void loadChats()
      if (activeRef.current) void loadMsgs(activeRef.current, false)
    }, 45_000)
    return () => clearInterval(t)
  }, [loadChats, loadMsgs])

  // Search: 2+ chars searches message bodies (server) — chat names filter locally.
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return }
    const t = setTimeout(async () => {
      const r = await fetch(`${BASE_PATH}/api/whatsapp/inbox?view=search&app=${appFilter}&q=${encodeURIComponent(q.trim())}`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (r.ok) setHits(d.hits || [])
    }, 350)
    return () => clearTimeout(t)
  }, [q, appFilter])

  async function setPolicy(c: Chat, policy: Policy) {
    setChats(prev => (prev || []).map(x => x.chatId === c.chatId ? { ...x, policy } : x))
    const r = await fetch(`${BASE_PATH}/api/whatsapp/inbox`, {
      method: 'POST', headers: await sessionHeaders(),
      body: JSON.stringify({ chatId: c.chatId, app: c.app, policy }),
    })
    if (!r.ok) { setErr('Não consegui salvar a política — recarregue'); void loadChats() }
  }

  // PROCESSADO ATÉ AQUI — fecha a conversa no round. O que chegar depois a
  // reabre sozinho (o servidor guarda a marca d'água na última mensagem atual).
  async function markProcessed(c: Chat, processed: boolean) {
    setChats(prev => (prev || []).map(x => x.chatId === c.chatId ? { ...x, pending: !processed } : x))
    const r = await fetch(`${BASE_PATH}/api/whatsapp/inbox`, {
      method: 'POST', headers: await sessionHeaders(),
      body: JSON.stringify({ chatId: c.chatId, processed }),
    })
    if (!r.ok) { setErr('Não consegui salvar — recarregue') }
    void loadChats()
  }

  function openChat(app: 'US' | 'BR', chatId: string, name: string | null) {
    setActive({ app, chatId, name })
    setMsgs(null)
    setHits(null)
    void loadMsgs({ app, chatId })
  }

  async function send() {
    if (!active || !reply.trim() || sending) return
    setSending(true)
    setErr('')
    try {
      const url = active.app === 'US' ? `${BASE_PATH}/api/whatsapp` : `${BASE_PATH}/api/whatsapp/relay`
      const r = await fetch(url, {
        method: 'POST', headers: await sessionHeaders(),
        body: JSON.stringify({ to: active.chatId, body: reply.trim(), personal }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || d.upstream?.error || `HTTP ${r.status}`)
      // Optimistic append — the webhook (message_create) lands it in the mirror.
      setMsgs(prev => [...(prev || []), {
        id: -Date.now(), from_me: true, author: null, pushname: null,
        type: 'chat', body: reply.trim(), media_url: null, sent_at: new Date().toISOString(),
      }])
      setReply('')
      setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end' }), 50)
      setTimeout(() => { if (activeRef.current) void loadMsgs(activeRef.current, false) }, 4000)
    } catch (e) { setErr(String((e as Error).message || e)) } finally { setSending(false) }
  }

  const visible = (chats || []).filter(c =>
    q.trim().length >= 2 ? (c.name || c.chatId).toLowerCase().includes(q.trim().toLowerCase()) : true
  )
  const awaiting = (chats || []).filter(c => !c.isGroup && c.lastFromMe === false).length
  const pendingCount = (chats || []).filter(c => c.pending).length

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-3 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">WHATSAPP HUB</h1>
        <WaBadge />
      </div>
      <p className="text-gray-400 mb-6 max-w-3xl">Both numbers in one inbox — the permanent mirror of every message. US times in Orlando, BR times in Brasília.</p>

      <div className="flex gap-2 flex-wrap items-center mb-4">
        {(['ALL', 'US', 'BR'] as const).map(f => (
          <button key={f} onClick={() => { setAppFilter(f); setChats(null); void loadChats(f) }}
            className={`px-4 py-2 rounded-full text-sm font-bold border ${appFilter === f ? 'bg-white text-black border-white' : 'bg-gray-900 text-gray-300 border-gray-700 hover:bg-gray-800'}`}>
            {f}
          </button>
        ))}
        {pendingCount > 0 && (
          <span className="px-3 py-1 rounded-full text-xs font-bold border bg-sky-950 text-sky-300 border-sky-800">
            {pendingCount} NO ROUND
          </span>
        )}
        {awaiting > 0 && (
          <span className="px-3 py-1 rounded-full text-xs font-bold border bg-amber-950 text-amber-300 border-amber-800">
            {awaiting} AWAITING REPLY
          </span>
        )}
        <input
          value={q} onChange={e => setQ(e.target.value)} placeholder="SEARCH chats & messages…"
          className="flex-1 min-w-[220px] bg-gray-900 border border-gray-700 rounded-2xl px-4 py-2 text-sm outline-none focus:border-gray-500"
        />
      </div>

      {err && <div className="mb-4 text-sm text-red-400">{err}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        {/* ── Chat list ─────────────────────────────────────────────── */}
        <div className="border border-gray-800 rounded-2xl overflow-hidden max-h-[70vh] overflow-y-auto">
          {hits !== null ? (
            <>
              <div className="px-4 py-2 text-xs font-bold text-gray-500 border-b border-gray-800 sticky top-0 bg-black">MESSAGE HITS · {hits.length}</div>
              {hits.map((h, i) => (
                <button key={i} onClick={() => openChat(h.app, h.chat_id, h.chat_name)}
                  className="w-full text-left px-4 py-3 border-b border-gray-900 hover:bg-gray-900">
                  <div className="flex items-center gap-2 text-sm">
                    <span className={`px-1.5 rounded text-[10px] font-bold border ${APP_CHIP[h.app]}`}>{h.app}</span>
                    <span className="font-bold truncate">{h.chat_name || h.chat_id.replace(/@.*/, '')}</span>
                    <span className="ml-auto text-gray-500 text-xs shrink-0">{fmtTime(h.sent_at, h.app)}</span>
                  </div>
                  <div className="text-xs text-gray-400 truncate mt-0.5">{h.from_me ? '→ ' : ''}{h.body || '[media]'}</div>
                </button>
              ))}
              {!hits.length && <div className="px-4 py-6 text-sm text-gray-500">No message matches.</div>}
            </>
          ) : chats === null ? (
            <div className="px-4 py-6 text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              {visible.map(c => (
                <button key={`${c.app}|${c.chatId}`} onClick={() => openChat(c.app, c.chatId, c.name)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-900 hover:bg-gray-900 ${active?.chatId === c.chatId && active?.app === c.app ? 'bg-gray-900' : ''}`}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={`px-1.5 rounded text-[10px] font-bold border ${APP_CHIP[c.app]}`}>{c.app}</span>
                    <span className="font-bold truncate">{c.name || c.chatId.replace(/@.*/, '')}</span>
                    {c.isGroup && <span className="text-[10px] text-gray-500">GROUP</span>}
                    {!c.pending && <span className="text-emerald-500 text-[10px] shrink-0" title="processada">✓</span>}
                    {c.policy !== 'ALL' && <span className={`px-1.5 rounded text-[9px] font-bold border shrink-0 ${POLICY_CHIP[c.policy]}`}>{POLICY_LABEL[c.policy]}</span>}
                    {!c.isGroup && c.lastFromMe === false && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Awaiting reply" />}
                    <span className="ml-auto text-gray-500 text-xs shrink-0">{fmtTime(c.lastAt, c.app)}</span>
                  </div>
                  <div className="text-xs text-gray-400 truncate mt-0.5">
                    {c.lastFromMe ? '→ ' : ''}{c.lastBody || (c.lastType && c.lastType !== 'chat' ? `[${c.lastType}]` : '')}
                  </div>
                </button>
              ))}
              {!visible.length && <div className="px-4 py-6 text-sm text-gray-500">No chats in the mirror yet — the webhook fills it as messages arrive; the deep sync backfills.</div>}
            </>
          )}
        </div>

        {/* ── Conversation ──────────────────────────────────────────── */}
        <div className="border border-gray-800 rounded-2xl flex flex-col max-h-[70vh]">
          {!active ? (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-sm p-8">Pick a chat.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                <span className={`px-1.5 rounded text-[10px] font-bold border ${APP_CHIP[active.app]}`}>{active.app}</span>
                <span className="font-bold">{active.name || active.chatId.replace(/@.*/, '')}</span>
                {(() => {
                  const c = (chats || []).find(x => x.chatId === active.chatId && x.app === active.app)
                  if (!c) return null
                  return (
                    <select
                      value={c.policy} onChange={e => void setPolicy(c, e.target.value as Policy)}
                      title="Quando esta conversa vira pauta sua"
                      className={`text-[10px] font-bold rounded-full border px-2 py-1 outline-none cursor-pointer ${POLICY_CHIP[c.policy]}`}
                    >
                      {(['ALL', 'MENTION_ONLY', 'IGNORE'] as Policy[]).map(p => (
                        <option key={p} value={p} className="bg-gray-900 text-white">{POLICY_LABEL[p]}</option>
                      ))}
                    </select>
                  )
                })()}
                {(() => {
                  const c = (chats || []).find(x => x.chatId === active.chatId && x.app === active.app)
                  if (!c) return null
                  return (
                    <button onClick={() => void markProcessed(c, c.pending)}
                      title={c.pending ? 'Marcar tudo até a última mensagem como tratado' : 'Reabrir esta conversa no round'}
                      className={`text-[10px] font-bold rounded-full border px-2 py-1 ${c.pending ? 'bg-gray-900 text-gray-300 border-gray-700 hover:bg-gray-800' : 'bg-emerald-950 text-emerald-300 border-emerald-800'}`}>
                      {c.pending ? '○ MARCAR PROCESSADO' : '✓ PROCESSADO'}
                    </button>
                  )
                })()}
                <span className="ml-auto text-xs text-gray-500">{active.app === 'US' ? 'Orlando time' : 'horário de Brasília'}</span>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {msgs === null ? (
                  <div className="text-sm text-gray-500">Loading…</div>
                ) : !msgs.length ? (
                  <div className="text-sm text-gray-500">Nothing mirrored for this chat yet.</div>
                ) : msgs.map(m => (
                  <div key={m.id} className={`max-w-[80%] ${m.from_me ? 'ml-auto' : ''}`}>
                    <div className={`rounded-2xl px-3 py-2 text-sm ${m.from_me ? 'bg-emerald-950 border border-emerald-900' : 'bg-gray-900 border border-gray-800'}`}>
                      {!m.from_me && m.pushname && <div className="text-[11px] font-bold text-blue-300 mb-0.5">{m.pushname}</div>}
                      {m.media_url && (isImage(m.type)
                        ? <a href={m.media_url} target="_blank" rel="noopener noreferrer"><img src={m.media_url} alt="" className="max-h-60 rounded-lg mb-1" /></a>
                        : <a href={m.media_url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:underline mb-1">📎 {m.type}</a>)}
                      {!m.media_url && m.type !== 'chat' && <span className="text-gray-500">[{m.type}] </span>}
                      <span className="whitespace-pre-wrap break-words">{m.body}</span>
                    </div>
                    <div className={`text-[10px] text-gray-600 mt-0.5 ${m.from_me ? 'text-right' : ''}`}>{fmtTime(m.sent_at, active.app)}</div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="border-t border-gray-800 p-3 flex gap-2 items-end">
                <textarea
                  value={reply} onChange={e => setReply(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                  rows={2} placeholder={`Reply as ${personal ? 'Márcio (personal)' : 'the app (signed)'}…`}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded-2xl px-4 py-2 text-sm outline-none focus:border-gray-500 resize-none"
                />
                <label className="flex items-center gap-1 text-[11px] text-gray-400 pb-1 cursor-pointer select-none" title="Off = message goes out with the app signature">
                  <input type="checkbox" checked={personal} onChange={e => setPersonal(e.target.checked)} /> personal
                </label>
                <button onClick={() => void send()} disabled={sending || !reply.trim()}
                  className="px-5 py-2 rounded-2xl font-bold text-sm bg-green-700 hover:bg-green-600 disabled:opacity-40">
                  {sending ? '…' : 'SEND'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
