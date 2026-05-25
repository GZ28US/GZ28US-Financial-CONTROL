import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { base64, mediaType } = body

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    }

    const isPDF = mediaType === 'application/pdf'

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
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
              text: `You are scanning a purchase receipt for an auto shop. Extract the following information and return ONLY valid JSON, no other text:
{
  "supplier": "store/supplier name",
  "date": "YYYY-MM-DD format, or empty string if not found",
  "grand_total": "invoice grand total as number string like 11138.67",
  "extra_charges": "total of all shipping, insurance, handling, and fee lines as number string like 117.20",
  "items": [
    { "description": "item name", "quantity": "quantity as integer string like 2", "line_total": "line total AFTER subtracting any discount applied to this item, as number string like 4462.92" }
  ]
}
Rules:
1. items: list ONLY physical product/part line items. No shipping, insurance, handling, fees, discounts, or coupons.
2. quantity: read exactly from the Qty column.
3. line_total: the item subtotal AFTER its associated discount is subtracted. Example: item $6375.60 minus discount $1912.68 = line_total $4462.92.
4. extra_charges: sum of ALL non-product lines: shipping, insurance, handling, fees. Do NOT include discounts here.
5. grand_total: the final total of the invoice.
6. Return only the JSON object, no other text.`
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
    const text = rawData.content?.map((c: any) => c.text || '').join('') || ''
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    // Do proportional math in code
    const items = parsed.items || []
    const extraCharges = parseFloat(parsed.extra_charges) || 0
    const itemsSubtotal = items.reduce((sum: number, item: any) => sum + (parseFloat(item.line_total) || 0), 0)

    const processedItems = items.map((item: any) => {
      const lineTotal = parseFloat(item.line_total) || 0
      const quantity = parseInt(item.quantity) || 1
      const proportion = itemsSubtotal > 0 ? lineTotal / itemsSubtotal : 1 / items.length
      const allocatedExtra = extraCharges * proportion
      const unitPrice = (lineTotal + allocatedExtra) / quantity
      return {
        description: item.description,
        quantity: String(quantity),
        amount: unitPrice.toFixed(2),
      }
    })

    // Return in the same format the client expects
    const responseData = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          supplier: parsed.supplier || '',
          date: parsed.date || '',
          items: processedItems,
        })
      }]
    }

    return NextResponse.json(responseData)

  } catch (err) {
    console.error('scan-receipt error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}