import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'

// TRACK RECEIPT SCAN (Márcio, 10/10/2026 — the 1/8, 1/4 and 100-200 pages, «same standards of the dyno page»).
// Two kinds of paper:
//   DRAG — a drag-strip TIMESLIP (Produpark, CompuLink, Portatree…): reaction, 60 ft, 330 ft/100 m, 1/8 (660 ft/201 m)
//          + trap, 1000 ft/302 m, 1/4 (1320 ft/402 m) + trap.
//   ROLL — a 100-200 km/h PERFORMANCE REPORT (Dragy and the like): the 100-200 time, the 100-110 … 100-200 splits,
//          distance, slope, temperature, altitude, density altitude, VALID stamp.
// Same law as scan-dyno: the model reads the paper AS PRINTED (value + unit); every conversion happens HERE, in code.
// Canonical storage is metric (km/h, m) — the US app shows mph/ft at render time.
const KMH_PER_MPH = 1.609344

export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const { base64, mediaType, filename } = await req.json()
    if (!base64 || !mediaType) return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 })
    const isPDF = mediaType === 'application/pdf'

    const prompt = `You are reading a car PERFORMANCE RECEIPT. It is one of two kinds:
(A) a drag-strip TIMESLIP (thermal paper or a printout) with incremental times at fixed distances, or
(B) a 100-200 km/h acceleration PERFORMANCE REPORT from a GPS meter app (e.g. Dragy), with a speed/height/acceleration chart and a table of splits like "100-110 0.47s".
Read EVERYTHING EXACTLY AS PRINTED — never convert units — and return ONLY one raw JSON object, no other text:
{
  "kind": "DRAG for a timeslip, ROLL for a 100-200 report, else empty string",
  "date": "the run date as YYYY-MM-DD, or empty string. Slips printed in Brazil/Europe use DD/MM/YYYY (e.g. 10/10/2026, 25/09/2026); US slips use MM/DD/YYYY. Ignore any 'Record ... Data' line — that is the track record, not this run.",
  "time": "the time of the run as printed (HH:MM:SS), from the 'Hora'/'Time' line, else empty string",
  "track": "the track or timing-system name printed on the slip (e.g. a website or venue line), else empty string",
  "driver": "the driver/racer name if printed (e.g. 'Nome:'), else empty string",
  "lane": "the lane if printed (e.g. 'Lado: E' -> 'Left', 'D' -> 'Right', 'L'/'R'), else empty string",
  "category": "the class/category line if printed, else empty string",
  "distance_unit": "DRAG only: 'm' when the increments are labelled in meters (100m, 201m, 302m, 402m), 'ft' when in feet (60', 330', 660', 1000', 1320'). 60 ft ('60 Pes', '60 ft', '60'') is always feet.",
  "speed_unit": "the unit of every trap speed and of the ROLL speeds: 'km/h' or 'mph'",
  "reaction": "DRAG: reaction time ('Reacao', 'R/T'), number string, else empty",
  "t60": "DRAG: 60 ft time",
  "t330": "DRAG: 330 ft or 100 m time",
  "t660": "DRAG: 660 ft / 201 m / 1/8 mile elapsed time",
  "v660": "DRAG: the trap speed printed at 660 ft / 201 m / 1/8",
  "t1000": "DRAG: 1000 ft or 302 m time. If the digits are smudged or unreadable, return empty string — never guess.",
  "t1320": "DRAG: 1320 ft / 402 m / 1/4 mile elapsed time",
  "v1320": "DRAG: the trap speed at 1320 ft / 402 m / 1/4",
  "total": "DRAG: the 'Soma'/'Total' line (reaction + ET) if printed",
  "range_from": "ROLL: the start speed of the measured range (e.g. 100)",
  "range_to": "ROLL: the end speed of the measured range (e.g. 200)",
  "roll_time": "ROLL: the headline time for the full range (e.g. 6.94)",
  "splits": "ROLL: an array of objects {\\"to\\": end speed number, \\"s\\": seconds number} for EVERY row of the split table, e.g. [{\\"to\\":110,\\"s\\":0.47}]",
  "distance": "ROLL: the distance covered as printed (number string)",
  "distance_unit_roll": "ROLL: 'm' or 'ft'",
  "slope": "ROLL: slope percent as printed with its sign (e.g. -0.86)",
  "temp": "ROLL: temperature number",
  "temp_unit": "ROLL: 'C' or 'F'",
  "altitude": "ROLL: altitude number (the mountain icon)",
  "density_altitude": "ROLL: density altitude number ('DA')",
  "alt_unit": "ROLL: 'm' or 'ft'",
  "device": "ROLL: the device id shown at the top (e.g. 'DRG69'), prefixed by the app name when visible (e.g. 'Dragy DRG69'), else empty",
  "valid": "ROLL: true when a 'Valid' stamp/seal is shown, false when 'Invalid', else null"
}
Rules:
1. Numbers may use a comma as the decimal separator (06,947 means 6.947; 01,590 means 1.590). Output dot-decimal number strings with no units and no leading zeros beyond one (\"6.947\", \"1.590\", \"0.825\"). A leading '+' or '-' on the reaction keeps its sign.
2. Unused fields are empty strings (or [] for splits, null for valid).
3. Output a single raw JSON object — no markdown fences, no text before or after.`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            ...(isPDF
              ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }]
              : [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }]),
            { type: 'text', text: prompt },
          ],
        }],
      }),
    })
    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text()
      console.error('scan-track Anthropic error:', anthropicRes.status, errText)
      return NextResponse.json({ error: `Anthropic API error: ${anthropicRes.status}`, detail: errText }, { status: 500 })
    }
    const raw = await anthropicRes.json()
    const text = raw.content?.map((c: any) => c.text || '').join('') || ''
    const p = parseModelJson(text)
    if (!p) return NextResponse.json({ error: 'Could not read the receipt. The scan did not return valid data.' }, { status: 422 })

    const num = (v: any): number | null => {
      const s = String(v ?? '').trim().replace(',', '.').replace(/[^0-9.+\-]/g, '')
      if (!s) return null
      const n = parseFloat(s)
      return Number.isFinite(n) ? n : null
    }
    const r3 = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000)
    const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)
    const str = (v: any) => (typeof v === 'string' ? v.trim() : '')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(p.date)) ? str(p.date) : dateFromFilename(String(filename || ''))
    const kind = String(p.kind || '').toUpperCase()
    const toKmh = (v: number | null) => (v == null ? null : String(p.speed_unit || '').toLowerCase().includes('mph') ? v * KMH_PER_MPH : v)

    if (kind === 'DRAG') {
      // Incremental times must grow with distance. A value that breaks the order is a misread (a smudged slip) —
      // it becomes empty instead of a wrong number in the bank.
      const seq: Array<[string, number | null]> = [['t60', num(p.t60)], ['t330', num(p.t330)], ['t660', num(p.t660)], ['t1000', num(p.t1000)], ['t1320', num(p.t1320)]]
      const dropped: string[] = []
      let last = 0
      for (const s of seq) {
        if (s[1] == null) continue
        if (s[1] <= last) { dropped.push(s[0]); s[1] = null; continue }
        last = s[1]
      }
      const t = Object.fromEntries(seq) as Record<string, number | null>
      if (t.t660 == null && t.t1320 == null) return NextResponse.json({ error: 'No 1/8 or 1/4 elapsed time was found on this slip.' }, { status: 422 })
      return NextResponse.json({
        kind: 'DRAG',
        date, time: str(p.time), track: str(p.track), driver: str(p.driver), lane: str(p.lane), category: str(p.category),
        reaction_s: r3(num(p.reaction)),
        t60ft_s: r3(t.t60), t100m_s: r3(t.t330), t201m_s: r3(t.t660), t302m_s: r3(t.t1000), t402m_s: r3(t.t1320),
        v201m_kmh: r2(toKmh(num(p.v660))), v402m_kmh: r2(toKmh(num(p.v1320))),
        total_s: r3(num(p.total)),
        note: dropped.length ? `out-of-order value(s) dropped: ${dropped.join(', ')}` : '',
      })
    }

    if (kind === 'ROLL') {
      const from = num(p.range_from), to = num(p.range_to)
      const mph = String(p.speed_unit || '').toLowerCase().includes('mph')
      // This page is 100-200 km/h. A 60-130 mph report is a different test — refuse it instead of filing it here.
      if (mph || (from != null && from !== 100) || (to != null && to !== 200)) {
        return NextResponse.json({ error: `This report measures ${from ?? '?'}-${to ?? '?'} ${mph ? 'mph' : 'km/h'} — the page takes 100-200 km/h only.` }, { status: 422 })
      }
      const splits = Array.isArray(p.splits)
        ? p.splits.map((s: any) => ({ to: num(s?.to), s: r2(num(s?.s)) })).filter((s: any) => s.to != null && s.s != null).sort((a: any, b: any) => a.to - b.to)
        : []
      const rollTime = r2(num(p.roll_time)) ?? (splits.find((s: any) => s.to === 200)?.s ?? null)
      if (rollTime == null) return NextResponse.json({ error: 'No 100-200 time was found on this report.' }, { status: 422 })
      const ft = (v: number | null, unit: any) => (v == null ? null : String(unit || '').toLowerCase() === 'ft' ? v * 0.3048 : v)
      const tc = num(p.temp)
      return NextResponse.json({
        kind: 'ROLL',
        date, time: str(p.time), device: str(p.device),
        t100_200_s: rollTime,
        splits,
        distance_m: r2(ft(num(p.distance), p.distance_unit_roll)),
        slope_pct: r2(num(p.slope)),
        temp_c: tc == null ? null : r2(String(p.temp_unit || '').toUpperCase() === 'F' ? (tc - 32) * 5 / 9 : tc),
        altitude_m: r2(ft(num(p.altitude), p.alt_unit)),
        density_alt_m: r2(ft(num(p.density_altitude), p.alt_unit)),
        valid: typeof p.valid === 'boolean' ? p.valid : null,
      })
    }

    return NextResponse.json({ error: 'This is neither a drag-strip timeslip nor a 100-200 km/h report.' }, { status: 422 })
  } catch (err) {
    console.error('scan-track error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// WhatsApp names its files «WhatsApp Image 2026-10-10 at 2.47.19 PM.jpeg» — the 100-200 screenshot carries no date of
// its own, so the file name is the next-best proof of the day.
function dateFromFilename(name: string): string {
  const m = name.match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

function parseModelJson(raw: string): any | null {
  if (!raw) return null
  const text = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}
