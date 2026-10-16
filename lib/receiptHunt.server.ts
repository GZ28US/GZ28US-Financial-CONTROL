// lib/receiptHunt.server.ts — O RECIBO DO GRUPO CASA A LINHA DA REGIONS (16/10/2026).
//
// Ordem do Márcio (16/10/2026, via AutoBook GZ28US; confirmada aqui com «yes»): «veja nos grupos staff e time, registre
// esta regra, tem que ser automático pelo robô esta busca». O time posta a FOTO do recibo com a LEGENDA dizendo o destino
// («Compra de parafusos para o Viper», «Maquina + brocas + carrinho para a oficina») nos grupos «🇺🇸GZ28US Time 🇺🇸» e
// «GZ28US - STAFF». A linha da Regions chega dias depois, sem lançamento. Este robô faz a ponte, sozinho, de hora em hora:
//
//   1. LÊ — toda imagem nova desses 2 grupos (espelho whatsapp_messages, app US) passa uma vez pela visão: é recibo?
//      loja, data, hora, total cobrado no cartão, 4 últimos, devolução em dinheiro, itens. O link da UltraMsg não é
//      eterno: recibo vira cópia no bucket expense-receipts na hora. Tudo fica em wa_receipt_scans (uma linha por foto).
//   2. CASA — linha NEW (ou parada no balde A ATRIBUIR) × recibo: total ao centavo + data + loja que bate. Só 1↔1.
//      Linha NEW que já tem gêmeo no app (rank) não é tocada: lançar de novo seria duplicar.
//   3. LANÇA — destino pela legenda: carro citado (nome, código ou modelo único) → invoice viva do carro; sem carro, o
//      classificador da casa (classificaItem) decide ferramenta → assets ou consumível → inputs CONSUMPTION, só com
//      confiança ALTA. Foto anexada como recibo. Casamento com match_engine RECEIPT e reviewed_at nulo = A CONFERIR.
//   4. DEVOLUÇÃO EM DINHEIRO (troca que voltou cash) não passa na Regions: linha NEGATIVA paga em CASH (gaveta) no mesmo
//      destino da compra que este robô lançou na mesma loja (±3 dias).
//   5. O que não fecha com certeza vira ASK (motivo + linha candidata) e aparece na linha do Bank Link — nunca chute.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { num, rank, candidatePool, writeMatch, logMatchEvent, bucketInvoiceId, MARKER_BUCKET, ENGINE_BUCKET, BUCKET_ORIGIN, newLines } from './bankReconcile.server'
import { classificaItem } from './autoBookMail.server'
import { hiddenPayers } from './payerRule'

export const RECEIPT_GROUPS = ['120363422206851200@g.us', '120363400165413030@g.us']   // 🇺🇸GZ28US Time 🇺🇸 · GZ28US - STAFF
export const HUNT_FLOOR = '2026-10-01'      // o robô nasceu em 16/10; o backlog antes disso é da AutoBook, na mão
export const ENGINE_RECEIPT = 'RECEIPT'
const SCAN_LOOKBACK_DAYS = 10
const VISION_MODEL = 'claude-opus-4-8'      // o mesmo motor do botão SCAN (app/api/scan-receipt)
const BOT_SIGNATURE = /Sent by GZ28US Control App/i
const TZ = 'America/New_York'

const dayNY = (iso: string | Date) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ })
const diffDays = (a: string, b: string) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5)
const norm = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const cents = (v: unknown) => Math.round(num(v) * 100)

export type Scan = {
  message_id: string; chat_id: string; sent_at: string; author: string | null; pushname: string | null; caption: string | null
  status: string; store: string | null; receipt_date: string | null; receipt_time: string | null; charged: number | null
  cash_refund: number | null; card_last4: string | null; tender: string | null; items: any; file_url: string | null
  bank_id: string | null; booked_table: string | null; booked_id: string | null; reason: string | null; tries: number | null
}

/* ─────────────── 1. LER AS FOTOS ─────────────── */

// A legenda mora no corpo da imagem; quando a pessoa manda a foto e escreve logo depois, vale o texto do MESMO autor no
// mesmo grupo até 3 min (a mesma régua do robô do FINANCEIRO). Mensagem do próprio app (assinatura) nunca é legenda.
function captionFor(msg: any, neighbours: any[]): string {
  const own = String(msg.body || '').trim()
  if (own) return own
  const t = Date.parse(msg.sent_at)
  const near = neighbours.filter(n => n.chat_id === msg.chat_id && n.author === msg.author && n.type === 'chat' && n.body && !BOT_SIGNATURE.test(n.body) && Math.abs(Date.parse(n.sent_at) - t) <= 3 * 60e3)
    .sort((a, b) => Math.abs(Date.parse(a.sent_at) - t) - Math.abs(Date.parse(b.sent_at) - t))
  return near[0] ? String(near[0].body).trim().slice(0, 500) : ''
}

