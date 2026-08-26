// CREW CHIEF P1 — o MINERADOR de blueprints (26/ago/2026). Funções PURAS,
// computadas ao vivo na tela de curadoria: NADA aqui grava no banco.
// Decisões do fan-out adversarial (11 agentes) + ajustes do João:
//   · o prefixo "NN. " REINICIA por frente de trabalho dentro da mesma invoice
//     (US.040.3 tem três "01.") — cada corrida contínua é uma espinha própria;
//   · a solda kit↔duty é ato HUMANO (só 5 invoices têm os dois);
//   · dica de tempo: o suspeito é o STINT (>10h contínuas = timer esquecido,
//     mesma régua do DUTY WATCH), nunca o total da duty (João);
//   · minerar é escolher EXEMPLARES, não aprender padrões — o corpus é pequeno.
// Importa a gramática de duty do Márcio (lib/utils) — nunca reimplementa.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { dutyOrderOf, stripDutyOrder } from '@/lib/utils'

export const STINT_MAX_HOURS = 10   // João, 26/ago: >10h numa esticada = suspeito

export type MinedKitBlock = { kitName: string; members: { description: string; quantity: number; cost: number | null }[]; invoiceIds: string[] }
export type SpineStep = { order: number | null; description: string; priority: string }
export type ExemplarSpine = { invoiceId: string; steps: SpineStep[]; backlog: SpineStep[] }
export type DutyStat = { canonical: string; variants: Record<string, number>; invoiceIds: string[]; timed: number[]; medianSeconds: number | null; suspectStints: number; priorityTop: string }
export type FamilyDraft = {
  family: string
  platform: string | null
  invoiceIds: string[]
  exemplars: { invoiceId: string; score: number; dutyCount: number; spineLen: number; kitCount: number }[]
  kitBlocks: MinedKitBlock[]
  primarySpine: ExemplarSpine | null
  vocabulary: DutyStat[]
  services: { description: string; n: number }[]
  matchingPacks: { id: string; name: string; status: string; dutiesCount: number }[]
}

const num = (v: unknown) => Number(v) || 0
export const normDuty = (s: unknown) => stripDutyOrder(String(s || '')).trim().toLowerCase()

// Palavras significativas de um nome de pack ("Demonized Pack (D170)" → demonized).
const packTokens = (name: string) =>
  String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 5 && !['pack', 'combo', 'full', 'stage', 'tier'].includes(w))

export const platformOf = (name: string): string | null => {
  const m = String(name || '').match(/\((D170|TRX|LT4|LT1|HELLCAT|REDEYE)\)/i)
  return m ? m[1].toUpperCase() : null
}

// Duties com STINT suspeito (>10h contínuas) — telemetria envenenada, fora das
// dicas de tempo. Pareamento igual ao staffDutyWatch: STARTED/RESUMED → próximo.
export function poisonedDutyIds(dutyEvents: any[]): Set<string> {
  const poisoned = new Set<string>()
  const open = new Map<string, any>()
  const sorted = [...dutyEvents].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  for (const e of sorted) {
    if (e.action === 'STARTED' || e.action === 'RESUMED') { if (!open.has(e.duty_id)) open.set(e.duty_id, e) }
    else if (e.action === 'PAUSED' || e.action === 'DONE') {
      const s = open.get(e.duty_id)
      if (s) {
        const wallH = (Date.parse(e.at) - Date.parse(s.at)) / 3600e3
        if (wallH > STINT_MAX_HOURS) poisoned.add(e.duty_id)
        open.delete(e.duty_id)
      }
    }
  }
  // stint ainda ABERTO e já longo também envenena (timer rodando esquecido)
  for (const [id, s] of open) if ((Date.now() - Date.parse(s.at)) / 3600e3 > STINT_MAX_HOURS) poisoned.add(id)
  return poisoned
}

