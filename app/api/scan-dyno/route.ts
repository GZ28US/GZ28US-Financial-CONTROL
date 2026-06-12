import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { base64, mediaType } = await req.json()

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    }

    const isPDF = mediaType === 'application/pdf'

    const prompt = `You are reading a chassis DYNO chart (Dynojet or similar) for a car. Extract the PEAK figures and return ONLY valid JSON, no other text:
{
  "pack": "the build/tune package or chart title if clearly shown on the sheet, else empty string",
  "whp": "peak wheel horsepower (the 'Max Power' value) as a number string like 911.55",
  "wnm": "peak wheel torque in Newton-metres (the 'Max Torque' value) as a number string like 1137.52",
  "date": "the test date in YYYY-MM-DD format, or empty string if not found",
  "dyno": "the dyno operator. If a GZ28 or GZ28US logo/name appears, return 'GZ28US DynoJet'. If a DynoSolutions logo/name appears, return 'DynoSolutions DynoJet'. Otherwise empty string."
}
Rules:
1. Numbers may use a comma as the decimal separator (e.g. 911,55 means 911.55). Convert every value to a dot decimal and remove any thousands separators. Output plain number strings only — no units, no commas.
2. whp = peak wheel power in horsepower (HP). If the sheet reports power in "cv"/"CV" (metric horsepower), convert to HP by multiplying by 0.98632; if already HP/wHP/bhp, leave as-is. wnm = peak wheel torque CONVERTED to Newton-metres (N·m). Some dynos report torque in kgf·m (written "Kgf.m", "kgf.m", "Kgfm" or "kgfm") — convert to N·m by multiplying by 9.80665. If torque is in lb-ft, multiply by 1.35582. If already in N·m, leave as-is. Output the converted N·m value.
3. date: parse any printed timestamp such as "11:23:49 PM, Tuesday, June 9, 2026" into "2026-06-09".
4. dyno: inspect logos and any header/footer text. Prefer exactly 'GZ28US DynoJet' or 'DynoSolutions DynoJet'. Use empty string if you cannot tell.
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
        max_tokens: 1024,
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
            { type: 'text', text: prompt }
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
    const parsed = parseModelJson(text)
    if (!parsed) {
      return NextResponse.json({ error: 'Could not read the chart. The scan did not return valid data.' }, { status: 422 })
    }

    const numStr = (v: any): string => {
      const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '')
      const n = parseFloat(cleaned)
      return Number.isFinite(n) ? String(n) : ''
    }

    const allowedDynos = ['GZ28US DynoJet', 'DynoSolutions DynoJet']
    const dyno = allowedDynos.includes(String(parsed.dyno || '').trim()) ? String(parsed.dyno).trim() : ''

    return NextResponse.json({
      pack: typeof parsed.pack === 'string' ? parsed.pack.trim() : '',
      whp: numStr(parsed.whp),
      wnm: numStr(parsed.wnm),
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '',
      dyno,
    })

  } catch (err) {
    console.error('scan-dyno error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

function parseModelJson(raw: string): any | null {
  if (!raw) return null
  const text = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
