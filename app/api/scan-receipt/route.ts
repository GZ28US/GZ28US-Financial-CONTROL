import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { base64, mediaType, mode } = body

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    }

    const isPDF = mediaType === 'application/pdf'
    const isPayment = mode === 'payment'

    const purchasePrompt = `You are scanning a purchase receipt for an auto shop. Extract the following information and return ONLY valid JSON, no other text:
{
  "supplier": "store/supplier name",
  "date": "YYYY-MM-DD format, or empty string if not found",
  "grand_total": "invoice grand total as number string like 11138.67",
  "extra_charges": "total of all shipping, insurance, handling, tax, and any other fee lines as number string like 117.20",
  "items": [
    { "description": "item name", "quantity": "quantity as integer string like 2", "line_total": "line total AFTER subtracting any discount applied to this item, as number string like 4462.92" }
  ]
}
Rules:
1. items: list ONLY physical product/part line items. No shipping, insurance, handling, tax, fees, discounts, or coupons.
2. quantity: read exactly from the Qty column.
3. line_total: the item line total AFTER its associated discount is subtracted. Example: item $6375.60 minus discount $1912.68 = line_total $4462.92.
4. extra_charges: sum of ALL non-product lines: shipping, insurance, handling, tax, and any other fees. Do NOT include discounts here.
5. grand_total: the final total of the invoice.
6. description: keep it concise, max ~80 characters. Trim long part names to the essential identifying text. Do NOT include inch marks (") or other unescaped double quotes inside any JSON string value — write inches as "in" or omit them.
7. Output must be a single raw JSON object. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the JSON.`

    const paymentPrompt = `You are scanning a PAYMENT proof for an auto shop (a bank transfer confirmation, Zelle/ACH receipt, check image, or card receipt). A document may show ONE payment or SEVERAL. Extract every payment and return ONLY valid JSON, no other text:
{
  "payments": [
    { "amount": "payment amount as number string like 1500.00", "source": "one of CASH, ACH, ZELLE, CHECK, or empty string if not clearly identifiable", "date": "YYYY-MM-DD format, or empty string if not found" }
  ]
}
Rules:
1. amount: the money amount of the payment, digits only as a number string (no $ or commas).
2. source: map to exactly one of CASH, ACH, ZELLE, CHECK based on clear evidence in the document (e.g. the word "Zelle", "ACH", a check number, "cash"). If you cannot tell, use an empty string — do NOT guess.
3. date: the date the payment was made/settled, YYYY-MM-DD. Empty string if not found.
4. If the document shows multiple payments, include one object per payment. If only one, return a single-element array.
5. Output must be a single raw JSON object. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the JSON.`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
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
        }
      }).filter((p: any) => p.amount !== '')

      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({ payments })
        }]
      })
    }

    // ---- PURCHASE MODE (default) ----
    const items = Array.isArray(parsed.items) ? parsed.items : []
    const extraCharges = parseFloat(parsed.extra_charges) || 0
    const itemsSubtotal = items.reduce(
      (sum: number, item: any) => sum + (parseFloat(item.line_total) || 0),
      0
    )

    // Keep ONE row per item. Report its quantity and per-unit amount
    // (extras distributed proportionally across the whole line).
    const processedItems: { description: string; quantity: string; amount: string }[] = []
    items.forEach((item: any) => {
      const lineTotal = parseFloat(item.line_total) || 0
      const quantity = parseInt(item.quantity) || 1
      const proportion = itemsSubtotal > 0 ? lineTotal / itemsSubtotal : (items.length ? 1 / items.length : 0)
      const allocatedExtra = extraCharges * proportion
      const unitPrice = quantity > 0 ? (lineTotal + allocatedExtra) / quantity : 0
      processedItems.push({
        description: item.description || '',
        quantity: String(quantity),
        amount: unitPrice.toFixed(2),
      })
    })

    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          supplier: parsed.supplier || '',
          date: parsed.date || '',
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
