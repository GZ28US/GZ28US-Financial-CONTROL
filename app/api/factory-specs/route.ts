import { NextRequest, NextResponse } from 'next/server'

// Returns the FACTORY (stock) crank engine ratings for a car, used to build the
// BoneStock baseline dyno row. hp = SAE net crank horsepower, nm = crank torque (N·m).
export async function POST(req: NextRequest) {
  try {
    const { manufacturer, brand, model, version, year } = await req.json()
    const car = [year, brand, model, version].filter(Boolean).join(' ').trim()
    if (!car) return NextResponse.json({ error: 'Missing car details' }, { status: 400 })

    const prompt = `Give the FACTORY (stock, as delivered from the manufacturer) engine ratings for this exact car:
${year || ''} ${brand || ''} ${model || ''} ${version || ''}${manufacturer ? ` (${manufacturer})` : ''}

Return ONLY valid JSON, no other text:
{ "hp": <SAE net crank horsepower as a number>, "nm": <crank torque in Newton-metres as a number> }

Rules:
- Use the manufacturer's official RATED CRANK (engine, not wheel) figures for that exact year/trim/engine.
- The "version" usually names the engine (e.g. "Base 6.0" = Corvette LS2 6.0L V8 = 400 hp / 543 N·m; "Z06 7.0" = LS7 7.0L V8; "ZR1 6.2 SC" = LS9 supercharged).
- If torque is officially published in lb-ft, convert to N·m (× 1.35582). If in kgf·m, convert to N·m (× 9.80665).
- Output plain numbers only (no units, no commas). If unsure of the exact trim, give your best estimate for that engine.
- Output a single raw JSON object, no markdown fences.`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) {
      const t = await res.text()
      return NextResponse.json({ error: `Anthropic API error: ${res.status}`, detail: t }, { status: 500 })
    }
    const data = await res.json()
    const text = data.content?.map((c: any) => c.text || '').join('') || ''
    const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim()
    const s = clean.indexOf('{'); const e = clean.lastIndexOf('}')
    if (s === -1 || e === -1) return NextResponse.json({ error: 'No specs found' }, { status: 422 })
    let parsed: any
    try { parsed = JSON.parse(clean.slice(s, e + 1)) } catch { return NextResponse.json({ error: 'Bad specs JSON' }, { status: 422 }) }
    const num = (v: any) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null }
    return NextResponse.json({ hp: num(parsed.hp), nm: num(parsed.nm) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
