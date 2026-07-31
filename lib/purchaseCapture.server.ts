// SERVER-ONLY — PURCHASE CAPTURE (ordem do Márcio, 26/jul/2026): "TUDO COMPRADO
// TEM QUE IR PRO STREAM. Todas as compras que chegarem nos e-mails obedecem este
// padrão, automatizado pelo app." Toda ORDER CONFIRMATION vira linha no STREAM
// (status BOUGHT, com loja/pedido/valor) e o grupo REPORTS recebe o aviso
// pedindo o DESTINO (carro/invoice) quando o sistema não souber.
//
// AUDITORIA 30/jul (bronca "this must be bullet-proof"): a 1ª versão só olhava
// o topo do INBOX do Hotmail, exigia um nº de pedido, excluía PayPal e morria em
// silêncio — o pedido TouchUpDirect (recibo PayPal) passou batido. Agora:
//   • varre TODAS as pastas do Hotmail (organizer/sweeps não escondem mais nada)
//   • varre também o Gmail (slot 4 — pedidos Walmart chegam lá)
//   • recibos do PayPal contam como compra (loja = comerciante do recibo)
//   • sem nº de pedido mas com total → nº sintético LOJA-DATA-VALOR
//   • captura o ENDEREÇO DE ENTREGA e ALARMA se não for o galpão (11320)
//   • nada é pulado em silêncio: skip vira linha SKIPPED no stream_mail_moves
// Dedup por internetMessageId + por order_number. Roda no mail-poll (5min).

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from './streamMail.server'
import { gmailAccessToken } from './appsMail.server'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'

// Compras anteriores a isto já foram tratadas à mão — não ressuscitar.
const CAPTURE_EPOCH = '2026-07-20T00:00:00Z'

// Assuntos que caracterizam CONFIRMAÇÃO DE COMPRA (não shipping/marketing).
const ORDER_SUBJECT = /order (confirmation|confirmed|acknowledg|received|placed|details)|orders? confirmation|your order (has been )?(received|placed|confirmed)|new order|thanks? for (your|shopping)|thank you for your (order|purchase)|purchase (is )?confirmed|receipt for your payment|your receipt|payment receipt|you('ve| have) made a payment|we('ve| have) received your order|invoice for (your )?order|pedido (confirmado|recebido|realizado)|recibo d[eo] pagamento/i
// Remetentes que têm fluxo próprio (APPS, staff travel) ou nunca são compra.
// PayPal SAIU da lista (30/jul) — recibo PayPal é compra (caso TouchUpDirect).
const EXCLUDE_FROM = /anthropic|apple|google|microsoft|united\.com|delta\.com|aa\.com|latam|copaair|voegol|azul|rockauto\.com|stripe\.com|vercel|supabase|ultramsg|godaddy|17track/i

// Endereço de entrega — o galpão é 11320 Space Blvd; qualquer outro destino em
// linha US é motivo de ALARME no grupo (caso Temu indo pro endereço velho).
const SHOP_ADDR = /11320|space\s*blvd/i
const SHIP_RE = /(?:ship(?:ping|s)?\s*(?:to|address)|deliver(?:y)?\s*(?:to|address)|entrega(?:r)?\s*(?:em|para))\s*[:：]?\s*(.{10,140})/i
function extractShipTo(text: string): string | null {
  const m = text.match(SHIP_RE)
  if (!m) return null
  return m[1].split(/\s+(?:Bill(?:ing)?|Payment|Order\b|Items?\b|Subtotal|Total\b|Qty|Track|View\b)/i)[0].trim().slice(0, 140) || null
}

// Lê o corpo do e-mail e devolve os ITENS comprados + um palpite do que a
// compra pode ser. O palpite é sempre apresentado como leitura, nunca como
// afirmação — quem decide o destino é o Márcio.
async function readItems(text: string): Promise<{ items: string[]; guess: string }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { items: [], guess: '' }
  const prompt = `Este é o texto de um e-mail de confirmação de compra de uma oficina de preparação de carros (GZ28). Devolva SOMENTE JSON:
{"items":["nome do item (qtd) — preço", ...],"guess":"uma frase curta em português dizendo a que a compra PODE se referir, começando com 'coisa de' ou 'material de' etc, sem afirmar carro nenhum; string vazia se não der para supor"}
Regras: até 8 itens, use o nome do produto como está no e-mail (traduza só se estiver ilegível); NÃO invente item; o guess é uma hipótese do TIPO de compra (ferramenta de oficina, insumo de limpeza, peça de motor, eletrônico, item pessoal/casa), nunca o nome de um carro.

E-MAIL:
${text.slice(0, 6000)}`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
  }).then(x => x.json()).catch(() => null)
  const raw = String(r?.content?.[0]?.text || '').replace(/```json|```/g, '').trim()
  try {
    const j = JSON.parse(raw)
    return { items: Array.isArray(j.items) ? j.items.slice(0, 8).map(String) : [], guess: String(j.guess || '') }
  } catch { return { items: [], guess: '' } }
}