const VISION_PROMPT = (today: string) => `You read ONE photo posted by the staff of an automotive performance shop in Orlando, FL, in their team WhatsApp group. Decide whether it is a STORE RECEIPT (a printed or digital sales receipt / invoice from a store, gas station, restaurant…) and, if so, read it. Return ONLY one raw JSON object:
{"is_receipt": true|false,
 "store": "store name as printed (e.g. Harbor Freight Tools, Ace Hardware, RaceTrac, Sam's Club)",
 "date": "YYYY-MM-DD of the sale (today is ${today}; resolve a year-less date to the most recent past one)",
 "time": "HH:MM 24h or empty",
 "charged": number — the amount charged to a CARD on this receipt (the card tender line / total paid by card), positive; null if nothing was charged to a card,
 "cash_refund": number — the NET money GIVEN BACK IN CASH to the customer on this receipt, positive; for an EXCHANGE it is the returned value MINUS the new items bought on the same receipt (e.g. returned 69.99, new item 59.24 → 10.75); null if none,
 "card_refund": number — money refunded to a card, positive; null if none,
 "card_last4": "last 4 digits of the card printed on the receipt, or empty",
 "tender": "CARD" | "CASH" | "MIXED" | "UNKNOWN",
 "items": [{"description": "...", "amount": number}]}
Photos of cars, parts, boxes, screens, labels, people or delivery slips WITHOUT prices paid are NOT receipts ("is_receipt": false, everything else empty/null). A fuel receipt IS a receipt. Never invent a number you cannot read — use null.`

async function readPhoto(buf: Buffer, mediaType: string, today: string): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY ausente')
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 1500, messages: [{ role: 'user', content: [block, { type: 'text', text: VISION_PROMPT(today) }] }] }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error('visão HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160))
  const j = await r.json()
  const txt = String(j.content?.map((c: { text?: string }) => c.text || '').join('') || '')
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('visão sem JSON')
  return JSON.parse(txt.slice(a, b + 1))
}

const pos = (v: unknown) => { const n = num(v); return n > 0 ? Math.round(n * 100) / 100 : null }

export async function scanGroupPhotos(db: any, opts: { max: number; deadline: number }): Promise<{ scanned: number; receipts: number; errors: string[] }> {
  const out = { scanned: 0, receipts: 0, errors: [] as string[] }
  const since = new Date(Math.max(Date.parse(HUNT_FLOOR + 'T00:00:00Z'), Date.now() - SCAN_LOOKBACK_DAYS * 864e5)).toISOString()
  const { data: msgs, error } = await db.from('whatsapp_messages').select('message_id, chat_id, author, pushname, type, body, media_url, sent_at')
    .eq('app', 'US').in('chat_id', RECEIPT_GROUPS).gte('sent_at', since).order('sent_at', { ascending: true }).limit(2000)
  if (error) { out.errors.push('whatsapp_messages: ' + error.message); return out }
  const all = msgs || []
  const photos = all.filter((m: any) => (m.type === 'image' || m.type === 'document') && m.media_url)
  if (!photos.length) return out
  const done = new Map<string, any>()
  for (let i = 0; i < photos.length; i += 200) {
    const { data: seen, error: e2 } = await db.from('wa_receipt_scans').select('message_id, status, tries').in('message_id', photos.slice(i, i + 200).map((p: any) => p.message_id))
    if (e2) { out.errors.push('wa_receipt_scans: ' + e2.message); return out }
    for (const s of seen || []) done.set(s.message_id, s)
  }
  const todo = photos.filter((p: any) => { const s = done.get(p.message_id); return !s || (s.status === 'ERROR' && (s.tries || 0) < 3) })
  const today = dayNY(new Date())
  for (const m of todo.slice(0, opts.max)) {
    if (Date.now() > opts.deadline) break
    const prev = done.get(m.message_id)
    const base = { message_id: m.message_id, chat_id: m.chat_id, sent_at: m.sent_at, author: m.author, pushname: m.pushname, caption: captionFor(m, all) || null, tries: (prev?.tries || 0) + 1, scanned_at: new Date().toISOString() }
    try {
      const bin = await fetch(m.media_url, { signal: AbortSignal.timeout(30_000) })
      if (!bin.ok) throw new Error('foto HTTP ' + bin.status)
      const ct = String(bin.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const buf = Buffer.from(await bin.arrayBuffer())
      if (buf.length > 9_000_000) throw new Error('foto grande demais')
      const sniff = buf.subarray(0, 4).toString('hex')
      const mediaType = sniff.startsWith('25504446') ? 'application/pdf' : sniff.startsWith('89504e47') ? 'image/png' : sniff.startsWith('52494646') ? 'image/webp' : sniff.startsWith('ffd8') ? 'image/jpeg' : ct
      if (!(mediaType === 'application/pdf' || mediaType === 'image/jpeg' || mediaType === 'image/png' || mediaType === 'image/webp')) {
        await db.from('wa_receipt_scans').upsert({ ...base, status: 'NOT_RECEIPT', reason: 'arquivo não é foto nem PDF (' + (mediaType || '?') + ')' }); out.scanned++; continue
      }
      const p = await readPhoto(buf, mediaType, today)
      out.scanned++
      if (!p || p.is_receipt !== true) { await db.from('wa_receipt_scans').upsert({ ...base, status: 'NOT_RECEIPT', raw: p || null, reason: null }); continue }
      // Cópia durável do recibo (o link da UltraMsg pode morrer) — é ela que vira receipt_url.
      const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg'
      const path = `wa-receipts/${String(m.sent_at).slice(0, 7)}/${String(m.message_id).replace(/[^A-Za-z0-9_-]+/g, '_').slice(-80)}.${ext}`
      let fileUrl: string | null = null
      const up = await db.storage.from('expense-receipts').upload(path, buf, { contentType: mediaType, upsert: true })
      if (!up.error) fileUrl = db.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
      const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null
      await db.from('wa_receipt_scans').upsert({
        ...base, status: 'RECEIPT', store: String(p.store || '').slice(0, 120) || null, receipt_date: date, receipt_time: String(p.time || '').slice(0, 5) || null,
        charged: pos(p.charged), cash_refund: pos(p.cash_refund), card_refund: pos(p.card_refund), card_last4: /^\d{4}$/.test(String(p.card_last4 || '')) ? String(p.card_last4) : null,
        tender: String(p.tender || '').toUpperCase().slice(0, 10) || null, items: Array.isArray(p.items) ? p.items.slice(0, 40) : null, raw: p, file_url: fileUrl,
        reason: fileUrl ? null : 'cópia do recibo falhou: ' + String(up.error?.message || '').slice(0, 120),
      })
      out.receipts++
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 200)
      out.errors.push(String(m.message_id).slice(-12) + ': ' + msg)
      await db.from('wa_receipt_scans').upsert({ ...base, status: 'ERROR', reason: msg })
    }
  }
  return out
}

