import { NextRequest, NextResponse } from 'next/server'

// Receipt OCR runs on Opus for maximum accuracy, which is slower than Sonnet —
// allow up to 60s so a tough/crumpled receipt never times out mid-scan.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { base64, mediaType, mode } = body
    // Client passes today's date so the model can resolve year-less dates (e.g.
    // "Confirmed Jun 17") and never return a future date.
    const todayISO = (typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today)) ? body.today : ''
    // separateExtras: when true (invoice expense scan), tax is returned per-item
    // (split across products) in a `tax` field and every other non-product
    // charge (shipping, handling, insurance, fees) is returned as its own row.
    // When false/absent (legacy goods & inputs scans), tax + extras are summed
    // and distributed into the item unit prices exactly as before.
    const separateExtras = body.separateExtras === true

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    }

    const isPDF = mediaType === 'application/pdf'
    const isPayment = mode === 'payment'

    const purchasePrompt = `You are scanning a purchase receipt for an auto shop. Extract the following information and return ONLY valid JSON, no other text:
{
  "supplier": "the SELLER — the business we BOUGHT FROM — see rule 0. If the header is only a generic greeting like 'WELCOME TO OUR STORE' with no business name, use the street address or city printed at the top instead (e.g. '9999 S Hwy 441, Orlando FL'). For a payment/transfer/PIX receipt use the RECIPIENT being paid (the 'recebedor' / 'Para'), never the bank or the payer",
  "currency": "ISO code of the currency the returned amounts are in (USD, BRL, ...) — see rule 15",
  "order_number": "the store's order / confirmation / sales-order number printed on the document (e.g. 'Order #123456', 'SO-98765', 'Confirmation 2AB4C'), copied EXACTLY as printed — see rule 9b — else empty string",
  "date": "YYYY-MM-DD format, or empty string if not found",
  "paid": true or false boolean — see rule 11,
  "source": "the PAYER who SENT the money (a transfer/PIX 'pagador' / 'De' / 'Dados do pagador'); empty string if not shown — see rule 14",
  "grand_total": "invoice grand total as number string like 291.13",
  "tax": "total sales tax as a number string like 17.77, or 0 if there is no tax",
  "extras": [
    { "description": "the receipt's own label for the charge, e.g. Shipping, Handling, Insurance, Freight, Surcharge", "amount": "number string like 12.50" }
  ],
  "items": [
    { "description": "item name", "part_number": "manufacturer part number / SKU / MPN / item or catalog number printed for this line, else empty string", "quantity": "quantity as integer string like 2", "line_total": "line total AFTER subtracting any discount applied to this item, as number string like 4462.92", "list_price": "per-UNIT list/retail/MSRP price if the receipt shows one HIGHER than what was actually paid, else 0", "weight_lbs": "per-UNIT weight in pounds if the document prints a weight for this line, else 0" }
  ]
}
Rules:
0. WHO IS THE SUPPLIER — a purchase document names TWO parties, and "supplier" is ALWAYS the one that SOLD the goods, never the one that bought them. WE are the buyer, and we appear under ANY of these names — "GZ28" is short for "GALPÃO Z28", so the spelled-out Brazilian legal name is equally us: GZ28, GZ28US, GZ28BR, "GZ28 V8 SpeedShop", "GZ28 V8 SpeedShop USA LLC", "GZ28 V8 SpeedShop BR Ltda", "GALPÃO Z28" / "GALPAO Z28", "GALPÃO Z28 SERVIÇOS AUTOMOTIVOS EIRELI", or an address in Orlando FL belonging to them. NEVER return any of these as the supplier.
   - The SELLER is the letterhead/logo at the top, the party the invoice is FROM, labelled "From", "Sold By", "Vendedor", "Remetente", or on a Brazilian nota fiscal the "EMITENTE" block (the one whose CNPJ heads the document).
   - The BUYER (us — never the supplier) is labelled "Bill To", "Sold To", "Ship To", "Customer", "Cliente", "Comprador", "Destinatário", or on a nota fiscal the "DESTINATÁRIO / REMETENTE" recipient block.
   - If BOTH parties are printed and one of them is a GZ28 entity, the supplier is the OTHER one, always.
   - Only when the document names no seller at all should supplier be an empty string — never fall back to the buyer.
1. items: list ONLY physical product/part line items. No shipping, insurance, handling, tax, fees, discounts, or coupons. A standalone "Dsc"/"Discount"/"Coupon" line (often printed right below the item it applies to) is NOT its own item — fold that amount into the line_total of the item directly above it and never emit it as a separate item. NEVER merge or deduplicate printed lines: two lines with similar or even identical descriptions are SEPARATE items — output one entry per printed product line, each with ITS OWN part number exactly as printed (e.g. two injector sets that differ only in part number are two items, never one).
2. quantity: read exactly from the Qty column. If there is no Qty column, look for a quantity multiplier printed for the item — usually on the line DIRECTLY BELOW the description, in the form "N x" / "N @" / "N X" (e.g. ALDI and other grocery receipts print "20 x" with the unit price beneath the item). That N is the quantity. Default to 1 only when no such multiplier is shown for that item.
3. line_total: the item line total AFTER its associated discount is subtracted. Example: item $6375.60 minus discount $1912.68 = line_total $4462.92. When the receipt has separate "List" and "Cost" (or "Price"/"Your Price") columns, use the COST/actual-paid column for line_total — never the List/retail column. On receipts that STACK the quantity (a "N x  unit_price" line below the item), the line_total is the EXTENDED amount printed on the item's OWN line (= N times unit_price — e.g. "Dog Entree ... 13.20" with "20 x 0.66" beneath it has line_total 13.20), NOT the small per-unit price on the sub-line. Never report the per-unit price as the line_total when a quantity multiplier is present.
4. list_price: ONLY when the receipt shows a per-unit retail/list/MSRP price that is HIGHER than the actual unit price paid (e.g. an AutoZone-style "List" column next to a "Cost" column). Report that higher per-unit price here. If the receipt shows only one price, set this to 0.
4b. weight_lbs: ONLY when the document prints a weight for that line (common on dealer/wholesale invoices and packing slips). Per UNIT, in POUNDS — if the document prints kg, convert (1 kg = 2.2046) and round to 2 decimals. Use 0 when no weight is printed; never estimate.
5. tax: the SALES TAX total only, as a single number string. Sum all tax lines into this one value. Use 0 if there is no tax. Do NOT put tax in "extras".
6. extras: every OTHER non-product charge line — shipping, handling, insurance, freight, surcharges, and any other fee — as its own entry, using the label printed on the receipt. Do NOT include tax here, and do NOT include discounts or coupons. Only include entries whose amount is greater than 0 (skip "Free" or $0.00 lines). If there are none, return an empty array.
7. grand_total: the final total of the invoice.
8. description: keep it concise, max ~80 characters. Trim long part names to the essential identifying text. Do NOT include inch marks (") or other unescaped double quotes inside any JSON string value — write inches as "in" or omit them.
9. part_number: the manufacturer part number, SKU, MPN, or item/catalog number printed for that line item (NOT the quantity or price). Use it as the product's identifying code. Empty string if none is shown.
9b. order_number: copy the order number CHARACTER FOR CHARACTER as the document prints it, keeping its original punctuation and structure. PRESERVE leading zeros (a Titan order '014082582' must NOT become '14082582'), PRESERVE hyphens (an eBay order '06-14955-51430' keeps both hyphens), PRESERVE any suffix (a Walmart order '2000149-94340612/D' keeps the '/D'), PRESERVE any letter prefix (a Temu order 'PO-211-...' keeps the 'PO-'). The ONLY thing to strip is a leading '#' or the label itself ('Order', 'Order Number:', 'Confirmation'): 'Order #123-456' becomes '123-456' — NEVER return the number with a '#' attached. Do NOT normalize, reformat, shorten, or re-space the number in any other way.
10. Output must be a single raw JSON object. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the JSON.
11. paid: a boolean. true when the document shows the purchase is already paid, charged, or CONFIRMED — a receipt, a paid invoice, a "PAID" mark, an order/payment confirmation, a "Confirmed" / "Order Confirmed" status, or a balance due of 0. false ONLY when it is clearly an unpaid quote/estimate or shows an outstanding balance still due. When unsure, use true (a scanned purchase receipt is normally already paid).
12. date: the TRANSACTION / SALE / PURCHASE date — on a store/POS receipt this is the timestamp usually printed at the BOTTOM next to the time (e.g. "6/26/26 7:32 PM"). IGNORE every unrelated date on the receipt: a date of birth or an "ID VERIFIED" age-check date, a "best by"/expiration date, store hours, or a loyalty/coupon date are NOT the purchase date. Return it as YYYY-MM-DD. If the document shows a date without a year (e.g. "Confirmed Jun 17"), infer the year so the date is the most recent one that is NOT in the future${todayISO ? ` relative to today, ${todayISO}` : ''}. Never return a date after today.
13. PAYMENT / TRANSFER / PIX receipts (e.g. a "Comprovante do Pix", a bank transfer / TED / DOC / Zelle / wire confirmation) have NO itemized products. For these, IGNORE rule 1: set "supplier" to the RECIPIENT/payee (the "recebedor" / "Para" / "Dados do recebedor" — the party RECEIVING the money, never the bank, never the payer), set "paid" to true, set "grand_total" to the amount paid ("Valor pago" / "Valor"), set "tax" to 0 and "extras" to [], and return a SINGLE item whose description is a short label (the payee name, or "Pagamento") and whose line_total is that same amount. Never return an empty items array for a payment receipt.
14. source: the PAYER — who SENT the money (the "pagador" / "De" / "Dados do pagador" / "from"). This is the person/company that paid, NOT the supplier/payee. Empty string if not shown.
15. CURRENCY — this system registers expenses in USD. Read carefully which currency each printed amount is in ("R$" / "BRL" = Brazilian real; "$" / "US$" / "USD" = US dollar; airline documents label amounts like "USD 350.00" or "BRL 1.839,48"). If the document shows amounts in USD anywhere, return ALL monetary fields (grand_total, tax, extras, line_total, list_price) in USD and set "currency" to "USD". When only some components are printed in USD, convert the rest using the exchange rate implied by any amount printed in BOTH currencies. ONLY if the document contains no USD amount at all: return the amounts exactly as printed in the document's own currency and set "currency" to its ISO code (e.g. "BRL") — never guess an exchange rate, and NEVER report a BRL/foreign amount as if it were USD.
15a. A BRAZILIAN document is BRL even when no "R$" symbol is printed next to the numbers — Brazilian invoices routinely print bare figures in their VL UNIT / VALOR columns. Treat the document as BRL whenever it carries Brazilian markers and shows no USD amount anywhere: a CNPJ or CPF number, "DANFE", "Nota Fiscal", "NF-e", "ICMS", "EMITENTE"/"DESTINATÁRIO", a Brazilian address or CEP, or amounts written in Brazilian format (1.234,56). Do NOT default to USD just because the currency symbol is missing — decide from the document's origin.
15b. AIRLINE TICKETS / TRAVEL ITINERARIES (Copa, LATAM, GOL, American, ...): these typically print the base FARE as a matching two-currency pair (e.g. "USD 300.00" alongside its local equivalent like "BRL 1,635.00") and then EXTRA charges — airport/boarding taxes, fees, surcharges, fuel, IOF — printed ONLY in the local currency, with the grand total also in local currency. NEVER return just the USD base fare as the total. Instead: (a) derive the exchange rate from the matching fare pair (local fare ÷ USD fare); (b) convert EVERY local-only charge to USD by dividing by that rate; (c) return ONE item per passenger ticket whose line_total is the ENTIRE amount paid in USD = USD base fare + ALL converted charges, rounded to 2 decimals; (d) grand_total = the sum of those USD ticket totals — cross-check: it must equal the printed local-currency grand total divided by the derived rate (within a few cents); (e) set tax to 0 and extras to [] — airline taxes/fees are part of the ticket price, not US sales tax; (f) do NOT create separate items for individual flight segments — put the route/segments in the ticket item's description instead.
16. Brazilian number format: "1.839,48" means 1839.48 (dot = thousands separator, comma = decimals). Always output plain numbers with a dot as the decimal separator and no thousands separators.`

    const paymentPrompt = `You are scanning a PAYMENT PROOF of money RECEIVED by an auto shop (a bank transfer confirmation, a Zelle/ACH receipt, a check image, a card receipt, or a Brazilian "Comprovante de Pix" / PIX / TED). A document may show ONE payment or SEVERAL. Extract every payment and return ONLY valid JSON, no other text:
{
  "currency": "USD" or "BRL" — the currency the AMOUNTS on this proof are printed in — see rule 0,
  "payments": [
    {
      "amount": "payment amount as number string like 1500.00",
      "source": "the payment METHOD — see rule 2 — or empty string if not identifiable",
      "date": "YYYY-MM-DD format, or empty string if not found",
      "payer": "the name of who SENT/PAID the money (the 'from' / 'De' / 'pagador' / 'Origem' / 'Dados do pagador'); empty string if not shown",
      "payee": "the name of who RECEIVED the money (the 'to' / 'Para' / 'recebedor' / 'Destino' / 'Dados do recebedor' / 'Favorecido' / 'Beneficiário'); empty string if not shown"
    }
  ]
}
Rules:
0. currency — READ THIS FIRST, before any amount. Return "USD" when the amounts are in US dollars (a "$" or "US$" sign, "USD", "Dollars", a Zelle/ACH/wire/check/US-bank document) and "BRL" when in Brazilian reais (an "R$" sign, "BRL", "reais", a Pix/TED/DOC or any Brazilian bank document). Never infer the currency from the size of the number. With no currency mark at all, default to "USD" for a Zelle/ACH/wire/check and to "BRL" for a Pix/TED/DOC.
1. amount: the money amount RECEIVED, digits only as a number string (no $ or R$ and no thousands separators; use a dot for the decimals). For a Pix use the "Valor". NEVER convert the amount — report it exactly as printed, in the document's own currency.
2. source: the payment method, mapped to exactly one of the words below, based on clear evidence in the document. If you cannot tell, use an empty string — do NOT guess.
   • On a US/dollar document: CASH, ZELLE, ACH, WIRE, CHECK, CARD, PAYPAL (the word "Zelle"/"ACH"/"wire", a check number, a card brand, "PayPal", "cash").
   • On a Brazilian document: PIX, TED, CASH, CHEQUE, CARD ("Comprovante de Pix"/"Pix enviado"/a "Chave Pix" or an "E2E"/"ID da transação" code ⇒ PIX; "TED"/"DOC"/"Transferência" ⇒ TED; "cheque" ⇒ CHEQUE; "cartão"/"débito"/"crédito" ⇒ CARD; "dinheiro"/"espécie" ⇒ CASH).
3. date: the date the payment was made/settled, as YYYY-MM-DD. A Brazilian date like "09/03/2026" is DD/MM/YYYY, so it becomes 2026-03-09. Empty string if not found.${todayISO ? ` Never return a date after today, ${todayISO}.` : ''}
4. payer: the party that SENT the money — the "from" / "De" / "pagador" / "Origem" / "Dados do pagador". This is the client who paid, NOT the recipient (the "Para" / "recebedor") and NOT the bank. Empty string if not shown.
5. payee: the party that RECEIVED the money — the "to" / "Para" / "recebedor" / "Favorecido" / "Beneficiário" / "Dados do recebedor" / the account credited. This is the shop, NOT the client and NOT the bank. Copy the name exactly as printed (e.g. "GALPAO Z28 LTDA", "GZ28US LLC", "Marcio De Maria"). Empty string if not shown.
6. If the document shows multiple payments, include one object per payment. If only one, return a single-element array.
7. Output must be a single raw JSON object. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the JSON.`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            ...(isPDF ? [{
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            }] : [{
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            }]),
            {
              type: 'text',
              text: isPayment ? paymentPrompt : purchasePrompt
            }
          ]
        }]
      })
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text()
      console.error('Anthropic API error:', anthropicRes.status, errText)
      return NextResponse.json({ error: `Anthropic API error: ${anthropicRes.status}`, detail: errText }, { status: 500 })
    }

    const rawData = await anthropicRes.json()

    // Surface a clear error if the model hit the token ceiling
    const stopReason = rawData.stop_reason
    const text = rawData.content?.map((c: any) => c.text || '').join('') || ''

    const parsed = parseModelJson(text)
    if (!parsed) {
      console.error('Failed to parse model output. stop_reason:', stopReason, 'raw:', text.slice(0, 500))
      return NextResponse.json({
        error: stopReason === 'max_tokens'
          ? 'The document was too long for one scan and the response was cut off. Try a smaller image/PDF or contact support to raise the limit.'
          : 'Could not read the document. The scan returned data that was not valid JSON.',
      }, { status: 422 })
    }

    // ---- PAYMENT MODE ----
    if (isPayment) {
      const rawPayments = Array.isArray(parsed.payments) ? parsed.payments : []
      const allowedSources = ['CASH', 'ACH', 'ZELLE', 'CHECK']
      const payments = rawPayments.map((p: any) => {
        const amt = parseFloat(p.amount)
        const src = String(p.source || '').toUpperCase().trim()
        return {
          amount: Number.isFinite(amt) ? amt.toFixed(2) : '',
          source: allowedSources.includes(src) ? src : '',
          date: typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : '',
          payer: String(p.payer || '').trim(),
        }
      }).filter((p: any) => p.amount !== '')

      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({ payments, currency: String(parsed.currency || '').toUpperCase().trim() || null })
        }]
      })
    }

    // ---- PURCHASE MODE (default) ----
    // Robust numeric parse: strip $, commas, spaces and stray currency text so
    // a model value like "$176.39" or "1,234.56" doesn't silently become 0.
    const num = (v: any): number => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : 0
      const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '')
      const n = parseFloat(cleaned)
      return Number.isFinite(n) ? n : 0
    }

    const items = Array.isArray(parsed.items) ? parsed.items : []
    let tax = num(parsed.tax)
    const grandTotal = num(parsed.grand_total)
    const rawExtras = Array.isArray(parsed.extras) ? parsed.extras : []
    const extras = rawExtras
      .map((x: any) => ({ description: String(x.description || '').trim(), amount: num(x.amount) }))
      .filter((x: any) => x.amount > 0)
    const extrasTotal = extras.reduce((sum: number, x: any) => sum + x.amount, 0)
    const itemsSubtotal = items.reduce(
      (sum: number, item: any) => sum + num(item.line_total),
      0
    )

    // Fallback: if the model didn't return a usable tax but did give a grand
    // total, recover the tax as grand_total - items - extras. Guards against
    // the model omitting/mis-formatting the tax line.
    if (tax <= 0 && grandTotal > 0 && itemsSubtotal > 0) {
      const derived = grandTotal - itemsSubtotal - extrasTotal
      if (derived > 0.01) tax = Math.round(derived * 100) / 100
    }

    // Order-level discount reconciliation: if items + tax + extras come out HIGHER
    // than the grand total, the receipt carried a discount the model didn't fold
    // into the line items (the output has no discount field). Scale every item line
    // down proportionally so the parts reconcile exactly to the grand total.
    let itemScale = 1
    if (grandTotal > 0 && itemsSubtotal > 0) {
      const netItemsTarget = grandTotal - tax - extrasTotal
      if (netItemsTarget > 0 && netItemsTarget < itemsSubtotal - 0.01) {
        itemScale = netItemsTarget / itemsSubtotal
      }
    }
    const scaledSubtotal = itemsSubtotal * itemScale

    const processedItems: { description: string; part_number: string; quantity: string; amount: string; tax: string; extra: string; item_discount: string; list_price: string; weight_lbs: string }[] = []

    if (separateExtras) {
      // Tax AND extra costs (shipping, handling, insurance, ...) are each split
      // across the products proportionally to line total and reported per row in
      // `tax` / `extra`. The item `amount` is the bare tax-free, extra-free unit
      // price. Extras are NO LONGER emitted as their own rows.
      let taxAllocated = 0
      let extraAllocated = 0
      items.forEach((item: any, idx: number) => {
        const lineTotal = num(item.line_total) * itemScale
        const quantity = parseInt(item.quantity) || 1
        const proportion = scaledSubtotal > 0 ? lineTotal / scaledSubtotal : (items.length ? 1 / items.length : 0)
        const isLast = idx === items.length - 1
        // Last product absorbs the rounding remainder so each total sums exactly.
        let lineTax: number
        if (isLast) {
          lineTax = Math.max(0, tax - taxAllocated)
        } else {
          lineTax = Math.round(tax * proportion * 100) / 100
          taxAllocated += lineTax
        }
        let lineExtra: number
        if (isLast) {
          lineExtra = Math.max(0, extrasTotal - extraAllocated)
        } else {
          lineExtra = Math.round(extrasTotal * proportion * 100) / 100
          extraAllocated += lineExtra
        }
        const unitPrice = quantity > 0 ? lineTotal / quantity : 0
        // If the receipt carried a higher per-unit list/retail price, derive the
        // per-item discount % (1 - paid/list). Used to pre-fill the Disc % field
        // for VARIABLE-discount suppliers. 0 when no list price was present.
        const listPrice = num(item.list_price)
        const itemDiscount = (listPrice > unitPrice && unitPrice > 0)
          ? Math.round((1 - unitPrice / listPrice) * 1000) / 10
          : 0
        processedItems.push({
          description: item.description || '',
          part_number: String(item.part_number || '').trim(),
          quantity: String(quantity),
          amount: unitPrice.toFixed(2),
          tax: lineTax.toFixed(2),
          extra: lineExtra.toFixed(2),
          item_discount: String(itemDiscount),
          list_price: listPrice > 0 ? String(listPrice) : '0',
          weight_lbs: String(num(item.weight_lbs) || 0),
        })
      })
    } else {
      // Legacy behavior: fold tax + all extras into the item unit prices,
      // distributed proportionally. One row per item, no separate tax.
      const extraCharges = tax + extrasTotal
      items.forEach((item: any) => {
        const lineTotal = num(item.line_total) * itemScale
        const quantity = parseInt(item.quantity) || 1
        const proportion = scaledSubtotal > 0 ? lineTotal / scaledSubtotal : (items.length ? 1 / items.length : 0)
        const allocatedExtra = extraCharges * proportion
        const unitPrice = quantity > 0 ? (lineTotal + allocatedExtra) / quantity : 0
        const listPrice = num(item.list_price)
        processedItems.push({
          description: item.description || '',
          part_number: String(item.part_number || '').trim(),
          quantity: String(quantity),
          amount: unitPrice.toFixed(2),
          tax: '0.00',
          extra: '0.00',
          item_discount: '0',
          list_price: listPrice > 0 ? String(listPrice) : '0',
          weight_lbs: String(num(item.weight_lbs) || 0),
        })
      })
    }

    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          supplier: sellerOnly(parsed.supplier),
          date: parsed.date || '',
          paid: parsed.paid !== false,
          source: parsed.source || '',
          // Store order/confirmation number — seeds the STREAM tracker.
          order_number: String(parsed.order_number || '').trim(),
          // Currency the amounts are in. 'USD' normally; a foreign ISO code (e.g.
          // BRL) only when the document had no USD amount at all — consumers must
          // warn instead of silently registering a foreign amount as dollars.
          currency: String(parsed.currency || 'USD').toUpperCase().trim() || 'USD',
          items: processedItems,
        })
      }]
    })

  } catch (err) {
    console.error('scan-receipt error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * The SUPPLIER is whoever SOLD to us — never ourselves. A purchase document prints both
 * parties (a Brazilian nota fiscal has EMITENTE and DESTINATÁRIO; a US invoice has a
 * letterhead and a "Bill To"), and the reader sometimes picks the buyer block, which put
 * GZ28 in the supplier field. Rule 0 of the prompt tells it which party to take; this is
 * the deterministic backstop for when it gets it wrong anyway.
 *
 * Only OUR OWN entity is stripped. GZ28BR is left alone on purpose — this app is GZ28US,
 * so a purchase from the Brazilian company is a real supplier, not a self-reference.
 * A blanked supplier is better than a wrong one: the field is editable on the review
 * screen, so an empty box asks to be filled while "GZ28US" looks already answered.
 */
function sellerOnly(name: unknown): string {
  const s = String(name ?? '').trim()
  if (!s) return ''
  // Accent-folded, punctuation-stripped, so "GALPÃO Z-28" and "GALPAO Z28" match alike.
  const flat = s.toLowerCase()
    .replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
    .replace(/[óòôõö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]/g, '')
  // Every way the house writes itself. "GZ28" IS "Galpão Z28", so the spelled-out legal
  // name (GALPAO Z28 SERVIÇOS AUTOMOTIVOS EIRELI) is us just as much as the short form —
  // that spelling is what slipped through on a real nota fiscal (13/aug/2026).
  const isOurs = flat.includes('gz28') || flat.includes('galpaoz28') || flat.includes('galpaozeta28')
  if (!isOurs) return s
  // The Brazilian SISTER COMPANY can genuinely sell to this (US) app, so it is kept —
  // but only when it identifies itself as the Ltda, not as the Galpão EIRELI that shows
  // up in the buyer block of Brazilian purchase notes.
  const isBrSibling = flat.includes('gz28br') || (/\bbr\b|brasil|brazil/i.test(s) && /ltda/i.test(s))
  return isBrSibling ? s : ''
}

/**
 * Robustly extract a JSON object from a model response.
 * Handles markdown fences, leading/trailing prose, and truncated output.
 * Returns null if nothing usable can be recovered.
 */
function parseModelJson(raw: string): any | null {
  if (!raw) return null

  // Strip markdown code fences if present
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim()

  // Narrow to the outermost JSON object
  const start = text.indexOf('{')
  if (start === -1) return null
  text = text.slice(start)

  // 1. Try a straight parse first (the happy path)
  try {
    return JSON.parse(text)
  } catch {
    // fall through to repair
  }

  // 2. Attempt to repair a truncated response (e.g. hit max_tokens mid-string)
  const repaired = repairTruncatedJson(text)
  if (repaired) {
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }

  return null
}

/**
 * Best-effort repair of JSON that was cut off mid-stream.
 * Drops any trailing incomplete token, closes open strings, and balances
 * brackets/braces so a partial item list can still be salvaged.
 */
function repairTruncatedJson(text: string): string | null {
  let s = text

  // Walk the string tracking structure so we can close it cleanly.
  let inString = false
  let escaped = false
  const stack: string[] = []
  let lastSafeIndex = -1 // index after the last complete value (closed string, }, ], or end of number)

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
        lastSafeIndex = i
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      lastSafeIndex = i
    } else if (/[\d}\]eE.+-]/.test(ch)) {
      lastSafeIndex = i
    }
  }

  // If we ended inside a string, cut back to the last complete value.
  if (inString) {
    if (lastSafeIndex === -1) return null
    s = s.slice(0, lastSafeIndex + 1)
    // Recompute the open-bracket stack for the trimmed string.
    return rebalance(s)
  }

  // Trim any dangling comma or partial token after the last safe value.
  if (lastSafeIndex !== -1 && lastSafeIndex < s.length - 1) {
    s = s.slice(0, lastSafeIndex + 1)
  }

  return rebalance(s)
}

function rebalance(s: string): string | null {
  // Remove a trailing comma if present.
  s = s.replace(/,\s*$/, '')

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  if (inString) return null // could not safely close

  // Close any still-open brackets/braces in reverse order.
  while (stack.length) {
    s += stack.pop()
  }

  return s
}
