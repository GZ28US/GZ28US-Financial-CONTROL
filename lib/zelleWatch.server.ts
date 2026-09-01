// SERVER-ONLY — ZELLE WATCH (ordem do Márcio, 13/ago/2026: "zelle is a serious
// thing, fix it, so it never happens anymore"). Um Zelle de $875 do Martez caiu
// 12/ago 19:57, o organizer arquivou o aviso do Regions antes da ronda humana e
// o dinheiro passou despercebido: a ronda só enxerga a CAIXA DE ENTRADA, e o
// e-mail já não estava nela.
//
// Correção: este watcher varre a CAIXA INTEIRA (todas as pastas, via /me/messages
// sem folder), não só a inbox — pasta nenhuma esconde dinheiro. Roda a cada 5 min
// no mail-poll.
//
//   ENTRADA ($ recebido)  → lança em invoice_payments quando o remetente já tem
//                           histórico (mesma invoice do último pagamento dele) e
//                           reporta no WhatsApp; sem histórico → PENDING + alerta.
//   SAÍDA ($ enviado)     → nunca lança sozinho (falta o carro/invoice) — alerta
//                           pra virar expense na mão.
//
// Dedup pelo NÚMERO DE CONFIRMAÇÃO do Zelle, procurado nas duas tabelas — o mesmo
// aviso pode ser reprocessado sem nunca duplicar dinheiro ([[financeiro-learning-order]]:
// o robô só lança o que tem certeza, o resto é PENDING_HUMAN).

import type { SupabaseClient } from '@supabase/supabase-js'
import { waSafeTarget } from '@/lib/waSelfGuard.server'

const G = 'https://graph.microsoft.com/v1.0'
const SIGNATURE = 'Sent by GZ28US Control App®'
// 31/ago/2026: NÃO pode ser o número da própria instância (13213150973). A
// UltraMsg recusa mensagem pro próprio número e o envio morre calado — 26
// avisos (FILA DE COMPRAS, COMPRA TEMU, VIP MAIL, ZELLE, MAIL WATCH) sumiram
// assim sem ninguém perceber. Todo aviso pessoal vai pro grupo REPORTS.
const MARCIO_US = '120363425950692194@g.us'
const ACCOUNT = 'gz28us@hotmail.com' // Regions escreve só nesta caixa
const FIRST_RUN_MIN = 60

type Hit = {
  direction: 'IN' | 'OUT'
  amount: number
  party: string
  conf: string
  when: string
  memo?: string
}

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

async function msToken(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('account', ACCOUNT).limit(1)
  const auth = data?.[0]
  if (!auth?.refresh_token) return null
  const tk = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access' }),
  }).then(r => r.json()).catch(() => null)
  if (!tk?.access_token) return null
  if (tk.refresh_token && tk.refresh_token !== auth.refresh_token) {
    await db.from('stream_mail_auth').update({ refresh_token: tk.refresh_token }).eq('id', auth.id)
  }
  return tk.access_token
}

const money = (s: string) => Number(String(s).replace(/,/g, ''))
const clean = (h: string) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

