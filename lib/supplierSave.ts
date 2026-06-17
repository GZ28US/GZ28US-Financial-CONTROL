import { supabase } from '@/lib/supabase'

// Insert/update a supplier row, tolerating a DB that has not yet gained the
// `discount_code` column (MIGRATION_supplier_discount_code.sql). PostgREST
// rejects the whole write on an unknown column, so on error we retry once
// without discount_code. This keeps supplier saving working before the
// migration is run, then carries the code through once the column exists.
function withoutCode(row: Record<string, unknown>) {
  const { discount_code, ...rest } = row
  return rest
}

export async function insertSupplier(row: Record<string, unknown>) {
  const res = await supabase.from('suppliers').insert([row])
  if (res.error && 'discount_code' in row) return supabase.from('suppliers').insert([withoutCode(row)])
  return res
}

export async function updateSupplier(id: string, row: Record<string, unknown>) {
  const res = await supabase.from('suppliers').update(row).eq('id', id)
  if (res.error && 'discount_code' in row) return supabase.from('suppliers').update(withoutCode(row)).eq('id', id)
  return res
}
