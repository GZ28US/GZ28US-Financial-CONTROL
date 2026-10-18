// lib/factorySpecs.server.ts — A POTÊNCIA DE FÁBRICA DE UM CARRO (crank SAE hp + N·m), base da linha BoneStock.
// Saiu de app/api/factory-specs/route.ts em 18/10/2026 para o servidor usar sem HTTP (lib/packPerformance.server.ts: a
// performance que nasce com a invoice do pack validado). A rota continua sendo a porta da tela; a regra mora aqui.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type CarroSpecs = { manufacturer?: string | null; brand?: string | null; model?: string | null; version?: string | null; year?: string | number | null; special_edition?: string | null }
export type Specs = { hp: number | null; nm: number | null }

export class ErroSpecs extends Error {
  status: number
  detail?: string
  constructor(message: string, status: number, detail?: string) { super(message); this.status = status; this.detail = detail }
}

export async function factorySpecs({ manufacturer, brand, model, version, year, special_edition }: CarroSpecs): Promise<Specs> {
  // The special edition can CHANGE the rating (JailBreak 807 vs Redeye 797) — it
  // must reach the prompt, never be dropped.
  const se = special_edition && special_edition !== 'None' ? String(special_edition) : ''
  const car = [year, brand, model, version, se].filter(Boolean).join(' ').trim()
  if (!car) throw new ErroSpecs('Missing car details', 400)

  const prompt = `Give the FACTORY (stock, as delivered from the manufacturer) engine ratings for this exact car:
${year || ''} ${brand || ''} ${model || ''} ${version || ''}${se ? ` ${se}` : ''}${manufacturer ? ` (${manufacturer})` : ''}

Return ONLY valid JSON, no other text:
{ "hp": <SAE net crank horsepower as a number>, "nm": <crank torque in Newton-metres as a number> }

Rules:
- Use the manufacturer's official RATED CRANK (engine, not wheel) figures for that exact year/trim/engine.
- The "version" usually names the engine (e.g. "Base 6.0" = Corvette LS2 6.0L V8 = 400 hp / 543 N·m; "Z06 7.0" = LS7 7.0L V8; "ZR1 6.2 SC" = LS9 supercharged).
- If torque is officially published in lb-ft, convert to N·m (× 1.35582). If in kgf·m, convert to N·m (× 9.80665).
- Dodge SRT pins (verified facts — use them over your own recollection): an SRT Hellcat REDEYE with the "JailBreak" package is 807 hp / 959 N·m (the Jailbreak calibration adds 10 hp over the 797-hp Redeye); a BASE 717-hp Hellcat JailBreak stays 717 hp; the Challenger SRT Super Stock is 807 hp / 959 N·m in EVERY year (2020-2023); the 2023 Challenger "Black Ghost" is Redeye Widebody Jailbreak-based, 807 hp / 959 N·m.
- Output plain numbers only (no units, no commas). If unsure of the exact trim, give your best estimate for that engine.
- Output a single raw JSON object, no markdown fences.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new ErroSpecs(`Anthropic API error: ${res.status}`, 500, await res.text())
  const data = await res.json()
  const text = data.content?.map((c: any) => c.text || '').join('') || ''
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const s = clean.indexOf('{'); const e = clean.lastIndexOf('}')
  if (s === -1 || e === -1) throw new ErroSpecs('No specs found', 422)
  let parsed: any
  try { parsed = JSON.parse(clean.slice(s, e + 1)) } catch { throw new ErroSpecs('Bad specs JSON', 422) }
  const num = (v: any) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null }
  return { hp: num(parsed.hp), nm: num(parsed.nm) }
}
