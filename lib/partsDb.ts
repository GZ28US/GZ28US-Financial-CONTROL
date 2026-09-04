import { supabase } from '@/lib/supabase'
import { normSup, matchSupplier, supplierDirectoryFrom, type SupplierEntry } from './supplierMatch'


// Items whose name matches these are "extras" (shipping/handling/etc). For the
// parts data bank we keep the CHEAPEST extra ever seen; regular parts keep the
// LAST purchase (most recent by date). Same list the parts importer skips.
export const EXTRA_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

// Money movements are NOT parts: a scanned line matching these never enrolls in
// the bank (word-bounded so "Balancer" or "wire harness" can't false-positive).
export const PAYMENT_WORDS = /\b(payment|pagamento|deposit|down\s?payment|installment|parcela|entrada|balance\s?due|wire\s?transfer|refund|estorno|chargeback)\b/i

export type EnrollItem = {
  item: string
  part_number?: string | null
  supplier?: string | null
  unit_price?: number | string
  tax?: number | string
  extra?: number | string
  quantity?: number | string
  item_discount?: number | string
  purchase_date?: string | null
  receipt_url?: string | null
  // Official-supplier invoices can print a List/Retail column (→ MAP) and
  // per-line weights — both enroll when the scan finds them.
  list_price?: number | string
  weight_lbs?: number | string
  // Optional nickname typed on the review screen — a typed alias always wins.
  alias?: string | null
  // MARKET the amounts above are printed in ('USD' | 'BRL'). One row per PN per market.
  currency?: string | null
}

// Part-number normalization for dedupe: uppercase, strip every non-alphanumeric
// char (so dots/commas/spaces/dashes can't split the same number), then drop a
// leading brand/supplier token. This makes "DOD 53021585AD" == "MOPAR 53021585AD"
// and "gatK100579HD" == "K100579HD" so the same part can't enroll twice.
export function normPN(pn?: string | null): string {
  // A trailing quantity marker (" x 2", " X 4") is packaging, not part of the PN.
  let x = String(pn || '').toUpperCase().replace(/\s+X\s*\d+\s*$/, '').replace(/[^A-Z0-9]/g, '')
  x = x.replace(/^(GATES|GAT|DODGE|DOD|MOPAR|NGK|ADO|IND)(?=[A-Z0-9])/, '')
  return x
}

// Per-unit OUR COST — ONE FIELD (user law 18/aug/2026): unit_price, whatever the
// source. A hunted part still waiting for its dealer cost falls back to MAP so
// dedupe comparisons stay meaningful. Same-market rows only, so no currency mix.
function ourCostOf(r: any): number {
  const v = r?.unit_price ?? r?.map_price
  const n = Number(v)
  return Number.isFinite(n) ? n : Infinity
}

// THE discount — ONE FIELD (user law 18/aug/2026): part_discount = MAP→OUR COST,
// recomputed against a (constant) MAP + a cost. Delivered projections derive on
// screen now, never stored.
function withDerived(row: any, map: number | null, cost: number): any {
  const r1 = (n: number) => Math.round(n * 10) / 10
  if (map != null && Number(map) > 0 && Number.isFinite(cost) && cost > 0) {
    const m = Number(map)
    return { ...row, map_price: m, part_discount: r1((1 - cost / m) * 100) }
  }
  return { ...row, map_price: map != null ? Number(map) : null, part_discount: null }
}