// Os dois avisos do Regions/Zelle, textos estáveis desde 2025.
export function parseZelle(subject: string, body: string): Hit | null {
  const t = clean(body)
  const inMatch = t.match(/deposited the \$([\d,]+\.\d{2}) payment from ([^(]+?)\s*\(confirmation number (\d+)\)/i)
  if (inMatch) return { direction: 'IN', amount: money(inMatch[1]), party: inMatch[2].trim(), conf: inMatch[3], when: '' }
  if (/payment to .+ (is complete|has finished processing)/i.test(`${subject} ${t}`)) {
    const amount = t.match(/Amount \$([\d,]+\.\d{2})/i)
    const conf = t.match(/Confirmation Number (\d+)/i)
    const to = t.match(/To ([A-Za-z0-9 .,&'-]+?) \(/) || subject.match(/payment to (.+?) is complete/i)
    const memo = t.match(/Message ([^]{0,80}?) As of /i)
    if (amount && conf) return { direction: 'OUT', amount: money(amount[1]), party: (to?.[1] || '?').trim(), conf: conf[1], when: '', memo: memo?.[1]?.trim() }
  }
  return null
}

// Já lançado? O número de confirmação vive na descrição do pagamento (entrada)
// ou na linha de despesa (saída) — é a impressão digital do Zelle.
async function alreadyBooked(db: SupabaseClient, hit: Hit): Promise<boolean> {
  if (hit.direction === 'IN') {
    const { data } = await db.from('invoice_payments').select('id').ilike('description', `%${hit.conf}%`).limit(1)
    return !!data?.length
  }
  const { data } = await db.from('invoice_expenses').select('id').ilike('item', `%${hit.conf}%`).limit(1)
  return !!data?.length
}

// Destino de uma ENTRADA (LEI 13/ago, caso Martez): o dinheiro novo entra na
// invoice ABERTA MAIS NOVA do cliente — foi exatamente o erro corrigido à mão
// (4 Zelles de agosto caíram na US.035.1 de junho enquanto a US.035.3, aberta no
// mesmo dia do 1º Zelle, ficava com "down payment" de mentira). Só se o cliente
// não for reconhecido é que cai no histórico (última invoice em que ele pagou).
async function targetInvoice(db: SupabaseClient, party: string): Promise<{ invoice_id: string; code: string } | null> {
  const words = party.trim().split(/\s+/).filter(w => w.length > 2)
  if (!words.length) return null

  const { data: clients } = await db.from('clients').select('id, name')
  const norm = (s: string) => String(s || '').toUpperCase()
  const client = (clients || []).find(c => words.every(w => norm(c.name).includes(norm(w))))
    || (clients || []).find(c => norm(c.name).includes(norm(words[0])) && words.length === 1)
  if (client) {
    // Invoice viva mais recente do cliente (nunca uma quote, nunca concluída).
    const { data: invs } = await db.from('invoices').select('id, invoice_code, conclusion_date, created_at')
      .eq('client_id', client.id).eq('is_quote', false).is('conclusion_date', null)
      .order('created_at', { ascending: false }).limit(1)
    if (invs?.[0]) return { invoice_id: invs[0].id, code: invs[0].invoice_code || '?' }
  }

  const { data } = await db.from('invoice_payments').select('invoice_id, payment_date').ilike('description', `%${words[0]}%`).not('invoice_id', 'is', null).order('payment_date', { ascending: false }).limit(1)
  const invoice_id = data?.[0]?.invoice_id
  if (!invoice_id) return null
  const { data: inv } = await db.from('invoices').select('invoice_code').eq('id', invoice_id).limit(1)
  return { invoice_id, code: inv?.[0]?.invoice_code || '?' }
}

export async function runZelleWatch(db: SupabaseClient): Promise<{ booked: string[]; pending: string[] }> {
  const runStart = new Date().toISOString()
  const booked: string[] = [], pending: string[] = []
  const token = await msToken(db)
  if (!token) return { booked, pending }

  const { data: st } = await db.from('whatsapp_polling_state').select('*').eq('id', 'zelle-watch').limit(1)
  const cursor = st?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()

  // CAIXA INTEIRA, não só a inbox — o organizer arquiva em minutos.
  const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=subject,from,receivedDateTime,body`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => null)

  for (const m of res?.value || []) {
    const from = m.from?.emailAddress?.address || ''
    if (!/regions\.com$/i.test(from)) continue
    const hit = parseZelle(String(m.subject || ''), m.body?.content || '')
    if (!hit) continue
    hit.when = String(m.receivedDateTime || runStart).slice(0, 10)
    if (await alreadyBooked(db, hit)) continue

    if (hit.direction === 'IN') {
      const target = await targetInvoice(db, hit.party)
      if (target) {
        await db.from('invoice_payments').insert({
          invoice_id: target.invoice_id, amount: hit.amount, payment_date: hit.when, source: 'ZELLE', paid_to: 'GZ28US',
          description: `Zelle from ${hit.party} — conf ${hit.conf} (Regions •9336)`,
        })
        booked.push(`${hit.party} $${hit.amount} → ${target.code}`)
        await wa(MARCIO_US, `💰 *ZELLE RECEBIDO — LANÇADO*\n$${hit.amount.toFixed(2)} de ${hit.party}\nInvoice ${target.code}\nConf ${hit.conf} · Regions •9336`)
      } else {
        pending.push(`${hit.party} $${hit.amount}`)
        await wa(MARCIO_US, `⚠️ *ZELLE RECEBIDO — SEM DESTINO*\n$${hit.amount.toFixed(2)} de ${hit.party}\nConf ${hit.conf} · Regions •9336\n\nPrimeiro pagamento deste remetente — me diga a invoice e eu lanço.`)
      }
    } else {
      pending.push(`OUT ${hit.party} $${hit.amount}`)
      await wa(MARCIO_US, `💸 *ZELLE ENVIADO*\n$${hit.amount.toFixed(2)} para ${hit.party}${hit.memo ? `\n"${hit.memo}"` : ''}\nConf ${hit.conf} · Regions •9336\n\nMe diga o carro/invoice e eu lanço a despesa.`)
    }
  }

  await db.from('whatsapp_polling_state').upsert({ id: 'zelle-watch', last_message_id: runStart, updated_at: runStart })
  return { booked, pending }
}
