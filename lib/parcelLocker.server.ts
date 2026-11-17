// SERVER-ONLY — ROBÔ DO LOCKER (17/11/2026).
//
//   «independent of in whose's name it is, send always the instructions with code, supplier and what it is to chris at her us
//    phone. that should be automatic, done by the robot, we here don't even have to process these emails… it MUST report the
//    supplier, what it is (the bought item) and the pick up instructions with code and everything.»  — Márcio, 17/11/2026
//
// O QUE FAZ, a cada passada (cron próprio de 5 min — o mail-poll já carrega 15 robôs em série, lei de 04/set):
//   1. lê, em TODAS as caixas conectadas, os avisos de locker (Parcel Pending / Quadient hoje; outro serviço de locker entra na
//      lista LOCKER_SENDERS e cai no mesmo caminho);
//   2. tira do e-mail: unidade, local, locker, código de retirada, quem entregou, taxa e prazo;
//   3. descobre O QUE É: e-mail de «delivered» da loja/transportadora na mesma janela → nº do pedido / rastreio → tabelas do app;
//   4. manda UMA mensagem por pacote no WhatsApp US da Chris e arquiva o e-mail com a marca d'água (mail-file), para ele nunca
//      chegar à rodada de e-mail.
//
// TRAVAS:
//   • CHAVE `notify.chris.parcel_locker` em app_settings — nasce DESLIGADA (lei de 06/11/2026). Desligada, o robô faz 1–3, grava a
//     mensagem como PREVIEW e NÃO manda nem arquiva. É assim que se confere o texto antes de armar.
//   • UM AVISO POR PACOTE: o mesmo pacote chega em duas caixas (slot 1 e slot 5) e volta todo dia como «REMINDER». A chave do
//     pacote é locker+código; o segundo e-mail do mesmo pacote só é arquivado (DUPLICATE).
//   • NADA DE PASSADO: só manda aviso de e-mail que chegou há menos de FRESH_HOURS. Aviso velho vira STALE — a Chris costuma
//     retirar antes, e código de pacote já retirado é ruído (ordem de 22/10/2026). Ligar a chave não dispara o histórico.
//   • O ITEM NUNCA É INVENTADO: sem pedido casado, a mensagem diz que não foi identificado. A Amazon esconde o nome do produto no
//     e-mail (só a categoria, «Pet Supplies»); quando o app ainda não tem o pedido lançado, é a categoria que vai, dita como tal.
//   • Texto de fora (local, transportadora, item) passa por semMarcacao.

import type { SupabaseClient } from '@supabase/supabase-js'
import { listMailAuths, freshAccessToken, mailProvider, fetchRecentGmail, fetchRecentMessages, extractTrackings, type MailAuth, type MailMsg } from '@/lib/streamMail.server'
import { enviaUltra } from '@/lib/waSend.server'
import { semMarcacao } from '@/lib/waMentions'
import { settingOn } from '@/lib/appSettings.server'
import { selfCallHeaders } from '@/lib/apiAuth.server'

export const PARCEL_SWITCH = 'notify.chris.parcel_locker'
// WhatsApp US da Chris («chris at her us phone»).
const CHRIS_US = '14072717278@c.us'
const SIGNATURE = 'Sent by GZ28US Control App®'
const LOOKBACK_DAYS = 3        // janela de leitura: cobre o REMINDER do dia seguinte
const FRESH_HOURS = 3          // só avisa o que acabou de chegar
const DEDUPE_DAYS = 15
const TZ = 'America/New_York'  // o assunto é o apê de Orlando

// Serviços de locker / sala de encomendas. Remetente novo entra aqui; o que não tiver leitor próprio vai no caminho genérico
// (o corpo do e-mail limpo), que ainda entrega código e instruções.
const LOCKER_SENDERS: Array<{ service: string; from: RegExp; subject: RegExp }> = [
  { service: 'Parcel Pending', from: /@parcelpending\.com$/i, subject: /parcel pending/i },
  { service: 'Luxer One', from: /@luxerone\.com$/i, subject: /package|delivery|pick ?up/i },
  { service: 'Package Concierge', from: /@packageconcierge\.com$/i, subject: /package|delivery|pick ?up/i },
  { service: 'Amazon Hub', from: /@amazon\.com$/i, subject: /ready for pick ?up|hub locker|pickup code/i },
]
const GMAIL_Q = '(from:parcelpending.com OR from:luxerone.com OR from:packageconcierge.com OR (from:amazon.com ("ready for pickup" OR "hub locker")))'

const dataHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const L = (s: string | number | Date) => dataHora.format(new Date(s)).replace(',', '').replace('.', '')

export type Notice = {
  service: string; isReminder: boolean
  unit: string | null; location: string | null; box: string | null; code: string | null; carrier: string | null
  feePerDay: string | null; feeDays: number | null
}

/** Lê o corpo (já em texto corrido) de um aviso da Parcel Pending / Quadient. Campo que não achar fica nulo — nunca chutado. */
export function parseParcelPending(subject: string, text: string): Notice {
  const t = String(text || '').replace(/\s+/g, ' ')
  const boxM = t.match(/stored in (?:a |the )?box\s+([A-Za-z]{1,3})\.?\s*Box number:\s*(\d{1,4})/i)
  const fee = t.match(/storage fees? of\s*(\$\s?[\d.,]+)\s*per day by picking up\s*(?:within|before)\s*(\d+)\s*days?/i)
  const carrier = t.match(/DELIVERED BY:\s*(.+?)\s*(?:Questions\?|Please see|Thank you|$)/i)?.[1] || null
  return {
    service: 'Parcel Pending',
    isReminder: /reminder/i.test(subject) || /\bREMINDER:/i.test(t),
    unit: t.match(/for unit\s+([A-Za-z0-9-]{1,10})/i)?.[1] || null,
    location: t.match(/LOCATION:\s*(.+?)\s*Your parcel is stored/i)?.[1]?.trim() || null,
    box: boxM ? `${boxM[1].toUpperCase()} ${boxM[2]}` : null,
    code: t.match(/pickup code on the locker screen\.?\s*(\d{4,12})/i)?.[1] || t.match(/(?:pickup|access) code[^0-9]{0,40}(\d{4,12})/i)?.[1] || null,
    // «Amazon Master» — «Master» é o fim do bloco no modelo do e-mail, não parte do nome.
    carrier: carrier ? carrier.replace(/\s+Master$/i, '').trim().slice(0, 40) : null,
    feePerDay: fee ? fee[1].replace(/\s/g, '') : null,
    feeDays: fee ? Number(fee[2]) : null,
  }
}

// ── O QUE É O PACOTE ────────────────────────────────────────────────────────
const CARRIER_KEYS: Array<[RegExp, RegExp]> = [
  [/amazon/i, /amazon/i], [/\bups\b/i, /\bups\b|united parcel/i], [/fedex/i, /fedex/i], [/usps|postal/i, /usps|postal service/i],
  [/dhl/i, /dhl/i], [/ontrac|lasership/i, /ontrac|lasership/i], [/temu|gofo|swiftx|speedx|uniuni/i, /temu|gofo|swiftx|speedx|uniuni/i],
]
const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/g
const TABELAS_ITEM = ['part_streams', 'invoice_expenses', 'inputs', 'inventory', 'staff_expenses', 'assets_expenses', 'fixed_cost_expenses'] as const

type Achado = { texto: string; via: string; loja: string | null }