// THE dedupe rule (hunt / scan / manual all funnel through here): a part number
// lives in the DB only ONCE PER MARKET (currency). Match on the normalized part number (or item name
// when there's no PN). Insert when new. When it already exists:
//   REAL LIFE PREVAILS — a SCANNED invoice is the ground truth. The flow is
//   hunt → quote → deal → purchase → real invoice, so a scan ALWAYS replaces
//   whatever an earlier date put on file (hunt, manual, older scan); between
//   two scans the NEWER purchase date wins; hunt/manual never beats a scan.
//   Extras (shipping/tax rows) keep the CHEAPEST ever seen; hunt-vs-hunt keeps
//   the lowest cost. The kept alias is preserved; a known weight is never erased.
export async function enrollOne(row: any): Promise<{ status: 'inserted' | 'updated' | 'kept'; error: any }> {
  const { data } = await supabase.from('parts_database')
    .select('id, item, alias, part_number, source_type, unit_price, map_price, shipping, handling, weight_lbs, purchase_date, is_extra, currency')
  const rows = data || []
  const keyOf = (r: any) => r.part_number ? normPN(r.part_number) : ('NAME:' + String(r.item || '').trim().toLowerCase())
  // Two part numbers are the SAME part when the normalized forms match exactly OR
  // one ends with the other (shorter side ≥ 6 chars) — catches brand-prefix
  // variants the strip list doesn't know (e.g. "JLTCAI755184" vs "CAI755184").
  const samePN = (a: string, b: string) => {
    if (!a || !b) return false
    if (a === b) return true
    if (a.startsWith('NAME:') || b.startsWith('NAME:')) return false
    const min = Math.min(a.length, b.length)
    return min >= 6 && (a.endsWith(b) || b.endsWith(a))
  }
  // ONE ROW PER PART NUMBER **PER MARKET** (user law 14/aug/2026). The same part is
  // genuinely a different purchase in each country — a Mopar oil filter is US$ 8.66 at
  // Titan and R$ 147 in Brazil — so the rows coexist and never overwrite each other:
  // the dollar row is the American reality, the reais row the Brazilian one. Every other
  // law (real life prevails, LOCKED, cheapest extra) then applies WITHIN the market.
  const market = (r: any) => String(r?.currency || 'USD').toUpperCase()
  const myMarket = market(row)
  const sameMarket = rows.filter((r: any) => market(r) === myMarket)
  const key = keyOf(row)
  let existing = key ? sameMarket.find((r: any) => samePN(keyOf(r), key)) : null

  // Fallback: listing titles (eBay etc.) often carry the real part number only in
  // the item TEXT, while the PN field holds a marketplace item number (or nothing).
  // Sweep the text for PN-looking tokens (≥6 alphanumerics with a digit) and match
  // them against the known part numbers — same part must never enroll twice.
  if (!existing) {
    const tokensOf = (s: any) => (String(s || '').toUpperCase().match(/[A-Z0-9][A-Z0-9.\-\/]{4,}[A-Z0-9]/g) || [])
      .map(t => normPN(t)).filter(t => t.length >= 6 && /\d/.test(t))
    const mine = new Set([...tokensOf(row.item), ...tokensOf(row.part_number)])
    if (mine.size) {
      existing = sameMarket.find((r: any) => {
        const rpn = r.part_number ? normPN(r.part_number) : ''
        if (rpn && rpn.length >= 6 && [...mine].some(t => samePN(t, rpn))) return true
        // Mirror case: our PN appears inside the existing row's item text.
        const k = keyOf(row)
        return !k.startsWith('NAME:') && k.length >= 6 && tokensOf(r.item).some(t => samePN(t, k))
      }) || null
    }
  }

  // A SCAN from an OFFICIAL SUPPLIER (dealer contract → dealer_supplier set) is
  // REAL LIFE at its most trusted: it re-validates any row and LOCKS the result.
  const officialScan = row.source_type === 'SCAN' && !!row.dealer_supplier

  if (!existing) {
    // A scanned MAP gets THE discount (MAP→OUR COST) computed on insert.
    // An official-supplier purchase enters already validated: status LOCKED.
    const base = officialScan ? { ...row, source_type: 'LOCKED' } : row
    const toInsert = base.map_price != null && Number(base.map_price) > 0
      ? withDerived(base, Number(base.map_price), ourCostOf(base))
      : base
    const { error } = await supabase.from('parts_database').insert([toInsert])
    return { status: 'inserted', error }
  }

  // LOCKED is ABSOLUTE (user law 2026-08-05: "when locked, nothing with the same
  // part-number gets enrolled in the system, no matter what, not even in a kit").
  // LOCKED is the part's STATUS (source_type), same level as SCAN/HUNT/MANUAL —
  // a LOCKED row is frozen: no scan, hunt, manual entry or kit member ever touches
  // it; everything that matches its PN resolves TO the locked row instead.
  if (existing.source_type === 'LOCKED') return { status: 'kept', error: null }

  // Who wins the row? Both sides are in the SAME currency by construction (the match
  // above never crosses markets), so these are plain number comparisons again — no rate,
  // no conversion, nothing to get wrong.
  const dateOf = (r: any) => { const t = Date.parse(String(r?.purchase_date || '')); return Number.isFinite(t) ? t : 0 }
  const isExtra = !!(row.is_extra || existing.is_extra)
  let replace: boolean
  if (isExtra) replace = ourCostOf(row) < ourCostOf(existing)                 // extras: cheapest ever
  else if (row.source_type === 'SCAN') replace = existing.source_type !== 'SCAN' || dateOf(row) >= dateOf(existing) // real life prevails; newest scan wins
  else if (existing.source_type === 'SCAN') replace = false                   // hunt/manual never beats a real invoice
  else replace = ourCostOf(row) < ourCostOf(existing)                         // hunt vs hunt: lowest cost

  // MAP: a winning SCAN that carries a retail (printed List or supplier-discount
  // derived) overrides the stored MAP — real life re-validates it. Otherwise the
  // known MAP stays constant, converted into the winning row's currency (a MAP carried
  // from a dollar row onto a reais row has to become reais, or the discount is nonsense).
  const map = replace && row.source_type === 'SCAN' && Number(row.map_price) > 0
    ? Number(row.map_price)
    : (existing.map_price != null ? existing.map_price : (row.map_price ?? null))
  if (replace) {
    // Write a COMPLETE, consistent payload so no stale fields linger when the
    // winning source differs from the one on file (e.g. scan beats a prior hunt).
    const full: any = {
      item: row.item ?? existing.item,
      part_number: row.part_number ?? null,
      supplier: row.supplier ?? null,
      dealer_supplier: row.dealer_supplier ?? null,
      unit_price: row.unit_price ?? null,
      tax: row.tax ?? null,
      extra: row.extra ?? null,
      quantity: row.quantity ?? null,
      purchase_date: row.purchase_date ?? null,
      is_extra: row.is_extra ?? false,
      receipt_url: row.receipt_url ?? null,
      shipping: row.shipping ?? null,
      handling: row.handling ?? null,
      // An official-supplier purchase VALIDATES the row: its status becomes
      // LOCKED and the guard above freezes it forever — the bank compiles
      // itself into a purchase-proven catalog.
      source_type: officialScan ? 'LOCKED' : (row.source_type ?? existing.source_type ?? null),
      // The market this row belongs to. Same as the existing row by construction (a
      // match never crosses markets), written explicitly so the pair can never drift.
      currency: myMarket,
      // A typed alias wins; otherwise the known alias is preserved.
      alias: row.alias ?? existing.alias ?? null,
      // Weight only when the incoming scan carries one — never erase a known weight.
      ...(row.weight_lbs != null && Number(row.weight_lbs) > 0 ? { weight_lbs: row.weight_lbs } : {}),
      updated_at: new Date().toISOString(),
    }
    const merged = withDerived(full, map, ourCostOf(row))
    const { error } = await supabase.from('parts_database').update(merged).eq('id', existing.id)
    return { status: 'updated', error }
  }
  // Even when the existing row wins (newer scan on file / cheaper extra), fill in
  // MAP and weight it lacks — an official-supplier scan is authoritative for both.
  const patch: any = {}
  if ((existing.map_price == null || Number(existing.map_price) <= 0) && row.map_price != null && Number(row.map_price) > 0) {
    Object.assign(patch, withDerived({}, Number(row.map_price), ourCostOf(existing)))
  }
  if ((existing.weight_lbs == null || Number(existing.weight_lbs) <= 0) && row.weight_lbs != null && Number(row.weight_lbs) > 0) {
    patch.weight_lbs = row.weight_lbs
  }
  // An alias typed on the review screen saves even when the existing row wins.
  if (row.alias && row.alias !== existing.alias) patch.alias = row.alias
  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString()
    const { error } = await supabase.from('parts_database').update(patch).eq('id', existing.id)
    return { status: 'updated', error }
  }
  return { status: 'kept', error: null }
}

