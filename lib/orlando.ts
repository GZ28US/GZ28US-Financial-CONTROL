// THE CLOCK for the quote portal (06/11/2026). Every day/time a client or the owner reads is computed here with an explicit
// time zone (AGENTS.md «O RELÓGIO»): US subjects → America/New_York; BR clients → America/Sao_Paulo. Never a hard-coded offset.
export const ORLANDO = 'America/New_York'
export const BRASILIA = 'America/Sao_Paulo'

// 'YYYY-MM-DD' of an instant in a zone (en-CA formats as ISO date).
export function dayIn(at: string | number | Date | null | undefined, tz = ORLANDO): string {
  if (at == null || at === '') return ''
  const d = new Date(at)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
export const orlandoDay = (at: string | number | Date | null | undefined) => dayIn(at, ORLANDO)
export const orlandoToday = () => dayIn(new Date(), ORLANDO)

// «Nov 6, 2026» / «6 de nov. de 2026» for a date-only value (no zone shift: the date IS the day).
export function fmtDay(ymd: string | null | undefined, lang: 'en' | 'pt' = 'en'): string {
  if (!ymd) return ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)))
}

// «Nov 6, 2026 10:12» in a zone, for timestamps (events, signatures).
export function fmtStamp(at: string | number | Date | null | undefined, lang: 'en' | 'pt' = 'en', tz = ORLANDO): string {
  if (at == null || at === '') return ''
  const d = new Date(at)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', '').replace(/ (\d{2}:\d{2})$/, ' $1')
}
