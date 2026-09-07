// SERVER-ONLY — AUTO-BOOK / E-MAIL: A RODADA DE 1 EM 1 HORA.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 06/set/2026) ───────────────────────
//   "ensine o robô a fazer o round de 1 em 1 hora, pra que ele deixe pra vc aqui
//    só o que ele tiver dúvida."
//   "Precisamos automatizar ao máximo o AutoBook."
//
// A rodada de e-mail já existia, mas dividida em dois pedaços que não se falavam:
//   • lib/mailToItem.server.ts escreve FATOS na linha QUE JÁ EXISTE — rastreio,
//     entrega, estorno. Funciona e continua sendo dele esse trabalho.
//   • a COMPRA NOVA — o e-mail que traz dinheiro antes de existir linha nenhuma —
//     virava uma string dentro de `semLinha`, dentro da resposta HTTP do cron de
//     5 minutos. Ninguém lê resposta de cron. Medido: desde 31/ago nenhum item
//     de `semLinha` chegou a lugar nenhum; a captura continuou 100% na mão.
//
// Este módulo é o pedaço que faltava, e ele tem UMA regra de conduta:
// **o robô só faz sozinho o que não precisa de decisão; o resto vira PERGUNTA
// com lugar, e pergunta respondida vira REGRA.** Não existe terceira saída —
// e-mail com dinheiro que ele não sabe lançar NUNCA some em silêncio.
//
// ── O QUE ELE FAZ ──────────────────────────────────────────────────────────
//   1. VARRE as 6 caixas na janela da rodada (padrão 3h de sobreposição pra
//      nenhum e-mail cair entre duas passadas).
//   2. PENEIRA: só sobrevive e-mail com DINHEIRO — confirmação de compra,
//      estorno, cobrança. Marketing e conversa morrem aqui, calados.
//   3. DESCARTA o que já tem dono: pedido que já existe em qualquer das 6
//      tabelas de item é assunto do mailToItem, não meu.
//   4. APLICA REGRA (`auto_book_mail_rules`): IGNORE mata; BOOK lança a linha
//      sozinho, com order_number, no destino que o humano já escolheu uma vez.
//   5. PERGUNTA o resto: uma linha em `auto_book_mail` com tudo que o parser
//      conseguiu ler (fornecedor, pedido, valor, moeda) + os destinos mais
//      prováveis, medidos no banco — nunca chutados.
//
// ── O QUE ELE NUNCA FAZ ────────────────────────────────────────────────────
//   • NUNCA escolhe carro sozinho sem regra escrita por gente. "Em que carro
//     entra é decisão de gente, e chutar isso é pior que não fazer."
//   • NUNCA lança valor que ele leu com pouca confiança — total sem rótulo
//     forte ("Order total", "Total paid") vira pergunta, não linha.
//   • NUNCA lança 0,00 (o PO de $0.00 do Temu não gera linha nenhuma).
//   • NUNCA repete pergunta: `message_key` é único e a resposta vira regra.
//   • NUNCA escreve status — status é derivado (lib/deliverStatus.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listMailAuths, mailProvider, freshAccessToken, fetchRecentMessages, fetchRecentGmail,
  isPurchaseConfirmation, type MailMsg, type MailAuth,
} from './streamMail.server'
import { ITEM_TABLES } from './itemTracking.server'
import { PEDIDO_NOVO, ESTORNOU } from './mailToItem.server'

export type AbKind = 'PURCHASE' | 'REFUND' | 'CHARGE'
export type AbRule = { id: string; label: string | null; match_from: string | null; match_subject: string | null; match_vendor: string | null; action: 'BOOK' | 'IGNORE' | 'ASK'; target: Record<string, unknown> | null; hits: number }
export type AbCand = { table: string; ref: string; label: string; n: number; last: string }
export type AutoBookMailResult = {
  janela: string
  caixas: string[]
  lidos: number
  comDinheiro: number
  jaTemLinha: string[]
  ignorados: string[]
  lancados: string[]
  semRecibo: string[]
  perguntas: string[]
  erros: string[]
}

