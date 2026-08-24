#!/usr/bin/env node
// WHATSAPP HUB — MCP server local (stdio, JSON-RPC newline-delimited, zero deps).
// Dá à assistente ferramentas NATIVAS sobre o espelho permanente dos 2 WhatsApp
// (whatsapp_messages / whatsapp_chats no Supabase US) em vez de dezenas de
// chamadas HTTP à UltraMsg por rodada:
//
//   wa_chats       lista de conversas (app, busca por nome) + última mensagem
//   wa_messages    uma conversa, horário já no fuso certo (Orlando/Brasília)
//   wa_search      busca no corpo de TODAS as mensagens espelhadas
//   wa_unanswered  chats diretos cuja última mensagem é do outro lado
//   wa_send        envia pela rota do app certo (US ou BR) — LEI: só com
//                  autorização literal do Márcio (never-send-unauthorized)
//
// Segredos: lidos de arquivos no diretório de memória (nunca argv/env do repo).
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const US_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
const KEY_DIR = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory'
const SEND_URL = { US: 'https://www.gz28us.com/ca/api/whatsapp', BR: 'https://www.gz28br.com/ca/api/whatsapp' }
const ZONE = { US: 'America/New_York', BR: 'America/Sao_Paulo' }

let SERVICE_KEY = ''
try { SERVICE_KEY = readFileSync(`${KEY_DIR}/us-service-key.txt`, 'utf8').trim().split(/\s+/).pop() } catch { /* handled per call */ }

const HDRS = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` })

async function rest(path) {
  if (!SERVICE_KEY) throw new Error(`service key not found at ${KEY_DIR}/us-service-key.txt`)
  const r = await fetch(`${US_URL}/rest/v1/${path}`, { headers: HDRS() })
  if (!r.ok) throw new Error(`PostgREST ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

const localTime = (iso, app) => iso
  ? new Intl.DateTimeFormat('en-US', { timeZone: ZONE[app] || ZONE.US, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  : null

const esc = (s) => String(s).replace(/[%_*,()]/g, ' ').trim()

// ── ferramentas ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'wa_chats',
    description: 'List WhatsApp chats from the permanent mirror (both numbers). Returns chat id, app (US/BR), name, group flag, unread, last message preview and local time (Orlando for US, Brasília for BR).',
    inputSchema: { type: 'object', properties: {
      app: { type: 'string', enum: ['US', 'BR'], description: 'Filter by number; omit for both' },
      q: { type: 'string', description: 'Filter by chat name (ilike)' },
      limit: { type: 'number', description: 'Max chats (default 40)' },
    } },
  },
  {
    name: 'wa_messages',
    description: 'Read one WhatsApp conversation from the mirror. Times are localized (US=Orlando, BR=Brasília). Media messages carry their stored URL.',
    inputSchema: { type: 'object', required: ['chatId', 'app'], properties: {
      chatId: { type: 'string', description: 'e.g. 55119...@c.us or 1203...@g.us' },
      app: { type: 'string', enum: ['US', 'BR'] },
      limit: { type: 'number', description: 'Max messages (default 50, newest last)' },
      since: { type: 'string', description: 'ISO timestamp — only messages after this' },
    } },
  },
  {
    name: 'wa_search',
    description: 'Full-text (ilike) search over the body of every mirrored WhatsApp message, both numbers, newest first.',
    inputSchema: { type: 'object', required: ['q'], properties: {
      q: { type: 'string' },
      app: { type: 'string', enum: ['US', 'BR'] },
      chatId: { type: 'string', description: 'Restrict to one chat' },
      limit: { type: 'number', description: 'Default 30' },
    } },
  },
  {
    name: 'wa_unanswered',
    description: 'Direct (non-group) chats whose LAST message is from the other side — i.e. possibly awaiting Márcio\'s reply. Sorted oldest wait first.',
    inputSchema: { type: 'object', properties: {
      app: { type: 'string', enum: ['US', 'BR'] },
      hours: { type: 'number', description: 'Only waits older than this many hours (default 0)' },
    } },
  },
  {
    name: 'wa_send',
    description: 'Send a WhatsApp message through the right app (US or BR instance). personal=true sends in Márcio\'s own voice (no app signature). LAW: only use with Márcio\'s literal authorization.',
    inputSchema: { type: 'object', required: ['app', 'to', 'body'], properties: {
      app: { type: 'string', enum: ['US', 'BR'] },
      to: { type: 'string', description: 'chat id (…@c.us / …@g.us) or bare number' },
      body: { type: 'string' },
      personal: { type: 'boolean', description: 'true = no app signature (default true)' },
    } },
  },
]

