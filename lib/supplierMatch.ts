// UM FORNECEDOR, UM NOME — módulo PURO (sem cliente Supabase, importável pelo
// browser e pelo servidor). Nasceu em lib/partsDb.ts (Márcio, 04/set/2026) e
// mudou pra cá no AUTO-BOOK fase B (BL 0.9.0): o motor do Bank Link precisa da
// MESMA chave de comparação pra escrever o nome do cadastro, nunca o texto cru
// do extrato ("Card Purchase Paypal *Summit 5533…" vira "Summit Racing Equipment").
// lib/partsDb.ts re-exporta tudo — nenhum comportamento mudou lá.

// "&" vira "and", sufixo societário cai, pontuação some. Sem isso
// "Texas Speed & Performance" e "Texas Speed and Performance" viravam dois
// fornecedores, e 28 peças ficaram sem o vínculo de official supplier.
export const normSup = (s: string) => (s || '').toLowerCase()
  .replace(/&/g, 'and')
  .replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '')

export type SupplierEntry = { name: string; keys: string[]; official: boolean }

// Diretório a partir das linhas de `suppliers` (name, aliases, is_dealership) —
// quem lê o banco (partsDb no browser, o motor no servidor) passa as linhas.
export function supplierDirectoryFrom(rows: any[] | null | undefined): SupplierEntry[] {
  return (rows || []).map((s: any) => ({
    name: s.name,
    official: s.is_dealership === true,
    keys: [s.name, ...String(s.aliases || '').split(/[\n,]/)].map(normSup).filter(Boolean),
  }))
}

// Resolve QUALQUER grafia para o fornecedor cadastrado. Primeiro a chave exata
// (nome ou alias); depois PREFIXO — uma grafia com endereço colado
// ("Titan Motorsports, 11370 Boggy Creek Rd...") ou com parêntese
// ("High Horse Performance (HHP Racing)") COMEÇA pela chave.
//
// Prefixo, e não contenção em qualquer posição: um alias do AutoZone trazia o
// endereço da loja, o split por vírgula gerou a chave "orlando", e ela casava
// no MEIO do endereço da Titan — dois candidatos, fornecedor errado no chute.
// Nome de empresa vem na frente; endereço vem depois. Exige 6+ caracteres e
// resposta ÚNICA: com duas candidatas devolve null em vez de adivinhar.
export function matchSupplier(nome: string | null | undefined, dir: SupplierEntry[]): SupplierEntry | null {
  const n = normSup(String(nome || ''))
  if (!n) return null
  const exato = dir.find(d => d.keys.includes(n))
  if (exato) return exato
  const prefixo = dir.filter(d => d.keys.some(k => k.length >= 6 && (n.startsWith(k) || k.startsWith(n))))
  return prefixo.length === 1 ? prefixo[0] : null
}