// O APP É A FONTE (Márcio, 17/11/2026: «All the info should already be in the app when it's bought… you find in the app all the
// other infos, don't expect to get all the info in the email»). O e-mail dá a PISTA (nº do pedido, rastreio, hora, quem entregou);
// o que é, de que loja e quanto custou sai do app: as 7 tabelas de item, o registro de pedidos (supplier_orders) e a fila de
// compras do AutoBook (auto_book_mail) — nessa ordem, do lançamento pronto para o que ainda espera lançamento.
const usd = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? `US$ ${n.toFixed(2)}` : '' }
type NoApp = { item: string; supplier: string | null; tabela: string }
async function itemNoApp(db: SupabaseClient, coluna: 'order_number' | 'tracking_number', valor: string): Promise<NoApp | null> {
  for (const t of TABELAS_ITEM) {
    if (coluna === 'tracking_number' && t === 'fixed_cost_expenses') continue
    const { data, error } = await db.from(t).select('*').ilike(coluna, `%${valor}%`).limit(3)
    if (error || !data?.length) continue
    for (const r of data as Record<string, unknown>[]) {
      const item = String(r.item || r.description || r.name || r.title || '').trim()
      if (item) return { item: item.slice(0, 140), supplier: r.supplier ? String(r.supplier) : null, tabela: t }
    }
  }
  if (coluna !== 'order_number') return null
  {
    const { data } = await db.from('supplier_orders').select('supplier_name, description, total, car_label').ilike('order_number', `%${valor}%`).limit(1)
    const r = (data || [])[0] as Record<string, unknown> | undefined
    const desc = String(r?.description || '').trim()
    if (r && desc) return { item: [desc.slice(0, 140), r.car_label ? `para ${r.car_label}` : '', usd(r.total)].filter(Boolean).join(' · '), supplier: r.supplier_name ? String(r.supplier_name) : null, tabela: 'supplier_orders' }
  }
  {
    // A fila do AutoBook: a compra foi lida do e-mail e espera lançamento. Tem loja e valor; o item só quando o e-mail trouxe.
    const { data } = await db.from('auto_book_mail').select('vendor, amount, currency, extracted, subject').eq('order_number', valor).eq('kind', 'PURCHASE').limit(1)
    const r = (data || [])[0] as Record<string, any> | undefined
    if (r) {
      const item = String(r.extracted?.item || '').trim()
      const categoria = String(r.subject || '').match(/(?:Ordered|Delivered|Shipped)(?:\s+\d+\s+items?)?\s*:\s*(.+)$/i)?.[1]?.trim() || ''
      const valorTxt = String(r.currency || 'USD') === 'USD' ? usd(r.amount) : `${r.currency} ${r.amount}`
      return {
        item: item ? [item.slice(0, 140), valorTxt].filter(Boolean).join(' · ')
          : [categoria ? `${categoria} (categoria; a loja não informa o produto)` : 'produto não informado pela loja', valorTxt, 'compra na fila do AutoBook, ainda sem item lançado'].filter(Boolean).join(' · '),
        supplier: r.vendor ? String(r.vendor) : null, tabela: 'auto_book_mail',
      }
    }
  }
  return null
}

/** E-mails de «delivered» na janela do aviso, em todas as caixas. Falha de uma caixa não derruba as outras. */
async function entregasNaJanela(db: SupabaseClient, auths: MailAuth[], noticeMs: number): Promise<MailMsg[]> {
  const since = new Date(noticeMs - 4 * 3600_000).toISOString(), ate = noticeMs + 90 * 60_000
  const out: MailMsg[] = []
  for (const auth of auths) {
    try {
      const token = await freshAccessToken(db, auth)
      if (!token) continue
      const msgs = mailProvider(auth) === 'gmail'
        ? await fetchRecentGmail(token, since, { q: '(delivered OR entregue OR "was delivered" OR "foi entregue")', max: 25 })
        : await fetchRecentMessages(token, since)
      for (const m of msgs) {
        const ms = new Date(m.received).getTime()
        if (!Number.isFinite(ms) || ms > ate) continue
        if (!/deliver|entreg/i.test(m.subject)) continue
        // Só o AVISO DE LOCKER fica de fora (remetente E assunto): o «Delivered» da Amazon vem do mesmo domínio do Amazon Hub e é
        // justamente o e-mail que diz o que é o pacote (17/11/2026: o ensaio saiu «não identificado» por causa disto).
        if (LOCKER_SENDERS.some(s => s.from.test(m.fromAddr) && s.subject.test(m.subject))) continue
        out.push(m)
      }
    } catch (e) { console.error('[parcel-locker] entregas', auth.id, e) }
  }
  return out
}

