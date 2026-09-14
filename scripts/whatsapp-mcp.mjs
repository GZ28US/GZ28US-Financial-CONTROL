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
// SMS (14/set/2026, Márcio: «inclua os SMSs nas pesquisas, em tudo!»): os SMS/iMessage
// que CHEGAM no iPhone US (atalho do iOS → /api/sms/webhook → sms_messages) entram
// nas quatro leituras, no formato de mensagem: app 'SMS', chatId `sms:<remetente>`,
// fromMe false, type 'sms', horário de Orlando. `source` (WHATSAPP|SMS) restringe a
// um canal; app US/BR = só o WhatsApp daquele número; app SMS = só SMS.
// wa_unanswered mostra o SMS numa seção À PARTE, «sem dado de resposta»: o iPhone não
// entrega o SMS que o Márcio MANDA, então nunca dá pra dizer que um SMS espera resposta.
// wa_send não manda SMS.
//
// Segredos: lidos de arquivos no diretório de memória (nunca argv/env do repo).
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const US_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
const KEY_DIR = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory'
const SEND_URL = { US: 'https://www.gz28us.com/ca/api/whatsapp', BR: 'https://www.gz28br.com/ca/api/whatsapp' }
// SMS chega no iPhone US → Orlando.
const ZONE = { US: 'America/New_York', BR: 'America/Sao_Paulo', SMS: 'America/New_York' }

let SERVICE_KEY = ''
try { SERVICE_KEY = readFileSync(`${KEY_DIR}/us-service-key.txt`, 'utf8').trim().split(/\s+/).pop() } catch { /* handled per call */ }

