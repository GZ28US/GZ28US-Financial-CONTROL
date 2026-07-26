// SERVER-ONLY — STREAM phase 3: the gz28us@hotmail.com watcher.
// Reads the mailbox through Microsoft Graph (personal-account OAuth, PKCE
// public client — no client secret anywhere) and auto-captures tracking
// numbers from supplier "your order has shipped" emails. Auth state lives in
// stream_mail_auth (single row, RLS with no policies = service-role only):
//   client_id      — the Azure app registration id (public, not a secret)
//   refresh_token  — minted by /api/stream/mail-callback, rotated on use
//   pkce_verifier / oauth_state — transient, used once during the consent hop
//   last_poll      — high-water mark for the message scan

import type { SupabaseClient } from '@supabase/supabase-js'
import { guessCarrier, type StreamRow } from './stream'

export const MAIL_REDIRECT = 'https://www.gz28us.com/ca/api/stream/mail-callback'
// The Azure app is "Personal Microsoft accounts only" — those must authorize
// through the /consumers authority (never /common).
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
// ReadWrite (includes read): the organizer files purchase emails into each
// car's Outlook folder. Scope upgrades take effect after a fresh consent at
// /api/stream/mail-auth.
// Mail.Send added 2026-07-23: the assistant answers emails (with the user's
// explicit go-ahead per message) — e.g. payment confirmations to Kravitz & Guerra.
export const MAIL_SCOPE = 'offline_access Mail.ReadWrite Mail.Send'

export type MailAuth = {
  id: number
  account?: string | null
  client_id: string | null
  refresh_token: string | null
  pkce_verifier: string | null
  oauth_state: string | null
  last_poll: string | null
}

// Multi-account (2026-07-24): one row per mailbox — id 1 = gz28us@hotmail.com
// (the STREAM watcher's box, untouched default), id 2+ = the other accounts
// (galpaoz28@hotmail.com, gz28br@hotmail.com, ...). `account` records which
// mailbox the row's refresh token belongs to (filled by the callback via /me).
export async function getMailAuth(db: SupabaseClient, id = 1): Promise<MailAuth | null> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('id', id).maybeSingle()
  return (data as MailAuth) || null
}
export async function setMailAuth(db: SupabaseClient, patch: Partial<MailAuth>, id = 1): Promise<void> {
  await db.from('stream_mail_auth').upsert([{ id, ...patch, updated_at: new Date().toISOString() }])
}

// ── OAuth (public client + PKCE, all server-side) ───────────────────────────
export function pkcePair(): { verifier: string; challenge: string } {
  const { randomBytes, createHash } = require('crypto') as typeof import('crypto')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authUrl(clientId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MAIL_REDIRECT,
    scope: MAIL_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  })
  return `${AUTHORITY}/authorize?${q}`
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const r = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  return r.json().catch(() => null)
}

export async function exchangeCode(clientId: string, code: string, verifier: string): Promise<any> {
  return tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: MAIL_REDIRECT, code_verifier: verifier, scope: MAIL_SCOPE })
}

// Refresh → access token; Microsoft rotates the refresh token, so persist the
// new one every time or the chain eventually dies.
export async function freshAccessToken(db: SupabaseClient, auth: MailAuth): Promise<string | null> {
  if (!auth.client_id || !auth.refresh_token) return null
  const res = await tokenRequest({ client_id: auth.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, scope: MAIL_SCOPE })
  if (!res?.access_token) return null
  if (res.refresh_token && res.refresh_token !== auth.refresh_token) {
    await setMailAuth(db, { refresh_token: res.refresh_token }, auth.id || 1)
  }
  return res.access_token
}

// ── message scanning ────────────────────────────────────────────────────────
export type MailMsg = { subject: string; from: string; fromAddr: string; received: string; text: string }

export async function fetchRecentMessages(accessToken: string, sinceIso: string): Promise<MailMsg[]> {
  const q = new URLSearchParams({
    $top: '50',
    $select: 'subject,from,receivedDateTime,body',
    $filter: `receivedDateTime ge ${sinceIso}`,
    $orderby: 'receivedDateTime desc',
  })
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?${q}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data?.value)) return []
  return data.value.map((m: any) => ({
    subject: String(m.subject || ''),
    from: String(m.from?.emailAddress?.name || ''),
    fromAddr: String(m.from?.emailAddress?.address || '').toLowerCase(),
    received: String(m.receivedDateTime || ''),
    text: String(m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' '),
  }))
}

