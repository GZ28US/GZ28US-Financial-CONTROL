// SERVER-ONLY — RASTREIO CEGO: A LEITURA DA LOJA (LIVRO 13.10, 19/10/2026).
//
//   "o robô tem que entrar na Amazon e checar a order, mas não pode
//    "abandonar" o caso, info is power" — Márcio, 19/10/2026
//
// O 17TRACK (lib/itemTracking.server.ts) só sabe perguntar por número de
// RASTREIO. Compra paga com número de PEDIDO e sem rastreio é «cega»: quem sabe
// dela é a loja. Este módulo faz as duas pontas que moram no app:
//   listBlind      → a fila: toda linha cega, agrupada por pedido, com a loja,
//                    a página do pedido e a última leitura (rota GET).
//   applyReading   → grava o que a loja disse NA PRÓPRIA LINHA (rota POST):
//                    store_checked_at sempre; last_event / eta quando mudam;
//                    delivered_at quando a loja diz que chegou; tracking_number
//                    e carrier quando a loja mostra o número — aí a linha deixa
//                    de ser cega e o 17TRACK assume na próxima passada (:37).
// Quem LÊ a loja é uma sessão do Claude com o Chrome do Márcio (as contas ficam
// logadas lá; nenhuma senha passa por aqui) — docs/ROBO-RASTREIO-CEGO.md.
//
// As mesmas travas do rastreador: entrega gravada NUNCA se desfaz (só escreve
// delivered_at vazio), PICKUP nunca entra (picked_up = false na query), compra
// cancelada sai da fila (cancel_status NULL), e status não é campo (o badge
// continua derivado). Toda escrita vai para data_fixes, check_key 'store-check'.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ITEM_TABLES, type ItemTable, EXPENSE_ITEM_GATE } from './itemTracking.server'
import { isBlindTracking, blindStore, storeOrderUrl, type BlindStore } from './deliverStatus'

// O que a cascata lê + o que a fila mostra. O VALOR vem em colunas diferentes
// por tabela — é só para cortar a linha de ESTORNO (negativa), não para somar.
const BASE = 'id, picked_up, cancel_status, payment_date, nature, supplier, order_number, tracking_number, carrier, eta, shipped_at, delivered_at, last_event, last_event_at, store_checked_at'
const LABEL: Record<ItemTable, { cols: string; label: string; amount: (r: any) => number | null }> = {
  invoice_expenses: { cols: 'item, price, quantity, invoice_id, stock_source_type', label: 'item', amount: r => r.price == null ? null : Number(r.price) * Number(r.quantity || 1) },
  inputs: { cols: 'description, unit_price, quantity, source_type', label: 'description', amount: r => r.unit_price == null ? null : Number(r.unit_price) * Number(r.quantity || 1) },
  inventory: { cols: 'description, unit_price, quantity, source_type', label: 'description', amount: r => r.unit_price == null ? null : Number(r.unit_price) * Number(r.quantity || 1) },
  assets: { cols: 'description, unit_price, quantity', label: 'description', amount: r => r.unit_price == null ? null : Number(r.unit_price) * Number(r.quantity || 1) },
  assets_expenses: { cols: 'description, amount', label: 'description', amount: r => r.amount == null ? null : Number(r.amount) },
  staff_expenses: { cols: 'description, amount, origin', label: 'description', amount: r => r.amount == null ? null : Number(r.amount) },
}

export type BlindLine = {
  table: ItemTable
  id: string
  item: string
  amount: number | null
  payment_date: string | null
  last_event: string | null
  eta: string | null
  store_checked_at: string | null
}
export type BlindOrder = {
  store: BlindStore | null      // null = loja que o robô ainda não sabe ler
  supplier: string
  order_number: string
  url: string | null
  last_checked: string | null   // o mais VELHO das linhas — o pedido só está lido quando todas estão
  lines: BlindLine[]
}

