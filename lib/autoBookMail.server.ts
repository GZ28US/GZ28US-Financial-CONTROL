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
  folderMap, moveMessage, maySweep, GMAIL_Q_COMPRA, type MailMsg, type MailAuth,
} from './streamMail.server'
import { ITEM_TABLES } from './itemTracking.server'
import { PEDIDO_NOVO, ESTORNOU } from './mailToItem.server'
import { matchSupplier, supplierDirectoryFrom } from './supplierMatch'
import { cacaNaPasta, respostaUnica, type PastaHit } from './dropboxHunt.server'

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
  duvidasApp: string[]
  arquivados: string[]
  semPasta: string[]
  achadosNoApp: string[]
  papelSemLinha: string[]
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

// "Total" sozinho é fraco em qualquer lugar do e-mail — MENOS dentro do bloco de
// fechamento da compra. Home Depot, Lowe's e Walmart escrevem "Order Summary …
// Subtotal … Taxes … Total $186.47": ali o "Total" é o total do pedido, com todas
// as letras. Medido em 07/set: sem esta subida a compra de $186,47 da Home Depot
// nascia como dúvida de "rótulo fraco" mesmo tendo valor exato no e-mail.
const BLOCO_FECHAMENTO = /(order|payment|purchase)\s+summary|resumo (do pedido|da compra)/i