/* ─────────────── 2. CASAR ─────────────── */

// Palavras que não identificam loja nenhuma.
const STORE_NOISE = new Set(['inc', 'llc', 'co', 'corp', 'the', 'store', 'stores', 'supercenter', 'super', 'center', 'market', 'orlando', 'fl', 'usa', 'us', 'tools', 'tool', 'company', 'and', 'of', 'gas', 'station', 'pos', 'debit', 'purchase', 'card', 'www', 'com'])
const storeWords = (s: unknown) => norm(s).split(' ').filter(w => w.length >= 3 && !STORE_NOISE.has(w) && !/^\d+$/.test(w))
// A loja do recibo bate com o nome da linha? Uma palavra forte em comum (4+ letras), solta ou colada («SAMS CLUB»/«Sam's Club»).
export function storeMatches(store: string | null, line: any): boolean {
  const sw = storeWords(store)
  if (!sw.length) return false
  const lineText = ' ' + norm((line.merchant || '') + ' ' + (line.name || '')) + ' '
  const glued = lineText.replace(/ /g, '')
  return sw.some(w => w.length >= 4 && (lineText.includes(' ' + w) || glued.includes(w)))
}

// Data: o recibo é do dia da compra; a linha posta depois. Com authorized_date do Plaid, ±1 dia dele; sem, até 5 dias antes da postagem.
// A foto no grupo: de 2 dias antes a 3 dias depois da linha (régua da ordem de 16/10).
export function datesMatch(scan: Pick<Scan, 'receipt_date' | 'sent_at'>, line: any): boolean {
  const ld = String(line.date).slice(0, 10)
  const ad = line.authorized_date ? String(line.authorized_date).slice(0, 10) : null
  const sent = dayNY(scan.sent_at)
  if (diffDays(sent, ld) < -2 || diffDays(sent, ld) > 3) return false
  if (!scan.receipt_date) return false
  if (ad) return Math.abs(diffDays(scan.receipt_date, ad)) <= 1
  return diffDays(scan.receipt_date, ld) <= 0 && diffDays(scan.receipt_date, ld) >= -5
}

// Só a data do recibo contra a linha (sem a régua do post no grupo) — para achar linha que alguém já casou.
const receiptDayFits = (rd: string, line: any) => line.authorized_date ? Math.abs(diffDays(rd, String(line.authorized_date).slice(0, 10))) <= 1 : diffDays(rd, String(line.date).slice(0, 10)) <= 0 && diffDays(rd, String(line.date).slice(0, 10)) >= -5

// O mesmo recibo postado duas vezes (duas fotos, dois grupos) é UMA compra.
const receiptKey = (s: Scan) => [norm(s.store), s.receipt_date, s.receipt_time || '', cents(s.charged), cents(s.cash_refund)].join('|')

/* ─────────────── 3. O DESTINO ─────────────── */

type Ride = { id: string; project_code: string; project_name: string | null; model: string | null }
type Dest = { table: 'invoice_expenses'; invoice_id: string; invoice_code: string; ride: string } | { table: 'inputs'; category: 'CONSUMPTION' } | { table: 'assets' }