/** O que é o pacote — do e-mail de entrega ao lançamento no app. Devolve as linhas da mensagem e de onde saíram. */
export async function oQueE(db: SupabaseClient, auths: MailAuth[], carrier: string | null, noticeIso: string): Promise<Achado> {
  const noticeMs = new Date(noticeIso).getTime()
  const chave = CARRIER_KEYS.find(([k]) => carrier && k.test(carrier))?.[1] || null
  const entregas = (await entregasNaJanela(db, auths, noticeMs))
    .filter(m => !chave || chave.test(m.fromAddr) || chave.test(m.from) || chave.test(m.subject) || chave.test(m.text.slice(0, 3000)))
  const linhas: string[] = [], vias: string[] = [], lojas: string[] = [], vistos = new Set<string>()

  for (const m of entregas) {
    const corpo = `${m.subject} ${m.text}`
    const pedidos = [...new Set(corpo.match(AMAZON_ORDER) || [])]
    const outroPedido = corpo.match(/order\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,24})/i)?.[1]
    if (!pedidos.length && outroPedido) pedidos.push(outroPedido)
    const rastreios = extractTrackings(corpo).slice(0, 3)
    const categoria = m.subject.match(/Delivered(?:\s+\d+\s+items?)?\s*:\s*(.+)$/i)?.[1]?.trim() || null
    const id = pedidos[0] || rastreios[0] || m.id || m.subject
    if (vistos.has(id)) continue
    vistos.add(id)

    let achado: NoApp | null = null
    for (const p of pedidos) { achado = await itemNoApp(db, 'order_number', p); if (achado) break }
    if (!achado) for (const r of rastreios) { achado = await itemNoApp(db, 'tracking_number', r); if (achado) break }
    const ref = pedidos[0] ? `pedido ${pedidos[0]}` : rastreios[0] ? `rastreio ${rastreios[0]}` : `e-mail «${m.subject.slice(0, 60)}»`
    if (achado) { linhas.push(`${achado.item} (${ref})`); vias.push(`${achado.tabela}`); if (achado.supplier) lojas.push(achado.supplier) }
    else if (categoria) { linhas.push(`${categoria} — é só a categoria que a loja informa; ${ref}, ainda sem lançamento no app`); vias.push('e-mail de entrega') }
    else { linhas.push(`${ref} — ainda sem lançamento no app`); vias.push('e-mail de entrega') }
  }

  // Sem e-mail de entrega: o STREAM pode ter a entrega marcada pelo rastreio.
  if (!linhas.length) {
    const { data } = await db.from('part_streams').select('item, supplier, order_number, carrier, delivered_at')
      .gte('delivered_at', new Date(noticeMs - 6 * 3600_000).toISOString()).lte('delivered_at', new Date(noticeMs + 2 * 3600_000).toISOString()).limit(5)
    for (const r of (data || []) as Record<string, unknown>[]) {
      if (chave && !chave.test(`${r.carrier || ''} ${r.supplier || ''}`)) continue
      linhas.push(`${String(r.item || '').slice(0, 140)}${r.order_number ? ` (pedido ${r.order_number})` : ''}`); vias.push('part_streams (entrega)'); if (r.supplier) lojas.push(String(r.supplier))
    }
  }

  const loja = new Set(lojas).size === 1 ? lojas[0] : null
  if (!linhas.length) return { texto: 'não identificado — nenhum pedido no app nem nas nossas caixas bate com esta entrega (pode ser compra pessoal ou do Heraldo)', via: 'sem casamento', loja: null }
  if (linhas.length === 1) return { texto: linhas[0], via: vias[0], loja }
  return { texto: `um destes, entregues na mesma hora:\n${linhas.map(l => `   • ${l}`).join('\n')}`, via: [...new Set(vias)].join(' + '), loja }
}

