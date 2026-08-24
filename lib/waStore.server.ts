// SERVER-ONLY — WHATSAPP HUB: o espelho permanente dos 2 WhatsApp no Supabase US.
//
// O problema que isto mata (24/ago/2026): toda leitura de WhatsApp era pull na
// UltraMsg — ~60 chamadas HTTP por rodada, zero histórico (a UltraMsg só guarda
// o que chegou com a instância conectada), link de mídia perdido depois que a
// mensagem passa, e horário em UTC cru. Agora TODA mensagem dos dois números
// (US e BR) vira uma linha em `whatsapp_messages` no projeto US:
//
//   webhook (tempo real, com o PC fechado)  ─┐
//                                            ├─→ whatsapp_messages + whatsapp_chats
//   cron whatsapp-sync (rede de segurança)  ─┘
//
// O app BR grava aqui também (app='BR') via lib/waStoreUS.server.ts — mesmo
// padrão do Parts & Packs compartilhado. Uma rodada de leitura vira UMA query.
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export type WaApp = 'US' | 'BR'

export type WaRow = {
  app: WaApp
  message_id: string
  chat_id: string
  author: string | null
  pushname: string | null
  from_me: boolean
  type: string
  body: string
  media_url: string | null
  sent_at: string
  via: string
  mentioned_ids: string[] | null
}

// Quem foi MARCADO na mensagem. O corpo mostra a marcação como @<LID> (número
// interno do WhatsApp, que NÃO é o telefone), então o texto sozinho não serve
// pra saber se o Márcio foi marcado. A UltraMsg manda os ids de verdade no
// payload — guardamos aqui pra política MENTION_ONLY do grupo funcionar exato.
function mentionsOf(m: any): string[] | null {
  const raw = m?.mentionedIds ?? m?.mentioned_ids ?? m?.mentions ?? m?.quotedMsg?.mentionedIds
  if (!raw) return null
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((x: any) => String(x?._serialized || x?.id || x || '').trim())
    .filter(Boolean)
  return list.length ? list.slice(0, 40) : null
}

export function waDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// Id estável por mensagem. A UltraMsg manda `id` (string ou {_serialized}) no
// webhook e no log da instância; /chats/messages às vezes vem sem — aí o id é
// sintético e determinístico (chat + hora + direção + hash do corpo), pra que
// webhook e sync NUNCA dupliquem a mesma mensagem no espelho.
export function waMsgKey(m: any, chatId: string): string {
  const real = typeof m?.id === 'string' ? m.id : (m?.id?._serialized ? String(m.id._serialized) : '')
  if (real) return real.slice(0, 180)
  const t = Number(m?.time ?? m?.timestamp ?? 0)
  const body = String(m?.body || m?.caption || '') + '|' + String(m?.media || '')
  const h = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)
  return `syn:${chatId}:${t}:${m?.fromMe ? 1 : 0}:${h}`
}

export function waNormalize(m: any, app: WaApp, via: string): WaRow | null {
  const chatId = String(m?.chatId || (m?.fromMe ? m?.to : m?.from) || '').trim()
  if (!chatId.includes('@')) return null
  const t = Number(m?.time ?? m?.timestamp ?? 0)
  return {
    app,
    message_id: waMsgKey(m, chatId),
    chat_id: chatId.slice(0, 120),
    author: m?.author ? String(m.author).slice(0, 120) : (m?.fromMe ? null : String(m?.from || '').slice(0, 120) || null),
    pushname: m?.pushname ? String(m.pushname).slice(0, 120) : null,
    from_me: !!m?.fromMe,
    type: String(m?.type || 'chat').slice(0, 24),
    body: String(m?.body || m?.caption || '').slice(0, 8000),
    media_url: m?.media ? String(m.media).slice(0, 1000) : null,
    sent_at: t ? new Date(t * 1000).toISOString() : new Date().toISOString(),
    via,
    mentioned_ids: mentionsOf(m),
  }
}

// Grava um lote no espelho. `ignoreDuplicates` deixa o que já existe quieto;
// depois um passo de "cura" preenche media_url em linhas que estavam sem (o
// link de mídia só existe no webhook e no log da instância — se o sync chegou
// primeiro sem o link, o log preenche).
export async function waStore(db: SupabaseClient, rows: WaRow[]): Promise<number> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400)
    const { data, error } = await db
      .from('whatsapp_messages')
      .upsert(chunk, { onConflict: 'app,message_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`whatsapp_messages upsert: ${error.message}`)
    inserted += data?.length || 0
  }
  const withMedia = rows.filter(r => r.media_url)
  for (const r of withMedia.slice(0, 60)) {
    await db.from('whatsapp_messages')
      .update({ media_url: r.media_url, type: r.type })
      .eq('app', r.app).eq('message_id', r.message_id).is('media_url', null)
  }
  // Mesma cura pras marcações: o sync (/chats/messages) não traz mentionedIds,
  // só o webhook — se o sync gravou primeiro, o webhook preenche depois.
  for (const r of rows.filter(r => r.mentioned_ids?.length).slice(0, 60)) {
    await db.from('whatsapp_messages')
      .update({ mentioned_ids: r.mentioned_ids })
      .eq('app', r.app).eq('message_id', r.message_id).is('mentioned_ids', null)
  }
  return inserted
}

