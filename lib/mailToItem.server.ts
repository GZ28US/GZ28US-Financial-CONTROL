// SERVER-ONLY — O E-MAIL ALIMENTA A LINHA DO ITEM.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 30/ago/2026) ───────────────────────
// Na batida de 30/ago o STREAM legado morreu inteiro — e junto com ele morreu a
// ÚNICA ponte entre a caixa de e-mail e o rastreio dos itens. O que ficou no
// lugar, /api/items/track, só pergunta à transportadora por números QUE JÁ
// ESTÃO na linha; ela não lê e-mail nenhum.
//
// Só que o e-mail continua sendo a única fonte de duas coisas:
//   • o rastreio NOVO  — quem manda é a transportadora, ninguém digita à mão;
//   • a ENTREGA        — em marketplace o "delivered" chega no e-mail antes de
//                        aparecer no 17TRACK (e às vezes é o único aviso).
//
// Sem esta ponte o robô do rastreio nunca começa: ele não tem número para
// perguntar. Medido nas rodadas de 29 e 30/ago, tudo isto passou pela caixa e
// não chegou a linha nenhuma: os rastreios do Temu (GOFO, SwiftX, SpeedX), o
// PBF39521864 do pedido HHP 382529, e a entrega do sensor de etanol do Dracula.
//
// ── O QUE ELE FAZ, EM UMA FRASE ────────────────────────────────────────────
// Lê as 4 caixas, casa o e-mail com a linha do item pelo NÚMERO DO PEDIDO, e
// escreve na própria linha o que o e-mail disse — nada além disso.
//
// ── O QUE ELE NUNCA FAZ ────────────────────────────────────────────────────
//   • NUNCA escreve status. Status é derivação desde 30/ago (deliverStatus.ts).
//     Aqui só entram FATOS: tracking_number, carrier, delivered_at.
//   • NUNCA sobrescreve rastreio que já existe. O primeiro que chegou vale; um
//     segundo e-mail com outro número vira dúvida, não escrita.
//   • NUNCA desfaz entrega. delivered_at gravado não se apaga.
//   • NUNCA toca em linha com picked_up — balcão não viaja.
//   • NUNCA escreve estorno. Reembolso mexe em dinheiro e vira DÚVIDA para o
//     dono decidir; o campo cancel_status não se preenche sozinho.
//
// ── POR QUE O DICIONÁRIO VEM DO BANCO, E NÃO DE REGEX ──────────────────────
// A tentação é achar o número do pedido no texto com um padrão. Não dá: os
// formatos da casa vão de "382872" a "PO-211-0129302526015", passando por
// "25-15048-33740" e "111-2300452-3523426" — um padrão largo o bastante para
// pegar todos pega também telefone, nota fiscal e pedaço de valor.
// Aqui é o contrário: a lista de números vem das LINHAS que já existem, e o
// e-mail só é aceito se contiver um deles. Falso positivo fica impossível por
// construção — o número tem de existir no banco antes de casar.
// (Custou caro aprender: em 30/ago um filtro largo meu moveu 50 e-mails de
// pastas certas para a pasta errada porque "eBay Commerce Inc" casava com tudo.)

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getMailAuth, freshAccessToken, fetchRecentMessages, fetchRecentGmail,
  extractTrackings, carrierFromText, isPurchaseConfirmation, type MailMsg,
} from './streamMail.server'
import { ITEM_TABLES, type ItemTable } from './itemTracking.server'

// Número de pedido curto demais casa com qualquer coisa ("3440" está dentro de
// um CEP, de um valor, de um id). Cinco caracteres é o piso: abaixo disso o
// pedido não entra no dicionário e o e-mail dele passa batido — de propósito.
const MIN_PEDIDO = 5

// A entrega dita pelo e-mail. Deliberadamente curta e literal: "delivery" solto
// fica de fora porque "Estimated delivery" aparece em todo e-mail de compra e
// carimbaria entrega no dia em que o pedido foi feito.
const ENTREGOU = /\b(was|has been|have been|is|were)\s+delivered\b|\bdelivered\s*[:！!]|\border\s+delivered\b|\bpackage\s+(?:was\s+)?delivered\b|\bentregue\b|\bfoi\s+entregue\b|\bdropped off\b/i

// Reembolso — NÃO se escreve, só se aponta.
const ESTORNO = /\brefund(ed)?\b|\breembolso\b|\bestorn(o|ado)\b|\bmoney back\b/i

type Linha = { tabela: ItemTable; id: string; order_number: string; supplier: string | null; tracking_number: string | null; carrier: string | null; delivered_at: string | null }

export type MailToItemResult = {
  varridas: number                 // e-mails lidos
  rastreios: string[]              // linhas que ganharam tracking
  entregas: string[]               // linhas que ganharam delivered_at
  duvidas: string[]                // o que precisa de gente
  caixas: string[]
  error?: string
}

