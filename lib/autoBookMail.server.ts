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
//   • NUNCA repete pergunta: `message_key` é único e a resposta vira regra. E
//     desde 11/set/2026 nem quando a loja manda DUAS cartas da mesma compra —
//     mesmo fornecedor, mesmo valor ao centavo, dúvida aberta nas últimas 24h
//     é a mesma pergunta (`chaveDuvida`, Livro 5.9). A 2ª carta NÃO some: ela
//     deixa a sua própria linha em `auto_book_mail` (status DUPLICATE, com o
//     trecho lido e o id da dúvida que responde por ela) e sai da caixa — e se
//     ela trouxer o número do pedido que a dúvida aberta não tem, o número é
//     ENXERTADO na dúvida antes de ela ser calada.
//   • NUNCA escreve status — status é derivado (lib/deliverStatus.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listMailAuths, mailProvider, freshAccessToken, fetchRecentMessages, fetchRecentGmail,
  folderMap, moveMessage, maySweep, GMAIL_Q_COMPRA, type MailMsg, type MailAuth,
} from './streamMail.server'
import { ITEM_TABLES } from './itemTracking.server'
import { PEDIDO_NOVO, ESTORNOU } from './mailToItem.server'
import { matchSupplier, supplierDirectoryFrom, type SupplierEntry } from './supplierMatch'
import { cacaNaPasta, respostaUnica, type PastaHit } from './dropboxHunt.server'
import { tabelaAtual } from './tableRenames'

export type AbKind = 'PURCHASE' | 'REFUND' | 'CHARGE'
export type AbRule = { id: string; label: string | null; match_from: string | null; match_subject: string | null; match_vendor: string | null; action: 'BOOK' | 'IGNORE' | 'ASK'; target: Record<string, unknown> | null; hits: number }
// `n` é UM CONTADOR: quantas compras anteriores deste fornecedor foram parar
// neste destino. `via` diz de onde o candidato veio, porque as duas origens
// medem coisas diferentes e não se comparam:
//   HISTORICO — estatística. `n` é o número de verdade.
//   PASTA     — o papel desta compra guardado por gente. Não conta nada, e por
//               isso `n` é 0. A ordem já vem certa (ORDEM antes de RECENTE) e a
//               etiqueta está no `label`.
//
// ── POR QUE ISSO VIROU CAMPO (09/set/2026) ────────────────────────────────
// Os achados de pasta entravam com n=999 (ORDEM) e n=998 (RECENTE) só para se
// ordenarem na frente. Quem lê a fila não vê um posto, vê um contador: a
// sugestão saiu na tela como "998x", que se lê como 998 lançamentos naquele
// destino — e não existe nenhum. Número inventado numa tela de dinheiro é a
// mesma doença de sempre; posto é posto, contagem é contagem.
export type AbCand = { table: string; ref: string; label: string; n: number; last: string; via?: "PASTA" | "HISTORICO" }
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
  duplicadas: string[]
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
    // O SUBTOTAL É O PIOR DOS FRACOS, E ERA ELE QUE GANHAVA (09/set/2026).
    // O desempate entre rótulos fracos era "o MAIOR valor, porque o total é o
    // teto" — e isso é verdade em nota sem desconto. Com desconto o subtotal
    // fica ACIMA do total, então a regra escolhia justamente o número errado: a
    // compra da HHP mostrou 1.444,75 (subtotal) no lugar de 1.290,93 pago
    // (subtotal 1.444,75 − desconto 161,77 + manuseio 7,95).
    // Três degraus, e o valor só desempata dentro do mesmo degrau.
    const degrau = strong ? 2 : /^sub\s*total$/i.test(label.trim()) ? 0 : 1
    const degrauBest = !best ? -1 : best.strong ? 2 : /^sub\s*total$/i.test(best.label.trim()) ? 0 : 1
    if (!best || degrau > degrauBest || (degrau === degrauBest && n > best.amount)) best = { amount: n, currency, strong, label }
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
// ── QUEM É TRILHO E QUEM É PLATAFORMA NÃO É FORNECEDOR ─────────────────────
// Dois domínios da lista acima mentem sobre quem vendeu, e os dois já custaram
// dúvida errada:
//   • PAYPAL é o trilho do pagamento. "paypal.com" como fornecedor não casa com
//     NADA no app (lá está escrito HHP, HP Tuners, Temu) — e foi assim que o
//     aviso de envio da compra HHP 384734 abriu a dúvida 6bab19c6 como cobrança
//     nova de "PayPal" (Livro 3.6). O comerciante está escrito no corpo, na
//     linha "Merchant".
//   • SHOPIFY é a plataforma da loja, não a loja. O recibo sai de
//     @t.shopifyemail.com e o nome da loja está no NOME do remetente ("Detail
//     Ground") — "Shopifyemail" seria um fornecedor inventado (Livro 3.7).
const ehDominio = (dom: string, base: string) => dom === base || dom.endsWith('.' + base)
export const ehPayPalMsg = (msg: MailMsg) => /paypal\./i.test(msg.fromAddr)
export const ehLojaShopify = (msg: MailMsg) => ehDominio((msg.fromAddr.split('@')[1] || '').toLowerCase(), 'shopifyemail.com')

