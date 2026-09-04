import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { NATURES, normNature, type Nature } from '@/lib/itemNature'
import { ITEM_TABLES, EXPENSE_ITEM_GATE, type ItemTable } from '@/lib/itemTracking.server'

// ── O CARD QUE ENSINA O ROBÔ (04/set/2026) ──────────────────────────────────
// Ordem do Márcio, com todas as letras: "ensine as regras pro robô".
//
// lib/itemNature.ts criou a pergunta que faltava ANTES de "chegou?" — PEÇA,
// SERVIÇO, DIGITAL, ENCARGO ou DINHEIRO — e deixou NULL querendo dizer "ninguém
// disse ainda". Esta rota é a bancada onde o humano responde, e o card
// /adm/check#item-nature é a tela dela.
//
// ── POR QUE AGRUPADO POR FORNECEDOR, E NÃO LINHA A LINHA ────────────────────
// Medido no banco US em 04/set/2026 (1.544 linhas nas 6 tabelas de item, o gate
// de `expenses` aplicado): elas caem em ~187 grupos de fornecedor canonizado, e
// 34 grupos cobrem 80% DAS LINHAS enquanto 23 grupos cobrem 90% DO DINHEIRO.
// Linha a linha, o trabalho é interminável e ninguém começa; por fornecedor, ele
// é FINITO — e é essa a diferença entre a regra existir e a regra ser aplicada.
// Os números não estão escritos na tela: a rota recalcula `groups_80`/`groups_90`
// a cada carga, porque placar de memória envelhece e mente.
//
// ── O FORNECEDOR DÁ O PALPITE, A LINHA DÁ A RESPOSTA ────────────────────────
// O mesmo fornecedor vende naturezas opostas — Kramer AutoPlex tem 5 linhas de
// carro e uma de "Taxes & Fees", Texas Speed vende peça e cobra frete, HHP vende
// tune digital e vende vela NGK, Kong vende blower e cobra "SuperCharger
// Porting". Por isso:
//   · `suppliers.default_nature` (o "lembrar para este fornecedor") só
//     PRÉ-SELECIONA o botão do grupo. Nunca escreve sozinho em linha nenhuma.
//   · cada linha do grupo pode ser classificada sozinha ANTES do botão do grupo
//     — é a EXCEÇÃO POR LINHA, e é ela que salva o caso Kramer.
//   · o palpite por palavra ("Sales Tax" → ENCARGO) viaja como ETIQUETA na
//     linha, para a exceção saltar aos olhos. Ele nunca é aplicado por ninguém
//     além de um clique humano.
//
// ── A ESCRITA ───────────────────────────────────────────────────────────────
// Todo UPDATE é `.is('nature', null)` — só preenche o vazio. Regra automática
// pode PÔR badge, nunca TIRAR (lei de lib/itemNature.ts): se outra sessão já
// respondeu, esta não passa por cima, e a resposta volta como `skipped`.
// Toda escrita vira linha em data_fixes (check_key='item-nature'), com
// old_value e new_value POR CAMPO — inclusive a do palpite do fornecedor.
//
// GET  → { ok, needs_migration, totals, groups[] }
// POST { action:'apply', nature, rows:[{table,id}] }      → classifica em lote
// POST { action:'remember', supplier_id, nature|null }    → grava o palpite
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown) => parseFloat(String(v)) || 0

