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

// Countries a client address can use, in dropdown order. ENGLAND uses UK postcodes
// (letters + digits, "SW1A 1AA") and the 9 English REGIONS in the state field.
export const CLIENT_COUNTRIES = ['USA', 'BRAZIL', 'ENGLAND']

// The 9 regions of England — exactly the strings postcodes.io returns as `region`,
// so a postcode lookup always lands on one of these.
export const ENGLAND_REGIONS = [
  'East Midlands', 'East of England', 'London', 'North East', 'North West',
  'South East', 'South West', 'West Midlands', 'Yorkshire and The Humber',
]

// What an empty PHONE and the STATE field start as when the COUNTRY select changes.
export function countryDefaults(country: string): { phone: string; state: string } {
  if (country === 'BRAZIL') return { phone: '+55 ', state: 'SP' }
  if (country === 'ENGLAND') return { phone: '+44 ', state: 'London' }
  return { phone: '+1 ', state: 'FL' }
}

// Mask a UK postcode as the user types: OUTWARD + space + INWARD (the inward half is
// always the last 3 chars) — "sw1a1aa" -> "SW1A 1AA". Letters/digits only, max 7.
export function formatUKPostcode(raw: string): string {
  const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7)
  return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s
}

// True once a UK postcode is complete (outward + inward) — the point where the
// postcodes.io lookup is worth firing.
export function isUKPostcode(raw: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test((raw || '').toUpperCase().trim())
}