async function openInvoiceOf(db: any, rideId: string): Promise<{ id: string; invoice_code: string } | null> {
  const { data } = await db.from('invoices').select('id, invoice_code, live_status, origin').eq('ride_id', rideId).eq('is_quote', false).is('conclusion_date', null).order('created_at', { ascending: false }).limit(3)
  const live = (data || []).filter((i: any) => i.live_status !== 'CLOSED' && i.origin !== BUCKET_ORIGIN)
  return live[0] ? { id: live[0].id, invoice_code: live[0].invoice_code } : null
}

// O carro da legenda: código (US.024), nome inteiro como palavra («WhiteSnake», «WorkTruck» sem o «GZ28US»), ou o MODELO
// quando um só carro da casa tem aquele modelo («Viper» = WhiteSnake). Dois carros = nenhum (pergunta).
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}
export function ridesInCaption(caption: string, rides: Ride[]): Ride[] {
  const cap = ' ' + norm(caption) + ' '
  const capWords = norm(caption).split(' ')
  const hit = new Map<string, Ride>()
  for (const m of caption.matchAll(/\b((?:US|SC|WV|PO|GM)\.\d{3})\b/gi)) for (const r of rides) if (r.project_code.toUpperCase() === m[1].toUpperCase()) hit.set(r.id, r)
  for (const r of rides) {
    const variants = [norm(r.project_name), norm(String(r.project_name || '').replace(/^gz28us\s+/i, ''))].filter(v => v.length >= 4)
    if (variants.some(v => cap.includes(' ' + v + ' '))) hit.set(r.id, r)
    else if (variants.some(v => !v.includes(' ') && v.length >= 7 && capWords.some(w => w.length >= 6 && oneEdit(w, v)))) hit.set(r.id, r)
  }
  if (!hit.size) {
    const byModel = new Map<string, Ride[]>()
    for (const r of rides) { const m = norm(r.model); if (m.length >= 4 && /^[a-z ]+$/.test(m)) byModel.set(m, [...(byModel.get(m) || []), r]) }
    byModel.forEach((rs, m) => { if (rs.length === 1 && cap.includes(' ' + m + ' ')) hit.set(rs[0].id, rs[0]) })
  }
  return [...hit.values()]
}

async function destinationFor(db: any, scan: Scan, rides: Ride[]): Promise<{ dest: Dest | null; why: string }> {
  const caption = String(scan.caption || '')
  const found = caption ? ridesInCaption(caption, rides) : []
  if (found.length > 1) return { dest: null, why: 'a legenda cita mais de um carro: ' + found.map(r => r.project_name).join(', ') }
  if (found.length === 1) {
    const inv = await openInvoiceOf(db, found[0].id)
    if (!inv) return { dest: null, why: `${found[0].project_name} (${found[0].project_code}) não tem invoice aberta` }
    return { dest: { table: 'invoice_expenses', invoice_id: inv.id, invoice_code: inv.invoice_code, ride: String(found[0].project_name || found[0].project_code) }, why: 'carro da legenda' }
  }
  const items = Array.isArray(scan.items) ? scan.items.map((i: any) => String(i?.description || '')).filter(Boolean).join('; ') : ''
  if (!caption && !items) return { dest: null, why: 'sem legenda e sem itens legíveis' }
  const c = await classificaItem((caption ? caption + ' — ' : '') + items, String(scan.store || ''), 'foto do recibo no grupo do time: ' + (caption || '(sem legenda)'))
  if (!c) return { dest: null, why: 'classificador indisponível' }
  if (c.forte && c.classe === 'OFICINA_FERRAMENTA') return { dest: { table: 'assets' }, why: 'ferramenta da oficina · ' + c.motivo }
  if (c.forte && c.classe === 'OFICINA_CONSUMIVEL') return { dest: { table: 'inputs', category: 'CONSUMPTION' }, why: 'consumível da oficina · ' + c.motivo }
  return { dest: null, why: `sem carro na legenda; classe ${c.classe}${c.forte ? '' : ' (confiança baixa)'} — ${c.motivo}` }
}

const descOf = (scan: Scan) => {
  const cap = String(scan.caption || '').replace(/\s+/g, ' ').trim()
  const items = Array.isArray(scan.items) ? scan.items.map((i: any) => String(i?.description || '').trim()).filter(Boolean) : []
  return (cap || items.slice(0, 4).join(', ') || String(scan.store || 'compra')).slice(0, 190)
}

