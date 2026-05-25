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
  "items": [
    { "description": "item name", "amount": "allocated amount as number string like 12.99" }
  ]
}
Rules:
1. List ONLY physical product/part line items. No shipping, insurance, handling, fees, discounts, coupons, or adjustment lines.
2. For each item, start with its listed unit price multiplied by quantity.
3. Apply any discounts that are directly associated with that item (e.g. a discount line immediately below it).
4. Then distribute ALL remaining charges (shipping, insurance, fees, etc.) proportionally across items based on their discounted value.
5. The sum of all item amounts MUST equal the invoice grand total exactly.
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

    const data = await anthropicRes.json()
    console.log('Anthropic response:', JSON.stringify(data))
    return NextResponse.json(data)

  } catch (err) {
    console.error('scan-receipt error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}