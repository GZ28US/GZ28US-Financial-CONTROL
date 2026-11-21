// SERVER-ONLY — CAR DEALS, etapa 4 (21/11/2026): o robô dos grupos. Spec: docs/SPEC-CAR-DEALS-2026-11-21.md §6.
//
//   1. LER    comprovante postado no grupo COMPRA de um deal → deal_movements PROPOSED (valor, data, taxa, quem pagou,
//             quem recebeu e a referência fiscal lidos do documento). Chave `car_deals.group_scan` — nasce DESLIGADA.
//   2. NUNCA  alocar nem confirmar: alocação errada é exatamente a causa da confusão que esta área veio curar.
//             A proposta espera um humano (aba MOVEMENTS do deal).
//   3. POSTAR a planilha (xlsx + pdf) nos destinos do deal (car_deals.post_targets), cada um na SUA visão. Sozinho só
//             com DUAS chaves ligadas — `car_deals.auto_post` (geral) E car_deals.auto_post (do deal) — e nunca a mesma
//             planilha duas vezes (hash do conteúdo em car_deals.last_post_hash). À mão, pelo botão da aba TRIPA SHEET.
//
// O piso: só mensagem enviada DEPOIS de o robô nascer. O histórico dos grupos é carga da sessão CC Sidney, à mão,
// com trilha — ler o passado aqui duplicaria tudo.
import type { SupabaseClient } from '@supabase/supabase-js'
import { settingOn } from '@/lib/appSettings.server'
import { buildDealSheet, dealSheetPdf, dealSheetXlsx, type SheetView } from '@/lib/dealSheet.server'
import { dealLabel } from '@/lib/carDeals'

export const SCAN_FLOOR = '2026-11-22T00:00:00Z'
export const KEY_SCAN = 'car_deals.group_scan'
export const KEY_POST = 'car_deals.auto_post'
const VISION_MODEL = 'claude-opus-4-8'      // o mesmo motor do botão SCAN e do receiptHunt
const KINDS = ['FX_CONTRACT', 'PIX', 'WIRE', 'ZELLE', 'STRIPE', 'CASH']

const PROMPT = (today: string) => `You are reading ONE image or PDF posted in a WhatsApp group where a Brazilian client, a car exporter and a US shop settle the purchase of a car. Decide whether it is PROOF OF A PAYMENT (a PIX receipt, a bank transfer / wire / SWIFT confirmation, a foreign-exchange contract «contrato de câmbio», a Zelle confirmation, a card charge receipt). Return ONLY one JSON object:
{"is_payment": true|false,
 "kind": "PIX" | "WIRE" | "FX_CONTRACT" | "ZELLE" | "STRIPE" | "CASH",
 "date": "YYYY-MM-DD the payment happened (today is ${today})",
 "amount_usd": number or null — the amount in US dollars, only if the document itself states it,
 "amount_brl": number or null — the amount in Brazilian reais, only if the document itself states it,
 "fx_rate": number or null — the BRL per USD rate, only if printed,
 "payer": "name of who PAID, as printed, or empty",
 "recipient": "name of who RECEIVED, as printed, or empty",
 "reference": "exchange contract number, proforma / invoice number, or other reference printed on it, or empty",
 "summary": "one short line saying what the document is"}
Brazilian numbers use a dot for thousands and a comma for decimals (84.600,00 means 84600.00). Photos of cars, titles, bills of lading, proformas, invoices, price lists, chats or spreadsheets are NOT proof of payment ("is_payment": false). Never invent a number you cannot read — use null.`

async function readDoc(buf: Buffer, mediaType: string, today: string): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY ausente')
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 800, messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT(today) }] }] }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error('visão HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160))
  const j = await r.json()
  const txt = String(j.content?.map((c: { text?: string }) => c.text || '').join('') || '')
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('visão sem JSON')
  return JSON.parse(txt.slice(a, b + 1))
}

const pos = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null }
const dayNY = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

export type ScanSummary = { on: boolean; scanned: number; proposed: number; errors: string[]; notes: string[] }

