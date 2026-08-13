// USD/BRL rate, used to PROJECT dollar figures from money that is recorded in reais.
//
// User law (13/aug/2026): "when a real life receipt is scanned, save the real BRL
// value and use the app math to project the USD amount — the BRL amount is enrolled
// FIXED, the USD amount is variable by the math rule."
//
// So a BRL document's numbers are stored exactly as printed, with parts_database.currency
// = 'BRL' marking them. No dollar figure is ever written to the row: every place that
// needs dollars (the parts list, an invoice import, a pack import) recomputes it from
// today's rate. A USD row (every legacy row — the column defaults to 'USD') is untouched
// by all of this.

const TTL_MS = 6 * 60 * 60 * 1000
const LS_KEY = 'gz28_usdbrl'

let memo: { rate: number; at: number } | null = null
let inFlight: Promise<number | null> | null = null

function readCache(): { rate: number; at: number } | null {
  if (memo) return memo
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (!raw) return null
    const c = JSON.parse(raw)
    if (Number(c?.rate) > 0 && Number(c?.at) > 0) { memo = { rate: Number(c.rate), at: Number(c.at) }; return memo }
  } catch {}
  return null
}

function writeCache(rate: number) {
  memo = { rate, at: Date.now() }
  try { localStorage.setItem(LS_KEY, JSON.stringify(memo)) } catch {}
}

// Today's commercial USD→BRL rate (how many reais one dollar buys), cached for 6h.
// If the quote can't be fetched, the last known rate is reused rather than blocking —
// a slightly stale projection beats a blank screen. Returns null only when no rate has
// ever been fetched on this device, and callers must then show the BRL figure alone.
export async function usdBrlRate(): Promise<number | null> {
  const cached = readCache()
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rate
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL')
      const j = await r.json()
      const spot = parseFloat(j?.USDBRL?.bid) || 0
      if (spot > 0) { writeCache(spot); return spot }
    } catch { /* offline / quote unavailable */ }
    return cached?.rate ?? null
  })()
  try { return await inFlight } finally { inFlight = null }
}

// Project a stored amount into USD. A USD amount passes through untouched; a BRL amount
// is divided by the live rate. Returns null when a BRL amount can't be projected because
// no rate is available — callers show the BRL figure on its own rather than a wrong dollar.
export function toUsd(value: number | string | null | undefined, currency: string | null | undefined, rate: number | null): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (String(currency || 'USD').toUpperCase() !== 'BRL') return n
  return rate && rate > 0 ? n / rate : null
}

// The currencies the parts bank accepts. A scan in anything else is refused outright
// rather than guessed at.
export const SUPPORTED_SCAN_CURRENCIES = ['USD', 'BRL']
export const isSupportedCurrency = (c: string | null | undefined) =>
  SUPPORTED_SCAN_CURRENCIES.includes(String(c || 'USD').toUpperCase().trim() || 'USD')
