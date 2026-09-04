// ── STATUS VIRA DERIVAÇÃO, NÃO CAMPO ────────────────────────────────────────
// Lei ditada por Márcio em 30/ago/2026, palavra por palavra:
//
//   "acho que deve ser mais simples, com menos campos. Tem que ter o campo do
//    tracking number e do carrier, e assim:
//      1. Esta pago e sem tracking? O badge mostra Pickup ou Bought, sem campo
//         pra isso, e uma INTERPRETACAO, nao um campo.
//      2. Pago com tracking? Shipped ou Delivered, por interpretacao, nao campo.
//    Assim a chance do app mostrar o status errado e zero."
//
//   "Se teve endereco de entrega no escaneamento da compra, e Bought; se nao
//    teve, e PickUp."
//
// O QUE MORREU: a coluna deliver_status. Ela existia nas 5 tabelas de item
// comprado e podia DIVERGIR do fato — foi o que aconteceu com as 6 linhas da TAG
// Motorsports (pagas em 25/ago e sem status nenhum, com "[A PAGAR]" no nome do
// item tapando o buraco). Um campo que repete um fato só serve para mentir
// quando a escrita falha na metade.
//
// O QUE SOBROU: UM campo, e ele nem é status — `picked_up` (boolean). É o único
// que NENHUMA conta produz: só o DOCUMENTO diz que a compra foi pega no balcão
// (nota sem endereço de entrega). Os outros três saem de fato já gravado:
// delivered_at, tracking_number, payment_date. Nada para divergir.
//
// A CASCATA, na ordem exata (é ela e mais nada que decide badge no app inteiro):
//   0. doado / de estoque             → SEM BADGE  (não é compra: nem cancelada
//                                       pode ter sido — cancel_status ali é lixo
//                                       de dado, não estado, e se ignora)
//   1. cancel_status                  → CANCELLED / REFUNDED  (ordem do dono,
//                                       30/ago/2026 — passa por cima de TUDO,
//                                       até do "pagou": o estorno LIMPA o
//                                       payment_date, e o badge tem de continuar
//                                       contando a história. As 4 linhas reais
//                                       do pedido HHP 382526 estão sem
//                                       payment_date exatamente por isso.)
//   2. não pago                       → SEM BADGE
//   3. picked_up                      → PICKUP
//   4. delivered_at                   → DELIVERED
//   5. tracking_number                → SHIPPED
//   6. resto (pago)                   → BOUGHT
//
// Este módulo é PURO de propósito (sem banco, sem rede, sem React): as telas, o
// robô do rastreio e o scan têm de responder exatamente a mesma coisa, e a única
// forma de garantir isso é ninguém mais calcular status em lugar nenhum.

// ── AS 6 TABELAS DE ITEM COMPRADO ───────────────────────────────────────────
// invoice_expenses, inputs, inventory, goods, good_expenses — e, desde
// 03/set/2026, expenses. Todas têm picked_up, tracking_number, carrier, eta,
// shipped_at, delivered_at, last_event, last_event_at — e todas têm
// payment_date, que é o degrau "pagou?". E, desde 30/ago/2026, todas têm
// cancel_status (null | CANCELLED | REFUNDED).
//
// expenses entrou por lei do dono (Márcio, 03/set/2026): "compra pessoal esta
// no lugar certo (expenses, origin='PERSONAL'), mas TEM que estar no STREAM
// tambem, e tem que ter rastreio". Só que expenses é, na maior parte, FOLHA —
// uma linha dela só é ITEM quando tem order_number OU tracking_number. Esse
// gate mora AQUI (módulo puro, importável por server e browser) para os três
// enumeradores (STREAM, robô do 17TRACK, ponte de e-mail) usarem o MESMO
// predicado NA QUERY do PostgREST — folha nunca sai do banco. A cascata abaixo
// continua agnóstica de tabela: não sabe o que é expenses.
// 04/set/2026: o gate anda SEMPRE com origin = 'PERSONAL' nos 3 consumidores. Sem isso,
// passagem/compensacao de staff (PNR gravado em order_number: BLNKJJ, LA0457622ODMO,
// BUSA-...) nascia BOUGHT no STREAM para sempre e entrava no dicionario da ponte de
// e-mail — um recibo da Copa com 'entregue' carimbaria entrega numa passagem.
import { travels } from './itemNature'