export async function scanDealGroups(db: SupabaseClient, opts: { max: number; deadline: number; dry?: boolean; force?: boolean }): Promise<ScanSummary> {
  const out: ScanSummary = { on: await settingOn(KEY_SCAN), scanned: 0, proposed: 0, errors: [], notes: [] }
  if (!out.on && !opts.force) { out.notes.push(`chave ${KEY_SCAN} desligada — nada lido`); return out }
  const { data: deals, error: e0 } = await db.from('car_deals').select('id, deal_no, wa_chat_id').eq('status', 'OPEN').not('wa_chat_id', 'is', null)
  if (e0) { out.errors.push('car_deals: ' + e0.message); return out }
  const today = dayNY(new Date())
  for (const deal of deals || []) {
    if (Date.now() > opts.deadline || out.scanned >= opts.max) break
    const { data: msgs, error } = await db.from('whatsapp_messages').select('message_id, chat_id, author, pushname, type, body, media_url, sent_at, from_me')
      .eq('app', 'US').eq('chat_id', deal.wa_chat_id).gte('sent_at', SCAN_FLOOR).in('type', ['image', 'document']).order('sent_at', { ascending: true }).limit(500)
    if (error) { out.errors.push('whatsapp_messages: ' + error.message); continue }
    // o que o próprio app postou (a planilha) não é comprovante
    const docs = (msgs || []).filter((m: any) => m.media_url && !m.from_me)
    if (!docs.length) continue
    const { data: seen } = await db.from('deal_group_scans').select('message_id, status, tries').in('message_id', docs.map((m: any) => m.message_id))
    const done = new Map<string, any>((seen || []).map((s: any) => [s.message_id, s]))
    const todo = docs.filter((m: any) => { const s = done.get(m.message_id); return !s || (s.status === 'ERROR' && (s.tries || 0) < 3) })
    for (const m of todo) {
      if (Date.now() > opts.deadline || out.scanned >= opts.max) break
      const base = { message_id: m.message_id, tries: (done.get(m.message_id)?.tries || 0) + 1, scanned_at: new Date().toISOString() }
      try {
        const bin = await fetch(m.media_url, { signal: AbortSignal.timeout(30_000) })
        if (!bin.ok) throw new Error('arquivo HTTP ' + bin.status)
        const buf = Buffer.from(await bin.arrayBuffer())
        if (buf.length > 9_000_000) throw new Error('arquivo grande demais')
        const sniff = buf.subarray(0, 4).toString('hex')
        const mediaType = sniff.startsWith('25504446') ? 'application/pdf' : sniff.startsWith('89504e47') ? 'image/png' : sniff.startsWith('52494646') ? 'image/webp' : sniff.startsWith('ffd8') ? 'image/jpeg' : ''
        out.scanned++
        if (!mediaType) { if (!opts.dry) await db.from('deal_group_scans').upsert({ ...base, status: 'NOT_PAYMENT', reason: 'arquivo não é foto nem PDF' }); continue }
        const p = await readDoc(buf, mediaType, today)
        const usd = pos(p?.amount_usd), brl = pos(p?.amount_brl), rate = pos(p?.fx_rate)
        // sem valor nenhum não há o que propor; sem US$ mas com R$ e taxa, o dólar sai da conta
        const amountUsd = usd ?? (brl && rate ? Math.round(brl / rate * 100) / 100 : null)
        if (!p || p.is_payment !== true || !amountUsd) {
          if (!opts.dry) await db.from('deal_group_scans').upsert({ ...base, status: 'NOT_PAYMENT', raw: p || null, reason: p?.is_payment === true ? 'comprovante sem valor em dólar legível' : null })
          if (p?.is_payment === true) out.notes.push(`${dealLabel(deal.deal_no)}: comprovante sem US$ legível (${String(p.summary || '').slice(0, 80)})`)
          continue
        }
        if (opts.dry) { out.proposed++; out.notes.push(`[dry] ${dealLabel(deal.deal_no)}: ${amountUsd} ${p.kind} ${p.date} — ${String(p.summary || '').slice(0, 80)}`); continue }
        // cópia durável do comprovante (o link da UltraMsg morre)
        const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg'
        const path = `car-deals/${String(m.sent_at).slice(0, 7)}/${String(m.message_id).replace(/[^A-Za-z0-9_-]+/g, '_').slice(-80)}.${ext}`
        const up = await db.storage.from('expense-receipts').upload(path, buf, { contentType: mediaType, upsert: true })
        const fileUrl = up.error ? null : db.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
        const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : String(m.sent_at).slice(0, 10)
        // possível repetição: mesmo valor em US$ num raio de 3 dias — avisa na nota, não descarta (quem decide é gente)
        const { data: twins } = await db.from('deal_movements').select('id, occurred_on, status').eq('amount_usd', amountUsd)
          .gte('occurred_on', new Date(Date.parse(date) - 3 * 864e5).toISOString().slice(0, 10)).lte('occurred_on', new Date(Date.parse(date) + 3 * 864e5).toISOString().slice(0, 10))
        const note = [
          `Read by the robot from the ${dealLabel(deal.deal_no)} group (${m.pushname || m.author || 'unknown sender'}). ${String(p.summary || '').slice(0, 160)}`,
          'Direction (from → to) is a guess: check it before confirming.',
          (twins || []).length ? `POSSIBLE DUPLICATE: ${twins!.length} movement(s) with the same US$ amount within 3 days already in the book.` : '',
        ].filter(Boolean).join(' ')
        // a direção é palpite: o robô não sabe se o dinheiro foi à Tripa Trading ou ao GZ28 — fica PROPOSED para gente corrigir
        const { data: mov, error: e2 } = await db.from('deal_movements').insert({
          occurred_on: date, kind: KINDS.includes(String(p.kind)) ? p.kind : 'WIRE', from_party: 'SIDNEY', to_party: 'TRIPA_TRADING',
          amount_usd: amountUsd, amount_brl: brl, counterparty_label: String(p.recipient || '').slice(0, 80) || null,
          payer_label: String(p.payer || '').slice(0, 80) || null, fiscal_ref: String(p.reference || '').slice(0, 80) || null,
          receipt_urls: fileUrl ? [fileUrl] : [], source_message_id: m.message_id, status: 'PROPOSED', note,
        }).select('id').single()
        if (e2 || !mov) throw new Error('deal_movements: ' + (e2?.message || 'sem linha'))
        await db.from('deal_group_scans').upsert({ ...base, status: 'PROPOSED', movement_id: mov.id, raw: p, reason: null })
        out.proposed++
      } catch (e) {
        const msg = String((e as Error)?.message || e).slice(0, 200)
        out.errors.push(String(m.message_id).slice(-12) + ': ' + msg)
        if (!opts.dry) await db.from('deal_group_scans').upsert({ ...base, status: 'ERROR', reason: msg })
      }
    }
  }
  return out
}

