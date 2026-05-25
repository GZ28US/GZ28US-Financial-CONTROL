import { supabase } from '@/lib/supabase'

/**
 * Records income on the DONOR car when one of its stock parts is picked
 * into another ride via FROM STOCK.
 *
 * For the donor car it finds (or creates) the auto "stock sale" invoice for
 * the current month and adds:
 *   - a PART line at the inventory unit price  (revenue / raises grand total)
 *   - a PAYMENT for the value, source ZELLE    (money received)
 * Florida taxes on that invoice are forced to 0% (inventory part, not bought).
 *
 * Same donor + same month -> appended to the same invoice.
 * New month -> a new invoice is created.
 *
 * Create-only: removing the pick later does NOT auto-reverse this.
 *
 * Returns a short status the caller can surface; never throws (a donor
 * bookkeeping failure must not block the recipient pick).
 *
 * @param donorRideId  the rides.id of the donor car (from inputs.donor_ride_id)
 * @param description  the part description
 * @param unitPrice    inventory unit price
 * @param qty          quantity picked
 */
export async function recordDonorStockIncome(params: {
  donorRideId: string | null
  description: string
  unitPrice: number
  qty: number
}): Promise<{ ok: boolean; message?: string }> {
  const { donorRideId, description, unitPrice, qty } = params

  if (!donorRideId) {
    return { ok: false, message: 'No donor car linked to this stock part — no donor invoice created.' }
  }
  if (!(qty > 0) || !(unitPrice >= 0)) {
    return { ok: false, message: 'Invalid quantity or price — no donor invoice created.' }
  }

  try {
    // Resolve donor ride + its project code for invoice naming.
    const { data: donorRide, error: rideErr } = await supabase
      .from('rides')
      .select('id, project_code, project_name')
      .eq('id', donorRideId)
      .single()
    if (rideErr || !donorRide) {
      return { ok: false, message: 'Donor car not found — no donor invoice created.' }
    }

    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const monthKey = `${yyyy}-${mm}`           // bucket: 'YYYY-MM'
    const today = `${yyyy}-${mm}-${String(now.getDate()).padStart(2, '0')}`

    // Find this month's existing auto stock-sale invoice for the donor.
    const { data: existing } = await supabase
      .from('invoices')
      .select('id')
      .eq('ride_id', donorRide.id)
      .eq('stock_sale_month', monthKey)
      .limit(1)
      .maybeSingle()

    let invoiceId: string
    if (existing?.id) {
      invoiceId = existing.id
    } else {
      // Create a new auto invoice for this month.
      const invoiceCode = `${donorRide.project_code}.S${monthKey}`
      const { data: created, error: invErr } = await supabase
        .from('invoices')
        .insert([{
          ride_id: donorRide.id,
          invoice_code: invoiceCode,
          service: 'Stock Parts Sold',
          entry_date: today,
          florida_taxes: 0,        // inventory part — never taxed
          global_discount: 0,
          stock_sale_month: monthKey,
        }])
        .select('id')
        .single()
      if (invErr || !created) {
        return { ok: false, message: `Could not create donor invoice: ${invErr?.message || 'unknown error'}` }
      }
      invoiceId = created.id
    }

    const lineTotal = unitPrice * qty

    // PART line (revenue). unit_price stays the inventory unit price; qty = picked.
    const partRes = await supabase.from('invoice_parts').insert([{
      invoice_id: invoiceId,
      description,
      unit_price: unitPrice,
      quantity: qty,
    }])
    if (partRes.error) {
      return { ok: false, message: `Donor part line failed: ${partRes.error.message}` }
    }

    // PAYMENT for the value, source ZELLE, dated today (counts as received).
    const payRes = await supabase.from('invoice_payments').insert([{
      invoice_id: invoiceId,
      amount: lineTotal,
      payment_date: today,
      source: 'ZELLE',
    }])
    if (payRes.error) {
      return { ok: false, message: `Donor payment failed: ${payRes.error.message}` }
    }

    return { ok: true, message: `Recorded ${qty} × ${description} as income on ${donorRide.project_code} (${monthKey}).` }
  } catch (err) {
    return { ok: false, message: `Donor income error: ${String(err)}` }
  }
}