export function parseMoney(texto: string): { amount: number; currency: string; strong: boolean; label: string } | null {
  let best: { amount: number; currency: string; strong: boolean; label: string } | null = null
  for (const m of texto.matchAll(ROTULO)) {
    const label = m[1], sym = m[2] || '', n = parseNumber(m[3] || '')
    if (n == null) continue
    const antes = texto.slice(Math.max(0, (m.index ?? 0) - 220), m.index ?? 0)
    const strong = FORTE.test(label) || (/^total$/i.test(label.trim()) && BLOCO_FECHAMENTO.test(antes))
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
// APÓSTROFO NÃO É ENFEITE (07/set/2026). Eu escrevi "Lowes", "Sams Club" e
// "OReilly" sem apóstrofo para fugir do escape do shell na hora de criar este
// arquivo — e isso virou cegueira em produção: as linhas do app escrevem
// "Lowe's 1652, 1300 W Osceola Pkwy", "Sam's Club 8290" e "O'Reilly Auto Parts",
// então o `ilike` do robô achava ZERO e toda compra desses três chegava como
// "não existe no app". Medido: 3 de 19 vendors cegos por isto.
// (Os outros zeros do dicionário — RockAuto, NAPA, Holley, Kooks — são zeros
//  CERTOS: não há uma linha sequer com esses fornecedores nos dois bancos.)
// O nome aqui tem de ser, letra por letra, o que a linha do app escreve.
const DOM_VENDOR: Record<string, string> = {
  'temu.com': 'Temu', 'amazon.com': 'Amazon', 'ebay.com': 'eBay', 'ebay.co.uk': 'eBay',
  'paypal.com': 'PayPal', 'hptuners.com': 'HP Tuners', 'hhpperformance.com': 'HHP',
  'homedepot.com': 'Home Depot', 'lowes.com': "Lowe's", 'samsclub.com': "Sam's Club",
  'summitracing.com': 'Summit Racing', 'rockauto.com': 'RockAuto', 'holley.com': 'Holley',
  'titanmotorsports.com': 'Titan Motorsports', 'kooksheaders.com': 'Kooks', 'halltech.com': 'HallTech',
  'mercadolivre.com.br': 'Mercado Livre', 'mercadolibre.com': 'Mercado Livre', 'wurth.com.br': 'Wurth',
  'uber.com': 'Uber', 'apple.com': 'Apple', 'walmart.com': 'Walmart', 'harborfreight.com': 'Harbor Freight',
  'oreillyauto.com': "O'Reilly Auto Parts", 'napaonline.com': 'NAPA', 'tirerack.com': 'Tire Rack',
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

// ── UM E-MAIL, VÁRIOS PEDIDOS ──────────────────────────────────────────────
// O Temu é o fornecedor de maior volume da casa e ele parte a compra: "Your
// purchase has been divided into 2 orders. Order 1 of 2 — Order ID: PO-…-…86085
// … Order total $0.00 … Order 2 of 2 — Order ID: PO-…-…34042 … Order total
// $3.94". Pegar "o maior total do e-mail" ali é simplesmente o valor errado
// colado no pedido errado. Cada pedido tem o SEU total, e ele mora no texto
// logo depois do número — é isso que esta função lê.
// Fora de janela (>600 chars) não conta: total distante é de outro bloco.
export function totaisPorPedido(texto: string): Record<string, { amount: number; currency: string }> {
  const out: Record<string, { amount: number; currency: string }> = {}
  for (const pedido of orderNumbersIn(texto)) {
    const at = texto.indexOf(pedido)
    if (at < 0) continue
    const janela = texto.slice(at + pedido.length, at + pedido.length + 600)
    const m = parseMoney(janela)
    if (m?.strong) out[pedido] = { amount: m.amount, currency: m.currency }
  }
  return out
}

// ── A PENEIRA ──────────────────────────────────────────────────────────────
// Só passa e-mail que carrega dinheiro que vira ou muda linha no app. É a lei
// de escopo desta rodada, escrita em código: o resto não existe.
//
// NÃO se usa `isPurchaseConfirmation` aqui, e a diferença custou a primeira
// rodada inteira (07/set/2026: 173 e-mails lidos, ZERO com dinheiro). Aquela
// função responde outra pergunta — "posso confiar num rastreio dentro deste
// e-mail?" — e por isso ela NEGA todo e-mail que fale de embarque. Só que
// "Order confirmed. We're processing your order now!" da Home Depot diz, no
// corpo, "we'll let you know when your items ship and tracking numbers are
// available": vocabulário de embarque num e-mail que É a confirmação da compra,
// com o total de $186,47 dentro. E "Your Temu orders confirmation" não casa com
// `order (confirm…)` por causa do "s" no meio. Duas negativas, mesma origem:
// julgar COMPRA pelo formato do assunto.
//
// A régua aqui é outra, e é sobre CONTEÚDO: um e-mail com um total de rótulo
// FORTE e um número de pedido é uma compra, diga o assunto o que disser. O
// assunto só entra como reforço, para o caso em que o valor não deu para ler.
// "order has been received" não casa com `order (receiv…)`: tem quatro palavras
// no meio. Por isso a janela de até 40 caracteres entre o pedido e o verbo — foi
// assim que "Your HP Tuners order has been received!" passou batido em 07/set.
const COMPRA_ASSUNTO = /\border\b.{0,40}?\b(confirmed|received|placed|acknowledged)\b|\border\s*(confirm|receiv|placed|acknowledg)|orders?\s+confirmation|confirmation of your order|confirmed:|thank(s| you) for (your|shopping)|your (order|purchase|receipt|invoice)\b|purchase (is )?confirmed|receipt for your (payment|purchase)|payment receipt|pedido (confirmado|recebido|realizado)|confirma[çc][ãa]o (do|de) pedido|recibo d[eo] pagamento|nota fiscal/i

// ── O RECIBO DO PAYPAL ─────────────────────────────────────────────────────
// O PayPal é o trilho de pagamento da casa e o recibo dele não tem rótulo
// nenhum no corpo: o valor mora NO ASSUNTO — "Whaleco Commerce, LL...: $30.88
// USD", "HP Tuners LLC: $499.99 USD". Nenhuma régua de rótulo pega isso, e são
// exatamente os e-mails que provam o dinheiro saindo. O assunto do PayPal é
// estruturado (<comerciante>: <valor> <moeda>), então dá para ler com certeza —
// e o comerciante que vem dali vale mais que o domínio "paypal.com".
const PAYPAL_ASSUNTO = /^(.{2,60}?)\s*:\s*(R\$|US\$|\$)?\s*([0-9][0-9.,]{0,13})\s*(USD|BRL)?\s*$/
export function paypalReceipt(msg: MailMsg): { vendor: string; amount: number; currency: string } | null {
  if (!/paypal\./i.test(msg.fromAddr)) return null
  const m = msg.subject.match(PAYPAL_ASSUNTO)
  if (!m) return null
  const n = parseNumber(m[3])
  if (n == null || !(n > 0)) return null
  const currency = m[4]?.toUpperCase() || (/R\$/.test(m[2] || '') ? 'BRL' : 'USD')
  // "HP Tuners LLC" tem de virar "HP Tuners": é assim que o fornecedor está
  // escrito no app, e o sufixo societário fazia o casamento por nome falhar
  // justo nos recibos que mais importam (07/set: o T46 de $499,99).
  const vendor = m[1].replace(/\.{2,}$/, '').replace(/[,\s]+(LLC?|INC|LTD|CO|S\.?A|LTDA)\.?$/i, '').trim()
  return { vendor, amount: n, currency }
}

export function classify(msg: MailMsg): { kind: AbKind; money: ReturnType<typeof parseMoney>; orders: string[] } | null {
  const texto = `${msg.subject}\n${msg.text}`
  const orders = orderNumbersIn(texto)
  const pp = paypalReceipt(msg)
  const money = pp ? { amount: pp.amount, currency: pp.currency, strong: true, label: 'PayPal (assunto)' } : parseMoney(texto)
  if (pp) return { kind: 'CHARGE', money, orders }
  const refund = ESTORNOU.test(texto)
  const cobranca = COBRANCA.test(texto)
  const compra = COMPRA_ASSUNTO.test(msg.subject) || !!(money?.strong && orders.length)
  if (!refund && !compra && !cobranca) return null
  if (!orders.length && !money) return null
  return { kind: refund ? 'REFUND' : compra ? 'PURCHASE' : 'CHARGE', money, orders }
}

// ── O DICIONÁRIO DE PEDIDOS JÁ CONHECIDOS ──────────────────────────────────
// Diferente do dicionário do mailToItem: aqui entra TUDO, inclusive linha
// entregue e de balcão. A pergunta é só "este pedido já tem dono no app?".
//
// PONTO CEGO CONHECIDO (07/set/2026), e ele já mordeu: este dicionário lê SÓ o
// banco do US. Compra lançada no app do **BR** não existe aqui, então o robô
// pergunta por ela como se estivesse fora do app. Foi o que aconteceu com o
// pedido 1965912 da HP Tuners (6 Universal Credits, US$ 299,94, pagos pelo
// PayPal do GZ28BR): a linha estava no BR desde 03/set 23:16 e a fila perguntou
// mesmo assim. Não corrompe nada — `message_key` é único, então cada e-mail
// pergunta no máximo uma vez —, mas gasta pergunta à toa.
// Ler o BR daqui exige credencial de serviço do outro projeto no ambiente do
// app US (o `lib/supabaseBR.ts` que existe hoje é anon + sessão de navegador,
// não serve em cron). É decisão do dono, não minha: por enquanto a pergunta
// avisa que o BR não foi consultado ([[nao-achei-onde-procurou]]).
// O MESMO PEDIDO ESCRITO DE DUAS MANEIRAS (08/set/2026, achado pela sessão
// PESCA/AutoBook). O e-mail de confirmação da Summit diz "Order Number:
// 0430475"; a fatura em PDF do MESMO pedido diz "430475". Comparando string
// crua, `'0430475' !== '430475'` — o robô não via que a linha já existia e abria
// DÚVIDA para uma compra lançada. Custo real: alguém responde a dúvida e lança
// a despesa duas vezes.
//
// A trava do outro lado é mais importante que a correção: casar DEMAIS é pior
// que perguntar demais. Dúvida falsa se vê; pedido que o robô acha que já tem
// dono some em silêncio e a compra nunca é lançada. Por isso a forma sem zero
// só entra quando ainda tem 5+ caracteres — "000803" não vira "803", que
// colidiria com um pedido curto de outra loja. Medido em 08/set nas 446 linhas
// com pedido dos quatro cofres (69 começam com zero): ZERO colisões com esta
// régua. Se um dia der colisão, é aqui que se aperta.
export const normOrdem = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
export const ordemSemZero = (s: unknown) => normOrdem(s).replace(/^0+/, '')
/** As formas sob as quais um pedido deve ser conhecido/procurado. */
export function formasDoPedido(s: unknown): string[] {
  const n = normOrdem(s)
  const out: string[] = []
  if (n.length >= 5) out.push(n)
  const z = ordemSemZero(n)
  if (z.length >= 5 && z !== n) out.push(z)
  return out
}

async function pedidosConhecidos(db: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>()
  // `fixed_cost_expenses` entra junto com as 6 de item: e la que moram ASSETS,
  // MARKETING, APPS, FIXED, FLEET, STAFF e BANK, e ela TEM `order_number`.
  // Varrer so as 6 era procurar em meio app ([[nao-achei-onde-procurou]]).
  for (const t of [...ITEM_TABLES, 'fixed_cost_expenses'] as const) {
    const { data } = await db.from(t).select('order_number').not('order_number', 'is', null)
    for (const r of (data || []) as { order_number: string }[]) {
      for (const f of formasDoPedido(r.order_number)) set.add(f)
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
  // O rótulo é o CÓDIGO da invoice e o nome do carro, nunca o uuid cru. Um
  // "invoice 31931adb" não diz nada a quem vai responder — e me fez achar, em
  // 07/set, que a sugestão apontava para invoice inexistente (era só o uuid
  // truncado que eu não sabia consultar). Duas queries a mais por rodada valem
  // uma sugestão legível.
  const invIds = [...new Set((ie || []).map(r => String((r as Record<string, unknown>).invoice_id || '')).filter(Boolean))]
  const rotulo = new Map<string, string>()
  if (invIds.length) {
    const { data: invs } = await db.from('invoices').select('id, invoice_code, ride_id').in('id', invIds)
    const rideIds = [...new Set((invs || []).map(i => String((i as Record<string, unknown>).ride_id || '')).filter(Boolean))]
    const carro = new Map<string, string>()
    if (rideIds.length) {
      const { data: rides } = await db.from('rides').select('id, project_code, project_name').in('id', rideIds)
      for (const r of (rides || []) as Record<string, unknown>[]) carro.set(String(r.id), `${r.project_code || ''} ${r.project_name || ''}`.trim())
    }
    for (const i of (invs || []) as Record<string, unknown>[]) {
      const c = i.ride_id ? carro.get(String(i.ride_id)) : ''
      rotulo.set(String(i.id), [i.invoice_code || String(i.id).slice(0, 8), c].filter(Boolean).join(' — '))
    }
  }
  for (const r of (ie || []) as Record<string, unknown>[]) {
    if (!r.invoice_id) continue
    add('invoice_expenses', String(r.invoice_id), rotulo.get(String(r.invoice_id)) || `invoice ${String(r.invoice_id).slice(0, 8)}`, String(r.expense_date || '').slice(0, 10))
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

// ── A PASTA VEM ANTES DO HISTÓRICO (Márcio, 08/set/2026) ───────────────────
//   "o primeiro lugar que o robô tem que caçar é nas pastas das invoices"
// `candidatosPara` mede estatística — onde as compras ANTERIORES deste fornecedor
// foram parar. A pasta mede outra coisa, e melhor: onde a PESSOA guardou o papel
// DESTA compra. Uma é palpite informado; a outra é a resposta já dada. Por isso
// a pasta entra na frente da lista, e com o rótulo dizendo por que ela está ali.
// Ver lib/dropboxHunt.server.ts para o caso medido que virou esta lei.
export async function candidatosDaPasta(db: SupabaseClient, hits: PastaHit[]): Promise<AbCand[]> {
  const comInvoice = hits.filter(h => h.invoiceCode)
  const codigos = [...new Set(comInvoice.map(h => h.invoiceCode as string))]
  const ids = new Map<string, string>()
  if (codigos.length) {
    const { data } = await db.from('invoices').select('id, invoice_code').in('invoice_code', codigos)
    for (const i of (data || []) as Record<string, unknown>[]) ids.set(String(i.invoice_code), String(i.id))
  }
  const out: AbCand[] = []
  for (const h of hits) {
    // Sem invoice_id não há para onde lançar — o achado vira só texto na pergunta.
    const id = h.invoiceCode ? ids.get(h.invoiceCode) : undefined
    if (!id) continue
    const porque = h.forca === 'ORDEM' ? 'o PEDIDO está no nome do arquivo'
      : h.forca === 'RECENTE' ? 'arquivo salvo JUNTO com este e-mail'
      : 'arquivo do mesmo fornecedor nesta pasta'
    out.push({
      table: 'invoice_expenses', ref: id,
      label: `PASTA ${h.forca}: ${h.invoiceCode} — ${h.rideCode} ${h.rideName} (${porque}: "${h.file}")`,
      n: h.forca === 'ORDEM' ? 999 : h.forca === 'RECENTE' ? 998 : 1,
      last: String(h.modified || '').slice(0, 10),
    })
  }
  // Uma invoice só, mesmo achada por dois arquivos.
  const vistas = new Set<string>()
  return out.filter(c => (vistas.has(c.ref) ? false : (vistas.add(c.ref), true))).slice(0, 5)
}

// ── ASSINATURA JÁ TEM DONO: O MÓDULO APPS ──────────────────────────────────
// O recibo de assinatura NÃO é desta fila. Quem cuida dele é o APPS sweep, que
// casa o remetente por `fixed_cost_suppliers.mail_match` e lança em
// `fixed_cost_expenses`. Perguntar aqui seria perguntar de novo o que já está
// respondido — e o custo disso foi medido na 1ª rodada boa (07/set/2026): 10 das
// 11 perguntas eram recarga da API da Anthropic, TODAS já lançadas em 04/set.
// O texto não denunciava: o app escreve "Claude #2318-6983-2570", não
// "Anthropic". Por isso o casamento aqui é por DOMÍNIO e por `supplier_id`,
// nunca por nome no texto.
export type AppSupplier = { id: string; company: string | null; mail_match: string | null; date_conclusion: string | null }
async function appsPorDominio(db: SupabaseClient): Promise<Map<string, AppSupplier>> {
  const m = new Map<string, AppSupplier>()
  const { data } = await db.from('fixed_cost_suppliers').select('id, company, mail_match, date_conclusion')
  for (const s of (data || []) as AppSupplier[]) {
    for (const d of String(s.mail_match || '').split(/[,\n;]/)) {
      const dom = d.trim().toLowerCase()
      if (dom.length >= 4) m.set(dom, s)
    }
  }
  return m
}
const appDoRemetente = (fromAddr: string, apps: Map<string, AppSupplier>): AppSupplier | null => {
  const dom = (fromAddr.split('@')[1] || '').toLowerCase()
  if (!dom) return null
  for (const [k, v] of apps) if (dom === k || dom.endsWith('.' + k)) return v
  return null
}
async function assinaturaLancada(db: SupabaseClient, supplierId: string, data: string, dias = 6): Promise<boolean> {
  const de = new Date(Date.parse(data + 'T12:00:00Z') - dias * 86400e3).toISOString().slice(0, 10)
  const ate = new Date(Date.parse(data + 'T12:00:00Z') + dias * 86400e3).toISOString().slice(0, 10)
  const { data: hit } = await db.from('fixed_cost_expenses').select('id').eq('supplier_id', supplierId).gte('expense_date', de).lte('expense_date', ate).limit(1)
  return (hit || []).length > 0
}

// ── ANTES DE PERGUNTAR, PROCURAR NOS DOIS LUGARES (ordem dele, 07/set/2026) ─
//   "ponha o robô pra vasculhar o app pra esta nova despesa; se não encontrar,
//    verificar as pastas PURCHASES dos carros; só se não encontrar nestes 2
//    lugares, isto fica em dúvida."
//
// 1) O APP — e o app é MAIOR do que as 6 tabelas de item. `fixed_cost_expenses`
//    é o par de ASSETS, MARKETING, APPS, FIXED, FLEET, STAFF e BANK (a mesma
//    dupla `fixed_cost_suppliers` + `fixed_cost_expenses`, separada por
//    `cost_type`). Eu varria só as 6 e ignorava essa — foi ele que apontou.
//    Aqui a busca é por VALOR TOTAL + fornecedor + janela, não só por pedido:
//    a maioria das linhas da casa nasce SEM `order_number`, então casar só por
//    número é fingir que procurou.
const TABELAS_VALOR = [
  ['invoice_expenses', 'price', 'expense_date', 'supplier', 'item'],
  ['inputs', 'unit_price', 'purchase_date', 'supplier', 'description'],
  ['expenses', 'amount', 'expense_date', 'supplier', 'description'],
  ['goods', 'unit_price', 'purchase_date', 'supplier', 'description'],
  ['inventory', 'unit_price', 'purchase_date', 'supplier', 'description'],
  ['good_expenses', 'amount', 'expense_date', '', 'description'],
  ['fixed_cost_expenses', 'amount', 'expense_date', '', 'description'],
] as const

export async function achaNoApp(db: SupabaseClient, vendor: string, amount: number, data: string, dias = 15): Promise<string | null> {
  const de = new Date(Date.parse(data + 'T12:00:00Z') - dias * 86400e3).toISOString().slice(0, 10)
  const ate = new Date(Date.parse(data + 'T12:00:00Z') + dias * 86400e3).toISOString().slice(0, 10)
  const like = `%${vendor.slice(0, 12)}%`
  for (const [t, col, dt, sup, txt] of TABELAS_VALOR) {
    // `select('*')`: o select montado por template confunde o parser de tipos do
    // supabase-js, e as tabelas nao tem as mesmas colunas (good_expenses e
    // fixed_cost_expenses nao tem quantity/tax/extra). Ler tudo e somar o que
    // existir e mais simples e nao mente.
    let q = db.from(t).select('*').gte(dt, de).lte(dt, ate)
    q = sup ? q.ilike(sup, like) : q.ilike(txt, like)
    const { data: rows } = await q
    for (const r of (rows || []) as Record<string, unknown>[]) {
      const total = Number(r[col] || 0) * (Number(r.quantity) || 1) + Number(r.tax || 0) + Number(r.extra || 0)
      if (Math.abs(total - amount) < 0.02) return `${t}:${String(r.id).slice(0, 8)} — ${String(r[txt] || '').slice(0, 50)} (${String(r[dt]).slice(0, 10)})`
    }
  }
  return null
}

// 2) O PAPEL. O robô roda na Vercel e NÃO enxerga o Dropbox — a pasta
//    `Rides/<carro>/Purchases` só existe no disco dele. O que o robô alcança é
//    o Storage, que é onde o mesmo PDF vive como `receipt_url`. Então ele
//    procura o número do pedido no NOME dos arquivos guardados; achar lá
//    significa "alguém já guardou o papel e não lançou a linha", que é um
//    achado diferente de "não existe em lugar nenhum". O `search` da API de
//    Storage não filtra (testado: não acha nem arquivo que acabou de subir),
//    então lista-se a pasta e filtra-se aqui.
const PASTAS_RECIBO: [string, string][] = [
  ['good-receipts', 'inputs/purchases'], ['good-receipts', 'docs'], ['good-receipts', 'goods'],
  ['good-receipts', 'expenses'], ['good-receipts', 'fleet'], ['expense-receipts', 'docs'],
]
// Procura pelo PEDIDO **e pelo FORNECEDOR**. O pedido sozinho não acha quase
// nada, e isso custou caro em 07/set/2026: a Commercial Invoice do pedido
// 1969205 estava guardada em `US.014 - GZ28US WorkTruck/Purchases` com o nome
// **"HP Tuners - Access Licences.pdf"**. O número do pedido está DENTRO do
// papel, nunca no nome — quem nomeia arquivo escreve o FORNECEDOR e o que é.
// Procurar pelo número no nome é procurar pelo campo errado.
// (E o papel é PDF impresso pelo Chrome, sem camada de texto: `pdftotext`
// devolve 1 byte. Nem grep dentro do arquivo resolveria — só renderizando.)
export async function achaPapel(db: SupabaseClient, order: string | null, vendor?: string): Promise<string | null> {
  const alvos = [order, vendor && vendor.length >= 4 ? vendor : null]
    .filter(Boolean).map(x => String(x).toLowerCase())
  if (!alvos.length) return null
  for (const [bucket, prefix] of PASTAS_RECIBO) {
    const { data } = await db.storage.from(bucket).list(prefix, { limit: 1000 })
    for (const f of (data || [])) {
      const nome = String(f.name || '').toLowerCase()
      if (alvos.some(a => nome.includes(a))) return `${bucket}/${prefix}/${f.name}`
    }
  }
  return null
}

// ── JÁ EXISTE ALGO DESTE COMERCIANTE POR PERTO? ────────────────────────────
// Teste deliberadamente FRACO: fornecedor parecido + data na janela, NUNCA
// valor exato. Conferir recibo do PayPal por valor de uma linha só já deu
// alarme falso quatro vezes (04/set) — o app parte a compra em price + tax +
// extra e rateia entre carros, então o valor do recibo não existe em linha
// nenhuma mesmo quando a compra está lançada. Aqui a pergunta é outra e mais
// honesta: "temos QUALQUER coisa deste comerciante nestes dias?". Se não temos,
// é dinheiro fora do app e vale perguntar.
async function temLinhaPorPerto(db: SupabaseClient, vendor: string, data: string, dias = 6): Promise<boolean> {
  const like = `%${vendor.slice(0, 12)}%`
  const de = new Date(Date.parse(data + 'T12:00:00Z') - dias * 86400e3).toISOString().slice(0, 10)
  const ate = new Date(Date.parse(data + 'T12:00:00Z') + dias * 86400e3).toISOString().slice(0, 10)
  // `fixed_cost_expenses` (assinaturas) não tem coluna `supplier` — o prestador
  // mora em supplier_id. Lá o nome que sobra é o da descrição, e é por ele que
  // se procura; usar 'supplier' ali devolveria erro mudo e o teste diria "não
  // existe" para toda assinatura da casa.
  for (const [t, col, campo] of [
    ['invoice_expenses', 'expense_date', 'supplier'],
    ['expenses', 'expense_date', 'supplier'],
    ['inputs', 'purchase_date', 'supplier'],
    ['fixed_cost_expenses', 'expense_date', 'description'],
  ] as const) {
    const { data: hit } = await db.from(t).select('id').ilike(campo, like).gte(col, de).lte(col, ate).limit(1)
    if ((hit || []).length) return true
  }
  return false
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
  // O NOME DO FORNECEDOR ENTRA CURADO (ordem dele, 07/set/2026: *"normalize
  // sempre os nomes dos fornecedores, ensine todos os robôs de escaneamento a
  // fazer isso, assim os dados já entram certos"*). O e-mail escreve o remetente
  // como bem entende — "Store #2484, 2074 Ctrl Fla Pkwy" em vez de AutoZone — e
  // cada grafia nova é um fornecedor a mais no relatório. Hoje são 459 grafias
  // para 107 cadastros nos dois bancos.
  //
  // Só AQUI, na ESCRITA. As BUSCAS (achaNoApp, temLinhaPorPerto, candidatosPara),
  // a escolha de pasta (arquiva) e o papel (achaPapel) continuam com o nome CRU:
  // elas procuram o que JÁ ESTÁ no banco e nas pastas, e lá o nome torto é o que
  // existe. Curar na busca cegaria o robô para o histórico que ele precisa achar.
  //
  // Sem cadastro que case, grava o nome cru: matchSupplier devolve null em vez de
  // adivinhar, e inventar nome é pior que repetir a grafia do vendedor.
  const { data: sups } = await db.from('suppliers').select('name,aliases,is_dealership')
  const casado = matchSupplier(dados.vendor, supplierDirectoryFrom(sups || []))
  const base: Record<string, unknown> = { supplier: casado?.name || dados.vendor, order_number: dados.order, source: 'GZ28US' }
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

// ── ARQUIVAR O QUE FOI RESOLVIDO ───────────────────────────────────────────
// Cobrança dele, 07/set/2026: *"porque tem tanto email da sua pauta ainda na
// minha caixa?"*. O robô lançava e deixava tudo na inbox — processar não
// terminava, terminava só a metade que ele não vê. Agora o que o robô RESOLVE
// sai da caixa na mesma passada.
//
// Sai: o que já tem dono (rastreio/entrega de linha existente), o lançado por
// regra, e o ignorado (regra IGNORE, total 0,00, assinatura já no APPS).
// **NUNCA sai o que virou PERGUNTA** — pergunta aberta fica na caixa dele à
// vista até ser respondida.
//
// Conservador de propósito: só move se existir uma pasta com o nome do
// fornecedor na própria caixa. Sem pasta, não inventa nem cria: deixa o e-mail
// e reporta. Caixa com `auto_sweep = false` (a 6, arquivo do BR) não é varrida
// por robô nenhum — mesma lei do sweepSpam/sweepMarketing.
// CASCATA DE DESTINO (07/set/2026, 2a cobranca dele: "ainda tem email na minha
// inbox das nossas pautas, processar significa tambem guardar o email no lugar
// certo"). A 1a versao so movia se existisse pasta com o NOME DO FORNECEDOR, e
// nao existe pasta "HP Tuners" na caixa 1 — entao a compra ficou la, resolvida e
// visivel, que e o pior dos dois mundos. Agora a busca desce degrau a degrau:
//   1. a pasta do CARRO ("US.014 - GZ28US WorkTruck"), quando se sabe o carro;
//   2. a pasta do FORNECEDOR ("Temu", "eBay", "Texas Speed");
//   3. **"Purchases"** — o guarda-chuva que ja existe nas caixas e ja tem compra
//      dentro. Compra resolvida NUNCA fica na inbox por falta de pasta exata.
// So depois disso ele desiste e reporta. Continua sem CRIAR pasta: inventar
// pasta e decisao de arrumacao da casa, nao de robo.
const DESTINO_FINAL = 'purchases'
async function arquiva(
  token: string, pastas: Map<string, string>, msg: MailMsg, vendor: string, out: AutoBookMailResult, carro?: string | null,
): Promise<void> {
  if (!msg.id) return
  const tentar = [carro || '', vendor, DESTINO_FINAL].map(x => String(x).trim().toLowerCase()).filter(Boolean)
  let alvo: string | undefined, onde = ''
  for (const t of tentar) { const id = pastas.get(t); if (id) { alvo = id; onde = t; break } }
  if (!alvo) { out.semPasta.push(`${vendor} — "${msg.subject.slice(0, 50)}" (sem pasta do carro, do fornecedor nem "Purchases")`); return }
  if (await moveMessage(token, msg.id, alvo)) out.arquivados.push(`${onde} ← ${msg.subject.slice(0, 55)}`)
  else out.erros.push(`falhou ao arquivar em ${onde}: ${msg.subject.slice(0, 45)}`)
}

// ── O CORTE DO BR (lei dele, 06/set/2026) ──────────────────────────────────
//   "pode processar as coisas do BR, mas SEM RETROATIVO, só daqui pra frente."
// O AutoBook do BR nasceu em 06/set/2026, 00:00 de Brasília = 03:00Z. E-mail das
// caixas brasileiras anterior a isso não se processa nem vira pergunta — é
// histórico, e só entra se ele mandar. A trava mora AQUI, e não na janela do
// cron, porque a janela é ajustável: uma varredura larga pra recuperar uma
// rodada perdida não pode ressuscitar o retroativo do BR por efeito colateral.
const BR_FLOOR = '2026-09-06T03:00:00Z'
const CAIXAS_BR = /gz28br@|gz28shopping@/i
const antesDoCorteBR = (account: string | null | undefined, received: string): boolean =>
  CAIXAS_BR.test(String(account || '')) && String(received || '') < BR_FLOOR

type Caixa = { nome: string; slot: number; msgs: MailMsg[]; token: string | null; pastas: Map<string, string>; podeArquivar: boolean }
async function lerCaixa(db: SupabaseClient, auth: MailAuth, desde: string): Promise<Caixa> {
  const nome = auth.account || 'slot' + auth.id
  const vazio = { nome, slot: auth.id || 0, msgs: [] as MailMsg[], token: null, pastas: new Map<string, string>(), podeArquivar: false }
  const token = await freshAccessToken(db, auth)
  if (!token) return { ...vazio, nome: nome + ':sem-token' }
  const gmail = mailProvider(auth) === 'gmail'
  const msgs = gmail ? await fetchRecentGmail(token, desde, { q: GMAIL_Q_COMPRA, max: 60 }) : await fetchRecentMessages(token, desde)
  // Só o Graph tem o mapa de pastas aqui, e só caixa com auto_sweep ligado é
  // varrida por robô ([[email-multi-account]]).
  const podeArquivar = !gmail && maySweep(auth)
  const pastas = podeArquivar ? await folderMap(token) : new Map<string, string>()
  return { nome: `${nome}:${msgs.length}`, slot: auth.id || 0, msgs, token, pastas, podeArquivar }
}

// ── PROVA DE VIDA ──────────────────────────────────────────────────────────
// Sem isto, fila vazia significa DUAS coisas ao mesmo tempo — "rodou e não achou
// nada" e "não rodou" — e não há como distinguir. Já aconteceu nesta casa: o
// mail-poll morreu calado no teto de tempo e passou 4 dias sem rodar sem ninguém
// perceber, porque a ausência de resultado parecia resultado. A linha nasce ANTES
// do trabalho, como o `last_poll` do mail-poll: passada que estoura no meio deixa
// RUNNING pendurado, e RUNNING velho é justamente o sintoma que se quer ver.
async function abreRodada(db: SupabaseClient, horas: number, trigger: string): Promise<string | null> {
  const { data } = await db.from('auto_book_mail_runs').insert({ trigger, horas, status: 'RUNNING' }).select('id').single()
  return data ? String((data as { id: string }).id) : null
}
async function fechaRodada(db: SupabaseClient, id: string | null, r: AutoBookMailResult, status: 'DONE' | 'ERROR'): Promise<void> {
  if (!id) return
  await db.from('auto_book_mail_runs').update({
    status, finished_at: new Date().toISOString(),
    counts: {
      lidos: r.lidos, com_dinheiro: r.comDinheiro, perguntas: r.perguntas.length,
      lancados: r.lancados.length, ja_tem_linha: r.jaTemLinha.length,
      ignorados: r.ignorados.length, duvidas_app: r.duvidasApp.length, sem_recibo: r.semRecibo.length,
      arquivados: r.arquivados.length, sem_pasta: r.semPasta.length,
      achados_no_app: r.achadosNoApp.length, papel_sem_linha: r.papelSemLinha.length,
    },
    caixas: r.caixas, errors: r.erros,
  }).eq('id', id)
}

export async function runAutoBookMail(db: SupabaseClient, horas = 3, trigger = 'cron'): Promise<AutoBookMailResult> {
  const out: AutoBookMailResult = { janela: '', caixas: [], lidos: 0, comDinheiro: 0, jaTemLinha: [], ignorados: [], lancados: [], semRecibo: [], perguntas: [], duvidasApp: [], arquivados: [], semPasta: [], achadosNoApp: [], papelSemLinha: [], erros: [] }
  const rodada = await abreRodada(db, horas, trigger)
  const desde = new Date(Date.now() - horas * 3600e3).toISOString()
  out.janela = `desde ${desde}`

  const { data: rulesRaw } = await db.from('auto_book_mail_rules').select('*').eq('active', true)
  const rules = (rulesRaw || []) as AbRule[]
  const conhecidos = await pedidosConhecidos(db)
  const apps = await appsPorDominio(db)
  const { data: jaNaFila } = await db.from('auto_book_mail').select('message_key').gte('created_at', new Date(Date.now() - 30 * 86400e3).toISOString())
  const naFila = new Set(((jaNaFila || []) as { message_key: string }[]).map(r => r.message_key))

  for (const auth of await listMailAuths(db)) {
    let caixa: Caixa
    try { caixa = await lerCaixa(db, auth, desde) } catch { out.caixas.push((auth.account || 'slot' + auth.id) + ':erro'); continue }
    out.caixas.push(caixa.nome)
    out.lidos += caixa.msgs.length

    for (const msg of caixa.msgs) {
      if (antesDoCorteBR(auth.account, msg.received)) continue
      const c = classify(msg)
      if (!c) continue
      out.comDinheiro++

      // No recibo do PayPal quem interessa é o COMERCIANTE ("HP Tuners LLC"),
      // não o trilho ("paypal.com") — é o comerciante que casa com o histórico.
      const pp = paypalReceipt(msg)
      const vendor = pp?.vendor || vendorOf(msg)
      const data = String(msg.received || new Date().toISOString()).slice(0, 10)
      const texto = `${msg.subject}\n${msg.text}`

      // ── ASSINATURA É DO MÓDULO APPS, NÃO DESTA FILA ─────────────────────
      const app = appDoRemetente(msg.fromAddr, apps)
      if (app) {
        if (await assinaturaLancada(db, app.id, data)) {
          out.jaTemLinha.push(`${app.company || vendor} — recibo de assinatura ja lancado no APPS`)
          if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, app.company || vendor, out)
        } else {
          out.duvidasApp.push(`${app.company || vendor} cobrou em ${data} e o robo de APPS nao lancou — "${msg.subject.slice(0, 60)}"`)
        }
        continue
      }

      // ── O RECIBO DO PAYPAL É A PERNA DO PAGAMENTO, NÃO A COMPRA ──────────
      // Ele quase nunca traz número de pedido, então não dá para casar por
      // pedido. Se já existe linha desse comerciante por perto da data, o
      // recibo é o pagamento de algo JÁ lançado e perguntar seria ruído puro.
      // Se não existe NADA dele na janela, aí sim é dinheiro fora do app — foi
      // exatamente assim que o $4,17 do Temu apareceu na conferência à mão.
      if (pp && !c.orders.length && await temLinhaPorPerto(db, vendor, data)) {
        out.jaTemLinha.push(`${vendor} ${pp.currency} ${pp.amount} — recibo PayPal de compra já lançada`)
        if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
        continue
      }

      // ── UM PEDIDO POR VEZ ───────────────────────────────────────────────
      // "Your purchase has been divided into 2 orders": dois pedidos, dois
      // totais, dois destinos possíveis. Uma linha de fila por pedido.
      const totais = totaisPorPedido(texto)
      type Item = { order: string | null; amount: number | null; currency: string; strong: boolean; label: string | null }
      const itens: Item[] = c.orders.length
        ? c.orders.map((o): Item => {
          const t = totais[o]
          if (t) return { order: o, amount: t.amount, currency: t.currency, strong: true, label: 'Order total (do próprio pedido)' }
          // Pedido único no e-mail: o total do e-mail é dele, sem ambiguidade.
          if (c.orders.length === 1 && c.money) return { order: o, amount: c.money.amount, currency: c.money.currency, strong: c.money.strong, label: c.money.label }
          // Vários pedidos e nenhum total colado: atribuir seria chute.
          return { order: o, amount: null, currency: c.money?.currency || 'USD', strong: false, label: null }
        })
        : [{ order: null, amount: c.money?.amount ?? null, currency: c.money?.currency || 'USD', strong: !!c.money?.strong, label: c.money?.label ?? null }]

      for (const it of itens) {
        const chave = it.order ? `${keyOf(caixa.slot, msg)}#${it.order}` : keyOf(caixa.slot, msg)
        if (naFila.has(chave)) continue

        // já tem dono? o mailToItem cuida dos fatos dessa linha. A comparação
        // passa pelas MESMAS formas com que o índice foi montado — ver normOrdem.
        if (it.order && formasDoPedido(it.order).some(f => conhecidos.has(f))) {
          out.jaTemLinha.push(`${it.order} — ${msg.subject.slice(0, 50)}`)
          if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
          continue
        }

        const desc = `${vendor}${it.order ? ' — pedido ' + it.order : ''} — ${msg.subject.slice(0, 90)}`
        // 0,00 não gera linha (PO de $0.00 do Temu).
        if (it.amount === 0) {
          out.ignorados.push(`${vendor} ${it.order || ''} — total 0,00`)
          if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
          continue
        }

        const regra = ruleFor(msg, vendor, rules)
        if (regra?.action === 'IGNORE') {
          out.ignorados.push(`${vendor} — ${msg.subject.slice(0, 50)} (regra "${regra.label || regra.id.slice(0, 8)}")`)
          await db.from('auto_book_mail_rules').update({ hits: (regra.hits || 0) + 1, last_hit_at: new Date().toISOString() }).eq('id', regra.id)
          if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
          continue
        }

        // REGRA DE LANÇAMENTO — só com valor de rótulo FORTE e pedido na mão.
        if (regra?.action === 'BOOK' && regra.target && it.strong && it.amount && it.order) {
          const r = await lancar(db, regra.target as Record<string, unknown>, { vendor, order: it.order, amount: it.amount, date: data, desc })
          if ('erro' in r) { out.erros.push(`${vendor} ${it.order}: ${r.erro}`) }
          else {
            await db.from('auto_book_mail_rules').update({ hits: (regra.hits || 0) + 1, last_hit_at: new Date().toISOString() }).eq('id', regra.id)
            await db.from('auto_book_mail').insert({
              message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
              from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: it.order,
              currency: it.currency, amount: it.amount, extracted: { label: it.label, orders: c.orders, regra: regra.label },
              status: 'BOOKED', booked_table: r.table, booked_id: r.id, answered_at: new Date().toISOString(),
              question: 'LANCADA POR REGRA — falta a printable invoice (PDF do vendedor) no receipt_url e na pasta Purchases',
            })
            naFila.add(chave)
            out.lancados.push(`${vendor} ${it.order} ${it.currency} ${it.amount} → ${r.table}:${r.id.slice(0, 8)}`)
            out.semRecibo.push(`${r.table}:${r.id.slice(0, 8)} — ${vendor} ${it.order}`)
            if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
            continue
          }
        }

        // ── AS DUAS BUSCAS ANTES DE PERGUNTAR (ordem dele, 07/set/2026) ──
        // 1) o app inteiro, por valor + fornecedor + janela — nao so por pedido.
        if (it.amount != null && it.amount > 0) {
          const achado = await achaNoApp(db, vendor, it.amount, data)
          if (achado) {
            out.achadosNoApp.push(`${vendor} ${it.currency} ${it.amount} JA ESTA em ${achado}`)
            if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
            continue
          }
        }
        // 2) o papel: o pedido aparece no nome de algum recibo ja guardado?
        const papel = await achaPapel(db, it.order, vendor)
        if (papel) out.papelSemLinha.push(`${vendor} ${it.order} — papel guardado em ${papel}, mas SEM linha no app`)

        // ── A TERCEIRA BUSCA, E ELA VEM PRIMEIRO NA RESPOSTA (08/set/2026) ──
        // "o primeiro lugar que o robô tem que caçar é nas pastas das invoices".
        // O Dropbox é alcançável pela API (as chaves já servem ao ride-folder) —
        // o "ponto cego" era suposição. Falha de rede aqui não pode derrubar a
        // rodada: sem pasta, a pergunta sai como saía antes.
        let pasta: PastaHit[] = []
        try { pasta = await cacaNaPasta({ vendor, order: it.order, quando: msg.received }) }
        catch (e) { out.erros.push(`pasta ${vendor}: ${e instanceof Error ? e.message : String(e)}`) }
        const daPasta = pasta.length ? await candidatosDaPasta(db, pasta) : []
        const unica = respostaUnica(pasta)

        // A PERGUNTA. Uma só, com tudo que já foi lido e os destinos medidos.
        // A pasta na frente do histórico: resposta dada por gente vale mais que
        // estatística de fornecedor.
        const cands = [...daPasta, ...(await candidatosPara(db, vendor))].slice(0, 8)
        const falta = [
          !it.order ? 'sem numero de pedido' : null,
          it.amount == null ? 'sem valor legivel' : !it.strong ? `valor ${it.amount} lido de rotulo fraco ("${it.label}")` : null,
          // Honestidade sobre o escopo da busca: eu só olhei o banco do US.
          it.order ? 'CONFERIR NO APP DO BR TAMBEM — este robo so olha o banco do US' : null,
          // Negativo so vale dizendo ONDE se procurou ([[nao-achei-onde-procurou]]).
          it.amount ? 'procurei por valor+fornecedor nas 6 tabelas de item E em fixed_cost_expenses (ASSETS/APPS/MARKETING/FIXED/FLEET/STAFF/BANK): nao achei' : null,
          papel ? `o PAPEL ja esta guardado em ${papel} — falta a linha` : 'nenhum recibo guardado com esse pedido nem com esse fornecedor',
          // A PASTA — primeiro lugar de caça desde 08/set/2026. Negativo aqui
          // também diz ONDE se procurou ([[nao-achei-onde-procurou]]).
          unica
            ? `A PASTA JA RESPONDEU: o arquivo "${unica.file}" esta em ${unica.invoiceCode} (${unica.rideCode} ${unica.rideName})`
            : daPasta.length ? `${daPasta.length} pasta(s) de invoice com papel deste fornecedor — a primeira sugestao vem de la`
            : 'procurei nas pastas de invoice do Dropbox (Rides US e BR, por numero de pedido e por fornecedor): nenhum arquivo',
        ].filter(Boolean)
        const valor = it.amount != null ? ` — ${it.currency} ${it.amount}` : ''
        const question = c.kind === 'REFUND'
          ? `Estorno de ${vendor}${it.order ? ' (pedido ' + it.order + ')' : ''}${valor}: qual linha ele abate?`
          : `${c.kind === 'CHARGE' ? 'Cobranca' : 'Compra'} de ${vendor}${it.order ? ' — pedido ' + it.order : ''}${valor}: entra em qual invoice/carro?${falta.length ? ' (' + falta.join('; ') + ')' : ''}`
        const { error } = await db.from('auto_book_mail').insert({
          message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
          from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: it.order,
          currency: it.currency, amount: it.amount, question, cands,
          extracted: { label: it.label, strong: it.strong, orders: c.orders, totais, trecho: msg.text.slice(0, 900) },
        })
        if (error) { out.erros.push(`fila ${vendor}: ${error.message}`); continue }
        naFila.add(chave)
        out.perguntas.push(question)
      }
    }
  }
  // Erro dentro da passada (uma caixa que falhou, uma escrita recusada) fecha a
  // rodada como ERROR mas com os números do que deu certo. Erro que ESTOURA a
  // função — o provedor fora do ar, o teto de tempo da Vercel — nem chega aqui:
  // a linha fica RUNNING pendurada, e RUNNING velho é o sintoma que se quer ver.
  await fechaRodada(db, rodada, out, out.erros.length ? 'ERROR' : 'DONE')
  return out
}