// O corpo chega com TODOS os espaços colapsados em um só (streamMail.server.ts
// troca `\s+` por ' '), então não existe "linha" para ler: o que sobra é
// "… Merchant High Horse Performance, Inc. Transaction ID 8XY… ". Por isso a
// leitura é por CERCA: pega no máximo 60 caracteres depois da palavra e corta
// no primeiro rótulo seguinte do recibo. Nome que não passa na peneira volta
// nulo — inventar fornecedor é pior que ficar com o domínio.
const PP_MERCHANT = /\b(?:merchant|comerciante|vendedor)\b\s*:?\s*([^|•·\n]{2,60})/gi
const PP_PROXIMO_ROTULO = /\b(transaction|invoice|order|payment|amount|total|receipt|purchase|seller|buyer|date|ship\w*|paypal|description|quantity|unit|subtotal|item|status|note)\b/i
export function comercianteDoPayPal(texto: string): string | null {
  for (const m of String(texto || '').matchAll(PP_MERCHANT)) {
    const nome = nomeSemSufixo(
      m[1].replace(/^(information|info|details|detalhes|name|nome)\b[\s:–-]*/i, '')
        // O e-mail de contato do vendedor vem COLADO no nome, e é o próximo
        // campo do recibo: "Merchant High Horse Performance, Inc.
        // orders@highhorseperformance.com Shipping address …" (trecho real da
        // dúvida 6bab19c6). O nome acaba onde começa o endereço.
        .split(/\s+\S*@\S*/)[0]
        .split(PP_PROXIMO_ROTULO)[0],
    )
    // A PENEIRA, e ela é o coração desta função: a palavra "merchant" também
    // aparece em prosa ("contact the merchant directly"), e dali sai frase, não
    // fornecedor. Nome de loja começa com MAIÚSCULA, tem no máximo 5 palavras,
    // não tem arroba nem link. O que não passa devolve nulo, e o robô fica com o
    // domínio — inventar fornecedor é pior que ficar com "PayPal".
    if (!/^[A-Z0-9À-Þ]/.test(nome)) continue
    if (/@|https?:/i.test(nome)) continue
    if (nome.length < 2 || nome.length > 40 || nome.split(/\s+/).length > 5) continue
    return nome
  }
  return null
}

// "HP Tuners LLC" tem de virar "HP Tuners": é assim que o fornecedor está
// escrito no app, e o sufixo societário fazia o casamento por nome falhar justo
// nos recibos que mais importam (07/set: o T46 de $499,99).
export function nomeSemSufixo(bruto: string): string {
  return String(bruto || '').trim()
    .replace(/\.{2,}$/, '')
    .replace(/[,\s]+(LLC?|INC|LTD|CO|S\.?A|LTDA)\.?$/i, '')
    .replace(/[.,;:\s]+$/, '')
    .trim()
}

