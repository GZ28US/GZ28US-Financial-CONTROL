import { NextRequest, NextResponse } from 'next/server'

// HUNT PART — given a manufacturer part number, use Claude + web search to
// identify the part and find its MAP (Minimum Advertised Price = the price
// authorized dealers converge on; what an ordinary buyer pays before tax/ship).
// Returns the part identity, MAP, the sellers found, and a best-place
// recommendation that prefers one of the shop's dealership suppliers.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const partNumber = String(body.partNumber || '').trim()
    const dealerships: string[] = Array.isArray(body.dealerships) ? body.dealerships : []

    if (!partNumber) {
      return NextResponse.json({ error: 'Missing partNumber' }, { status: 400 })
    }

    const dealerLine = dealerships.length
      ? `The shop holds DEALER accounts with these suppliers: ${dealerships.join(', ')}. If any of them carries this part, set "recommended_dealership" to that exact name and make it the "best_place".`
      : `The shop has no dealership suppliers on file.`

    const prompt = `You are a parts buyer for a US auto speed shop in Orlando, Florida. Use web search to identify the part with manufacturer part number "${partNumber}" and determine its MAP (Minimum Advertised Price).

MAP = the price independent authorized dealers converge on (the same recurring advertised price). It is the price an ORDINARY retail buyer pays for the part itself, before shipping and sales tax. Find it by checking several authorized sellers and reporting the converged price.

${dealerLine}

Return ONLY a single raw JSON object, no markdown, no prose:
{
  "found": true/false,
  "part_number": "${partNumber}",
  "name": "concise part name (max 80 chars)",
  "manufacturer": "brand that makes it",
  "map": number (USD per-unit MAP; 0 if not found),
  "sellers": [ { "name": "seller", "price": number, "url": "product url" } ],
  "best_place": "where you recommend buying it",
  "recommended_dealership": "exact dealership name from the list above if one carries it, else empty string",
  "notes": "one short line (e.g. fitment, oversized-freight warning, MAP confidence)"
}
Rules: report the per-unit MAP as a number only (no $ or commas). Include up to 5 sellers with the prices you actually saw. Do NOT wrap the JSON in code fences.`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text()
      console.error('Anthropic API error:', anthropicRes.status, errText)
      return NextResponse.json({ error: `Search error: ${anthropicRes.status}`, detail: errText }, { status: 500 })
    }

    const rawData = await anthropicRes.json()
    const text = (rawData.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('')
    const parsed = parseModelJson(text)
    if (!parsed) {
      return NextResponse.json({ error: 'Could not read the search result.' }, { status: 422 })
    }

    const num = (v: any): number => {
      const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''))
      return Number.isFinite(n) ? n : 0
    }
    const sellers = (Array.isArray(parsed.sellers) ? parsed.sellers : [])
      .map((s: any) => ({ name: String(s.name || '').trim(), price: num(s.price), url: String(s.url || '').trim() }))
      .filter((s: any) => s.name)

    return NextResponse.json({
      found: parsed.found !== false && num(parsed.map) > 0,
      part_number: String(parsed.part_number || partNumber),
      name: String(parsed.name || '').slice(0, 80),
      manufacturer: String(parsed.manufacturer || ''),
      map: num(parsed.map),
      sellers,
      best_place: String(parsed.best_place || ''),
      recommended_dealership: String(parsed.recommended_dealership || ''),
      notes: String(parsed.notes || ''),
    })
  } catch (err) {
    console.error('hunt-part error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

function parseModelJson(raw: string): any | null {
  if (!raw) return null
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{')
  if (start === -1) return null
  text = text.slice(start)
  const end = text.lastIndexOf('}')
  if (end !== -1) text = text.slice(0, end + 1)
  try { return JSON.parse(text) } catch { return null }
}
