import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { PART_CATEGORIES, suggestCategory } from '@/lib/partsMeta'

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
    let hasSupplierId = true
    let parts: any[] = []
    try { parts = await fetchAll(db, 'parts_database', 'id, item, alias, part_number, supplier, unit_price, map_price, locked_at, source_type, is_kit, supplier_id') }
    catch (e) { if (!/supplier_id/.test(String(e))) throw e; hasSupplierId = false; parts = await fetchAll(db, 'parts_database', 'id, item, alias, part_number, supplier, unit_price, map_price, locked_at, source_type, is_kit') }
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
    // ── R1: fornecedor com identidade (188 grafias → 40 oficiais) ──
    const suppliers = await fetchAll(db, 'suppliers', 'id, name, aliases')
    const supNorm = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim()
    // Fricção #3 do João (25/ago): "O&J PERFORMANCE INC" tem que achar "OJ Performance".
    // supHard = identidade dura: só letras/números (& e pontuação caem) e sem sufixo
    // legal no fim (INC/LLC/CORP…). Igualdade dura = mesma empresa = CERTO.
    const SUP_SUFFIX = new Set(['INC', 'INCORPORATED', 'LLC', 'CORP', 'CORPORATION', 'LTD', 'LIMITED', 'CO'])
    const supHard = (s: unknown) => {
      const w = String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
      while (w.length > 1 && SUP_SUFFIX.has(w[w.length - 1])) w.pop()
      return w.join('')
    }
    const offRows = suppliers.map((s: any) => {
      const rawAliases = String(s.aliases || '').split(/[,\n]/)
      return { id: s.id, name: s.name, n: supNorm(s.name), h: supHard(s.name), aliases: rawAliases.map(supNorm).filter(Boolean), hAliases: rawAliases.map(supHard).filter(Boolean) }
    })
    const supCandidates = (text: string) => {
      const t = supNorm(text), th = supHard(text)
      if (!t) return []
      const out: { id: string; label: string; certain: boolean; score: number }[] = []
      for (const o of offRows) {
        if (o.n === t || o.aliases.includes(t)) { out.push({ id: o.id, label: o.name, certain: true, score: 100 }); continue }
        if (th.length >= 3 && (o.h === th || o.hAliases.includes(th))) { out.push({ id: o.id, label: o.name, certain: true, score: 95 }); continue }
        const flat = th, fo = o.h
        if (flat.length >= 4 && (fo.includes(flat) || flat.includes(fo) || flat.includes(fo.slice(0, Math.min(8, fo.length))))) out.push({ id: o.id, label: o.name, certain: false, score: Math.min(flat.length, fo.length) })
      }
      return out.sort((a, b) => Number(b.certain) - Number(a.certain) || b.score - a.score).slice(0, 4)
    }
    const supItems = hasSupplierId ? parts.filter((p: any) => !p.supplier_id && String(p.supplier || '').trim()).map((p: any) => ({
      id: p.id, text: String(p.supplier).slice(0, 60), part: [p.part_number, p.alias || p.item].filter(Boolean).join(' · ').slice(0, 70), candidates: supCandidates(p.supplier),
    })) : []
    // higiene: MAP < custo, source_type nulo, KIT × is_kit em desacordo
    const mapBad = parts.filter((p: any) => p.map_price != null && p.unit_price != null && Number(p.map_price) > 0 && Number(p.map_price) < Number(p.unit_price))
      .map((p: any) => ({ id: p.id, item: String(p.alias || p.item || '').slice(0, 60), cost: Number(p.unit_price), map: Number(p.map_price) }))
    const noSource = parts.filter((p: any) => !p.source_type).map((p: any) => String(p.alias || p.item || '').slice(0, 60))
    const kitMismatch = parts.filter((p: any) => (p.source_type === 'KIT') !== !!p.is_kit && (p.source_type === 'KIT' || p.is_kit)).map((p: any) => ({ item: String(p.alias || p.item || '').slice(0, 60), st: p.source_type, kit: !!p.is_kit }))
    // categorias: vazia ou fora do vocabulário fechado → sugestão por palavra-chave
    const catSet = new Set<string>(PART_CATEGORIES as unknown as string[])
    const catItems = parts.filter((p: any) => !p.category || !catSet.has(p.category)).map((p: any) => ({
      id: p.id, item: String(p.alias || p.item || '').slice(0, 70), current: p.category || null,
      suggest: suggestCategory([p.item, p.alias, p.category].filter(Boolean).join(' ')),
    }))
    return NextResponse.json({
      ok: true, needs_migration: needsMigration,
      totals: { parts: parts.length, locked: catalog.filter(c => c.locked).length, inv_unlinked: invItems.length, inv_total: inv.length, ps_unlinked: psItems.length, ps_total: ps.length, no_pn: noPN.length, dup_pn: dupPN.length, sup_unlinked: supItems.length, map_bad: mapBad.length },
      inventory: invItems, streams: psItems, no_pn: noPN.slice(0, 200), dup_pn: dupPN.slice(0, 50),
      suppliers_unlinked: supItems, map_bad: mapBad.slice(0, 60), no_source: noSource.slice(0, 60), kit_mismatch: kitMismatch.slice(0, 40), needs_supplier_migration: !hasSupplierId,
      categories: catItems, category_vocab: PART_CATEGORIES,
    })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  // R1: linka o FORNECEDOR oficial na peça do catálogo (guarda is-null + trilha).
  if (String(b.action) === 'link_supplier') {
    const partId2 = String(b.part_id || ''), supplierId = String(b.supplier_id || '')
    if (!partId2 || !supplierId) return NextResponse.json({ error: 'bad request' }, { status: 400 })
    const db = bankDb()
    const { data: sup } = await db.from('suppliers').select('id, name').eq('id', supplierId).maybeSingle()
    if (!sup) return NextResponse.json({ error: 'fornecedor não encontrado' }, { status: 404 })
    const { data: r, error } = await db.from('parts_database').update({ supplier_id: supplierId }).eq('id', partId2).is('supplier_id', null).select('id, item, alias')
    if (error) return NextResponse.json({ error: error.message, needs_migration: /supplier_id/.test(error.message) }, { status: 500 })
    if (!r || !r.length) return NextResponse.json({ error: 'peça já linkada — recarregue' }, { status: 409 })
    await db.from('data_fixes').insert({
      check_key: 'parts-suppliers', table_name: 'parts_database', row_id: partId2, field: 'supplier_id',
      old_value: null, new_value: supplierId, label: (`FORNECEDOR · ${r[0].alias || r[0].item} → ${sup.name}`).slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true })
  }
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