// ── A MENSAGEM ──────────────────────────────────────────────────────────────
export function montaMensagem(n: Notice, item: string, receivedIso: string, firstIso: string, textoCru?: string, loja?: string | null): string {
  const s = semMarcacao
  if (!n.code || !n.box) {
    // Serviço sem leitor próprio, ou modelo que mudou: vai o corpo do e-mail, limpo, para a instrução não se perder.
    return [`📦 *ENCOMENDA NO LOCKER* — ${s(n.service)}`, `O que é: ${s(item)}`, '', s(String(textoCru || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 900)), '', `Aviso recebido ${L(receivedIso)}`].join('\n')
  }
  // O prazo conta do PRIMEIRO aviso. Num lembrete que chegou sem o primeiro, a data não é conhecida — então não é escrita.
  const prazo = n.feeDays && !n.isReminder ? new Date(new Date(firstIso).getTime() + n.feeDays * 86400_000) : null
  return [
    `📦 *ENCOMENDA NO LOCKER*${n.location ? ` — ${s(n.location)}` : ''}`,
    // Fornecedor = a LOJA que o app tem para o pedido; quem entregou (o que o e-mail do locker diz) vai ao lado quando é outro.
    `Fornecedor: *${s(loja || n.carrier || 'não informado')}*${loja && n.carrier && loja.toLowerCase() !== n.carrier.toLowerCase() ? ` · entregue por ${s(n.carrier)}` : ''}`,
    `O que é: ${s(item)}`,
    '',
    `Locker: *${s(n.box)}*${n.unit ? ` · unidade ${s(n.unit)}` : ''}`,
    `Código de retirada: *${s(n.code)}*`,
    'Como retirar: digite o código (ou escaneie o código de barras do e-mail) na tela do locker; a porta abre sozinha.',
    prazo ? `Prazo: retirar até *${L(prazo)}* — depois, ${s(n.feePerDay || '')} por dia de armazenagem.`
      : n.feeDays ? `Prazo: ${n.feeDays} dias a contar do primeiro aviso — depois, ${s(n.feePerDay || '')} por dia de armazenagem.` : '',
    `Aviso do ${s(n.service)} recebido ${L(receivedIso)}${n.isReminder ? ' (lembrete)' : ''}.`,
  ].filter(l => l !== '').join('\n').replace(/\n\n\n+/g, '\n\n')
}

// ── LEITURA DAS CAIXAS ──────────────────────────────────────────────────────
type Carta = MailMsg & { id: string; slot: number; account: string; service: string }

async function avisosDaCaixa(db: SupabaseClient, auth: MailAuth, sinceIso: string): Promise<Carta[]> {
  const token = await freshAccessToken(db, auth)
  if (!token) return []
  let msgs: MailMsg[]
  if (mailProvider(auth) === 'gmail') msgs = await fetchRecentGmail(token, sinceIso, { q: `in:anywhere ${GMAIL_Q}`, max: 40 })
  else {
    // Graph: o filtro por remetente vai na consulta — a janela de 3 dias de uma caixa cheia não cabe em 50 mensagens.
    msgs = []
    for (const dominio of ['no-reply@parcelpending.com']) {
      const q = new URLSearchParams({ $top: '40', $select: 'id,parentFolderId,subject,from,receivedDateTime,body', $filter: `from/emailAddress/address eq '${dominio}' and receivedDateTime ge ${sinceIso}` })
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?${q}`, { headers: { Authorization: `Bearer ${token}` } })
      const j: any = await r.json().catch(() => null)
      if (!r.ok || !Array.isArray(j?.value)) { console.error('[parcel-locker] graph list', auth.id, r.status, j?.error?.message); continue }
      for (const m of j.value) msgs.push({
        id: String(m.id || ''), folderId: String(m.parentFolderId || ''), subject: String(m.subject || ''),
        from: String(m.from?.emailAddress?.name || ''), fromAddr: String(m.from?.emailAddress?.address || '').toLowerCase(), received: String(m.receivedDateTime || ''),
        text: String(m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' '),
      })
    }
  }
  const out: Carta[] = []
  for (const m of msgs) {
    const sender = LOCKER_SENDERS.find(s => s.from.test(m.fromAddr) && s.subject.test(m.subject))
    if (!sender || !m.id) continue
    out.push({ ...m, id: m.id, slot: auth.id, account: String(auth.account || ''), service: sender.service })
  }
  return out
}

async function arquiva(origin: string, slot: number, id: string, pasta: string, nota: string): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/ca/api/stream/mail-file`, {
      method: 'POST', headers: selfCallHeaders(),
      body: JSON.stringify({ key: process.env.WHATSAPP_READ_KEY, slot, id, folder: pasta, read: true, note: nota, ref_table: 'parcel_locker_notices' }),
      signal: AbortSignal.timeout(25000),
    })
    const j: any = await r.json().catch(() => null)
    return !!j?.ok
  } catch (e) { console.error('[parcel-locker] arquiva', e); return false }
}

