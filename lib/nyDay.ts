// An Orlando calendar day → the exact instant it starts/ends, with the real offset of THAT day (EST −05:00 or EDT −04:00).
// Law of the clock (AGENTS.md): never hardcode the offset.
export function nyOffset(day: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`)).find(x => x.type === 'timeZoneName')?.value || 'GMT-05:00'
  return part.replace('GMT', '') || '+00:00'
}
export const nyStart = (day: string) => new Date(`${day}T00:00:00${nyOffset(day)}`)
export const nyEnd = (day: string) => new Date(`${day}T23:59:59${nyOffset(day)}`)
