import { supabase } from '@/lib/supabase'

// Items whose name matches these are "extras" (shipping/handling/etc). For the
// parts data bank we keep the CHEAPEST extra ever seen; regular parts keep the
// LAST purchase (most recent by date). Same list the parts importer skips.
export const EXTRA_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

export type EnrollItem = {
  item: string
  part_number?: string | null
  supplier?: string | null
  unit_price?: number | string
  tax?: number | string
  extra?: number | string
  quantity?: number | string
  item_discount?: number | string
  purchase_date?: string | null
  receipt_url?: string | null
  // Official-supplier invoices can print a List/Retail column (→ MAP) and
  // per-line weights — both enroll when the scan finds them.
  list_price?: number | string
  weight_lbs?: number | string
}

// Part-number normalization for dedupe: uppercase, strip every non-alphanumeric
// char (so dots/commas/spaces/dashes can't split the same number), then drop a
// leading brand/supplier token. This makes "DOD 53021585AD" == "MOPAR 53021585AD"
// and "gatK100579HD" == "K100579HD" so the same part can't enroll twice.
export function normPN(pn?: string | null): string {
  let x = String(pn || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  x = x.replace(/^(GATES|GAT|DODGE|DOD|MOPAR|NGK|ADO|IND)(?=[A-Z0-9])/, '')
  return x
}

// Unified per-unit OUR COST that decides which duplicate wins: hunt parts use the
// dealer net (our_cost), scanned/manual parts use the unit price.
function ourCostOf(r: any): number {
  const v = r?.source_type === 'HUNT' ? (r.our_cost ?? r.map_price) : (r.unit_price ?? r.base_cost)
  const n = Number(v)
  return Number.isFinite(n) ? n : Infinity
}

// Recompute the delivered/discount fields against a (constant) MAP + a cost.
function withDerived(row: any, map: number | null, cost: number): any {
  const ship = Number(row.shipping) || 0, hand = Number(row.handling) || 0
  const r2 = (n: number) => Math.round(n * 100) / 100
  const r1 = (n: number) => Math.round(n * 10) / 10
  if (map != null && Number(map) > 0 && Number.isFinite(cost)) {
    const m = Number(map)
    const mapDel = r2((m + ship + hand) * 1.065)
    const costDel = r2(cost + ship + hand)
    return {
      ...row, map_price: m, map_delivered: mapDel, cost_delivered: costDel,
      part_discount: r1((1 - cost / m) * 100), delivered_discount: r1((1 - costDel / mapDel) * 100),
    }
  }
  return { ...row, map_price: map != null ? Number(map) : null, map_delivered: null, cost_delivered: null, part_discount: null, delivered_discount: null }
}

// THE dedupe rule (hunt / scan / manual all funnel through here): a part number
// lives in the DB only ONCE. Match on the normalized part number (or item name
// when there's no PN). Insert when new; when it already exists, REPLACE only if
// the incoming OUR COST is LOWER (keep the lowest), and always preserve the
// existing MAP — the MAP is constant for a part across all three sources. The
// kept alias is preserved. Returns a status + supabase error for the caller.
export async function enrollOne(row: any): Promise<{ status: 'inserted' | 'updated' | 'kept'; error: any }> {
  const { data } = await supabase.from('parts_database')
    .select('id, item, alias, part_number, source_type, unit_price, base_cost, our_cost, map_price, shipping, handling, weight_lbs')
  const rows = data || []
  const keyOf = (r: any) => r.part_number ? normPN(r.part_number) : ('NAME:' + String(r.item || '').trim().toLowerCase())
  const key = keyOf(row)
  const existing = key ? rows.find((r: any) => keyOf(r) === key) : null

  if (!existing) {
    // A scanned MAP gets the derived delivered/discount fields computed on insert.
    const toInsert = row.map_price != null && Number(row.map_price) > 0
      ? withDerived(row, Number(row.map_price), ourCostOf(row))
      : row
    const { error } = await supabase.from('parts_database').insert([toInsert])
    return { status: 'inserted', error }
  }
  // MAP is constant: keep whichever MAP is already known (existing wins).
  const map = existing.map_price != null ? existing.map_price : (row.map_price ?? null)
  if (ourCostOf(row) < ourCostOf(existing)) {
    // Write a COMPLETE, consistent payload so no stale fields linger when the
    // winning source differs from the one on file (e.g. scan beats a prior hunt).
    const full: any = {
      item: row.item ?? existing.item,
      part_number: row.part_number ?? null,
      supplier: row.supplier ?? null,
      dealer_supplier: row.dealer_supplier ?? null,
      unit_price: row.unit_price ?? null,
      base_cost: row.base_cost ?? null,
      tax: row.tax ?? null,
      extra: row.extra ?? null,
      quantity: row.quantity ?? null,
      item_discount: row.item_discount ?? null,
      purchase_date: row.purchase_date ?? null,
      is_extra: row.is_extra ?? false,
      receipt_url: row.receipt_url ?? null,
      our_cost: row.our_cost ?? null,
      shipping: row.shipping ?? null,
      handling: row.handling ?? null,
      source_type: row.source_type ?? existing.source_type ?? null,
      alias: existing.alias ?? row.alias ?? null,
      // Weight only when the incoming scan carries one — never erase a known weight.
      ...(row.weight_lbs != null && Number(row.weight_lbs) > 0 ? { weight_lbs: row.weight_lbs } : {}),
      updated_at: new Date().toISOString(),
    }
    const merged = withDerived(full, map, ourCostOf(row))
    const { error } = await supabase.from('parts_database').update(merged).eq('id', existing.id)
    return { status: 'updated', error }
  }
  // Even when the existing (cheaper) row wins, fill in MAP and weight it lacks —
  // an official-supplier scan is authoritative for both when nothing is on file.
  const patch: any = {}
  if ((existing.map_price == null || Number(existing.map_price) <= 0) && row.map_price != null && Number(row.map_price) > 0) {
    Object.assign(patch, withDerived({ shipping: existing.shipping, handling: existing.handling }, Number(row.map_price), ourCostOf(existing)))
  }
  if ((existing.weight_lbs == null || Number(existing.weight_lbs) <= 0) && row.weight_lbs != null && Number(row.weight_lbs) > 0) {
    patch.weight_lbs = row.weight_lbs
  }
  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString()
    const { error } = await supabase.from('parts_database').update(patch).eq('id', existing.id)
    return { status: 'updated', error }
  }
  return { status: 'kept', error: null }
}

