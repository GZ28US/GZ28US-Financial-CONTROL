import { NextRequest, NextResponse } from 'next/server'
import { itemsDb } from '@/lib/itemTracking.server'
import { listBlind, applyReading, type StoreReading } from '@/lib/storeCheck.server'
import { readKeyOk } from '@/lib/apiAuth.server'

// ── RASTREIO CEGO — A PORTA DA LEITURA DA LOJA (LIVRO 13.10, 19/10/2026) ────
//   "o robô tem que entrar na Amazon e checar a order, mas não pode
//    "abandonar" o caso, info is power" — Márcio
//
// GET  → a fila: toda linha paga, com pedido, sem rastreio e sem entrega,
//        agrupada por pedido, com a página do pedido na loja e a última leitura.
//        Mais velho primeiro (nunca lido no topo).
// POST → a sessão que leu a página do pedido no Chrome do Márcio grava a
//        leitura (corpo = StoreReading, ou { readings: StoreReading[] }).
//        DELIVERED → delivered_at; o resto → last_event + eta + store_checked_at.
//        Trilha em data_fixes, check_key 'store-check'.
// A rotina que lê as lojas: docs/ROBO-RASTREIO-CEGO.md.
//
// PORTÃO: só a chave de leitura no header x-read-key (é como as sessões rodam o
// robô de rastreio à mão). Sem anônimo: o POST escreve nas linhas de item.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const r = await listBlind(itemsDb())
  if (r.error) return NextResponse.json({ ok: false, error: r.error }, { status: 500 })
  const readable = r.orders.filter(o => o.store)
  return NextResponse.json({
    ok: true,
    lines: r.lines,
    orders: r.orders.length,
    robot_queue: readable.length,
    never_checked: readable.filter(o => !o.last_checked).length,
    queue: readable,
    // Loja que o robô ainda não lê (pedido com número mas fora de Amazon/eBay/Temu):
    // fica na lista do STREAM com o chip, para ninguém esquecer.
    other_stores: r.orders.filter(o => !o.store),
  })
}

export async function POST(req: NextRequest) {
  if (!readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const readings: StoreReading[] = Array.isArray(body?.readings) ? body.readings : body ? [body] : []
  if (!readings.length) return NextResponse.json({ ok: false, error: 'body must be a StoreReading or { readings: [...] }' }, { status: 400 })
  const db = itemsDb()
  const results = []
  for (const rd of readings.slice(0, 50)) results.push({ store: rd?.store, order_number: rd?.order_number, ...(await applyReading(db, rd)) })
  const ok = results.every(r => r.ok)
  return NextResponse.json({ ok, delivered: results.reduce((n, r) => n + r.delivered, 0), results }, { status: ok ? 200 : 207 })
}
