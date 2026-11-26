// FLOW: UMA LINHA POR INVOICE EM CADA LISTAGEM (Márcio, 25/11/2026: «mostra um item da invoice por linha, tá errado, cada
// invoice só pode aparecer uma vez, mostrando o valor em aberto» · «isso dentro da mesma listagem, eu digo»).
// Listagem = DELAYED · UNDATED · cada marco (Goods Arrival, Project Conclusion) · cada MÊS do fluxo datado.
// Dentro de uma listagem as rendas abertas da mesma invoice viram uma linha só, com a soma; a data mostrada é a MAIS
// ANTIGA do grupo e o hover lista as parcelas. A mesma invoice pode aparecer em listagens diferentes.
// Só agrupa na tela: nenhum total muda.
type FlowRow = { code: string; amount: number; dated: boolean; date: string | null; labelTip?: string; milestone?: string; delayed?: boolean }

const listing = (r: FlowRow) => r.milestone ? `M:${r.milestone}` : r.delayed ? 'DELAYED' : r.dated && r.date ? `F:${r.date.slice(0, 7)}` : 'UNDATED'
const piece = (r: FlowRow) => `${r.date ? `${r.date.slice(8, 10)}/${r.date.slice(5, 7)} ` : ''}${r.amount.toFixed(2)}${r.labelTip ? ` ${r.labelTip}` : ''}`

/** Keeps the order of the first row of each group (the list comes sorted by date, so that is the oldest). */
export function oneRowPerInvoice<T extends FlowRow>(rows: T[]): T[] {
  const out: T[] = []
  const byKey = new Map<string, { row: T; pieces: string[] }>()
  for (const r of rows) {
    const key = `${r.code}|${listing(r)}`
    const g = byKey.get(key)
    if (!g) { const row = { ...r }; byKey.set(key, { row, pieces: [piece(r)] }); out.push(row); continue }
    g.pieces.push(piece(r))
    g.row.amount += r.amount
    if (r.date && (!g.row.date || r.date < g.row.date)) g.row.date = r.date
    g.row.labelTip = `${g.pieces.length} open payments: ${g.pieces.join(' · ')}`
  }
  return out
}
