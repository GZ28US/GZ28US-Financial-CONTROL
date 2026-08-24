import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// TAX HUB · 1099-NEC (v0.1.0): agrega TODO pagamento da LLC via Zelle, wire ou
// cheque por BENEFICIÁRIO e por ANO, direto do extrato (bank_transactions — a
// fonte que não mente). O humano classifica cada um em tax_contractors
// (Serviço/Mercadoria/Corporação/Pessoal/Ignorar) e marca o W-9. Regra geral:
// serviço ≥ $600/ano a não-corporação pede 1099-NEC até 31/jan — quem afirma a
// lei é a Drummond; o app só organiza. Cartão/PayPal ficam de fora (o
// processador emite 1099-K, não nós — regra geral, idem).
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown) => parseFloat(String(v)) || 0
const r2 = (v: number) => Math.round(v * 100) / 100
const FEE_RE = /FEE|ASSESSMENT|ANALYSIS CHARGE|SERVICE CHARGE|WITHDRAWAL/i

function payeeOf(l: { name: string | null; check_number: string | null }): { key: string; name: string; method: string } | null {
  const n = String(l.name || '')
  if (FEE_RE.test(n)) return null
  const z = n.match(/zelle debit to (.+?)(?: ref#| ref\b|$)/i)
  if (z) { const p = z[1].trim(); return { key: norm(p), name: p, method: 'ZELLE' } }
  if (/^wire transfer/i.test(n) && !/incoming|domestic out|intl|international/i.test(n)) {
    const p = n.replace(/^wire transfer\s*/i, '').trim()
    if (p) return { key: norm(p), name: p, method: 'WIRE' }
  }
  if (l.check_number || /^check\b/i.test(n)) return { key: 'CHECK#' + (l.check_number || '?'), name: 'Cheque #' + (l.check_number || '?'), method: 'CHECK' }
  return null
}
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim()

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const rows: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('bank_transactions').select('date, amount, name, check_number, match_status, pending')
        .gt('amount', 0).neq('match_status', 'REMOVED').order('id').range(from, from + 999)
      if (error) throw new Error(error.message)
      rows.push(...(data || []))
      if (!data || data.length < 1000) break
    }
    // beneficiário × ano
    const agg = new Map<string, { key: string; name: string; years: Map<string, { total: number; n: number; methods: Set<string>; last: string }> }>()
    for (const l of rows) {
      const p = payeeOf(l)
      if (!p) continue
      const y = String(l.date).slice(0, 4)
      const a = agg.get(p.key) || { key: p.key, name: p.name, years: new Map() }
      const yr = a.years.get(y) || { total: 0, n: 0, methods: new Set<string>(), last: l.date }
      yr.total = r2(yr.total + num(l.amount)); yr.n++; yr.methods.add(p.method); if (l.date > yr.last) yr.last = l.date
      a.years.set(y, yr); agg.set(p.key, a)
    }
    // classificações (tabela pode não existir ainda — migration); aliases (v0.2.0)
    let contractors = new Map<string, any>(), needsMigration = false, hasAliases = true
    let { data: tc, error: tcErr } = await db.from('tax_contractors').select('id, name_key, display_name, classification, w9_on_file, notes, aliases')
    if (tcErr && /aliases/.test(tcErr.message)) { hasAliases = false; ({ data: tc, error: tcErr } = await db.from('tax_contractors').select('id, name_key, display_name, classification, w9_on_file, notes')) }
    if (tcErr) needsMigration = /tax_contractors/.test(tcErr.message)
    else contractors = new Map((tc || []).map((c: any) => [c.name_key, c]))
    // FOLD: apelido → canônico. O banco trunca nomes de jeitos diferentes; quem
    // decide que dois nomes são a mesma pessoa é o humano (botão UNIR).
    const canonicalOf = new Map<string, string>()
    contractors.forEach((c: any, k: string) => { for (const a of String(c.aliases || '').split('\n').map((s: string) => s.trim()).filter(Boolean)) canonicalOf.set(a, k) })
    const folded = new Map<string, { key: string; name: string; years: Map<string, { total: number; n: number; methods: Set<string>; last: string }> }>()
    agg.forEach(a => {
      const ck = canonicalOf.get(a.key) || a.key
      const dst = folded.get(ck) || { key: ck, name: contractors.get(ck)?.display_name || (ck === a.key ? a.name : ck), years: new Map() }
      a.years.forEach((yr, y) => {
        const t = dst.years.get(y) || { total: 0, n: 0, methods: new Set<string>(), last: yr.last }
        t.total = r2(t.total + yr.total); t.n += yr.n; yr.methods.forEach(m => t.methods.add(m)); if (yr.last > t.last) t.last = yr.last
        dst.years.set(y, t)
      })
      folded.set(ck, dst)
    })
    // Dica "parece o mesmo": prefixo de 8+ caracteres em comum (sem espaços).
    const foldedKeys = [...folded.values()].map(f => ({ key: f.key, name: f.name, flat: f.key.replace(/[^A-Z0-9]/g, '') }))
    const hints: { a_key: string; a_name: string; b_key: string; b_name: string }[] = []
    for (let i = 0; i < foldedKeys.length; i++) for (let j = i + 1; j < foldedKeys.length; j++) {
      const A = foldedKeys[i], B = foldedKeys[j]
      const n = Math.min(A.flat.length, B.flat.length, 8)
      if (n >= 7 && A.flat.slice(0, n) === B.flat.slice(0, n)) hints.push({ a_key: A.key, a_name: A.name, b_key: B.key, b_name: B.name })
    }
    const years = new Map<string, any[]>()
    folded.forEach(a => {
      const c = contractors.get(a.key)
      a.years.forEach((yr, y) => {
        if (yr.total < 600) return
        const arr = years.get(y) || []
        arr.push({ key: a.key, name: c?.display_name || a.name, total: yr.total, n: yr.n, methods: [...yr.methods], last_date: yr.last, classification: c?.classification || null, w9_on_file: !!c?.w9_on_file, notes: c?.notes || null })
        years.set(y, arr)
      })
    })
    const out = [...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, payees]) => ({ year, payees: payees.sort((a, b) => b.total - a.total) }))
    return NextResponse.json({ ok: true, needs_migration: needsMigration, needs_alias_migration: !hasAliases, years: out, merge_hints: hints.slice(0, 20) })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  // UNIR (v0.2.0): alias_key some da lista e vira apelido do canônico — soma,
  // classificação e W-9 do apelido são absorvidos (canônico manda quando tem).
  if (String(b.action) === 'merge') {
    const canonical = String(b.canonical_key || ''), canonicalName = String(b.canonical_name || canonical), alias = String(b.alias_key || '')
    if (!canonical || !alias || canonical === alias) return NextResponse.json({ error: 'chaves inválidas' }, { status: 400 })
    const db2 = bankDb()
    const { data: rows, error: gErr } = await db2.from('tax_contractors').select('id, name_key, display_name, classification, w9_on_file, notes, aliases').in('name_key', [canonical, alias])
    if (gErr) return NextResponse.json({ error: gErr.message, needs_migration: /aliases|tax_contractors/.test(gErr.message) }, { status: 500 })
    const can = (rows || []).find(r => r.name_key === canonical), al = (rows || []).find(r => r.name_key === alias)
    const aliasSet = new Set<string>([
      ...String(can?.aliases || '').split('\n').map(s => s.trim()).filter(Boolean),
      ...String(al?.aliases || '').split('\n').map(s => s.trim()).filter(Boolean),
      alias,
    ])
    aliasSet.delete(canonical)
    const { error: upErr } = await db2.from('tax_contractors').upsert([{
      name_key: canonical, display_name: can?.display_name || canonicalName,
      classification: can?.classification || al?.classification || null,
      w9_on_file: !!(can?.w9_on_file || al?.w9_on_file),
      notes: [can?.notes, al?.notes].filter(Boolean).join(' · ') || null,
      aliases: [...aliasSet].join('\n') || null, updated_at: new Date().toISOString(),
    }], { onConflict: 'name_key' })
    if (upErr) return NextResponse.json({ error: upErr.message, needs_migration: /aliases/.test(upErr.message) }, { status: 500 })
    if (al) await db2.from('tax_contractors').delete().eq('id', al.id)
    await db2.from('data_fixes').insert({
      check_key: 'tax-1099', table_name: 'tax_contractors', row_id: canonical, field: 'aliases',
      old_value: alias, new_value: 'UNIDO', label: (`UNIR · "${al?.display_name || alias}" agora é ${can?.display_name || canonicalName}`).slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true })
  }
  const key = String(b.key || ''), name = String(b.name || key)
  const cls = b.classification == null || b.classification === '' ? null : String(b.classification)
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  if (cls && !['SERVICE', 'GOODS', 'CORPORATION', 'PERSONAL', 'IGNORE'].includes(cls)) return NextResponse.json({ error: 'classification inválida' }, { status: 400 })
  const db = bankDb()
  const { error } = await db.from('tax_contractors').upsert([{
    name_key: key, display_name: name, classification: cls, w9_on_file: !!b.w9_on_file, notes: String(b.notes || '') || null, updated_at: new Date().toISOString(),
  }], { onConflict: 'name_key' })
  if (error) return NextResponse.json({ error: error.message, needs_migration: /tax_contractors/.test(error.message) }, { status: 500 })
  await db.from('data_fixes').insert({
    check_key: 'tax-1099', table_name: 'tax_contractors', row_id: key, field: 'classification',
    old_value: null, new_value: cls || '(vazio)', label: (`1099 · ${name}` + (b.w9_on_file ? ' · W-9 ✓' : '')).slice(0, 200),
  }).then(() => undefined, () => undefined)
  return NextResponse.json({ ok: true })
}
