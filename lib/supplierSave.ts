import { supabase } from '@/lib/supabase'
import { supplierNameForRegistry } from '@/lib/supplierGuard'
import { primeCarRegistry } from '@/lib/carRegistry'

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

// ── GUARDA DO FORNECEDOR (Márcio, 30/ago/2026) ──────────────────────────────
//   "os carros, mesmo aparecendo como SUPPLIER nas expenses quando doaram algo,
//    JAMAIS podem ser cadastrados como supplier no banco. Nao permita que isso
//    aconteca, sem poluir o banco. Isso e FEATURE, nao campo."
// O carro CONTINUA no campo supplier da linha da expense — é o doador, e é lá o
// lugar dele. O que não pode é virar LINHA na tabela suppliers. Esta é a porta
// do cadastro manual (tela ADM → SUPPLIERS), então a guarda mora aqui também.
export async function insertSupplier(row: Record<string, unknown>) {
  // Ensina os carros à guarda antes de perguntar: sem isso ela só reconhece o
  // CÓDIGO ("US.040 — HellMonster") e deixa passar o NOME COMERCIAL do carro.
  await primeCarRegistry(supabase)
  if (!supplierNameForRegistry(row?.name as string)) {
    return { data: null, error: { message: 'Carro não pode ser cadastrado como fornecedor (lei de 30/ago/2026): o código do ride fica no campo supplier da linha da expense, nunca na tabela suppliers.' } } as any
  }
  const res = await supabase.from('suppliers').insert([row])
  if (res.error && hasOptional(row)) return supabase.from('suppliers').insert([withoutOptional(row)])
  return res
}

export async function updateSupplier(id: string, row: Record<string, unknown>) {
  await primeCarRegistry(supabase)
  // Mesma guarda no UPDATE: renomear um fornecedor existente para o código de um
  // carro entraria pela janela o que a porta barrou.
  if (!supplierNameForRegistry(row?.name as string)) {
    return { data: null, error: { message: 'Carro não pode ser cadastrado como fornecedor (lei de 30/ago/2026).' } } as any
  }
  const res = await supabase.from('suppliers').update(row).eq('id', id)
  if (res.error && hasOptional(row)) return supabase.from('suppliers').update(withoutOptional(row)).eq('id', id)
  return res
}