// ── A CANONIZAÇÃO DO FORNECEDOR ─────────────────────────────────────────────
// O texto livre escreve o mesmo fornecedor de N jeitos. Medido: "AutoZone Store
// 02484" e "AutoZone Store #2484, 2074 Ctrl Fla Pkwy, Orlando FL 32837" são a
// mesma loja em 2 grupos diferentes — sozinhas somam 100 linhas. Canonizar
// derrubou 235 grupos para 187 e é o que faz 34 grupos cobrirem 80% das linhas.
//   · corta no primeiro ',' ou '(' — dali pra frente é endereço ou canal
//   · "eBay - fulano" perde o canal: eBay é ordering_method, não fornecedor
//   · número solto e a palavra STORE somem (o nº da loja não muda a natureza)
//   · sufixo legal no fim (INC/LLC/CORP…) some — mesma empresa
const SUP_SUFFIX = new Set(['INC', 'INCORPORATED', 'LLC', 'CORP', 'CORPORATION', 'LTD', 'LIMITED', 'CO', 'COM'])
const SUP_NOISE = new Set(['STORE', 'STORES', 'SHOP', 'THE', 'OF'])
export function canonSupplier(raw: unknown): string {
  const raw0 = String(raw || '').trim()
  if (!raw0) return ''
  let s = raw0.split(/[,(]/)[0]
  s = s.replace(/\bebay\b\s*[-–—·:]*\s*/gi, ' ')
  s = s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
  const w = s.split(' ').filter(Boolean).filter(t => !SUP_NOISE.has(t) && !/^\d+$/.test(t))
  while (w.length > 1 && SUP_SUFFIX.has(w[w.length - 1])) w.pop()
  const c = w.join('')
  // NUNCA ESVAZIAR UM TEXTO QUE EXISTE. Achado ao rodar isto contra o banco:
  // "Store #2484, 2074 Ctrl Fla Pkwy" e "Ebay" ficavam sem nenhum token (loja +
  // número; canal + nada) e caíam no balde "(sem fornecedor)" — mentira, o
  // fornecedor está escrito ali. Sem letra sobrando, vale o texto cru.
  return c || raw0.toUpperCase().replace(/[^A-Z0-9]+/g, '')
}

// ── O PALPITE POR PALAVRA (etiqueta, nunca decisão) ─────────────────────────
// Só existe para a EXCEÇÃO saltar aos olhos dentro de um grupo grande: a linha
// "Sales Tax" no meio de 5 carros do Kramer, o "Shipping" no meio das peças da
// Texas Speed. A ordem importa — o primeiro que casar vence, e o mais
// específico (encargo) vem antes do mais genérico (serviço).
//
// PRECISÃO ACIMA DE COBERTURA, e por um motivo: etiqueta errada é PIOR que
// etiqueta ausente — ela empurra o humano pro lado errado, e o humano é o único
// que decide aqui. Por isso palavra que também é PEÇA ficou de fora, mesmo
// perdendo casos: "paint" é lata de tinta tanto quanto pintura, "installation
// kit" é peça, e "transfer case" é peça (daí o transfer só valer sem "case").
const HINT: [RegExp, Nature][] = [
  [/\b(sales\s*)?tax(es)?\b|\bimposto\b|taxes?\s*&\s*fees|\bfl\s*tax\b|\bdoc\s*fee\b|\btag\s*(&|and)\s*title\b|\bregistration\b|\blicense\s*fee\b|\bsurcharge\b|\bhandling\b|\bshipping\b|\bfrete\b|\bfreight\b|route\s*package\s*protection|\bseguro\b|\binsurance\b/i, 'CHARGE'],
  // "wire" só quando é a REMESSA: "6-Wire Oxygen Sensor" e "Plug Wire Set" são
  // peça. Sem look-behind de propósito (o projeto alveja ES2017): o grupo da
  // frente faz o mesmo trabalho e roda em qualquer runtime.
  [/(^|[^\d-])\bwire\b(?!\s*(harness|set|loom|kit))|\btransfer\b(?!\s*case)|\bdeposit\b|\bdown\s*payment\b|\bparcela\b|\binstallment\b|\brepasse\b|\bzelle\b|\bcar\s*purchase\b|\bpayoff\b|bank\s*fee/i, 'MONEY'],
  [/\btune\b|\btuning\b|\bcredits?\b|\blicense\b|\bunlock\b|vcm\s*suite|hp\s*tuners|\bmpvi\b|\bsubscription\b|\bsoftware\b/i, 'DIGITAL'],
  [/\bdyno\b|\blabor\b|\bporting\b|\bmachining\b|\bretífica\b|\brebuild\b|\bwrap\b|\btow(ing)?\b|\bcar\s*wash\b|\balignment\b|\brental\b|\baluguel\b/i, 'SERVICE'],
]
// ── SÓ OS PRIMEIROS 60 CARACTERES ───────────────────────────────────────────
// Medido nas 1.533 descrições reais: olhar o texto INTEIRO etiquetava peça como
// encargo por causa da NOTA no fim — "MOPAR 77072552AC Widebody Flare Kit …
// (HHP order 373270 — frete rateado)" virava ENCARGO, e "Injector Dynamics
// ID1750-XDS … (tax prorated)" também. As linhas que REALMENTE são encargo ou
// dinheiro dizem isso na cara: "Shipping", "Handling (order 806017)", "Freight —
// car transport", "Demon 170 #283 - Installment 3/5". Cortar em 60 derrubou as
// etiquetas erradas e manteve as certas (190 → 161 linhas etiquetadas).
const hintFor = (text: string): Nature | null => {
  const head = String(text || '').slice(0, 60)
  const m = HINT.find(([re]) => re.test(head))
  return m ? m[1] : null
}

// ── AS TABELAS DE ITEM, COM O NOME DE CADA COLUNA ───────────────────────────
// ITEM_TABLES é a lista canônica (lib/itemTracking.server.ts) — esta rota não
// inventa a sua. O que muda por tabela é só como cada uma escreve descrição,
// fornecedor, valor e data; e `expenses` carrega o EXPENSE_ITEM_GATE, senão a
// FOLHA inteira entraria na fila de classificação (lei de 03/set/2026).
// A invoice entra como CONTEXTO da linha: "013.2" ao lado de "Sales Tax" é a
// diferença entre decidir e adivinhar — e o link abre a invoice de verdade
// (mesmo endereço de invoiceMeta: /rides/<ride>/invoices/<id> ou /clients/…).
type InvCtx = Map<string, { code: string; href: string }>
type Spec = {
  select: string
  desc: (r: any) => string
  amount: (r: any) => number
  date: (r: any) => string | null
  href: (r: any, inv: InvCtx) => string
  ctx?: (r: any, inv: InvCtx) => string
}
const SPECS: Record<ItemTable, Spec> = {
  // valor = preço × qtd + tax + extra: a MESMA conta de expLine (lib/financials
  // é 'use client', não dá para importar aqui — a conta é que é lei, não o arquivo)
  invoice_expenses: {
    select: 'id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, invoice_id, nature',
    desc: r => r.item, amount: r => num(r.price) * (num(r.quantity) || 1) + num(r.tax) + num(r.extra),
    date: r => r.payment_date || r.expense_date || null,
    href: (r, inv) => inv.get(String(r.invoice_id))?.href || '/invoices',
    ctx: (r, inv) => inv.get(String(r.invoice_id))?.code || '',
  },
  inputs: {
    select: 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, nature',
    desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1),
    date: r => r.payment_date || r.purchase_date || null, href: () => '/supplies',
  },
  inventory: {
    select: 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, nature',
    desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1),
    date: r => r.payment_date || r.purchase_date || null, href: () => '/inventory',
  },
  goods: {
    select: 'id, description, supplier, unit_price, quantity, payment_date, purchase_date, nature',
    desc: r => r.description, amount: r => num(r.unit_price) * (num(r.quantity) || 1),
    date: r => r.payment_date || r.purchase_date || null, href: () => '/goods',
  },
  good_expenses: {
    select: 'id, description, supplier, amount, payment_date, expense_date, nature',
    desc: r => r.description, amount: r => num(r.amount),
    date: r => r.payment_date || r.expense_date || null, href: () => '/goods',
  },
  expenses: {
    select: 'id, description, supplier, amount, payment_date, expense_date, origin, order_number, tracking_number, nature',
    desc: r => r.description, amount: r => num(r.amount),
    date: r => r.payment_date || r.expense_date || null, href: () => '/stream',
  },
}

