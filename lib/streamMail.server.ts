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

// ── A QUARTA CAIXA: o Gmail (26/ago/2026) ──────────────────────────────────
// fetchRecentMessages fala Graph, então só serve para os slots 1-3. A Amazon
// manda a nota de embarque para o gz28us@gmail — e por isso as duas compras de
// 25/ago embarcaram com o STREAM continuando em BOUGHT, sem rastreio nenhum.
// Mesmo defeito de véspera (o vigia lia 1 caixa de 4), só que na caixa que fala
// outro protocolo. Devolve o MESMO formato para o poll não precisar saber a
// diferença.
export async function fetchRecentGmail(accessToken: string, sinceIso: string): Promise<MailMsg[]> {
  const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
  const H = { Authorization: `Bearer ${accessToken}` }
  const afterSec = Math.floor(new Date(sinceIso).getTime() / 1000)
  // Aqui o filtro por assunto É defensável (ao contrário do da captura de
  // compras, que engolia pedido): rastreio só chega em nota de despacho, e o
  // vocabulário dela é pequeno e estável. Sem esse recorte a perna do Gmail
  // baixava o corpo de tudo e estourou os 60s da função no 1º deploy (26/ago).
  const q = `after:${afterSec} -in:chats (shipped OR shipping OR tracking OR delivered OR "on its way" OR "a caminho" OR "foi enviado")`
  const list = await fetch(`${GM}/messages?maxResults=25&q=${encodeURIComponent(q)}`, { headers: H }).then(r => r.json()).catch(() => null)
  const stubs = list?.messages || []
  const out: MailMsg[] = []
  for (let i = 0; i < stubs.length; i += 8) {
    const batch = await Promise.all(stubs.slice(i, i + 8).map((s: any) =>
      fetch(`${GM}/messages/${s.id}?format=full`, { headers: H }).then(r => r.json()).catch(() => null)))
    for (const m of batch) {
      if (!m?.payload) continue
      const hv = (n: string) => String((m.payload.headers || []).find((h: any) => String(h.name || '').toLowerCase() === n)?.value || '')
      const fromRaw = hv('from')
      const chunks: string[] = []
      const walk = (p: any) => {
        if (!p) return
        if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || '')) {
          try { chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) } catch { /* skip part */ }
        }
        for (const c of p.parts || []) walk(c)
      }
      walk(m.payload)
      out.push({
        subject: hv('subject'),
        from: fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
        fromAddr: (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).toLowerCase().trim(),
        received: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
        text: chunks.join(' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' '),
      })
    }
  }
  return out
}

