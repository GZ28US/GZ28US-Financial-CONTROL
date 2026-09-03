// MULTA POR ATRASO — um lugar só, para toda tela que mostra vencimento.
//
// A regra mora no FORNECEDOR (fixed_cost_suppliers), porque é cláusula de
// contrato, não do boleto: quatro campos NULLABLE, e nulo em todos = fornecedor
// sem multa contratada (a maioria tem, mas nem todos — decisão do Márcio,
// 3/set/2026). O vencimento continua sendo UM campo só no app inteiro, o
// `expense_date` da linha de despesa — nada aqui cria um segundo.
//
//   multa = max(late_fee_fixed, late_fee_percent% × valor)
//         + late_fee_daily × dias de atraso DEPOIS da tolerância
//
// A tolerância (`late_grace_days`) conta DEPOIS do vencimento: pagar dentro dela
// é pagar em dia. Os dois contratos que originaram isto, lidos cláusula a
// cláusula (não de cabeça):
//
// • LUMA HEADWATERS apt 01-306, §1.j: "Rent is due on or before the 1st day of
//   the month and late charges are assessed if all rent is not paid on or before
//   the 3rd day" → vence dia 1, em dia até o dia 3 = tolerância de 2 DIAS.
//   Multa inicial $100 + $10/dia "for each day after that date", e §11.b crava o
//   teto: "Daily late charges will not exceed 15 days for any single month's
//   Rent" → daily_cap_days = 15 (sem o teto, um atraso de 60 dias projetaria
//   $600 de diária onde o contrato limita a $150).
//   Confirmado na vida real: setembro venceu 01/set e foi pago 03/set — dentro
//   da tolerância, e a Luma não cobrou multa nenhuma.
//
// • WAREHOUSE LEASE, §4.3: "If any monthly installment ... is not paid by the
//   third (3rd) day after such amount is due ... a late charge equal to the
//   greater of (a) $500 or (b) five percent (5%) of such unpaid amount" → vence
//   dia 1, em dia até o dia 4 = tolerância de 3 DIAS, e a multa é o MAIOR entre
//   os dois — daí `max`, não soma. Sem diária (o contrato cobra juros ao Default
//   Rate, que é outro animal e não entra aqui).
//
// O que esta função NÃO faz, de propósito: ela não lança multa. Multa prevista é
// AVISO, não despesa — nada disso entra no Total DUE nem no Future Flow. A multa
// real chega quando o fornecedor cobra, e aí vem no `amount` do pagamento (é o
// que o selo "FINES for Late" da página do fornecedor mede, comparando o pago
// contra o agendado).

export type LateFeeRule = {
  late_grace_days?: number | null
  late_fee_fixed?: number | null
  late_fee_percent?: number | null
  late_fee_daily?: number | null
  late_fee_daily_cap_days?: number | null
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** O fornecedor tem multa contratada? Tolerância sozinha não é multa. */
export function hasLateFee(r: LateFeeRule | null | undefined): boolean {
  if (!r) return false
  return (num(r.late_fee_fixed) || 0) > 0 || (num(r.late_fee_percent) || 0) > 0 || (num(r.late_fee_daily) || 0) > 0
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.floor((new Date(toYmd + 'T00:00:00').getTime() - new Date(fromYmd + 'T00:00:00').getTime()) / 86400000)
}

function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export type LateFeeResult = {
  /** Último dia em que ainda é pagar em dia (vencimento + tolerância). */
  graceUntil: string
  /** Dias de atraso já corridos DEPOIS da tolerância. 0 = ainda em dia. */
  daysLate: number
  /** Dias de diária que o contrato aceita cobrar (respeita o teto). */
  billableDays: number
  /** Multa que a régua do contrato dá HOJE. 0 enquanto está em dia. */
  fine: number
  /** Quanto a diária ainda soma por dia daqui pra frente (0 se bateu o teto). */
  perDay: number
  /** Havia diária E ela bateu o teto de dias. Só isto merece a palavra "capped":
   *  fornecedor sem diária nenhuma não tem nada a limitar (caso do galpão, que
   *  cobra só o maior entre $500 e 5% — dizer "capped" ali era mentira). */
  dailyCapped: boolean
  /** Dias que faltam pra multa começar a correr (0 = já correndo). */
  daysToGrace: number
  /** Frase curta da regra, pra selo e tooltip. */
  ruleLabel: string
}

/**
 * A régua do contrato aplicada a UMA conta. Devolve null quando não há multa a
 * calcular — fornecedor sem regra, ou linha sem vencimento (UNDATED não vence,
 * então não atrasa).
 */
export function lateFeeFor(
  rule: LateFeeRule | null | undefined,
  amountDue: number,
  dueYmd: string | null | undefined,
  asOfYmd: string,
): LateFeeResult | null {
  if (!hasLateFee(rule)) return null
  if (!dueYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) return null

  const grace = Math.max(0, num(rule!.late_grace_days) || 0)
  const fixed = Math.max(0, num(rule!.late_fee_fixed) || 0)
  const percent = Math.max(0, num(rule!.late_fee_percent) || 0)
  const daily = Math.max(0, num(rule!.late_fee_daily) || 0)
  const capDays = num(rule!.late_fee_daily_cap_days)

  const graceUntil = addDays(dueYmd, grace)
  const daysLate = Math.max(0, daysBetween(graceUntil, asOfYmd))
  const capped = capDays != null && capDays >= 0 ? Math.min(daysLate, capDays) : daysLate

  const base = daysLate > 0 ? Math.max(fixed, (percent / 100) * (Number(amountDue) || 0)) : 0
  const fine = daysLate > 0 ? base + daily * capped : 0

  const ruleBits: string[] = []
  if (fixed > 0 && percent > 0) ruleBits.push(`the greater of ${usd(fixed)} or ${trim(percent)}%`)
  else if (fixed > 0) ruleBits.push(usd(fixed))
  else if (percent > 0) ruleBits.push(`${trim(percent)}% of the bill`)
  if (daily > 0) ruleBits.push(`${usd(daily)}/day${capDays != null ? ` (max ${capDays} days)` : ''}`)

  return {
    graceUntil,
    daysLate,
    billableDays: capped,
    fine,
    perDay: daysLate > 0 && capDays != null && capped >= capDays ? 0 : daily,
    dailyCapped: daily > 0 && capDays != null && daysLate > 0 && capped >= capDays,
    daysToGrace: Math.max(0, daysBetween(asOfYmd, graceUntil)),
    ruleLabel: `${ruleBits.join(' + ')}${grace > 0 ? ` after ${grace} day${grace === 1 ? '' : 's'} of grace` : ' from the day after the due date'}`,
  }
}

function usd(v: number) { return `$${v % 1 === 0 ? v.toLocaleString('en-US') : v.toFixed(2)}` }
function trim(v: number) { return String(Number(v.toFixed(3))) }
