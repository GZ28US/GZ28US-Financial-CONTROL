// SERVER-ONLY — PURCHASE CAPTURE (ordem do Márcio, 26/jul/2026): "TUDO COMPRADO
// TEM QUE IR PRO STREAM. Todas as compras que chegarem nos e-mails obedecem este
// padrão, automatizado pelo app." Toda ORDER CONFIRMATION que chega no
// gz28us@hotmail vira linha no STREAM (status BOUGHT, com loja/pedido/valor) e o
// grupo REPORTS recebe o aviso pedindo o DESTINO (carro/invoice) quando o
// sistema não souber. Trackings posteriores casam com a linha pelo organizer já
// existente (extractTrackings/matchRows). Dedup por message_id em
// stream_mail_moves. Roda no mail-poll (5min) — PC desligado incluso.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from './streamMail.server'

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'

// Assuntos que caracterizam CONFIRMAÇÃO DE COMPRA (não shipping/marketing).
const ORDER_SUBJECT = /order (confirmation|confirmed|acknowledg)|orders? confirmation|your order (has been )?(received|placed)|thanks? for your (order|purchase)|purchase (is )?confirmed|pedido (confirmado|recebido|realizado)/i
// Remetentes que têm fluxo próprio (APPS, staff travel) ou nunca são compra.
const EXCLUDE_FROM = /anthropic|apple|google|microsoft|paypal\.com|united\.com|delta\.com|aa\.com|latam|copaair|voegol|azul|rockauto\.com/i

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

function storeNameOf(fromAddr: string, fromName: string): string {
  if (fromName && !/no.?reply|notification|orders?@|store\+/i.test(fromName)) return fromName.slice(0, 40)
  const dom = (fromAddr.split('@')[1] || '').replace(/^(mail|email|em|e|mg|mkt|transaction|orders?|shop|store|t|g)\./, '')
  return dom.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) || 'Loja'
}

export async function runPurchaseCapture(db: SupabaseClient): Promise<{ captured: string[] }> {
  const out: string[] = []
  const auth = await getMailAuth(db, 1)
  if (!auth?.refresh_token) return { captured: out }
  const token = await freshAccessToken(db, auth)
  if (!token) return { captured: out }

  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'purchase-capture')
  const seenSet = new Set((seen || []).map((r: any) => r.message_id))

  const inbox = await fetch(`${G}/me/mailFolders/inbox/messages?$top=25&$select=id,subject,from`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
  for (const m of inbox?.value || []) {
    const fromAddr = String(m.from?.emailAddress?.address || '')
    const fromName = String(m.from?.emailAddress?.name || '')
    const subj = String(m.subject || '')
    if (!ORDER_SUBJECT.test(subj) || EXCLUDE_FROM.test(fromAddr)) continue
    const key = `pc:${m.id}`
    if (seenSet.has(key)) continue

    const full = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=body`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
    const text = String(full?.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const store = storeNameOf(fromAddr, fromName)
    // Nº do pedido: padrões comuns (Order #123, Order ID: PO-..., pedido 123...).
    const orders = [...new Set([...text.matchAll(/(?:Order(?:\s*ID)?|Pedido|Invoice)\s*[#:：]?\s*([A-Z]{0,3}[-#]?[A-Z0-9][A-Z0-9-]{4,28})/gi)].map((x) => x[1]).filter((o) => /\d/.test(o)))].slice(0, 5)
    const totals = [...text.matchAll(/(?:Order\s*)?[Tt]otal[^$]{0,20}\$\s*([\d,]+\.\d{2})/g)].map((x) => Number(x[1].replace(/,/g, '')))
    if (!orders.length) continue

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
      }).select().single()
      if (row) out.push(`${store} ${orderNo}`)
    }

    // Report pedindo o destino. Bronca do Márcio (27/jul): a mensagem tem que
    // LISTAR OS ITENS e dizer a que eles PODEM se referir — nunca afirmar que a
    // compra é de um carro, porque muitas não são (ferramenta, insumo, casa).
    if (out.length) {
      const read = await readItems(text)
      const instance = process.env.ULTRAMSG_INSTANCE, tk = process.env.ULTRAMSG_TOKEN, groupId = process.env.ULTRAMSG_GROUP_ID
      if (instance && tk && groupId) {
        const body = [
          `🛒 *COMPRA CAPTURADA — ${store}*`, '',
          `Pedido(s): ${orders.join(', ')}`,
          totals.length ? `Total: ${totals.map(usd).join(' + ')}` : '',
          read.items.length ? `\n*Itens:*\n${read.items.map(i => `• ${i}`).join('\n')}` : '',
          read.guess ? `\n🤔 Pelo que são, parece ${read.guess} — mas é só leitura minha.` : '',
          '', 'Está no STREAM como BOUGHT. *A que se refere?* (carro, insumo da oficina, ferramenta, estoque, pessoal…)',
        ].filter(Boolean).join('\n')
        await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tk, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
        }).catch(() => {})
      }
    }
    await db.from('stream_mail_moves').insert({ message_id: key, subject: subj.slice(0, 120), from_addr: 'purchase-capture', folder_name: store.slice(0, 60), state: 'CAPTURED' })
  }
  return { captured: out }
}