// Every tracking-number shape we can trust from an email body/subject.
// 29/ago/2026: as 5 formas originais ignoravam 39% do que a casa recebe de
// verdade (medido em part_streams: GOFO 24 casos, SwiftX 8, SpeedX 3, DHL 2,
// Estes 1 — todos digitados à mão até hoje). Os prefixos GFUS/SWX/SPX são
// inconfundíveis; DHL (10 dígitos) e Estes (3-7 com hífen) são ambíguos e só
// entram com prova por perto (ver guardas dentro de extractTrackings).
const TRACKING_RES: RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/g,             // UPS
  /\b9[2345]\d{20,24}\b/g,           // USPS 92/93/94/95…
  /\b\d{15}\b/g,                     // FedEx 15
  /\b\d{12}\b/g,                     // FedEx 12
  /\b[A-Z]{2}\d{9}US\b/g,            // USPS intl
  /\bGFUS\d{12,16}\b/g,              // GOFO (Temu) — GFUS01064131777865
  /\bSWX\d{16,20}\b/g,               // SwiftX (Temu) — SWX783240000125251628
  /\bSPX[A-Z]{2,4}\d{14,20}\b/g,     // SpeedX — SPXMCO + 18 dígitos
  // Estes PRO (frete LTL) — 046-8349621. As BORDAS são o coração da regra: o
  // order number da AMAZON é 3-7-7 (111-5579813-4088211) e o \b do JS casa no
  // hífen interno, então o \b\d{3}-\d{7}\b nu recortava "111-5579813" do
  // PRÓPRIO número do pedido e o transformava em rastreio (guessCarrier ainda
  // dizia "Estes"). A Amazon é o 2º maior fornecedor da casa (27 pedidos), e o
  // estrago era completo: gravava rastreio falso, registrava no 17TRACK,
  // reportava no WhatsApp e ainda PULAVA o ramo "Amazon despacha sem número".
  // Por isso: nada de dígito nem de hífen colado dos DOIS lados do candidato.
  /(?<![A-Za-z0-9-])\d{3}-\d{7}(?![A-Za-z0-9-])/g,
  /\b\d{10}\b/g,                     // DHL Express — 3749834410 (guarda dura)
]
// eBay listing Item IDs are 12-digit numbers — the exact shape of a FedEx
// tracking. They show up as "Item ID: 236502286470" / "ebay.com/itm/2365…"
// in BOTH the order-confirmation and the shipping-confirmation emails, so an
// all-digit candidate sitting in item context is never a tracking number.
const ITEM_ID_CONTEXT = /(?:\/itm[/:]?|\bitem\s*(?:id|number|no\.?|#)?\s*[:#]?)\s*$/i
// ITEM_ID_CONTEXT é ancorado no FIM do trecho anterior, então só blinda a
// PRIMEIRA cópia do número — e o eBay imprime o Item ID DUAS VEZES seguidas
// ("Item ID: 398152407962 398152407962"). A segunda cópia entrava como se
// fosse rastreio FedEx, porque "Track package" aparece perto e satisfaz o
// NEAR_TRACK. Foi assim que a bomba do JailBreak170 (pedido 24-14969-99732)
// passou 22 dias em SHIPPED com um número que não era de transportadora
// nenhuma, enquanto o eBay já tinha avisado a entrega (25/ago/2026).
// Agora: todo número que apareça em contexto de ITEM em QUALQUER ponto do
// texto fica banido do resultado inteiro, não só na ocorrência rotulada.
const ITEM_ID_ANYWHERE = /(?:\/itm[/:]?|\bitem\s*(?:id|number|no\.?|#)?\s*[:#]?)\s*(\d{9,22})/gi
// Tracking language that must sit NEAR an ambiguous all-digit candidate.
// "deliver" stays out on purpose — "Estimated delivery" lines sit right next
// to item listings in marketplace emails.
const NEAR_TRACK = /track|fedex|usps|ups\b|carrier|shipment|shipped/i
// Prova exigida perto de um PRO number da Estes (frete LTL). O vocabulário aqui
// é de FRETE DE VERDADE, não de despacho genérico: "track", "shipment",
// "shipped" e "carrier" estão em TODO e-mail de embarque do planeta, então
// aceitá-los era o mesmo que não ter guarda nenhuma — bastava um 3-7 solto no
// texto (telefone "407-5551234" ao lado de "shipment", pedaço de order number)
// pra virar rastreio. A casa mediu 1 (UMA) remessa Estes na vida inteira: o
// custo de apertar é zero, o risco de afrouxar é carimbar pedido errado.
const NEAR_TRACK_LTL = /estes|freight|\bltl\b|pro\s*(?:no\.?|number|#)|bill of lading|\bbol\b|less[- ]than[- ]truckload/i

// A transportadora dita em texto claro vale mais que palpite por nº de dígitos:
// o eBay escreve "Carrier: USPS" / "Shipped with USPS" no próprio e-mail.
const CARRIER_SAID = /(?:carrier|shipped\s+(?:with|via|by)|ship(?:ped)?\s+by)\s*[:：]?\s*(USPS|UPS|FedEx|DHL|OnTrac|LaserShip|Amazon|SpeedX|GOFO|SwiftX|UniUni|Pandion|Estes|Roadrunner)\b/i
const CARRIER_CANON: Record<string, string> = { usps: 'USPS', ups: 'UPS', fedex: 'FedEx', dhl: 'DHL', ontrac: 'OnTrac', lasership: 'LaserShip', amazon: 'Amazon', speedx: 'SpeedX', gofo: 'GOFO', swiftx: 'SwiftX', uniuni: 'UniUni', pandion: 'Pandion', estes: 'Estes', roadrunner: 'Roadrunner' }
export function carrierFromText(s: string): string | null {
  const m = s.match(CARRIER_SAID)
  return m ? (CARRIER_CANON[m[1].toLowerCase()] || m[1]) : null
}

export function extractTrackings(s: string): string[] {
  const out = new Set<string>()
  const banned = new Set<string>()
  for (const m of s.matchAll(ITEM_ID_ANYWHERE)) banned.add(m[1])
  for (const re of TRACKING_RES) {
    for (const m of s.matchAll(re)) {
      const t = m[0]
      const at = m.index ?? 0
      const before = s.slice(Math.max(0, at - 90), at)
      const after = s.slice(at + t.length, at + t.length + 90)
      if (banned.has(t)) continue
      if (ITEM_ID_CONTEXT.test(before)) continue
      // An all-digit shape (FedEx 12/15) is ambiguous — eBay Item IDs, phone
      // numbers, invoice ids all collide. Only trust it when tracking language
      // sits within ~90 chars of the number itself, not just anywhere in the
      // email (the eBay Item ID 236502286470 passed the old anywhere-check and
      // shipped a BOUGHT row at purchase time, 06/ago/2026).
      if (/^\d{12}$|^\d{15}$/.test(t) && !NEAR_TRACK.test(before) && !NEAR_TRACK.test(after)) continue
      // DHL Express (10 dígitos) é a forma mais perigosa da lista: telefone,
      // nº de fatura e trecho de valor têm 10 dígitos. Só vale quando o e-mail
      // NOMEIA a DHL em algum lugar E há linguagem de rastreio colada ao número
      // (mesma régua de 90 chars do FedEx). Item ID do eBay já saiu no banned.
      if (/^\d{10}$/.test(t) && (!/\bDHL\b/i.test(s) || (!NEAR_TRACK.test(before) && !NEAR_TRACK.test(after)))) continue
      // Estes PRO (3-7 com hífen): exige vocabulário de FRETE colado (não vale
      // "shipped"/"track", que qualquer e-mail tem) pra não engolir nº de
      // fatura, telefone 3-7 nem pedaço de order number com a mesma cara.
      if (/^\d{3}-\d{7}$/.test(t) && !NEAR_TRACK_LTL.test(before) && !NEAR_TRACK_LTL.test(after)) continue
      out.add(t)
    }
  }
  return [...out]
}

// Purchase-confirmation emails NEVER carry a trustable tracking number — an
// "Order confirmed" mail means BOUGHT, nothing more. Tracking only enters via
// the shipping-confirmation email (caso eBay 25-14968-48374, 06/ago/2026:
// the Item ID was captured as FedEx tracking and the row flipped SHIPPED at
// purchase time). An email whose subject reads like a purchase confirmation
// is skipped by the tracking capture unless its text explicitly announces the
// shipment happened.
const CONFIRM_SUBJECT = /order (confirm|receiv|placed|acknowledg)|confirmed:|thanks? for (your|shopping)|thank you for your (order|purchase)|purchase (is )?confirmed|receipt for your payment|your receipt|payment receipt|pedido (confirmado|recebido|realizado)|recibo d[eo] pagamento/i
const SHIPPING_CONFIRM = /(has|have|was|were|just) (been )?(shipped|dispatched)|shipping confirmation|is on its way|on the way to you|out for delivery|tracking (number|no\.?|#)|foi (enviado|despachado|postado)|pedido enviado/i
export function isPurchaseConfirmation(msg: MailMsg): boolean {
  return CONFIRM_SUBJECT.test(msg.subject) && !SHIPPING_CONFIRM.test(`${msg.subject} ${msg.text}`)
}

const normTok = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4)

// ── inbox organizer (user rule 2026-07-23) ──────────────────────────────────
// A purchase email STAYS in the inbox until the user reads it; 10+ minutes
// after the first time we see it read, it moves to the car's Outlook folder
// ("Rides / US.0XX - Name"). Any doubt → it stays put and the doubt is logged
// in stream_mail_moves for the assistant to raise in chat.
export type InboxMsg = { id: string; isRead: boolean; subject: string; from: string; fromAddr: string; received: string; text: string }

const graphH = (token: string) => ({ Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' })

// LÊ INBOX **E** LIXO ELETRÔNICO (01/set/2026). O organizador só olhava a
// inbox, e por isso e-mail de compra que o Outlook classificou como spam nunca
// chegava à pasta do carro. Caso-origem: as 4 mensagens da AGE Styling do
// airbag da BR.538 (RussianRoulette) — confirmação do pedido #3440 e o embarque
// com o rastreio FedEx — caíram TODAS em Lixo Eletrônico e tiveram de ser
// arquivadas à mão. Loja nova que o filtro ainda não conhece cai em spam por
// padrão, então isto não é exceção, é o caminho normal de todo fornecedor novo.
//
// O que NÃO muda: quem decide arquivar continua sendo a mesma regra de sempre
// (casa por order_number/fornecedor, dúvida fica parada). Ler o spam só amplia
// de onde as mensagens vêm — o organizador move a mensagem para a pasta do
// carro, o que já a tira do spam de quebra.
const INBOX_FOLDERS = ['inbox', 'junkemail']

export async function fetchInbox(accessToken: string): Promise<InboxMsg[]> {
  const q = new URLSearchParams({ $top: '50', $select: 'id,isRead,subject,from,receivedDateTime,body', $orderby: 'receivedDateTime desc' })
  const lists = await Promise.all(INBOX_FOLDERS.map(async (folder) => {
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?${q}`, { headers: graphH(accessToken) })
    const d = await r.json().catch(() => null)
    return Array.isArray(d?.value) ? d.value : []
  }))
  const data = { value: lists.flat().sort((a: any, b: any) => String(b.receivedDateTime || '').localeCompare(String(a.receivedDateTime || ''))) }
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
    // PROTECTED senders never get filed by the organizer (30/jul/2026: Jordan's
    // Auto Tags quote uses titan.email hosting — the "titan" token in the
    // signature false-matched the Titan Motorsports purchases and the e-mail
    // was filed into a ride folder; Progressive/e-sign mail suffered the same).
    if (/autotagsandtitle|echosign|adobesign|docusign|e\.progressive\.com/i.test(msg.fromAddr)) continue
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

// ═══ CASADOR TRACKING↔PEDIDO↔ITEM (29/ago/2026 — pedidos 3 e 4 do Márcio) ═══
// Funções PURAS (testáveis sem banco) + dois helpers de banco no fim. A regra
// da casa: o robô só age no INEQUÍVOCO; o resto vira pergunta, nunca chute.

// REGRA: order number se compara NORMALIZADO — upper + só A-Z0-9. '#3384094' e
// '3384094' são o MESMO pedido; o valor gravado/exibido continua o original.
export const normOrder = (s: string | null | undefined): string =>
  String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// inventory (estoque doado — e até PURCHASED antigo) guarda CÓDIGO DE INVOICE
// INTERNA no campo order_number (US.016.1, US.040.3). Isso NUNCA é pedido de
// fornecedor: não casa e-mail, não entra em índice nenhum do rastreio.
export const isInternalOrderCode = (s: string | null | undefined): boolean =>
  /^(US|BR)\.\d+/i.test(String(s || '').trim())

// 6 linhas reais têm 2-3 rastreios enfiados no MESMO campo tracking_number
// ("1Z…136, 1Z…550 (UPS), 875552855742 (FedEx)"). O campo nunca é reescrito
// pelo robô (só à mão), mas o casador precisa ENXERGAR cada número lá dentro
// pra guarda por pedido funcionar. Tokens curtos e nomes de carrier caem fora.
export const trackingsInField = (v: string | null | undefined): string[] =>
  String(v || '').toUpperCase().split(/[^A-Z0-9-]+/).filter(t => t.replace(/-/g, '').length >= 8 && /\d/.test(t))

// Devolução/replacement: o rastreio da VOLTA chega no mesmo thread, com o
// MESMO order number (caso real Amazon 111-9713466-2609021). Nunca capturar.
export const RETURN_WORDS = /\breturn label\b|\breturn shipping\b|\byour return\b|\bstart(?:ed)? (?:a |your )?return\b|\breturn (?:is|was|has been) (?:started|approved|received)\b|\breturn of (?:the )?original\b|\breplacement (?:order|item|has|is|was|delivered|shipped)\b|etiqueta de devolu[çc][ãa]o|devolu[çc][ãa]o (?:do|de|em)/i

// Embarque PARCIAL declarado pelo vendedor — a Temu escreve literalmente
// "Part of your Temu order has been transferred to GOFO". Parcial em pedido
// multi-item = o e-mail NÃO diz quais itens foram: ambíguo por definição.
export const PARTIAL_SHIPMENT = /part of your .{0,30}order|partial shipment|has been split into|remaining items? will ship|parte do seu pedido/i

// Palavra de pedido exigida perto de um order CURTO (piso de segurança).
const ORDER_WORD = /\b(order|orders|pedido|po|so|invoice|confirmation|purchase|transaction)\b/i

// Variantes toleradas do número gravado (medidas no banco, não inventadas):
//   · zero à esquerda — Titan grava 014082582, e-mail escreve "14082582"
//   · sufixo de 1 letra — Walmart grava 2000149-94340612/D, e-mail escreve sem
// Ambas só valem quando sobram ≥6 chars (variante curta demais vira isca).
function orderVariants(raw: string): string[] {
  const n = normOrder(raw)
  const v = new Set<string>()
  if (n.length >= 4) v.add(n)
  const noZeros = n.replace(/^0+/, '')
  if (noZeros !== n && noZeros.length >= 6) v.add(noZeros)
  const noSuffix = n.replace(/[A-Z]$/, '')
  if (noSuffix !== n && noSuffix.length >= 6) v.add(noSuffix)
  return [...v]
}

// O pedido está escrito no e-mail? Compara NORMALIZADO dos dois lados: cada
// char do order pode vir separado por 1 pontuação no texto ("PO-211-007…"),
// e as bordas exigem NÃO-alfanumérico — "3724" dentro do tracking UPS
// 1Z1777V54253724… NÃO casa (o vizinho é dígito). PISO DE SEGURANÇA (medido:
// 37 das 160 orders têm 4-8 chars só-dígitos): order de dígitos com <6 chars
// só casa se o FORNECEDOR também bater E houver palavra de pedido a ≤90 chars
// antes do número. Sem isso "3724" (BSSParts) casaria dentro de CEP/valor/data.
export function orderHitInBlob(orderRaw: string, blob: string, supplierOk: boolean): boolean {
  for (const v of orderVariants(orderRaw)) {
    const body = v.split('').join('[-#./]?')
    let m: RegExpExecArray | null
    try { m = new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i').exec(blob) } catch { continue }
    if (!m) continue
    if (/^\d+$/.test(v) && v.length < 6) {
      if (!supplierOk) continue
      if (!ORDER_WORD.test(blob.slice(Math.max(0, m.index - 90), m.index))) continue
    }
    return true
  }
  return false
}

// GUARDA APERTADA do fallback por fornecedor (29/ago): o nome tem de aparecer
// no REMETENTE ou no ASSUNTO — nunca só no corpo. Foi 1 token de 4 letras no
// corpo que fez e-mail de marketing ("ready to sell your vehicle?") marcar o
// pedido HHP 382525 (8 itens) como ENTREGUE, e um e-mail da Montway fechar um
// pedido do eBay. O caso PayPal/HHP continua vivo: o PSP manda do domínio
// dele, mas o ASSUNTO nomeia o lojista ("Your High Horse Performance, Inc.
// order is on its way").
export function supplierSenderMatches(row: StreamRow, msg: MailMsg): boolean {
  return supplierTokensHit(row, msg).length > 0
}
// Quais tokens do fornecedor da linha bateram no remetente/assunto. Saber
// QUAIS bateram (e não só QUE bateram) é o que separa "achei o VENDEDOR" de
// "achei só a LOJA onde ele vende" — ver supplierLayerRow.
function supplierTokensHit(row: StreamRow, msg: MailMsg): string[] {
  const hay = `${msg.fromAddr} ${msg.from} ${msg.subject}`.toLowerCase()
  const squash = hay.replace(/[^a-z0-9]/g, '')
  return normTok(row.supplier || '').filter(tok => hay.includes(tok) || squash.includes(tok))
}

// ── PLATAFORMAS QUE FALAM POR MUITOS VENDEDORES ─────────────────────────────
// eBay, PayPal, Amazon, Temu & cia mandam o e-mail EM NOME de um lojista que
// costuma aparecer só no corpo (quando aparece). Reconhecer a plataforma no
// REMETENTE é reconhecer o balcão, nunca o vendedor.
const MARKETPLACE_PLATFORMS: { platform: string; sender: RegExp }[] = [
  { platform: 'ebay', sender: /@(?:[a-z0-9-]+\.)*ebay\.[a-z.]+$/i },
  { platform: 'paypal', sender: /@(?:[a-z0-9-]+\.)*paypal\.[a-z.]+$/i },
  { platform: 'amazon', sender: /@(?:[a-z0-9-]+\.)*amazon\.[a-z.]+$/i },
  { platform: 'temu', sender: /@(?:[a-z0-9-]+\.)*temu\.[a-z.]+$/i },
  { platform: 'aliexpress', sender: /@(?:[a-z0-9-]+\.)*aliexpress\.[a-z.]+$/i },
  { platform: 'walmart', sender: /@(?:[a-z0-9-]+\.)*walmart\.[a-z.]+$/i },
  { platform: 'etsy', sender: /@(?:[a-z0-9-]+\.)*etsy\.[a-z.]+$/i },
  { platform: 'mercadolivre', sender: /@(?:[a-z0-9-]+\.)*mercado(?:livre|libre)\.[a-z.]+$/i },
]
export function platformOfSender(msg: MailMsg): string | null {
  const a = String(msg.fromAddr || '').toLowerCase().trim()
  return MARKETPLACE_PLATFORMS.find(p => p.sender.test(a))?.platform || null
}

// Assinatura do FORMATO do order number: dígito→9, letra→A, pontuação fica.
// eBay grava 06-14956-19683 e 24-15079-97471 — os dois viram 99-99999-99999.
// Não é dado novo em campo nenhum: é uma leitura do que já está gravado.
const orderShape = (s: string | null | undefined): string =>
  String(s || '').trim().toUpperCase().replace(/[0-9]/g, '9').replace(/[A-Z]/g, 'A')

// ── A EXCLUSIVIDADE DE VERDADE (conserto 29/ago) ────────────────────────────
// A camada de fornecedor só pode agir no INEQUÍVOCO: "existe UMA única linha
// aberta que este e-mail poderia ser". O erro anterior media a unicidade SÓ
// entre as linhas cujo token bateu — e token é justamente o que falta nas
// linhas gravadas com o nome CRU do vendedor de marketplace. Caso real do
// banco: "mopareparts (eBay)" e "hawksmotorsports" abertas ao mesmo tempo; um
// e-mail do ebay@ebay.com com o título do item da hawks batia só em
// "mopareparts (eBay)" (pelo token "ebay"!), essa linha ficava "única" e o
// rastreio da hawks era carimbado no pedido errado, com os itens errados
// ligados.
//   A REGRA: quando o ÚNICO token que casou é o nome da PRÓPRIA PLATAFORMA, o
//   e-mail identificou o balcão, não o vendedor — então a unicidade tem de ser
//   medida contra TODAS as linhas abertas que poderiam ser daquela plataforma:
//   as que a nomeiam no supplier E as que só têm o nome cru do vendedor mas
//   carregam um order number com o MESMO FORMATO das que a nomeiam. 2+ dessas
//   ⇒ AMBÍGUO ⇒ não se casa por fornecedor (vira pergunta ou silêncio).
//   Quando o e-mail nomeia o VENDEDOR (a HHP no assunto do PayPal), o token que
//   bateu não é o da plataforma e a regra estrita de sempre continua valendo.
export function supplierLayerRow(open: StreamRow[], msg: MailMsg): StreamRow | null {
  const bySupplier = open.filter(r => supplierSenderMatches(r, msg))
  const suppliers = new Set(bySupplier.map(r => (r.supplier || '').toLowerCase().trim()))
  if (suppliers.size !== 1 || bySupplier.length !== 1) return null
  const cand = bySupplier[0]
  const platform = platformOfSender(msg)
  if (!platform) return cand
  const platformToks = new Set(normTok(platform))
  // Bateu algum token que NÃO é o nome da plataforma? Então o e-mail nomeou o
  // vendedor de verdade — inequívoco, segue.
  if (supplierTokensHit(cand, msg).some(tok => !platformToks.has(tok))) return cand
  // Só a plataforma bateu: monta o universo plausível daquela plataforma.
  const namesPlatform = (r: StreamRow) => normTok(r.supplier || '').some(t => platformToks.has(t))
  const shapes = new Set(open.filter(namesPlatform).map(r => orderShape(r.order_number)).filter(s => s.length >= 4))
  const plausible = open.filter(r => namesPlatform(r) || (r.order_number && shapes.has(orderShape(r.order_number))))
  return plausible.length === 1 ? cand : null
}

// Match open stream rows against one email. Strongest first:
//   1. the row's order number appears in the email (NORMALIZADO, com piso)
//   2. the SENDER/SUBJECT matches the row's supplier AND that supplier has
//      exactly ONE open row (no ambiguity)
export function matchRows(open: StreamRow[], msg: MailMsg): StreamRow[] {
  const inMail = `${msg.subject} ${msg.text}`
  const byOrder = open.filter(r => r.order_number && !isInternalOrderCode(r.order_number) &&
    orderHitInBlob(r.order_number, inMail, supplierMatches(r, msg)))
  if (byOrder.length) return byOrder
  const one = supplierLayerRow(open, msg)
  return one ? [one] : []
}

// Casa o e-mail com PEDIDOS (grupos de linhas do stream com o mesmo order
// normalizado) — é o que substitui o pareamento posicional. Camadas:
//   ORDER    — o número do pedido está escrito no e-mail (inequívoco)
//   SUPPLIER — sem número: fornecedor no remetente/assunto + UMA única linha
//              aberta daquele fornecedor (inequívoco por exclusão)
// Sem camada → lista vazia → NADA é gravado.
export type PedidoMatch = { key: string; orderNorm: string | null; layer: 'ORDER' | 'SUPPLIER'; rows: StreamRow[] }
export function matchPedidos(open: StreamRow[], msg: MailMsg): PedidoMatch[] {
  const blob = `${msg.subject} ${msg.text}`
  const hit = new Map<string, StreamRow[]>()
  for (const r of open) {
    if (!r.order_number || isInternalOrderCode(r.order_number)) continue
    if (!orderHitInBlob(r.order_number, blob, supplierMatches(r, msg))) continue
    const k = normOrder(r.order_number)
    hit.set(k, [...(hit.get(k) || []), r])
  }
  if (hit.size) return [...hit.entries()].map(([k, rows]) => ({ key: k, orderNorm: k, layer: 'ORDER' as const, rows }))
  // Exclusividade medida contra TODAS as linhas plausíveis, não só contra as
  // que casaram o token — ver supplierLayerRow.
  const r = supplierLayerRow(open, msg)
  if (r) {
    const orderNorm = r.order_number && !isInternalOrderCode(r.order_number) ? normOrder(r.order_number) : null
    return [{ key: orderNorm || `row:${r.id}`, orderNorm, layer: 'SUPPLIER', rows: [r] }]
  }
  return []
}

// O e-mail DIZ o item? eBay põe o título no assunto ("📦ORDER DELIVERED:
// 22X10 +30 Forgestar…"); Shopify/CARiD trazem bloco "Items in this shipment".
// Temu é cega (nunca traz item) e PayPal/HHP não traz nem item nem pedido —
// medido nos 350 e-mails reais de stream_mail_moves. Devolve pistas de texto;
// quem decide se a pista prova alguma coisa é matchHintsToLines.
const SUBJECT_ITEM = /(?:order delivered|out for delivery|order update|shipped|delivered|on its way)\s*[:：]\s*(.{6,90})/i
const SHIPMENT_BLOCK = /items? in (?:this|your) shipment\s*[:：]?\s*(.{10,400})/i
export function extractItemHints(msg: MailMsg): string[] {
  const hints: string[] = []
  const ms = msg.subject.match(SUBJECT_ITEM)
  if (ms) hints.push(ms[1].trim())
  const mb = msg.text.match(SHIPMENT_BLOCK)
  if (mb) hints.push(mb[1].trim())
  return hints
}

// Uma linha de dinheiro de qualquer uma das origens do rastreio (a enumeração
// viva é ITEM_TABLES em lib/itemTracking.server.ts — 6 desde 03/set/2026).
export type MoneyLine = { table: string; id: string; text: string; qty: number; supplier: string | null; order_number: string }

// Prova textual item↔linha: part number (token com dígito, ≥5 chars) presente
// na pista, OU 3+ palavras significativas da linha presentes (todas, quando a
// linha tem menos que 3 — mas nunca menos que 2: 1 palavra genérica não é
// prova). Sem prova → lista vazia → o chamador NÃO reparte nada.
const sigToks = (s: string): string[] =>
  [...new Set(String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4))]
export function matchHintsToLines(hints: string[], lines: MoneyLine[]): string[] {
  if (!hints.length || !lines.length) return []
  const hintSet = new Set(hints.join(' ').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(Boolean))
  const out: string[] = []
  for (const l of lines) {
    const toks = sigToks(l.text)
    if (!toks.length) continue
    const pnHit = toks.some(t => /\d/.test(t) && t.length >= 5 && hintSet.has(t))
    const wordHits = toks.filter(t => hintSet.has(t)).length
    if (pnHit || (wordHits >= Math.min(3, toks.length) && wordHits >= 2)) out.push(l.id)
  }
  return out
}

// A DECISÃO — pura, uma por (e-mail, pedido). É aqui que morre o chute:
//   EMAIL_ITEM   — 1 rastreio novo + o e-mail prova QUAIS itens → liga só eles
//   ORDER_FANOUT — rastreio ÚNICO do pedido, sem parcial → carimba em TODOS os
//                  itens do pedido ("mesmo que seja o mesmo tracking para
//                  múltiplos itens" — palavras literais do Márcio)
//   NEEDS_ITEMS  — 2+ rastreios no pedido, ou embarque parcial multi-item, ou
//                  várias remessas abertas pra um número só: o rastreio entra
//                  na REMESSA, item NENHUM é chutado, e o dono é perguntado.
export type BoxDecision =
  | { kind: 'EMAIL_ITEM'; tracking: string; lineIds: string[] }
  | { kind: 'ORDER_FANOUT'; tracking: string }
  | { kind: 'NEEDS_ITEMS'; trackings: string[]; reason: string }
export function decideBoxes(a: {
  newTrackings: string[]; prevTrackingCount: number; openNoTrack: number
  lines: MoneyLine[]; hints: string[]; partial: boolean
}): BoxDecision {
  const totalTr = a.prevTrackingCount + a.newTrackings.length
  if (a.newTrackings.length === 1 && a.hints.length && a.lines.length) {
    const ids = matchHintsToLines(a.hints, a.lines)
    if (ids.length) return { kind: 'EMAIL_ITEM', tracking: a.newTrackings[0], lineIds: ids }
  }
  if (totalTr === 1 && a.openNoTrack <= 1 && !(a.partial && a.lines.length > 1))
    return { kind: 'ORDER_FANOUT', tracking: a.newTrackings[0] }
  const reason = totalTr > 1 ? `${totalTr} rastreios no mesmo pedido`
    : a.partial ? 'embarque parcial declarado no e-mail'
    : `${a.openNoTrack} remessas abertas para 1 rastreio`
  return { kind: 'NEEDS_ITEMS', trackings: a.newTrackings, reason }
}

// ── Helpers de banco do casador ─────────────────────────────────────────────
// Índice pedido→linhas de dinheiro das 5 origens do rastreio (só app US — as
// linhas BR moram no banco BR). LEGADO sem consumidor vivo: a enumeração que
// vale é ITEM_TABLES (lib/itemTracking.server.ts), que desde 03/set/2026 inclui
// expenses por lei do dono — este índice NÃO foi atualizado de propósito.
// Na lei antiga ficavam FORA: expenses (staff),
// fixed_cost_expenses (jamais rastreadas), inventory DONATED (o order_number
// dela é código de invoice interna) e QUALQUER order com cara de código
// interno (US.016.1). BLINDAGEM dutyWatch: o lançamento de imposto grava em
// invoice_expenses um order_number que é o nº da FATURA do carrier — outro
// significado; a linha se reconhece pelo carimbo fixo do próprio dutyWatch
// ("import duty & customs clearance") e nunca entra no casamento.
export async function loadMoneyIndex(db: SupabaseClient): Promise<Map<string, MoneyLine[]>> {
  const idx = new Map<string, MoneyLine[]>()
  const push = (table: string, rows: any[], textOf: (r: any) => string, qtyOf: (r: any) => number) => {
    for (const r of rows) {
      const on = String(r.order_number || '').trim()
      if (!on || isInternalOrderCode(on)) continue
      const k = normOrder(on)
      if (k.length < 4) continue
      idx.set(k, [...(idx.get(k) || []), { table, id: String(r.id), text: textOf(r), qty: qtyOf(r), supplier: r.supplier ?? null, order_number: on }])
    }
  }
  const { data: ie } = await db.from('invoice_expenses').select('id, item, part_number, quantity, supplier, order_number').not('order_number', 'is', null)
  push('invoice_expenses', (ie || []).filter(r => !/import duty|customs clearance/i.test(String(r.item || ''))),
    r => [r.item, r.part_number].filter(Boolean).join(' '), r => Number(r.quantity) || 1)
  const { data: inp } = await db.from('inputs').select('id, description, quantity, supplier, order_number').not('order_number', 'is', null)
  push('inputs', inp || [], r => String(r.description || ''), r => Number(r.quantity) || 1)
  const { data: inv } = await db.from('inventory').select('id, description, quantity, supplier, order_number, source_type').not('order_number', 'is', null)
  push('inventory', (inv || []).filter(r => String(r.source_type || '').toUpperCase() !== 'DONATED'),
    r => String(r.description || ''), r => Number(r.quantity) || 1)
  const { data: gd } = await db.from('goods').select('id, description, quantity, supplier, order_number').not('order_number', 'is', null)
  push('goods', gd || [], r => String(r.description || ''), r => Number(r.quantity) || 1)
  const { data: ge } = await db.from('good_expenses').select('id, description, supplier, order_number').not('order_number', 'is', null)
  push('good_expenses', ge || [], r => String(r.description || ''), () => 1)
  return idx
}

// Materializa a ponte item↔remessa em part_stream_items. Item que JÁ está
// ligado a qualquer caixa deste pedido é intocável (o robô nunca troca link
// existente — divergência é assunto de gente); só o que falta é criado.
export async function ensureStreamItemLinks(
  db: SupabaseClient, pedidoStreamIds: string[], targetStreamId: string,
  lines: MoneyLine[], matchedBy: 'ORDER' | 'EMAIL_ITEM',
): Promise<number> {
  if (!lines.length) return 0
  const { data: existing } = await db.from('part_stream_items').select('source_table, source_id').in('stream_id', pedidoStreamIds)
  const have = new Set((existing || []).map((x: any) => `${x.source_table}:${x.source_id}`))
  let n = 0
  for (const l of lines) {
    if (have.has(`${l.table}:${l.id}`)) continue
    const { error } = await db.from('part_stream_items').insert({
      stream_id: targetStreamId, source_app: 'US', source_table: l.table,
      source_id: l.id, qty: l.qty, matched_by: matchedBy,
    })
    if (!error) n++
  }
  return n
}

// ── Spam auto-clean (regra do Márcio 2026-07-24: "apague logo que chegar") ──
// Cada passada do mail-poll varre Caixa de Entrada + Lixo Eletrônico das 3
// contas Hotmail conectadas e manda os remetentes de marketing/junk conhecidos
// para os Itens Excluídos (soft delete — recuperável). A lista é curada: só
// remetentes puramente promocionais/golpe; transacionais nunca entram aqui.
const SPAM_SENDERS: RegExp[] = [
  // Phoenyx Design — ordem do Márcio 04/ago/2026: "delete this and any other email from them, forever"
  /phoenyxdesign\.com/i,
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
  // touchupdirect REMOVIDO 30/jul: virou fornecedor real (pedido $131.05 via
  // PayPal) — as notificações de pedido/envio dele são transacionais agora.
  /koshergoods\.net/i, /negociar\.acerto\.com\.br/i,
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
          const hit = SPAM_SENDERS.some(re => re.test(addr)) || (/facebookmail\.com/i.test(addr) && SPAM_FB_SUBJECT.test(subj)) || /^Lembrete: Anivers/i.test(subj)
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
const SAFE_SENDER = /rockauto\.com|titanmotorsports|hptuners|texas-speed|summitracing|paypal|ups\.com|fedex|usps|dhl|17track|shop\.app|shopify|anthropic|supabase|vercel|regions|c6bank|sunpass|progressive|dukeenergy|speedpay|docusign|echosign|adobesign|hellosign|pandadoc|d4sign|e-notariado|registrocivil|autotagsandtitle|bssparts|vstar|kooksheaders|halltech|modernmuscle|tirerack|discounttire|graph|microsoft\.com|google\.com|apple\.com|sema\.org|classic\.com/i
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
