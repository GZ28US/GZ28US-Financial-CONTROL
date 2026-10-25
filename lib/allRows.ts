// ════════════════════════════════════════════════════════════════════════════
// lib/allRows.ts · 25/out/2026 — LEITURA SEM TETO (mesmo arquivo do app BR)
//
// O PostgREST devolve no MÁXIMO 1.000 linhas por pedido, em silêncio. Uma soma que lê
// uma tabela maior que isso soma só um pedaço (no BR o CURRENT mostrava LOSS −251.870,66
// em vez de −1.454.713,41 — auditoria da AutoBook BR, 25/10). Toda leitura que SOMA uma
// tabela inteira, ou uma janela que pode passar de 1.000 linhas, vem por aqui: páginas
// de 1.000, ordem por id (desempate estável entre páginas), até a página vir incompleta.
//
// Uso: const { data } = await allRows(() => supabase.from('x').select('...').gte(...))
// O construtor é uma FUNÇÃO porque cada página precisa de um pedido novo.

const PAGE = 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allRows<T = any>(build: () => any): Promise<{ data: T[]; error: { message: string } | null }> {
  const data: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await build().order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) return { data, error }
    data.push(...((page || []) as T[]))
    if (!page || page.length < PAGE) return { data, error: null }
  }
}