const HDRS = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` })

// CHAVE DE ENVIO (11/set/2026): a rota de envio dos dois apps só aceita tela logada
// ou o header x-send-key. Lida a cada envio (troca de chave não pede reiniciar o
// servidor): whatsapp-send-key.txt quando existir, senão a de leitura — que segue
// valendo para mandar enquanto WHATSAPP_SEND_KEY não entrar no ambiente. Nunca impressa.
function sendKey() {
  for (const file of ['whatsapp-send-key.txt', 'whatsapp-read-key.txt']) {
    try {
      const k = readFileSync(`${KEY_DIR}/${file}`, 'utf8').trim().split(/\s+/).pop()
      if (k) return k
    } catch { /* tenta o próximo arquivo */ }
  }
  return ''
}

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

// ── SMS ──────────────────────────────────────────────────────────────────────
const SMS_NOTE = 'SMS/iMessage received on the US iPhone (iOS Shortcut). Only INCOMING texts are captured — what Márcio sends by SMS is not, so there is no reply/processed data for SMS.'
const isSms = (chatId) => String(chatId || '').startsWith('sms:')
const smsChatId = (sender) => `sms:${sender || ''}`
// Filtro PostgREST de uma conversa `sms:<remetente>` (vazio = gravado sem remetente).
const smsSenderFilter = (chatId) => {
  const sender = String(chatId).slice(4)
  return sender ? `sender=eq.${encodeURIComponent(sender)}` : 'sender=is.null'
}
// Quais canais uma chamada quer. app US/BR = WhatsApp daquele número; app SMS = só SMS;
// chatId decide sozinho; source WHATSAPP|SMS restringe.
function channels(a) {
  let wa = a.source !== 'SMS' && a.app !== 'SMS'
  let sms = a.source !== 'WHATSAPP' && (!a.app || a.app === 'SMS')
  if (a.chatId) { wa = wa && !isSms(a.chatId); sms = sms && isSms(a.chatId) }
  return { wa, sms }
}
const smsRead = async (path) => {
  try { return await rest(path) } catch (e) {
    throw new Error(`SMS read failed (${e.message || e}) — pass source:"WHATSAPP" to read WhatsApp only`)
  }
}
// Conversas de SMS (uma por remetente), a mais nova primeiro. Pagina de 1000 em 1000
// (teto calado do PostgREST).
async function smsThreads({ since, q, maxRows = 10000 } = {}) {
  const threads = new Map()
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const parts = ['select=id,sender,body,received_at', 'order=received_at.desc,id.desc', 'limit=1000', `offset=${offset}`]
    if (since) parts.push(`received_at=gte.${encodeURIComponent(since)}`)
    if (q) parts.push(`sender=ilike.*${encodeURIComponent(esc(q))}*`)
    const rows = await smsRead(`sms_messages?${parts.join('&')}`)
    for (const r of rows) {
      const id = smsChatId(r.sender)
      const t = threads.get(id)
      if (t) t.count++
      else threads.set(id, { chatId: id, sender: r.sender, lastAtIso: r.received_at, last: r.body || '', count: 1 })
    }
    if (rows.length < 1000) break
  }
  return [...threads.values()]
}

// ── ferramentas ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'wa_chats',
    description: 'List conversations from the permanent mirror: WhatsApp chats (both numbers) AND SMS conversations received on the US iPhone (one per sender, app "SMS", chatId "sms:<sender>"), merged by last activity. Returns chat id, app (US/BR/SMS), source (WHATSAPP/SMS), name, group flag, unread, last message preview and local time (Orlando for US and SMS, Brasília for BR). SMS has lastFromMe null: replies are not captured.',
    inputSchema: { type: 'object', properties: {
      app: { type: 'string', enum: ['US', 'BR', 'SMS'], description: 'US/BR = WhatsApp of that number only; SMS = SMS only; omit for all' },
      source: { type: 'string', enum: ['WHATSAPP', 'SMS'], description: 'Restrict to one channel; omit for both' },
      q: { type: 'string', description: 'Filter by chat name (ilike); for SMS, by sender' },
      limit: { type: 'number', description: 'Max chats (default 40)' },
    } },
  },
  {
    name: 'wa_messages',
    description: 'Read one conversation from the mirror: a WhatsApp chat (chatId …@c.us/…@g.us + app US|BR) or an SMS conversation (chatId "sms:<sender>" as returned by wa_chats/wa_search; app not needed). Times are localized (US and SMS=Orlando, BR=Brasília). Media messages carry their stored URL. SMS conversations only contain incoming texts.',
    inputSchema: { type: 'object', required: ['chatId'], properties: {
      chatId: { type: 'string', description: 'e.g. 55119...@c.us, 1203...@g.us or sms:+14075551234' },
      app: { type: 'string', enum: ['US', 'BR', 'SMS'], description: 'Required for WhatsApp chats; ignored for sms: chats' },
      limit: { type: 'number', description: 'Max messages (default 50, newest last)' },
      since: { type: 'string', description: 'ISO timestamp — only messages after this' },
    } },
  },
  {
    name: 'wa_search',
    description: 'Full-text (ilike) search over the body of every mirrored WhatsApp message (both numbers) AND every SMS received on the US iPhone, merged newest first. SMS hits have app "SMS", source "SMS", chatId "sms:<sender>", who = sender.',
    inputSchema: { type: 'object', required: ['q'], properties: {
      q: { type: 'string' },
      app: { type: 'string', enum: ['US', 'BR', 'SMS'], description: 'US/BR = WhatsApp of that number only; SMS = SMS only; omit for all' },
      source: { type: 'string', enum: ['WHATSAPP', 'SMS'], description: 'Restrict to one channel; omit for both' },
      chatId: { type: 'string', description: 'Restrict to one chat (…@c.us / …@g.us / sms:<sender>)' },
      limit: { type: 'number', description: 'Default 30' },
    } },
  },
  {
    name: 'wa_unanswered',
    description: 'Returns { whatsapp, sms }. whatsapp = direct (non-group) WhatsApp chats whose LAST message is from the other side — i.e. possibly awaiting Márcio\'s reply, oldest wait first. sms = a SEPARATE "no reply data" section: SMS conversations with texts received in the last smsDays (default 3), newest first — Márcio\'s SMS replies are not captured, so these are NOT known to be unanswered; check before treating one as pending.',
    inputSchema: { type: 'object', properties: {
      app: { type: 'string', enum: ['US', 'BR', 'SMS'], description: 'US/BR = WhatsApp of that number only (no sms section); SMS = sms section only; omit for all' },
      source: { type: 'string', enum: ['WHATSAPP', 'SMS'], description: 'Restrict to one channel; omit for both' },
      hours: { type: 'number', description: 'Only waits older than this many hours (default 0)' },
      smsDays: { type: 'number', description: 'Window of the sms section in days (default 3)' },
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
    const limit = Math.min(a.limit || 40, 200)
    const want = channels(a)
    const rows = [] // { iso, out }
    if (want.wa) {
      const parts = ['select=*', 'order=last_at.desc.nullslast', `limit=${limit}`]
      if (a.app) parts.push(`app=eq.${a.app}`)
      if (a.q) parts.push(`name=ilike.*${encodeURIComponent(esc(a.q))}*`)
      const chats = await rest(`whatsapp_chats?${parts.join('&')}`)
      for (const c of chats) {
        const m = (await rest(`whatsapp_messages?app=eq.${c.app}&chat_id=eq.${encodeURIComponent(c.chat_id)}&select=from_me,type,body,media_url,sent_at&order=sent_at.desc&limit=1`))[0]
        const iso = m?.sent_at || c.last_at || null
        rows.push({ iso, out: {
          app: c.app, source: 'WHATSAPP', chatId: c.chat_id, name: c.name, isGroup: c.is_group, unread: c.unread,
          lastAt: localTime(iso, c.app),
          lastFromMe: m ? !!m.from_me : null,
          last: m ? (m.body || `[${m.type}]`).slice(0, 120) : null,
        } })
      }
    }
    if (want.sms) {
      for (const t of (await smsThreads({ q: a.q })).slice(0, limit)) {
        rows.push({ iso: t.lastAtIso, out: {
          app: 'SMS', source: 'SMS', chatId: t.chatId, name: t.sender, isGroup: false, unread: null,
          lastAt: localTime(t.lastAtIso, 'SMS'),
          lastFromMe: null, // resposta por SMS não é capturada
          last: t.last.slice(0, 120),
        } })
      }
    }
    // Os dois canais juntos, pela hora da última mensagem (sem hora vai pro fim).
    if (want.wa && want.sms) rows.sort((x, y) => String(y.iso || '').localeCompare(String(x.iso || '')))
    return rows.slice(0, limit).map(r => r.out)
  }

  if (name === 'wa_messages') {
    if (isSms(a.chatId) || a.app === 'SMS') {
      const chatId = isSms(a.chatId) ? a.chatId : smsChatId(a.chatId)
      const parts = [
        smsSenderFilter(chatId), 'select=id,sender,body,received_at',
        'order=received_at.desc', `limit=${Math.min(a.limit || 50, 300)}`,
      ]
      if (a.since) parts.push(`received_at=gt.${encodeURIComponent(a.since)}`)
      const rows = await smsRead(`sms_messages?${parts.join('&')}`)
      return rows.reverse().map(r => ({
        time: localTime(r.received_at, 'SMS'), fromMe: false,
        who: r.sender, type: 'sms', body: r.body, media: null,
      }))
    }
    if (a.app !== 'US' && a.app !== 'BR') throw new Error('app (US|BR) is required for WhatsApp chats (sms:<sender> chats need no app)')
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
    const limit = Math.min(a.limit || 30, 100)
    const want = channels(a)
    const rows = [] // { iso, out }
    if (want.wa) {
      const parts = [
        `body=ilike.*${encodeURIComponent(esc(a.q))}*`,
        'select=app,chat_id,from_me,pushname,type,body,media_url,sent_at',
        'order=sent_at.desc', `limit=${limit}`,
      ]
      if (a.app) parts.push(`app=eq.${a.app}`)
      if (a.chatId) parts.push(`chat_id=eq.${encodeURIComponent(a.chatId)}`)
      for (const m of await rest(`whatsapp_messages?${parts.join('&')}`)) {
        rows.push({ iso: m.sent_at, out: {
          app: m.app, source: 'WHATSAPP', chatId: m.chat_id, time: localTime(m.sent_at, m.app),
          fromMe: m.from_me, who: m.from_me ? 'me' : (m.pushname || null),
          body: (m.body || '').slice(0, 300), media: m.media_url,
        } })
      }
    }
    if (want.sms) {
      const parts = [
        `body=ilike.*${encodeURIComponent(esc(a.q))}*`,
        'select=id,sender,body,received_at',
        'order=received_at.desc', `limit=${limit}`,
      ]
      if (a.chatId) parts.push(smsSenderFilter(a.chatId))
      for (const r of await smsRead(`sms_messages?${parts.join('&')}`)) {
        rows.push({ iso: r.received_at, out: {
          app: 'SMS', source: 'SMS', chatId: smsChatId(r.sender), time: localTime(r.received_at, 'SMS'),
          fromMe: false, who: r.sender, body: (r.body || '').slice(0, 300), media: null,
        } })
      }
    }
    rows.sort((x, y) => String(y.iso).localeCompare(String(x.iso)))
    return rows.slice(0, limit).map(r => r.out)
  }

  if (name === 'wa_unanswered') {
    const want = channels(a)
    const cutoff = Date.now() - (a.hours || 0) * 3600_000
    const out = []
    if (want.wa) {
      const parts = ['select=app,chat_id,from_me,pushname,body,sent_at', 'order=sent_at.desc', 'limit=800', 'chat_id=like.*%40c.us']
      if (a.app) parts.push(`app=eq.${a.app}`)
      const msgs = await rest(`whatsapp_messages?${parts.join('&')}`)
      const seen = new Map()
      for (const m of msgs) {
        const k = `${m.app}|${m.chat_id}`
        if (!seen.has(k)) seen.set(k, m)
      }
      const waiting = [...seen.values()].filter(m => !m.from_me && new Date(m.sent_at).getTime() < cutoff)
      waiting.sort((x, y) => x.sent_at.localeCompare(y.sent_at))
      for (const m of waiting) {
        const c = (await rest(`whatsapp_chats?app=eq.${m.app}&chat_id=eq.${encodeURIComponent(m.chat_id)}&select=name&limit=1`))[0]
        out.push({ app: m.app, chatId: m.chat_id, name: c?.name || null, who: m.pushname || null, since: localTime(m.sent_at, m.app), last: (m.body || '[media]').slice(0, 160) })
      }
    }
    if (!want.sms) return { whatsapp: out }
    // SMS À PARTE: sem dado de resposta, então nunca «esperando» — só o que chegou na janela.
    const smsDays = a.smsDays || 3
    const since = new Date(Date.now() - smsDays * 864e5).toISOString()
    const threads = (await smsThreads({ since })).filter(t => new Date(t.lastAtIso).getTime() < cutoff)
    return {
      whatsapp: out,
      sms: {
        note: SMS_NOTE, windowDays: smsDays,
        threads: threads.map(t => ({ app: 'SMS', chatId: t.chatId, name: t.sender, lastAt: localTime(t.lastAtIso, 'SMS'), count: t.count, last: t.last.slice(0, 160) })),
      },
    }
  }

  if (name === 'wa_send') {
    if (isSms(a.to) || !SEND_URL[a.app]) throw new Error('wa_send sends WhatsApp only (app US|BR) — SMS cannot be sent from here')
    const key = sendKey()
    if (!key) throw new Error(`send key not found at ${KEY_DIR}/whatsapp-send-key.txt or whatsapp-read-key.txt`)
    const r = await fetch(SEND_URL[a.app], {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-send-key': key },
      body: JSON.stringify({ to: a.to, body: a.body, personal: a.personal !== false }),
    })
    const data = await r.json().catch(() => null)
    // 401 = a rota não reconheceu a chave. Enquanto WHATSAPP_SEND_KEY não existir na Vercel, os
    // dois apps aceitam a chave de LEITURA — que é a MESMA no US e no BR (medido em 11/set/2026: o
    // /api/health/env dos dois abre com a whatsapp-read-key.txt). Quando a de envio entrar nos dois
    // projetos, a whatsapp-send-key.txt tem de existir aqui com o mesmo valor.
    if (r.status === 401) throw new Error(`send refused 401 by ${a.app}: key not accepted — needs ${KEY_DIR}/whatsapp-send-key.txt matching WHATSAPP_SEND_KEY on that app (or the read key while WHATSAPP_SEND_KEY is unset)`)
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
