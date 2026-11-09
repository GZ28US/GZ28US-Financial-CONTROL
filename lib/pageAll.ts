// Leitura paginada do PostgREST: o Supabase corta em 1000 linhas por pedido, em
// silêncio. Uma tabela que passou de 1000 (fixed_cost_expenses tinha 1.170 em
// 09/11/2026) faz um gerador "idempotente" achar meses vazios e recriar linhas
// que já existem: dívida-fantasma na HOME e no FUTURE. Toda leitura que precisa
// da tabela INTEIRA passa por aqui.
// O builder do Supabase tem generics profundos demais para tipar (TS2589);
// `any` aqui é deliberado e local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pageAll(build: () => any, page = 1000): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await build().order('id').range(from, from + page - 1)
    // Erro no meio da leitura: falha alto em vez de devolver meia tabela
    // (meia tabela é exatamente o que cria as linhas-fantasma).
    if (error) throw new Error('pageAll: ' + (error.message || String(error)))
    const rows = data || []
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}
