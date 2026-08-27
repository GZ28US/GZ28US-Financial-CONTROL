// SERVER-ONLY — MAIL WATCH (27/ago/2026). Ele pediu um aviso na hora em que o
// Bradenton/FL2K responder os dois e-mails do caso Street Car Shootout. Por
// [[auto-by-app-rule]] e [[claudinha-is-an-interface]] isso não vira script no PC
// dele: vira watcher do app, rodando no mail-poll de 5 min com o PC fechado.
//
// E não vira watcher DO FL2K — vira watcher GENÉRICO com a regra numa tabela
// (`mail_watches`). Da próxima vez que ele quiser ser avisado da resposta de um
// fornecedor, de um advogado ou de um comprador, é um INSERT, não um deploy.
//
// Casa a CAIXA INTEIRA (mesma lição do [[zelle-watch]]: o organizer arquiva em
// minutos, pasta nenhuma pode esconder a resposta) e ignora o que saiu da própria
// conta — senão o watcher se alarma com o e-mail que nós mesmos mandamos.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

const G = 'https://graph.microsoft.com/v1.0'
const SIGNATURE = 'Sent by GZ28US Control App®'
const FIRST_RUN_MIN = 60
const GRAPH_SLOTS = [1, 2, 3] // slot 4 = Gmail, refresh próprio — fora deste watcher por enquanto

export type MailWatch = {
  id: string
  label: string
  slot: number
  from_pattern: string | null
  subject_pattern: string | null
  notify_to: string
  active: boolean
  hits: number
}

async function wa(to: string, body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

const clean = (h: string) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const has = (hay: string, needle: string | null) => !needle || String(hay || '').toLowerCase().includes(needle.toLowerCase())

export function matches(w: MailWatch, fromAddr: string, subject: string): boolean {
  if (!w.from_pattern && !w.subject_pattern) return false // regra vazia nunca casa com tudo
  return has(fromAddr, w.from_pattern) && has(subject, w.subject_pattern)
}

export async function runMailWatch(db: SupabaseClient): Promise<{ alerts: string[] }> {
  const alerts: string[] = []

  const { data: rows } = await db.from('mail_watches').select('*').eq('active', true)
  const watches = (rows || []) as MailWatch[]
  if (!watches.length) return { alerts }

  for (const slot of GRAPH_SLOTS) {
    const slotWatches = watches.filter(w => Number(w.slot) === slot)
    if (!slotWatches.length) continue

    const auth = await getMailAuth(db, slot)
    if (!auth) continue
    const token = await freshAccessToken(db, auth)
    if (!token) continue
    const self = String(auth.account || '').toLowerCase()

    const stateId = `mail-watch-${slot}`
    const runStart = new Date().toISOString()
    const { data: st } = await db.from('whatsapp_polling_state').select('*').eq('id', stateId).limit(1)
    const cursor = st?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()

    // Caixa inteira, não só a inbox.
    const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=subject,from,receivedDateTime,body&$orderby=receivedDateTime desc`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => null)

    for (const m of res?.value || []) {
      const fromAddr = String(m.from?.emailAddress?.address || '').toLowerCase()
      if (!fromAddr || fromAddr === self) continue // o que NÓS mandamos não é resposta
      const subject = String(m.subject || '')

      for (const w of slotWatches) {
        if (!matches(w, fromAddr, subject)) continue

        const preview = clean(m.body?.content || '').slice(0, 400)
        await wa(w.notify_to, `📬 *RESPOSTA — ${w.label}*\nDe: ${fromAddr}\nAssunto: ${subject}\n\n${preview}${preview.length >= 400 ? '…' : ''}`)
        await db.from('mail_watches').update({ hits: (w.hits || 0) + 1, last_hit_at: m.receivedDateTime || runStart }).eq('id', w.id)
        w.hits = (w.hits || 0) + 1
        alerts.push(`${w.label} ← ${fromAddr}`)
      }
    }

    await db.from('whatsapp_polling_state').upsert({ id: stateId, last_message_id: runStart, updated_at: runStart })
  }

  return { alerts }
}