export type PostTarget = { chat_id: string; app?: string; label?: string; view?: SheetView }
export type PostResult = { posted: boolean; reason: string | null; hash: string | null; sent: { to: string; label: string | null; view: SheetView; file: string; ok: boolean; error: string | null }[] }

// Posta a planilha do deal nos destinos dele. `send` é quem fala com o WhatsApp (a rota /api/whatsapp, com a credencial de
// quem pediu) — este arquivo não tem como mandar nada sozinho.
//   auto: true  → só com as DUAS chaves ligadas, e nunca a mesma planilha duas vezes
//   auto: false → pedido de gente (botão); manda mesmo com as chaves desligadas, e avisa se a planilha é igual à última
export async function postDealSheet(
  db: SupabaseClient, dealId: string,
  opts: { auto: boolean; force?: boolean; send: (p: { to: string; body: string; documentBase64: string; filename: string }) => Promise<{ ok: boolean; error: string | null }> },
): Promise<PostResult> {
  const none = (reason: string): PostResult => ({ posted: false, reason, hash: null, sent: [] })
  const { data: deal } = await db.from('car_deals').select('id, deal_no, auto_post, post_targets, last_post_hash').eq('id', dealId).maybeSingle()
  if (!deal) return none('deal not found')
  if (opts.auto) {
    if (!(await settingOn(KEY_POST))) return none(`switch ${KEY_POST} is OFF`)
    if (!deal.auto_post) return none('automatic posting is OFF for this deal')
  }
  const targets: PostTarget[] = (Array.isArray(deal.post_targets) ? deal.post_targets : []).filter((t: any) => t && typeof t.chat_id === 'string' && t.chat_id.trim())
  if (!targets.length) return none('this deal has no posting targets')
  const full = await buildDealSheet(db, dealId, 'GZ28')
  if (!full) return none('deal not found')
  if (deal.last_post_hash === full.hash && !opts.force) return { ...none('the sheet is identical to the last one posted'), hash: full.hash }

  const res: PostResult = { posted: false, reason: null, hash: full.hash, sent: [] }
  const byView = new Map<SheetView, { xlsx: string; pdf: string; name: string }>()
  for (const t of targets) {
    const view: SheetView = t.view === 'SIDNEY' ? 'SIDNEY' : t.view === 'TRIPA' ? 'TRIPA' : 'GZ28'
    const row = (file: string, ok: boolean, error: string | null) => res.sent.push({ to: t.chat_id, label: t.label || null, view, file, ok, error })
    // os grupos BR vivem na instância do app BR; esta rota só fala pela instância US
    if (String(t.app || 'us').toLowerCase() !== 'us') { row('—', false, 'target is on the BR number: not supported yet'); continue }
    if (!byView.has(view)) {
      const s = view === 'GZ28' ? full : await buildDealSheet(db, dealId, view)
      if (!s) { row('—', false, 'sheet not built'); continue }
      byView.set(view, { xlsx: (await dealSheetXlsx(s)).toString('base64'), pdf: dealSheetPdf(s).toString('base64'), name: s.fileName })
    }
    const f = byView.get(view)!
    const caption = `${dealLabel(deal.deal_no)} — planilha atualizada`
    for (const [ext, b64] of [['xlsx', f.xlsx], ['pdf', f.pdf]] as const) {
      const r = await opts.send({ to: t.chat_id, body: caption, documentBase64: b64, filename: `${f.name}.${ext}` })
      row(`${f.name}.${ext}`, r.ok, r.error)
    }
  }
  res.posted = res.sent.some(s => s.ok)
  // só grava o hash quando TUDO saiu: falha parcial tem de poder ser repetida
  if (res.sent.length && res.sent.every(s => s.ok)) await db.from('car_deals').update({ last_post_hash: full.hash, updated_at: new Date().toISOString() }).eq('id', dealId)
  else if (res.posted) res.reason = 'some files did not go out'
  else res.reason = 'nothing went out'
  return res
}
