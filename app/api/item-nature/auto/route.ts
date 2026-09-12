import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { ITEM_TABLES, type ItemTable } from '@/lib/itemTracking.server'
import { normNature, type Nature } from '@/lib/itemNature'

// A NATUREZA SE PREENCHE SOZINHA onde há PROVA (DC 1.44.0, João, 8/set/2026 — levantamento
// «Data Checker autossuficiente»). Três provas, medidas em produção:
//   1. CARRO → DINHEIRO: a MESMA régua que o DFC usa pra reconhecer compra de carro
//      (≥ $15k + vocabulário de carro ou apelido do ride, com guarda de peça) — 27 linhas, $1,3M.
//   2. PN DO CATÁLOGO ou part_id → PEÇA: identidade dura — 279 linhas.
//   3. HÁBITO UNÂNIME do fornecedor (≥3 linhas classificadas, ≥90% numa natureza) → a mesma,
//      salvo palavra-chave contradizendo (aí é a exceção: HHP vende tune e vela) — 536 linhas.
// Cada escrita deixa «AUTO · <prova>» em data_fixes (card SOZINHO, DESFAZER genérico). Esta
// rota não toca a do Márcio (/api/item-nature): só lê o mesmo dado e escreve pela mesma trava
// (nature IS NULL). `staff_expenses` fica fora (portão da folha).
export const maxDuration = 120

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fornecedor canônico (mesma ideia da rota do Márcio, sem importar um route.ts): só letras e dígitos, sem sufixo legal.
const canonSupplier = (raw: unknown) => String(raw || '').toUpperCase().replace(/\b(INC|LLC|LTD|CORP|CO|COMPANY|STORE|THE|USA)\b\.?/g, '').replace(/[^A-Z0-9]/g, '')
const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const normPN = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
// Réplica de lib/financials.isCarLine (o módulo é 'use client'; a régua é que é lei, não o arquivo).
const CAR_TOKENS = /car purchase|compra |challenger|charger|demon|hellcat|redeye|widebody|superstock|camaro|z\/28|vin\s|corvette|mustang|durango/i
const CAR_PART_GUARD = /engine|kit\b|heads|camshaft|transmission|c[âa]mbio|turbo|porting|supercharger|pulley|injector/i
const isCarLine = (text: string, amount: number, nickname?: string | null) => {
  if (amount < 15000 || CAR_PART_GUARD.test(text)) return false
  if (CAR_TOKENS.test(text)) return true
  const nick = String(nickname || '').trim()
  return nick.length >= 4 && text.toUpperCase().includes(nick.toUpperCase())
}
// Palavra-chave só pra CONTRADIZER o hábito (a exceção pede gente); nunca pra gravar sozinha.
const HINT: [RegExp, Nature][] = [
  [/\b(sales )?tax\b|imposto|\bfee\b|taxa|freight|shipping|frete|customs|duty|surcharge|handling/i, 'CHARGE'],
  [/\blabor\b|install|servi[çc]o|service\b|m[ãa]o de obra|dyno|alignment|alinhamento|tuning session|porting/i, 'SERVICE'],
  [/license|licen[çc]a|subscription|assinatura|software|tune file|calibration|credits?\b|firmware/i, 'DIGITAL'],
  [/\bwire\b|installment|parcela|payment \d\/\d|down payment|dep[óo]sito|entrada do carro/i, 'MONEY'],
]
const hintFor = (t: string): Nature | null => { const h = String(t || '').slice(0, 80); const m = HINT.find(([re]) => re.test(h)); return m ? m[1] : null }

const SPECS: Record<Exclude<ItemTable, 'staff_expenses'>, { select: string; desc: (r: any) => string; amount: (r: any) => number; partId?: boolean; inv?: boolean }> = {
  invoice_expenses: { select: 'id, item, supplier, price, quantity, tax, extra, invoice_id, nature', desc: r => r.item, amount: r => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra), partId: true, inv: true },
  inputs: { select: 'id, description, supplier, unit_price, quantity, nature', desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1) },
  inventory: { select: 'id, description, supplier, unit_price, quantity, nature', desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1), partId: true },
  assets: { select: 'id, description, supplier, unit_price, quantity, nature', desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1) },
  assets_expenses: { select: 'id, description, supplier, amount, nature', desc: r => r.description, amount: r => num(r.amount) },
}

