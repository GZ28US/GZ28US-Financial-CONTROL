'use client'

// ── DELIVER STATUS — o badge agora É DA LINHA (Márcio, 29/ago/2026) ──────────
//
// A VIRADA DE CHAVE, nas palavras dele:
//
//   "todos os itens comprados tem que ter uma coluna chamada deliver_status:
//      PickUp    - PAGO e pego no balcao
//      Bought    - PAGO e sem tracking ainda
//      Shipped   - quando o item bought ganha tracking
//      Delivered - quando o Shipped foi entregue
//    SAGRADO, nao pode haver 1 item de compra sem estes status. Comprei uma
//    coca-cola no Wawa? PickUp!"
//
//   "a leitura do rastreio agora deve viver na pagina do item, ESQUECA A AREA DE
//    STREAM, e tudo na pagina de origem do item."
//
//   "esqueca o stream, refaremos ele do zero depois. NAO USE NADA DO STREAM,
//    nada. O tracking, carrier e o que quer que seja necessario pra rastrear
//    agora vive como coluna nova da tabela dos itens comprados, na origem."
//
// O QUE MORREU AQUI: o antecessor deste arquivo (components/StreamChips.tsx)
// carregava part_streams inteiro e casava por order_number para descobrir o
// status. Isso ACABOU. Não há join, não há loadStreamMap, não há segunda
// consulta: a tela já carregou a linha do item, e a linha do item já traz
// deliver_status / tracking_number / carrier / eta / delivered_at. Menos
// consulta, mais verdade — o chip lê o mesmo dado que o formulário grava.
//
// LEI DO LUGAR (mantida, 29/ago/2026): "os badges de order number, tracking ou
// BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das compras,
// MESMO QUE SEJA REPETIDO EM TODOS. Este controle e gerenciamento e pros itens,
// nao pra compra, uma vez que podem gerar order numbers e tracking diferentes."
// Portanto: renderize na LINHA DE CADA ITEM, nunca no header do grupo de compra.
//
// QUEM FICA SEM CHIP: linha não paga (a cascata começa no "pagou") e linha
// DOADA (source_type DONATED — não foi comprada). As duas ficam com
// deliver_status NULL no banco, então o corte é automático: sem status, sem
// chip. Nenhum call site precisa mais passar `paid` — o banco já decidiu.

// Os QUATRO status, na ordem da cascata que ele ditou. Nada além disto entra na
// coluna (o CHECK do banco recusa) — não há "status especial" nem lista negra.
export const DELIVER_STATUSES = ['PICKUP', 'BOUGHT', 'SHIPPED', 'DELIVERED'] as const
export type DeliverStatus = (typeof DELIVER_STATUSES)[number]

// A parte de logística de QUALQUER linha de item comprado — as 5 tabelas
// (invoice_expenses, inputs, inventory, goods, good_expenses) têm exatamente
// estas colunas, com estes nomes, nos dois bancos. Um campo por informação
// (lei do usuário): tracking/carrier/ETA são COLUNAS, nunca texto em notes.
export type DeliverRow = {
  deliver_status?: string | null
  tracking_number?: string | null
  carrier?: string | null
  eta?: string | null
  shipped_at?: string | null
  delivered_at?: string | null
  last_event?: string | null
  last_event_at?: string | null
}

// A lista de colunas para os `select(...)` explícitos das telas. Quem usa
// `select('*')` já as recebe de graça.
export const DELIVER_COLUMNS = 'deliver_status, tracking_number, carrier, eta, shipped_at, delivered_at, last_event, last_event_at'

export function normDeliverStatus(v: string | null | undefined): DeliverStatus | '' {
  const k = String(v || '').trim().toUpperCase()
  return (DELIVER_STATUSES as readonly string[]).includes(k) ? (k as DeliverStatus) : ''
}

// Mesmo critério do chip, exposto para a tela decidir se abre a linha (ou a
// margem) onde ele mora — sem isso sobra div vazia empurrando o layout.
export function hasDeliverChip(row: DeliverRow | null | undefined): boolean {
  return !!normDeliverStatus(row?.deliver_status)
}

// A REGRA DE TELA (lei dele): "Digitar rastreio num item BOUGHT sobe ele para
// SHIPPED sozinho." Só sobe de BOUGHT (ou de vazio) — PICKUP não vira SHIPPED
// por digitação, porque PICKUP quer dizer "não viaja", e DELIVERED jamais
// regride. Trocar o status À MÃO continua permitido: é assim que uma compra
// vira PICKUP.
export function applyTrackingRule(status: string | null | undefined, tracking: string | null | undefined): DeliverStatus | '' {
  const s = normDeliverStatus(status)
  if (!String(tracking || '').trim()) return s
  return s === '' || s === 'BOUGHT' ? 'SHIPPED' : s
}

