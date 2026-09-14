// SERVER-ONLY — O SMS DO iPHONE US NAS MESMAS BUSCAS DO WHATSAPP.
//
// Ordem do Márcio (14/set/2026): «inclua os SMSs nas pesquisas, em tudo!». Desde
// 13/set à noite, todo SMS/iMessage que chega no iPhone do número US é POSTado pelo
// Atalhos do iOS em /api/sms/webhook e vira linha em `sms_messages` (RLS ligado, só
// service role — a tela nunca lê direto, sempre por uma rota com o portão dela).
//
// Um SMS aparece onde a mensagem do WhatsApp aparece, no MESMO formato de linha do
// espelho: app 'SMS', conversa `sms:<remetente>`, from_me false, type 'sms',
// sent_at = received_at, horário de Orlando (é o iPhone US).
//
// O que o SMS NÃO tem, e por quê: resposta (o iPhone não entrega ao Atalhos o SMS que
// ELE mandou — só o que chega), marca d'água de «processado» e política de pauta
// (essas moram em whatsapp_chats, tabela do WhatsApp). Por isso quem lista pendência
// mostra o SMS numa seção à parte, «sem dado de resposta», e nunca como «esperando».
// Não há importação retroativa: não existe fonte dos SMS antigos.
import type { SupabaseClient } from '@supabase/supabase-js'

export const SMS_APP = 'SMS' as const
export const SMS_ZONE = 'America/New_York'
const PREFIX = 'sms:'

export const isSmsChat = (chatId: string | null | undefined) => String(chatId || '').startsWith(PREFIX)
export const smsChatId = (sender: string | null) => `${PREFIX}${sender || ''}`
/** Remetente de uma conversa `sms:<remetente>`; null = SMS gravado sem remetente. */
export const smsSenderOf = (chatId: string) => chatId.slice(PREFIX.length) || null

export const SMS_NOTE = 'SMS/iMessage recebidos no iPhone US (atalho do iOS). Só o que CHEGA é capturado: o que o Márcio responde pelo iPhone não entra, então não há «última palavra dele» nem marca de processado para SMS.'

export type SmsRow = { id: string; sender: string | null; body: string | null; received_at: string }

export type SmsThread = {
  chatId: string
  sender: string | null
  lastAt: string
  lastBody: string
  count: number
}

const COLS = 'id, sender, body, received_at'

// O SMS no formato de linha do espelho do WhatsApp.
export function smsAsMessage(r: SmsRow) {
  return {
    id: r.id,
    app: SMS_APP,
    chat_id: smsChatId(r.sender),
    from_me: false,
    author: r.sender,
    pushname: r.sender,
    type: 'sms',
    body: r.body || '',
    media_url: null as string | null,
    sent_at: r.received_at,
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const bySender = (sel: any, chatId: string) => {
  const sender = smsSenderOf(chatId)
  return sender === null ? sel.is('sender', null) : sel.eq('sender', sender)
}

/** Busca no corpo dos SMS, mais novo primeiro. `chatId` = só uma conversa `sms:<remetente>`. */
export async function smsSearch(db: SupabaseClient, q: string, limit: number, chatId?: string): Promise<SmsRow[]> {
  let sel: any = db.from('sms_messages').select(COLS)
    .ilike('body', `%${q}%`)
    .order('received_at', { ascending: false }).limit(limit)
  if (chatId) sel = bySender(sel, chatId)
  const { data, error } = await sel
  if (error) throw new Error(`sms_messages: ${error.message}`)
  return (data || []) as SmsRow[]
}

/** Uma conversa `sms:<remetente>`, mais novo primeiro (quem mostra inverte). */
export async function smsOfChat(db: SupabaseClient, chatId: string, opts: { limit: number; before?: string | null; since?: string | null }): Promise<SmsRow[]> {
  let sel: any = db.from('sms_messages').select(COLS)
    .order('received_at', { ascending: false }).limit(opts.limit)
  sel = bySender(sel, chatId)
  if (opts.before) sel = sel.lt('received_at', opts.before)
  if (opts.since) sel = sel.gt('received_at', opts.since)
  const { data, error } = await sel
  if (error) throw new Error(`sms_messages: ${error.message}`)
  return (data || []) as SmsRow[]
}

/**
 * As conversas de SMS (uma por remetente), a de mensagem mais nova primeiro.
 * `since` = só o que chegou desde então; `q` = remetente contém. Pagina de 1000 em
 * 1000 porque o PostgREST corta em 1000 linhas calado (a lição do round, 24/ago).
 */
export async function smsThreads(db: SupabaseClient, opts: { since?: string | null; q?: string | null; maxRows?: number } = {}): Promise<SmsThread[]> {
  const size = 1000
  const maxRows = opts.maxRows ?? 10000
  const threads = new Map<string, SmsThread>()
  for (let from = 0; from < maxRows; from += size) {
    let sel: any = db.from('sms_messages').select(COLS)
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
    if (opts.since) sel = sel.gte('received_at', opts.since)
    if (opts.q) sel = sel.ilike('sender', `%${opts.q}%`)
    const { data, error } = await sel.range(from, from + size - 1)
    if (error) throw new Error(`sms_messages: ${error.message}`)
    const rows = (data || []) as SmsRow[]
    for (const r of rows) {
      const chatId = smsChatId(r.sender)
      const t = threads.get(chatId)
      if (t) t.count++
      else threads.set(chatId, { chatId, sender: r.sender, lastAt: r.received_at, lastBody: r.body || '', count: 1 })
    }
    if (rows.length < size) break
  }
  return [...threads.values()]
}
