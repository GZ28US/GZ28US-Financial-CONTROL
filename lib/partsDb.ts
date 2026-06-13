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
}

// Enroll scanned items into parts_database. The product code is the PART NUMBER
// when present (most reliable, minimizes duplicates); otherwise the item name.
// One row per product:
//   - extras -> keep the cheapest unit_price
//   - parts  -> keep the most recent purchase (by purchase_date)
// A user-set alias is always preserved. Returns how many rows were inserted/updated.
export async function enrollParts(items: EnrollItem[], sourceType: string = 'SCAN'): Promise<number> {
  let changed = 0
  for (const raw of items) {
    const name = (raw.item || '').trim()
    const pn = (raw.part_number || '').trim()
    if (!name && !pn) continue
    const isExtra = EXTRA_WORDS.test(name)
    const price = Number(raw.unit_price) || 0
    const qtyN = Number(raw.quantity) || 1
    // Landed unit cost = unit price + per-unit share of tax + extras.
    const baseCost = price + (qtyN > 0 ? ((Number(raw.tax) || 0) + (Number(raw.extra) || 0)) / qtyN : 0)

    // Find the existing row: prefer the part number; fall back to the item name.
    // A scan that now carries a PN can adopt an earlier name-only row.
    let existing: any = null
    if (pn) {
      const { data } = await supabase.from('parts_database').select('*').ilike('part_number', pn).limit(1)
      existing = data?.[0] || null
      if (!existing && name) {
        const { data: d2 } = await supabase.from('parts_database').select('*').ilike('item', name).is('part_number', null).limit(1)
        existing = d2?.[0] || null
      }
    } else if (name) {
      const { data } = await supabase.from('parts_database').select('*').ilike('item', name).limit(1)
      existing = data?.[0] || null
    }

    const row: any = {
      item: name || existing?.item || pn,
      part_number: pn || existing?.part_number || null,
      supplier: raw.supplier || null,
      unit_price: price,
      base_cost: baseCost,
      tax: Number(raw.tax) || 0,
      extra: Number(raw.extra) || 0,
      quantity: Number(raw.quantity) || 1,
      item_discount: Number(raw.item_discount) || 0,
      purchase_date: raw.purchase_date || null,
      is_extra: isExtra,
      receipt_url: raw.receipt_url || null,
      updated_at: new Date().toISOString(),
    }

    if (!existing) {
      // Tag the lineage on first insert (default SCAN). Never overwrite it on
      // later updates below, so a HUNT row re-touched by a scan keeps HUNTED.
      const { error } = await supabase.from('parts_database').insert([{ ...row, source_type: sourceType }])
      if (!error) changed++
      continue
    }

    let replace: boolean
    if (isExtra) {
      replace = price < (Number(existing.unit_price) || Infinity)
    } else {
      replace = (row.purchase_date || '') >= (existing.purchase_date || '')
    }
    if (replace) {
      const { error } = await supabase
        .from('parts_database')
        .update({ ...row, alias: existing.alias ?? null })
        .eq('id', existing.id)
      if (!error) changed++
    }
  }
  return changed
}
