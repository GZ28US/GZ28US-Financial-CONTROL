import { supabaseBR } from '@/lib/supabaseBR'
import { supplierNameForRegistry } from '@/lib/supplierGuard'
import { primeCarRegistry, primeMirrorCarRegistry } from '@/lib/carRegistry'
import { supabase } from '@/lib/supabase'

// One-way mirror of supplier activity from the US app into the GZ28BR project's
// SEPARATE suppliers table. The two suppliers tables stay independent; this just
// makes sure every supplier touched in the US app also exists (and stays current)
// in BR.
//
// Matched by NAME, because the US and BR rows have independent ids. Every call is
// best-effort and non-blocking — wrap with `void` at the call site so a BR hiccup
// never breaks the US write. Re-runnable: the standalone backfill reconciles
// anything a transient failure missed.

// Columns always present on BR's suppliers table.
const CORE = ['name', 'discount', 'discount_type', 'aliases'] as const
// Extra columns that exist only after MIGRATION_suppliers_parity.sql has been run
// in the BR project. If they're not there yet, the write falls back to CORE.
// `is_dealership` is deliberately NOT mirrored: dealership agreements belong to
// one shop only (US or BR) and must never propagate across projects.
const EXTRA = ['account_number', 'website', 'instagram', 'seller', 'phone', 'email', 'ordering_method', 'discount_code'] as const

function pick(row: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k]
  return out
}

// Insert or update a BR supplier by name with the given fields. Pass `prevName`
// from an edit so a rename relocates the BR row instead of orphaning it.
// Writes the full field set; if BR is missing the parity columns, retries with
// just the core fields so the mirror still works before the migration is run.
export async function mirrorUpsertSupplier(row: Record<string, unknown>, prevName?: string) {
  try {
    // GUARDA DO FORNECEDOR (30/ago/2026): o espelho é um caminho de CADASTRO
    // como qualquer outro — um carro barrado no US não pode entrar no BR pela
    // porta dos fundos. E aqui a guarda tem de conhecer os carros DOS DOIS
    // bancos: o destino é a tabela suppliers do BR, e foi exatamente lá que
    // "Dodge Charger Presidiário" (ride que existe nos dois) foi parar.
    await primeCarRegistry(supabase)
    await primeMirrorCarRegistry(supabaseBR)
    const name = supplierNameForRegistry(row?.name as string)
    if (!name) return
    if (prevName && prevName.trim() && prevName.trim() !== name) {
      await supabaseBR.from('suppliers').delete().eq('name', prevName.trim())
    }
    const full = pick({ ...row, name }, [...CORE, ...EXTRA])
    const core = pick({ ...row, name }, CORE)
    const { data } = await supabaseBR.from('suppliers').select('id').eq('name', name).maybeSingle()
    const write = async (fields: Record<string, unknown>) =>
      data
        ? supabaseBR.from('suppliers').update(fields).eq('id', data.id)
        : supabaseBR.from('suppliers').insert([fields])
    const res = await write(full)
    if (res.error) await write(core)
  } catch { /* best-effort mirror */ }
}

// Ensure a BR supplier with this name exists (the name-only auto-add that
// goods/inputs do). Never overwrites an existing BR row's other fields.
export async function mirrorEnsureSupplier(name: string) {
  try {
    // GUARDA DO FORNECEDOR (30/ago/2026): carro não vira linha em suppliers,
    // nem no banco US nem no espelho BR — pelo código OU pelo nome comercial.
    await primeCarRegistry(supabase)
    await primeMirrorCarRegistry(supabaseBR)
    const n = supplierNameForRegistry(name)
    if (!n) return
    const { data } = await supabaseBR.from('suppliers').select('id').eq('name', n).maybeSingle()
    if (!data) await supabaseBR.from('suppliers').insert([{ name: n }])
  } catch { /* best-effort mirror */ }
}

// Mirror a US supplier delete.
export async function mirrorDeleteSupplier(name: string) {
  try {
    const n = String(name || '').trim()
    if (!n) return
    await supabaseBR.from('suppliers').delete().eq('name', n)
  } catch { /* best-effort mirror */ }
}
