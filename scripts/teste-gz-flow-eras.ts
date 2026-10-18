// Conferência das ERAS da tela GZ FLOW (só LÊ os dois bancos): soma das eras = número do motor? npx tsx scripts/teste-gz-flow-eras.ts
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
const key = (f: string) => fs.readFileSync(MEM + f, 'utf8').trim()
async function main() {
  const { readCrossingRows } = await import('../lib/crossingBalance.server')
  const { computeCrossingBalance } = await import('../lib/crossingBalance')
  const us = createClient('https://fvgpkbpqacnqxtrjsmpi.supabase.co', key('us-service-key.txt'), { auth: { persistSession: false } })
  const br = createClient('https://saaowriaptbvfoqoykrh.supabase.co', key('br-service-key.txt'), { auth: { persistSession: false } })
  const d = computeCrossingBalance(await readCrossingRows({ us, br }))
  const cut = '2026-01-01', era = (x: string | null | undefined) => (x ? (x.slice(0, 10) < cut ? 1 : 2) : null), r2 = (v: number) => Math.round(v * 100) / 100
  const ymd = (ts: string | null, tz: string) => { if (!ts) return null; const t = new Date(ts); const i = t.toISOString(); return i.endsWith('T00:00:00.000Z') ? i.slice(0, 10) : t.toLocaleDateString('en-CA', { timeZone: tz }) }
  const E: Record<number, { u: number; b: number; nu: number; nb: number }> = { 1: { u: 0, b: 0, nu: 0, nb: 0 }, 2: { u: 0, b: 0, nu: 0, nb: 0 } }
  for (const inv of d.usSide.invoices) {
    const ds = [...inv.items.filter(i => i.counted).map(i => i.day), ...inv.incomes.filter(p => p.counted).map(p => p.paymentDate ? p.paymentDate.slice(0, 10) : ymd(p.paidAt, 'America/New_York'))].filter(Boolean).sort() as string[]
    const e = era(ds[0] || inv.day) || 2; E[e].u += inv.open; E[e].nu++
  }
  for (const inv of d.brSide.invoices) {
    const pd = (p: any) => p.paymentDate ? p.paymentDate.slice(0, 10) : ymd(p.paidAt, 'America/Sao_Paulo')
    const ds = [...inv.lines.map(l => l.day), ...inv.payments.filter(p => p.counted).map(pd)].filter(Boolean).sort() as string[]
    const fb = era(ds[0] || inv.day) || 2, seen = new Set<number>()
    for (const l of inv.lines) { const e = era(l.day) || fb; E[e].b += l.usd; seen.add(e) }
    for (const p of inv.payments) if (p.counted) { const e = era(pd(p)) || fb; E[e].b -= p.usd; seen.add(e) }
    for (const e of seen) E[e].nb++
  }
  for (const k of [1, 2]) console.log(`Era ${k}: 006.N ${E[k].nu} inv, open US$ ${r2(E[k].u)} · 085.N ${E[k].nb} inv, open US$ ${r2(E[k].b)} · BR owes US US$ ${r2(E[k].u - E[k].b)}`)
  console.log(`soma das eras US$ ${r2(E[1].u - E[1].b + E[2].u - E[2].b)} · motor US$ ${d.brOwesUs}`)
}
main()
