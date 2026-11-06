// SERVER-ONLY — ONE total for a quote/invoice, computed on the server (06/11/2026, quote → invoice redesign).
//
// Why it exists: the Stripe webhook, the public client page and the deposit session must charge EXACTLY the number the
// view page shows, and `lib/financials.ts` is a 'use client' module. This file loads the rows with the service key and runs
// the same rulers the view page runs (app/rides/[id]/invoices/[invoiceId]/page.tsx, lines ~460-471):
//   • item line = unit_price × quantity;  service line = price;
//   • refunded/cancelled lines leave the money by lib/estorno.ts `foraDoDinheiro` (grouped by invoice, as the view does);
//   • totals by lib/flTax.ts `invoiceMoneyFor` — FL sales tax by law (car's OWNER & DESTINATION / client address / override),
//     global discount before tax.
//   • received = Σ incomes with `paid_at` (cash law); open balance = max(0, grand − received).
// Pure reads, never writes. The client page gets a curated projection built on top of this — never base_cost, expenses,
// markup or other invoices.

import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceMoneyFor, type InvoiceMoney } from './flTax'
import { foraDoDinheiro } from './estorno'

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (n: number) => Math.round(n * 100) / 100

export type InvoiceMoneyBundle = {
  invoice: Record<string, any>
  ride: Record<string, any> | null
  client: Record<string, any> | null
  items: Record<string, any>[]          // all rows, in position order (refunded ones flagged by `counts: false`)
  services: Record<string, any>[]
  notes: Record<string, any>[]
  incomes: Record<string, any>[]
  money: InvoiceMoney
  received: number
  openBalance: number
}

export async function loadInvoiceMoney(db: SupabaseClient, invoiceId: string): Promise<InvoiceMoneyBundle | null> {
  const { data: invoice, error } = await db.from('invoices').select('*').eq('id', invoiceId).maybeSingle()
  if (error) throw new Error(`invoice ${invoiceId}: ${error.message}`)
  if (!invoice) return null
  const [rideR, itemsR, servicesR, notesR, incomesR] = await Promise.all([
    invoice.ride_id ? db.from('rides').select('*').eq('id', invoice.ride_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true }),
    db.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
    db.from('invoice_notes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
    db.from('invoice_incomes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
  ])
  for (const [n, r] of [['ride', rideR], ['items', itemsR], ['services', servicesR], ['notes', notesR], ['incomes', incomesR]] as const) {
    if (r.error) throw new Error(`invoice ${invoiceId} ${n}: ${r.error.message}`)
  }
  const ride = (rideR.data as Record<string, any> | null) || null
  const clientId = invoice.client_id ?? ride?.client_id ?? null   // R-22: invoice.client_id ?? ride.client_id
  const clientR = clientId ? await db.from('clients').select('*').eq('id', clientId).maybeSingle() : { data: null, error: null }
  if (clientR.error) throw new Error(`invoice ${invoiceId} client: ${clientR.error.message}`)
  const client = (clientR.data as Record<string, any> | null) || null

  const items = (itemsR.data || []) as Record<string, any>[]
  const services = (servicesR.data || []) as Record<string, any>[]
  const itemLine = (p: Record<string, any>) => num(p.unit_price) * num(p.quantity)
  const out = foraDoDinheiro(items, itemLine, () => invoiceId)
  const live = items.filter(p => !out.has(p))
  const money = invoiceMoneyFor(invoice, ride?.title_scope, client, live.map(itemLine), services.map(s => num(s.price)))
  const incomes = (incomesR.data || []) as Record<string, any>[]
  const received = r2(incomes.filter(p => p.paid_at).reduce((s, p) => s + num(p.amount), 0))
  return {
    invoice, ride, client,
    items: items.map(p => ({ ...p, counts: !out.has(p) })),
    services, notes: (notesR.data || []) as Record<string, any>[], incomes,
    money, received, openBalance: r2(Math.max(0, money.grand - received)),
  }
}
