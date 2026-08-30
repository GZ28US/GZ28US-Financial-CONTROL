// ── DE ONDE SAI O DELIVER STATUS DE UMA COMPRA ESCANEADA ────────────────────
// Regra ditada por Márcio em 29/ago/2026, palavra por palavra:
//
//   "Amazon nunca vai ser pickup. Walmart pode ser das 2 formas: a partir do
//    escaneamento da invoice, se tiver endereco de entrega e nota de compra a
//    ser entregue; se nao tiver endereco, e compra de balcao, PickUp."
//
// Ou seja: quem decide não é o palpite sobre a loja, é o DOCUMENTO. O scan
// devolve o endereço de entrega quando ele está impresso na nota; sem endereço,
// numa loja que TEM balcão, a compra foi pega na mão — PICKUP, e o app não deve
// rastrear essa linha. Com endereço, é entrega: BOUGHT (e SHIPPED se o próprio
// documento já trouxe o rastreio).
//
// Este módulo é puro (sem banco, sem rede) de propósito: as duas pontas que
// gravam a partir de um scan — a tela e o robô — têm de responder igual.

// LOJA SEM BALCÃO: marketplace/e-commerce puro. Ele foi explícito ("Amazon
// nunca vai ser pickup"), e a lista segue o mesmo princípio: não existe balcão
// onde retirar. Casa por SUBSTRING, minúsculo, no nome do fornecedor.
const ONLINE_ONLY = [
  'amazon', 'temu', 'ebay', 'aliexpress', 'mercado livre', 'mercadolivre',
  'mercado pago', 'mercadopago', 'rockauto', 'carid', 'summit', 'bestbuy.com',
  'zanvis', 'pneustore', 'autozonepro',
]

// LOJA COM BALCÃO (inclui as HÍBRIDAS, que vendem no balcão E entregam). É nesta
// lista que a regra do endereço decide. Quem não está em lista nenhuma cai no
// padrão seguro: BOUGHT (pago, sem rastreio) — nunca se inventa um PICKUP.
const COUNTER_STORES = [
  'walmart', 'autozone', "o'reilly", 'oreilly', 'advance auto', 'napa',
  'harbor freight', 'ace hardware', 'home depot', 'lowe', 'sam’s club', "sam's club",
  'costco', 'aldi', 'publix', 'target', 'best buy', 'kmart', 'k-mart', 'ross',
  'marshalls', 'homegoods', 'walgreens', 'cvs', 'dollar', 'skycraft',
  'racetrac', 'wawa', '7-eleven', 'seven eleven', 'texaco', 'shell', 'bp ',
  'pilot', 'circle k', 'gas station', 'posto',
]

const has = (list: string[], supplier: string) => {
  const s = String(supplier || '').toLowerCase()
  return !!s && list.some(k => s.includes(k))
}

export const isOnlineOnlySupplier = (supplier: string) => has(ONLINE_ONLY, supplier)
export const isCounterStore = (supplier: string) => !has(ONLINE_ONLY, supplier) && has(COUNTER_STORES, supplier)

// A decisão, na ordem em que ela se lê:
//   1. veio rastreio no documento          → SHIPPED (já está viajando)
//   2. loja sem balcão                     → BOUGHT  ("Amazon nunca vai ser pickup")
//   3. a nota traz ENDEREÇO DE ENTREGA     → BOUGHT  (é entrega, não balcão)
//   4. loja com balcão e sem endereço      → PICKUP  (peguei na mão)
//   5. o resto                             → BOUGHT
// Compra NÃO PAGA não chega aqui: a cascata começa no "pagou", e quem chama
// grava NULL nesse caso.
export function deliverStatusFromScan(input: { supplier?: string | null; shipTo?: string | null; tracking?: string | null }): 'PICKUP' | 'BOUGHT' | 'SHIPPED' {
  if (String(input.tracking || '').trim()) return 'SHIPPED'
  const supplier = String(input.supplier || '')
  if (isOnlineOnlySupplier(supplier)) return 'BOUGHT'
  if (String(input.shipTo || '').trim()) return 'BOUGHT'
  if (isCounterStore(supplier)) return 'PICKUP'
  return 'BOUGHT'
}