function storeNameOf(fromAddr: string, fromName: string, subject: string): string {
  // Recibo PayPal: a loja é o comerciante do recibo, nunca "PayPal".
  if (/paypal/i.test(fromAddr)) {
    const m = subject.match(/payment to (.{2,50})$/i)
    if (m) return m[1].replace(/\s+(LLC|Inc\.?|Ltd\.?|Corp\.?)$/i, '').trim().slice(0, 40)
  }
  if (fromName && !/no.?reply|notification|orders?@|store\+|paypal/i.test(fromName)) return fromName.slice(0, 40)
  const dom = (fromAddr.split('@')[1] || '').replace(/^(mail|email|em|e|mg|mkt|transaction|orders?|shop|store|t|g)\./, '')
  return dom.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) || 'Loja'
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
}

type MailMsg = { key: string; fromAddr: string; fromName: string; subject: string; text: string; dateStr: string; box: string }

// Núcleo compartilhado Hotmail/Gmail: decide se é compra, enrola no STREAM e
// pede o destino no grupo. Devolve os labels inseridos.
async function processPurchase(db: SupabaseClient, seenSet: Set<string>, msg: MailMsg): Promise<string[]> {
  const inserted: string[] = []
  if (seenSet.has(msg.key)) return inserted
  if (!ORDER_SUBJECT.test(msg.subject) || EXCLUDE_FROM.test(msg.fromAddr)) return inserted

  const store = storeNameOf(msg.fromAddr, msg.fromName, msg.subject)
  const text = msg.text
  // Nº do pedido: padrões comuns + Transaction ID (PayPal).
  let orders = [...new Set([...text.matchAll(/(?:Order(?:\s*(?:ID|Number|No\.?))?|Pedido|Invoice|Transaction(?:\s*ID)?|Confirmation(?:\s*(?:number|#))?)\s*[#:：]?\s*([A-Z]{0,3}[-#]?[A-Z0-9][A-Z0-9-]{4,28})/gi)].map((x) => x[1]).filter((o) => /\d/.test(o)))].slice(0, 5)
  const totals = [...text.matchAll(/(?:Order\s*|Grand\s*)?[Tt]otal[^$]{0,20}\$\s*([\d,]+\.\d{2})/g)].map((x) => Number(x[1].replace(/,/g, '')))
  // Sem nº de pedido mas com total → nº sintético (LOJA-DATA-VALOR), padrão que
  // já usávamos à mão. Sem pedido E sem total → skip REGISTRADO, nunca mudo.
  if (!orders.length && totals.length) {
    orders = [`${store.toUpperCase().replace(/\W+/g, '').slice(0, 12)}-${msg.dateStr.replace(/-/g, '')}-${totals[0].toFixed(2).replace('.', '')}`]
  }
  const shipTo = extractShipTo(text)

  if (!orders.length) {
    await db.from('stream_mail_moves').insert({ message_id: msg.key, subject: msg.subject.slice(0, 120), from_addr: 'purchase-capture', folder_name: msg.box, state: 'SKIPPED — no order/total' })
    seenSet.add(msg.key)
    return inserted
  }

  for (let i = 0; i < orders.length; i++) {
    const orderNo = orders[i]
    const amt = totals[i] ?? (orders.length === 1 ? totals[0] : undefined)
    const { data: dup } = await db.from('part_streams').select('id').eq('order_number', orderNo).limit(1)
    if (dup?.length) continue
    const { data: row } = await db.from('part_streams').insert({
      supplier: store,
      item: `${store} ${orderNo}${amt ? ' — ' + usd(amt) : ''} — ❓ destino a definir`,
      order_number: orderNo,
      status: 'BOUGHT',
      app: 'US',
      ship_to: shipTo,
    }).select().single()
    if (row) inserted.push(`${store} ${orderNo}`)
  }

  // Report pedindo o destino — só quando esta mensagem realmente inseriu algo.
  // Bronca do Márcio (27/jul): a mensagem tem que LISTAR OS ITENS e dizer a que
  // eles PODEM se referir — nunca afirmar que a compra é de um carro.
  if (inserted.length) {
    const read = await readItems(text)
    const instance = process.env.ULTRAMSG_INSTANCE, tk = process.env.ULTRAMSG_TOKEN, groupId = process.env.ULTRAMSG_GROUP_ID
    if (instance && tk && groupId) {
      const addrAlarm = shipTo && !SHOP_ADDR.test(shipTo)
        ? `\n🚨 *ENDEREÇO DE ENTREGA NÃO É O GALPÃO:*\n${shipTo}`
        : (shipTo ? `\n📍 Entrega: galpão (11320 Space Blvd) ✓` : '')
      const body = [
        `🛒 *COMPRA CAPTURADA — ${store}*`, '',
        `Pedido(s): ${orders.join(', ')}`,
        totals.length ? `Total: ${totals.map(usd).join(' + ')}` : '',
        read.items.length ? `\n*Itens:*\n${read.items.map(i => `• ${i}`).join('\n')}` : '',
        addrAlarm,
        read.guess ? `\n🤔 Pelo que são, parece ${read.guess} — mas é só leitura minha.` : '',
        '', 'Está no STREAM como BOUGHT. *A que se refere?* (carro, insumo da oficina, ferramenta, estoque, pessoal…)',
      ].filter(Boolean).join('\n')
      await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tk, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
      }).catch(() => {})
    }
  }
  await db.from('stream_mail_moves').insert({ message_id: msg.key, subject: msg.subject.slice(0, 120), from_addr: 'purchase-capture', folder_name: store.slice(0, 60), state: inserted.length ? 'CAPTURED' : 'DUP' })
  seenSet.add(msg.key)
  return inserted
}

// ── Hotmail (slot 1) — TODAS as pastas, não só o inbox ──────────────────────
async function scanHotmail(db: SupabaseClient, seenSet: Set<string>, out: string[]): Promise<void> {
  const auth = await getMailAuth(db, 1)
  if (!auth?.refresh_token) return
  const token = await freshAccessToken(db, auth)
  if (!token) return
  const self = String(auth.account || 'gz28us@hotmail.com').toLowerCase()

  const list = await fetch(`${G}/me/messages?$top=40&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,internetMessageId`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
  for (const m of list?.value || []) {
    const fromAddr = String(m.from?.emailAddress?.address || '').toLowerCase()
    if (!fromAddr || fromAddr === self) continue
    const received = String(m.receivedDateTime || '')
    if (received && received < CAPTURE_EPOCH) continue
    const key = `pc:${m.internetMessageId || m.id}`
    const subj = String(m.subject || '')
    if (seenSet.has(key) || !ORDER_SUBJECT.test(subj) || EXCLUDE_FROM.test(fromAddr)) continue

    const full = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=body`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
    const text = stripHtml(String(full?.body?.content || ''))
    out.push(...await processPurchase(db, seenSet, {
      key, fromAddr, fromName: String(m.from?.emailAddress?.name || ''), subject: subj,
      text, dateStr: received.slice(0, 10) || new Date().toISOString().slice(0, 10), box: 'hotmail',
    }))
  }
}

// ── Gmail (slot 4) — pedidos Walmart & cia chegam lá (task #59) ─────────────
function gmailBodyText(payload: any): string {
  const chunks: string[] = []
  const walk = (p: any) => {
    if (!p) return
    if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || '')) {
      try { chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) } catch { /* skip part */ }
    }
    for (const c of p.parts || []) walk(c)
  }
  walk(payload)
  return stripHtml(chunks.join(' '))
}

async function scanGmail(db: SupabaseClient, seenSet: Set<string>, out: string[]): Promise<void> {
  const token = await gmailAccessToken(db)
  if (!token) return
  const q = encodeURIComponent('newer_than:5d (subject:(order) OR subject:(receipt) OR subject:(purchase) OR subject:(payment) OR subject:(pedido))')
  const list = await fetch(`${GM}/messages?q=${q}&maxResults=25`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
  for (const stub of list?.messages || []) {
    const key = `pc:gm:${stub.id}`
    if (seenSet.has(key)) continue
    const m = await fetch(`${GM}/messages/${stub.id}?format=full`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
    if (!m?.payload) continue
    const header = (n: string) => String((m.payload.headers || []).find((h: any) => h.name?.toLowerCase() === n)?.value || '')
    const fromRaw = header('from')
    const fromAddr = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).toLowerCase().trim()
    const fromName = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim()
    const subj = header('subject')
    if (!ORDER_SUBJECT.test(subj) || EXCLUDE_FROM.test(fromAddr)) continue
    const dateStr = new Date(Number(m.internalDate || Date.now())).toISOString().slice(0, 10)
    if (dateStr < CAPTURE_EPOCH.slice(0, 10)) continue
    out.push(...await processPurchase(db, seenSet, {
      key, fromAddr, fromName, subject: subj, text: gmailBodyText(m.payload), dateStr, box: 'gmail',
    }))
  }
}

export async function runPurchaseCapture(db: SupabaseClient): Promise<{ captured: string[] }> {
  const out: string[] = []
  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'purchase-capture')
  const seenSet = new Set((seen || []).map((r: any) => r.message_id))

  try { await scanHotmail(db, seenSet, out) } catch (e) { console.error('[purchase-capture hotmail]', e) }
  try { await scanGmail(db, seenSet, out) } catch (e) { console.error('[purchase-capture gmail]', e) }
  return { captured: out }
}