// ── DINHEIRO: ler valor só quando o e-mail DIZ que é o total ────────────────
// Rótulo forte = o vendedor nomeou o total do pedido. Rótulo fraco = a palavra
// "total" solta, que aparece em subtotal, total de itens e rodapé de marketing.
// Só rótulo forte autoriza LANÇAMENTO automático; fraco vira pergunta.
const FORTE = /(order total|grand total|total paid|amount paid|amount charged|you paid|total charged|payment total|order amount|total do pedido|valor total|valor pago|total pago)/i
const ROTULO = /(order total|grand total|total paid|amount paid|amount charged|you paid|total charged|payment total|order amount|total do pedido|valor total|valor pago|total pago|subtotal|total)\s*[:\-—]?\s*(R\$|US\$|\$|USD|BRL)?\s*([0-9][0-9.,]{0,13})/gi
const COBRANCA = /\b(payment (of|received|sent)|we charged|charged to your|your card (was )?charged|invoice paid|fatura paga|pagamento (recebido|efetuado|aprovado)|compra aprovada)\b/i

// "1,234.56" e "1.234,56" chegam do mesmo parser: o ÚLTIMO separador manda.
export function parseNumber(raw: string): number | null {
  const s = String(raw).replace(/\s/g, '')
  if (!/^[0-9][0-9.,]*$/.test(s)) return null
  const lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',')
  let n: number
  if (lastDot < 0 && lastCom < 0) n = Number(s)
  else {
    const cut = Math.max(lastDot, lastCom)
    const dec = s.slice(cut + 1)
    // separador final com 1-2 casas = decimal; 3 casas = milhar ("1.234")
    if (dec.length === 3) n = Number(s.replace(/[.,]/g, ''))
    else n = Number(s.slice(0, cut).replace(/[.,]/g, '') + '.' + dec)
  }
  return Number.isFinite(n) ? n : null
}

export function parseMoney(texto: string): { amount: number; currency: string; strong: boolean; label: string } | null {
  let best: { amount: number; currency: string; strong: boolean; label: string } | null = null
  for (const m of texto.matchAll(ROTULO)) {
    const label = m[1], sym = m[2] || '', n = parseNumber(m[3] || '')
    if (n == null) continue
    const strong = FORTE.test(label)
    // ZERO só vale de rótulo FORTE, e vale de propósito: o PO de $0.00 do Temu
    // é um total de verdade e a resposta certa a ele é "não gera linha". Zero
    // de rótulo fraco é lixo de rodapé ("Total: 0 items") e não conta.
    if (!(n > 0) && !strong) continue
    const currency = /R\$|BRL/i.test(sym) ? 'BRL' : 'USD'
    // rótulo forte ganha de fraco; entre iguais, o MAIOR valor (o total é o teto)
    if (!best || (strong && !best.strong) || (strong === best.strong && n > best.amount)) best = { amount: n, currency, strong, label }
  }
  return best
}

// ── FORNECEDOR: vem do domínio de quem mandou, não de adivinhação no texto ──
const DOM_VENDOR: Record<string, string> = {
  'temu.com': 'Temu', 'amazon.com': 'Amazon', 'ebay.com': 'eBay', 'ebay.co.uk': 'eBay',
  'paypal.com': 'PayPal', 'hptuners.com': 'HP Tuners', 'hhpperformance.com': 'HHP',
  'homedepot.com': 'Home Depot', 'lowes.com': 'Lowes', 'samsclub.com': 'Sams Club',
  'summitracing.com': 'Summit Racing', 'rockauto.com': 'RockAuto', 'holley.com': 'Holley',
  'titanmotorsports.com': 'Titan Motorsports', 'kooksheaders.com': 'Kooks', 'halltech.com': 'HallTech',
  'mercadolivre.com.br': 'Mercado Livre', 'mercadolibre.com': 'Mercado Livre', 'wurth.com.br': 'Wurth',
  'uber.com': 'Uber', 'apple.com': 'Apple', 'walmart.com': 'Walmart', 'harborfreight.com': 'Harbor Freight',
  'oreillyauto.com': 'OReilly', 'napaonline.com': 'NAPA', 'tirerack.com': 'Tire Rack',
}
export function vendorOf(msg: MailMsg): string {
  const dom = (msg.fromAddr.split('@')[1] || '').toLowerCase()
  for (const [k, v] of Object.entries(DOM_VENDOR)) if (dom === k || dom.endsWith('.' + k)) return v
  const base = dom.replace(/^(mail|email|no-?reply|orders?|transaction|info|news|e|m|t)\./, '').split('.')[0]
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : (msg.from || msg.fromAddr).slice(0, 40)
}

