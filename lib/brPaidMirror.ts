import { supabaseBR } from '@/lib/supabaseBR'

// ── US shopping-invoice income PAID  ->  the BR invoice's GZ28US bills go PAID ──
// A GZ28BR ride expense paid by GZ28US is a re-sale: GZ28US bills GZ28BR for the
// parts at +10% + Florida tax and gives BR 30 days to settle. The BR app builds
// that bill as a US shopping invoice under client US.006 — "GZ28 V8 SpeedShop BR
// Ltda" (see the BR app's lib/usShoppingMirror.ts), whose single income row is the
// PENDING BALANCE that BR owes.
//
// When that income is marked PAID in the US app, GZ28BR has settled the bill — so
// the BR invoice's GZ28US-owed expense lines must stop showing as unpaid in the BR
// app. This mirrors just that fact back: only the paid DATE crosses, never the
// scanned receipt/document.
//
// Linked by BR invoices.us_invoice_id -> US invoices.id, so this is a silent no-op
// on any invoice that isn't a BR mirror. Best-effort and non-blocking — wrap with
// `void` at the call site so a BR hiccup never breaks the US write, exactly like
// lib/suppliersMirror.ts.
//
// TWO kinds of line on the BR invoice are owed to GZ28US, and both get settled by
// the one payment:
//   • merchandise ......... source = 'GZ28US'
//   • the Florida tax row .. supplier = 'GZ28US' (its source stays 'GZ28BR')
// The US invoice's grand total is cost x1.10 x1.065 — it INCLUDES that Florida tax
// — so paying it clears the BR-side tax line too.

// Mark (or, with paidDate = null, un-mark) every GZ28US-owed expense of the BR
// invoice mirrored from this US invoice. `paidDate` is a YYYY-MM-DD string.
export async function mirrorUsInvoicePaidToBR(usInvoiceId: string, paidDate: string | null) {
  try {
    if (!usInvoiceId) return
    const { data } = await supabaseBR.from('invoices').select('id').eq('us_invoice_id', usInvoiceId).limit(1)
    const brInvoiceId = data?.[0]?.id
    if (!brInvoiceId) return // not a BR-mirrored invoice — nothing to do
    const value = /^\d{4}-\d{2}-\d{2}$/.test(String(paidDate || '')) ? paidDate : null
    // Merchandise GZ28US paid for, then the Florida tax owed to the US unit.
    await supabaseBR.from('invoice_expenses').update({ payment_date: value }).eq('invoice_id', brInvoiceId).eq('source', 'GZ28US')
    await supabaseBR.from('invoice_expenses').update({ payment_date: value }).eq('invoice_id', brInvoiceId).eq('supplier', 'GZ28US')
  } catch { /* best-effort mirror */ }
}
