// ════════════════════════════════════════════════════════════════════════════
// lib/estorno.ts · 14/set/2026 — LINHA ESTORNADA FICA NA INVOICE E SAI DO DINHEIRO (MÓDULO PURO)
//
// DECISÃO DO DONO (Márcio, 14/09/2026), sobre o pedido HHP 382526 — cobrado na Regions em 13/08 (US$ 5.349,65) e estornado
// inteiro em 19/08 (PayPal 1HY11455CN7150914) —, cujas peças continuam na shopping invoice 006.27:
//   «deixe nas invoices como estornado, e faça os controles financeiros.»
// A linha FICA na lista, visível e marcada (chip + valor riscado); o dinheiro dela SAI de toda conta: total da invoice,
// custo, markup, pending balance, DRE, DFC, Balanço, conta corrente US ⇄ BR, placar do fechamento e relatórios.
//
// O CAMPO: cancel_status (null | CANCELLED | REFUNDED), o mesmo das 6 tabelas de item comprado (lib/deliverStatus.ts). Desde
// MIGRATION_invoice_items_cancel_status.sql, invoice_items também tem: é a linha que COBRA o cliente.
// CANCELLED entra junto com REFUNDED (ordem de 14/09): compra cancelada não é custo nem venda, mesmo com o dinheiro ainda na
// mão do vendedor.
//
// A ARMADILHA: A LEI 8.10 DO AUTOBOOK (lib/autoBookLivro.ts). «Estorno é uma linha NEGATIVA espelhando a original — mesmo
// pedido, mesmo comprovante, mesma categoria —, com a data do e-mail do estorno. A linha original nunca é editada para baixo.»
// E o robô do e-mail (lib/mailToItem.server.ts) carimba REFUNDED na linha ORIGINAL quando o vendedor afirma o estorno. Então
// um estorno aparece no banco de DOIS jeitos, e os dois existem hoje (medido em 14/09, só leitura):
//   (a) SÓ O CARIMBO — a original com cancel_status e nenhuma linha negativa: 006.27 (HHP 382526, 4 despesas); assets
//       Harbor Freight 129168 (US$ 63,89); inputs Amazon 111-2300452-3523426 (US$ 10,63); inputs Harbor Freight 0318353
//       (US$ 107,49, CANCELLED). Aqui o carimbo É o estorno: a linha sai da conta.
//   (b) A NEGATIVA LANÇADA — US.008.2 Texas Speed (duas originais REFUNDED de US$ 8.534,14 e 8.032,48 com tax/extra, e duas
//       negativas SEM pedido e SEM carimbo do mesmo valor); US.014.1 AutoZone 1585884 (+111,29 e −111,29, as duas REFUNDED);
//       inputs Temu PO-211-09539381883512437 (+25,96 REFUNDED e −8,38 REFUNDED — estorno PARCIAL) e PO-211-12975478892152437
//       (27,30 viva e −1,37 REFUNDED). Aqui o dinheiro de volta JÁ está numa linha: tirar a original contaria o estorno duas
//       vezes (a US.008.2 ficaria com custo −US$ 16.566,62).
//
// A RÉGUA — respeita os dois jeitos, e nenhum número que já estava certo muda:
//   1. linha NEGATIVA (ou zero) sempre conta: ela é o dinheiro voltando, com carimbo ou sem;
//   2. linha positiva sem cancel_status conta;
//   3. linha positiva COM cancel_status conta só se o estorno dela já foi lançado em linha negativa:
//        · do MESMO PEDIDO (order_number), em qualquer lugar da lista recebida — a lei 8.10; vale para o pedido inteiro,
//          estorno parcial incluído (o parcial fica certo porque a original conta e a negativa desconta só a parte);
//        · ou, dentro do MESMO GRUPO (a invoice), uma negativa SEM pedido de valor igual ao centavo, uma para uma — o legado
//          da Texas Speed. Sem grupo (tabelas soltas: inputs, assets…) só vale o pedido: valor igual numa tabela inteira é
//          coincidência, não prova;
//   4. o resto — cancelada/estornada sem a negativa — NÃO conta. Continua na tela, riscada.
// Quando o estorno de um (a) cair e virar negativa pela 8.10, a original volta a contar e as duas se anulam: o total não pula.
//
// LIMITE DECLARADO: a régua enxerga só as linhas que recebe. Tela de UMA invoice não vê negativa do mesmo pedido lançada em
// OUTRA invoice (a 8.10 manda lançar na mesma categoria, então é raro); as demonstrações, que leem a tabela inteira, veem.
//
// PURO de propósito (sem banco, sem rede, sem React): tela, rota, motor da travessia e demonstrações têm de responder a mesma
// coisa, e o jeito de garantir isso é ninguém mais decidir "conta ou não conta" em lugar nenhum.
import { normCancelStatus, type CancelStatus } from './deliverStatus'

