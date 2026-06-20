import { supabase } from '@/lib/supabase'

// Insert/update a supplier row, tolerating a DB that has not yet gained an
// optional column (`discount_code` → MIGRATION_supplier_discount_code.sql;
// `instagram` → MIGRATION_supplier_instagram.sql). PostgREST rejects the whole
// write on an unknown column, so on error we retry once without those optional
// columns. This keeps supplier saving working before the migration is run, then
// carries the fields through once the columns exist.
function withoutOptional(row: Record<string, unknown>) {
  const { discount_code, instagram, ...rest } = row
  return rest
}
function hasOptional(row: Record<string, unknown>) {
  return 'discount_code' in row || 'instagram' in row
}

export async function insertSupplier(row: Record<string, unknown>) {
  const res = await supabase.from('suppliers').insert([row])
  if (res.error && hasOptional(row)) return supabase.from('suppliers').insert([withoutOptional(row)])
  return res
}

export async function updateSupplier(id: string, row: Record<string, unknown>) {
  const res = await supabase.from('suppliers').update(row).eq('id', id)
  if (res.error && hasOptional(row)) return supabase.from('suppliers').update(withoutOptional(row)).eq('id', id)
  return res
}