async function callTool(name, a = {}) {
  if (name === 'wa_chats') {
    const parts = ['select=*', 'order=last_at.desc.nullslast', `limit=${Math.min(a.limit || 40, 200)}`]
    if (a.app) parts.push(`app=eq.${a.app}`)
    if (a.q) parts.push(`name=ilike.*${encodeURIComponent(esc(a.q))}*`)
    const chats = await rest(`whatsapp_chats?${parts.join('&')}`)
    const out = []
    for (const c of chats) {
      const m = (await rest(`whatsapp_messages?app=eq.${c.app}&chat_id=eq.${encodeURIComponent(c.chat_id)}&select=from_me,type,body,media_url,sent_at&order=sent_at.desc&limit=1`))[0]
      out.push({
        app: c.app, chatId: c.chat_id, name: c.name, isGroup: c.is_group, unread: c.unread,
        lastAt: localTime(m?.sent_at || c.last_at, c.app),
        lastFromMe: m ? !!m.from_me : null,
        last: m ? (m.body || `[${m.type}]`).slice(0, 120) : null,
      })
    }
    return out
  }

  if (name === 'wa_messages') {
    const parts = [
      `app=eq.${a.app}`, `chat_id=eq.${encodeURIComponent(a.chatId)}`,
      'select=from_me,author,pushname,type,body,media_url,sent_at',
      'order=sent_at.desc', `limit=${Math.min(a.limit || 50, 300)}`,
    ]
    if (a.since) parts.push(`sent_at=gt.${encodeURIComponent(a.since)}`)
    const msgs = await rest(`whatsapp_messages?${parts.join('&')}`)
    return msgs.reverse().map(m => ({
      time: localTime(m.sent_at, a.app), fromMe: m.from_me,
      who: m.from_me ? 'me' : (m.pushname || m.author || null),
      type: m.type, body: m.body, media: m.media_url,
    }))
  }

  if (name === 'wa_search') {
    const parts = [
      `body=ilike.*${encodeURIComponent(esc(a.q))}*`,
      'select=app,chat_id,from_me,pushname,type,body,media_url,sent_at',
      'order=sent_at.desc', `limit=${Math.min(a.limit || 30, 100)}`,
    ]
    if (a.app) parts.push(`app=eq.${a.app}`)
    if (a.chatId) parts.push(`chat_id=eq.${encodeURIComponent(a.chatId)}`)
    const hits = await rest(`whatsapp_messages?${parts.join('&')}`)
    return hits.map(m => ({
      app: m.app, chatId: m.chat_id, time: localTime(m.sent_at, m.app),
      fromMe: m.from_me, who: m.from_me ? 'me' : (m.pushname || null),
      body: (m.body || '').slice(0, 300), media: m.media_url,
    }))
  }

  if (name === 'wa_unanswered') {
    const parts = ['select=app,chat_id,from_me,pushname,body,sent_at', 'order=sent_at.desc', 'limit=800', 'chat_id=like.*%40c.us']
    if (a.app) parts.push(`app=eq.${a.app}`)
    const msgs = await rest(`whatsapp_messages?${parts.join('&')}`)
    const seen = new Map()
    for (const m of msgs) {
      const k = `${m.app}|${m.chat_id}`
      if (!seen.has(k)) seen.set(k, m)
    }
    const cutoff = Date.now() - (a.hours || 0) * 3600_000
    const waiting = [...seen.values()].filter(m => !m.from_me && new Date(m.sent_at).getTime() < cutoff)
    waiting.sort((x, y) => x.sent_at.localeCompare(y.sent_at))
    const out = []
    for (const m of waiting) {
      const c = (await rest(`whatsapp_chats?app=eq.${m.app}&chat_id=eq.${encodeURIComponent(m.chat_id)}&select=name&limit=1`))[0]
      out.push({ app: m.app, chatId: m.chat_id, name: c?.name || null, who: m.pushname || null, since: localTime(m.sent_at, m.app), last: (m.body || '[media]').slice(0, 160) })
    }
    return out
  }

  if (name === 'wa_send') {
    const r = await fetch(SEND_URL[a.app], {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: a.to, body: a.body, personal: a.personal !== false }),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`send failed ${r.status}: ${JSON.stringify(data).slice(0, 300)}`)
    return { ok: true, app: a.app, to: a.to, upstream: data }
  }

  throw new Error(`unknown tool: ${name}`)
}

// ── protocolo MCP (stdio) ────────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'gz28-whatsapp', version: '0.1.0' },
    } })
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // notificações — sem resposta
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ERROR: ${e.message || e}` }], isError: true } })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
