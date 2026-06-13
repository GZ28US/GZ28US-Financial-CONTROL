// The app's base path (Next.js basePath). Prefix raw <a href>, fetch('/api/...')
// and <img src> with this; next/link and next/router already include it.
export const BASE_PATH = '/ca'

// PAID VIA options for income everywhere in the app. GZ28BR = paid through the
// Brazil entity (an extra R$ amount is recorded alongside the USD).
export const PAID_VIA_OPTIONS = ['CASH', 'ACH', 'ZELLE', 'CHECK', 'GZ28BR']

export function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

// Entity-code prefix for this app (US.### projects, US.QT.### quotes).
export const CODE_PREFIX = 'US'

export function pad3(n: number): string { return String(n).padStart(3, '0') }

// Display code for a client: US.### (project) / US.QT.### (quote).
export function clientCode(c: { is_quote?: boolean | null; client_number: number | null }): string {
  const num = c.client_number != null ? pad3(c.client_number) : '—'
  return `${CODE_PREFIX}.${c.is_quote ? 'QT.' : ''}${num}`
}