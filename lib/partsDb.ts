import { supabase } from '@/lib/supabase'

// Items whose name matches these are "extras" (shipping/handling/etc). For the
// parts data bank we keep the CHEAPEST extra ever seen; regular parts keep the
// LAST purchase (most recent by date). Same list the parts importer skips.
export const EXTRA_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

export type EnrollItem = {
  item: string
  supplier?: string | null
  unit_price?: number | string
  tax?: number | string
  extra?: number | string
  quantity?: number | string
  item_discount?: number | string
  purchase_date?: string | null
  receipt_url?: string | null
}

// Enroll scanned items into parts_database. One row per item name (case-insensitive):
//   - extras  -> keep the cheapest unit_price
//   - parts   -> keep the most recent purchase (by purchase_date)
// A user-set alias on an existing row is always preserved. Returns how many rows
// were inserted or updated.
export async function enrollParts(items: EnrollItem[]): Promise<number> {
  let changed = 0
  for (const raw of items) {
    const name = (raw.item || '').trim()
    if (!name) continue
    const isExtra = EXTRA_WORDS.test(name)
    const price = Number(raw.unit_price) || 0

    const { data: existing } = await supabase
      .from('parts_database')
      .select('*')
      .ilike('item', name)
      .maybeSingle()

    const row: any = {
      item: name,
      supplier: raw.supplier || null,
      unit_price: price,
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
      const { error } = await supabase.from('parts_database').insert([row])
      if (!error) changed++
      continue
    }

    let replace: boolean
    if (isExtra) {
      // Cheapest wins.
      replace = price < (Number(existing.unit_price) || Infinity)
    } else {
      // Most recent purchase wins (string YYYY-MM-DD compare; equal/blank replaces
      // so the latest scan takes precedence).
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