// A fila inteira. Mais velho primeiro (nunca lido > lido há mais tempo): é a
// ordem em que o caso começa a ser abandonado.
export async function listBlind(db: SupabaseClient): Promise<{ orders: BlindOrder[]; lines: number; error?: string }> {
  const byOrder = new Map<string, BlindOrder>()
  let n = 0
  for (const table of ITEM_TABLES) {
    const spec = LABEL[table]
    let q: any = db.from(table).select(`${BASE}, ${spec.cols}`)
      .not('order_number', 'is', null)
      .is('delivered_at', null)
      .eq('picked_up', false)
      .not('payment_date', 'is', null)
      .is('cancel_status', null)
      .or('nature.is.null,nature.eq.PART')
    if (table === 'staff_expenses') q = q.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)
    const { data, error } = await q.range(0, 4999)
    if (error) return { orders: [], lines: 0, error: `${table}: ${error.message}` }
    for (const r of (data || []) as any[]) {
      const amount = spec.amount(r)
      if (!isBlindTracking({ ...r, amount })) continue
      const order = String(r.order_number).trim()
      const store = blindStore(r.supplier, order)
      const key = `${store || r.supplier || ''}|${order}`
      if (!byOrder.has(key)) byOrder.set(key, { store, supplier: r.supplier || '', order_number: order, url: store ? storeOrderUrl(store, order) : null, last_checked: null, lines: [] })
      byOrder.get(key)!.lines.push({ table, id: r.id, item: String(r[spec.label] || '—').slice(0, 160), amount, payment_date: r.payment_date, last_event: r.last_event, eta: r.eta, store_checked_at: r.store_checked_at })
      n++
    }
  }
  const orders = [...byOrder.values()]
  for (const o of orders) {
    const ts = o.lines.map(l => l.store_checked_at)
    o.last_checked = ts.some(t => !t) ? null : ts.sort()[0] || null
  }
  orders.sort((a, b) => (a.last_checked || '').localeCompare(b.last_checked || '') || String(b.lines[0]?.payment_date || '').localeCompare(String(a.lines[0]?.payment_date || '')))
  return { orders, lines: n }
}