export type RunResult = { on: boolean; read: number; sent: string[]; preview: string[]; duplicate: number; stale: number; failed: string[]; already: number; dry?: Array<{ account: string; received: string; subject: string; body: string; via: string }> }

// `dryHours` = ENSAIO: monta a mensagem de todo aviso das últimas N horas e devolve o texto. Não grava, não manda, não arquiva —
// é como se confere o que o robô escreveria, inclusive de aviso velho.
export async function runParcelLocker(db: SupabaseClient, origin: string, opts: { dryHours?: number } = {}): Promise<RunResult> {
  const dry = Number(opts.dryHours) > 0 ? Math.min(240, Number(opts.dryHours)) : 0
  const on = dry ? false : await settingOn(PARCEL_SWITCH)
  const res: RunResult = { on, read: 0, sent: [], preview: [], duplicate: 0, stale: 0, failed: [], already: 0 }
  const auths = await listMailAuths(db)
  const since = new Date(Date.now() - Math.max(LOOKBACK_DAYS * 24, dry) * 3600_000).toISOString()

  const cartas: Carta[] = []
  for (const auth of auths) {
    try { cartas.push(...(await avisosDaCaixa(db, auth, since))) } catch (e) { console.error('[parcel-locker] caixa', auth.id, e) }
  }
  cartas.sort((a, b) => a.received.localeCompare(b.received)) // do mais velho pro mais novo: o 1º aviso de um pacote é quem manda
  res.read = cartas.length
  if (!cartas.length) return res

  const { data: jaLidas } = await db.from('parcel_locker_notices').select('account, message_id, status, parcel_key, received_at, filed')
    .gte('created_at', new Date(Date.now() - (DEDUPE_DAYS + LOOKBACK_DAYS) * 86400_000).toISOString())
  const lidas = new Map<string, { status: string; filed: boolean }>(), porPacote = new Map<string, string>()
  for (const r of (jaLidas || []) as any[]) {
    lidas.set(`${r.account}|${r.message_id}`, { status: r.status, filed: r.filed })
    if (r.parcel_key && ['SENT', 'PREVIEW', 'STALE'].includes(r.status)) {
      const antes = porPacote.get(r.parcel_key)
      if (!antes || String(r.received_at) < antes) porPacote.set(r.parcel_key, String(r.received_at))
    }
  }

  if (dry) {
    res.dry = []
    for (const c of cartas) {
      if ((Date.now() - new Date(c.received).getTime()) / 3600_000 > dry) continue
      const n = c.service === 'Parcel Pending' ? parseParcelPending(c.subject, c.text)
        : { service: c.service, isReminder: /reminder/i.test(c.subject), unit: null, location: null, box: null, code: null, carrier: null, feePerDay: null, feeDays: null } as Notice
      const achado = await oQueE(db, auths, n.carrier, c.received).catch(e => ({ texto: `não identificado (a busca falhou: ${String(e).slice(0, 80)})`, via: 'erro', loja: null }))
      res.dry.push({ account: c.account, received: c.received, subject: c.subject, body: montaMensagem(n, achado.texto, c.received, c.received, c.text, achado.loja), via: achado.via })
    }
    return res
  }

  for (const c of cartas) {
    const visto = lidas.get(`${c.account}|${c.id}`)
    // PREVIEW é refeito a cada passada enquanto a chave está desligada? Não: uma linha por e-mail. Quando a chave liga, o
    // PREVIEW que ainda estiver FRESCO é enviado; o resto fica como está.
    // Volta a olhar, com a chave ligada: o PREVIEW ainda fresco (vira envio), o envio que FALHOU e a cópia que ficou sem arquivar.
    const reabre = on && !!visto && (visto.status === 'PREVIEW' || visto.status === 'FAILED' || (visto.status === 'DUPLICATE' && !visto.filed))
    if (visto && !reabre) { res.already++; continue }

    const n = c.service === 'Parcel Pending' ? parseParcelPending(c.subject, c.text)
      : { service: c.service, isReminder: /reminder/i.test(c.subject), unit: null, location: null, box: null, code: null, carrier: null, feePerDay: null, feeDays: null } as Notice
    const parcelKey = n.box && n.code ? `${n.box}|${n.code}` : null
    const idadeH = (Date.now() - new Date(c.received).getTime()) / 3600_000
    const primeiro = parcelKey ? porPacote.get(parcelKey) : undefined
    const repetido = !!primeiro && primeiro < c.received && !(visto?.status === 'PREVIEW')
    const pasta = /luma/i.test(`${n.location || ''} ${c.text}`) ? 'Apartment - Luma 01-306' : 'Lockers'

    const linha: Record<string, unknown> = {
      slot: c.slot, account: c.account, message_id: c.id, received_at: c.received, subject: c.subject.slice(0, 200), service: n.service,
      is_reminder: n.isReminder, unit: n.unit, location: n.location, box: n.box, code: n.code, carrier: n.carrier,
      fee_text: n.feePerDay ? `${n.feePerDay} per day after ${n.feeDays} days` : null, parcel_key: parcelKey, updated_at: new Date().toISOString(),
    }
    const grava = async (extra: Record<string, unknown>) => {
      const { error } = await db.from('parcel_locker_notices').upsert({ ...linha, ...extra }, { onConflict: 'account,message_id' })
      if (error) console.error('[parcel-locker] grava', error.message)
    }

    if (repetido) {
      // O mesmo pacote já avisado (outra caixa, ou o REMINDER): só arquiva — e só com a chave ligada.
      const filed = on ? await arquiva(origin, c.slot, c.id, pasta, `locker ${n.box}: pacote já avisado à Chris em ${L(primeiro!)} — ${n.isReminder ? 'lembrete' : 'cópia em outra caixa'}`) : false
      await grava({ status: 'DUPLICATE', filed }); res.duplicate++
      continue
    }
    if (idadeH > FRESH_HOURS) {
      // Aviso velho: não manda (ela costuma já ter retirado). Fica registrado e conta como 1º aviso do pacote.
      await grava({ status: 'STALE', deadline_at: n.feeDays ? new Date(new Date(c.received).getTime() + n.feeDays * 86400_000).toISOString() : null })
      if (parcelKey && !porPacote.has(parcelKey)) porPacote.set(parcelKey, c.received)
      res.stale++
      continue
    }

    const achado = await oQueE(db, auths, n.carrier, c.received).catch(e => { console.error('[parcel-locker] oQueE', e); return { texto: 'não identificado (a busca do pedido falhou)', via: 'erro', loja: null } })
    const corpo = `${montaMensagem(n, achado.texto, c.received, c.received, c.text, achado.loja)}\n\n${SIGNATURE}`
    const base = { item_text: achado.texto, match_via: achado.via, wa_to: CHRIS_US, wa_body: corpo, deadline_at: n.feeDays ? new Date(new Date(c.received).getTime() + n.feeDays * 86400_000).toISOString() : null }
    if (parcelKey) porPacote.set(parcelKey, c.received)

    if (!on) { await grava({ ...base, status: 'PREVIEW' }); res.preview.push(`${n.box || c.service} ← ${c.account}`); continue }

    const envio = await enviaUltra(CHRIS_US, corpo)
    if (!envio.ok) {
      // Não arquiva: e-mail cujo aviso não saiu TEM de aparecer na rodada de e-mail.
      await grava({ ...base, status: 'FAILED', wa_result: (envio.error || envio.raw || '').slice(0, 300) }); res.failed.push(`${n.box || c.service}: ${envio.error || 'ultramsg recusou'}`)
      continue
    }
    const filed = await arquiva(origin, c.slot, c.id, pasta, `locker ${n.box || ''} código ${n.code || ''} — aviso mandado à Chris (WhatsApp US) pelo robô em ${L(Date.now())}. Item: ${achado.texto.slice(0, 160)}`)
    await grava({ ...base, status: 'SENT', wa_result: String(envio.data?.id || 'sent').slice(0, 80), filed })
    res.sent.push(`${n.box || c.service} → Chris${filed ? '' : ' (e-mail NÃO arquivado)'}`)
  }
  return res
}
