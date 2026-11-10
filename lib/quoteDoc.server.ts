/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the quote/invoice DOCUMENT of the portal (06/11/2026; blueprint §3, §4, §5).
//
// Two jobs:
//   1. buildRevision(): freeze what the client sees into an immutable snapshot (`invoice_revisions.document`) — the lines WITH
//      their ids (the DB lock trigger reads them), totals by law (lib/flTax via lib/invoiceMoney.server), the payment plan in
//      INTEGER CENTS (last row absorbs the rounding, Σ = round(grand × 100)), the terms text's SHA-256 in the document language.
//      `sha256` = canonical JSON of the whole document (what the client signs); `presented_sha256` = only the presented facts
//      (lines, totals, plan) — it drives the staff chip "unsent changes".
//   2. loadDocState(): everything /doc and the public page need about one document, plus its derived stage (lib/quoteStage).
//
// Nothing here writes. Nothing here messages anyone.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import { loadInvoiceMoney, type InvoiceMoneyBundle } from './invoiceMoney.server'
import { FL_TAX_STATUS_LABEL, type FlTaxStatus } from './flTax'
import { TERMS_TEXT, t, type Lang } from './quoteStrings'
import { quoteStage, type StageOut } from './quoteStage'
import { orlandoToday } from './orlando'
import { realEdition } from './utils'
import { isPackageInvoice } from './packageRule'
import { buyLink } from './buyLink'

export const COMPANY = {
  name: 'GZ28 V8 SpeedShop USA LLC',
  address: '11320 Space Blvd, 32837, Orlando / FL',                 // D-03: exactly what the printed invoice shows today
  phone: '(321) 315.0973',
  email: 'gz28us@hotmail.com',
  social: 'IG: @gz28us / @gz28br · FB: Dema De Maria',
  zelle: 'gz28us@hotmail.com',
}

// Service-role client, created at REQUEST time (never at module scope — the build runs without the key, RO-12).
export function serviceDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// Canonical JSON: object keys sorted at every level, no whitespace. Same object → same bytes → same hash.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
}

export const termsSha256 = (lang: Lang) => sha256(TERMS_TEXT[lang])

// Display code: a quote ON A PROJECT CAR has a code without ".QT." (US.032.5 — consumers #10) — shown normalised.
export function displayCode(code: string | null | undefined, isQuote: boolean): string {
  const c = String(code || '')
  if (!isQuote || c.includes('.QT.')) return c
  return c
}

export function carLabel(ride: Record<string, any> | null): string {
  if (!ride) return ''
  return [ride.year, ride.brand || ride.manufacturer, ride.model, ride.version].filter(Boolean).map(String)
    .map(s => s.replace(/\b([A-Z])([A-Z]{3,})\b/g, (_m, a: string, b: string) => a + b.toLowerCase())).join(' ').trim()
}