// Every tracking-number shape we can trust from an email body/subject.
const TRACKING_RES: RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/g,             // UPS
  /\b9[2345]\d{20,24}\b/g,           // USPS 92/93/94/95…
  /\b\d{15}\b/g,                     // FedEx 15
  /\b\d{12}\b/g,                     // FedEx 12
  /\b[A-Z]{2}\d{9}US\b/g,            // USPS intl
]
export function extractTrackings(s: string): string[] {
  const out = new Set<string>()
  for (const re of TRACKING_RES) for (const m of s.match(re) || []) out.add(m)
  // A FedEx-12 match that is really a phone number etc. is filtered by context:
  // only keep 12-digit hits when a shippy word is nearby in the same text.
  return [...out].filter(t => !/^\d{12}$/.test(t) || /track|ship|carrier|fedex|deliver/i.test(s))
}

const normTok = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4)

// ── inbox organizer (user rule 2026-07-23) ──────────────────────────────────
// A purchase email STAYS in the inbox until the user reads it; 10+ minutes
// after the first time we see it read, it moves to the car's Outlook folder
// ("Rides / US.0XX - Name"). Any doubt → it stays put and the doubt is logged
// in stream_mail_moves for the assistant to raise in chat.
export type InboxMsg = { id: string; isRead: boolean; subject: string; from: string; fromAddr: string; received: string; text: string }