// A linha nova no destino (colunas de cada tabela — o valor mora em price / unit_price).
function rowFor(dest: Dest, scan: Scan, amount: number, opts: { cash?: boolean; purchaseGroup?: string | null; supplier: string; date: string }) {
  const desc = (opts.cash ? 'Devolução em dinheiro — ' : '') + descOf(scan)
  const pay = { payment_date: opts.date, payment_method: opts.cash ? 'CASH' : 'BANK ACCOUNT', paid_from: 'GZ28US', source: 'GZ28US', receipt_url: scan.file_url, purchase_group: opts.purchaseGroup ?? null }
  if (dest.table === 'invoice_expenses') return { ...hiddenPayers('invoice_expenses', null, true), ...pay, invoice_id: dest.invoice_id, item: desc, supplier: opts.supplier, price: amount, quantity: 1, tax: 0, extra: 0, item_discount: 0, expense_date: opts.date, export_status: 'FRESH', picked_up: true, receipt_proves_payment: true }
  if (dest.table === 'inputs') return { ...hiddenPayers('inputs', null, true), ...pay, description: desc, category: dest.category, supplier: opts.supplier, unit_price: amount, quantity: 1, purchase_date: opts.date, picked_up: true }
  return { ...hiddenPayers('assets', null, true), ...pay, description: desc, supplier: opts.supplier, unit_price: amount, quantity: 1, purchase_date: opts.date, nature: 'PART', picked_up: true }
}

/* ─────────────── 4. A RODADA ─────────────── */

export type HuntSummary = { scanned: number; receipts: number; booked: number; moved: number; cash: number; asked: number; errors: string[]; notes: string[] }

