// SCOPE DA LINHA DO PACK (Márcio, 07/10/2026: «all the info to be in the packs in packs db»; gravado pela sessão Parts & Packs).
// Cada linha de `parts`, `services`, `expenses` e `notes` diz em qual modo de venda ela vale:
//   BOTH      → nos dois (sem a chave = BOTH)
//   SHIPPED   → só no 📦 PACK SHIPPED (peças enviadas ao cliente)
//   IN_HOUSE  → só no 🚗 IN-HOUSE BUILD (o carro vem até a oficina)
//   APP_ONLY  → só no Control App (nunca aparece na loja — ex.: a nota do CatBack)
// A loja gz28us.com/shop recorta por aqui: SHIPPED = BOTH+SHIPPED · IN-HOUSE = BOTH+IN_HOUSE.
export const PACK_SCOPES = ['BOTH', 'SHIPPED', 'IN_HOUSE', 'APP_ONLY'] as const
export type PackScope = typeof PACK_SCOPES[number]

export function scopeOf(line: { scope?: unknown } | null | undefined): PackScope {
  const s = String(line?.scope || '').toUpperCase()
  return (PACK_SCOPES as readonly string[]).includes(s) ? (s as PackScope) : 'BOTH'
}

export const SCOPE_LABEL: Record<PackScope, string> = {
  BOTH: '📦🚗 BOTH',
  SHIPPED: '📦 SHIPPED',
  IN_HOUSE: '🚗 IN-HOUSE',
  APP_ONLY: '🔧 APP ONLY',
}
export const SCOPE_CLS: Record<PackScope, string> = {
  BOTH: 'bg-gray-700 text-gray-200',
  SHIPPED: 'bg-sky-800 text-sky-100',
  IN_HOUSE: 'bg-emerald-800 text-emerald-100',
  APP_ONLY: 'bg-amber-700 text-amber-50',
}

// O que a linha leva para o banco: a chave `scope` só quando a linha já tinha uma, ou quando alguém escolheu um modo que
// não é o padrão — linha antiga sem a chave continua sem ela (BOTH implícito) e não vira diff à toa.
export function scopeKey(line: { scope?: unknown } | null | undefined): { scope?: PackScope } {
  if (line == null || line.scope == null || line.scope === '') return {}
  return { scope: scopeOf(line) }
}
