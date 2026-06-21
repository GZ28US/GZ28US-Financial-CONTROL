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

// Order income payments by their payment_date (ascending); rows with no valid
// date always sort LAST. Returns a new array. Used by every INCOME list/box.
export function orderIncomes<T extends { payment_date?: string | null }>(arr: T[]): T[] {
  const valid = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  return [...arr].sort((a, b) => {
    const av = valid(a.payment_date) ? a.payment_date : ''
    const bv = valid(b.payment_date) ? b.payment_date : ''
    if (av && bv) return av.localeCompare(bv)
    if (av) return -1
    if (bv) return 1
    return 0
  })
}

// Entity-code prefix for this app (US.### projects, US.QT.### quotes).
export const CODE_PREFIX = 'US'

export function pad3(n: number): string { return String(n).padStart(3, '0') }

// Display code for a client: US.### (project) / US.QT.### (quote).
export function clientCode(c: { is_quote?: boolean | null; client_number: number | null }): string {
  const num = c.client_number != null ? pad3(c.client_number) : '—'
  return `${CODE_PREFIX}.${c.is_quote ? 'QT.' : ''}${num}`
}

// Normalize a stored phone into the digits-only form UltraMsg expects as `to` for
// an individual WhatsApp chat, BY the client's country (both apps have clients from
// both countries). Brazil -> +55 (DDD + number; a 10/11-digit "55…" is a DDD, not
// the country code, so it still gets +55). USA (default) -> +1.
export function toWaNumber(phone: string | null | undefined, country?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (country === 'BRAZIL') {
    if (digits.startsWith('55') && digits.length >= 12) return digits
    if (digits.length === 10 || digits.length === 11) return '55' + digits
    return digits
  }
  if (digits.startsWith('1') && digits.length === 11) return digits
  if (digits.length === 10) return '1' + digits
  return digits
}

// Mask a CPF as the user types: 000.000.000-00 (keeps at most 11 digits).
export function formatCPF(raw: string): string {
  const d = (raw || '').replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

// Validate a Brazilian CPF (the two check digits). Accepts any punctuation; only
// the 11 digits matter. Rejects all-equal sequences (000.../111... are invalid).
export function isValidCPF(raw: string): boolean {
  const cpf = (raw || '').replace(/\D/g, '')
  if (cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i], 10) * (10 - i)
  let d1 = (sum * 10) % 11
  if (d1 === 10) d1 = 0
  if (d1 !== parseInt(cpf[9], 10)) return false
  sum = 0
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i], 10) * (11 - i)
  let d2 = (sum * 10) % 11
  if (d2 === 10) d2 = 0
  return d2 === parseInt(cpf[10], 10)
}