export type Estornavel = { cancel_status?: string | null; order_number?: string | null }

/** O carimbo normalizado da linha (null = compra/linha viva). */
export const cancelOf = (row: Estornavel | null | undefined): CancelStatus | null => normCancelStatus(row?.cancel_status)
/** A linha carrega CANCELLED ou REFUNDED? (só o carimbo — quem decide se o dinheiro sai é foraDoDinheiro) */
export const isCancelled = (row: Estornavel | null | undefined): boolean => cancelOf(row) !== null

const CENTAVO = 0.005
const pedidoDe = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '')

/**
 * As linhas que NÃO contam dinheiro (a régua acima). Devolve o conjunto dos PRÓPRIOS objetos recebidos.
 * @param valor  o dinheiro da linha, com sinal (despesa: preço × qtd + tax + extra; item: unit_price × qtd)
 * @param grupo  onde a negativa sem pedido pode casar por valor (a invoice). Omitido = só casa por pedido.
 */
export function foraDoDinheiro<T extends Estornavel>(rows: readonly T[], valor: (r: T) => number, grupo?: (r: T) => unknown): Set<T> {
  const fora = new Set<T>()
  if (!rows.some(isCancelled)) return fora
  const negativas = rows.filter(r => valor(r) < -CENTAVO)
  const pedidosEstornados = new Set(negativas.map(n => pedidoDe(n.order_number)).filter(Boolean))
  // Negativas sem pedido, por grupo — cada uma cobre UMA original de valor igual.
  const soltas = new Map<string, T[]>()
  if (grupo) for (const n of negativas) {
    const k = String(grupo(n) ?? '')
    if (!k || pedidoDe(n.order_number)) continue
    const a = soltas.get(k); if (a) a.push(n); else soltas.set(k, [n])
  }
  for (const r of rows) {
    if (!isCancelled(r)) continue
    const v = valor(r)
    if (v <= CENTAVO) continue                                   // 1. negativa (ou zero): é o dinheiro voltando
    const p = pedidoDe(r.order_number)
    if (p && pedidosEstornados.has(p)) continue                  // 3. estorno do pedido já lançado (lei 8.10)
    const lista = grupo ? soltas.get(String(grupo(r) ?? '')) : undefined
    const i = lista ? lista.findIndex(n => Math.abs(valor(n) + v) < CENTAVO) : -1
    if (lista && i >= 0) { lista.splice(i, 1); continue }       // 3. negativa sem pedido, mesmo valor, mesma invoice
    fora.add(r)                                                  // 4. estornada sem a negativa: sai do dinheiro
  }
  return fora
}

/** As linhas que contam dinheiro — a mesma régua, pelo outro lado. */
export function soOQueConta<T extends Estornavel>(rows: readonly T[], valor: (r: T) => number, grupo?: (r: T) => unknown): T[] {
  const fora = foraDoDinheiro(rows, valor, grupo)
  return fora.size ? rows.filter(r => !fora.has(r)) : [...rows]
}

// As duas contas de linha que o app inteiro usa (as mesmas de lib/financials.ts expLine / qtyLine). Moram aqui também
// porque lib/financials.ts é 'use client' e o servidor não pode importá-lo.
const n = (v: unknown) => parseFloat(String(v ?? '')) || 0
/** invoice_expenses: preço × qtd + tax + extra */
export const valorDespesa = (e: { price?: unknown; amount?: unknown; quantity?: unknown; tax?: unknown; extra?: unknown }) =>
  n(e.price ?? e.amount) * (n(e.quantity) || 1) + n(e.tax) + n(e.extra)
/** invoice_items / inputs / assets / inventory: unit_price × qtd */
export const valorItem = (i: { unit_price?: unknown; quantity?: unknown }) => n(i.unit_price) * (n(i.quantity) || 1)