export function vendorOf(msg: MailMsg): string {
  const dom = (msg.fromAddr.split('@')[1] || '').toLowerCase()
  if (ehPayPalMsg(msg)) {
    const comerciante = comercianteDoPayPal(msg.text)
    if (comerciante) return comerciante
  }
  if (ehLojaShopify(msg)) {
    const loja = nomeSemSufixo(String(msg.from || '').replace(/["']/g, ''))
    if (loja.length >= 2) return loja.slice(0, 40)
  }
  for (const [k, v] of Object.entries(DOM_VENDOR)) if (ehDominio(dom, k)) return v
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
//
// "RECEIPT FOR ORDER" ENTRA (11/set/2026, Livro 3.7): é o assunto padrão do
// recibo de loja Shopify — "Receipt for order #13150". Não casava com nada
// daqui ("receipt for your purchase" pede o "your"), e a compra de US$ 77,67 da
// Detail Ground não deixou uma linha sequer na fila.
const COMPRA_ASSUNTO = /\border\b.{0,40}?\b(confirmed|received|placed|acknowledged)\b|\border\s*(confirm|receiv|placed|acknowledg)|orders?\s+confirmation|confirmation of your order|confirmed:|thank(s| you) for (your|shopping)|your (order|purchase|receipt|invoice)\b|purchase (is )?confirmed|receipt for (your (payment|purchase)|order)|payment receipt|pedido (confirmado|recebido|realizado)|confirma[çc][ãa]o (do|de) pedido|recibo d[eo] pagamento|nota fiscal/i

// ── AVISO DE ENVIO DO PAYPAL NÃO É COBRANÇA (Livro 3.6, 11/set/2026) ───────
// O caso, medido: em 10/set 14:23 chegou o aviso do PayPal de que a compra da
// HHP (pedido 384734), LANÇADA em 09/set, tinha saído para entrega. O e-mail
// traz o valor pago dentro, o assunto fala do pedido, e a peneira leu tudo isso
// como dinheiro novo: nasceu a dúvida 6bab19c6, "Cobranca de PayPal — US$
// 1.290,93", fechada à mão como IGNORED. Dinheiro nenhum se moveu duas vezes,
// mas a fila de dúvida é do dono, e dúvida falsa nela é ruído que cansa.
//
// A trava é ESTREITA de propósito, e vale só para o PayPal: assunto de embarque
// em e-mail de LOJA continua passando, porque a confirmação de compra da Home
// Depot fala de embarque no corpo e é compra de verdade (foi a lição de 07/set,
// que custou uma rodada inteira). No PayPal é diferente: o recibo dele tem
// assunto ESTRUTURADO ("<comerciante>: $499.99 USD") e nunca fala de entrega —
// então "on its way" ali só pode ser a segunda carta da mesma compra. O
// rastreio dentro dela continua sendo lido pelo mailToItem, que escreve o fato
// na linha que já existe.
const ENVIO_ASSUNTO = /\bon (its|the) way\b|\b(has|have|was|were) shipped\b|\bshipping (confirmation|update)\b|\bout for delivery\b|\bdelivered\b|\ba caminho\b|\bfoi (enviado|despachado)\b|\bsaiu para entrega\b/i

// ── O RECIBO DO PAYPAL ─────────────────────────────────────────────────────
// O PayPal é o trilho de pagamento da casa e o recibo dele não tem rótulo
// nenhum no corpo: o valor mora NO ASSUNTO — "Whaleco Commerce, LL...: $30.88
// USD", "HP Tuners LLC: $499.99 USD". Nenhuma régua de rótulo pega isso, e são
// exatamente os e-mails que provam o dinheiro saindo. O assunto do PayPal é
// estruturado (<comerciante>: <valor> <moeda>), então dá para ler com certeza —
// e o comerciante que vem dali vale mais que o domínio "paypal.com".
const PAYPAL_ASSUNTO = /^(.{2,60}?)\s*:\s*(R\$|US\$|\$)?\s*([0-9][0-9.,]{0,13})\s*(USD|BRL)?\s*$/
export function paypalReceipt(msg: MailMsg): { vendor: string; amount: number; currency: string } | null {
  if (!ehPayPalMsg(msg)) return null
  const m = msg.subject.match(PAYPAL_ASSUNTO)
  if (!m) return null
  const n = parseNumber(m[3])
  if (n == null || !(n > 0)) return null
  const currency = m[4]?.toUpperCase() || (/R\$/.test(m[2] || '') ? 'BRL' : 'USD')
  // O CORPO VEM ANTES DO ASSUNTO (11/set/2026, Livro 3.6). O assunto corta o
  // comerciante em 60 caracteres — "Whaleco Commerce, LL..." — e nome cortado
  // não casa com cadastro nenhum. A linha "Merchant" do corpo traz o nome
  // inteiro; sem ela, fica o do assunto, como sempre foi.
  const vendor = comercianteDoPayPal(msg.text) || nomeSemSufixo(m[1])
  return { vendor, amount: n, currency }
}

export function classify(msg: MailMsg): { kind: AbKind; money: ReturnType<typeof parseMoney>; orders: string[] } | null {
  const texto = `${msg.subject}\n${msg.text}`
  const orders = orderNumbersIn(texto)
  const pp = paypalReceipt(msg)
  // O aviso de ENVIO do PayPal morre aqui, calado, como marketing: ele não é
  // recibo (não tem o assunto estruturado) e o que ele carrega já foi pago.
  if (!pp && ehPayPalMsg(msg) && ENVIO_ASSUNTO.test(msg.subject)) return null
  const money = pp ? { amount: pp.amount, currency: pp.currency, strong: true, label: 'PayPal (assunto)' } : parseMoney(texto)
  if (pp) return { kind: 'CHARGE', money, orders }
  const refund = ESTORNOU.test(texto)
  const cobranca = COBRANCA.test(texto)
  // Recibo de loja Shopify com o número do pedido NO ASSUNTO é compra, diga o
  // resto do assunto o que disser. O número tem de estar no ASSUNTO, e não em
  // qualquer lugar do corpo: a campanha do Shopify Email sai do MESMO domínio e
  // carrega "order #12345" no rodapé ("check your order status", cupom) — com a
  // peneira no corpo inteiro, promoção viraria dúvida na fila do dono. Recibo
  // põe o pedido no assunto ("Receipt for order #13150"); anúncio não põe.
  const compra = COMPRA_ASSUNTO.test(msg.subject) || (ehLojaShopify(msg) && orderNumbersIn(msg.subject).length > 0) || !!(money?.strong && orders.length)
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
    const c = out.get(k) || { table, ref, label, n: 0, last: date, via: 'HISTORICO' as const }
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
  const { data: ex } = await db.from('staff_expenses')
    .select('season_id, expense_date, origin').ilike('supplier', like)
    .order('expense_date', { ascending: false }).limit(40)
  for (const r of (ex || []) as Record<string, unknown>[]) {
    if (!r.season_id) continue
    add('staff_expenses', String(r.season_id), `staff_expenses ${String(r.origin || '')} (season ${String(r.season_id).slice(0, 8)})`, String(r.expense_date || '').slice(0, 10))
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
      // Zero, e é a verdade: a pasta não contou lançamento nenhum. A ordem vem
      // de `cacaNaPasta`, que já devolve ORDEM antes de RECENTE antes de
      // FORNECEDOR, e a força está escrita no próprio label.
      n: 0, via: 'PASTA',
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
  ['staff_expenses', 'amount', 'expense_date', 'supplier', 'description'],
  ['assets', 'unit_price', 'purchase_date', 'supplier', 'description'],
  ['inventory', 'unit_price', 'purchase_date', 'supplier', 'description'],
  ['assets_expenses', 'amount', 'expense_date', '', 'description'],
  ['fixed_cost_expenses', 'amount', 'expense_date', '', 'description'],
] as const

export async function achaNoApp(db: SupabaseClient, vendor: string, amount: number, data: string, dias = 15): Promise<string | null> {
  const de = new Date(Date.parse(data + 'T12:00:00Z') - dias * 86400e3).toISOString().slice(0, 10)
  const ate = new Date(Date.parse(data + 'T12:00:00Z') + dias * 86400e3).toISOString().slice(0, 10)
  const like = `%${vendor.slice(0, 12)}%`
  for (const [t, col, dt, sup, txt] of TABELAS_VALOR) {
    // `select('*')`: o select montado por template confunde o parser de tipos do
    // supabase-js, e as tabelas nao tem as mesmas colunas (assets_expenses e
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

// ── O CADASTRO DE FORNECEDORES, UMA LEITURA POR RODADA ─────────────────────
// O PostgREST corta a resposta em 1.000 linhas SEM DIZER NADA: passando disso o
// diretório volta pela metade, `matchSupplier` deixa de achar o nome curado, e o
// teste de "já tem linha por perto" fica menos eficaz sem ninguém saber. Hoje são
// 212 cadastros (medido em 11/set/2026, só leitura) — longe do corte. Por isso o
// teto é explícito e a chegada nele GRITA na rodada, em vez de esperar alguém
// desconfiar. (`lancar` tem a sua própria leitura, e ela é rara: só quando uma
// regra BOOK vai gravar linha.)
const TETO_SUPPLIERS = 2000
async function diretorioFornecedores(db: SupabaseClient, out: AutoBookMailResult): Promise<SupplierEntry[]> {
  const { data: sups, error } = await db.from('suppliers').select('name,aliases,is_dealership').limit(TETO_SUPPLIERS)
  if (error) {
    out.erros.push(`cadastro de fornecedores: ${error.message} — o teste "já tem linha por perto" roda só com a grafia crua do e-mail`)
    return []
  }
  const linhas = sups || []
  if (linhas.length >= 1000) out.erros.push(`cadastro de fornecedores voltou com ${linhas.length} linhas — pode estar truncado no corte do PostgREST, e aí o nome CURADO deixa de casar`)
  return supplierDirectoryFrom(linhas)
}

// ── JÁ EXISTE ALGO DESTE COMERCIANTE POR PERTO? ────────────────────────────
// Teste deliberadamente FRACO: fornecedor parecido + data na janela, NUNCA
// valor exato. Conferir recibo do PayPal por valor de uma linha só já deu
// alarme falso quatro vezes (04/set) — o app parte a compra em price + tax +
// extra e rateia entre carros, então o valor do recibo não existe em linha
// nenhuma mesmo quando a compra está lançada. Aqui a pergunta é outra e mais
// honesta: "temos QUALQUER coisa deste comerciante nestes dias?". Se não temos,
// é dinheiro fora do app e vale perguntar.
// O NOME PROCURADO É O DO COMERCIANTE, E ELE TEM DOIS (11/set/2026, Livro 3.6).
// Quem chama daqui é o ramo do PayPal, e antes chegava "PayPal" — que não existe
// em linha nenhuma do app, porque lá está escrito o vendedor. Agora chega o
// comerciante lido do corpo ("High Horse Performance"), e aí aparece a segunda
// metade do problema: o app escreve esse mesmo fornecedor como "HHP". Por isso o
// teste roda com as DUAS grafias — a crua do e-mail e a CURADA do cadastro
// (suppliers.aliases) — e basta uma achar.
// É a única busca que cura o nome, e por um motivo: aqui a pergunta não é "onde
// está o histórico desta grafia", é "existe QUALQUER linha deste comerciante
// nestes dias". As outras buscas continuam com o nome cru, de propósito.
// O CADASTRO CHEGA PRONTO, LIDO UMA VEZ POR RODADA (`dir`): a 1ª versão de
// 11/set lia a tabela `suppliers` INTEIRA a cada e-mail do PayPal, e o laço de
// nomes ainda multiplicava as consultas por dois. Ler o mesmo cadastro oito
// vezes numa rodada não melhora resposta nenhuma — e a rodada roda de hora em
// hora, dentro do teto de tempo da Vercel.
async function temLinhaPorPerto(db: SupabaseClient, dir: SupplierEntry[], vendor: string, data: string, dias = 6): Promise<boolean> {
  const casado = matchSupplier(vendor, dir)
  const nomes = [...new Set([vendor, casado?.name].filter(Boolean).map(n => String(n).slice(0, 12)))]
  const de = new Date(Date.parse(data + 'T12:00:00Z') - dias * 86400e3).toISOString().slice(0, 10)
  const ate = new Date(Date.parse(data + 'T12:00:00Z') + dias * 86400e3).toISOString().slice(0, 10)
  // `fixed_cost_expenses` (assinaturas) não tem coluna `supplier` — o prestador
  // mora em supplier_id. Lá o nome que sobra é o da descrição, e é por ele que
  // se procura; usar 'supplier' ali devolveria erro mudo e o teste diria "não
  // existe" para toda assinatura da casa.
  for (const [t, col, campo] of [
    ['invoice_expenses', 'expense_date', 'supplier'],
    ['staff_expenses', 'expense_date', 'supplier'],
    ['inputs', 'purchase_date', 'supplier'],
    ['fixed_cost_expenses', 'expense_date', 'description'],
  ] as const) {
    for (const nome of nomes) {
      const { data: hit } = await db.from(t).select('id').ilike(campo, `%${nome}%`).gte(col, de).lte(col, ate).limit(1)
      if ((hit || []).length) return true
    }
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
  // O ALVO CHEGA DE DENTRO DE UM JSON GRAVADO NO BANCO, e com NOME DE TABELA nele:
  // ou de `auto_book_mail.cands[].table` (a sugestão que a pessoa clicou ao responder
  // a dúvida), ou de `auto_book_mail_rules.target.table` (a regra aprendida). A
  // migration da onda 2 reescreve `auto_book_mail.booked_table` — a coluna de TEXTO —
  // e não entra em JSON nenhum. Medido pela REST na noite de 11/set/2026, antes dos renames:
  // 6 das 20 linhas da fila guardam 'expenses' dentro de `cands` (9 entradas); regras
  // aprendidas, zero. Sem traduzir, a peneira de destino abaixo recusa a própria
  // sugestão que o robô ofereceu («tabela "expenses" nao e destino de compra») e o
  // lançamento morre na mão de quem respondeu. tabelaAtual() é idempotente.
  const t = tabelaAtual(String(target.table || ''))
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
  else if (t === 'staff_expenses') Object.assign(base, { description: dados.desc, amount: dados.amount, expense_date: dados.date, type: base.type || 'SINGLE' })
  else if (t === 'inputs') Object.assign(base, { description: dados.desc, unit_price: dados.amount, quantity: 1, purchase_date: dados.date })
  else return { erro: `tabela "${t}" nao e destino de compra` }
  const { data, error } = await db.from(t).insert(base).select('id').single()
  if (error) return { erro: error.message }
  return { table: t, id: String((data as { id: string }).id) }
}

const keyOf = (slot: number, m: MailMsg) => `${slot}|${m.received}|${m.fromAddr}|${m.subject.slice(0, 90)}`

// ── DUAS CARTAS DA MESMA COMPRA, UMA PERGUNTA SÓ (Livro 5.9, 11/set/2026) ──
// O `message_key` garante que o MESMO e-mail nunca pergunta duas vezes. Não
// garante nada quando a loja manda DOIS e-mails da mesma compra: a Aeromotive
// mandou a confirmação às 22:37 e o e-mail de boas-vindas às 22:38 de 10/set, e
// nasceram as dúvidas 07142a50 e 3ccf912c, uma ao lado da outra, para uma
// compra só (lançada à mão na US.019.3).
//
// A régua é a do dono: MESMO FORNECEDOR + MESMO VALOR AO CENTAVO, com dúvida
// ABERTA nas últimas 24 horas. Duas travas por cima dela, as duas para o lado
// de perguntar demais, que é o lado barato:
//   • sem valor legível não deduplica — "sem valor" é igual a "sem valor" em
//     compras que não têm nada a ver uma com a outra;
//   • ESTORNO não se confunde com compra. Devolução de US$ 77,67 da mesma loja
//     na mesma semana é outra pergunta ("qual linha ela abate?"), e engoli-la
//     seria silêncio — o único erro que esta fila não pode cometer.
//
// OS TIPOS DE ENTRADA SÃO FROUXOS DE PROPÓSITO: quem chama do banco traz
// `amount` de coluna `numeric` (o PostgREST devolve isso como STRING quando
// quer) e `kind` de coluna `text` livre. Prometer `number` e `AbKind` no
// parâmetro passaria no tsc e mentiria na hora certa — aqui o número é
// convertido e o kind é comparado como texto.
export function chaveDuvida(vendor: string | null | undefined, amount: number | string | null | undefined, kind: string | null | undefined): string | null {
  const v = String(vendor || '').trim().toLowerCase()
  if (!v || amount == null || amount === '') return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  return `${String(kind || '').toUpperCase() === 'REFUND' ? 'REFUND' : 'COMPRA'}|${v}|${n.toFixed(2)}`
}

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
  // ── A ORDEM É A DO RELÓGIO, NÃO A DA CAIXA (11/set/2026, Livro 5.9) ───────
  // O Graph devolve `receivedDateTime desc` (streamMail.server.ts) e o Gmail vem
  // na ordem dele: a carta mais NOVA chegava primeiro no laço. Com a dedução de
  // duas cartas da mesma compra isso decidia QUAL das duas vira a pergunta, e
  // decidia errado — no caso Aeromotive, a de 22:38 ("Thanks for your order!",
  // sem pedido) abriria a dúvida e a de 22:37 ("Order A13706 Confirmed"), a
  // única que carrega o número, seria a calada. Medido linha a linha na fila em
  // 11/set. Aqui a rodada passa a ler na ordem em que as cartas chegaram: a
  // primeira pergunta é a da primeira carta, como está escrito no Livro.
  msgs.sort((a, b) => String(a.received || '').localeCompare(String(b.received || '')))
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
      duplicadas: r.duplicadas.length,
      lancados: r.lancados.length, ja_tem_linha: r.jaTemLinha.length,
      ignorados: r.ignorados.length, duvidas_app: r.duvidasApp.length, sem_recibo: r.semRecibo.length,
      arquivados: r.arquivados.length, sem_pasta: r.semPasta.length,
      achados_no_app: r.achadosNoApp.length, papel_sem_linha: r.papelSemLinha.length,
    },
    caixas: r.caixas, errors: r.erros,
  }).eq('id', id)
}

export async function runAutoBookMail(db: SupabaseClient, horas = 3, trigger = 'cron'): Promise<AutoBookMailResult> {
  const out: AutoBookMailResult = { janela: '', caixas: [], lidos: 0, comDinheiro: 0, jaTemLinha: [], ignorados: [], lancados: [], semRecibo: [], perguntas: [], duplicadas: [], duvidasApp: [], arquivados: [], semPasta: [], achadosNoApp: [], papelSemLinha: [], erros: [] }
  const rodada = await abreRodada(db, horas, trigger)
  const desde = new Date(Date.now() - horas * 3600e3).toISOString()
  out.janela = `desde ${desde}`

  const { data: rulesRaw } = await db.from('auto_book_mail_rules').select('*').eq('active', true)
  const rules = (rulesRaw || []) as AbRule[]
  const conhecidos = await pedidosConhecidos(db)
  const apps = await appsPorDominio(db)
  const dirFornecedores = await diretorioFornecedores(db, out)
  const { data: jaNaFila } = await db.from('auto_book_mail').select('message_key').gte('created_at', new Date(Date.now() - 30 * 86400e3).toISOString())
  const naFila = new Set(((jaNaFila || []) as { message_key: string }[]).map(r => r.message_key))
  // As dúvidas ABERTAS das últimas 24h, pela chave fornecedor+valor — ver
  // `chaveDuvida`. Só DOUBT: dúvida já respondida (BOOKED/IGNORED) não cala a
  // próxima pergunta, porque a resposta dela virou regra ou linha.
  //
  // Guarda o ID e o PEDIDO de cada dúvida aberta, não só a chave: a 2ª carta
  // precisa poder DIZER de quem ela é duplicata, e precisa poder enxertar na
  // dúvida o número de pedido que ela trouxe e a 1ª não tinha. Os tipos vêm
  // frouxos porque o banco é frouxo — `amount` é `numeric` (pode chegar como
  // string) e `kind`/`status` são `text` livre.
  type Aberta = { id: string; order: string | null; question: string | null }
  const { data: abertas } = await db.from('auto_book_mail')
    .select('id, vendor, amount, kind, order_number, question').eq('status', 'DOUBT')
    .gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString())
  const duvidaAberta = new Map<string, Aberta>()
  for (const r of (abertas || []) as { id: string; vendor: string | null; amount: number | string | null; kind: string | null; order_number: string | null; question: string | null }[]) {
    const k = chaveDuvida(r.vendor, r.amount, r.kind)
    if (k && !duvidaAberta.has(k)) duvidaAberta.set(k, { id: String(r.id), order: r.order_number, question: r.question })
  }

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

      // ── O E-MAIL DO PAYPAL É A PERNA DO PAGAMENTO, NÃO A COMPRA ──────────
      // Ele quase nunca traz número de pedido, então não dá para casar por
      // pedido. Se já existe linha desse comerciante por perto da data, o
      // e-mail é o pagamento de algo JÁ lançado e perguntar seria ruído puro.
      // Se não existe NADA dele na janela, aí sim é dinheiro fora do app — foi
      // exatamente assim que o $4,17 do Temu apareceu na conferência à mão.
      // VALE PARA QUALQUER CARTA DO PAYPAL (11/set/2026, Livro 3.6), não só
      // para o recibo de assunto estruturado: era o `pp` aqui que deixava o
      // aviso de envio da HHP passar direto para a fila. E o `vendor` que chega
      // agora é o COMERCIANTE lido do corpo — com "PayPal" este teste nunca
      // achava nada, porque o app não guarda o trilho, guarda o vendedor.
      // **MENOS ESTORNO.** Este portão diz "isto é o pagamento de algo já
      // lançado"; dinheiro VOLTANDO não é pagamento de nada, e a pergunta dele é
      // outra ("qual linha ele abate?"). Sem esta trava, um "we've refunded"
      // do PayPal sem número de pedido sumia calado assim que existisse
      // QUALQUER linha do comerciante em ±6 dias — e com o comerciante lido do
      // corpo isso passou a casar muito mais. Engolir estorno é exatamente o
      // silêncio que a nota da 5.9 promete não cometer.
      if (ehPayPalMsg(msg) && c.kind !== 'REFUND' && !c.orders.length && await temLinhaPorPerto(db, dirFornecedores, vendor, data)) {
        const quanto = c.money ? `${c.money.currency} ${c.money.amount}` : 'sem valor lido'
        out.jaTemLinha.push(`${vendor} ${quanto} — e-mail do PayPal de compra já lançada`)
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
        // ── A MESMA COMPRA JÁ PERGUNTOU HÁ POUCO? (Livro 5.9) ──────────────
        // O lugar do corte é este, e não depois de montar a pergunta: a busca no
        // app acima pode RESOLVER a carta (melhor que calá-la), mas as buscas de
        // papel e de pasta abaixo só montam o TEXTO de uma pergunta que não vai
        // ser feita — e a primeira delas ainda empurrava a carta silenciada para
        // `papelSemLinha`, ruído de relatório sobre pergunta que não existe.
        //
        // CALAR NÃO É SUMIR. A 2ª carta deixa três rastros:
        //   1. o NÚMERO DO PEDIDO, quando ela traz e a dúvida aberta não tem: é
        //      enxertado na dúvida ANTES de calar. Era o defeito de nascença
        //      desta regra — a carta calada era justamente a que trazia o A13706
        //      que este mesmo commit ensinou o robô a ler;
        //   2. a PRÓPRIA LINHA dela em `auto_book_mail`, status DUPLICATE, com o
        //      trecho lido e o id da dúvida que responde por ela. Sem essa linha
        //      o `message_key` não existe, a janela de 3 h relê a carta na
        //      rodada seguinte e — com a 1ª dúvida já respondida (11 de 19 foram
        //      respondidas em ≤3 h, medido em 11/set) — a 2ª pergunta nasce de
        //      novo, uma hora atrasada. Era o defeito inteiro em uma frase;
        //   3. o e-mail SAI da caixa, como sai tudo que o robô resolve.
        const chaveDup = chaveDuvida(vendor, it.amount, c.kind)
        const aberta = chaveDup ? duvidaAberta.get(chaveDup) : undefined
        if (chaveDup && aberta) {
          let enxerto = ''
          if (it.order && !aberta.order) {
            const q = `${aberta.question || ''} · PEDIDO ${it.order} veio na 2a carta ("${msg.subject.slice(0, 50)}"), que e a mesma compra — a pergunta acima nasceu sem ele`.trim()
            // `.eq('status','DOUBT')`: se o dono respondeu a dúvida entre a carga
            // do início da rodada e agora, não se escreve por cima da resposta.
            const { error: eEnx } = await db.from('auto_book_mail')
              .update({ order_number: it.order, question: q.slice(0, 2000), updated_at: new Date().toISOString() })
              .eq('id', aberta.id).eq('status', 'DOUBT')
            if (eEnx) out.erros.push(`enxerto do pedido ${it.order} na duvida ${aberta.id.slice(0, 8)}: ${eEnx.message}`)
            else { aberta.order = it.order; aberta.question = q; enxerto = ` — o pedido ${it.order} foi enxertado na dúvida ${aberta.id.slice(0, 8)}` }
          }
          const { error: eDup } = await db.from('auto_book_mail').insert({
            message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
            from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: it.order,
            currency: it.currency, amount: it.amount, status: 'DUPLICATE', answered_at: new Date().toISOString(),
            question: `2a carta da mesma compra — a duvida ${aberta.id.slice(0, 8)} responde pelas duas${enxerto ? ` (e ficou com o pedido ${it.order})` : ''}`,
            extracted: { label: it.label, strong: it.strong, orders: c.orders, duplicada_de: aberta.id, trecho: msg.text.slice(0, 900) },
          })
          if (eDup) out.erros.push(`duplicada ${vendor}: ${eDup.message}`)
          else naFila.add(chave)
          out.duplicadas.push(`${vendor} ${it.currency} ${it.amount} — "${msg.subject.slice(0, 50)}" é a 2ª carta da mesma compra; a dúvida ${aberta.id.slice(0, 8)} responde pelas duas${enxerto}`)
          if (caixa.podeArquivar && caixa.token) await arquiva(caixa.token, caixa.pastas, msg, vendor, out)
          continue
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
        const { data: nova, error } = await db.from('auto_book_mail').insert({
          message_key: chave, slot: caixa.slot, account: auth.account, received_at: msg.received,
          from_addr: msg.fromAddr, subject: msg.subject, kind: c.kind, vendor, order_number: it.order,
          currency: it.currency, amount: it.amount, question, cands,
          extracted: { label: it.label, strong: it.strong, orders: c.orders, totais, trecho: msg.text.slice(0, 900) },
        }).select('id').single()
        if (error) { out.erros.push(`fila ${vendor}: ${error.message}`); continue }
        naFila.add(chave)
        // A carta de 22:38 tem de ver a pergunta que a de 22:37 acabou de
        // abrir: as duas chegam na MESMA rodada, e sem esta linha a dedução só
        // valeria na rodada seguinte — quando as duas dúvidas já existem. O id
        // vem de volta do insert porque a 2ª carta precisa DIZER de quem ela é
        // duplicata, e enxertar o pedido nesta mesma linha se for o caso.
        if (chaveDup && nova) duvidaAberta.set(chaveDup, { id: String((nova as { id: string }).id), order: it.order, question })
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