export function orderNumbersIn(texto: string): string[] {
  const out = new Set<string>()
  for (const re of PEDIDO_NOVO) for (const m of texto.matchAll(re)) out.add(m[1])
  return [...out]
}

// ── A PENEIRA ──────────────────────────────────────────────────────────────
// Só passa e-mail que carrega dinheiro que vira ou muda linha no app. É a lei
// de escopo desta rodada, escrita em código: o resto não existe.
export function classify(msg: MailMsg): { kind: AbKind; money: ReturnType<typeof parseMoney>; orders: string[] } | null {
  const texto = `${msg.subject}\n${msg.text}`
  const orders = orderNumbersIn(texto)
  const money = parseMoney(texto)
  const refund = ESTORNOU.test(texto)
  const compra = isPurchaseConfirmation(msg)
  const cobranca = COBRANCA.test(texto)
  if (!refund && !compra && !cobranca) return null
  if (!orders.length && !money) return null
  return { kind: refund ? 'REFUND' : compra ? 'PURCHASE' : 'CHARGE', money, orders }
}

// ── O DICIONÁRIO DE PEDIDOS JÁ CONHECIDOS ──────────────────────────────────
// Diferente do dicionário do mailToItem: aqui entra TUDO, inclusive linha
// entregue e de balcão. A pergunta é só "este pedido já tem dono no app?".
async function pedidosConhecidos(db: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>()
  for (const t of ITEM_TABLES) {
    const { data } = await db.from(t).select('order_number').not('order_number', 'is', null)
    for (const r of (data || []) as { order_number: string }[]) {
      const s = String(r.order_number || '').trim()
      if (s.length >= 5) set.add(s)
    }
  }
  return set
}

// ── OS DESTINOS PROVÁVEIS, MEDIDOS ─────────────────────────────────────────
// A sugestão não é palpite: é onde as compras ANTERIORES deste mesmo fornecedor
// foram parar, com quantas vezes e quando foi a última. O humano decide olhando
// o histórico, não a intuição do robô.
export async function candidatosPara(db: SupabaseClient, vendor: string): Promise<AbCand[]> {
  const like = `%${vendor.slice(0, 14)}%`
  const out = new Map<string, AbCand>()
  const add = (table: string, ref: string, label: string, date: string) => {
    const k = `${table}:${ref}`
    const c = out.get(k) || { table, ref, label, n: 0, last: date }
    c.n++; if (date > c.last) c.last = date
    out.set(k, c)
  }
  const { data: ie } = await db.from('invoice_expenses')
    .select('invoice_id, expense_date, item')
    .ilike('supplier', like).order('expense_date', { ascending: false }).limit(60)
  for (const r of (ie || []) as Record<string, unknown>[]) {
    if (!r.invoice_id) continue
    add('invoice_expenses', String(r.invoice_id), `invoice ${String(r.invoice_id).slice(0, 8)}`, String(r.expense_date || '').slice(0, 10))
  }
  const { data: ex } = await db.from('expenses')
    .select('season_id, expense_date, origin').ilike('supplier', like)
    .order('expense_date', { ascending: false }).limit(40)
  for (const r of (ex || []) as Record<string, unknown>[]) {
    if (!r.season_id) continue
    add('expenses', String(r.season_id), `expenses ${String(r.origin || '')} (season ${String(r.season_id).slice(0, 8)})`, String(r.expense_date || '').slice(0, 10))
  }
  return [...out.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).slice(0, 5)
}