const graphH = (token: string) => ({ Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' })

export async function fetchInbox(accessToken: string): Promise<InboxMsg[]> {
  const q = new URLSearchParams({ $top: '50', $select: 'id,isRead,subject,from,receivedDateTime,body', $orderby: 'receivedDateTime desc' })
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${q}`, { headers: graphH(accessToken) })
  const data = await r.json().catch(() => null)
  if (!Array.isArray(data?.value)) return []
  return data.value.map((m: any) => ({
    id: String(m.id),
    isRead: !!m.isRead,
    subject: String(m.subject || ''),
    from: String(m.from?.emailAddress?.name || ''),
    fromAddr: String(m.from?.emailAddress?.address || '').toLowerCase(),
    received: String(m.receivedDateTime || ''),
    text: String(m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' '),
  }))
}

// "Rides / US.0XX - Name" → map project_code → folder id.
export async function rideFolderMap(accessToken: string): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  const top = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders?$top=100`, { headers: graphH(accessToken) }).then(r => r.json()).catch(() => null)
  const rides = (top?.value || []).find((f: any) => String(f.displayName).trim().toLowerCase() === 'rides')
  if (!rides) return out
  const kids = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${rides.id}/childFolders?$top=100`, { headers: graphH(accessToken) }).then(r => r.json()).catch(() => null)
  for (const f of kids?.value || []) {
    const m = String(f.displayName || '').match(/^(US\.\d+)\b/i)
    if (m) out.set(m[1].toUpperCase(), { id: f.id, name: f.displayName })
  }
  return out
}

export async function moveMessage(accessToken: string, messageId: string, folderId: string): Promise<boolean> {
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST', headers: { ...graphH(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinationId: folderId }),
  })
  return r.ok
}

const READ_WAIT_MIN = 10

// One organizer pass. Match precedence per email: a row's order number in the
// SUBJECT wins; else a UNIQUE order number in the body; else the supplier —
// but only when every matching row points at the SAME car. Anything else is a
// DOUBT and never moves.
export async function organizeInbox(db: SupabaseClient, accessToken: string): Promise<{ moved: string[]; doubts: string[] }> {
  const moved: string[] = [], doubts: string[] = []
  // Organizer files into US car folders — BR rows (PowerTrade pipeline) have no
  // folder here; their purchase emails stay put and never raise doubts.
  const { data: rowsData } = await db.from('part_streams').select('id, supplier, order_number, invoice_id').not('invoice_id', 'is', null).eq('app', 'US')
  const rows = (rowsData || []) as { id: string; supplier: string | null; order_number: string | null; invoice_id: string }[]
  if (!rows.length) return { moved, doubts }
  const invIds = [...new Set(rows.map(r => r.invoice_id))]
  const { data: invs } = await db.from('invoices').select('id, ride_id').in('id', invIds)
  const rideIds = [...new Set((invs || []).map(i => i.ride_id).filter(Boolean))]
  const { data: rides } = await db.from('rides').select('id, project_code, project_name').in('id', rideIds)
  const rideByInv = new Map((invs || []).map(i => [i.id, (rides || []).find(r => r.id === i.ride_id)]))
  const rideOfRow = (r: { invoice_id: string }) => rideByInv.get(r.invoice_id) || null

  const inbox = await fetchInbox(accessToken)
  if (!inbox.length) return { moved, doubts }
  let folders: Map<string, { id: string; name: string }> | null = null

  for (const msg of inbox) {
    const hay = `${msg.subject} ${msg.text}`
    // Which purchase rows does this email touch?
    const byOrder = rows.filter(r => r.order_number && r.order_number.length >= 4 && hay.includes(r.order_number))
    const bySubjOrder = byOrder.filter(r => msg.subject.includes(r.order_number!))
    const bySupplier = rows.filter(r => supplierMatches(r as any, msg))
    if (!byOrder.length && !bySupplier.length) continue   // not a purchase email

    let ride: any = null, reason = ''
    const uniqRide = (cands: typeof rows) => {
      const rs = [...new Set(cands.map(c => rideOfRow(c)?.project_code).filter(Boolean))]
      return rs.length === 1 ? rideOfRow(cands[0]) : null
    }
    if (bySubjOrder.length) { ride = uniqRide(bySubjOrder); if (!ride) reason = 'order no assunto aponta pra mais de um carro' }
    else if (byOrder.length) { ride = uniqRide(byOrder); if (!ride) reason = 'e-mail cita orders de carros diferentes' }
    else { ride = uniqRide(bySupplier); if (!ride) reason = `fornecedor com compras em ${[...new Set(bySupplier.map(c => rideOfRow(c)?.project_code).filter(Boolean))].join(', ')}` }

    // State machine on stream_mail_moves.
    const { data: st } = await db.from('stream_mail_moves').select('*').eq('message_id', msg.id).maybeSingle()
    const now = new Date()
    if (!ride) {
      if (!st || st.state !== 'DOUBT') {
        await db.from('stream_mail_moves').upsert([{ message_id: msg.id, subject: msg.subject.slice(0, 200), from_addr: msg.fromAddr, state: 'DOUBT', doubt_reason: reason }], { onConflict: 'message_id' })
        doubts.push(`${msg.subject.slice(0, 60)} — ${reason}`)
      }
      continue
    }
    if (!msg.isRead) {
      if (!st) await db.from('stream_mail_moves').insert([{ message_id: msg.id, subject: msg.subject.slice(0, 200), from_addr: msg.fromAddr, ride_code: ride.project_code, state: 'WAIT_READ' }])
      continue
    }
    // Read: stamp the first sighting, move 10+ minutes later.
    if (!st || !st.first_read_at) {
      await db.from('stream_mail_moves').upsert([{ message_id: msg.id, subject: msg.subject.slice(0, 200), from_addr: msg.fromAddr, ride_code: ride.project_code, state: 'READ_WAIT', first_read_at: now.toISOString() }], { onConflict: 'message_id' })
      continue
    }
    if (st.state === 'MOVED') continue
    if (now.getTime() - new Date(st.first_read_at).getTime() < READ_WAIT_MIN * 60_000) continue
    folders = folders || await rideFolderMap(accessToken)
    const folder = folders.get(String(ride.project_code).toUpperCase())
    if (!folder) {
      await db.from('stream_mail_moves').update({ state: 'DOUBT', doubt_reason: `sem pasta "${ride.project_code} - …" no Outlook` }).eq('message_id', msg.id)
      doubts.push(`${msg.subject.slice(0, 60)} — sem pasta ${ride.project_code}`)
      continue
    }
    const ok = await moveMessage(accessToken, msg.id, folder.id)
    await db.from('stream_mail_moves').update(ok
      ? { state: 'MOVED', folder_name: folder.name, moved_at: now.toISOString() }
      : { state: 'DOUBT', doubt_reason: 'Graph recusou o move (reconsentir Mail.ReadWrite?)' }).eq('message_id', msg.id)
    if (ok) moved.push(`${msg.subject.slice(0, 60)} → ${folder.name}`)
    else doubts.push(`${msg.subject.slice(0, 60)} — move falhou`)
  }
  return { moved, doubts }
}

// Does this email plausibly belong to this stream row's supplier? The BODY is
// included because marketplace/PSP notifications (PayPal "your order shipped")
// come from the PSP's address and only name the merchant in the text; the
// space-squashed haystack catches "Polmax Racing" vs supplier "POLMAXRACING".
export function supplierMatches(row: StreamRow, msg: MailMsg): boolean {
  const hay = `${msg.fromAddr} ${msg.from} ${msg.subject} ${msg.text}`.toLowerCase()
  const squash = hay.replace(/[^a-z0-9]/g, '')
  return normTok(row.supplier || '').some(tok => hay.includes(tok) || squash.includes(tok))
}

// Match open stream rows against one email. Strongest first:
//   1. the row's order number appears in the email
//   2. the sender/subject matches the row's supplier AND that supplier has
//      exactly ONE open row (no ambiguity)
export function matchRows(open: StreamRow[], msg: MailMsg): StreamRow[] {
  const inMail = `${msg.subject} ${msg.text}`
  const byOrder = open.filter(r => r.order_number && r.order_number.length >= 4 && inMail.includes(r.order_number))
  if (byOrder.length) return byOrder
  const bySupplier = open.filter(r => supplierMatches(r, msg))
  const suppliers = new Set(bySupplier.map(r => (r.supplier || '').toLowerCase()))
  return suppliers.size === 1 && bySupplier.length === 1 ? bySupplier : []
}

// ── Spam auto-clean (regra do Márcio 2026-07-24: "apague logo que chegar") ──
// Cada passada do mail-poll varre Caixa de Entrada + Lixo Eletrônico das 3
// contas Hotmail conectadas e manda os remetentes de marketing/junk conhecidos
// para os Itens Excluídos (soft delete — recuperável). A lista é curada: só
// remetentes puramente promocionais/golpe; transacionais nunca entram aqui.
const SPAM_SENDERS: RegExp[] = [
  /zanvis\.com/i, /quickreliablecoverage/i, /insideapple\.apple\.com/i,
  /alstspecials\.com/i, /newvisionbooking\.com/i, /searshomeservices\.com/i,
  /acordocerto\.com\.br/i, /acerto\.com\.br/i, /ephysioassociates\.com/i,
  /centraldecampanhas\.com\.br/i, /centraldeboletos\.com\.br/i,
  /newsletter\.volotea\.com/i, /e\.sixt\.com/i, /hello@eaze\.com/i,
  /marketing\.jetblue\.com/i, /shopyourwayrewards\.com/i, /dpny\.com\.br/i,
  /e\.localiza\.com/i, /e-cotaragora\.com/i, /mkt\.americanas\.com/i,
  /elements\.envato\.com/i, /intelbras-info\.com/i, /emkt\.intercityhoteis/i,
  /novidades@reserva\.ink/i, /minibardelivery\.com/i, /emails\.pbr\.com/i,
  /boutique@toleman\.com\.br/i, /premiereplay\.globo\.com/i,
  /sistemadeinfracao/i, /mcdonalds.*privaterelay\.appleid\.com/i,
  // newsletter da RockAuto — NUNCA incluir noreply@rockauto.com (carrinhos!)
  /newsletter@list\.rockauto\.com/i,
  // Faxina inbox-zero 2026-07-25 — puramente promocionais:
  /infoemails\.microsoft\.com/i, /promomail\.microsoft\.com/i,
  /mail\.nordvpn\.com/i, /em\.autozone\.com/i, /email\.bestbuy\.com/i,
  /bounce\.17track\.net/i, /hamia@17track\.com/i, /mm\.simpletire\.com/i,
  /e\.stripe\.com/i, /meuacerto\.com\.br/i, /jcsjunioradvogados\.com\.br/i,
  /ciaathletica\.com\.br/i, /announce@winzip\.com/i, /photos@onedrive\.com/i,
  /uberone@uber\.com/i, /jegs@e\.jegs\.com/i, /emanualonline\.com/i,
  /touchupdirect\.com/i, /koshergoods\.net/i, /negociar\.acerto\.com\.br/i,
]
// Facebook só cai se for cutucada/aniversário — avisos de segurança ficam.
const SPAM_FB_SUBJECT = /poked you|birthday|anivers[áa]rio/i

export async function sweepSpam(db: SupabaseClient): Promise<{ deleted: string[] }> {
  const deleted: string[] = []
  for (const slot of [1, 2, 3]) {
    try {
      const auth = await getMailAuth(db, slot)
      if (!auth?.refresh_token) continue
      const token = await freshAccessToken(db, auth)
      if (!token) continue
      for (const folder of ['inbox', 'junkemail']) {
        const r = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=30&$select=id,subject,from`, { headers: graphH(token) })
        const data = await r.json().catch(() => null)
        for (const m of data?.value || []) {
          const addr = String(m.from?.emailAddress?.address || '')
          const subj = String(m.subject || '')
          const hit = SPAM_SENDERS.some(re => re.test(addr)) || (/facebookmail\.com/i.test(addr) && SPAM_FB_SUBJECT.test(subj))
          if (!hit) continue
          const mv = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}/move`, {
            method: 'POST', headers: { ...graphH(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ destinationId: 'deleteditems' }),
          })
          if (mv.ok) deleted.push(`[slot ${slot}] ${addr} — ${subj.slice(0, 60)}`)
        }
      }
    } catch (e) { console.error('[spam-sweep]', slot, e) }
  }
  return { deleted }
}

// MARKETING SWEEP — kills promotional mail from senders we've never listed:
// a message with a List-Unsubscribe header whose sender/subject carries no
// transactional signal is bulk marketing by definition. Transactional senders
// and anything order/payment/doc-shaped NEVER matches (inbox-zero, 2026-07-26).
const SAFE_SENDER = /rockauto\.com|titanmotorsports|hptuners|texas-speed|summitracing|paypal|ups\.com|fedex|usps|dhl|17track|shop\.app|shopify|anthropic|supabase|vercel|regions|c6bank|sunpass|progressive|dukeenergy|speedpay|docusign|d4sign|e-notariado|registrocivil|autotagsandtitle|bssparts|vstar|kooksheaders|halltech|modernmuscle|tirerack|discounttire|graph|microsoft\.com|google\.com|apple\.com|sema\.org/i
const SAFE_SUBJECT = /order|track|invoice|receipt|payment|paid|ship|deliver|cart|carrinho|quote|or[çc]amento|confirm|refund|return|rma|appointment|statement|security|verify|c[óo]digo|code|password|sign|assinatura|contrato|nf-?e|boleto|fatura|ipva|guia/i

export async function sweepMarketing(db: SupabaseClient): Promise<{ deleted: string[] }> {
  const deleted: string[] = []
  for (const slot of [1, 2, 3]) {
    try {
      const auth = await getMailAuth(db, slot)
      if (!auth?.refresh_token) continue
      const token = await freshAccessToken(db, auth)
      if (!token) continue
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20&$select=id,subject,from`, { headers: graphH(token) })
      const data = await r.json().catch(() => null)
      for (const m of data?.value || []) {
        const addr = String(m.from?.emailAddress?.address || '')
        const subj = String(m.subject || '')
        if (SAFE_SENDER.test(addr) || SAFE_SUBJECT.test(subj)) continue
        // header check costs one GET per candidate — only non-safe mail gets here.
        const h = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders`, { headers: graphH(token) })
        const hd = await h.json().catch(() => null)
        const unsub = (hd?.internetMessageHeaders || []).some((x: any) => /^list-unsubscribe$/i.test(String(x.name)))
        if (!unsub) continue
        const mv = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}/move`, {
          method: 'POST', headers: { ...graphH(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ destinationId: 'deleteditems' }),
        })
        if (mv.ok) deleted.push(`[slot ${slot}] ${addr} — ${subj.slice(0, 60)}`)
      }
    } catch (e) { console.error('[marketing-sweep]', slot, e) }
  }
  return { deleted }
}

export { guessCarrier }