export const EXPENSE_ITEM_GATE = 'order_number.not.is.null,tracking_number.not.is.null'

export const DELIVER_STATUSES = ['PICKUP', 'BOUGHT', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const
export type DeliverStatus = (typeof DELIVER_STATUSES)[number]

// O ÚNICO campo de cancelamento — e ele é FATO, não interpretação: só um humano
// (ou um estorno confirmado) o escreve. CANCELLED = "cancelei, o dinheiro ainda
// está na mão do vendedor"; REFUNDED = "o estorno chegou, caso encerrado".
export const CANCEL_STATUSES = ['CANCELLED', 'REFUNDED'] as const
export type CancelStatus = (typeof CANCEL_STATUSES)[number]

export function normCancelStatus(v: string | null | undefined): CancelStatus | null {
  const s = String(v || '').trim().toUpperCase()
  return s === 'CANCELLED' || s === 'REFUNDED' ? s : null
}

// A parte de logística de QUALQUER linha de item comprado. Um campo por
// informação (lei da casa): tracking/carrier/ETA são COLUNAS, nunca texto em
// notes — e status não é coluna nenhuma, é o resultado de ler estas aqui.
export type DeliverRow = {
  // O ÚNICO campo guardado da cascata. NOT NULL default false no banco: item não
  // é de balcão até que um documento diga que é. Ninguém nasce PICKUP por omissão.
  picked_up?: boolean | null
  // O DEGRAU MAIS ALTO da cascata (depois do corte doado/estoque): null =
  // compra viva, CANCELLED = aguardando estorno, REFUNDED = estornada. No banco
  // é text com CHECK — aqui viaja como string e a derivação normaliza.
  cancel_status?: string | null
  tracking_number?: string | null
  carrier?: string | null
  eta?: string | null
  shipped_at?: string | null
  delivered_at?: string | null
  last_event?: string | null
  last_event_at?: string | null
  // ── OS TRÊS CORTES DO DEGRAU 1 ───────────────────────────────────────────
  // payment_date: existe nas 6 tabelas e é o "pagou?" — sem ele não há badge.
  payment_date?: string | null
  // source_type (inputs/inventory) e stock_source_type (invoice_expenses):
  // 'DONATED' = a peça não foi comprada, veio de dentro de casa.
  source_type?: string | null
  stock_source_type?: string | null
  // nature: PART | SERVICE | DIGITAL | CHARGE | MONEY | null. É o degrau zero —
  // "isso é coisa que chega?". NULL = ninguém disse ainda, e NULL VIAJA (ver
  // lib/itemNature.ts: poluir custa um clique, sumir custa um carro parado).
  nature?: string | null
  // supplier: é aqui que mora o "veio do estoque" — e é o ponto fraco declarado
  // desta cascata (ver fromStock abaixo).
  supplier?: string | null
}

// A lista de colunas para os `select(...)` explícitos das telas. Quem usa
// `select('*')` já as recebe de graça. ATENÇÃO: quem monta select explícito e
// desenha badge TEM de trazer payment_date junto — sem ele a cascata corta no
// degrau 1 e o badge some.
export const DELIVER_COLUMNS = 'picked_up, cancel_status, tracking_number, carrier, eta, shipped_at, delivered_at, last_event, last_event_at, nature'

// ── O TIPO QUE O COMPILADOR COBRA ───────────────────────────────────────────
// A regressão de 30/ago/2026: as telas de EDIÇÃO montavam um objeto de
// formulário à mão e o entregavam ao <DeliverChip>. O objeto trazia
// picked_up/tracking_number/carrier/payment_date e ESQUECIA delivered_at — e a
// cascata, sem o degrau 3, caía um degrau e pintava SHIPPED numa linha que já
// tinha CHEGADO. 151 linhas erradas no US, 11 no BR.
//
// O buraco NÃO era de lógica (a derivação está certa e testada): era de
// FORMATO. Um objeto incompleto entrava calado porque todo campo de DeliverRow
// é opcional — perfeito para LER uma linha do banco, péssimo para MONTAR uma.
//
// Então a classe do bug morre no tipo, não na disciplina de quem escreve a
// tela: DeliverChipRow exige — de verdade, com erro de compilação — os SETE
// campos que o chip lê. `| null` continua valendo: dizer `delivered_at: null`
// é uma AFIRMAÇÃO ("não chegou"), enquanto omitir era um ESQUECIMENTO. Quem
// monta objeto agora tem de responder cada pergunta da cascata.
//
// Os cinco que ficaram opcionais são os que não mudam o que o chip DESENHA:
// shipped_at e last_event_at (não aparecem), e os três cortes do degrau 1
// (source_type / stock_source_type / supplier), que variam de tabela para
// tabela — invoice_expenses tem stock_source_type e não tem source_type.
export type DeliverChipRow = DeliverRow & {
  picked_up: boolean | null
  // cancel_status entrou aqui EXIGIDO (30/ago/2026) pelo mesmo motivo do
  // delivered_at: é degrau da cascata, e omiti-lo num objeto montado à mão
  // faria o chip mentir BOUGHT numa compra cancelada. `cancel_status: null` é
  // afirmação ("compra viva"); omitir não compila.
  cancel_status: string | null
  payment_date: string | null
  tracking_number: string | null
  carrier: string | null
  eta: string | null
  delivered_at: string | null
  last_event: string | null
  // nature EXIGIDO pelo mesmo motivo do delivered_at: quem monta o objeto tem de
  // responder. E há um motivo a mais aqui — se a tela esquecer `nature` no
  // select, ela volta undefined, VIAJA, e o degrau nunca dispara naquela tela.
  // Exigir no tipo é o que garante que o select traga.
  nature: string | null
}

// ── DEGRAU 1: QUEM NEM CHEGA A TER BADGE ────────────────────────────────────
// "Linha doada / não paga / de estoque não tem badge."

const isPaid = (row: DeliverRow) => !!String(row.payment_date || '').trim()

// PROVA DE CHEGADA: os três fatos que dizem que a coisa terminou o caminho. É o
// guarda-costas do degrau zero — nenhuma classificação humana errada consegue
// apagar um badge que o mundo real já provou.
const hasArrivalFact = (row: DeliverRow) =>
  !!String(row.tracking_number || '').trim() ||
  !!String(row.delivered_at || '').trim() ||
  !!row.picked_up

const isDonated = (row: DeliverRow) =>
  String(row.source_type || '').toUpperCase() === 'DONATED' ||
  String(row.stock_source_type || '').toUpperCase() === 'DONATED'

// PONTO FRACO DECLARADO (não inventei, herdei): "veio do estoque" ainda é
// reconhecido por TEXTO no campo supplier — a mesma doença que o dono acabou de
// matar no nome do item ("[A PAGAR]"). São ~7 linhas no banco e não existe campo
// para isso hoje. Uso exatamente o mesmo critério que o backfill usou, para não
// inventar diferença; o certo, no dia em que ele quiser fechar o cerco, é um
// `from_stock boolean` na mesma linha de raciocínio do picked_up.
const isFromStock = (row: DeliverRow) => /^(stock|stock inventory)$/i.test(String(row.supplier || '').trim())

// ── A DERIVAÇÃO. É ESTA FUNÇÃO E MAIS NENHUMA ───────────────────────────────
// Devolve null quando a linha não é compra paga — e null é "sem badge", nunca
// "status desconhecido".
export function deriveDeliverStatus(row: DeliverRow | null | undefined): DeliverStatus | null {
  if (!row) return null
  // EXCEÇÃO DA EXCEÇÃO: doado / de estoque não é compra — não pode ter sido
  // cancelado. Se por absurdo carregar cancel_status, é lixo de dado, não
  // estado: continua SEM badge.
  if (isDonated(row) || isFromStock(row)) return null
  // ── DEGRAU ZERO: "ISSO É COISA QUE CHEGA?" (04/set/2026) ──────────────────
  // Wire de carro, imposto do Texas, licença da HP Tuners, tune por e-mail, car
  // wash e aluguel de empilhadeira NÃO chegam de caminhão — e caíam todos em
  // BOUGHT por construção, 197 linhas e 80% do dinheiro da aba.
  // GUARDADO PELO FATO: só corta quem não tem prova de chegada. Se a
  // transportadora disser que entregou, o fato ganha do rótulo — senão isto
  // seria juízo acima de fato, exatamente o que matou a coluna deliver_status.
  if (!hasArrivalFact(row) && !travels(row.nature)) return null
  // O DEGRAU MAIS ALTO: cancelamento passa por cima de TUDO, até do "pagou" —
  // o estorno limpa o payment_date e o badge tem de continuar contando a
  // história (as 4 linhas do pedido HHP 382526 são exatamente esse caso).
  const cancelled = normCancelStatus(row.cancel_status)
  if (cancelled) return cancelled
  if (!isPaid(row)) return null
  if (row.picked_up) return 'PICKUP'
  if (String(row.delivered_at || '').trim()) return 'DELIVERED'
  if (String(row.tracking_number || '').trim()) return 'SHIPPED'
  return 'BOUGHT'
}

// Mesmo critério do chip, exposto para a tela decidir se abre a linha (ou a
// margem) onde ele mora — sem isso sobra div vazia empurrando o layout.
export function hasDeliverChip(row: DeliverRow | null | undefined): boolean {
  return deriveDeliverStatus(row) !== null
}

// ── DE ONDE SAI O picked_up: O DOCUMENTO ────────────────────────────────────
//   "Se teve endereco de entrega no escaneamento da compra, e Bought; se nao
//    teve, e PickUp."
//   "Amazon nunca vai ser pickup. Walmart pode ser das 2 formas: a partir do
//    escaneamento da invoice, se tiver endereco de entrega e nota de compra a
//    ser entregue; se nao tiver endereco, e compra de balcao, PickUp."
//
// Quem decide não é o palpite sobre a loja, é o PAPEL: o scan devolve ship_to
// quando ele está impresso na nota. Sem endereço, numa loja que TEM balcão, a
// compra foi pega na mão.

// LOJA SEM BALCÃO: marketplace/e-commerce puro — loja online não tem balcão,
// então NUNCA é picked_up, mesmo sem endereço na nota. Casa por SUBSTRING,
// minúsculo, no nome do fornecedor.
const ONLINE_ONLY = [
  'amazon', 'temu', 'ebay', 'aliexpress', 'mercado livre', 'mercadolivre',
  'mercado pago', 'mercadopago', 'walmart.com', 'rockauto', 'carid', 'summit',
  'bestbuy.com', 'zanvis', 'pneustore', 'autozonepro',
]

// LOJA COM BALCÃO (inclui as HÍBRIDAS, que vendem no balcão E entregam). É nesta
// lista que a regra do endereço decide. Quem não está em lista nenhuma cai no
// padrão seguro: picked_up = false — nunca se INVENTA um PICKUP.
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

// O ÚNICO campo que o scan grava da cascata. Note o que ele NÃO olha: tracking.
// Rastreio é fato próprio (vira SHIPPED sozinho na derivação) e não tem nada a
// ver com ter pego no balcão — misturar os dois era exatamente o defeito do
// modelo antigo.
export function pickedUpFromScan(input: { supplier?: string | null; shipTo?: string | null }): boolean {
  const supplier = String(input.supplier || '')
  if (isOnlineOnlySupplier(supplier)) return false          // loja online não tem balcão
  if (String(input.shipTo || '').trim()) return false       // a nota traz endereço = é entrega
  return isCounterStore(supplier)                           // balcão + sem endereço = peguei na mão
}