function fmtDate(d: string | null | undefined) {
  if (!d) return ''
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00')
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Chip índigo do pedido — o campo mais importante da compra, sempre visível na
// LINHA do item que o carrega (nunca no título da compra).
export function OrderChip({ order }: { order: string }) {
  return (
    <span className="px-2.5 py-0.5 rounded-lg text-sm font-bold bg-indigo-950 text-indigo-300 border border-indigo-800 whitespace-nowrap">#{order}</span>
  )
}

// AS QUATRO CORES (ditadas na virada de chave):
//   PICKUP    cinza-esverdeado — peguei na loja, NÃO VIAJA. É este badge que diz
//             ao app que a linha não deve ser rastreada.
//   BOUGHT    cinza  — pago, ainda sem rastreio.
//   SHIPPED   azul   — em movimento.
//   DELIVERED verde  — chegou.
const TONE: Record<DeliverStatus, string> = {
  // PICKUP ganha fundo PROPRIO, nao so cor de letra: numa lista densa, 'peguei no
  // balcao' e 'pago sem rastreio' tem de se distinguir de relance — sao coisas
  // diferentes (o de balcao nunca vai viajar).
  PICKUP: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  BOUGHT: 'bg-gray-800 text-gray-300 border-gray-700',
  SHIPPED: 'bg-blue-950 text-blue-300 border-blue-800',
  DELIVERED: 'bg-green-950 text-green-300 border-green-800',
}

// O semáforo. Recebe A PRÓPRIA LINHA do item — nada de mapa, nada de join.
export function DeliverChip({ row }: { row?: DeliverRow | null }) {
  const status = normDeliverStatus(row?.deliver_status)
  if (!status) return null
  const tracking = String(row?.tracking_number || '').trim()
  const carrier = String(row?.carrier || '').trim()
  // PICKUP não mostra transportadora nem ETA: não há viagem para descrever.
  const tail = status === 'PICKUP' ? '' : `${carrier ? ` · ${carrier}` : ''}${tracking ? ` ${tracking}` : ''}`
  const head = status === 'DELIVERED'
    ? `✓ DELIVERED${fmtDate(row?.delivered_at) ? ' ' + fmtDate(row?.delivered_at) : ''}`
    : `${status}${status === 'SHIPPED' && fmtDate(row?.eta) ? ` · ETA ${fmtDate(row?.eta)}` : ''}`
  return (
    <span className={`px-2.5 py-0.5 rounded-lg text-sm font-bold border ${TONE[status]}`} title={String(row?.last_event || '') || undefined}>
      {head}{tail}
    </span>
  )
}

// ── OS CAMPOS DO FORMULÁRIO ─────────────────────────────────────────────────
// Onde se cadastra e edita item comprado entram os três: DELIVER STATUS (os 4
// valores), TRACKING e CARRIER. Trocar o status à mão é PERMITIDO — é assim que
// uma compra vira PICKUP. Digitar rastreio num BOUGHT sobe para SHIPPED sozinho
// (applyTrackingRule), que é a cascata do dono em forma de formulário.
//
// `size` só escolhe a métrica visual: 'lg' nas fichas de página inteira,
// 'sm' nas fileiras densas de despesa dentro da invoice.
export function DeliverFields({
  status, tracking, carrier, onStatus, onTracking, onCarrier, size = 'lg', className = '',
}: {
  status: string
  tracking: string
  carrier: string
  onStatus: (v: string) => void
  onTracking: (v: string) => void
  onCarrier: (v: string) => void
  size?: 'lg' | 'sm'
  className?: string
}) {
  const box = size === 'lg'
    ? 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-5 py-3 text-lg'
    : 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-2 text-sm'
  const label = size === 'lg' ? 'block mb-2 text-lg font-bold' : 'block mb-1 text-xs text-gray-400'
  // Rastreio digitado sobe o status sozinho — a regra vive num lugar só.
  const typeTracking = (v: string) => { onTracking(v); const next = applyTrackingRule(status, v); if (next && next !== normDeliverStatus(status)) onStatus(next) }
  return (
    <div className={`flex gap-2 flex-wrap items-end ${className}`}>
      <div className="flex-1 min-w-[8rem]">
        <label className={label}>DELIVER STATUS</label>
        <select value={normDeliverStatus(status)} onChange={(e) => onStatus(e.target.value)} className={box}>
          <option value="">—</option>
          {DELIVER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex-1 min-w-[9rem]">
        <label className={label}>TRACKING</label>
        <input type="text" value={tracking} onChange={(e) => typeTracking(e.target.value)} placeholder="e.g. 1ZHE56910323676001" className={box} />
      </div>
      <div className="flex-1 min-w-[7rem]">
        <label className={label}>CARRIER</label>
        <input type="text" value={carrier} onChange={(e) => onCarrier(e.target.value)} placeholder="UPS / FedEx / USPS" className={box} />
      </div>
    </div>
  )
}
