// ── CUSTO DE MÃO DE OBRA DA CASA ────────────────────────────────────────────
//
// LEI ATUAL (Márcio, 31/ago/2026): "deixe nativo nas páginas que o custo da
// nossa hora é USD 15". A hora da casa é uma CONSTANTE, não sai mais de
// cadastro nenhum.
//
// E continua valendo: "MARKUP (grand total − expenses − staff cost)". Mão de
// obra é CUSTO — deixar de fora faz o markup contar salário como lucro.
//
// POR QUE MUDOU. Até 30/ago a taxa era lida da season aberta do membro fixo
// (o Jeff, US.006 Jeferson Ferreira), pela lei de 26/ago: "o Jeff é o único
// membro fixo daqui... consulte o valor da hora dele na season corrente".
// A season US.003 dele (BRL 15.000/mês, 9h/dia × 6d/semana) foi ENCERRADA em
// 29/ago/2026, e não sobrou nenhuma season MONTHLY aberta na casa. Resultado:
// loadFixedMember() passou a devolver null e TODO pack e TODA quote começaram
// a calcular custo de staff = ZERO, inflando o markup em silêncio.
// A hora fixa da casa mata esse buraco: não depende de quem está contratado.
//
// A taxa NÃO é copiada para pack nenhum nem para invoice nenhuma — é lida daqui
// a cada abertura de tela. Mudar a constante corrige o markup de todos os packs
// e de todas as quotes de uma vez.

/** A hora da casa, em USD. Márcio, 31/ago/2026. */
export const HOUSE_HOURLY_USD = 15

export type FixedMember = { name: string; hourly: number }

/**
 * A MÃO DE OBRA DA CASA — hoje uma taxa fixa em dólar, igual para todo pack e
 * toda quote.
 *
 * Continua `async` e com a mesma forma de retorno de quando lia a season, para
 * que as telas que já a consomem (editor de packs, editor de invoice e a view
 * da invoice) não precisem mudar nada.
 */
export async function loadFixedMember(): Promise<FixedMember | null> {
  return { name: 'House Rate', hourly: HOUSE_HOURLY_USD }
}

/** O que um punhado de horas previstas custa, à hora da casa. */
export function staffCostOf(estimatedSeconds: number, member: FixedMember | null): number {
  if (!member || !(estimatedSeconds > 0)) return 0
  return (estimatedSeconds / 3600) * member.hourly
}

/** Soma o previsto de uma lista de duties (pack ou invoice). */
export function sumEstimatedSeconds(duties: { estimated_seconds?: number | null }[] | null | undefined): number {
  return (duties || []).reduce((t, d) => t + (Number(d?.estimated_seconds) || 0), 0)
}
