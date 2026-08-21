import { NextRequest, NextResponse } from 'next/server'

// DYNO SHEET SCAN — the US app records torque in POUND-FEET (lb·ft), always
// (user law 20/aug/2026). The model reads the sheet AS PRINTED (value + unit);
// every conversion happens HERE, in code, never inside the model. Reason: the
// GZ28US DynoJet started printing N·m in Aug/2026 and the old "convert it
// yourself" prompt was obeyed on some sheets and ignored on others — five pulls
// landed in the bank with raw N·m labelled as lb·ft.
const LBFT_PER_NM = 1 / 1.3558179       // N·m  → lb·ft
const LBFT_PER_KGFM = 9.80665 / 1.3558179 // kgf·m → lb·ft
const HP_PER_CV = 0.98632                // metric hp (cv/PS) → hp

export async function POST(req: NextRequest) {
  try {
    const { base64, mediaType } = await req.json()

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    }

    const isPDF = mediaType === 'application/pdf'

    const prompt = `You are reading a chassis DYNO chart (Dynojet or similar) for a car. Extract the PEAK figures EXACTLY AS PRINTED — do NOT convert any unit — and return ONLY valid JSON, no other text:
{
  "pack": "the build/tune package or chart title if clearly shown on the sheet, else empty string",
  "power": "peak power (the 'Max Power' value) as printed, as a number string like 911.55",
  "power_unit": "the unit the POWER axis/legend is printed in: exactly one of \\"hp\\" or \\"cv\\"",
  "torque": "peak torque (the 'Max Torque' value) as printed, as a number string like 1137.52",
  "torque_unit": "the unit the TORQUE axis/legend is printed in: exactly one of \\"lb-ft\\", \\"N·m\\" or \\"kgf·m\\"",
  "date": "the test date in YYYY-MM-DD format, or empty string if not found",
  "dyno": "the dyno operator. If a GZ28 or GZ28US logo/name appears, return 'GZ28US DynoJet'. If a DynoSolutions logo/name appears, return 'DynoSolutions DynoJet'. Otherwise empty string."
}
Rules:
1. Numbers may use a comma as the decimal separator (e.g. 911,55 means 911.55). Convert every value to a dot decimal and remove any thousands separators. Output plain number strings only — no units.
2. torque_unit comes from the TORQUE axis label or legend: "Torque (ft-lbs)" / "lb-ft" / "ft·lb" → "lb-ft"; "Torque (N·m)" / "Nm" → "N·m"; "Kgf.m" / "kgfm" / "kgf·m" → "kgf·m". Read the label — do not guess from the size of the number.
3. power_unit: "Power (hp)" / "HP" / "wHP" → "hp"; "cv" / "CV" / "PS" → "cv".
4. date: parse any printed timestamp such as "11:23:49 PM, Tuesday, June 9, 2026" into "2026-06-09".
5. dyno: inspect logos and any header/footer text. Prefer exactly 'GZ28US DynoJet' or 'DynoSolutions DynoJet'. Use empty string if you cannot tell.
6. Output must be a single raw JSON object. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the JSON.`

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

    const num = (v: any): number | null => {
      const cleaned = String(v ?? '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '')
      const n = parseFloat(cleaned)
      return Number.isFinite(n) ? n : null
    }
    const r2 = (n: number) => Math.round(n * 100) / 100

    // ---- POWER → hp (in code) ----
    const powerRaw = num(parsed.power ?? parsed.whp)
    const powerUnit = /cv|ps/i.test(String(parsed.power_unit || '')) ? 'cv' : 'hp'
    const whp = powerRaw != null ? r2(powerUnit === 'cv' ? powerRaw * HP_PER_CV : powerRaw) : null

    // ---- TORQUE → lb·ft (in code) ----
    const torqueRaw = num(parsed.torque ?? parsed.wnm)
    const unitStr = String(parsed.torque_unit || '').toLowerCase()
    let torqueUnit: 'lb-ft' | 'N·m' | 'kgf·m' = /kgf|kgm/.test(unitStr) ? 'kgf·m' : /n\s*[·.\-]?\s*m|nm|newton/.test(unitStr) ? 'N·m' : 'lb-ft'
    let unitNote = ''
    // Sanity guard: a V8 chart never peaks above ~1.25 lb·ft per hp. If the model
    // says lb-ft but the ratio screams N·m (≈1.36 per lb·ft), trust the physics —
    // this is exactly the failure that put raw N·m in the bank.
    if (torqueUnit === 'lb-ft' && torqueRaw != null && whp != null && whp > 0 && torqueRaw / whp > 1.28) {
      torqueUnit = 'N·m'
      unitNote = 'torque read as lb-ft but the torque/hp ratio says N·m — converted as N·m'
    }
    const wnm = torqueRaw != null
      ? r2(torqueUnit === 'N·m' ? torqueRaw * LBFT_PER_NM : torqueUnit === 'kgf·m' ? torqueRaw * LBFT_PER_KGFM : torqueRaw)
      : null

    const allowedDynos = ['GZ28US DynoJet', 'DynoSolutions DynoJet']
    const dyno = allowedDynos.includes(String(parsed.dyno || '').trim()) ? String(parsed.dyno).trim() : ''

    return NextResponse.json({
      pack: typeof parsed.pack === 'string' ? parsed.pack.trim() : '',
      whp: whp != null ? String(whp) : '',
      wnm: wnm != null ? String(wnm) : '',            // ALWAYS lb·ft
      torque_as_printed: torqueRaw != null ? String(torqueRaw) : '',
      torque_unit_printed: torqueUnit,
      unit_note: unitNote,
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
