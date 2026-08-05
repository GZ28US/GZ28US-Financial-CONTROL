// The app's base path (Next.js basePath). Prefix raw <a href>, fetch('/api/...')
// and <img src> with this; next/link and next/router already include it.
export const BASE_PATH = '/ca'

// PAID VIA options for income everywhere in the app. GZ28BR = paid through the
// Brazil entity (an extra R$ amount is recorded alongside the USD).
export const PAID_VIA_OPTIONS = ['CASH', 'ACH', 'ZELLE', 'CHECK', 'GZ28BR']

export function formatUSD(amount: number): string {
  // A value that rounds to zero at 2 decimals must never render as "-$0.00" — that minus
  // is just floating-point residue from subtractions (e.g. a pending balance). Snap to 0.
  const v = Math.abs(amount) < 0.005 ? 0 : amount
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(v)
}

// Universal short date format. US is month-first: MM/DD/YY. Input is an ISO
// 'YYYY-MM-DD' (extra time part tolerated); anything else returns ''.
export function formatShortDate(d: string | null | undefined): string {
  if (typeof d !== 'string') return ''
  const m = d.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : ''
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

// Display code for a client: US.### (project) / US.QT.### (quote) / SHP.### (shop).
export function clientCode(c: { is_quote?: boolean | null; client_number: number | null; origin?: string | null }): string {
  const num = c.client_number != null ? pad3(c.client_number) : '—'
  if (c.origin === 'SHOP') return `SHP.${num}`
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

// Display a phone number in its country's format:
//   BR  +55 (11) 98121.5678  (mobile)  /  +55 (11) 3121.5678  (landline)
//   US  +1 (321) 315.0973
// `country` ('BRAZIL' | 'USA') forces the format; otherwise it's inferred from the
// digits (leading 55 with 12-13 digits => Brazil, else US). Unknown shapes return
// the original string untouched.
export function formatPhone(phone: string | null | undefined, country?: string | null): string {
  if (!phone) return ''
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return String(phone)
  const isBR = country === 'BRAZIL' || (!country && digits.startsWith('55') && digits.length > 11)
  if (isBR) {
    const local = digits.startsWith('55') ? digits.slice(2) : digits
    if (local.length === 11) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}.${local.slice(7)}`
    if (local.length === 10) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 6)}.${local.slice(6)}`
    return String(phone)
  }
  // US (default)
  const local = (digits.startsWith('1') && digits.length === 11) ? digits.slice(1) : digits
  if (local.length === 10) return `+1 (${local.slice(0, 3)}) ${local.slice(3, 6)}.${local.slice(6)}`
  return String(phone)
}

// Punctuation-insensitive, word-order-tolerant search match. Splits the query into
// tokens (letters/digits only) and matches only when EVERY token appears across the
// given fields — so "DragPack Setup Welds" finds "…DragPack Setup - Welds…".
export function partMatches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const q = norm(query).trim()
  if (!q) return true
  const hay = fields.map(norm).join(' ')
  return q.split(' ').filter(Boolean).every((tok) => hay.includes(tok))
}

// Part STATUS — exactly ONE per part (user law 05/aug/2026: "it can't be both").
// LOCKED lives in source_type at the same level as SCAN / HUNT / MANUAL: locking a
// part SETS its status to LOCKED, replacing the provenance status. Null/legacy
// source_type reads as SCANNED (rows that predate source tagging).
export const isLockedPart = (p: { source_type?: string | null } | null | undefined) => p?.source_type === 'LOCKED'
export function partStatusBadge(p: { source_type?: string | null; is_kit?: boolean | null }): { label: string; cls: string } {
  if (p?.source_type === 'LOCKED') return { label: '🔒 LOCKED', cls: 'bg-purple-800 text-purple-100' }
  if (p?.is_kit) return { label: '📦 KIT', cls: 'bg-teal-600 text-white' }
  if (p?.source_type === 'HUNT') return { label: '🎯 HUNTED', cls: 'bg-yellow-600 text-black' }
  if (p?.source_type === 'MANUAL') return { label: '✍️ MANUALLY ENTERED', cls: 'bg-sky-700 text-white' }
  return { label: '🧾 SCANNED', cls: 'bg-purple-700 text-white' }
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

// Money-flow rows name the two GZ28 units by their SHORT CODE — GZ28BR / GZ28US — rather
// than the full legal name ("GZ28 V8 SpeedShop BR Ltda"), so an inter-company payment
// reads at a glance and both apps label it the same way. Display-only: invoices, reports
// and documents keep the legal name.
export function flowClientLabel(name: string | null | undefined): string {
  const n = String(name || "").trim()
  if (/gz28.*speed\s*shop.*\bbr\b/i.test(n)) return "GZ28BR"
  if (/gz28.*speed\s*shop.*\bus\b/i.test(n)) return "GZ28US"
  return n
}
