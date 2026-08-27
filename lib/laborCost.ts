// ── CUSTO DE MÃO DE OBRA DA CASA ────────────────────────────────────────────
//
// LEI (Márcio, 26/ago/2026): "o Jeff é o único membro fixo daqui, nos templates
// do Packs DB e depois nas quotes, são os valores dele que valem. Consulte o
// valor da hora dele na season corrente dele, use este valor pra multiplicar
// pelo número de horas somadas no template... sem campo duplicado."
//
// E: "MARKUP (grand total − expenses − staff cost)". Mão de obra é CUSTO —
// deixar de fora fazia o markup contar salário como lucro.
//
// A taxa NÃO é copiada para pack nenhum nem para invoice nenhuma: é lida da
// season corrente a cada abertura de tela. Mexer no salário corrige o markup de
// todos os packs e de todas as quotes sozinho.

import { supabase } from '@/lib/supabase'
import { seasonHourlyRate } from '@/lib/utils'
import { usdBrlSpot } from '@/lib/fx'

export type FixedMember = { name: string; hourly: number }

/**
 * O MEMBRO FIXO da casa: season ABERTA com mensalidade **e** jornada gravadas.
 * Hoje é só o Jeff. Sem taxa ou sem jornada ninguém entra — custo de hora não
 * se estima.
 *
 * Devolve a taxa SEMPRE EM USD ("sempre mostrando tudo em USD"): uma taxa em
 * reais é a âncora, e o dólar sai do comercial de hoje. Sem cotação, devolve
 * null em vez de um número torto.
 */
export async function loadFixedMember(): Promise<FixedMember | null> {
  const { data } = await supabase
    .from('seasons')
    .select('pay_type, pay_rate, pay_currency, hours_per_day, days_per_week, staff(name)')
    .is('date_conclusion', null)

  const candidatos = (data || []).filter((r: any) =>
    r.pay_type === 'MONTHLY' &&
    Number(r.pay_rate) > 0 &&
    Number(r.hours_per_day) > 0 &&
    Number(r.days_per_week) > 0)
  if (candidatos.length === 0) return null

  const r: any = candidatos[0]
  const taxa = seasonHourlyRate(r) || 0
  if (taxa <= 0) return null

  if ((r.pay_currency || 'USD') === 'BRL') {
    const spot = await usdBrlSpot()
    if (!spot || spot <= 0) return null
    return { name: r.staff?.name || '—', hourly: taxa / spot }
  }
  return { name: r.staff?.name || '—', hourly: taxa }
}

/** O que um punhado de horas previstas custa, à taxa do membro fixo. */
export function staffCostOf(estimatedSeconds: number, member: FixedMember | null): number {
  if (!member || !(estimatedSeconds > 0)) return 0
  return (estimatedSeconds / 3600) * member.hourly
}

/** Soma o previsto de uma lista de duties (pack ou invoice). */
export function sumEstimatedSeconds(duties: { estimated_seconds?: number | null }[] | null | undefined): number {
  return (duties || []).reduce((t, d) => t + (Number(d?.estimated_seconds) || 0), 0)
}
