// SERVER-ONLY — A CATEGORIA DA PEÇA SE PREENCHE SOZINHA (DC 1.42.0, João, 8/set/2026:
// «tem coisa no Data Checker que não precisa de gente pra resolver — é óbvio»).
//
// Regra da casa: PALPITE NÃO É PROVA. Dois leitores independentes concordando É prova:
//   1. a palavra-chave (lib/partsMeta.suggestCategory) — regras fixas, ordem importa;
//   2. a IA (Haiku) lendo o texto da peça com o vocabulário FECHADO de 13 valores.
// Concordaram → CERTA: o app grava sozinho, deixa trilha (data_fixes, «AUTO ·») e mostra
// «preenchidas sozinhas» com DESFAZER por 7 dias. Discordaram, ou só um sabe → PERGUNTA,
// com as duas opiniões na cara. A IA disse «não é peça» → pilha própria (frete, placa).
// O veredito da IA fica em parts_database.category_ai (MIGRATION_parts_category_ai.sql) —
// sem a coluna, o app segue vivo com a palavra-chave só e avisa.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PART_CATEGORIES, suggestCategory, type PartCategory } from './partsMeta'

export const NOT_A_PART = 'NOT_A_PART'
export type Tier = 'CERTAIN' | 'ASK' | 'NOT_PART' | 'PENDING'
const VOCAB = new Set<string>(PART_CATEGORIES as unknown as string[])

export const partText = (p: any) => [p.item, p.alias].filter(Boolean).map(String).join(' · ').slice(0, 240)

// Lote de até 20 peças por chamada; devolve id → categoria | NOT_A_PART | null (a IA não respondeu).
export async function classifyWithAI(rows: { id: string; text: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) { for (const r of rows) out.set(r.id, null); return out }
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20)
    const prompt = `Você classifica PEÇAS DE CARRO do catálogo de uma oficina de preparação (muscle cars americanos: Hellcat, Demon, Camaro, Corvette, Mustang, LS/LT, HEMI).
Vocabulário FECHADO (use exatamente um destes): ${PART_CATEGORIES.join(' | ')} | ${NOT_A_PART}
Guia: ENGINE = motor e tudo dentro/sobre ele (cam, pistão, biela, virabrequim, válvula, mola de válvula, retentor, junta, cabeçote, parafuso de cabeçote/mancal, coletor de admissão, corpo de borboleta, polia do supercharger, supercharger, turbo, bomba de óleo, pushrod, lifter). DRIVETRAIN = câmbio, embreagem, conversor, eixo, cardan, diferencial, semieixo, shifter. SUSPENSION & BRAKES = mola de suspensão, amortecedor, coilover, barra, bucha, freio, disco, pinça, pastilha. FUEL SYSTEM = bico, bomba de combustível, flauta, regulador de pressão, E85/flex, filtro de combustível, linhas AN de combustível. EXHAUST = header, escape, catback, downpipe, silencioso, ponteira, junta de coletor de escape. COOLING = radiador, intercooler, trocador de calor, bomba d'água, termostato, ventoinha, reservatório. ELECTRONICS = ECU/PCM, tuner (HP Tuners), sensores, chicote, cabos de vela, módulos, gauges, câmera, rádio/stereo, iluminação LED/faróis. WHEELS & TIRES = roda, pneu (tamanhos tipo 275/35ZR18; marcas Hoosier, Michelin, Toyo, Nitto, Mickey Thompson), porca, espaçador, TPMS. EXTERIOR = carroceria, capô, para-lama, para-choque, spoiler, splitter, emblema, adesivo, pintura, engate, paraquedas de arrancada, capa. INTERIOR = banco, volante, carpete, acabamento interno, pedal, manopla. CONSUMABLES = óleo, fluido, filtro de óleo/ar, vela, graxa, limpador, fita, abraçadeira, selante, luva. LABOR = mão de obra, instalação, tune/dyno como serviço. OTHER = ferramenta de oficina, item genérico de peça que não cabe acima. ${NOT_A_PART} = não é peça nem serviço de carro (frete/SEDEX, placa, taxa, texto solto, nome de loja).
Responda SOMENTE JSON: [{"id":"...","category":"..."}] — um objeto por id, todos os ids, nada mais.
PEÇAS:
${batch.map(r => JSON.stringify({ id: r.id, text: r.text })).join('\n')}`
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    }).then(x => x.json()).catch(() => null)
    const raw = String(r?.content?.[0]?.text || '').replace(/```json|```/g, '').trim()
    let arr: any[] = []
    try { const j = JSON.parse(raw); arr = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [] } catch { arr = [] }
    const got = new Map<string, string>()
    for (const x of arr) { const c = String(x?.category || '').trim().toUpperCase(); if (x?.id && (VOCAB.has(c) || c === NOT_A_PART)) got.set(String(x.id), c) }
    for (const b of batch) out.set(b.id, got.get(b.id) ?? null)
  }
  return out
}

