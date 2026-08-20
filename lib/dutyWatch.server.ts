// SERVER-ONLY — DUTY WATCH (ordem do Márcio, 20/ago/2026, caso BONOSS #207546):
// peça importada chega e o custo REAL só fecha semanas depois, quando o carrier
// manda a fatura de imposto/desembaraço. O de minimis de US$ 800 morreu (China/HK
// em 02/mai/2025, todo o resto em 29/ago/2025): HOJE toda remessa internacional,
// de qualquer valor, paga imposto e exige entrada aduaneira. Ou seja: TODA compra
// de fora gera uma segunda cobrança que chega SOZINHA, dias depois da caixa — e
// era exatamente o tipo de dinheiro que passava batido.
//
// Este watcher varre a caixa INTEIRA (Hotmail, todas as pastas) + o Gmail atrás
// de fatura de imposto/desembaraço de DHL/FedEx/UPS e:
//
//   waybill BATE com part_streams.tracking_number  → lança invoice_expenses na(s)
//                                                    MESMA(S) invoice(s) da remessa,
//                                                    rateado igual entre elas
//   waybill não bate (ou sem valor legível)        → NÃO lança; alerta o Márcio
//                                                    pra decidir ([[financeiro-learning-order]])
//
// Dedup pelo nº da fatura do carrier (ou carrier+waybill), procurado no item da
// despesa — a mesma fatura pode ser reprocessada sem nunca duplicar dinheiro.
// Roda a cada 5 min dentro do mail-poll: funciona com o PC desligado.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from './streamMail.server'
import { gmailAccessToken } from './appsMail.server'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'
const MARCIO_US = '13213150973@c.us'
const FIRST_RUN_MIN = 180

// Faturas anteriores a isto já foram tratadas à mão — não ressuscitar.
const DUTY_EPOCH = '2026-08-01T00:00:00Z'

const CARRIER_FROM = /dhl\.(com|de)|fedex\.com|ups\.com|aramex\.com/i
const DUTY_SUBJECT = /duty|customs|import charge|import tax|brokerage|vat invoice|tax invoice|clearance (fee|invoice|charge)|entry summary|payment request|amount due|imposto de importa|despacho aduaneiro/i
// O gate roda no ASSUNTO, nunca no corpo: o aviso de rastreio do próprio BONOSS
// diz "Customs clearance status updated" no corpo e, se ele contasse, um e-mail
// de status viraria imposto lançado. Aviso de remessa nunca é cobrança.
const NOT_A_BILL = /shipment (status|update|notification)|status update|tracking (update|notification)|on its way|out for delivery|has been delivered|delivery notification|proof of delivery/i
// Uma fatura JÁ PAGA é receita liquidada ([[receipt-means-paid]]); uma cobrança
// em aberto vira despesa NÃO paga e alerta pra pagar.
const PAID_HINT = /receipt|payment received|paid in full|thank you for your payment|payment confirmation/i

type Carrier = 'DHL' | 'FedEx' | 'UPS' | 'Aramex'
type MailMsg = { key: string; fromAddr: string; subject: string; text: string; dateStr: string; box: string }