export function firstName(name: string | null | undefined): string {
  const n = String(name || '').trim()
  if (!n) return ''
  if (/\b(LLC|INC|LTDA|CORP|MOTORS|AUTO|GROUP|S\.A\.|EIRELI)\b/i.test(n)) return n      // a company keeps its whole name
  return n.split(/\s+/)[0]
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (n: number) => Math.round(n * 100) / 100

export type PlanRow = { id: string; seq: number; kind: string; label_key: string; label: string | null; pct: number | null; amount: number | null;
  due_rule: string; due_date: string | null; net_days: number | null; paid_to: string }
export type Terms = { invoice_id: string; valid_days: number; valid_until: string | null; fee_policy: string; rails: string[]; language: Lang;
  consent_version: string; disclosure_choice?: string | null; disclosure_limit?: number | null; parts_return_choice?: string | null }

// Plan → integer cents, Σ = round(grand × 100); the last row absorbs the rounding.
export function planCents(plan: PlanRow[], grand: number): { seq: number; cents: number }[] {
  const total = Math.round(grand * 100)
  const rows = [...plan].sort((a, b) => a.seq - b.seq)
  const out: { seq: number; cents: number }[] = []
  let used = 0
  rows.forEach((p, i) => {
    const c = i === rows.length - 1 ? total - used : (p.amount != null ? Math.round(num(p.amount) * 100) : Math.round(total * num(p.pct) / 100))
    out.push({ seq: p.seq, cents: c }); used += c
  })
  return out
}

export function planLabel(p: { label_key: string; label?: string | null; seq: number }, lang: Lang): string {
  if (p.label) return p.label
  return t(lang, 'label.' + p.label_key) + (p.label_key === 'CUSTOM' ? ` ${p.seq}` : '')
}

export type RevisionBuild = {
  document: Record<string, any>
  sha256: string; presented_sha256: string; terms_sha256: string
  grand: number; fl_tax: number; fl_status: FlTaxStatus
  problems: string[]                                 // readiness gate — empty = can SEND
}

export function buildRevision(b: InvoiceMoneyBundle, terms: Terms, plan: PlanRow[], opts: { validUntil?: string | null } = {}): RevisionBuild {
  const lang = terms.language
  const problems: string[] = []
  const inv = b.invoice, ride = b.ride, client = b.client
  const liveItems = b.items.filter(i => i.counts)
  const hasPackage = isPackageInvoice(inv, liveItems, b.services)   // lib/packageRule — same rule as the app printable
  const lineOf = (kind: 'item' | 'service', row: Record<string, any>) => {
    const unit = kind === 'item' ? num(row.unit_price) : num(row.price)
    const qty = kind === 'item' ? num(row.quantity) || 1 : 1
    const total = r2(unit * qty)
    return {
      id: String(row.id), kind, description: String(row.description || ''), unit_price: r2(unit), quantity: qty, total,
      kit_group: row.kit_group || null, kit_name: row.kit_name || null, buy_url: kind === 'item' ? buyLink(row.source_item)?.url || null : null,
      display: total !== 0 ? 'price' : (hasPackage || row.kit_group ? 'included' : 'courtesy'),
    }
  }
  const lines = [...liveItems.map(i => lineOf('item', i)), ...b.services.map(s => lineOf('service', s))]
  const m = b.money
  const grand = r2(m.grand)
  if (!(grand > 0)) problems.push('grand total is zero')
  if (!ride?.title_scope && !inv.fl_tax_override && (!client?.state && !client?.country)) problems.push('FL tax: set OWNER & DESTINATION on the car or the client address')
  const sortedPlan = [...plan].sort((a, b2) => a.seq - b2.seq)
  if (!sortedPlan.length) problems.push('payment plan is empty')
  const pctSum = sortedPlan.reduce((s, p) => s + (p.pct != null ? num(p.pct) : 0), 0)
  const amtSum = sortedPlan.reduce((s, p) => s + (p.amount != null ? num(p.amount) : 0), 0)
  if (sortedPlan.every(p => p.pct != null) && Math.abs(pctSum - 100) > 0.001) problems.push(`payment plan sums to ${pctSum}% (must be 100%)`)
  if (sortedPlan.some(p => p.amount != null) && amtSum > grand + 0.005) problems.push('payment plan amounts exceed the total')
  for (const p of sortedPlan) {
    if (p.due_rule === 'DATE' && !p.due_date) problems.push(`installment ${p.seq}: due_date missing`)
    if (p.due_rule === 'NET_DAYS' && p.net_days == null) problems.push(`installment ${p.seq}: net_days missing`)
  }
  const cents = planCents(sortedPlan, grand)
  if (cents.some(c => c.cents <= 0)) problems.push('an installment would be zero or negative')
  const installments = sortedPlan.map(p => ({
    id: p.id, seq: p.seq, kind: p.kind, label_key: p.label_key, label: p.label || null, label_text: planLabel(p, lang),
    pct: p.pct != null ? num(p.pct) : null, amount_cents: cents.find(c => c.seq === p.seq)!.cents,
    due_rule: p.due_rule, due_date: p.due_date || null, net_days: p.net_days ?? null, paid_to: p.paid_to,
  }))
  const notes = b.notes.filter(n => n.client_visible !== false).map(n => ({ id: String(n.id), text: String(n.note || '') }))
  const totals = {
    parts: r2(m.parts), services: r2(m.services), subtotal: r2(m.subtotal), discount_pct: m.discountPct, discount: r2(m.discount),
    fl_tax: r2(m.tax), fl_status: m.status, fl_label: FL_TAX_STATUS_LABEL[m.status], taxable: m.taxable, grand,
  }
  const terms_sha256 = termsSha256(lang)
  const document = {
    v: 1, kind: 'QUOTE', language: lang, invoice_id: String(inv.id),
    header: {
      code: String(inv.invoice_code || ''), display_code: displayCode(inv.invoice_code, !!inv.is_quote), service: String(inv.service || ''),
      car: carLabel(ride), client_name: String(client?.name || ''), client_first: firstName(client?.name), ride_code: ride?.project_code || null,
      parts_only: !ride, has_package: hasPackage,
    },
    // 09/11/2026 (Márcio: «do it with the current printable invoice look»): the CLIENT and VEHICLE boxes of the printable
    // invoice, frozen with the revision so the PDF still comes ONLY from the snapshot. Older revisions don't have them —
    // the PDF then prints the name / car label it always had. Quote = no project nickname (printable rule, 26/08).
    client: client ? {
      name: String(client.name || ''), address: client.address || null, city: client.city || null, state: client.state || null,
      zip: client.zip || null, country: client.country || null, phone: client.phone || null, email: client.email || null,
    } : null,
    vehicle: ride ? {
      make: [ride.manufacturer, ride.brand].filter(Boolean).join(' / ') || null,
      model: ride.model ? `${ride.model}${ride.version ? ` — ${ride.version}` : ''}${realEdition(ride.special_edition) ? ` ${realEdition(ride.special_edition)}` : ''}` : null,
      year: ride.year ? String(ride.year) : null, vin: ride.vin || null, color: ride.color || null, plate: ride.plate || null,
      mileage: inv.mileage ? Number(inv.mileage) : null,
    } : null,
    lines, notes, totals, installments,
    terms: { rails: terms.rails, fee_policy: terms.fee_policy, language: lang, consent_version: terms.consent_version, valid_days: terms.valid_days,
      valid_until: opts.validUntil ?? null, terms_sha256 },
    company: { name: COMPANY.name, address: COMPANY.address, phone: COMPANY.phone, email: COMPANY.email },
  }
  const presented = { lines: lines.map(l => [l.id, l.description, l.unit_price, l.quantity]), totals, installments: installments.map(i => [i.seq, i.amount_cents, i.paid_to]) }
  return {
    document, sha256: sha256(canonicalJson(document)), presented_sha256: sha256(canonicalJson(presented)), terms_sha256,
    grand, fl_tax: r2(m.tax), fl_status: m.status, problems,
  }
}

// ── everything about one document ─────────────────────────────────────────────
export type DocState = {
  bundle: InvoiceMoneyBundle
  terms: Terms | null
  plan: PlanRow[]
  revisions: Record<string, any>[]
  live: Record<string, any> | null
  approvals: Record<string, any>[]
  approvalOnLive: Record<string, any> | null
  links: Record<string, any>[]                // public columns only (no token)
  liveLink: Record<string, any> | null
  attempts: Record<string, any>[]             // no url
  events: Record<string, any>[]
  clientNotes: Record<string, any>[]
  stage: StageOut
  presentedDrift: boolean                     // live revision's presented facts ≠ the document now ("unsent changes")
  planDrift: number                           // hired: round(grand(live)×100) − Σ plan cents (≠ 0 → "balance ≠ plan")
  signedDrift: number                         // approval: revision grand − live grand
  isTest: boolean
}

const ATTEMPT_COLS = 'id, invoice_id, installment_id, seq, revision_id, income_id, provider, rail, status, verification, amount_cents, currency, fee, net, method_type, method_last4, account_holder_type, checkout_session_id, payment_intent_id, charge_id, balance_transaction_id, refund_ids, dispute_id, payout_id, expires_at, livemode, created_at, authorized_at, succeeded_at, failed_at, failure_code, created_by'
const LINK_COLS = 'id, invoice_id, gate, gate_tier, is_test, created_at, revoked_at, first_viewed_at, last_viewed_at, view_count, rotated_from'

export async function loadDocState(db: SupabaseClient, invoiceId: string): Promise<DocState | null> {
  const bundle = await loadInvoiceMoney(db, invoiceId)
  if (!bundle) return null
  const [termsR, planR, revR, apR, linkR, attR, evR, cnR] = await Promise.all([
    db.from('invoice_terms').select('*').eq('invoice_id', invoiceId).maybeSingle(),
    db.from('invoice_installments').select('*').eq('invoice_id', invoiceId).order('seq'),
    db.from('invoice_revisions').select('*').eq('invoice_id', invoiceId).order('seq'),
    db.from('invoice_approvals').select('*').eq('invoice_id', invoiceId).order('signed_at'),
    db.from('quote_links').select(LINK_COLS).eq('invoice_id', invoiceId).order('created_at'),
    db.from('payment_attempts').select(ATTEMPT_COLS).eq('invoice_id', invoiceId).order('created_at'),
    db.from('invoice_events').select('*').eq('invoice_id', invoiceId).order('at'),
    db.from('invoice_client_notes').select('*').eq('invoice_id', invoiceId).order('created_at'),
  ])
  for (const [n, r] of [['terms', termsR], ['plan', planR], ['revisions', revR], ['approvals', apR], ['links', linkR], ['attempts', attR], ['events', evR], ['client notes', cnR]] as const) {
    if (r.error) throw new Error(`doc ${invoiceId} ${n}: ${r.error.message}`)
  }
  const terms = (termsR.data as Terms | null) || null
  const plan = (planR.data || []) as PlanRow[]
  const revisions = (revR.data || []) as Record<string, any>[]
  const live = [...revisions].reverse().find(r => !r.superseded_at && (r.kind === 'QUOTE' || r.kind === 'CHANGE_ORDER')) || null
  const approvals = (apR.data || []) as Record<string, any>[]
  const approvalOnLive = live ? approvals.find(a => a.revision_id === live.id) || null : null
  const links = (linkR.data || []) as Record<string, any>[]
  const liveLink = links.find(l => !l.revoked_at) || null
  const attempts = (attR.data || []) as Record<string, any>[]
  const events = (evR.data || []) as Record<string, any>[]
  const clientNotes = (cnR.data || []) as Record<string, any>[]
  const isTest = links.some(l => l.is_test)

  // the plan the stage reads: the frozen revision's amounts when one exists, else the live plan rows
  const frozen = (live?.document?.installments || []) as any[]
  const planForStage = frozen.length
    ? frozen.map(i => ({ id: String(i.id), seq: Number(i.seq), amount: Number(i.amount_cents) / 100 }))
    : (() => { const c = planCents(plan, bundle.money.grand); return plan.map(p => ({ id: p.id, seq: p.seq, amount: (c.find(x => x.seq === p.seq)?.cents || 0) / 100 })) })()
  const latestLink = liveLink || links[links.length - 1] || null
  const stage = quoteStage({
    is_quote: !!bundle.invoice.is_quote,
    link: latestLink ? { revoked_at: latestLink.revoked_at, first_viewed_at: latestLink.first_viewed_at } : null,
    liveLink: !!liveLink,
    live: live ? { id: live.id, seq: live.seq, created_at: live.created_at, kind: live.kind } : null,
    hasSuperseded: revisions.some(r => r.superseded_at && r.kind !== 'LEGACY_BACKUP'),
    approvalOnLive: !!approvalOnLive, anyApproval: approvals.length > 0,
    attempts: attempts.map(a => ({ status: a.status, installment_id: a.installment_id, seq: a.seq, verification: a.verification, created_at: a.created_at, revision_id: a.revision_id })),
    validUntil: terms?.valid_until || null, today: orlandoToday(),
    events: events.map(e => ({ kind: e.kind, at: e.at })),
    openChanges: !!live && clientNotes.some(n => n.kind === 'CHANGES' && !n.hidden_at && n.created_at >= live.created_at),
    plan: planForStage,
    incomes: bundle.incomes.map(i => ({ installment_id: i.installment_id || null, amount: Number(i.amount || 0), paid_at: i.paid_at || null })),
  })

  let presentedDrift = false, planDrift = 0, signedDrift = 0
  if (live && terms) {
    const now = buildRevision(bundle, terms, plan)
    presentedDrift = now.presented_sha256 !== live.presented_sha256
    signedDrift = approvalOnLive ? r2(Number(live.grand_total) - now.grand) : 0
    if (!bundle.invoice.is_quote) {
      const sumPlan = frozen.reduce((s, i) => s + Number(i.amount_cents || 0), 0)
      planDrift = Math.round(now.grand * 100) - sumPlan
    }
  }
  return { bundle, terms, plan, revisions, live, approvals, approvalOnLive, links, liveLink, attempts, events, clientNotes, stage, presentedDrift, planDrift, signedDrift, isTest }
}

export const PUBLIC_BASE = 'https://www.gz28us.com/ca'
export const publicUrl = (token: string) => `${PUBLIC_BASE}/q/${token}`