// A régua dos dois leitores.
export function tierFor(keyword: string | null, ai: string | null | undefined): { tier: Tier; certain: PartCategory | null } {
  if (ai === undefined || ai === null) return { tier: 'PENDING', certain: null }
  if (ai === NOT_A_PART) return { tier: 'NOT_PART', certain: null }
  if (keyword && ai === keyword) return { tier: 'CERTAIN', certain: keyword as PartCategory }
  return { tier: 'ASK', certain: null }
}

// Lê a IA pras peças sem veredito, grava o veredito e PREENCHE as certas (com trilha).
// dry = só conta. Devolve o que fez.
// O preenchimento sozinho é LIGADO uma vez pelo dono (marcador em data_fixes): a primeira
// rodada só lê a IA e mostra a divisão (João, 8/set: «me mostre o corte antes de gravar»).
export async function autoFillEnabled(db: any): Promise<boolean> {
  const { data } = await db.from('data_fixes').select('id').eq('check_key', 'parts-category').eq('row_id', 'auto-fill').eq('field', 'ENABLED').limit(1).maybeSingle()
  return !!data
}
export async function enableAutoFill(db: any): Promise<void> {
  if (await autoFillEnabled(db)) return
  await db.from('data_fixes').insert({ check_key: 'parts-category', table_name: 'parts_database', row_id: 'auto-fill', field: 'ENABLED', old_value: null, new_value: 'on', label: 'LIGADO · a categoria entra sozinha quando palavra-chave e IA concordam' })
}
export async function classifyParts(db: any, parts: any[], opts: { max?: number; dry?: boolean; force?: boolean; fill?: boolean; knownMax?: number } = {}): Promise<{ read: number; filled: number; asked: number; not_part: number; no_ai: number; errors: string[] }> {
  const res = { read: 0, filled: 0, asked: 0, not_part: 0, no_ai: 0, errors: [] as string[] }
  const fill = opts.fill !== false
  const empty = parts.filter(p => !p.category || !VOCAB.has(p.category))
  const todo = empty.filter(p => opts.force || !p.category_ai).slice(0, opts.max ?? 80)
  // Já lidas pela IA (veredito guardado): só a régua e o preenchimento, sem reler.
  // Lote das já lidas limitado (8/set: 407 de uma vez levaram 87 s — a rota tem 60 s); o que sobrar entra na próxima abertura.
  const known = fill && !opts.dry ? empty.filter(p => p.category_ai && !todo.includes(p)).slice(0, opts.knownMax ?? 150) : []
  const verdict = todo.length ? await classifyWithAI(todo.map(p => ({ id: String(p.id), text: partText(p) }))) : new Map<string, string | null>()
  for (const p of known) verdict.set(String(p.id), String(p.category_ai))
  res.read = todo.length
  for (const p of [...todo, ...known]) {
    const fresh = todo.includes(p)
    const ai = verdict.get(String(p.id)) ?? null
    if (!ai) { res.no_ai++; continue }
    if (fresh && !opts.dry) { const { error } = await db.from('parts_database').update({ category_ai: ai, category_ai_at: new Date().toISOString() }).eq('id', p.id); if (error) { res.errors.push('category_ai: ' + error.message); continue } }
    const kw = suggestCategory(partText(p))
    const t = tierFor(kw, ai)
    if (t.tier === 'NOT_PART') { res.not_part++; continue }
    if (t.tier !== 'CERTAIN') { res.asked++; continue }
    if (opts.dry || !fill) { res.filled++; continue }   // desligado: conta como «certa, pronta» sem gravar
    // Escrita guardada pelo valor atual (vazio ou fora do vocabulário): 0 linhas = alguém mexeu.
    let q = db.from('parts_database').update({ category: t.certain }).eq('id', p.id)
    q = p.category ? q.eq('category', p.category) : q.is('category', null)
    const { data: ok, error } = await q.select('id')
    if (error) { res.errors.push('category: ' + error.message); continue }
    if (!ok || !ok.length) continue
    await db.from('data_fixes').insert({ check_key: 'parts-category', table_name: 'parts_database', row_id: p.id, field: 'category', old_value: p.category ?? null, new_value: t.certain, label: ('AUTO · palavra-chave + IA concordam · ' + partText(p)).slice(0, 200) }).then(() => undefined, () => undefined)
    res.filled++
  }
  return res
}