// Espinhas de uma invoice: corridas contíguas de "NN." que REINICIAM em 01
// viram espinhas separadas; sem prefixo = backlog (STANDBY por padrão).
export function spinesOf(duties: any[]): { spines: SpineStep[][]; backlog: SpineStep[] } {
  // dutyOrderOf (Márcio) devolve STRING '01'…'99' ou '' — converte na fronteira
  const ordered = duties
    .map(d => { const o = dutyOrderOf(String(d.description || '')); return { order: o ? Number(o) : null, description: String(d.description || ''), priority: String(d.priority || '1') } })
  const backlog = ordered.filter(d => d.order == null).map(d => ({ ...d, order: null }))
  const withOrder = ordered.filter(d => d.order != null).sort((a, b) => (a.order as number) - (b.order as number))
  const spines: SpineStep[][] = []
  // agrupa por reinício: cada vez que a ordem volta pra ≤ à anterior, nova espinha
  for (const d of withOrder) {
    const cur = spines[spines.length - 1]
    if (!cur || (cur.length && (d.order as number) <= (cur[cur.length - 1].order as number))) spines.push([d])
    else cur.push(d)
  }
  return { spines, backlog }
}

export function mineFamilies(data: {
  invoices: any[]; invParts: any[]; invServices: any[]; invDuties: any[]; dutyEvents: any[]; packs: any[]
}): FamilyDraft[] {
  const { invoices, invParts, invServices, invDuties, dutyEvents, packs } = data
  const poisoned = poisonedDutyIds(dutyEvents)
  const partsByInv = groupBy(invParts, p => p.invoice_id)
  const svcsByInv = groupBy(invServices, s => s.invoice_id)
  const dutiesByInv = groupBy(invDuties, d => d.invoice_id)

  // FAMÍLIAS por tokens de nome de pack achados nos serviços/parts da invoice
  // (regra do João: match simples + reagrupamento manual na tela; nada de IA em n=3).
  const fams = new Map<string, { platform: string | null; invoiceIds: Set<string>; packIds: string[] }>()
  for (const pk of packs) {
    const toks = packTokens(pk.name)
    if (!toks.length) continue
    const fam = toks[0]
    const e = fams.get(fam) || { platform: platformOf(pk.name), invoiceIds: new Set<string>(), packIds: [] }
    e.packIds.push(pk.id)
    if (!e.platform) e.platform = platformOf(pk.name)
    for (const inv of invoices) {
      const hay = [
        inv.service || '',
        ...(svcsByInv.get(inv.id) || []).map((s: any) => s.description),
        ...(partsByInv.get(inv.id) || []).map((p: any) => p.description),
      ].join(' ').toLowerCase()
      if (toks.some(t => hay.includes(t))) e.invoiceIds.add(inv.id)
    }
    fams.set(fam, e)
  }
  // balde das ricas-em-duties sem família (≥4 duties)
  const claimed = new Set([...fams.values()].flatMap(f => [...f.invoiceIds]))
  const orphanRich = invoices.filter(i => !claimed.has(i.id) && (dutiesByInv.get(i.id) || []).length >= 4)
  if (orphanRich.length) fams.set('sem família (ricas em duties)', { platform: null, invoiceIds: new Set(orphanRich.map(i => i.id)), packIds: [] })

  const out: FamilyDraft[] = []
  for (const [family, f] of fams) {
    const ids = [...f.invoiceIds]
    if (!ids.length) continue
    // exemplares por riqueza: duties + espinha + kits
    const exemplars = ids.map(id => {
      const du = dutiesByInv.get(id) || []
      const { spines } = spinesOf(du)
      const kitCount = new Set((partsByInv.get(id) || []).filter((p: any) => p.kit_group).map((p: any) => p.kit_name)).size
      const spineLen = Math.max(0, ...spines.map(s => s.length))
      return { invoiceId: id, dutyCount: du.length, spineLen, kitCount, score: du.length + spineLen * 2 + kitCount * 3 }
    }).sort((a, b) => b.score - a.score)

    // KIT BLOCKS recorrentes na família
    const kitAgg = new Map<string, { members: Map<string, { qty: number; costs: number[] }>; invs: Set<string> }>()
    for (const id of ids) for (const p of (partsByInv.get(id) || [])) {
      if (!p.kit_group || !p.kit_name) continue
      const k = String(p.kit_name).trim()
      const e = kitAgg.get(k) || { members: new Map(), invs: new Set() }
      e.invs.add(id)
      const mk = String(p.description || '').trim()
      const me = e.members.get(mk) || { qty: num(p.quantity) || 1, costs: [] }
      if (p.base_cost != null) me.costs.push(num(p.base_cost))
      e.members.set(mk, me)
      kitAgg.set(k, e)
    }
    const kitBlocks: MinedKitBlock[] = [...kitAgg.entries()].map(([kitName, e]) => ({
      kitName, invoiceIds: [...e.invs],
      members: [...e.members.entries()].map(([description, m]) => ({ description, quantity: m.qty, cost: m.costs.length ? median(m.costs) : null })),
    })).sort((a, b) => b.invoiceIds.length - a.invoiceIds.length)

    // espinha primária = maior espinha do melhor exemplar
    let primarySpine: ExemplarSpine | null = null
    if (exemplars[0] && exemplars[0].dutyCount > 0) {
      const du = dutiesByInv.get(exemplars[0].invoiceId) || []
      const { spines, backlog } = spinesOf(du)
      const best = spines.sort((a, b) => b.length - a.length)[0] || []
      primarySpine = { invoiceId: exemplars[0].invoiceId, steps: best, backlog }
    }

    // vocabulário + dicas de tempo (regra do stint)
    const vocab = new Map<string, DutyStat>()
    for (const id of ids) for (const d of (dutiesByInv.get(id) || [])) {
      const key = normDuty(d.description)
      if (!key) continue
      const v = vocab.get(key) || { canonical: stripDutyOrder(String(d.description)).trim(), variants: {}, invoiceIds: [], timed: [], medianSeconds: null, suspectStints: 0, priorityTop: '1' }
      const raw = stripDutyOrder(String(d.description)).trim()
      v.variants[raw] = (v.variants[raw] || 0) + 1
      if (!v.invoiceIds.includes(id)) v.invoiceIds.push(id)
      if (poisoned.has(d.id)) v.suspectStints++
      else if (d.done && num(d.time_seconds) > 0) v.timed.push(num(d.time_seconds))
      vocab.set(key, v)
    }
    const vocabulary = [...vocab.values()].map(v => ({
      ...v,
      canonical: Object.entries(v.variants).sort((a, b) => b[1] - a[1])[0][0],
      medianSeconds: v.timed.length ? median(v.timed) : null,
    })).sort((a, b) => b.invoiceIds.length - a.invoiceIds.length)

    // serviços por frequência
    const svcAgg = new Map<string, number>()
    for (const id of ids) for (const s of (svcsByInv.get(id) || [])) {
      const k = String(s.description || '').trim(); if (!k) continue
      svcAgg.set(k, (svcAgg.get(k) || 0) + 1)
    }

    out.push({
      family, platform: f.platform, invoiceIds: ids, exemplars: exemplars.slice(0, 5),
      kitBlocks, primarySpine, vocabulary,
      services: [...svcAgg.entries()].map(([description, n]) => ({ description, n })).sort((a, b) => b.n - a.n).slice(0, 10),
      matchingPacks: packs.filter(pk => f.packIds.includes(pk.id)).map(pk => ({ id: pk.id, name: pk.name, status: pk.status, dutiesCount: Array.isArray(pk.duties) ? pk.duties.length : 0 })),
    })
  }
  return out.sort((a, b) => b.invoiceIds.length - a.invoiceIds.length)
}

function groupBy<T>(rows: T[], key: (r: any) => string): Map<string, any[]> {
  const m = new Map<string, any[]>()
  for (const r of rows as any[]) { const k = key(r); if (!k) continue; const a = m.get(k) || []; a.push(r); m.set(k, a) }
  return m
}
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
