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
// when there's no PN). Insert when new. When it already exists:
//   REAL LIFE PREVAILS — a SCANNED invoice is the ground truth. The flow is
//   hunt → quote → deal → purchase → real invoice, so a scan ALWAYS replaces
//   whatever an earlier date put on file (hunt, manual, older scan); between
//   two scans the NEWER purchase date wins; hunt/manual never beats a scan.
//   Extras (shipping/tax rows) keep the CHEAPEST ever seen; hunt-vs-hunt keeps
//   the lowest cost. The kept alias is preserved; a known weight is never erased.
export async function enrollOne(row: any): Promise<{ status: 'inserted' | 'updated' | 'kept'; error: any }> {
  const { data } = await supabase.from('parts_database')
    .select('id, item, alias, part_number, source_type, unit_price, base_cost, our_cost, map_price, shipping, handling, weight_lbs, purchase_date, is_extra')
  const rows = data || []
  const keyOf = (r: any) => r.part_number ? normPN(r.part_number) : ('NAME:' + String(r.item || '').trim().toLowerCase())
  // Two part numbers are the SAME part when the normalized forms match exactly OR
  // one ends with the other (shorter side ≥ 6 chars) — catches brand-prefix
  // variants the strip list doesn't know (e.g. "JLTCAI755184" vs "CAI755184").
  const samePN = (a: string, b: string) => {
    if (!a || !b) return false
    if (a === b) return true
    if (a.startsWith('NAME:') || b.startsWith('NAME:')) return false
    const min = Math.min(a.length, b.length)
    return min >= 6 && (a.endsWith(b) || b.endsWith(a))
  }
  const key = keyOf(row)
  const existing = key ? rows.find((r: any) => samePN(keyOf(r), key)) : null

  if (!existing) {
    // A scanned MAP gets the derived delivered/discount fields computed on insert.
    const toInsert = row.map_price != null && Number(row.map_price) > 0
      ? withDerived(row, Number(row.map_price), ourCostOf(row))
      : row
    const { error } = await supabase.from('parts_database').insert([toInsert])
    return { status: 'inserted', error }
  }

  // Who wins the row?
  const dateOf = (r: any) => { const t = Date.parse(String(r?.purchase_date || '')); return Number.isFinite(t) ? t : 0 }
  const isExtra = !!(row.is_extra || existing.is_extra)
  let replace: boolean
  if (isExtra) replace = ourCostOf(row) < ourCostOf(existing)                 // extras: cheapest ever
  else if (row.source_type === 'SCAN') replace = existing.source_type !== 'SCAN' || dateOf(row) >= dateOf(existing) // real life prevails; newest scan wins
  else if (existing.source_type === 'SCAN') replace = false                   // hunt/manual never beats a real invoice
  else replace = ourCostOf(row) < ourCostOf(existing)                         // hunt vs hunt: lowest cost

  // MAP: a winning SCAN that carries a retail (printed List or supplier-discount
  // derived) overrides the stored MAP — real life re-validates it. Otherwise the
  // known MAP stays constant.
  const map = replace && row.source_type === 'SCAN' && Number(row.map_price) > 0
    ? Number(row.map_price)
    : (existing.map_price != null ? existing.map_price : (row.map_price ?? null))
  if (replace) {
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
  // Even when the existing row wins (newer scan on file / cheaper extra), fill in
  // MAP and weight it lacks — an official-supplier scan is authoritative for both.
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

// Registered-supplier directory (name + aliases → discount/dealer info). An
// official supplier's purchase enrolls WITH the dealer identity and discount;
// when the invoice prints no List price, the retail (MAP) is derived from the
// supplier's fixed discount (paid ÷ (1 − disc%)).
async function supplierDirectory(): Promise<Array<{ name: string; keys: string[]; discount: number; fixed: boolean; dealer: boolean }>> {
  const normSup = (s: string) => (s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '').replace(/[^a-z0-9]/g, '')
  try {
    const { data } = await supabase.from('suppliers').select('name, aliases, discount, discount_type, is_dealership')
    return (data || []).map((s: any) => ({
      name: s.name,
      keys: [s.name, ...String(s.aliases || '').split(/[\n,]/)].map(normSup).filter(Boolean),
      discount: Number(s.discount) || 0,
      fixed: s.discount_type !== 'VARIABLE',
      dealer: !!s.is_dealership,
    }))
  } catch { return [] }
}

// Enroll scanned items into parts_database (product code = PART NUMBER when
// present, else item name). Each goes through enrollOne, so one row per part —
// a SCAN (real-life invoice) overrides older data; see enrollOne. Returns rows changed.
export async function enrollParts(items: EnrollItem[], sourceType: string = 'SCAN'): Promise<number> {
  const directory = await supplierDirectory()
  const normSup = (s: string) => (s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '').replace(/[^a-z0-9]/g, '')
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
    // Official supplier: register the dealer identity + discount. No printed List
    // price → derive the retail (MAP) from the supplier's registered fixed discount.
    const sup = raw.supplier && !row.is_extra ? directory.find(d => d.keys.includes(normSup(String(raw.supplier)))) : null
    if (sup) {
      row.dealer_supplier = sup.name
      if (!(listP > 0) && sup.fixed && sup.discount > 0 && price > 0) {
        row.map_price = Math.round((price / (1 - sup.discount / 100)) * 100) / 100
        if (!row.item_discount) row.item_discount = sup.discount
      }
    }
    const { status, error } = await enrollOne(row)
    if (!error && status !== 'kept') changed++
  }
  return changed
}
