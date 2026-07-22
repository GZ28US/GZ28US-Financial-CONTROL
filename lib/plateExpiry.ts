// ── License plate / registration renewal ────────────────────────────────────────
// Every ride can carry the date its registration (tag) expires. The app watches it so
// a plate never goes stale unnoticed — HOME shows what is expiring or already expired,
// and the ride page shows the status with the renewal link.
//
// Florida renews through the state portal (FLHSMV MyDMV) or the county tax collector;
// Orange County (Orlando, where GZ28US is) also offers same-day pickup via Tag Express.

export const PLATE_RENEWAL_URL = 'https://mydmvportal.flhsmv.gov/Home/en/ExpressRenew/Landing'
export const PLATE_RENEWAL_COUNTY_URL = 'https://www.octaxcol.com/motor-vehicles/registration-tag-renewals/'

// Warn this many days before the expiry date.
export const PLATE_WARN_DAYS = 60

export type PlateStatus = {
  state: 'none' | 'ok' | 'due' | 'expired'
  days: number      // days until expiry (negative once expired)
  label: string     // short badge text
  cls: string       // badge colour classes
}

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(fromYmd + 'T00:00:00').getTime()
  const b = new Date(toYmd + 'T00:00:00').getTime()
  return Math.round((b - a) / 86400000)
}

// Florida registrations are valid THROUGH the last day of the expiry month, so a plate
// stamped "Jun/26" is only late from July 1st — compare against the month's last day.
export function plateStatus(expiry: string | null | undefined): PlateStatus {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { state: 'none', days: 0, label: '', cls: '' }
  const d = new Date(expiry + 'T00:00:00')
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const effective = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`
  const days = daysBetween(todayYmd(), effective)
  if (days < 0) {
    const late = Math.abs(days)
    return { state: 'expired', days, label: `EXPIRED — ${late} ${late === 1 ? 'day' : 'days'} late`, cls: 'bg-red-900 text-red-300' }
  }
  if (days <= PLATE_WARN_DAYS) {
    return { state: 'due', days, label: `RENEW — ${days} ${days === 1 ? 'day' : 'days'} left`, cls: 'bg-amber-900 text-amber-300' }
  }
  return { state: 'ok', days, label: 'OK', cls: 'bg-green-900 text-green-300' }
}

// "Jun 2026" — how a plate sticker reads.
export function fmtPlateExpiry(expiry: string | null | undefined): string {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return '—'
  const d = new Date(expiry + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
