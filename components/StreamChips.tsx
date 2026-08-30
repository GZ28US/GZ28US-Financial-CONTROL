'use client'

// ── ORDER NUMBER + SEMÁFORO DO STREAM (Márcio, 29/ago/2026) ─────────────────
// ORDER NUMBER é SAGRADO: toda compra o carrega, e TRACKING aparece em toda
// tela de item comprado — mas tracking NUNCA se digita nem se grava na origem:
// ele mora SÓ em part_streams e chega aqui por JOIN pelo order_number.
// Este arquivo é o MOLDE da página SUPPLIES (app/supplies/page.tsx) extraído
// para as demais telas — chip índigo do pedido, semáforo verde/azul/cinza do
// stream e o join normalizado. Nada aqui grava nada: é leitura pura.
//
// LEI DO LUGAR (Márcio, 29/ago/2026): "os badges de order number, tracking ou
// BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das compras,
// MESMO QUE SEJA REPETIDO EM TODOS. Este controle e gerenciamento e pros
// itens, nao pra compra, uma vez que podem gerar order numbers e tracking
// diferentes." Ou seja: estes chips renderizam na LINHA DE CADA ITEM, nunca no
// header/título do grupo de compra — o padrão commonOf (subir pro header
// quando todos compartilham) MORREU.

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
// na LINHA do item que o carrega (lei 29/ago/2026: nunca no título da compra).
export function OrderChip({ order }: { order: string }) {
  return (
    <span className="px-2.5 py-0.5 rounded-lg text-sm font-bold bg-indigo-950 text-indigo-300 border border-indigo-800 whitespace-nowrap">#{order}</span>
  )
}

// ── A CASCATA DO STATUS (Márcio, 29/ago/2026) ───────────────────────────────
// Ele ditou a lei nesta ordem, e é nesta ordem que ela se lê:
//
//     "PAGOU?        Bought
//      TEM RASTREIO? Shipped
//      ENTREGOU?     Delivered"
//
// A consequência que importa: ITEM PAGO SEMPRE TEM STATUS. Antes o semáforo só
// nascia quando existia linha em part_streams — item pago sem remessa ficava
// SEM CHIP NENHUM, e isso contrariava a lei: ele é BOUGHT e a tela tem de dizer
// isso. Por isso `st` virou OPCIONAL: sem remessa casada, o chip continua e diz
// BOUGHT (cinza). O que manda é o PAGAMENTO, não a existência do stream.
//
// A cascata se lê de trás pra frente (o fato mais avançado ganha):
//   entregou (status DELIVERED ou delivered_at preenchido) → DELIVERED
//   tem rastreio OU status SHIPPED                         → SHIPPED
//   resto (pagou)                                          → BOUGHT
// O ramo do SHIPPED é um OU, nunca um E: há 16 linhas SHIPPED sem número de
// rastreio no banco ("despachou sem número"), e elas continuam SHIPPED.
//
// ESTADOS ESPECIAIS ficam FORA da cascata e aparecem como estão — REFUNDED e
// ON HOLD dizem algo que a cascata não sabe expressar, e achatar seria mentir.
// Um pedido estornado NÃO é "comprado": ele entra aqui antes de qualquer
// derivação, inclusive antes do teste de pagamento — o estorno costuma limpar
// o payment_date da linha de origem (é o caso das 4 linhas do pedido 382526,
// "[ESTORNADO 11/08]"), e esconder o chip apagaria justamente o fato que a lei
// mandou preservar. Regra 4 governa a CASCATA; o especial não é derivação, é
// fato gravado no STREAM.
//
// LINHA NÃO PAGA NÃO TEM STATUS: sem pagamento, nenhum chip — a cascata começa
// no "pagou". Quem sabe se a linha está paga é a TELA (payment_date, na maioria
// delas), e por isso `paid` é prop obrigatória: nenhum call site passa batido.
// Linha DOADA (source_type DONATED) continua sem chip nenhum: não foi comprada
// (lei anterior, intocada) — esse corte é feito no call site, que é quem enxerga
// o source_type.
export type DerivedStreamStatus = 'BOUGHT' | 'SHIPPED' | 'DELIVERED'

// LISTA BRANCA, NÃO LISTA NEGRA. Só estes três degraus entram na cascata; QUALQUER
// outro status gravado é exibido como está. A versão anterior enumerava os
// especiais (REFUNDED, ON HOLD) e achatava em BOUGHT tudo o que não estivesse na
// lista — e o app tem mais estados vivos do que aqueles dois: CANCELLED (há botão
// que o grava em app/stream/page.tsx), REPORTED_PT e DELIVERED_BR (escada do BR,
// que chega aqui porque o join não filtra por app). Uma compra CANCELADA
// estampando "BOUGHT" seria exatamente a mentira que a lei proíbe. Com lista
// branca, estado novo no futuro aparece cru em vez de virar outra coisa.
const CASCATA = new Set(['', 'BOUGHT', 'SHIPPED', 'DELIVERED'])

function statusKey(st?: StreamInfo | null): string {
  return String(st?.status || '').trim().toUpperCase()
}

// Devolve o status especial (texto como está gravado) ou null quando a linha
// entra na cascata normal.
export function specialStreamStatus(st?: StreamInfo | null): string | null {
  const k = statusKey(st)
  return CASCATA.has(k) ? null : String(st?.status || '').trim()
}

// A cascata em si — só fatos, nenhuma invenção.
export function deriveStreamStatus(st?: StreamInfo | null): DerivedStreamStatus {
  const s = statusKey(st)
  if (s === 'DELIVERED' || String(st?.delivered_at || '').trim()) return 'DELIVERED'
  if (String(st?.tracking_number || '').trim() || s === 'SHIPPED') return 'SHIPPED'
  return 'BOUGHT'
}

// Mesmo critério do chip, exposto pra tela decidir se abre a LINHA (ou a
// margem) onde ele mora — sem isso sobra div vazia empurrando o layout.
export function hasStreamChip(st: StreamInfo | null | undefined, paid: boolean): boolean {
  return paid || !!specialStreamStatus(st)
}

// Semáforo do STREAM (molde: supplies page): verde DELIVERED, azul SHIPPED,
// cinza BOUGHT (e cinza também nos especiais, como sempre foi). Nunca some por
// falta de tracking — e agora nem por falta de remessa.
export function StreamChip({ st, paid }: { st?: StreamInfo | null; paid: boolean }) {
  const special = specialStreamStatus(st)
  // Regra 4: sem pagamento não há status. O especial passa por cima porque não
  // é derivado — é o que o STREAM registrou.
  if (!hasStreamChip(st, paid)) return null
  const status = special || deriveStreamStatus(st)
  const tone = special ? 'bg-gray-800 text-gray-300 border-gray-700'
    : status === 'DELIVERED' ? 'bg-green-950 text-green-300 border-green-800'
    : status === 'SHIPPED' ? 'bg-blue-950 text-blue-300 border-blue-800'
    : 'bg-gray-800 text-gray-300 border-gray-700'
  return (
    <span className={`px-2.5 py-0.5 rounded-lg text-sm font-bold border ${tone}`}>
      {!special && status === 'DELIVERED'
        ? `✓ DELIVERED${st?.delivered_at ? ' ' + fmtDate(String(st.delivered_at).slice(0, 10)) : ''}`
        : `${status}${st?.eta ? ` · ETA ${fmtDate(st.eta)}` : ''}`}
      {st?.carrier ? ` · ${st.carrier}` : ''}{st?.tracking_number ? ` ${st.tracking_number}` : ''}
    </span>
  )
}