export async function huntReceipts(db: any, opts: { deadlineMs: number; maxScans?: number; dry?: boolean }): Promise<HuntSummary> {
  const t0 = Date.now(), deadline = t0 + opts.deadlineMs
  const sum: HuntSummary = { scanned: 0, receipts: 0, booked: 0, moved: 0, cash: 0, asked: 0, errors: [], notes: [] }
  const sc = await scanGroupPhotos(db, { max: opts.maxScans ?? 20, deadline: deadline - 60_000 })
  sum.scanned = sc.scanned; sum.receipts = sc.receipts; sum.errors.push(...sc.errors)

  const { data: scanRows, error: sErr } = await db.from('wa_receipt_scans').select('*').in('status', ['RECEIPT', 'ASK']).gte('sent_at', HUNT_FLOOR)
  if (sErr) { sum.errors.push('wa_receipt_scans: ' + sErr.message); return sum }
  const scans: Scan[] = (scanRows || []).map((s: any) => ({ ...s, charged: s.charged == null ? null : num(s.charged), cash_refund: s.cash_refund == null ? null : num(s.cash_refund) }))
  if (!scans.length) return sum
  const dry = !!opts.dry
  const setScan = async (id: string, patch: Record<string, unknown>) => { if (dry) { sum.notes.push('DRY ' + id.slice(-12) + ' → ' + JSON.stringify(patch).slice(0, 300)); return } await db.from('wa_receipt_scans').update({ ...patch, decided_at: new Date().toISOString() }).eq('message_id', id) }

  // Recibo repetido: fica o primeiro post; os outros viram DUPLICATE do mesmo recibo.
  const firstOf = new Map<string, Scan>()
  for (const s of [...scans].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))) {
    if (!s.charged && !s.cash_refund) continue
    const k = receiptKey(s); const f = firstOf.get(k)
    if (!f) { firstOf.set(k, s); continue }
    await setScan(s.message_id, { status: 'DUPLICATE', reason: 'mesmo recibo de ' + f.message_id.slice(-12) })
  }
  const live = [...firstOf.values()]

  // As linhas: NEW/QUEUED postadas, saída, desde o piso — e as que o motor jogou no balde A ATRIBUIR e ninguém atribuiu.
  const fresh = (await newLines(db, 3000, { since: HUNT_FLOOR })).filter((l: any) => !l.pending && num(l.amount) > 0)
  const { data: bucketRows } = await db.from('bank_transactions').select('id, date, amount, name, merchant, match_status, matched_table, matched_id, match_engine, reviewed_at, authorized_date:raw->>authorized_date')
    .eq('match_engine', ENGINE_BUCKET).eq('match_status', 'MATCHED').is('reviewed_at', null).gte('date', HUNT_FLOOR)
  const lines: any[] = [...fresh.map((l: any) => ({ ...l, inBucket: false })), ...(bucketRows || []).map((l: any) => ({ ...l, inBucket: true }))]

  const fits = (s: Scan, l: any) => !!s.charged && cents(s.charged) === cents(l.amount) && datesMatch(s, l) && storeMatches(s.store, l)
  const pool = fresh.length ? await candidatePool(db) : null
  const { data: rideRows } = await db.from('rides').select('id, project_code, project_name, model').not('project_code', 'ilike', '%.QT.%').not('project_code', 'ilike', 'BR.%')
  const rides: Ride[] = (rideRows || []).filter((r: any) => r.project_code)
  const bucketId = (bucketRows || []).length ? await bucketInvoiceId(db).catch(() => null) : null
  const ask = async (s: Scan, line: any | null, why: string) => { sum.asked++; await setScan(s.message_id, { status: 'ASK', bank_id: line ? String(line.id) : null, reason: why.slice(0, 300) }) }
  const fix = (line: any, label: string, newV: string) => db.from('data_fixes').insert({ check_key: 'receipt-hunt', table_name: 'bank_transactions', row_id: String(line.id), field: 'match', old_value: line.inBucket ? 'A ATRIBUIR' : 'NEW', new_value: newV, label: label.slice(0, 200) }).then(() => undefined, () => undefined)

  for (const s of live.filter(x => !!x.charged)) {
    if (Date.now() > deadline - 15_000) { sum.notes.push('tempo esgotado — continua na próxima rodada'); break }
    const ls = lines.filter(l => fits(s, l))
    if (!ls.length && s.receipt_date) {
      const { data: done } = await db.from('bank_transactions').select('id, date, amount, name, merchant, matched_table, matched_note, authorized_date:raw->>authorized_date')
        .eq('match_status', 'MATCHED').eq('amount', num(s.charged)).gte('date', s.receipt_date).lte('date', new Date(Date.parse(s.receipt_date + 'T12:00:00Z') + 8 * 864e5).toISOString().slice(0, 10))
      const already = (done || []).filter((l: any) => receiptDayFits(s.receipt_date!, l) && storeMatches(s.store, l))
      if (already.length) { await setScan(s.message_id, { status: 'TWIN', bank_id: String(already[0].id), reason: ('a linha da Regions já está casada (' + String(already[0].matched_note || already[0].matched_table || '') + ')').slice(0, 300) }); continue }
    }
    if (!ls.length) {
      // Recibo sem linha AINDA: a linha posta em poucos dias. Passada uma semana, a compra não passou na Regions (outro cartão?).
      const age = diffDays(dayNY(new Date()), s.receipt_date || dayNY(s.sent_at))
      if (age > 7 && s.status !== 'ASK') await ask(s, null, `nenhuma linha da Regions de ${num(s.charged).toFixed(2)} na ${s.store || 'loja ?'} em 7 dias${s.card_last4 && s.card_last4 !== '9785' ? ' — cartão ••' + s.card_last4 + ' não é o da Regions' : ''}`)
      continue
    }
    if (ls.length > 1) { await ask(s, ls[0], `${ls.length} linhas da Regions com o mesmo valor e loja (${ls.map(l => l.date).join(', ')}) — qual é?`); continue }
    const line = ls[0]
    const rivals = live.filter(o => o !== s && fits(o, line))
    if (rivals.length) { await ask(s, line, `${rivals.length + 1} recibos diferentes do grupo servem nesta linha — qual é?`); continue }
    if (!line.inBucket && pool) {
      const twins = rank(line, pool).filter((c: any) => c.tier !== 'COINCIDENCIA' && (c.dd == null || c.dd <= 10))
      if (twins.length) { await setScan(s.message_id, { status: 'TWIN', bank_id: String(line.id), reason: ('a linha já tem registro no app (' + String(twins[0].label || '') + ') — o motor casa; o robô não duplica').slice(0, 300) }); continue }
    }
    const { dest, why } = await destinationFor(db, s, rides)
    if (!dest) { await ask(s, line, why); continue }
    const supplier = String(s.store || line.merchant || line.name || '').slice(0, 120)
    const date = s.receipt_date || String(line.date).slice(0, 10)
    const amount = Math.abs(num(line.amount))
    const destLabel = dest.table === 'invoice_expenses' ? 'CARRO ' + dest.invoice_code + ' (' + dest.ride + ')' : dest.table === 'inputs' ? 'SUPPLIES CONSUMPTION' : 'ATIVO DA OFICINA'
    const note = ('AUTO · RECIBO DO GRUPO · ' + destLabel + ' · ' + (s.pushname || '') + ' «' + String(s.caption || '').slice(0, 60) + '»').slice(0, 150)
    if (dry) { sum.notes.push(`DRY BOOK ${line.date} ${line.merchant || line.name} ${amount} → ${note}`); if (line.inBucket) sum.moved++; else sum.booked++; continue }
    try {
      if (!line.inBucket) {
        const row = rowFor(dest, s, amount, { supplier, date, purchaseGroup: String(line.id) })
        const { data: created, error } = await (db.from(dest.table) as any).insert(row).select('id').single()
        if (error || !created) throw new Error(dest.table + ': ' + (error?.message || 'insert falhou'))
        try {
          await writeMatch(db, line, { table: dest.table, id: String(created.id) }, { matched_note: note, match_engine: ENGINE_RECEIPT, match_batch: null, reviewed_at: null })
        } catch (e) { await (db.from(dest.table) as any).delete().eq('id', created.id); throw e }
        await setScan(s.message_id, { status: 'BOOKED', bank_id: String(line.id), booked_table: dest.table, booked_id: String(created.id), reason: why.slice(0, 300) })
        await fix(line, note, dest.table + ':' + created.id)
        sum.booked++
      } else {
        // Linha no balde: a linha do balde vira a do carro (mesma linha, invoice nova); supplies/ativo = linha nova e o balde sai.
        if (!bucketId || line.matched_table !== 'invoice_expenses') throw new Error('balde indisponível')
        const { data: brow } = await db.from('invoice_expenses').select('*').eq('id', line.matched_id).maybeSingle()
        if (!brow || brow.invoice_id !== bucketId || !String(brow.item || '').includes(MARKER_BUCKET) || String(brow.paid_from || '') === 'GZ28BR') throw new Error('linha do balde mudou')
        const newTable: string = dest.table
        let newId = String(brow.id)
        if (dest.table === 'invoice_expenses') {
          const { data: moved } = await db.from('invoice_expenses').update({ invoice_id: dest.invoice_id, item: descOf(s), supplier, receipt_url: s.file_url, expense_date: date, payment_date: date, receipt_proves_payment: true, picked_up: true, position: null, updated_at: new Date().toISOString() }).eq('id', brow.id).eq('invoice_id', bucketId).select('id')
          if (!moved || !moved.length) throw new Error('linha do balde mudou')
        } else {
          const { data: created, error } = await (db.from(dest.table) as any).insert(rowFor(dest, s, amount, { supplier, date, purchaseGroup: String(line.id) })).select('id').single()
          if (error || !created) throw new Error(dest.table + ': ' + (error?.message || 'insert falhou'))
          newId = String(created.id)
        }
        const { data: repointed } = await db.from('bank_transactions').update({ matched_table: newTable, matched_id: newId, matched_note: note, match_engine: ENGINE_RECEIPT, reviewed_at: null })
          .eq('id', line.id).eq('match_status', 'MATCHED').eq('match_engine', ENGINE_BUCKET).eq('matched_id', brow.id).is('reviewed_at', null).select('id')
        if (!repointed || !repointed.length) {
          if (dest.table === 'invoice_expenses') await db.from('invoice_expenses').update({ invoice_id: bucketId, item: brow.item, supplier: brow.supplier, receipt_url: brow.receipt_url, expense_date: brow.expense_date, payment_date: brow.payment_date, receipt_proves_payment: brow.receipt_proves_payment, picked_up: brow.picked_up, position: brow.position }).eq('id', brow.id)
          else await (db.from(dest.table) as any).delete().eq('id', newId)
          throw new Error('linha do banco já decidida')
        }
        if (dest.table !== 'invoice_expenses') await db.from('invoice_expenses').delete().eq('id', brow.id).eq('invoice_id', bucketId).eq('purchase_group', line.id)
        await logMatchEvent(db, line, 'MATCH', { matched_table: newTable, matched_id: newId, note, engine: ENGINE_RECEIPT })
        await setScan(s.message_id, { status: 'BOOKED', bank_id: String(line.id), booked_table: newTable, booked_id: newId, reason: ('do balde · ' + why).slice(0, 300) })
        await fix(line, note + ' (saiu do balde)', newTable + ':' + newId)
        sum.moved++
      }
      lines.splice(lines.indexOf(line), 1)
    } catch (e) {
      sum.errors.push((s.store || '?') + ' ' + num(s.charged).toFixed(2) + ': ' + String((e as Error)?.message || e).slice(0, 160))
    }
  }

  // DEVOLUÇÃO EM DINHEIRO: não passa na Regions. Volta no MESMO destino da compra da mesma loja — lançada pelo robô (BOOKED)
  // ou casada na mão (TWIN: o ponteiro da linha da Regions diz onde mora). Compra do MESMO dia ganha; ±3 dias se for a única.
  const cashOnes = live.filter(x => x.cash_refund && x.cash_refund > 0)
  if (cashOnes.length) {
    const { data: prior } = await db.from('wa_receipt_scans').select('*').in('status', ['BOOKED', 'TWIN']).gte('sent_at', HUNT_FLOOR)
    for (const s of cashOnes) {
      if (Date.now() > deadline - 10_000) break
      const refund = num(s.cash_refund)
      const sameStore = (prior || []).filter((o: any) => o.message_id !== s.message_id && storeWords(o.store).some(w => w.length >= 4 && storeWords(s.store).includes(w)) && o.receipt_date && s.receipt_date && Math.abs(diffDays(o.receipt_date, s.receipt_date)) <= 3)
      const sameDay = sameStore.filter((o: any) => o.receipt_date === s.receipt_date)
      const origin = sameDay.length === 1 ? sameDay : sameStore
      const age = diffDays(dayNY(new Date()), s.receipt_date || dayNY(s.sent_at))
      if (origin.length !== 1) {
        if (age > 2 && s.status !== 'ASK') await ask(s, null, origin.length ? `devolução em dinheiro de ${refund.toFixed(2)}: ${origin.length} compras da mesma loja — de qual?` : `devolução em dinheiro de ${refund.toFixed(2)} na ${s.store || 'loja ?'}: a compra original não está no app pelo recibo do grupo — lance o crédito (CASH, gaveta) na mão`)
        continue
      }
      const o = origin[0]
      try {
        // Onde a compra mora: o que o robô lançou, ou o registro que a linha da Regions aponta.
        let table: string | null = o.booked_table, id: string | null = o.booked_id
        if (o.status === 'TWIN' && o.bank_id) { const { data: bl } = await db.from('bank_transactions').select('matched_table, matched_id').eq('id', o.bank_id).maybeSingle(); table = bl?.matched_table || null; id = bl?.matched_id || null }
        let dest: Dest | null = null
        if (table === 'invoice_expenses' && id) { const { data: r } = await db.from('invoice_expenses').select('invoice_id').eq('id', id).maybeSingle(); if (r) dest = { table: 'invoice_expenses', invoice_id: r.invoice_id, invoice_code: '', ride: '' } }
        else if (table === 'inputs' && id) { const { data: r } = await db.from('inputs').select('category').eq('id', id).maybeSingle(); if (r) dest = { table: 'inputs', category: (r.category || 'CONSUMPTION') as 'CONSUMPTION' } }
        else if (table === 'assets' && id) dest = { table: 'assets' }
        if (!dest) { if (s.status !== 'ASK') await ask(s, null, `devolução em dinheiro de ${refund.toFixed(2)}: a compra da ${o.store || 'loja'} está casada em «${table || '?'}», que não é carro, supplies nem ativo — lance na mão`); continue }
        // NUNCA DUPLICA: crédito do mesmo valor já lançado (pela AutoBook, na mão) no mesmo destino, ±5 dias.
        const lo = new Date(Date.parse((s.receipt_date || dayNY(s.sent_at)) + 'T12:00:00Z') - 5 * 864e5).toISOString().slice(0, 10)
        const hi = new Date(Date.parse((s.receipt_date || dayNY(s.sent_at)) + 'T12:00:00Z') + 5 * 864e5).toISOString().slice(0, 10)
        const twinQ = dest.table === 'invoice_expenses'
          ? db.from('invoice_expenses').select('id').eq('invoice_id', dest.invoice_id).eq('price', -refund).gte('expense_date', lo).lte('expense_date', hi)
          : (db.from(dest.table) as any).select('id').eq('unit_price', -refund).gte('purchase_date', lo).lte('purchase_date', hi)
        const { data: twin } = await twinQ
        if (twin && twin.length) { await setScan(s.message_id, { status: 'TWIN', booked_table: dest.table, booked_id: String(twin[0].id), reason: 'o crédito em dinheiro já está lançado no app' }); continue }
        if (dry) { sum.notes.push(`DRY CASH −${refund} ${s.store} → ${dest.table} (compra ${String(o.message_id).slice(-12)})`); sum.cash++; continue }
        const row = rowFor(dest, s, -refund, { cash: true, supplier: String(s.store || o.store || '').slice(0, 120), date: s.receipt_date || dayNY(s.sent_at) })
        const { data: created, error } = await (db.from(dest.table) as any).insert(row).select('id').single()
        if (error || !created) throw new Error(dest.table + ': ' + (error?.message || 'insert falhou'))
        await setScan(s.message_id, { status: 'CASH_BOOKED', booked_table: dest.table, booked_id: String(created.id), reason: 'crédito em CASH (gaveta) da compra ' + String(o.message_id).slice(-12) })
        await db.from('data_fixes').insert({ check_key: 'receipt-hunt', table_name: dest.table, row_id: String(created.id), field: 'insert', old_value: null, new_value: String(-refund), label: ('DEVOLUÇÃO EM DINHEIRO · ' + (s.store || '') + ' · «' + String(s.caption || '').slice(0, 60) + '»').slice(0, 200) }).then(() => undefined, () => undefined)
        sum.cash++
      } catch (e) { sum.errors.push('devolução ' + (s.store || '?') + ': ' + String((e as Error)?.message || e).slice(0, 160)) }
    }
  }
  return sum
}

export type ReceiptHint = { caption: string | null; store: string | null; charged: number | null; file_url: string | null; who: string | null; reason: string | null; status: string }
// A dica do recibo para a linha parada no Bank Link: o que o grupo disse e por que o robô não lançou.
export async function receiptHints(db: any, bankIds: string[]): Promise<Map<string, ReceiptHint>> {
  const out = new Map<string, ReceiptHint>()
  if (!bankIds.length) return out
  try {
    for (let i = 0; i < bankIds.length; i += 200) {
      const { data } = await db.from('wa_receipt_scans').select('bank_id, caption, store, charged, file_url, pushname, reason, status').in('bank_id', bankIds.slice(i, i + 200)).in('status', ['ASK', 'TWIN'])
      for (const r of data || []) out.set(String(r.bank_id), { caption: r.caption, store: r.store, charged: r.charged == null ? null : num(r.charged), file_url: r.file_url, who: r.pushname, reason: r.reason, status: r.status })
    }
  } catch { /* sem a tabela: sem dica */ }
  return out
}