// Normalize a stored phone into the digits-only form UltraMsg expects as `to` for
// an individual WhatsApp chat, BY the client's country (both apps have clients from
// several countries). Brazil -> +55 (DDD + number; a 10/11-digit "55…" is a DDD, not
// the country code, so it still gets +55). England -> +44 (the national trunk "0" is
// dropped: 07911 123456 -> 447911123456). USA (default) -> +1.
export function toWaNumber(phone: string | null | undefined, country?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (country === 'BRAZIL') {
    if (digits.startsWith('55') && digits.length >= 12) return digits
    if (digits.length === 10 || digits.length === 11) return '55' + digits
    return digits
  }
  if (country === 'ENGLAND') {
    const rest = digits.startsWith('44') && digits.length >= 12 ? digits.slice(2) : digits
    const local = rest.replace(/^0/, '')
    return local.length === 9 || local.length === 10 ? '44' + local : digits
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
//   UK  +44 7911 123456      (mobile)  /  +44 20 7946 0958    (London/2-digit area)
//   US  +1 (321) 315.0973
// `country` ('BRAZIL' | 'ENGLAND' | 'USA') forces the format; otherwise it's inferred
// from the digits (leading 55/44 with 12-13 digits => Brazil/England, else US).
// Unknown shapes return the original string untouched.
export function formatPhone(phone: string | null | undefined, country?: string | null): string {
  if (!phone) return ''
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return String(phone)
  const isUK = country === 'ENGLAND' || (!country && digits.startsWith('44') && digits.length > 11)
  if (isUK) {
    // After +44 the national trunk "0" is dropped: 020 7946 0958 -> +44 20 7946 0958.
    const rest = digits.startsWith('44') && digits.length > 11 ? digits.slice(2) : digits
    const local = rest.replace(/^0/, '')
    if (local.length === 10) {
      // The area code is 2 digits for 02x (London 20, Coventry 24, Cardiff 29…) and 3 for
      // the big-city "11x"/"1x1" codes (Manchester 161, Birmingham 121…). Everything else
      // — including 07### mobiles — reads as 4 + 6.
      if (local.startsWith('2')) return `+44 ${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`
      if (/^(11\d|1[1-9]1)/.test(local)) return `+44 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`
    }
    if (local.length === 10 || local.length === 9) return `+44 ${local.slice(0, 4)} ${local.slice(4)}`
    return String(phone)
  }
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

// BASELINE packs (user law 17/aug/2026): "BoneStock" is the factory baseline; "Stock" is
// the same thing FOR THAT CAR ONLY — identical behavior everywhere (scan-only, loss deduced
// from the factory rating, purple pinned row, Build.01 always), with ONE difference:
// a Stock pull is never offered to other cars as an importable reference; BoneStock is.
export const isBaselineName = (name: string | null | undefined) => {
  const n = String(name || '').trim().toLowerCase()
  return n === 'bonestock' || n === 'stock' || n === BASELINE_PREDICTION.toLowerCase()
}

// A BASELINE PREVISTA (ordem do usuário, 17/ago/2026): carro que nunca passou no dinamômetro
// não tem linha de base — e sem ela não há meta, nem ganho, nem perda calculada. Então o
// usuário CHUTA a perda e o app deriva a baseline da potência de fábrica. Ela se comporta
// como baseline em tudo (define a perda, fixa no topo, aparece emprestada nos outros packs),
// menos numa coisa: NUNCA é oferecida a outro carro. Previsão não é prova — só a BoneStock
// escaneada (isTrueBoneStock) atravessa de um carro pro outro.
export const BASELINE_PREDICTION = 'BoneStock Prediction'
export const isPredictedBaseline = (name: string | null | undefined) =>
  String(name || '').trim().toLowerCase() === BASELINE_PREDICTION.toLowerCase()

// A BUILD's pack name states the goal in CRANK bhp: "Z1250sc Alpha170 Pack" = 1250 bhp.
// (Z = the house prefix, the number, then the aspiration: sc / na / tt.) Returns null for
// a name outside that pattern — no invented target. Shared by the builds list and the
// dyno tab so both read the same goal from the same string.
export function packTargetBhp(packName: string | null | undefined): number | null {
  const m = String(packName || '').trim().match(/^Z\s*(\d{3,4})\s*(sc|na|tt)?\b/i)
  const n = m ? parseInt(m[1], 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
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

// ── CAR DESTINY (rides.title_scope) ─────────────────────────────────────────
// One field answers two questions at once: WHO OWNS the car, and WHO HANDLES
// its paperwork. Ownership is what the financial statements run on — a client's
// car parked in our name is never our asset, no matter whose name is on the
// title — while the docs flag is what drives the plate and insurance watches.
//
//   USA     client's car that stays in the US; we hold title, plates, insurance
//   EXPORT  client's car, in our name only until it ships to Brazil
//   CLIENT  American client's car, owner handles their own docs
//   OWN     ours — the showcase & marketing fleet (Devil170, GENEZIZ, HellBull)
//   TOOL    ours — a vehicle or rig that works for the shop (RAMbo, the trailer)
//
// USA used to mean "GZ28US fleet" and was carrying our own cars; OWN and TOOL
// took that job on 19/aug/2026 so the balance sheet can tell the two apart.
// A legacy 'DEALER' value still exists on one ride and renders as OWNER HANDLES.
export const CAR_DESTINY = [
  { value: 'USA',    badge: 'USA CLIENT',   cls: 'bg-blue-900 text-blue-300',
    option: "USA CLIENT — American client's car, GZ28US holds title, plates & insurance" },
  { value: 'EXPORT', badge: 'EXPORT',       cls: 'bg-purple-900 text-purple-300',
    option: "EXPORT — client's car, in GZ28US' name until it ships to Brazil" },
  { value: 'CLIENT', badge: 'OWNER HANDLES', cls: 'bg-gray-700 text-gray-300',
    option: 'OWNER HANDLES — the client takes care of their own docs' },
  { value: 'OWN',    badge: 'GZ28US OWN',   cls: 'bg-amber-900 text-amber-300',
    option: 'GZ28US OWN — our showcase & marketing fleet (an asset, not a job)' },
  { value: 'TOOL',   badge: 'GZ28US TOOL',  cls: 'bg-emerald-900 text-emerald-300',
    option: 'GZ28US TOOL — our service vehicle or rig (depreciates like equipment)' },
] as const

export function carDestiny(scope: string | null | undefined) {
  return CAR_DESTINY.find(d => d.value === scope) || null
}

// Ours, therefore on our balance sheet: OWN as a marketing-fleet asset, TOOL as
// depreciable equipment. Everything else belongs to a client and stays off it.
export const isOurCar = (scope: string | null | undefined) => scope === 'OWN' || scope === 'TOOL'

// Cars physically here on our plates — we buy the policy, so we watch it expire.
// EXPORT is excluded: no FL title, no registration, the endorsed title just ships.
export const insuresCar = (scope: string | null | undefined) =>
  scope === 'USA' || scope === 'OWN' || scope === 'TOOL'