function carrierOf(fromAddr: string, subject: string): Carrier {
  const s = `${fromAddr} ${subject}`
  if (/fedex/i.test(s)) return 'FedEx'
  if (/\bups\b|ups\.com/i.test(s)) return 'UPS'
  if (/aramex/i.test(s)) return 'Aramex'
  return 'DHL'
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

async function wa(body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: MARCIO_US, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

// Candidatos a waybill: DHL 10 dígitos, FedEx 12, UPS 1Z+16. Não filtramos aqui
// por carrier — quem decide é o banco: só vira destino o número que EXISTE em
// part_streams. Número que não bate nunca lança nada.
export function waybillCandidates(text: string): string[] {
  const hits = [...text.matchAll(/\b(1Z[0-9A-Z]{16}|\d{12}|\d{10})\b/gi)].map(m => m[1].toUpperCase())
  return [...new Set(hits)].slice(0, 20)
}

// Valor da cobrança. `labelled` diz se veio de um rótulo explícito de total a
// pagar — e SÓ valor rotulado pode virar lançamento automático. O maior "$x" da
// mensagem serve para o alerta ao Márcio, nunca para debitar um carro sozinho
// ([[financeiro-learning-order]]: o robô só lança o que tem certeza).
export function dutyAmount(text: string): { amount: number | null; labelled: boolean } {
  const hit = text.match(/(?:total\s*(?:amount\s*)?(?:due|payable|charges?)|amount\s*due|balance\s*due|total\s*invoice\s*(?:amount|value))[^$\d]{0,24}\$?\s*([\d,]+\.\d{2})/i)
  if (hit) return { amount: Number(hit[1].replace(/,/g, '')), labelled: true }
  const all = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => Number(m[1].replace(/,/g, ''))).filter(n => n > 0)
  return { amount: all.length ? Math.max(...all) : null, labelled: false }
}

// Nº da fatura do carrier — a impressão digital do dedup. O lookahead exige um
// DÍGITO no token: sem ele, "Tax Invoice  Invoice no. 8-123-45678" capturava a
// própria palavra "Invoice" e o dedup virava pó (FedEx).
export function carrierInvoiceNo(text: string): string | null {
  const m = text.match(/(?:invoice|fatura|document)\s*(?:number|no\.?|#)?\s*[:#]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,20})/i)
  return m ? m[1].replace(/^#+/, '') : null
}

async function alreadyBooked(db: SupabaseClient, fingerprint: string): Promise<boolean> {
  const { data } = await db.from('invoice_expenses').select('id').ilike('item', `%${fingerprint}%`).limit(1)
  return !!data?.length
}

// ── Coleta: Hotmail (caixa INTEIRA — pasta nenhuma esconde dinheiro) ─────────
async function hotmailMessages(db: SupabaseClient, cursor: string): Promise<MailMsg[]> {
  const auth = await getMailAuth(db, 1)
  if (!auth?.refresh_token) return []
  const token = await freshAccessToken(db, auth)
  if (!token) return []
  const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=id,subject,from,receivedDateTime,body`
  const res = await fetch(url, { headers: gh(token) }).then(r => r.json()).catch(() => null)
  return (res?.value || []).map((m: any): MailMsg => ({
    key: String(m.id),
    fromAddr: String(m.from?.emailAddress?.address || ''),
    subject: String(m.subject || ''),
    text: stripHtml(String(m.body?.content || '')),
    dateStr: String(m.receivedDateTime || '').slice(0, 10),
    box: 'hotmail',
  }))
}

// ── Coleta: Gmail (slot 4) — o recibo do BONOSS caiu lá, a fatura do DHL pode
// cair também. in:anywhere já inclui spam e lixeira.
async function gmailMessages(db: SupabaseClient): Promise<MailMsg[]> {
  const token = await gmailAccessToken(db)
  if (!token) return []
  const q = 'in:anywhere newer_than:7d (dhl OR fedex OR ups OR duty OR customs OR brokerage)'
  const list = await fetch(`${GM}/messages?${new URLSearchParams({ maxResults: '50', q })}`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
  const out: MailMsg[] = []
  for (const { id } of list?.messages || []) {
    const m = await fetch(`${GM}/messages/${id}?format=full`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    if (!m?.id) continue
    const hdr = (n: string) => (m.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === n)?.value || ''
    const parts: string[] = []
    const walk = (p: any) => {
      if (p?.body?.data) parts.push(Buffer.from(p.body.data, 'base64').toString('utf8'))
      for (const c of p?.parts || []) walk(c)
    }
    walk(m.payload)
    out.push({
      key: String(m.id),
      fromAddr: String(hdr('from')),
      subject: String(hdr('subject')),
      text: stripHtml(parts.join(' ')),
      dateStr: new Date(Number(m.internalDate || Date.now())).toISOString().slice(0, 10),
      box: 'gmail',
    })
  }
  return out
}

export async function runDutyWatch(db: SupabaseClient): Promise<{ booked: string[]; pending: string[] }> {
  const runStart = new Date().toISOString()
  const booked: string[] = [], pending: string[] = []

  const { data: st } = await db.from('whatsapp_polling_state').select('*').eq('id', 'duty-watch').limit(1)
  let cursor = st?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()
  if (cursor < DUTY_EPOCH) cursor = DUTY_EPOCH

  const msgs = [...await hotmailMessages(db, cursor), ...await gmailMessages(db)]

  for (const msg of msgs) {
    if (!CARRIER_FROM.test(msg.fromAddr)) continue
    if (!DUTY_SUBJECT.test(msg.subject) || NOT_A_BILL.test(msg.subject)) continue

    const carrier = carrierOf(msg.fromAddr, msg.subject)
    const { amount, labelled } = dutyAmount(msg.text)
    const invNo = carrierInvoiceNo(msg.text)
    const waybills = waybillCandidates(`${msg.subject} ${msg.text}`)

    // Só remessas que o STREAM conhece viram destino.
    const { data: rows } = waybills.length
      ? await db.from('part_streams').select('invoice_id, item, tracking_number, supplier').in('tracking_number', waybills)
      : { data: [] as any[] }
    const matched = (rows || []).filter(r => r.invoice_id)
    const fingerprint = invNo ? `${carrier} inv ${invNo}` : `${carrier} waybill ${waybills[0] || msg.key}`
    if (await alreadyBooked(db, fingerprint)) continue

    if (!amount || !labelled || !matched.length) {
      pending.push(`${carrier} ${invNo || waybills[0] || '?'} ${amount ? usd(amount) : 'valor ilegível'}`)
      await wa([
        `🛃 *IMPOSTO DE IMPORTAÇÃO — SEM DESTINO*`,
        ``,
        `Carrier: *${carrier}*`,
        amount ? `Valor: *${usd(amount)}*${labelled ? '' : ' _(li do corpo do e-mail, sem rótulo de total — confira)_'}` : `Valor: ⚠️ não consegui ler no e-mail`,
        invNo ? `Fatura: ${invNo}` : '',
        waybills.length ? `Waybill: ${waybills.slice(0, 3).join(', ')}` : `Waybill: não encontrado`,
        ``,
        !matched.length && waybills.length ? `Nenhuma remessa do STREAM bate com esse waybill.` : '',
        `Me diga o carro/invoice e eu lanço.`,
      ].filter(Boolean).join('\n'))
      continue
    }

    // Rateio: uma fatura de imposto cobre a remessa inteira; se a remessa serve
    // 2 carros (caso BONOSS: 1 pedido, 1 par pra cada), o imposto se divide
    // igual entre as invoices — nunca duplicado ([[car-cost-allocation]]).
    const invoiceIds = [...new Set(matched.map(r => String(r.invoice_id)))]
    const share = Math.round((amount / invoiceIds.length) * 100) / 100
    const paid = PAID_HINT.test(`${msg.subject} ${msg.text.slice(0, 400)}`)
    const wb = matched[0]?.tracking_number || waybills[0] || '?'
    const supplier = matched[0]?.supplier || carrier

    const { data: invs } = await db.from('invoices').select('id, invoice_code').in('id', invoiceIds)
    const codeOf = (id: string) => invs?.find((i: any) => i.id === id)?.invoice_code || '?'

    for (let i = 0; i < invoiceIds.length; i++) {
      await db.from('invoice_expenses').insert({
        invoice_id: invoiceIds[i],
        supplier: carrier,
        item: `${carrier} import duty & customs clearance — ${supplier} shipment, waybill ${wb}${invoiceIds.length > 1 ? ` (${i + 1}/${invoiceIds.length} split)` : ''} — ${fingerprint}`,
        price: share,
        quantity: 1,
        tax: 0,
        extra: 0,
        expense_date: msg.dateStr || runStart.slice(0, 10),
        payment_date: paid ? (msg.dateStr || runStart.slice(0, 10)) : null,
        order_number: invNo,
      })
    }
    booked.push(`${carrier} ${usd(amount)} → ${invoiceIds.map(codeOf).join(' + ')}`)
    await wa([
      `🛃 *IMPOSTO DE IMPORTAÇÃO — LANÇADO*`,
      ``,
      `Carrier: *${carrier}*  ·  Waybill ${wb}`,
      `Remessa: ${supplier}`,
      `Valor: *${usd(amount)}*${invoiceIds.length > 1 ? ` — ${usd(share)} em cada` : ''}`,
      `Invoice: ${invoiceIds.map(codeOf).join(' + ')}`,
      ``,
      paid ? `✅ Já paga — lançada como PAGA.` : `⚠️ *EM ABERTO* — o ${carrier} ainda espera esse pagamento.`,
    ].join('\n'))
  }

  await db.from('whatsapp_polling_state').upsert({ id: 'duty-watch', last_message_id: runStart, updated_at: runStart })
  return { booked, pending }
}