// Enroll scanned items into parts_database (product code = PART NUMBER when
// present, else item name). Each goes through enrollOne, so one row per part,
// keeping the LOWEST OUR COST with the MAP held constant. Returns rows changed.
export async function enrollParts(items: EnrollItem[], sourceType: string = 'SCAN'): Promise<number> {
  let changed = 0
  for (const raw of items) {
    const name = (raw.item || '').trim()
    const pn = (raw.part_number || '').trim()
    if (!name && !pn) continue
    const price = Number(raw.unit_price) || 0
    const qtyN = Number(raw.quantity) || 1
    // Landed unit cost = unit price + per-unit share of tax + extras.
    const baseCost = price + (qtyN > 0 ? ((Number(raw.tax) || 0) + (Number(raw.extra) || 0)) / qtyN : 0)
    const row: any = {
      item: name || pn,
      part_number: pn || null,
      supplier: raw.supplier || null,
      unit_price: price,
      base_cost: baseCost,
      tax: Number(raw.tax) || 0,
      extra: Number(raw.extra) || 0,
      quantity: Number(raw.quantity) || 1,
      item_discount: Number(raw.item_discount) || 0,
      purchase_date: raw.purchase_date || null,
      is_extra: EXTRA_WORDS.test(name),
      receipt_url: raw.receipt_url || null,
      source_type: sourceType,
      updated_at: new Date().toISOString(),
    }
    // Official-supplier extras: printed List/Retail price = the MAP; printed weight.
    const listP = Number(raw.list_price) || 0
    if (listP > 0) row.map_price = listP
    const weight = Number(raw.weight_lbs) || 0
    if (weight > 0) row.weight_lbs = weight
    const { status, error } = await enrollOne(row)
    if (!error && status !== 'kept') changed++
  }
  return changed
}