// PostgREST corta em 1.000 linhas CALADO — paginar não é otimização, é correção.
async function fetchAll(db: any, table: string, select: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).order('id').range(from, from + 999)
    if (table === 'expenses') q = q.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)
    const { data, error } = await q
    if (error) throw Object.assign(new Error(`${table}: ${error.message}`), { pgMessage: error.message })
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

// A migration pode ainda não ter rodado. PostgREST devolve HTTP 400 com
// "column invoice_expenses.nature does not exist" — reconhecer ISSO, e não um
// "nature" solto em qualquer mensagem, senão erro de verdade vira "falta rodar".
const missingNature = (e: unknown) => /nature.{0,40}does not exist|does not exist.{0,40}nature/i.test(String((e as any)?.pgMessage || (e as Error)?.message || ''))

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()

  // O palpite do fornecedor mora em suppliers.default_nature — coluna da mesma
  // migration. Sem ela o card ainda funciona; só não pré-seleciona nada.
  let suppliers: any[] = []
  let hasDefaultNature = true
  try {
    const { data, error } = await db.from('suppliers').select('id, name, aliases, default_nature').order('name')
    if (error) throw new Error(error.message)
    suppliers = data || []
  } catch (e) {
    if (!/default_nature/.test(String(e))) return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 })
    hasDefaultNature = false
    const { data } = await db.from('suppliers').select('id, name, aliases').order('name')
    suppliers = data || []
  }

  // Cadastro oficial indexado pela canonização — nome E apelidos. É por aqui que
  // uma grafia solta encontra o fornecedor de verdade (e o palpite dele).
  const official = suppliers.map((s: any) => ({
    id: s.id, name: s.name as string, default_nature: normNature(s.default_nature),
    keys: [...new Set([s.name, ...String(s.aliases || '').split(/[,\n]/)].map(canonSupplier).filter(Boolean))],
    k: canonSupplier(s.name),
  })).filter(o => o.k)
  const byKey = new Map<string, (typeof official)[number]>()
  for (const o of official) for (const k of o.keys) if (!byKey.has(k)) byKey.set(k, o)
  // Prefixo casa "TEXASSPEEDPERFORMANCE" com o oficial "TEXASSPEED" — mas só com
  // 6+ letras dos dois lados, senão "TEX" engoliria "TEXASSPEED" e o grupo
  // passaria a juntar empresas diferentes, que é o único erro que não se percebe.
  const byLength = [...official].sort((a, b) => b.k.length - a.k.length)
  const resolve = (raw: unknown) => {
    const c = canonSupplier(raw)
    if (!c) return null
    const exact = byKey.get(c)
    if (exact) return exact
    for (const o of byLength) if (o.k.length >= 6 && c.length >= 6 && (c.startsWith(o.k) || o.k.startsWith(c))) return o
    return null
  }

  // Contexto das linhas de invoice — 137 invoices no US (04/set), uma leitura
  // barata que transforma "Sales Tax" em "013.2 · Sales Tax" com link pra
  // invoice certa. Paginada como todo o resto: PostgREST corta em 1.000 calado,
  // e um dia serão mais de mil invoices.
  const invCtx: InvCtx = new Map()
  {
    for (const i of await fetchAll(db, 'invoices', 'id, invoice_code, ride_id, client_id')) {
      const owner = i.ride_id ? `/rides/${i.ride_id}` : i.client_id ? `/clients/${i.client_id}` : ''
      invCtx.set(String(i.id), { code: String(i.invoice_code || ''), href: owner ? `${owner}/invoices/${i.id}` : '/invoices' })
    }
  }

  type Row = { table: ItemTable; id: string; label: string; ctx: string; supplier: string; amount: number; date: string | null; hint: Nature | null; href: string }
  const pending: Row[] = []
  let doneRows = 0, doneMoney = 0

  try {
    for (const table of ITEM_TABLES) {
      const spec = SPECS[table]
      for (const r of await fetchAll(db, table, spec.select)) {
        const amount = spec.amount(r)
        if (normNature(r.nature)) { doneRows++; doneMoney += amount; continue }
        const text = String(spec.desc(r) || '').trim()
        pending.push({
          table, id: String(r.id), label: text.slice(0, 110) || '(sem descrição)',
          ctx: spec.ctx ? spec.ctx(r, invCtx) : '', supplier: String(r.supplier || '').trim(),
          amount, date: spec.date(r), hint: hintFor(text), href: spec.href(r, invCtx),
        })
      }
    }
  } catch (e) {
    // A coluna pode ainda não existir (o Márcio roda a migration no editor). Isso
    // NÃO é defeito: é migration pendente, e o card diz isso com todas as letras.
    if (missingNature(e)) return NextResponse.json({ ok: true, needs_migration: true, totals: null, groups: [] })
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }

  // ── OS GRUPOS ─────────────────────────────────────────────────────────────
  const groups = new Map<string, { key: string; name: string; supplier_id: string | null; default_nature: Nature | null; count: number; amount: number; rows: Row[] }>()
  for (const r of pending) {
    const off = resolve(r.supplier)
    const key = off ? off.k : (canonSupplier(r.supplier) || '__none__')
    const name = off ? off.name : (String(r.supplier || '').split(/[,(]/)[0].trim() || '(sem fornecedor)')
    const g = groups.get(key) || { key, name, supplier_id: off?.id || null, default_nature: off?.default_nature || null, count: 0, amount: 0, rows: [] as Row[] }
    g.count++; g.amount += r.amount; g.rows.push(r)
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count || b.amount - a.amount)
  for (const g of list) g.rows.sort((a, b) => b.amount - a.amount)

  // O placar honesto: quantos grupos bastam para 80% das linhas e 90% do
  // dinheiro. Recalculado agora — é o que torna o trabalho visivelmente finito.
  const totalRows = pending.length, totalMoney = pending.reduce((s, r) => s + r.amount, 0)
  let acc = 0, groups80 = 0
  for (const g of list) { if (acc >= 0.8 * totalRows) break; acc += g.count; groups80++ }
  let accM = 0, groups90 = 0
  for (const g of [...list].sort((a, b) => b.amount - a.amount)) { if (accM >= 0.9 * totalMoney) break; accM += g.amount; groups90++ }

  return NextResponse.json({
    ok: true, needs_migration: false, has_default_nature: hasDefaultNature,
    totals: { rows: totalRows, money: totalMoney, done_rows: doneRows, done_money: doneMoney, groups: list.length, groups_80: groups80, groups_90: groups90 },
    groups: list,
  })
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({} as any))
  const db = bankDb()
  const action = String(b.action || '')

  // ── O PALPITE DO FORNECEDOR ───────────────────────────────────────────────
  // "Lembrar para este fornecedor" grava suppliers.default_nature — e ele só
  // pré-seleciona o botão do grupo na próxima carga. NUNCA classifica linha
  // nenhuma sozinho: Kramer venderia 5 carros e um imposto como carro.
  if (action === 'remember') {
    const supplierId = String(b.supplier_id || '')
    const nature = b.nature === null ? null : normNature(b.nature)
    if (!supplierId || (b.nature !== null && !nature)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
    const { data: sup } = await db.from('suppliers').select('id, name, default_nature').eq('id', supplierId).maybeSingle()
    if (!sup) return NextResponse.json({ error: 'fornecedor não encontrado' }, { status: 404 })
    const { error } = await db.from('suppliers').update({ default_nature: nature }).eq('id', supplierId)
    if (error) return NextResponse.json({ error: error.message, needs_migration: /default_nature/.test(error.message) }, { status: 500 })
    await db.from('data_fixes').insert({
      check_key: 'item-nature', table_name: 'suppliers', row_id: supplierId, field: 'default_nature',
      old_value: sup.default_nature ?? null, new_value: nature,
      label: `PALPITE · ${sup.name} → ${nature || '(nenhum)'}`.slice(0, 200),
    }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true })
  }

  if (action !== 'apply') return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const nature = normNature(b.nature)
  if (!nature) return NextResponse.json({ error: `natureza inválida — use ${NATURES.join('/')}` }, { status: 400 })
  const rows: { table: string; id: string }[] = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length) return NextResponse.json({ error: 'nenhuma linha' }, { status: 400 })
  if (rows.length > 1500) return NextResponse.json({ error: 'lote grande demais — o card manda um grupo por vez' }, { status: 400 })

  const byTable = new Map<ItemTable, string[]>()
  for (const r of rows) {
    const t = String(r.table || '') as ItemTable
    if (!(ITEM_TABLES as readonly string[]).includes(t)) return NextResponse.json({ error: `tabela fora das tabelas de item: ${t}` }, { status: 400 })
    if (!r.id) continue
    byTable.set(t, [...(byTable.get(t) || []), String(r.id)])
  }

  let applied = 0
  const label = String(b.label || '').slice(0, 60)
  try {
    for (const [table, ids] of byTable) {
      const spec = SPECS[table]
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100)
        // `.is('nature', null)` + `.select()`: escreve SÓ o vazio e devolve o que
        // realmente mudou. Quem já tinha resposta não é sobrescrito — e não entra
        // na trilha como se tivesse sido (o placar do card ficaria mentindo).
        let upd = db.from(table).update({ nature }).in('id', chunk).is('nature', null)
        // O GATE DE `expenses` TAMBÉM NA ESCRITA. A leitura já o aplica, mas o
        // id chega pelo corpo do POST: sem repetir o gate aqui, bastaria um id
        // de FOLHA no payload para carimbar natureza numa linha de salário. A
        // lei de 03/set/2026 diz que folha nunca sai do banco — nem por engano.
        if (table === 'expenses') upd = upd.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)
        const { data, error } = await upd.select(spec.select)
        if (error) return NextResponse.json({ error: `${table}: ${error.message}`, needs_migration: missingNature({ pgMessage: error.message }), applied }, { status: 500 })
        const written = data || []
        applied += written.length
        if (written.length) {
          await db.from('data_fixes').insert(written.map((r: any) => ({
            check_key: 'item-nature', table_name: table, row_id: String(r.id), field: 'nature',
            old_value: null, new_value: nature,
            label: `${label ? label + ' · ' : ''}${String(r.supplier || '(sem fornecedor)').slice(0, 40)} · ${String(spec.desc(r) || '').slice(0, 90)}`.slice(0, 200),
          }))).then(() => undefined, () => undefined)
        }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300), applied }, { status: 500 })
  }
  return NextResponse.json({ ok: true, applied, skipped: rows.length - applied })
}
