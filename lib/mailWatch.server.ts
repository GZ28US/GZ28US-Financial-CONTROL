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
import { listMailAuths, freshAccessToken, type MailAuth } from '@/lib/streamMail.server'
import { waSafeTarget } from '@/lib/waSelfGuard.server'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SIGNATURE = 'Sent by GZ28US Control App®'
const FIRST_RUN_MIN = 60
// As caixas vêm do banco (listMailAuths) e cada provedor tem sua perna: Graph
// para as Microsoft, Gmail API para as Google. Até 04/set/2026 o watcher era
// [1, 2, 3] e ignorava calado qualquer mail_watches.slot apontando para uma
// caixa Google — e é justamente lá (gz28speedshop) que caem Home Depot, Target,
// Sam's e cia. Vigia que não cobre a caixa onde o assunto vive é vigia inútil.

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

// `notify_to` vem do banco (mail_watches) — é o caminho mais fácil de alguém
// reapontar pro cel do Márcio sem querer e o alerta sumir de novo. Guarda aqui.
async function wa(to: string, body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return
  const dest = waSafeTarget(to) // nunca o próprio número — ver waSelfGuard
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: dest, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

const clean = (h: string) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const has = (hay: string, needle: string | null) => !needle || String(hay || '').toLowerCase().includes(needle.toLowerCase())

export function matches(w: MailWatch, fromAddr: string, subject: string): boolean {
  if (!w.from_pattern && !w.subject_pattern) return false // regra vazia nunca casa com tudo
  return has(fromAddr, w.from_pattern) && has(subject, w.subject_pattern)
}

// Cursor por caixa: a MESMA linha de whatsapp_polling_state das duas pernas, para
// que trocar o provedor de um slot não faça o watcher reprocessar o passado.
async function readCursor(db: SupabaseClient, slot: number): Promise<string> {
  const { data } = await db.from('whatsapp_polling_state').select('*').eq(`id`, `mail-watch-${slot}`).limit(1)
  return data?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()
}
async function saveCursor(db: SupabaseClient, slot: number, runStart: string): Promise<void> {
  await db.from('whatsapp_polling_state').upsert({ id: `mail-watch-${slot}`, last_message_id: runStart, updated_at: runStart })
}
// Um achado vira aviso — igual nas duas pernas, para o alerta não depender do provedor.
async function fire(db: SupabaseClient, w: MailWatch, fromAddr: string, subject: string, preview: string, when: string, alerts: string[]): Promise<void> {
  await wa(w.notify_to, `📬 *RESPOSTA — ${w.label}*\nDe: ${fromAddr}\nAssunto: ${subject}\n\n${preview}${preview.length >= 400 ? '…' : ''}`)
  await db.from('mail_watches').update({ hits: (w.hits || 0) + 1, last_hit_at: when }).eq('id', w.id)
  w.hits = (w.hits || 0) + 1
  alerts.push(`${w.label} ← ${fromAddr}`)
}

// ── Perna Google ────────────────────────────────────────────────────────────
// in:anywhere cobre inbox, arquivados, spam e lixeira — a resposta que interessa
// costuma já ter sido arquivada pelo organizer quando o watcher passa.
// O `snippet` já vem no format=metadata e serve de preview sem baixar o corpo.
async function gmailWatch(db: SupabaseClient, auth: MailAuth, slotWatches: MailWatch[], alerts: string[]): Promise<void> {
  const token = await freshAccessToken(db, auth)
  if (!token) return
  const H = { Authorization: `Bearer ${token}` }
  const self = String(auth.account || '').toLowerCase()
  const slot = auth.id
  const runStart = new Date().toISOString()
  const cursor = await readCursor(db, slot)
  // O `after:` do Gmail tem resolução de SEGUNDOS e é inclusivo; recuar 1s evita
  // perder a mensagem que chegou no mesmo segundo em que a passada anterior fechou.
  const afterSec = Math.floor(new Date(cursor).getTime() / 1000) - 1
  const q = `in:anywhere after:${afterSec}`
  const list = await fetch(`${GM}/messages?maxResults=100&q=${encodeURIComponent(q)}`, { headers: H }).then(r => r.json()).catch(() => null)
  for (const stub of list?.messages || []) {
    const m = await fetch(`${GM}/messages/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: H }).then(r => r.json()).catch(() => null)
    if (!m?.id) continue
    const hv = (n: string) => String((m.payload?.headers || []).find((h: { name?: string; value?: string }) => String(h.name || '').toLowerCase() === n)?.value || '')
    const fromRaw = hv('from')
    const fromAddr = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).toLowerCase().trim()
    if (!fromAddr || fromAddr === self) continue // o que NÓS mandamos não é resposta
    const subject = hv('subject')
    const when = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : runStart
    for (const w of slotWatches) {
      if (!matches(w, fromAddr, subject)) continue
      await fire(db, w, fromAddr, subject, clean(String(m.snippet || '')).slice(0, 400), when, alerts)
    }
  }
  await saveCursor(db, slot, runStart)
}

export async function runMailWatch(db: SupabaseClient): Promise<{ alerts: string[] }> {
  const alerts: string[] = []

  const { data: rows } = await db.from('mail_watches').select('*').eq('active', true)
  const watches = (rows || []) as MailWatch[]
  if (!watches.length) return { alerts }

  for (const auth of await listMailAuths(db, 'gmail')) {
    const slotWatches = watches.filter(w => Number(w.slot) === auth.id)
    if (!slotWatches.length) continue
    try { await gmailWatch(db, auth, slotWatches, alerts) } catch (e) { console.error('[mail-watch gmail]', auth.id, e) }
  }

  for (const auth of await listMailAuths(db, 'graph')) {
    const slot = auth.id
    const slotWatches = watches.filter(w => Number(w.slot) === slot)
    if (!slotWatches.length) continue

    const token = await freshAccessToken(db, auth)
    if (!token) continue
    const self = String(auth.account || '').toLowerCase()

    const runStart = new Date().toISOString()
    const cursor = await readCursor(db, slot)

    // Caixa inteira, não só a inbox.
    const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=subject,from,receivedDateTime,body&$orderby=receivedDateTime desc`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => null)

    for (const m of res?.value || []) {
      const fromAddr = String(m.from?.emailAddress?.address || '').toLowerCase()
      if (!fromAddr || fromAddr === self) continue // o que NÓS mandamos não é resposta
      const subject = String(m.subject || '')

      for (const w of slotWatches) {
        if (!matches(w, fromAddr, subject)) continue
        await fire(db, w, fromAddr, subject, clean(m.body?.content || '').slice(0, 400), m.receivedDateTime || runStart, alerts)
      }
    }

    await saveCursor(db, slot, runStart)
  }

  return { alerts }
}