// Registered-supplier directory (name + aliases). An official supplier's purchase
// enrolls WITH the dealer identity. NO typed discount exists anymore: the discount
// is always computed per item as OUR PRICE vs open-market MAP (MAP rule: eBay
// first, else the official supplier's open-market price — recorded at HUNT time
// or re-validated by a printed List price on a real invoice).
// UM fornecedor, UM nome — a chave de comparação (Márcio, 04/set/2026).
// "&" vira "and", sufixo societário cai, pontuação some. Sem isso
// "Texas Speed & Performance" e "Texas Speed and Performance" viravam dois
// fornecedores, e 28 peças ficaram sem o vínculo de official supplier.
// normSup / SupplierEntry / matchSupplier moram em lib/supplierMatch.ts desde o
// AUTO-BOOK fase B (BL 0.9.0): módulo puro que o motor do Bank Link também usa.
// Re-exportados aqui — quem importava de partsDb continua funcionando.
export { normSup, matchSupplier, supplierDirectoryFrom }
export type { SupplierEntry }

async function supplierDirectory(): Promise<SupplierEntry[]> {
  try {
    const { data } = await supabase.from('suppliers').select('name, aliases, is_dealership')
    return supplierDirectoryFrom(data || [])
  } catch { return [] }
}

// Enroll scanned items into parts_database (product code = PART NUMBER when
// present, else item name). Each goes through enrollOne, so one row per part —
// a SCAN (real-life invoice) overrides older data; see enrollOne. Returns rows changed.
export async function enrollParts(items: EnrollItem[], sourceType: string = 'SCAN'): Promise<number> {
  const directory = await supplierDirectory()
  let changed = 0
  for (const raw of items) {
    const name = (raw.item || '').trim()
    const pn = (raw.part_number || '').trim()
    if (!name && !pn) continue
    if (PAYMENT_WORDS.test(name)) continue
    const price = Number(raw.unit_price) || 0
    const row: any = {
      item: name || pn,
      part_number: pn || null,
      supplier: raw.supplier || null,
      unit_price: price,
      tax: Number(raw.tax) || 0,
      extra: Number(raw.extra) || 0,
      quantity: Number(raw.quantity) || 1,
      purchase_date: raw.purchase_date || null,
      is_extra: EXTRA_WORDS.test(name),
      receipt_url: raw.receipt_url || null,
      source_type: sourceType,
      // The document's own currency, stored with its numbers untouched.
      currency: String(raw.currency || 'USD').toUpperCase().trim() || 'USD',
      alias: (typeof raw.alias === 'string' ? raw.alias.trim() : '') || null,
      updated_at: new Date().toISOString(),
    }
    // Official-supplier extras: printed List/Retail price = the MAP; printed weight.
    const listP = Number(raw.list_price) || 0
    if (listP > 0) row.map_price = listP
    const weight = Number(raw.weight_lbs) || 0
    if (weight > 0) row.weight_lbs = weight
    // O NOME DO FORNECEDOR É O DO CADASTRO, nunca o texto cru da nota
    // (Márcio, 04/set/2026: "ensine o app a escrever estes fornecedores sempre
    // assim, pra nunca mais entrar com outro nome"). A HHP tinha entrado com
    // SETE grafias — "High Horse Performance", "HHP Racing", "High Horse
    // Performance, Inc. (HHP Racing)" — e o cadastro dela aparecia com ZERO
    // peças, zerando o desconto médio na tela de Suppliers.
    const sup = raw.supplier ? matchSupplier(raw.supplier, directory) : null
    if (sup) row.supplier = sup.name
    // dealer_supplier é o OFFICIAL supplier — só quem tem contrato de
    // dealership entra aqui. Antes qualquer cadastrado entrava, e o eBay virava
    // "fornecedor oficial" em 9 peças, diluindo o desconto real dos oficiais.
    // Ver a lei SUPPLIER x OFFICIAL SUPPLIER.
    if (sup && sup.official && !row.is_extra) row.dealer_supplier = sup.name
    const { status, error } = await enrollOne(row)
    if (!error && status !== 'kept') changed++
  }
  return changed
}
