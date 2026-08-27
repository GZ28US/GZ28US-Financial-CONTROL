// ── CÂMBIO COMERCIAL DO DIA ─────────────────────────────────────────────────
//
// LEI (Márcio, 26/ago/2026): "Se o membro tiver seu valor definido em R$, esta é
// a âncora, o app deve mostrar os valores em USD pelo câmbio comercial do dia,
// isso deve ser dinâmico até ser pago, pagou, fica o valor pago, pra todos os em
// aberto, sempre dinâmico pelo câmbio comercial do dia."
//
// Traduzindo pro banco, numa linha de staff ancorada em reais (`amount_brl`):
//   • EM ABERTO (payment_date NULL) → o dólar é uma PROJEÇÃO. Recalcula-se no
//     câmbio de hoje toda vez que a tela abre. `expenses.amount` é só a última
//     foto, e não manda.
//   • PAGA (payment_date preenchido) → o dólar CONGELA no que saiu de fato.
//     `expenses.amount` vira o valor real e nunca mais é reconvertido.
//
// Antes disto cada arquivo buscava a cotação por conta própria — staffPayroll,
// future, scanFile, brShoppingMirror — cada um com seu try/catch e sem cache.
// Este módulo é o único lugar que fala com a fonte.

// Cotação comercial (bid) da AwesomeAPI, a mesma que o resto do app já usava.
const FONTE = 'https://economia.awesomeapi.com.br/json/last/USD-BRL'

// Cache de processo. A cotação comercial não se move o suficiente em 10 minutos
// para valer uma chamada por componente — e uma tela de seasons pode pedir a
// mesma cotação dezenas de vezes no mesmo render.
const TTL_MS = 10 * 60 * 1000
let cache: { spot: number; at: number } | null = null
let voando: Promise<number | null> | null = null

/**
 * Quantos REAIS vale 1 dólar, no comercial de hoje.
 * Devolve `null` quando a fonte não responde — NUNCA um número inventado.
 */
export async function usdBrlSpot(): Promise<number | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.spot
  // Chamadas concorrentes compartilham o mesmo voo em vez de disparar N fetches.
  if (voando) return voando
  voando = (async () => {
    try {
      const r = await fetch(FONTE)
      const j: any = await r.json()
      const spot = parseFloat(j?.USDBRL?.bid) || 0
      if (spot > 0) { cache = { spot, at: Date.now() }; return spot }
      return null
    } catch {
      return null
    } finally {
      voando = null
    }
  })()
  return voando
}

/** A última cotação já buscada nesta sessão, sem ir à rede. */
export function usdBrlCached(): number | null {
  return cache ? cache.spot : null
}

type MoneyRow = {
  amount?: number | null
  amount_brl?: number | null
  payment_date?: string | null
}

/**
 * O valor em DÓLAR de uma linha, seguindo a lei acima.
 *
 * @param spot cotação de hoje (de `usdBrlSpot()`), ou null se a fonte caiu.
 *
 * Linha PAGA, ou linha sem âncora em reais, ou fonte fora do ar → devolve o
 * `amount` gravado. Linha EM ABERTO ancorada em reais → converte agora.
 */
export function usdOf(row: MoneyRow, spot: number | null): number {
  const gravado = Number(row?.amount) || 0
  const brl = Number(row?.amount_brl) || 0
  if (brl <= 0) return gravado          // não é ancorada em reais
  if (row?.payment_date) return gravado // pagou → congelou
  if (!spot || spot <= 0) return gravado // sem cotação, mostra a última foto
  return brl / spot
}

/** true quando a linha é uma projeção que se move com o câmbio. */
export function usdIsLive(row: MoneyRow): boolean {
  return (Number(row?.amount_brl) || 0) > 0 && !row?.payment_date
}