// Toda escrita deixa rastro, igual ao robô do 17TRACK. Se data_fixes não
// existir, a escrita acontece assim mesmo e a dúvida registra a falta.
async function logFix(db: SupabaseClient, tabela: string, rowId: string, campo: string, antes: unknown, depois: unknown): Promise<boolean> {
  const { error } = await db.from('data_fixes').insert({
    check_key: 'mail-to-item',
    table_name: tabela,
    row_id: rowId,
    field: campo,
    old_value: antes == null ? null : String(antes),
    new_value: depois == null ? null : String(depois),
    label: 'E-MAIL → ITEM — o e-mail da transportadora escreveu na própria linha (só fatos: nunca status, que é derivado)',
  })
  return !error
}

// O dicionário: toda linha de item comprado que tem número de pedido e ainda
// não está resolvida. Linha entregue não volta; linha de balcão não viaja.
async function carregarLinhas(db: SupabaseClient): Promise<Map<string, Linha[]>> {
  const porPedido = new Map<string, Linha[]>()
  for (const tabela of ITEM_TABLES) {
    const { data } = await db.from(tabela)
      .select('id, order_number, supplier, tracking_number, carrier, delivered_at, picked_up')
      .not('order_number', 'is', null)
      .is('delivered_at', null)
    for (const r of (data || []) as any[]) {
      if (r.picked_up) continue
      const pedido = String(r.order_number || '').trim()
      if (pedido.length < MIN_PEDIDO) continue
      const arr = porPedido.get(pedido) || []
      arr.push({ tabela, id: r.id, order_number: pedido, supplier: r.supplier ?? null, tracking_number: r.tracking_number ?? null, carrier: r.carrier ?? null, delivered_at: r.delivered_at ?? null })
      porPedido.set(pedido, arr)
    }
  }
  return porPedido
}

// Casa por conteúdo, com fronteira: o número tem de aparecer inteiro, não como
// pedaço de outro número. "382872" não pode casar dentro de "1382872".
function pedidosNoTexto(texto: string, dicionario: Map<string, Linha[]>): string[] {
  const achados: string[] = []
  for (const pedido of dicionario.keys()) {
    const i = texto.indexOf(pedido)
    if (i < 0) continue
    const antes = texto[i - 1] || ' '
    const depois = texto[i + pedido.length] || ' '
    if (/[0-9A-Za-z]/.test(antes) || /[0-9A-Za-z]/.test(depois)) continue
    achados.push(pedido)
  }
  return achados
}

async function lerCaixa(db: SupabaseClient, slot: number, desde: string): Promise<{ nome: string; msgs: MailMsg[] }> {
  const auth = await getMailAuth(db, slot)
  if (!auth?.refresh_token) return { nome: 'slot' + slot + ':sem-conta', msgs: [] }
  const token = await freshAccessToken(db, auth)
  if (!token) return { nome: (auth.account || 'slot' + slot) + ':sem-token', msgs: [] }
  const msgs = slot === 4 ? await fetchRecentGmail(token, desde) : await fetchRecentMessages(token, desde)
  return { nome: (auth.account || 'slot' + slot) + ':' + msgs.length, msgs }
}

export async function runMailToItem(db: SupabaseClient, dias = 3): Promise<MailToItemResult> {
  const out: MailToItemResult = { varridas: 0, rastreios: [], entregas: [], duvidas: [], caixas: [] }
  const dicionario = await carregarLinhas(db)
  if (!dicionario.size) return out

  const desde = new Date(Date.now() - dias * 86400e3).toISOString()

  for (const slot of [1, 2, 3, 4]) {
    let caixa: { nome: string; msgs: MailMsg[] }
    try { caixa = await lerCaixa(db, slot, desde) } catch (e) { out.caixas.push('slot' + slot + ':erro'); continue }
    out.caixas.push(caixa.nome)

    for (const msg of caixa.msgs) {
      const texto = `${msg.subject} ${msg.text}`
      const pedidos = pedidosNoTexto(texto, dicionario)
      if (!pedidos.length) continue
      out.varridas++

      const entregou = ENTREGOU.test(texto)
      // Confirmação de compra nunca carrega rastreio confiável — foi assim que
      // o Item ID do eBay carimbou SHIPPED no ato da compra (25-14968-48374).
      const podeRastrear = !isPurchaseConfirmation(msg)
      const numeros = podeRastrear ? extractTrackings(texto) : []
      const transportadora = carrierFromText(texto)

      if (ESTORNO.test(texto)) {
        for (const p of pedidos) out.duvidas.push(`ESTORNO citado no pedido ${p} — "${msg.subject.slice(0, 60)}" (não escrevi: reembolso é decisão do dono)`)
      }
      if (!numeros.length && !entregou) continue

      for (const pedido of pedidos) {
        for (const linha of (dicionario.get(pedido) || [])) {
          const onde = `${linha.tabela}:${pedido}`

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

          if (entregou && !linha.delivered_at) {
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
