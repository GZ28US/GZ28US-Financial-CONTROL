// SERVER-ONLY — O E-MAIL ALIMENTA A LINHA DO ITEM.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 30/ago/2026) ───────────────────────
// Na batida de 30/ago o STREAM legado morreu inteiro, e com ele as ÚNICAS
// pontes entre a caixa de e-mail e o resto do app. O que ficou no lugar,
// /api/items/track, só pergunta à transportadora por números QUE JÁ ESTÃO na
// linha; ela não lê e-mail nenhum.
//
// Só que o e-mail continua sendo a única fonte de três coisas:
//   • o rastreio NOVO  — quem manda é a transportadora, ninguém digita à mão;
//   • a ENTREGA        — em marketplace o "delivered" chega antes do 17TRACK;
//   • o ESTORNO        — o reembolso só aparece no e-mail do vendedor.
// E de uma quarta que NÃO se resolve sozinha: a COMPRA NOVA, que chega por
// e-mail antes de existir linha nenhuma para ela.
//
// Sem a primeira ponte o robô do rastreio nunca começa: ele não tem número para
// perguntar. Medido nas rodadas de 29-30/ago, tudo isto passou pela caixa e não
// chegou a linha nenhuma: os rastreios do Temu (GOFO, SwiftX, SpeedX), o
// PBF39521864 do pedido HHP 382529, e a entrega do sensor de etanol do Dracula.
//
// ── O QUE ELE FAZ ──────────────────────────────────────────────────────────
//   1. RASTREIO  — casa o e-mail com a linha pelo número do pedido e grava
//                  tracking_number + carrier NA PRÓPRIA LINHA.
//   2. ENTREGA   — o e-mail que diz "delivered" grava delivered_at.
//   3. ESTORNO   — o e-mail em que o VENDEDOR diz que reembolsou grava
//                  cancel_status = 'REFUNDED'. É fato dele, não decisão nossa.
//   4. COMPRA    — pedido que aparece no e-mail e não casa com linha nenhuma
//                  vira AVISO, nunca linha. Em que carro entra é decisão de
//                  gente, e chutar isso é pior que não fazer.
//
// ── O QUE ELE NUNCA FAZ ────────────────────────────────────────────────────
//   • NUNCA escreve status. Status é derivação desde 30/ago (deliverStatus.ts).
//     Aqui só entram FATOS: tracking_number, carrier, delivered_at, cancel_status.
//   • NUNCA sobrescreve rastreio que já existe. O primeiro que chegou vale; um
//     segundo e-mail com outro número vira dúvida, não escrita.
//   • NUNCA desfaz entrega nem estorno já gravados.
//   • NUNCA toca em linha com picked_up — balcão não viaja.
//   • NUNCA cria linha de item. Ver item 4 acima.
//
// ── POR QUE O DICIONÁRIO VEM DO BANCO, E NÃO DE REGEX ──────────────────────
// A tentação é achar o número do pedido no texto com um padrão. Não dá: os
// formatos da casa vão de "382872" a "PO-211-0129302526015", passando por
// "25-15048-33740" e "111-2300452-3523426" — um padrão largo o bastante para
// pegar todos pega também telefone, nota fiscal e pedaço de valor.
// Aqui é o contrário: a lista de números vem das LINHAS que já existem, e o
// e-mail só casa se contiver um deles. Falso positivo fica impossível por
// construção — o número tem de existir no banco antes de casar.
// (Custou caro aprender: em 30/ago um filtro largo meu moveu 50 e-mails de
// pastas certas para a errada porque "eBay Commerce Inc" casava com tudo.)
// O padrão só aparece no item 4, onde o resultado é um AVISO e o custo de um
// falso positivo é uma linha de ruído, não dado corrompido — e mesmo lá cada
// formato exige a palavra "order/pedido" colada.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getMailAuth, freshAccessToken, fetchRecentMessages, fetchRecentGmail,
  extractTrackings, carrierFromText, isPurchaseConfirmation, type MailMsg,
} from './streamMail.server'
import { gmailAccessToken } from './appsMail.server'
import { ITEM_TABLES, type ItemTable } from './itemTracking.server'

