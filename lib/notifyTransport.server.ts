// SERVER-ONLY — THE WIRE of the quote-portal switchboard (08/11/2026; blueprint §8.1, §16 M4). lib/notify.server.ts DECIDES
// (key OFF → nothing; ON → one message); this file is the only place that touches the outside world, and it is INJECTABLE:
// scripts/test-notify-senders.ts swaps in a fake and proves the real one is never reached.
//
// Nothing new on the wire — it REUSES the app's existing senders:
//   • WhatsApp → lib/waSend.server.ts `enviaUltra` (the one path to UltraMsg the watchers use: self-send guard, group mentions,
//     resend without `mentions` on a field refusal). The house signature is applied BEFORE this layer (lib/waSignature.ts,
//     the same rule /api/whatsapp applies). Every attempt — sent or refused — leaves a `wa_send_log` row, like the route does
//     (enviaUltra itself logs nothing). The OTP message passes its own `logHead`, so the code never lands in the log.
//   • e-mail → Microsoft Graph /me/sendMail on mailbox slot 1 (the token path of lib/streamMail.server.ts) — the sender the
//     switchboard already used for client e-mails.
// Both are lazy-imported: loaded only when a message really goes out.
import { createClient } from '@supabase/supabase-js'

export type WaSendResult = { ok: boolean; error: string | null; status: number | null; id: string | null }
export type MailMessage = { to: string; subject: string; html: string; attachments: { name: string; base64: string }[] }
export type Transport = {
  name: string
  whatsapp(to: string, body: string, o?: { logHead?: string }): Promise<WaSendResult>
  email(m: MailMessage): Promise<string | null>          // null = sent; string = why not
}

async function waLog(row: { destination: string; kind: string; body_head: string; ok: boolean; error: string | null; http_status: number | null; ultra_id: string | null }) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return
    await createClient(url, key, { auth: { persistSession: false } }).from('wa_send_log').insert({ ...row, group_name: null })
  } catch { /* the log never brings a send down */ }
}

const G = 'https://graph.microsoft.com/v1.0'

export const realTransport: Transport = {
  name: 'real',
  async whatsapp(to, body, o = {}) {
    const { enviaUltra } = await import('./waSend.server')
    const r = await enviaUltra(to, body)
    const id = r.data?.id != null ? String(r.data.id) : null
    const error = r.ok ? null : (r.error || String(r.data?.error || 'ultramsg refused')).slice(0, 300)
    await waLog({ destination: to, kind: 'chat', body_head: (o.logHead ?? body).slice(0, 160), ok: r.ok, error, http_status: r.status, ultra_id: id })
    return { ok: r.ok, error, status: r.status, id }
  },
  async email(m) {
    const { getMailAuth, freshAccessToken } = await import('./streamMail.server')
    const { streamDb } = await import('./stream.server')
    const mdb = streamDb()
    const auth = await getMailAuth(mdb, 1)
    if (!auth?.refresh_token) return 'mailbox not connected'
    const token = await freshAccessToken(mdb, auth)
    if (!token) return 'mail token refresh failed'
    const r = await fetch(`${G}/me/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { subject: m.subject, body: { contentType: 'HTML', content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }],
        attachments: m.attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: 'application/pdf', contentBytes: a.base64 })) }, saveToSentItems: true }) })
    return r.ok ? null : `graph ${r.status}: ${(await r.text()).slice(0, 200)}`
  },
}

// The harness seam. Production never calls setTransportForTests; `transport()` is then always the real one.
let injected: Transport | null = null
export function setTransportForTests(t: Transport | null) { injected = t }
export function transport(): Transport { return injected || realTransport }