async function fetchAll(db: any, table: string, select: string, filter?: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).order('id').range(from, from + 999)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}
// part_id existe em invoice_expenses/inventory por migration; sem a coluna, segue sem ela.
async function fetchRows(db: any, table: string, spec: { select: string; partId?: boolean }): Promise<any[]> {
  if (spec.partId) { try { return await fetchAll(db, table, spec.select + ', part_id') } catch (e) { if (!/part_id/.test(String(e))) throw e } }
  return fetchAll(db, table, spec.select)
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const b = await req.json().catch(() => ({}))
  const dry = !!b.dry
  const cap = Math.min(2000, Math.max(1, Number(b.max) || 800))
  const res = { car: 0, pn: 0, habit: 0, contradicted: 0, pending: 0, written: 0, dry, errors: [] as string[] }
  try {
    const [pnRows, invoices, rides] = await Promise.all([
      fetchAll(db, 'parts_database', 'id, part_number'),
      fetchAll(db, 'invoices', 'id, ride_id'),
      fetchAll(db, 'rides', 'id, project_name'),
    ])
    const pns = pnRows.map((p: any) => normPN(p.part_number)).filter((s: string) => s.length >= 5)
    const rideName = new Map<string, string>(rides.map((r: any) => [String(r.id), String(r.project_name || '')]))
    const invNick = new Map<string, string>(invoices.map((i: any) => [String(i.id), rideName.get(String(i.ride_id)) || '']))
    // Hábito por fornecedor canônico, sobre TODAS as tabelas (o fornecedor é o mesmo em qualquer uma).
    const habit = new Map<string, Record<string, number>>()
    const all: { table: string; r: any; text: string; amount: number; key: string }[] = []
    for (const table of ITEM_TABLES) {
      if (table === 'staff_expenses') continue
      const spec = SPECS[table]
      for (const r of await fetchRows(db, table, spec)) {
        const text = String(spec.desc(r) || '').trim()
        const key = canonSupplier(r.supplier)
        const n = normNature(r.nature)
        if (n) { if (key) { const m = habit.get(key) || {}; m[n] = (m[n] || 0) + 1; habit.set(key, m) }; continue }
        all.push({ table, r, text, amount: spec.amount(r), key })
      }
    }
    res.pending = all.length
    const unanimous = (key: string): Nature | null => { const m = habit.get(key); if (!m) return null; const e = Object.entries(m); const tot = e.reduce((s, [, n]) => s + n, 0); const top = e.sort((a, b) => b[1] - a[1])[0]; return tot >= 3 && top[1] / tot >= 0.9 ? (top[0] as Nature) : null }
    const decided: { table: string; id: string; nature: Nature; proof: string; text: string }[] = []
    for (const x of all) {
      const t = x.text
      if (isCarLine(t, x.amount, x.table === 'invoice_expenses' ? invNick.get(String(x.r.invoice_id)) : null)) { decided.push({ table: x.table, id: String(x.r.id), nature: 'MONEY', proof: 'compra de carro (≥ $15k + carro/apelido, mesma régua do DFC)', text: t }); res.car++; continue }
      const tn = normPN(t)
      if (x.r.part_id || (tn.length >= 5 && pns.some(p => tn.includes(p)))) { decided.push({ table: x.table, id: String(x.r.id), nature: 'PART', proof: x.r.part_id ? 'peça do catálogo (part_id)' : 'PN do catálogo no texto', text: t }); res.pn++; continue }
      const h = x.key ? unanimous(x.key) : null
      if (h) { const hint = hintFor(t); if (hint && hint !== h) { res.contradicted++; continue } decided.push({ table: x.table, id: String(x.r.id), nature: h, proof: 'hábito unânime do fornecedor (≥3 linhas, ≥90%)', text: t }); res.habit++ }
    }
    if (dry) return NextResponse.json({ ok: true, ...res })
    // Escreve em lotes por (tabela, natureza), só onde nature ainda é NULL; trilha por linha.
    const todo = decided.slice(0, cap)
    const groups = new Map<string, { table: string; nature: Nature; rows: typeof todo }>()
    for (const d of todo) { const k = d.table + '|' + d.nature; const g = groups.get(k) || { table: d.table, nature: d.nature, rows: [] as typeof todo }; g.rows.push(d); groups.set(k, g) }
    for (const g of groups.values()) {
      for (let i = 0; i < g.rows.length; i += 100) {
        const chunk = g.rows.slice(i, i + 100)
        const { data: ok, error } = await (db.from(g.table) as any).update({ nature: g.nature }).in('id', chunk.map(c => c.id)).is('nature', null).select('id')
        if (error) { res.errors.push(g.table + ': ' + error.message); continue }
        const okIds = new Set((ok || []).map((r: any) => String(r.id)))
        const trail = chunk.filter(c => okIds.has(c.id)).map(c => ({ check_key: 'item-nature', table_name: g.table, row_id: c.id, field: 'nature', old_value: null, new_value: g.nature, label: ('AUTO · ' + c.proof + ' · ' + c.text).slice(0, 200) }))
        if (trail.length) await db.from('data_fixes').insert(trail).then(() => undefined, () => undefined)
        res.written += okIds.size
      }
    }
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    const m = String((e as Error).message || e)
    if (/nature/.test(m) && /column|does not exist/.test(m)) return NextResponse.json({ ok: true, needs_migration: true, ...res })
    return NextResponse.json({ error: m.slice(0, 300) }, { status: 500 })
  }
}
