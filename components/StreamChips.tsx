'use client'

// ── ORDER NUMBER + SEMÁFORO DO STREAM (Márcio, 29/ago/2026) ─────────────────
// ORDER NUMBER é SAGRADO: toda compra o carrega, e TRACKING aparece em toda
// tela de item comprado — mas tracking NUNCA se digita nem se grava na origem:
// ele mora SÓ em part_streams e chega aqui por JOIN pelo order_number.
// Este arquivo é o MOLDE da página SUPPLIES (app/supplies/page.tsx) extraído
// para as demais telas — chip índigo do pedido, semáforo verde/azul/cinza do
// stream e o join normalizado. Nada aqui grava nada: é leitura pura.

import { supabase } from '@/lib/supabase'

// Colunas de logística do STREAM — um campo por info (lei do usuário): status,
// carrier, tracking e datas moram em part_streams, nunca em notes/descrição.
export type StreamInfo = {
  order_number: string | null
  status: string | null
  carrier: string | null
  tracking_number: string | null
  eta: string | null
  delivered_at: string | null
}

// Normalização dos DOIS lados do join (upper + só alfanumérico): '#3384094'
// casa com '3384094', 'PO-211' com 'po 211'. Os índices do banco usam a MESMA
// regra — upper(regexp_replace(order_number,'[^A-Za-z0-9]','','g')).
export function normOrder(v: string | null | undefined): string {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Join com o STREAM: busca as linhas com order_number e devolve o mapa por
// chave NORMALIZADA. part_streams é pequena (~200 linhas), então trazer todas
// custa menos que perder um match por pontuação divergente num .in() exato.
// Desempate (regra da supplies page): num pedido com várias linhas (remessa
// dividida), a linha COM tracking ocupa o slot de exibição.
// Mesmo filtro da supplies page: SEM .eq('app', ...) — replicado idêntico.
export async function loadStreamMap(): Promise<Record<string, StreamInfo>> {
  const { data } = await supabase
    .from('part_streams')
    .select('order_number, status, carrier, tracking_number, eta, delivered_at')
    .not('order_number', 'is', null)
  const map: Record<string, StreamInfo> = {}
  for (const s of (data || []) as StreamInfo[]) {
    const k = normOrder(s.order_number)
    if (!k) continue
    if (!map[k] || (s.tracking_number && !map[k].tracking_number)) map[k] = s
  }
  return map
}

// Atalho do consumidor: a linha do STREAM para um order number (ou undefined).
export function streamFor(map: Record<string, StreamInfo>, order: string | null | undefined): StreamInfo | undefined {
  const k = normOrder(order)
  return k ? map[k] : undefined
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Chip índigo do pedido — o campo mais importante da compra, sempre visível
// (molde: supplies page, header do card).
export function OrderChip({ order }: { order: string }) {
  return (
    <span className="px-2.5 py-0.5 rounded-lg text-sm font-bold bg-indigo-950 text-indigo-300 border border-indigo-800 whitespace-nowrap">#{order}</span>
  )
}

// Semáforo do STREAM (molde: supplies page): verde DELIVERED, azul SHIPPED,
// cinza BOUGHT — e NUNCA some por falta de tracking: sem tracking o chip
// continua lá, cinza, dizendo BOUGHT.
export function StreamChip({ st }: { st: StreamInfo }) {
  const delivered = st.status === 'DELIVERED'
  return (
    <span className={`px-2.5 py-0.5 rounded-lg text-sm font-bold border ${delivered ? 'bg-green-950 text-green-300 border-green-800' : st.status === 'SHIPPED' ? 'bg-blue-950 text-blue-300 border-blue-800' : 'bg-gray-800 text-gray-300 border-gray-700'}`}>
      {delivered ? `✓ DELIVERED${st.delivered_at ? ' ' + fmtDate(st.delivered_at.slice(0, 10)) : ''}`
        : `${st.status || 'BOUGHT'}${st.eta ? ` · ETA ${fmtDate(st.eta)}` : ''}`}
      {st.carrier ? ` · ${st.carrier}` : ''}{st.tracking_number ? ` ${st.tracking_number}` : ''}
    </span>
  )
}