// ── REGRA ──────────────────────────────────────────────────────────────────
export function ruleFor(msg: MailMsg, vendor: string, rules: AbRule[]): AbRule | null {
  const from = msg.fromAddr.toLowerCase(), subj = msg.subject.toLowerCase(), ven = vendor.toLowerCase()
  for (const r of rules) {
    const cond = [
      r.match_from ? from.includes(r.match_from.toLowerCase()) : null,
      r.match_subject ? subj.includes(r.match_subject.toLowerCase()) : null,
      r.match_vendor ? ven === r.match_vendor.toLowerCase() : null,
    ].filter(x => x !== null)
    if (cond.length && cond.every(Boolean)) return r
  }
  return null
}

// Lança a linha no destino que o humano já escolheu. Uma tabela por vez, com os
// nomes de coluna de CADA uma — o valor mora em `price` na invoice_expenses,
// `amount` na expenses e `unit_price` na inputs, e trocar isso grava zero.
export async function lancar(
  db: SupabaseClient,
  target: Record<string, unknown>,
  dados: { vendor: string; order: string | null; amount: number; date: string; desc: string },
): Promise<{ table: string; id: string } | { erro: string }> {
  const t = String(target.table || '')
  const base: Record<string, unknown> = { supplier: dados.vendor, order_number: dados.order, source: 'GZ28US' }
  for (const [k, v] of Object.entries(target)) if (k !== 'table') base[k] = v
  if (t === 'invoice_expenses') Object.assign(base, { item: dados.desc, price: dados.amount, quantity: 1, expense_date: dados.date })
  else if (t === 'expenses') Object.assign(base, { description: dados.desc, amount: dados.amount, expense_date: dados.date, type: base.type || 'SINGLE' })
  else if (t === 'inputs') Object.assign(base, { description: dados.desc, unit_price: dados.amount, quantity: 1, purchase_date: dados.date })
  else return { erro: `tabela "${t}" nao e destino de compra` }
  const { data, error } = await db.from(t).insert(base).select('id').single()
  if (error) return { erro: error.message }
  return { table: t, id: String((data as { id: string }).id) }
}

const keyOf = (slot: number, m: MailMsg) => `${slot}|${m.received}|${m.fromAddr}|${m.subject.slice(0, 90)}`

async function lerCaixa(db: SupabaseClient, auth: MailAuth, desde: string): Promise<{ nome: string; slot: number; msgs: MailMsg[] }> {
  const nome = auth.account || 'slot' + auth.id
  const token = await freshAccessToken(db, auth)
  if (!token) return { nome: nome + ':sem-token', slot: auth.id || 0, msgs: [] }
  const msgs = mailProvider(auth) === 'gmail' ? await fetchRecentGmail(token, desde) : await fetchRecentMessages(token, desde)
  return { nome: `${nome}:${msgs.length}`, slot: auth.id || 0, msgs }
}

