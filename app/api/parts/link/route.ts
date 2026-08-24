import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// LINKER — identidade de peças (pré-P1 do Crew Chief, 24/ago/2026).
// GET: pra cada linha de inventory e part_streams SEM part_id, os candidatos do
// catálogo: PN da peça aparece no texto = CERTO (o número não mente); apelido/
// nome batendo = sugestão. Também a higiene do catálogo: peça sem part_number
// e PN duplicado (regra uma-linha-por-PN).
// POST { action:'link', table:'inventory'|'part_streams', id, part_id } grava o
// ponteiro (só se ainda vazio) com trilha. O card do Data Checker consome isto;
// o bulk PREENCHER CERTOS usa o mesmo POST um a um.
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */
const normPN = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const words = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4)

async function fetchAll(db: any, table: string, select: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).order('id').range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const parts = await fetchAll(db, 'parts_database', 'id, item, alias, part_number, supplier, unit_price, locked_at')
    const catalog = parts.map((p: any) => ({
      id: p.id, label: [p.part_number, p.item].filter(Boolean).join(' · ').slice(0, 90),
      pn: normPN(p.part_number), toks: new Set([...words(p.item), ...words(p.alias)]), locked: !!p.locked_at, supplier: p.supplier || '',
    }))
    const withPN = catalog.filter(c => c.pn.length >= 5)
    // candidatos pra um texto livre
    const candidatesFor = (text: string, supplier: string) => {
      const t = normPN(text), tw = words(text), sup = String(supplier || '').toUpperCase()
      const scored: { id: string; label: string; certain: boolean; score: number }[] = []
      for (const c of withPN) if (t.includes(c.pn)) scored.push({ id: c.id, label: c.label, certain: true, score: 100 + c.pn.length })
      if (!scored.length) for (const c of catalog) {
        let hit = 0; for (const w of tw) if (c.toks.has(w)) hit++
        if (c.supplier && sup && String(c.supplier).toUpperCase().includes(sup.slice(0, 6))) hit++
        if (hit >= 2) scored.push({ id: c.id, label: c.label, certain: false, score: hit })
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, 4)
    }
    let needsMigration = false
    let inv: any[] = [], ps: any[] = []
    try { inv = await fetchAll(db, 'inventory', 'id, description, supplier, source_type, part_id') } catch (e) { if (/part_id/.test(String(e))) needsMigration = true; else throw e }
    try { ps = await fetchAll(db, 'part_streams', 'id, item, supplier, status, part_id') } catch (e) { if (/part_id/.test(String(e))) needsMigration = true; else throw e }
    const invItems = inv.filter(r => !r.part_id).map(r => ({ table: 'inventory', id: r.id, text: r.description || '', supplier: r.supplier || '', extra: r.source_type || '', candidates: candidatesFor(r.description, r.supplier) }))
    const psItems = ps.filter(r => !r.part_id).map(r => ({ table: 'part_streams', id: r.id, text: r.item || '', supplier: r.supplier || '', extra: r.status || '', candidates: candidatesFor(r.item, r.supplier) }))
    // higiene do catálogo
    const noPN = parts.filter((p: any) => !normPN(p.part_number)).map((p: any) => ({ id: p.id, item: String(p.item || '').slice(0, 80) }))
    const byPN = new Map<string, any[]>()
    for (const p of parts) { const k = normPN(p.part_number); if (k.length >= 5) byPN.set(k, [...(byPN.get(k) || []), p]) }
    const dupPN = [...byPN.entries()].filter(([, l]) => l.length > 1).map(([pn, l]) => ({ pn, items: l.map((p: any) => String(p.item || '').slice(0, 50)) }))
    return NextResponse.json({
      ok: true, needs_migration: needsMigration,
      totals: { parts: parts.length, locked: catalog.filter(c => c.locked).length, inv_unlinked: invItems.length, inv_total: inv.length, ps_unlinked: psItems.length, ps_total: ps.length, no_pn: noPN.length, dup_pn: dupPN.length },
      inventory: invItems, streams: psItems, no_pn: noPN.slice(0, 200), dup_pn: dupPN.slice(0, 50),
    })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const table = String(b.table || ''), id = String(b.id || ''), partId = String(b.part_id || '')
  if (String(b.action) !== 'link' || !['inventory', 'part_streams'].includes(table) || !id || !partId) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  try {
    const db = bankDb()
    const { data: part } = await db.from('parts_database').select('id, item, part_number').eq('id', partId).maybeSingle()
    if (!part) return NextResponse.json({ error: 'peça não encontrada no catálogo' }, { status: 404 })
    // só escreve onde ainda está vazio — religar exige deslinkar antes (trilha honesta)
    const { data: r, error } = await db.from(table).update({ part_id: partId }).eq('id', id).is('part_id', null).select('id')
    if (error) return NextResponse.json({ error: error.message, needs_migration: /part_id/.test(error.message) }, { status: 500 })
    if (!r || !r.length) return NextResponse.json({ error: 'linha já linkada — recarregue' }, { status: 409 })
    await db.from('data_fixes').insert({
      check_key: 'parts-linker', table_name: table, row_id: id, field: 'part_id',
      old_value: null, new_value: partId, label: (`LINK · ${table} → ${[part.part_number, part.item].filter(Boolean).join(' · ')}`).slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