// Toque leve no snapshot do chat (last_at/is_group) sem clobber no nome — o
// upsert do PostgREST só mexe nas colunas presentes no payload.
export async function waTouchChat(db: SupabaseClient, app: WaApp, chatId: string, lastAt: string) {
  await db.from('whatsapp_chats').upsert(
    { app, chat_id: chatId, is_group: chatId.endsWith('@g.us'), last_at: lastAt },
    { onConflict: 'app,chat_id' }
  )
}

export type WaSyncResult = {
  app: WaApp
  chats: number
  scanned: number
  inserted: number
  logPages: number
  nextStart: number | null
}

// REDE DE SEGURANÇA + BACKFILL. Modo normal (cron 10/10min): atualiza o
// snapshot dos chats e relê só os que mexeram desde o último sync. Modo deep
// (`deep=1`, manual): varre TODOS os chats fundo (limite 200 msgs cada) e
// pagina o log da instância — o único endpoint com link de mídia retroativo.
// `start` retoma uma varredura que estourou o tempo (devolve nextStart).
export async function waSyncInstance(opts: {
  app: WaApp
  instance: string
  token: string
  db: SupabaseClient
  deep?: boolean
  start?: number
  timeBudgetMs?: number
}): Promise<WaSyncResult> {
  const { app, instance, token, db } = opts
  const deep = !!opts.deep
  const start = Math.max(0, opts.start || 0)
  const t0 = Date.now()
  const budget = opts.timeBudgetMs ?? 240_000
  const base = `https://api.ultramsg.com/${instance}`

  const rChats = await fetch(`${base}/chats?token=${encodeURIComponent(token)}`)
  const chatList = await rChats.json().catch(() => null)
  if (!Array.isArray(chatList)) throw new Error('UltraMsg /chats: unexpected response')

  const chats = chatList
    .map((c: any) => ({
      id: String(c.id || ''),
      name: c.name ? String(c.name).slice(0, 160) : null,
      last_at: (c.time ?? c.timestamp) ? new Date(Number(c.time ?? c.timestamp) * 1000).toISOString() : null,
      unread: Number(c.unread ?? c.unreadCount ?? 0) || 0,
    }))
    .filter(c => c.id.includes('@'))

  for (let i = 0; i < chats.length; i += 200) {
    const chunk = chats.slice(i, i + 200).map(c => ({
      app, chat_id: c.id, name: c.name, is_group: c.id.endsWith('@g.us'), last_at: c.last_at, unread: c.unread,
    }))
    const { error } = await db.from('whatsapp_chats').upsert(chunk, { onConflict: 'app,chat_id' })
    if (error) throw new Error(`whatsapp_chats upsert: ${error.message}`)
  }

  // Quem precisa de releitura? Normal: chats com atividade nova desde synced_at.
  const { data: stored } = await db.from('whatsapp_chats')
    .select('chat_id, last_at, synced_at').eq('app', app)
  const syncedAt = new Map((stored || []).map((s: any) => [s.chat_id, s.synced_at]))
  const targets = chats
    .filter(c => {
      if (deep) return true
      const s = syncedAt.get(c.id)
      return !s || (c.last_at && c.last_at > s)
    })
    .sort((a, b) => (b.last_at || '').localeCompare(a.last_at || ''))

  let scanned = 0
  let inserted = 0
  let nextStart: number | null = null
  const perChat = deep ? 200 : 50
  const cap = deep ? targets.length : 25

  for (let i = start; i < Math.min(targets.length, start + cap); i++) {
    if (Date.now() - t0 > budget) { nextStart = i; break }
    const c = targets[i]
    try {
      const r = await fetch(`${base}/chats/messages?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(c.id)}&limit=${perChat}`)
      const data = await r.json().catch(() => null)
      if (Array.isArray(data)) {
        const rows = data.map((m: any) => waNormalize({ chatId: c.id, ...m }, app, 'sync')).filter(Boolean) as WaRow[]
        inserted += await waStore(db, rows)
        scanned++
        await db.from('whatsapp_chats').update({ synced_at: new Date().toISOString() })
          .eq('app', app).eq('chat_id', c.id)
      }
    } catch (e) {
      console.error(`[wa-sync ${app}] chat ${c.id}`, e)
    }
  }

  // Log da instância: carrega mídia retroativa. 1 página no normal, até 6 no deep.
  let logPages = 0
  const maxPages = deep ? 6 : 1
  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() - t0 > budget) break
    try {
      const r = await fetch(`${base}/messages?token=${encodeURIComponent(token)}&limit=100&status=all&sort=desc&page=${page}`)
      const data = await r.json().catch(() => null)
      const msgs = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : null)
      if (!msgs || !msgs.length) break
      const rows = msgs.map((m: any) => waNormalize(m, app, 'sync')).filter(Boolean) as WaRow[]
      inserted += await waStore(db, rows)
      logPages = page
    } catch (e) {
      console.error(`[wa-sync ${app}] log page ${page}`, e)
      break
    }
  }

  return { app, chats: chats.length, scanned, inserted, logPages, nextStart }
}
