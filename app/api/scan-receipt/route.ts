import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { base64, mediaType } = body

    const isPDF = mediaType === 'application/pdf'

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
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
    { "description": "item name", "amount": "price as number string like 12.99" }
  ]
}
Extract ALL line items from the receipt. For each item include the full description and its price. Do not include tax, shipping, or handling as line items — skip them. Return only the JSON object.`
            }
          ]
        }]
      })
    })

    const data = await response.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Failed to scan receipt' }, { status: 500 })
  }
}