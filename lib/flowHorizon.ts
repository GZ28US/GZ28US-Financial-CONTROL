// O HORIZONTE DO FLUXO FUTURO (25/out/2026, Márcio: «the future flow pages should show up to December of next year or
// minimal of 6 months in front»). Fim = o MAIOR entre 31/dez do ano que vem e o fim do 6º mês à frente.
// Um lugar só: o FUTURE (gráfico + listas) e todos os geradores (custo fixo, sócios, folha) leem daqui.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function flowHorizonEnd(today = new Date()): Date {
  const dezAnoQueVem = new Date(today.getFullYear() + 1, 11, 31)
  const seisMeses = new Date(today.getFullYear(), today.getMonth() + 7, 0)
  return dezAnoQueVem > seisMeses ? dezAnoQueVem : seisMeses
}
export const flowHorizonEndYmd = (today = new Date()) => ymd(flowHorizonEnd(today))
// Quantos meses DEPOIS do corrente o horizonte cobre (out/2026 → dez/2027 = 14).
export function flowHorizonMonths(today = new Date()): number {
  const h = flowHorizonEnd(today)
  return (h.getFullYear() - today.getFullYear()) * 12 + (h.getMonth() - today.getMonth())
}