export async function runAutoBookMail(db: SupabaseClient, horas = 3): Promise<AutoBookMailResult> {
  const out: AutoBookMailResult = { janela: '', caixas: [], lidos: 0, comDinheiro: 0, jaTemLinha: [], ignorados: [], lancados: [], semRecibo: [], perguntas: [], erros: [] }
  const desde = new Date(Date.now() - horas * 3600e3).toISOString()
  out.janela = `desde ${desde}`

  const { data: rulesRaw } = await db.from('auto_book_mail_rules').select('*').eq('active', true)
  const rules = (rulesRaw || []) as AbRule[]
  const conhecidos = await pedidosConhecidos(db)
  const { data: jaNaFila } = await db.from('auto_book_mail').select('message_key').gte('created_at', new Date(Date.now() - 30 * 86400e3).toISOString())
  const naFila = new Set(((jaNaFila || []) as { message_key: string }[]).map(r => r.message_key))

  for (const auth of await listMailAuths(db)) {
    let caixa: { nome: string; slot: number; msgs: MailMsg[] }
    try { caixa = await lerCaixa(db, auth, desde) } catch { out.caixas.push((auth.account || 'slot' + auth.id) + ':erro'); continue }
    out.caixas.push(caixa.nome)
    out.lidos += caixa.msgs.length

    for (const msg of caixa.msgs) {
      const c = classify(msg)
      if (!c) continue
      out.comDinheiro++
      const chave = keyOf(caixa.slot, msg)
      if (naFila.has(chave)) continue

      // 3. já tem dono? o mailToItem cuida dos fatos dessa linha.
      const dono = c.orders.find(o => conhecidos.has(o))
      if (dono) { out.jaTemLinha.push(`${dono} — ${msg.subject.slice(0, 50)}`); continue }

      const vendor = vendorOf(msg)
      const order = c.orders[0] || null
      const amount = c.money?.amount ?? null
      const data = String(msg.received || new Date().toISOString()).slice(0, 10)
      const desc = `${vendor}${order ? ' — pedido ' + order : ''} — ${msg.subject.slice(0, 90)}`

      // 0,00 não gera linha (PO de $0.00 do Temu).
      if (amount != null && amount === 0) { out.ignorados.push(`${vendor} ${order || ''} — total 0,00`); continue }

      const regra = ruleFor(msg, vendor, rules)
      if (regra?.action === 'IGNORE') {
        out.ignorados.push(`${vendor} — ${msg.subject.slice(0, 50)} (regra "${regra.label || regra.id.slice(0, 8)}")`)
        await db.from('auto_book_mail_rules').update({ hits: (regra.hits || 0) + 1, last_hit_at: new Date().toISOString() }).eq('id', regra.id)
        continue
      }

      // 4. REGRA DE LANÇAMENTO — só com valor de rótulo FORTE e pedido na mão.
      if (regra?.action === 'BOOK' && regra.target && c.money?.strong && amount && order) {
        const r = await lancar(db, regra.target as Record<string, unknown>, { vendor, order, amount, date: data, desc })
        if ('erro' in r) { out.erros.push(`${vendor} ${order}: ${r.erro}`) }
        else {
          await db.from('auto_book_mail_rules').update({ hits: (regra.hits || 0) + 1, last_hit_at: new Date().toISOString() }).eq('id', regra.id)
          await db.from('auto_book_mail').insert({
            message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
            from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: order,
            currency: c.money.currency, amount, extracted: { label: c.money.label, orders: c.orders, regra: regra.label },
            status: 'BOOKED', booked_table: r.table, booked_id: r.id, answered_at: new Date().toISOString(),
            question: 'LANCADA POR REGRA — falta a printable invoice (PDF do vendedor) no receipt_url e na pasta Purchases',
          })
          naFila.add(chave)
          out.lancados.push(`${vendor} ${order} ${c.money.currency} ${amount} → ${r.table}:${r.id.slice(0, 8)}`)
          out.semRecibo.push(`${r.table}:${r.id.slice(0, 8)} — ${vendor} ${order}`)
          continue
        }
      }

      // 5. A PERGUNTA. Uma só, com tudo que já foi lido e os destinos medidos.
      const cands = await candidatosPara(db, vendor)
      const falta = [
        !order ? 'sem numero de pedido' : null,
        amount == null ? 'sem valor legivel' : !c.money?.strong ? `valor ${amount} lido de rotulo fraco ("${c.money?.label}")` : null,
      ].filter(Boolean)
      const question = c.kind === 'REFUND'
        ? `Estorno de ${vendor}${order ? ' (pedido ' + order + ')' : ''}${amount ? ' — ' + c.money?.currency + ' ' + amount : ''}: qual linha ele abate?`
        : `Compra de ${vendor}${order ? ' — pedido ' + order : ''}${amount ? ' — ' + c.money?.currency + ' ' + amount : ''}: entra em qual invoice/carro?${falta.length ? ' (' + falta.join('; ') + ')' : ''}`
      const { error } = await db.from('auto_book_mail').insert({
        message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
        from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: order,
        currency: c.money?.currency || 'USD', amount, question, cands,
        extracted: { label: c.money?.label || null, strong: !!c.money?.strong, orders: c.orders, trecho: msg.text.slice(0, 900) },
      })
      if (error) { out.erros.push(`fila ${vendor}: ${error.message}`); continue }
      naFila.add(chave)
      out.perguntas.push(question)
    }
  }
  return out
}