// ── A LEITURA ───────────────────────────────────────────────────────────────
// state é a resposta da loja reduzida ao que importa AQUI:
//   DELIVERED  → chegou (delivered_at = delivered_on, ou agora se a loja não deu data)
//   MOVING     → despachado / a caminho / atrasado
//   WAITING    → pedido feito, ainda não despachado
//   PROBLEM    → cancelado, devolvido, "não entregue", disputa — NÃO mexe em
//                cancel_status (esse é fato de humano/estorno); só registra a
//                leitura, e a linha continua na fila até alguém decidir
//   UNREADABLE → a página não abriu / pedido não achado / não está logado
//                (só carimba store_checked_at: o caso foi OLHADO, não abandonado)
export type StoreReading = {
  store: BlindStore
  order_number: string
  state: 'DELIVERED' | 'MOVING' | 'WAITING' | 'PROBLEM' | 'UNREADABLE'
  status_text: string            // o que a loja escreve, curto: "Delivered October 14", "Arriving Thursday"
  delivered_on?: string | null   // YYYY-MM-DD como a loja mostra (data local de Orlando)
  eta?: string | null            // YYYY-MM-DD
  tracking_number?: string | null
  carrier?: string | null
  // Pedido com várias caixas: a leitura vale só para estas linhas. Sem isso,
  // vale para TODAS as linhas cegas daquele pedido.
  lines?: { table: ItemTable; id: string }[]
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
// "Delivered October 14" é data de Orlando, sem hora. Grava-se 16:00 UTC (meio-dia
// EDT, 11h EST) — longe da meia-noite nos dois fusos, então o dia nunca pula ao
// ser mostrado (AGENTS.md, motivo 1 do relógio).
const noonOrlando = (d: string) => `${d}T12:00:00-04:00`

export async function applyReading(db: SupabaseClient, rd: StoreReading): Promise<{ ok: boolean; updated: string[]; delivered: number; skipped: string[]; dataFixesLogged: boolean; error?: string }> {
  const out = { ok: true, updated: [] as string[], delivered: 0, skipped: [] as string[], dataFixesLogged: true }
  if (!BLIND_OK.has(rd.store)) return { ...out, ok: false, error: `store must be one of ${[...BLIND_OK].join(', ')}` }
  if (!String(rd.order_number || '').trim()) return { ...out, ok: false, error: 'order_number missing' }
  if (!STATES.has(rd.state)) return { ...out, ok: false, error: `state must be one of ${[...STATES].join(', ')}` }
  if (rd.delivered_on && !DAY.test(rd.delivered_on)) return { ...out, ok: false, error: 'delivered_on must be YYYY-MM-DD' }
  if (rd.eta && !DAY.test(rd.eta)) return { ...out, ok: false, error: 'eta must be YYYY-MM-DD' }

  const { orders, error } = await listBlind(db)
  if (error) return { ...out, ok: false, error }
  const order = orders.find(o => o.store === rd.store && o.order_number === rd.order_number.trim())
  if (!order) return { ...out, ok: false, error: `no open blind line for ${rd.store} ${rd.order_number}` }
  const wanted = rd.lines?.length ? new Set(rd.lines.map(l => `${l.table}/${l.id}`)) : null
  const targets = order.lines.filter(l => !wanted || wanted.has(`${l.table}/${l.id}`))
  if (wanted) for (const w of wanted) if (!targets.some(t => `${t.table}/${t.id}` === w)) out.skipped.push(`${w}: não é linha cega aberta deste pedido`)

  const now = new Date().toISOString()
  const text = `${rd.store}: ${String(rd.status_text || '').trim().slice(0, 300) || rd.state}`
  for (const l of targets) {
    // Relê a linha inteira: o que a fila trouxe pode ter mudado no meio.
    const { data: cur, error: e1 } = await db.from(l.table).select('id, delivered_at, tracking_number, carrier, eta, last_event').eq('id', l.id).maybeSingle()
    if (e1 || !cur) { out.skipped.push(`${l.table}/${l.id}: ${e1?.message || 'sumiu'}`); continue }
    const patch: Record<string, unknown> = { store_checked_at: now }
    if (rd.state !== 'UNREADABLE' && text !== cur.last_event) patch.last_event = text
    if (rd.eta && rd.eta !== cur.eta && rd.state !== 'DELIVERED') patch.eta = rd.eta
    const trk = String(rd.tracking_number || '').trim()
    if (trk && !String(cur.tracking_number || '').trim()) {
      patch.tracking_number = trk
      if (rd.carrier && !String(cur.carrier || '').trim()) patch.carrier = String(rd.carrier).trim()
    }
    if (rd.state === 'DELIVERED' && !cur.delivered_at) {
      patch.delivered_at = rd.delivered_on ? new Date(noonOrlando(rd.delivered_on)).toISOString() : now
      patch.last_event_at = patch.delivered_at
    }
    const { error: e2 } = await db.from(l.table).update(patch).eq('id', l.id).is('delivered_at', null)
    if (e2) { out.skipped.push(`${l.table}/${l.id}: ${e2.message}`); continue }
    // store_checked_at não vai para data_fixes: é carimbo de «olhei», não dado
    // da compra — logá-lo encheria a trilha com uma linha por dia por pedido.
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'store_checked_at') continue
      const { error: e3 } = await db.from('data_fixes').insert({
        check_key: 'store-check',
        table_name: l.table,
        row_id: l.id,
        field,
        old_value: (cur as any)[field] == null ? null : String((cur as any)[field]),
        new_value: value == null ? null : String(value),
        label: `RASTREIO CEGO (LIVRO 13.10) — leitura da página do pedido ${rd.store} ${rd.order_number}: «${text}»`,
      })
      if (e3) out.dataFixesLogged = false
    }
    out.updated.push(`${l.table}/${l.id}: ${Object.keys(patch).join(', ')}`)
    if (patch.delivered_at) out.delivered++
  }
  return out
}

const BLIND_OK = new Set<string>(['AMAZON', 'EBAY', 'TEMU'])
const STATES = new Set<string>(['DELIVERED', 'MOVING', 'WAITING', 'PROBLEM', 'UNREADABLE'])
