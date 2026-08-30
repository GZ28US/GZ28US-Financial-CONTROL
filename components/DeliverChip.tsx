'use client'

// ── O SEMÁFORO DO ITEM — AGORA ELE SÓ LÊ, NUNCA DECIDE ──────────────────────
//
// A VIRADA DE 30/ago/2026, nas palavras do dono:
//
//   "acho que deve ser mais simples, com menos campos. Tem que ter o campo do
//    tracking number e do carrier, e assim:
//      1. Esta pago e sem tracking? O badge mostra Pickup ou Bought, sem campo
//         pra isso, e uma INTERPRETACAO, nao um campo.
//      2. Pago com tracking? Shipped ou Delivered, por interpretacao, nao campo.
//    Assim a chance do app mostrar o status errado e zero."
//
// Por isso ESTE ARQUIVO NÃO CALCULA NADA. A cascata inteira mora em
// lib/deliverStatus.ts (deriveDeliverStatus) e este componente só a chama e
// pinta. Sumiram daqui: DELIVER_STATUSES como seletor, normDeliverStatus,
// applyTrackingRule — não há mais status a normalizar nem a "aplicar", porque
// não há mais status guardado. Sobrou UM campo, e ele nem é status: picked_up.
//
// LEI DO LUGAR (mantida, 29/ago/2026): "os badges de order number, tracking ou
// BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das compras,
// MESMO QUE SEJA REPETIDO EM TODOS." Renderize na LINHA DE CADA ITEM, nunca no
// header do grupo de compra.
//
// QUEM FICA SEM CHIP: linha não paga, linha DOADA e linha de ESTOQUE. O corte é
// o degrau 1 da cascata, dentro de deriveDeliverStatus — a tela não precisa
// repetir a regra (e quando repete, é só cinto e suspensório).

import {
  deriveDeliverStatus,
  hasDeliverChip,
  DELIVER_COLUMNS,
  DELIVER_STATUSES,
  type DeliverRow,
  type DeliverChipRow,
  type DeliverStatus,
} from '@/lib/deliverStatus'

// Reexportado para as telas continuarem importando de um lugar só. A VERDADE
// vive em lib/deliverStatus.ts; aqui é apenas a porta.
export { deriveDeliverStatus, hasDeliverChip, DELIVER_COLUMNS, DELIVER_STATUSES }
export type { DeliverRow, DeliverChipRow, DeliverStatus }

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

// AS QUATRO CORES:
//   PICKUP    verde-escuro — peguei na loja, NÃO VIAJA.
//   BOUGHT    cinza  — pago, ainda sem rastreio.
//   SHIPPED   azul   — em movimento.
//   DELIVERED verde  — chegou.
const TONE: Record<DeliverStatus, string> = {
  // PICKUP ganha fundo PRÓPRIO, não só cor de letra: numa lista densa, "peguei
  // no balcão" e "pago sem rastreio" têm de se distinguir de relance — são
  // coisas diferentes (o de balcão nunca vai viajar).
  PICKUP: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  BOUGHT: 'bg-gray-800 text-gray-300 border-gray-700',
  SHIPPED: 'bg-blue-950 text-blue-300 border-blue-800',
  DELIVERED: 'bg-green-950 text-green-300 border-green-800',
}

// O semáforo. Recebe A PRÓPRIA LINHA do item — nada de mapa, nada de join, e
// nenhuma decisão: uma chamada a deriveDeliverStatus e pronto.
// O ROW TEM DE VIR INTEIRO (30/ago/2026). O tipo é DeliverChipRow, não
// DeliverRow: quem monta um objeto à mão para este chip — as telas de EDIÇÃO —
// é OBRIGADO pelo compilador a responder os sete campos que a cascata e o
// desenho leem. Foi assim que 162 badges pararam de mentir DELIVERED→SHIPPED, e
// é assim que a classe não volta: esquecer um campo agora não compila.
export function DeliverChip({ row }: { row?: DeliverChipRow | null }) {
  const status = deriveDeliverStatus(row)
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
// O SELETOR DE 4 STATUS ACABOU. No lugar dele entra UM controle, e ele não é de
// status: "PICKED UP AT STORE" — marcar/desmarcar "peguei na loja". É o único
// fato da cascata que nenhuma conta produz, então é o único que se digita.
//
// TRACKING e CARRIER continuam digitáveis, como ele pediu ("Tem que ter o campo
// do tracking number e do carrier"). Digitar rastreio sobe o badge para SHIPPED
// SOZINHO — e repare que não há nenhuma linha de código aqui para isso: a
// derivação lê tracking_number e o badge acompanha. Antes existia
// applyTrackingRule justamente porque havia um status guardado para consertar.
//
// `size` só escolhe a métrica visual: 'lg' nas fichas de página inteira,
// 'sm' nas fileiras densas de despesa dentro da invoice.
export function DeliverFields({
  pickedUp, tracking, carrier, onPickedUp, onTracking, onCarrier, size = 'lg', className = '',
}: {
  pickedUp: boolean
  tracking: string
  carrier: string
  onPickedUp: (v: boolean) => void
  onTracking: (v: string) => void
  onCarrier: (v: string) => void
  size?: 'lg' | 'sm'
  className?: string
}) {
  const box = size === 'lg'
    ? 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-5 py-3 text-lg'
    : 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-2 text-sm'
  const label = size === 'lg' ? 'block mb-2 text-lg font-bold' : 'block mb-1 text-xs text-gray-400'
  const pickBox = size === 'lg'
    ? 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-5 py-3 text-lg flex items-center gap-3 cursor-pointer'
    : 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-2 text-sm flex items-center gap-2 cursor-pointer'
  return (
    <div className={`flex gap-2 flex-wrap items-end ${className}`}>
      <div className="flex-1 min-w-[10rem]">
        <label className={label}>PICKED UP</label>
        <label className={`${pickBox} ${pickedUp ? 'text-emerald-300 border-emerald-800' : 'text-gray-400'}`}>
          <input type="checkbox" checked={pickedUp} onChange={(e) => onPickedUp(e.target.checked)} className="w-5 h-5 accent-emerald-500" />
          <span className="font-bold">AT STORE</span>
        </label>
      </div>
      <div className="flex-1 min-w-[9rem]">
        <label className={label}>TRACKING</label>
        <input type="text" value={tracking} onChange={(e) => onTracking(e.target.value)} placeholder="e.g. 1ZHE56910323676001" className={box} />
      </div>
      <div className="flex-1 min-w-[7rem]">
        <label className={label}>CARRIER</label>
        <input type="text" value={carrier} onChange={(e) => onCarrier(e.target.value)} placeholder="UPS / FedEx / USPS" className={box} />
      </div>
    </div>
  )
}