// Número de pedido curto demais casa com qualquer coisa ("3440" está dentro de
// um CEP, de um valor, de um id). Cinco caracteres é o piso: abaixo disso o
// pedido não entra no dicionário e o e-mail dele passa batido — de propósito.
const MIN_PEDIDO = 5

// A entrega dita pelo e-mail. Deliberadamente curta e literal: "delivery" solto
// fica de fora porque "Estimated delivery" aparece em todo e-mail de compra e
// carimbaria entrega no dia em que o pedido foi feito.
const ENTREGOU = /\b(was|has been|have been|is|were)\s+delivered\b|\bdelivered\s*[:！!]|\border\s+delivered\b|\bpackage\s+(?:was\s+)?delivered\b|\bentregue\b|\bfoi\s+entregue\b|\bdropped off\b/i

// O ESTORNO tem de ser afirmado pelo VENDEDOR no passado. "refund policy",
// "request a refund" e "eligible for refund" são conversa, não dinheiro de
// volta — e carimbariam REFUNDED numa compra viva.
const ESTORNOU = /\b(refund(?:ed)?\s+(?:was|has been|is)\s+issued|your refund was issued|we(?:'ve| have)\s+refunded|has been refunded|was refunded|refund(?:ed)?\s+to your|cancelled and refunded)\b|\breembolso (?:foi )?(?:emitido|processado|efetuado)\b|\bestornad[oa]\b/i

// Só se fala em compra NOVA quando o e-mail traz a palavra do pedido colada ao
// número. Formatos que a casa usa de verdade — nada genérico.
const PEDIDO_NOVO = [
  /\border\s*(?:number|#|no\.?)?\s*[:#]?\s*(\d{2}-\d{5}-\d{5})\b/gi,        // eBay
  /\border\s*(?:number|#|no\.?)?\s*[:#]?\s*(\d{3}-\d{7}-\d{7})\b/gi,        // Amazon
  /\border\s*(?:id|number|#|no\.?)?\s*[:#]?\s*(PO-\d{3}-\d{10,20})\b/gi,     // Temu
  /\border\s*(?:number|#|no\.?)?\s*[:#]?\s*#?(\d{6,7})\b/gi,                 // HHP / HP Tuners
  /\bpedido\s*(?:n[ºo°]|#)?\s*[:#]?\s*(\d{5,})\b/gi,                          // lojas BR
]

type Linha = { tabela: ItemTable; id: string; order_number: string; tracking_number: string | null; carrier: string | null; delivered_at: string | null; cancel_status: string | null }

export type MailToItemResult = {
  varridas: number                 // e-mails que casaram com algum pedido
  rastreios: string[]              // linhas que ganharam tracking
  entregas: string[]               // linhas que ganharam delivered_at
  estornos: string[]               // linhas que ganharam cancel_status REFUNDED
  semLinha: string[]               // compra vista no e-mail e sem linha no app
  duvidas: string[]                // o que precisa de gente
  caixas: string[]
}

// Toda escrita deixa rastro, igual ao robô do 17TRACK. Se data_fixes não
// existir, a escrita acontece assim mesmo e o retorno avisa a falta.
async function logFix(db: SupabaseClient, tabela: string, rowId: string, campo: string, antes: unknown, depois: unknown): Promise<boolean> {
  const { error } = await db.from('data_fixes').insert({
    check_key: 'mail-to-item',
    table_name: tabela,
    row_id: rowId,
    field: campo,
    old_value: antes == null ? null : String(antes),
    new_value: depois == null ? null : String(depois),
    label: 'E-MAIL → ITEM — o e-mail do vendedor/transportadora escreveu na própria linha (só fatos: nunca status, que é derivado)',
  })
  return !error
}

// O dicionário: toda linha de item comprado que tem número de pedido e ainda
// não está resolvida. Linha entregue não volta; linha de balcão não viaja.
async function carregarLinhas(db: SupabaseClient): Promise<Map<string, Linha[]>> {
  const porPedido = new Map<string, Linha[]>()
  for (const tabela of ITEM_TABLES) {
    const { data } = await db.from(tabela)
      .select('id, order_number, tracking_number, carrier, delivered_at, cancel_status, picked_up')
      .not('order_number', 'is', null)
    for (const r of (data || []) as any[]) {
      if (r.picked_up) continue
      const pedido = String(r.order_number || '').trim()
      if (pedido.length < MIN_PEDIDO) continue
      const arr = porPedido.get(pedido) || []
      arr.push({ tabela, id: r.id, order_number: pedido, tracking_number: r.tracking_number ?? null, carrier: r.carrier ?? null, delivered_at: r.delivered_at ?? null, cancel_status: r.cancel_status ?? null })
      porPedido.set(pedido, arr)
    }
  }
  return porPedido
}

// Casa por conteúdo, com fronteira: o número tem de aparecer inteiro, não como
// pedaço de outro. "382872" não pode casar dentro de "1382872".
function pedidosNoTexto(texto: string, dicionario: Map<string, Linha[]>): string[] {
  const achados: string[] = []
  for (const pedido of dicionario.keys()) {
    const i = texto.indexOf(pedido)
    if (i < 0) continue
    if (/[0-9A-Za-z]/.test(texto[i - 1] || ' ')) continue
    if (/[0-9A-Za-z]/.test(texto[i + pedido.length] || ' ')) continue
    achados.push(pedido)
  }
  return achados
}

// Slot 4 fala Google, os outros três falam Graph. Usar a função errada devolve
// token nulo e a caixa inteira some da varredura sem erro nenhum — foi o que
// aconteceu na primeira versão deste arquivo (31/ago), e a caixa que sumiu é
// justamente onde a Amazon manda nota de embarque.
async function lerCaixa(db: SupabaseClient, slot: number, desde: string): Promise<{ nome: string; msgs: MailMsg[] }> {
  if (slot === 4) {
    const token = await gmailAccessToken(db)
    if (!token) return { nome: 'gz28us@gmail.com:sem-token', msgs: [] }
    const msgs = await fetchRecentGmail(token, desde)
    return { nome: 'gz28us@gmail.com:' + msgs.length, msgs }
  }
  const auth = await getMailAuth(db, slot)
  if (!auth?.refresh_token) return { nome: 'slot' + slot + ':sem-conta', msgs: [] }
  const token = await freshAccessToken(db, auth)
  if (!token) return { nome: (auth.account || 'slot' + slot) + ':sem-token', msgs: [] }
  const msgs = await fetchRecentMessages(token, desde)
  return { nome: (auth.account || 'slot' + slot) + ':' + msgs.length, msgs }
}

export async function runMailToItem(db: SupabaseClient, dias = 3): Promise<MailToItemResult> {
  const out: MailToItemResult = { varridas: 0, rastreios: [], entregas: [], estornos: [], semLinha: [], duvidas: [], caixas: [] }
  const dicionario = await carregarLinhas(db)
  if (!dicionario.size) return out

  const desde = new Date(Date.now() - dias * 86400e3).toISOString()
  const jaAvisado = new Set<string>()

  for (const slot of [1, 2, 3, 4]) {
    let caixa: { nome: string; msgs: MailMsg[] }
    try { caixa = await lerCaixa(db, slot, desde) } catch { out.caixas.push('slot' + slot + ':erro'); continue }
    out.caixas.push(caixa.nome)

    for (const msg of caixa.msgs) {
      const texto = `${msg.subject} ${msg.text}`
      const pedidos = pedidosNoTexto(texto, dicionario)

      // ── 4. COMPRA SEM LINHA: só quando o e-mail não casou com nada ────────
      if (!pedidos.length) {
        for (const re of PEDIDO_NOVO) {
          for (const m of texto.matchAll(re)) {
            const n = m[1]
            if (dicionario.has(n) || jaAvisado.has(n)) continue
            jaAvisado.add(n)
            out.semLinha.push(`${n} — "${msg.subject.slice(0, 60)}" (${msg.fromAddr}) — comprado e sem linha no app`)
          }
        }
        continue
      }
      out.varridas++

      const entregou = ENTREGOU.test(texto)
      const estornou = ESTORNOU.test(texto)
      // Confirmação de compra nunca carrega rastreio confiável — foi assim que
      // o Item ID do eBay carimbou SHIPPED no ato da compra (25-14968-48374).
      const numeros = isPurchaseConfirmation(msg) ? [] : extractTrackings(texto)
      const transportadora = carrierFromText(texto)
      if (!numeros.length && !entregou && !estornou) continue

      for (const pedido of pedidos) {
        for (const linha of (dicionario.get(pedido) || [])) {
          const onde = `${linha.tabela}:${pedido}`

          // ── 3. ESTORNO — passa por cima de tudo, então vem primeiro ───────
          if (estornou && !linha.cancel_status) {
            const { error } = await db.from(linha.tabela).update({ cancel_status: 'REFUNDED' }).eq('id', linha.id)
            if (error) { out.duvidas.push(`${onde} — falhou ao gravar estorno: ${error.message}`); continue }
            linha.cancel_status = 'REFUNDED'
            const logado = await logFix(db, linha.tabela, linha.id, 'cancel_status', null, 'REFUNDED')
            out.estornos.push(`${onde} REFUNDED — "${msg.subject.slice(0, 50)}"${logado ? '' : ' [sem rastro em data_fixes]'}`)
          }
          if (linha.cancel_status || linha.delivered_at) continue

          // ── 1. RASTREIO ──────────────────────────────────────────────────
          if (numeros.length) {
            if (linha.tracking_number) {
              if (!numeros.includes(linha.tracking_number)) out.duvidas.push(`${onde} já tem rastreio ${linha.tracking_number} e o e-mail traz ${numeros.join(', ')} — não sobrescrevi`)
            } else if (numeros.length > 1) {
              out.duvidas.push(`${onde} — o e-mail traz ${numeros.length} rastreios (${numeros.join(', ')}); não dá para saber qual é o desta linha`)
            } else {
              const patch: Record<string, unknown> = { tracking_number: numeros[0] }
              if (transportadora && !linha.carrier) patch.carrier = transportadora
              const { error } = await db.from(linha.tabela).update(patch).eq('id', linha.id)
              if (error) { out.duvidas.push(`${onde} — falhou ao gravar rastreio: ${error.message}`); continue }
              linha.tracking_number = numeros[0]
              const logado = await logFix(db, linha.tabela, linha.id, 'tracking_number', null, numeros[0])
              out.rastreios.push(`${onde} ← ${numeros[0]}${transportadora ? ' (' + transportadora + ')' : ''}${logado ? '' : ' [sem rastro em data_fixes]'}`)
            }
          }

          // ── 2. ENTREGA ───────────────────────────────────────────────────
          if (entregou) {
            const quando = msg.received || new Date().toISOString()
            const { error } = await db.from(linha.tabela).update({ delivered_at: quando }).eq('id', linha.id)
            if (error) { out.duvidas.push(`${onde} — falhou ao gravar entrega: ${error.message}`); continue }
            linha.delivered_at = quando
            const logado = await logFix(db, linha.tabela, linha.id, 'delivered_at', null, quando)
            out.entregas.push(`${onde} entregue em ${quando.slice(0, 10)}${logado ? '' : ' [sem rastro em data_fixes]'}`)
          }
        }
      }
    }
  }
  return out
}
