'use client'

// DATA CHECK — bancada de conserto dos dados do APP INTEIRO (ADM → DATA
// CHECK): não é ferramenta só do financeiro — é a organização que mantém
// rides, fornecedores, pagamentos e datas sempre corretos.
//   · Conserto de UM CAMPO acontece AQUI DENTRO (data, destino, tipo, baixa):
//     clica FIX na linha, preenche, salva — a linha some da lista na hora.
//   · Conserto que precisa de contexto (job legado sem linhas, saldo de caixa)
//     abre a tela cheia NUMA ABA NOVA — o DATA CHECK não sai do lugar.
//   · Todo conserto feito aqui vira linha na trilha data_fixes; a seção
//     HISTÓRICO agrupa por dia ("sessão") pro double-check de depois.
//   · DESTINY REVIEW: cruza cada destino com o dinheiro do carro e acusa
//     contradição (carro nosso faturando cliente, carro "do cliente" que a
//     LLC comprou, EXPORT com dono americano…) — pega inclusive mudanças
//     feitas FORA desta tela, que histórico nenhum pegaria.
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import Header from '@/components/Header'
import DcBadge from '@/components/DcBadge'
import DatePicker from '@/components/DatePicker'
import PartPicker from '@/components/PartPicker'
import BankReconcileCard, { sessionHeaders } from '@/components/BankReconcileCard'
import { PAID_FROM_OPTIONS } from '@/components/PaymentFields'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, CAR_DESTINY, formatShortDate } from '@/lib/utils'
import { loadFinancials, invoiceTotals, invoiceMeta, ledgerTotals, expLine, qtyLine, FinData } from '@/lib/financials'
import { DC_CHANGELOG } from '@/lib/dcVersion'
import { NATURES, NATURE_LABEL, NATURE_HINT, type Nature } from '@/lib/itemNature'
import { classifyInput } from '@/lib/inputsCategory'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
// Relógio do app = Orlando (regra de 20/08): depois das 20h o UTC já é amanhã.
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const CAR_RX = /car purchase|compra |challenger|charger|demon|hellcat|redeye|widebody|superstock|camaro|z\/28/i

type Fix =
  | { kind: 'date'; table: string; rowId: string; field: string }
  | { kind: 'select'; table: string; rowId: string; field: string; options: { value: string; label: string }[]; current?: string | null; spelling?: string; sup?: string; ebay?: string | null; meta?: Record<string, unknown> }
  | { kind: 'number'; table: string; rowId: string; field: string; suffix?: string }
  | { kind: 'flag'; table: string; rowId: string; field: string; value: boolean; confirmText: string }
  | { kind: 'trash'; table: string; rowId: string; field: string; confirmText: string }
  // AUTO-BOOK (BL 0.8.0): PURGAR órfão do motor (pela rota, com re-checagem) e
  // TROCAR dupla (desfaz o lançamento do motor e casa a linha com o registro humano).
  | { kind: 'purge'; table: string; rowId: string; field: string; confirmText: string }
  | { kind: 'rematch'; table: string; rowId: string; field: string; bankId: string; confirmText: string }
  // BALDE (fase B): DESFAZER um ponteiro morto — a linha do banco volta a NEW e o motor recria.
  | { kind: 'unmatch'; table: string; rowId: string; field: string; bankId: string; confirmText: string }
  // SILÊNCIO (BL 0.10.0): ADOTAR — a agendada aberta que o banco já pagou recebe a linha (data, elo, valor).
  | { kind: 'adopt'; table: string; rowId: string; field: string; bankId: string; confirmText: string }
  // CASAR COM AJUSTE (BL 1.1.0): SOLTAR — a passagem diz que casou, a linha do banco não a aponta; limpa o elo, nunca apaga.
  | { kind: 'unlink'; table: string; rowId: string; field: string; confirmText: string }
  // CATEGORIA SOZINHA (DC 1.42.0): DESFAZER o que o app preencheu (palavra-chave + IA concordaram).
  | { kind: 'undo_category'; table: string; rowId: string; field: string; confirmText: string }
  | { kind: 'enable_autofill'; table: string; rowId: string; field: string; confirmText: string }
  // DC 1.44.0: DESFAZER genérico do que o app preencheu sozinho; VISTO (dispensa com memória); CASAR por prova (paga no app, sem banco).
  | { kind: 'undo_auto'; table: string; rowId: string; field: string; fixId: string; confirmText: string }
  | { kind: 'dismiss'; table: string; rowId: string; field: string; checkKey: string; confirmText: string }
  | { kind: 'match'; table: string; rowId: string; field: string; bankId: string; confirmText: string }
  | { kind: 'received'; table: string; rowId: string }
  | { kind: 'trim'; table: 'invoice_duties'; rowId: string; field: 'time_seconds'; dutyId: string; segStart: string; segEnd: string; bankedStart: number | null; bankedEnd: number | null }
// certain: a sugestão é prova, não palpite (ex.: a Regions já casou a linha) — entra no bulk PREENCHER CERTOS.
type Item = { href: string; code: string; label: string; extra?: string; amount?: number; fix?: Fix; suggest?: string; certain?: boolean; signal?: string; when?: string; link?: { href: string; label: string } }

// A prova de cada PREENCHER CERTOS, na língua do card (achado do João, 25/ago:
// a legenda da Regions aparecia até nos cards de peças).
const CERTAIN_PROOF: Record<string, string> = {
  'paid-from': 'linhas já casadas com a Regions → GZ28US (prova, não palpite)',
  'parts-identity': 'o PN da peça está no próprio texto — o número não mente',
  'parts-suppliers': 'nome, apelido ou identidade dura batendo com o fornecedor oficial',
  'inputs-category': 'identidade da loja (mercado/lanchonete → TEAM, pet → CATS, ferragem → oficina) ou loja e texto concordando',
  'parts-category': 'palavra-chave e IA concordam na categoria — dois leitores independentes, não um palpite',
  'admission-mileage': 'a milhagem já está na invoice do carro (mesmo valor em outro lugar do banco de dados)',
  'bank-drift': 'o nome do prestador está na linha do banco e o valor é único na janela — a mesma prova que o motor usa pra adotar',
  'paid-no-bank': 'valor exato + nome do prestador + linha única da Regions em ±10 dias',
  'sub-ended-scheduled': 'assinatura encerrada formalmente e nenhuma cobrança da Regions depois do fim',
}
const fixField = (f: Fix) => (f.kind === 'received' ? 'paid_at' : f.field)
// Categorias do Data Checker (João, 22/ago: inglês, casando com o menu do app).
// STAFF, TAX e SYSTEM já existem na ordem — os cards deles chegam com as features
// (duty timer, 1099, FL sales tax); seção sem card não aparece.
const GROUP_ORDER = ['BANK', 'FINANCIAL', 'RIDES', 'INVOICES', 'INVENTORY', 'STAFF', 'TAX', 'SYSTEM'] as const
type Group = typeof GROUP_ORDER[number]
type Check = { group: Group; key: string; title: string; why: string; blocks: string; items: Item[]; impact?: number; good?: boolean }   // good: notícia boa (o que o app fez sozinho) — não conta como pendência, não fica amarelo

const DESTINY_OPTIONS = CAR_DESTINY.map(o => ({ value: o.value, label: o.option }))
const TYPE_OPTIONS = ['FIXED', 'APP', 'MARKETING', 'ASSET'].map(v => ({ value: v, label: v }))

const PAID_FROM_SELECT = PAID_FROM_OPTIONS.map(v => ({ value: v, label: v }))

// Sinal do banco (/api/bank/reconcile?matched=1): pares já casados, saídas da Regions
// (data+valor) e a data de abertura da conta. Tudo melhor esforço — sem isso o card
// só perde as sugestões.
type CashItem = { id: string; account: string; live: { current: number; available: number; as_of: string } | null; live_error: string | null; integrity: { anchor_date: string; anchor_balance: number; lines_after: number; implied: number; pending_out: number; pending_in: number; gap: number | null } | null }
type DutyIncident = { key: string; kind: 'LONG' | 'OVERLAP' | 'OVERNIGHT'; duty_id: string; staff_name: string; label: string; car: string; hours: number; nudged: string | null; escalated: boolean }
type AbsurdSeg = { key: string; duty_id: string; staff_name: string; label: string; car: string; start: string; end: string; wall_h: number; banked_start: number | null; banked_end: number | null }
type SilentComp = { key: string; staff_name: string; after: string; days: string[]; label: string }
type DutySignal = { state: 'loading' | 'error' | 'ok'; maxHours: number; incidents: DutyIncident[]; history: { absurd: AbsurdSeg[]; comps: SilentComp[] } }
type LinkerRow = { table: string; id: string; text: string; supplier: string; extra: string; candidates: { id: string; label: string; certain: boolean }[] }
type CatRow = { id: string; item: string; current: string | null; suggest: string | null; keyword?: string | null; ai?: string | null; tier?: 'CERTAIN' | 'ASK' | 'NOT_PART' | 'PENDING' }
type SupRow = { id: string; text: string; part: string; candidates: { id: string; label: string; certain: boolean }[]; ebay?: string | null; ebay_bare?: boolean; ebay_item?: string | null }
type LinkerSignal = { state: 'loading' | 'error' | 'ok'; needsMigration: boolean; needsSupplierMigration: boolean; totals: { parts: number; locked: number; inv_unlinked: number; inv_total: number; ps_unlinked: number; ps_total: number; no_pn: number; dup_pn: number; sup_unlinked?: number; map_bad?: number } | null; inventory: LinkerRow[]; streams: LinkerRow[]; no_pn: { id: string; item: string }[]; dup_pn: { pn: string; items: string[] }[]; suppliers_unlinked: SupRow[]; suppliers_all: { id: string; name: string }[]; map_bad: { id: string; item: string; cost: number; map: number }[]; no_source: string[]; kit_mismatch: { item: string; st: string | null; kit: boolean }[]; ebay_pn: { id: string; item: string; listing: string; suggest: string | null; supplier: string }[]; categories: CatRow[]; category_vocab: string[]; category_ai_pending?: number; needs_category_ai_migration?: boolean; auto_fill_enabled?: boolean; certain_ready?: number; auto_categories?: { fix_id: string; id: string; item: string; category: string; old: string | null; at: string }[] }
type TaxPayee = { key: string; name: string; total: number; classification: string | null; w9_on_file: boolean }
type TaxSignal = { state: 'loading' | 'error' | 'ok'; needsMigration: boolean; years: { year: string; payees: TaxPayee[] }[] }
type AutoBookSignal = { floor: string; needs_migration?: boolean; runs: { id: string; trigger: string; status: string; started_at: string; finished_at: string | null; counts: Record<string, number> | null; errors: string[] | null; remaining: number | null }[]; booked_24h: Record<string, number>; booked_7d: Record<string, number>; remaining: number; errors: string[]; orphans: { table: string; id: string; label: string; amount: number; bank_id: string; code?: string }[]; dups: { auto_table: string; auto_id: string; auto_label: string; bank_id: string; twin_table: string; twin_id: string; twin_label: string; amount: number; days: number }[]; bucket?: { total: number; balance: number; older_7d: number }; dead_pointers?: { bank_id: string; table: string; id: string; label: string; amount: number }[]; amount_drift?: { bank_id: string; row_id: string; bank_amount: number; row_amount: number; label: string }[]; seed?: { skipped: string[] }; drift?: { row_id: string; supplier_id: string | null; supplier: string; amount: number; due: string; bank_id: string; bank_date: string; bank_status: string; days: number; overdue_days: number; ambiguous: boolean; late_fee: boolean; name_ok?: boolean; unique?: boolean }[]; anomalies?: { supplier_id: string; supplier: string; month: string; current: number; avg3: number; ratio: number }[]; bounce?: { bank_id: string; n: number }[]; questions?: { suppliers: number; supplier_total: number; money: number; twins: number; caps: number; maturity: number; other: number; lines: number } | null; silence_error?: string | null; runs_7d?: { n: number; errors: number } }
// As saídas da Regions com id, nome e status (DC 1.44.0): «paga no app, sem banco» casa por prova e o imposto FL acha o recolhimento pelo nome.
type BankLine = { d: string; a: number; id: string; n: string; s: string }
type BankSignal = { matched: Set<string>; groups: Map<string, number>; outflows: Map<string, string[]>; lines: BankLine[]; opened: string; cash: CashItem[] | null; cashState: 'loading' | 'error' | 'ok'; autobook?: AutoBookSignal | null }
// O APP PREENCHEU SOZINHO + DISPENSAS (DC 1.44.0): trilha «AUTO ·» dos últimos 7 dias (com DESFAZER genérico) e «visto, está certo».
type AutoRow = { id: string; check_key: string; table_name: string; row_id: string; field: string; old_value: string | null; new_value: string | null; label: string; fixed_at: string }
type AutoSignal = { state: 'loading' | 'error' | 'ok'; rows: AutoRow[]; dismissed: Record<string, string>; total?: number }
// Sugestões da fila A ATRIBUIR (?bucket=1) e as invoices com o estado FECHADA — o card do balde fala por fornecedor.
type BucketSig = { state: 'loading' | 'error' | 'ok'; sug: Map<string, { invoice_id: string; code: string; car: string; why: string; score: number }>; invoices: { id: string; code: string; ride_code: string; ride_name: string; closed: boolean }[] }
const REGIONS_OPENED = '2025-11-10'
let AUTO_CAT_RAN = false   // categoria sozinha: uma leitura da IA por abertura da página
let AUTO_NATURE_RAN = false   // natureza sozinha (carro → dinheiro, PN → peça, hábito): uma rodada por abertura
let AUTO_RAN = false          // níveis CERTOS dos cards: uma rodada por abertura
// Cards cujos itens CERTOS o app resolve sozinho (com trilha «AUTO ·» e DESFAZER no card SOZINHO).
const AUTO_KEYS = new Set(['paid-from', 'parts-suppliers', 'admission-mileage', 'bank-drift', 'paid-no-bank', 'sub-ended-scheduled', 'inputs-category'])
// Cards que aceitam «visto, está certo» (dispensa com memória — nunca mais pergunta a mesma linha).
const DISMISSABLE = new Set(['out-of-pattern', 'parts-suppliers', 'destiny-review', 'fixed-dup-month', 'inputs-category'])
const nameTok = (s: unknown) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !['STORE', 'INC', 'LLC', 'CORP', 'THE', 'AND', 'COMPANY'].includes(w))
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
// WA SEND LOG (caso Gui, 31/ago): falhas de envio do /api/whatsapp gravadas em wa_send_log.
type WaSignal = { state: 'loading' | 'ok' | 'missing' | 'error'; fails: { id: string; at: string; destination: string | null; group_name: string | null; kind: string | null; body_head: string | null; error: string | null; http_status: number | null }[] }
// O QUE É ESTA LINHA? (04/set/2026) — o sinal de /api/item-nature: as linhas sem
// natureza, AGRUPADAS POR FORNECEDOR canonizado. O card tem corpo próprio (o
// grupo é a unidade de trabalho, não a linha) — ver <NatureWorkbench> lá embaixo.
type NatureRow = { table: string; id: string; label: string; ctx: string; supplier: string; amount: number; date: string | null; hint: Nature | null; href: string }
type NatureGroup = { key: string; name: string; supplier_id: string | null; default_nature: Nature | null; count: number; amount: number; rows: NatureRow[] }
type NatureTotals = { rows: number; money: number; done_rows: number; done_money: number; groups: number; groups_80: number; groups_90: number }
type NatureSignal = { state: 'loading' | 'error' | 'ok'; needsMigration: boolean; totals: NatureTotals | null; groups: NatureGroup[] }

// As cores das 5 naturezas. lib/itemNature.ts guarda o TOM (sky/amber/violet/
// zinc/rose); a classe inteira é escrita aqui à mão de propósito: o Tailwind
// varre o código por strings LITERAIS, então `bg-${tone}-900` nunca chega ao CSS
// e o botão sairia sem cor nenhuma — bug silencioso, dos piores.
const NATURE_BTN: Record<Nature, string> = {
  PART: 'bg-sky-900/60 border-sky-700 text-sky-100 hover:bg-sky-800',
  SERVICE: 'bg-amber-900/60 border-amber-700 text-amber-100 hover:bg-amber-800',
  DIGITAL: 'bg-violet-900/60 border-violet-700 text-violet-100 hover:bg-violet-800',
  CHARGE: 'bg-zinc-800 border-zinc-600 text-zinc-100 hover:bg-zinc-700',
  MONEY: 'bg-rose-900/60 border-rose-700 text-rose-100 hover:bg-rose-800',
}
const NATURE_TAG: Record<Nature, string> = {
  PART: 'text-sky-300', SERVICE: 'text-amber-300', DIGITAL: 'text-violet-300', CHARGE: 'text-zinc-300', MONEY: 'text-rose-300',
}

// DISPENSA COM MEMÓRIA (DC 1.44.0): «visto, está certo» some do card até alguém desdispensar; item sem
// conserto ganha o botão VISTO. E a sobreposição: a agendada que a deriva ADOTA não aparece em «vencida».
function applyDismiss(checks: Check[], auto: AutoSignal, bank: BankSignal): Check[] {
  const driftIds = new Set(((bank.autobook && bank.autobook.drift) || []).filter(x => !x.ambiguous).map(x => String(x.row_id)))
  return checks.map(c => {
    let items = c.items
    if (c.key === 'undated-fixed' && driftIds.size) items = items.filter(i => !(i.fix && driftIds.has(String(i.fix.rowId))))
    if (!DISMISSABLE.has(c.key)) return { ...c, items }
    items = items.flatMap(i => {
      const rowId = i.fix ? String(i.fix.rowId) : (i.code + '|' + i.label).slice(0, 150)
      const k = c.key + '|' + rowId
      // Dispensa esconde; DESFEITO (a pessoa desfez um AUTO) não esconde — só impede a máquina de refazer.
      if (auto.dismissed[k] !== undefined && auto.dismissed[k] !== 'DESFEITO') return []
      if (i.fix) return [i]
      return [{ ...i, fix: { kind: 'dismiss' as const, table: 'data_check', rowId, field: 'DISMISSED', checkKey: c.key, confirmText: `Marcar «visto, está certo» em «${i.label.slice(0, 90)}»? O card para de perguntar isto (fica na trilha; dá pra voltar).` } }]
    })
    return { ...c, items }
  })
}
function buildChecks(d: FinData, bank: BankSignal, tax: TaxSignal, duty: DutySignal, linker: LinkerSignal, wa: WaSignal, nature: NatureSignal, auto: AutoSignal, bucketSig: BucketSig): Check[] {
  const matched = bank.matched
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const checks: Check[] = []

  // Quem é o dono da pendência: carro (project name) · cliente. Invoice de
  // shop sem project name cai no nome do cliente — "006.8 Pending balance"
  // sem contexto nenhum foi o exemplo do Márcio (20/ago).
  const whoFor = (invoiceId: string) => {
    const inv = d.invoiceById.get(invoiceId)
    const ride = inv?.ride_id ? d.rides.get(inv.ride_id) : null
    const car = ride ? (ride.project_name || [ride.model, ride.version].filter(Boolean).join(' ')) : ''
    const cid = inv?.client_id || ride?.client_id
    const client = cid ? (d.clients.get(cid)?.name || '') : ''
    return [car, client].filter(Boolean).join(' · ') || '(sem carro/cliente)'
  }

  // 1 · Invoices sem data de conclusão (G1) — CLOSED primeiro, que é o pior caso.
  {
    // Insight do Márcio (20/ago): CLOSED exige incomes datados e recebidos —
    // o último recebimento JÁ é data derivável de conclusão. Pendência de
    // verdade é só a raridade fechada SEM NENHUMA data (nem conclusão, nem
    // entrega, nem income datado). O resto o DRE deriva sozinho.
    const derivable = (i: any) => {
      if (i.conclusion_date || i.delivery_date) return true
      return d.payments.some((p: any) => p.invoice_id === i.id && (p.paid_at || p.payment_date))
    }
    const items = d.invoices
      .filter((i: any) => i.live_status === 'CLOSED' && !derivable(i))
      .map((i: any) => {
        const m = invoiceMeta(d, i.id)
        // Sugestão: última atividade do invoice (pagamento recebido ou despesa
        // paga/lançada) — num invoice fechado, isso costuma cravar a conclusão.
        let last = ''
        for (const p of d.payments) if (p.invoice_id === i.id) {
          const dt = p.paid_at ? String(p.paid_at).slice(0, 10) : (p.payment_date || '')
          if (dt && dt > last) last = dt
        }
        for (const e of d.invExpenses) if (e.invoice_id === i.id) {
          const dt = e.payment_date || e.expense_date || ''
          if (dt && dt > last) last = dt
        }
        return {
          href: m.href, code: m.code, label: whoFor(i.id),
          extra: last ? 'última atividade: ' + formatShortDate(last) : 'fechada sem data de conclusão',
          suggest: last || undefined,
          fix: { kind: 'date' as const, table: 'invoices', rowId: i.id, field: 'conclusion_date' },
        }
      })
    checks.push({
      group: 'INVOICES', key: 'conclusion', title: 'Invoice fechada sem nenhuma data', blocks: 'o resultado entra no mês errado no DRE',
      why: 'Fechada com incomes datados já tem mês de resultado (deriva do último recebimento). Só aparece aqui a raridade sem conclusão, sem entrega E sem income datado — aí não tem de onde derivar.',
      items,
    })
  }

  // 2 · Rides sem CAR DESTINY. Quotes e vitrine SHOP ficam fora de propósito.
  {
    const items: Item[] = []
    d.rides.forEach((r: any) => {
      // TODA ride real precisa de destino — mesmo sem invoice ainda (pedido
      // do Márcio, 20/ago). Só quote e vitrine SHOP ficam de fora.
      if (r.is_quote || r.origin === 'SHOP') return
      if (r.title_scope && r.title_scope !== 'DEALER') return
      items.push({
        href: '/rides/edit/' + r.id, code: r.project_code || '—',
        label: r.project_name || [r.model, r.version].filter(Boolean).join(' '),
        extra: r.title_scope === 'DEALER' ? 'valor legado DEALER — re-taguear' : 'destino indefinido',
        fix: { kind: 'select', table: 'rides', rowId: r.id, field: 'title_scope', options: DESTINY_OPTIONS, current: r.title_scope },
      })
    })
    checks.push({
      group: 'RIDES', key: 'destiny', title: 'Este carro fica, vende ou exporta? (sem destino)', blocks: 'o Balanço não sabe se o carro é estoque, frota ou do cliente',
      why: 'Sem destino o Balanço não sabe se o carro é nosso (OWN/TOOL → ativo), de cliente em exportação (EXPORT) ou de cliente americano. Vitrine SHOP fica sem destino de propósito.',
      items,
    })
  }

  // 3 · DESTINY REVIEW — o double-check: destino × dinheiro do carro.
  //     Pega contradição mesmo em mudança feita FORA desta tela.
  {
    const items: Item[] = []
    const byRide = new Map<string, any[]>()
    for (const i of d.invoices) { if (!i.ride_id) continue; const a = byRide.get(i.ride_id) || []; a.push(i); byRide.set(i.ride_id, a) }
    d.rides.forEach((r: any) => {
      const scope = r.title_scope
      if (!scope || scope === 'DEALER' || r.is_quote || r.origin === 'SHOP') return
      const invs = byRide.get(r.id) || []
      let billed = 0, received = 0, carBuy = 0
      for (const inv of invs) {
        const t = invoiceTotals(d, inv)
        billed += t.grand; received += t.received
        carBuy += d.invExpenses.filter((e: any) => e.invoice_id === inv.id && expLine(e) >= 15000 && CAR_RX.test(e.item || ''))
          .reduce((s: number, e: any) => s + expLine(e), 0)
      }
      const client = r.client_id ? d.clients.get(r.client_id) : null
      const flags: string[] = []
      if ((scope === 'OWN' || scope === 'TOOL') && (billed > 0.005 || received > 0.005))
        flags.push(`carro NOSSO com faturamento de cliente (${usd(billed)} faturado, ${usd(received)} recebido)`)
      if (scope === 'USA' && carBuy > 0)
        flags.push(`a LLC comprou o carro (${usd(carBuy)}) num carro de cliente americano — devia ser GZ28 EXPORT ou OWN?`)
      if (scope === 'EXPORT' && client?.country === 'USA')
        flags.push('GZ28 EXPORT com cliente dos EUA — vai exportar mesmo?')
      // Lei do 0km (Márcio, 20/ago): SÓ carro com DELIVERY MILES — entrada
      // abaixo de 100 mi (admission_mileage) — pode ser exportado ao Brasil,
      // por nós (GZ28 EXPORT) ou por terceiro (3RD PARTY EXPORT). Cliente
      // brasileiro com carro usado nos EUA é normal (residência).
      if (scope === 'EXPORT' || scope === 'CLIENT') {
        const kindLabel = scope === 'EXPORT' ? 'GZ28 EXPORT' : '3RD PARTY EXPORT'
        const mi = r.admission_mileage == null ? null : parseFloat(r.admission_mileage)
        // milhagem AUSENTE tem card próprio com fix inline; aqui só a contradição
        if (mi != null && !isNaN(mi) && mi >= 100)
          flags.push(`${Math.round(mi).toLocaleString('en-US')} mi na entrada — acima do teto de DELIVERY MILES (100 mi), não pode ser ${kindLabel}`)
      }
      if (r.exported && scope !== 'EXPORT' && scope !== 'CLIENT')
        flags.push('marcado EXPORTED mas o destino não é de exportação — conferir')
      if (!flags.length) return
      items.push({
        href: '/rides/edit/' + r.id, code: r.project_code || '—',
        label: `${r.project_name || ''} [${scope}] — ${flags.join(' · ')}`,
        fix: { kind: 'select', table: 'rides', rowId: r.id, field: 'title_scope', options: DESTINY_OPTIONS, current: scope },
      })
    })
    checks.push({
      group: 'RIDES', key: 'destiny-review', title: 'Destino do carro: os dados discordam entre si', blocks: 'a classificação do carro no Balanço e no DRE fica em dúvida',
      why: 'Cruza cada destino com o dinheiro e com a lei: carro OWN/TOOL não fatura cliente; carro USA a LLC nunca comprou; exportação (GZ28 ou 3RD PARTY) exige ADMISSION MILEAGE abaixo de 100 mi — DELIVERY MILES; DONOR pode ter crédito de peça puxada, isso é normal. Cliente brasileiro com carro nos EUA é normal — muitos têm residência. Zero aqui = a classificação passou.',
      items,
    })
  }

  // 4 · Export sem ADMISSION MILEAGE — a milhagem lança AQUI, inline.
  {
    const items: Item[] = []
    d.rides.forEach((r: any) => {
      if (r.is_quote || r.origin === 'SHOP') return
      if (r.title_scope !== 'EXPORT' && r.title_scope !== 'CLIENT') return
      if (r.admission_mileage != null) return
      // PROVA (DC 1.44.0): a invoice do carro já traz a milhagem de entrada — mesmo valor em outro lugar do banco de dados.
      const mis = d.invoices.filter((i: any) => i.ride_id === r.id && Number(i.mileage) > 0).map((i: any) => Number(i.mileage))
      const mi = mis.length ? Math.min(...mis) : null
      items.push({
        href: '/rides/edit/' + r.id, code: r.project_code || '—',
        label: r.project_name || [r.model, r.version].filter(Boolean).join(' '),
        extra: (r.title_scope === 'EXPORT' ? 'GZ28 EXPORT' : '3RD PARTY EXPORT') + (mi != null ? ` · a invoice diz ${mi} mi` : ''),
        suggest: mi != null ? String(mi) : undefined, certain: mi != null, signal: mi != null ? 'matched' : undefined,
        fix: { kind: 'number', table: 'rides', rowId: r.id, field: 'admission_mileage', suffix: 'mi' },
      })
    })
    checks.push({
      group: 'RIDES', key: 'admission-mileage', title: 'Carro de exportação sem milhagem de entrada', blocks: 'não dá pra provar que era 0km — exigência legal da exportação',
      why: 'Todo carro de exportação — GZ28 ou por terceiro — precisa da milhagem de entrada: abaixo de 100 mi é DELIVERY MILES e pode embarcar. Lance o número aqui mesmo.',
      items,
    })
  }

  // 5 · Ciclo de entrega: delivery_date (fato: no passado + invoice FECHADA)
  //     e o selo EXPORTED validam um ao outro. delivery_date em invoice
  //     ABERTA é PROMESSA (banner PROMISED TO) — não conta como saída.
  {
    const items: Item[] = []
    const byRide = new Map<string, any[]>()
    for (const i of d.invoices) { if (!i.ride_id) continue; const a = byRide.get(i.ride_id) || []; a.push(i); byRide.set(i.ride_id, a) }
    d.rides.forEach((r: any) => {
      if (r.is_quote || r.origin === 'SHOP') return
      if (r.title_scope !== 'EXPORT' && r.title_scope !== 'CLIENT') return
      const invs = byRide.get(r.id) || []
      const deliveredFact = invs.filter((i: any) => i.delivery_date && i.delivery_date <= TODAY && i.live_status === 'CLOSED')
      const anyDelivery = invs.some((i: any) => i.delivery_date)
      if (!r.exported && deliveredFact.length > 0) {
        const last = deliveredFact.map((i: any) => i.delivery_date).sort().pop()
        items.push({
          href: '/rides/edit/' + r.id, code: r.project_code || '—',
          label: (r.project_name || '') + ' — entregue em ' + formatShortDate(last) + ' e sem selo EXPORTED',
          fix: { kind: 'flag', table: 'rides', rowId: r.id, field: 'exported', value: true, confirmText: 'O carro embarcou de fato? Marca EXPORTED: fim do ciclo na GZ28US — num GZ28 EXPORT, sai do nome da LLC e o custo sai do WIP.' },
        })
      }
      if (r.exported && !anyDelivery) {
        items.push({
          href: '/rides/' + r.id + '/invoices', code: r.project_code || '—',
          label: (r.project_name || '') + ' — EXPORTED sem delivery date em nenhuma invoice: quando saiu?',
          extra: 'lançar na invoice final',
        })
      }
    })
    checks.push({
      group: 'RIDES', key: 'delivery-cycle', title: 'Entrega não bate com a exportação', blocks: 'o ciclo do carro fica impossível (entregue antes de chegar)',
      why: 'Delivery date no passado em invoice FECHADA diz que o carro saiu — aí o selo EXPORTED tem que existir (um clique aqui confirma). E EXPORTED sem delivery date em invoice nenhuma não diz QUANDO saiu. Delivery em invoice aberta é promessa, não conta.',
      items,
    })
  }

  // 6 · Despesa VENCIDA sem pagamento (G6 v2 — achado do João, 25/ago, caso
  // US.047.1). No modelo do Márcio, payment_date vazio É o estado "Not paid yet"
  // (fica em Fornecedores a pagar — estado normal, não pendência): 299 das 334
  // linhas do card antigo eram falso positivo. Pendência de verdade é a data
  // prevista (expense_date — espelho legado / agenda de parcelas) já VENCIDA e
  // o pagamento sem lançar: ou atrasou, ou pagou e a data ficou de fora.
  {
    const rows = d.invExpenses.filter((e: any) => !e.payment_date && e.expense_date && String(e.expense_date).slice(0, 10) <= TODAY)
    const items = rows.map((e: any) => {
      const m = invoiceMeta(d, e.invoice_id)
      return {
        href: m.href, code: m.code, label: e.item || '(despesa sem descrição)',
        extra: [whoFor(e.invoice_id), e.supplier, 'previsto ' + String(e.expense_date).slice(0, 10)].filter(Boolean).join(' · '), amount: expLine(e),
        fix: { kind: 'date' as const, table: 'invoice_expenses', rowId: e.id, field: 'payment_date' },
      }
    }).sort((a: Item, b: Item) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      group: 'FINANCIAL', key: 'undated-inv', title: 'Despesa venceu e o pagamento não foi lançado', blocks: 'ou o pagamento atrasou, ou foi pago e o DFC não sabe quando',
      why: 'Não pago = sem data é o estado NORMAL de uma despesa (aparece como Not paid yet na invoice e em Fornecedores a pagar) — não é pendência e não entra aqui. O que entra: a linha tinha data prevista (parcela agendada ou o espelho legado) que já passou, e o pagamento continua sem lançar. Se pagou, registre a data; se atrasou, é cobrança, não conserto.',
      items, impact: rows.reduce((s: number, e: any) => s + expLine(e), 0),
    })
  }

  // 5 · Custos fixos e folha sem payment_date.
  {
    // v2 (João, 25/ago): conta futura agendada NÃO é pendência — o Márcio registra
    // meses adiante (7 Warehouse Lease "iguais" eram ago VENCIDA + set–fev futuras,
    // sem data na linha ninguém distinguia). Entram só: VENCIDA (prevista ≤ hoje,
    // com dias de atraso) e SEM DATA NENHUMA (nem o mês dá pra saber — defeito).
    const due = (e: any) => String(e.expense_date || '').slice(0, 10)
    const late = (e: any) => Math.floor((Date.parse(TODAY) - Date.parse(due(e))) / 864e5)
    const tag = (e: any) => due(e) ? `prevista ${due(e)} · ATRASADA há ${late(e)} dia(s)` : 'SEM DATA NENHUMA — nem o mês dá pra saber'
    const supEnd = (e: any) => { const sup = d.fixedSuppliers.get(e.supplier_id); return sup?.date_conclusion ? String(sup.date_conclusion).slice(0, 10) : null }
    // AUTO-BOOK (BL 0.8.0): conta em aberto cujo mês JÁ tem a linha ligada ao
    // banco não recebe o fix de data (endureceria a dupla) — vai pro card 5b.
    const linkedMonth = new Set(d.fixedExpenses.filter((e: any) => e.bank_transaction_id).map((e: any) => e.supplier_id + '|' + String(e.expense_date || e.payment_date || '').slice(0, 7)))
    const fx = d.fixedExpenses.filter((e: any) => !e.payment_date && (!due(e) || due(e) <= TODAY) && !(supEnd(e) && due(e) && due(e) > supEnd(e)!) && !(due(e) && linkedMonth.has(e.supplier_id + '|' + due(e).slice(0, 7))))
    const st = d.expenses.filter((e: any) => !e.payment_date && e.origin !== 'PERSONAL' && (!due(e) || due(e) <= TODAY))
    const items: Item[] = [
      ...fx.map((e: any) => {
        const sup = d.fixedSuppliers.get(e.supplier_id)
        return {
          href: e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', code: 'FIXO',
          label: [sup?.company, e.description].filter(Boolean).join(' · '), extra: tag(e) + (supEnd(e) ? ` · assinatura ENCERRADA em ${supEnd(e)} — pague ou apague (write-off)` : ''), amount: parseFloat(e.amount) || 0,
          fix: { kind: 'date' as const, table: 'fixed_cost_expenses', rowId: e.id, field: 'payment_date' },
        }
      }),
      ...st.map((e: any) => ({
        href: '/staff', code: 'FOLHA', label: e.description || e.type || '', extra: tag(e), amount: parseFloat(e.amount) || 0,
        fix: { kind: 'date' as const, table: 'expenses', rowId: e.id, field: 'payment_date' },
      })),
    ].sort((a, b) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      group: 'FINANCIAL', key: 'undated-fixed', title: 'Custo fixo ou folha vencido (ou sem data nenhuma)', blocks: 'ou o pagamento atrasou, ou foi pago e o DFC não sabe quando',
      why: 'Conta futura agendada é o fluxo normal (Future Flow) — não entra aqui. Entra a VENCIDA (a data prevista passou sem pagamento lançado: se pagou, registre; se atrasou, é cobrança) e a SEM DATA NENHUMA, que nem no mês certo consegue aparecer.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 5b · Fornecedor MONTHLY com 2+ contas no mesmo mês (AUTO-BOOK, BL 0.8.0): a
  // criada/adotada pelo banco (ou lançada à mão) + a agendada do gerador = dupla.
  // APP fica fora: recibos do Gmail cobram várias vezes no mês por natureza.
  {
    const items: Item[] = []
    const byKey = new Map<string, any[]>()
    for (const e of d.fixedExpenses) {
      const sup = d.fixedSuppliers.get(e.supplier_id)
      if (!sup || sup.periodicity !== 'MONTHLY' || ['BANK', 'ASSET', 'MARKETING', 'MERCHANDISE', 'APP'].includes(String(sup.cost_type))) continue
      const m = String(e.expense_date || '').slice(0, 7); if (!m) continue
      const k = e.supplier_id + '|' + m; byKey.set(k, [...(byKey.get(k) || []), e])
    }
    byKey.forEach((rows, k) => {
      const [supId, month] = k.split('|')
      const sup = d.fixedSuppliers.get(supId)
      if (rows.length < 2) return
      // DUPLICATA é identidade dura: mesmo fornecedor, mesmo mês e MESMO VALOR (ou mesma descrição).
      // Contar «slots» marcava aluguel + garagem da Luma (duas cobranças legítimas no mesmo dia) e
      // oferecia APAGAR um aluguel real — 28 falsos positivos medidos em 8/set/2026.
      const amt = (r: any) => Math.round((parseFloat(r.amount) || 0) * 100) / 100
      const desc = (r: any) => String(r.description || '').trim().toLowerCase()
      const twin = (o: any) => rows.find((r: any) => r.id !== o.id && (Math.abs(amt(r) - amt(o)) < 0.011 || (desc(o) && desc(r) === desc(o))))
      const open = rows.filter((r: any) => !r.bank_transaction_id && !r.payment_date)
      for (const o of open) {
        const t = twin(o); if (!t) continue
        const tPaid = !!(t.bank_transaction_id || t.payment_date)
        items.push({
          href: '/costs/fixed/' + supId, code: 'DUPLA MÊS', when: String(o.expense_date || '').slice(0, 10),
          label: `${sup?.company || sup?.description || ''} · ${month} · ${usd(amt(o))} duas vezes`,
          extra: tPaid ? `a gêmea (${String(t.expense_date || '').slice(0, 10)}, ${usd(amt(t))}) já está paga/ligada ao banco — esta em aberto é sobra do gerador` : `as duas estão em aberto (${String(t.expense_date || '').slice(0, 10)} e ${String(o.expense_date || '').slice(0, 10)}) — decida qual vive`,
          amount: amt(o), signal: tPaid ? 'matched' : undefined,
          fix: { kind: 'trash' as const, table: 'fixed_cost_expenses', rowId: o.id, field: 'DELETED', confirmText: `Apagar a conta em aberto de ${String(o.expense_date || '').slice(0, 10)} (${usd(amt(o))})? O mês ${month} de ${sup?.company || ''} tem outra igual${tPaid ? ', paga/ligada ao banco' : ' em aberto'}. Fica na trilha.` },
        })
      }
    })
    if (items.length) checks.push({
      group: 'FINANCIAL', key: 'fixed-dup-month', title: 'Fornecedor MONTHLY com 2+ contas no mesmo mês', blocks: 'a mesma conta pesa duas vezes: no DRE e em "a pagar"',
      why: 'Duplicata é identidade dura: mesmo fornecedor, mesmo mês e MESMO VALOR (ou mesma descrição) — aluguel e garagem no mesmo dia NÃO são duplicata (Luma, 8/set). Quando o banco cria ou adota a conta do mês (AUTO-BOOK) ou alguém lança a mesma conta à mão, sobra uma agendada em aberto ao lado da paga. APP fica fora (assinaturas com recibo do Gmail cobram várias vezes no mês por natureza). Apague a sobra em aberto — a paga/ligada ao banco é a verdadeira.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 5c · Assinatura ENCERRADA com conta ainda agendada (caso Disney+, João 25/ago:
  // encerrar é FORMAL — date_conclusion — não uma nota na descrição). O gerador
  // para de criar contas no encerramento, mas as JÁ criadas ficam: fantasmas.
  {
    const items: Item[] = []
    for (const e of d.fixedExpenses) {
      if (e.payment_date) continue
      const sup = d.fixedSuppliers.get(e.supplier_id)
      const end = sup?.date_conclusion ? String(sup.date_conclusion).slice(0, 10) : null
      const due2 = String(e.expense_date || '').slice(0, 10)
      const supToks = nameTok(sup?.company)
      const chargedAfter = end ? bank.lines.some(x => x.d > end && (() => { const lt = new Set(nameTok(x.n)); return supToks.some(t => lt.has(t)) })()) : true
      // CERTA só com nome real (≥4 letras), fim há 7+ dias (a última fatura posta DEPOIS do fim) e a Regions carregada.
      const mature = !!end && end <= new Date(Date.parse(TODAY) - 7 * 864e5).toISOString().slice(0, 10)
      if (end && due2 && due2 > end) items.push({
        certain: supToks.length > 0 && mature && bank.lines.length > 0 && !chargedAfter, signal: supToks.length > 0 && mature && bank.lines.length > 0 && !chargedAfter ? 'matched' : undefined,
        href: e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', code: 'FANTASMA',
        label: [sup?.company, e.description].filter(Boolean).join(' · '), extra: `assinatura encerrou ${end} · conta agendada ${due2}`, amount: parseFloat(e.amount) || 0,
        fix: { kind: 'trash' as const, table: 'fixed_cost_expenses', rowId: e.id, field: 'DELETED', confirmText: `Apagar a conta agendada de ${due2} (${sup?.company || ''})? A assinatura encerrou em ${end} — depois disso não há serviço, não há despesa. Fica na trilha.` },
      })
    }
    checks.push({
      group: 'FINANCIAL', key: 'sub-ended-scheduled', title: 'Assinatura encerrada com conta ainda agendada', blocks: 'despesa fantasma no fluxo futuro de um serviço que já morreu',
      why: 'Encerrar é formal: o END DATE do fornecedor (date_conclusion — botão ENCERRAR na página dele preenche e limpa as agendadas). Este card pega a sobra: conta não paga agendada DEPOIS do encerramento. Apague aqui (com trilha) — ou, se de fato ficou devendo, acerte a data do encerramento.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 6 · Jobs legados: dinheiro recebido contra invoice sem linha nenhuma (D9).
  {
    const items: Item[] = []
    let impact = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const sched = d.payments.filter((p: any) => p.invoice_id === inv.id).reduce((s: number, p: any) => s + (parseFloat(p.amount) || 0), 0)
      if (t.grand < 0.005 && sched > 0) {
        const m = invoiceMeta(d, inv.id)
        // Fricção #18 (João): a linha mostra o FORMATO do dinheiro e leva direto
        // pro editor — reconstruir linhas é trabalho de editor, não de FIX inline.
        const ps = d.payments.filter((p: any) => p.invoice_id === inv.id)
        const dates = ps.map((p: any) => String(p.paid_at || p.payment_date || '').slice(0, 10)).filter(Boolean).sort()
        items.push({
          href: m.href.replace('/invoices/', '/invoices/edit/'), code: m.code, label: whoFor(inv.id),
          extra: `recebido ${usd(t.received)} de ${usd(sched)} · ${ps.length} parcela(s)${dates.length ? ` · ${dates[0]} → ${dates[dates.length - 1]}` : ''} · ${inv.live_status} — abra o EDITOR e reconstrua as linhas do que foi vendido`,
          amount: sched,
        })
        impact += sched
      }
    }
    checks.push({
      group: 'INVOICES', key: 'zero-billed', title: 'Cliente pagou, mas a invoice não fatura NADA', blocks: 'o dinheiro vira DÍVIDA nossa com o cliente no Balanço (adiantamento eterno) — nunca vira receita',
      why: 'O que este card pega: o total FATURADO da invoice (parts + services) é ZERO, mas há dinheiro recebido nela — o cliente pagou por algo que o papel não conta. Receita só nasce de linha faturada; sem linhas, o Balanço trata o dinheiro como ADIANTAMENTO DE CLIENTE (uma dívida nossa!) pra sempre, e o DRE nunca vê o resultado do job. Conserto real: abrir o EDITOR da invoice (a linha já leva) e reconstruir o que foi vendido — parts, services, preços — trabalho de contexto, por isso não há FIX inline. As legadas de 2025 (US.003–US.008) têm a alternativa contábil de fechar contra o resultado de abertura: essa é a decisão D9, ainda pendente com o Márcio. As de 2026 são jobs reais com linhas esquecidas — só preencher.',
      items: items.sort((a, b) => (b.amount || 0) - (a.amount || 0)), impact,
    })
  }

  // 7 · Fornecedores de custo fixo sem cost_type.
  {
    const items: Item[] = []
    let impact = 0
    d.fixedSuppliers.forEach((s: any) => {
      if (s.cost_type) return
      const tot = d.fixedExpenses.filter((e: any) => e.supplier_id === s.id).reduce((x: number, e: any) => x + (parseFloat(e.amount) || 0), 0)
      items.push({
        href: '/costs/fixed/' + s.id, code: 'FIXO', label: s.company || s.description || '—', extra: 'sem cost_type', amount: tot,
        fix: { kind: 'select', table: 'fixed_cost_suppliers', rowId: s.id, field: 'cost_type', options: TYPE_OPTIONS, current: null },
      })
      impact += tot
    })
    checks.push({
      group: 'FINANCIAL', key: 'untyped-supplier', title: 'Este fornecedor fixo é de quê?', blocks: 'o DRE joga o gasto na linha "não classificado"',
      why: 'Sem cost_type (FIXED/APP/MARKETING/ASSET) o gasto cai na linha genérica da DRE em vez da família certa.',
      items, impact,
    })
  }

  // 8 · Recebimentos agendados vencidos sem baixa.
  {
    const rows = d.payments.filter((p: any) => !p.paid_at && p.payment_date && p.payment_date < TODAY)
    const items = rows.map((p: any) => {
      const m = invoiceMeta(d, p.invoice_id)
      return {
        href: m.href, code: m.code,
        label: whoFor(p.invoice_id) + ' — income «' + (p.description || p.source || 'agendado') + '»',
        extra: 'vencido ' + formatShortDate(p.payment_date), amount: parseFloat(p.amount) || 0,
        fix: { kind: 'received' as const, table: 'invoice_payments', rowId: p.id },
      }
    }).sort((a: Item, b: Item) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      group: 'INVOICES', key: 'overdue-receipts', title: 'Recebimento venceu e ninguém deu baixa', blocks: 'ou o cliente atrasou, ou o dinheiro entrou e ficou sem registro',
      why: 'Agendado pra uma data que já passou e sem paid_at. Se o dinheiro entrou, MARK RECEIVED dá a baixa agora (caixa de hoje). Se não entrou, é cobrança.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 9 · Estoque comprado sem payment_date.
  {
    const rows = d.inventory.filter((s: any) => s.source_type === 'PURCHASED' && !s.payment_date)
    checks.push({
      group: 'INVENTORY', key: 'undated-stock', title: 'Compra de estoque: pagamos quando?', blocks: 'a compra some do fluxo de caixa',
      why: 'Compra de estoque sem data de pagamento não entra no caixa de investimentos.',
      items: rows.map((r: any) => ({
        href: '/inventory', code: 'STOCK', label: r.description || '', amount: qtyLine(r),
        // João conferiu (25/ago): aqui o card está CERTO — estoque sem data é dado
        // faltando mesmo. Só ganha a data de compra no rótulo (regra: linha se distingue).
        extra: r.purchase_date ? `comprado ${String(r.purchase_date).slice(0, 10)}` : 'sem data de compra também',
        fix: { kind: 'date' as const, table: 'inventory', rowId: r.id, field: 'payment_date' },
      })),
      impact: rows.reduce((s: number, r: any) => s + qtyLine(r), 0),
    })
  }

  // 9b · PAID FROM vazio — quem pagou? Sem isso o motor do Bank Link trata a
  // linha como "talvez Regions" (ruído no pool) e o DFC não sabe de que caixa
  // saiu. Linha já casada com a Regions = GZ28US com certeza (o banco provou):
  // vai no bulk PREENCHER CERTOS. source GZ28BR/GZ28US vira sugestão pré-carregada.
  {
    // Sinais, do mais forte pro mais fraco:
    //   casada com a Regions      → GZ28US, certo (o banco provou)          [bulk PREENCHER CERTOS]
    //   antes da conta abrir      → NÃO foi GZ28US; BR ou Beto (humano decide)
    //   não consta na Regions     → provavelmente não foi GZ28US (item de pedido somado pode enganar)
    //   consta na Regions (±10d)  → provavelmente GZ28US — o motor/MATCH confirma
    //   campo SOURCE              → sugestão fraca
    const inRegions = (amount: number, date: string | null) => {
      if (!date || !bank.outflows.size) return null
      const ds = bank.outflows.get(amount.toFixed(2)) || []
      return ds.some(x => dayDiff(x, date) <= 10)
    }
    // Total de cada pedido (grupo) — TODOS os itens, com ou sem paid_from: o banco
    // cobrou o pedido inteiro, então é o total que se procura no extrato (revisão #2).
    const groupSums = new Map<string, number>()
    const addG = (rows: any[], amt: (r: any) => number) => { for (const r of rows) if (r.purchase_group) groupSums.set(r.purchase_group, (groupSums.get(r.purchase_group) || 0) + amt(r)) }
    addG(d.invExpenses, expLine); addG(d.goods, qtyLine); addG(d.inputs, qtyLine); addG(d.inventory.filter((x: any) => x.source_type === 'PURCHASED'), qtyLine)
    const mk = (table: string, r: any, code: string, href: string, label: string, amount: number): Item => {
      const date: string | null = r.payment_date || r.expense_date || r.purchase_date || null
      const gid: string | null = r.purchase_group || null
      const gSum = gid ? groupSums.get(gid) : undefined
      const gBank = gid ? bank.groups.get(gid) : undefined                        // valor que o banco cobrou do pedido casado
      const groupCertain = gid != null && gBank !== undefined && gSum !== undefined && Math.abs(gSum - gBank) < 0.011
      const bankCertain = matched.has(table + ':' + r.id) || groupCertain
      // Colheita do SOURCE legado (auditoria do João, 25/ago): antes do paid_from
      // existir, o campo `source` ERA o quem-pagou — valor limpo é resposta do
      // próprio app (74×GZ28US, 4×Regions no dia da auditoria), não palpite.
      const srcRaw = String(r.source || '').trim()
      const srcMapped = /^regions$/i.test(srcRaw) ? 'GZ28US' : ((PAID_FROM_OPTIONS as readonly string[]).find(o => o.toLowerCase() === srcRaw.toLowerCase()) || null)
      let certain = bankCertain
      let suggest: string | undefined, extra: string | undefined, signal = 'source'
      if (bankCertain && srcMapped && srcMapped !== 'GZ28US') { certain = false; extra = `banco provou GZ28US, mas o SOURCE antigo diz ${srcMapped} — conferir`; signal = 'conflict' }
      else if (bankCertain) { suggest = 'GZ28US'; extra = groupCertain ? 'pedido casado com a Regions' : 'casada com a Regions'; signal = 'matched' }
      else if (srcMapped && srcMapped !== 'GZ28US') { certain = true; suggest = srcMapped; extra = `o campo antigo SOURCE já dizia: ${srcMapped}`; signal = 'source' }
      else if (srcMapped === 'GZ28US' && inRegions(amount, date) !== false) { certain = true; suggest = 'GZ28US'; extra = 'o campo antigo SOURCE já dizia: GZ28US'; signal = 'source' }
      else if (srcMapped === 'GZ28US') { suggest = 'GZ28US'; extra = 'SOURCE antigo diz GZ28US, mas não consta na Regions — conferir'; signal = 'conflict' }
      else if (gid && gBank !== undefined) { suggest = 'GZ28US'; extra = 'pedido casado com a Regions (total do pedido mudou — conferir)'; signal = 'present' }
      // Antes da conta abrir NÃO foi GZ28US — mas GZ28BR × BETO é decisão de gente:
      // sem palpite pré-carregado (revisão #5).
      else if (date && date < (bank.opened || REGIONS_OPENED)) { extra = 'antes da Regions abrir — GZ28BR ou BETO?'; signal = 'pre-open' }
      else {
        const hitItem = inRegions(amount, date)
        const hitGroup = gid && gSum ? inRegions(gSum, date) : null
        if (hitItem === true) { suggest = 'GZ28US'; extra = 'encontrada na Regions (±10d)'; signal = 'present' }
        else if (hitGroup === true) { suggest = 'GZ28US'; extra = 'pedido somado encontrado na Regions (±10d)'; signal = 'present' }
        else if (hitItem === false) {
          // SOURCE contradizendo o sinal é CONFLITO, não palpite BR (revisão #3 — o
          // ternário antigo dava GZ28BR dos dois lados).
          if (r.source === 'GZ28US') { suggest = 'GZ28US'; extra = 'fora da Regions, mas SOURCE diz GZ28US — conferir'; signal = 'conflict' }
          // Ausente da Regions NÃO é prova de BR: medido em 8/set nas linhas já preenchidas, 85% das
          // «ausentes» eram GZ28US (valor partido, pedido somado). Sem palpite — a resposta é de gente.
          else { extra = 'fora da Regions (±10d) — GZ28BR, sócio ou valor partido? sem palpite'; signal = 'absent' }
        }
        else if (r.source === 'GZ28BR' || r.source === 'GZ28US') { suggest = r.source; extra = 'sugestão: ' + r.source; signal = 'source' }
      }
      return {
        href, code, label, amount, certain, suggest, extra, signal, when: date || undefined,
        fix: { kind: 'select' as const, table, rowId: r.id, field: 'paid_from', options: PAID_FROM_SELECT, current: null },
      }
    }
    const items: Item[] = [
      // Auditoria do João (25/ago): 310 das 937 eram linhas NÃO PAGAS — quem pagou?
      // ninguém ainda. O paid_from nasce na hora do pagamento; só linha PAGA entra.
      ...d.invExpenses.filter((e: any) => !e.paid_from && e.payment_date).map((e: any) => { const m = invoiceMeta(d, e.invoice_id); return mk('invoice_expenses', e, 'PROJ', m.href, [m.code, m.car, e.item, e.supplier].filter(Boolean).join(' · '), expLine(e)) }),
      ...d.fixedExpenses.filter((e: any) => !e.paid_from && e.payment_date).map((e: any) => mk('fixed_cost_expenses', e, 'FIXO', e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', [d.fixedSuppliers.get(e.supplier_id)?.company, e.description].filter(Boolean).join(' · '), parseFloat(e.amount) || 0)),
      ...d.expenses.filter((e: any) => !e.paid_from && e.payment_date).map((e: any) => mk('expenses', e, e.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA', '/staff', e.description || e.type || '', parseFloat(e.amount) || 0)),
      ...d.goods.filter((g: any) => !g.paid_from && g.payment_date).map((g: any) => mk('goods', g, 'GOODS', '/goods', [g.description, g.supplier].filter(Boolean).join(' · '), qtyLine(g))),
      ...d.goodExpenses.filter((g: any) => !g.paid_from && g.payment_date).map((g: any) => mk('good_expenses', g, 'GOODS', '/goods', g.description || '', parseFloat(g.amount) || 0)),
      ...d.inputs.filter((x: any) => !x.paid_from && x.payment_date).map((x: any) => mk('inputs', x, 'INPUT', '/supplies', [x.description, x.category].filter(Boolean).join(' · '), qtyLine(x))),
      ...d.inventory.filter((x: any) => x.source_type === 'PURCHASED' && !x.paid_from && x.payment_date).map((x: any) => mk('inventory', x, 'STOCK', '/inventory', x.description || '', qtyLine(x))),
    ].sort((a, b) => Number(!!b.certain) - Number(!!a.certain) || (b.amount || 0) - (a.amount || 0))
    checks.push({
      group: 'FINANCIAL', key: 'paid-from', title: 'Quem pagou esta conta?', blocks: 'o caixa por banco sai errado e a conciliação não fecha',
      why: 'Quem pagou define a conta corrente com a GZ28BR e o empréstimo de sócio (Beto) no Balanço — e sem isso o motor do Bank Link trata a linha como possível Regions. Só linha PAGA entra (o paid_from nasce na hora do pagamento; não paga não tem quem-pagou). Provas do PREENCHER CERTOS, por linha: casada com a Regions (o banco) ou o campo antigo SOURCE com valor limpo (o quem-pagou da época). Antes de 10/nov/2025 a conta nem existia = GZ28BR ou BETO (sem palpite — decidam); "fora da Regions" = provavelmente não foi GZ28US; banco × SOURCE discordando = conflito, um a um. Use o filtro de SINAL + texto e marque os filtrados de uma vez.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 9c · CAIXA NÃO BATE — o saldo que o BANCO diz (Plaid, agora) contra o que as
  // linhas do Bank Link implicam (último extrato lançado + linhas desde então).
  // Diferença maior que o que ainda está pendente = linha faltando ou sobrando
  // no feed. É a régua de tudo: se isto não bate, nenhum outro número vale.
  {
    const items: Item[] = []
    // Verificação que não rodou NÃO é verde (revisão #16).
    if (bank.cashState !== 'ok') items.push({ href: '/adm/bank', code: 'SINAL', label: bank.cashState === 'loading' ? 'sinal do banco ainda carregando — verificação não rodou' : 'sinal do banco indisponível — verificação NÃO rodou', extra: 'recarregue; se persistir, veja BANK LINK' })
    for (const c of bank.cash || []) {
      if (!c.live) { items.push({ href: '/adm/bank', code: 'BANCO', label: `${c.account}: Plaid sem resposta`, extra: c.live_error || 'sem saldo real' }); continue }
      if (!c.integrity) { items.push({ href: '/adm/financials/ledgers', code: 'ÂNCORA', label: `${c.account}: nenhum extrato lançado como âncora`, extra: 'lance o saldo de um extrato em LEDGERS' }); continue }
      const g = c.integrity.gap ?? 0
      // Esperado: gap = pendente de saída − pendente de entrada; fora disso ±$1 = buraco (revisões #12/#24).
      if (Math.abs(g - (c.integrity.pending_out - (c.integrity.pending_in || 0))) > 1)
        items.push({ href: '/adm/bank', code: 'NÃO BATE', label: `${c.account}: banco ${usd(c.live.current)} · extrato ${c.integrity.anchor_date} + ${c.integrity.lines_after} linhas = ${usd(c.integrity.implied)}`, extra: `${g > 0 ? 'faltam linhas de entrada / sobram saídas' : 'faltam saídas / sobram entradas'} · pendente −${usd(c.integrity.pending_out)} / +${usd(c.integrity.pending_in || 0)}`, amount: Math.abs(g) })
    }
    checks.push({
      group: 'BANK', key: 'cash-match', title: 'O caixa do app bate com o banco?', blocks: 'TUDO — esta é a régua de todo o resto',
      why: 'O Plaid pergunta ao banco o saldo de agora. O Bank Link implica um saldo: último extrato lançado + todas as linhas desde então. Os dois têm que ser iguais até o que ainda está pendente (cartão que não postou). Diferença maior = linha faltando ou duplicada no feed — nada mais deve ser conciliado antes de resolver isto.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 10 · Caixa: migration pendente, nenhum saldo, ou saldo com mais de 35 dias.
  {
    const lt = ledgerTotals(d)
    const items: Item[] = []
    if (!lt) items.push({ href: '/adm/financials/ledgers', code: 'LIVROS', label: 'Rodar MIGRATION_financial_ledgers.sql no Supabase e lançar os primeiros saldos', extra: 'migration pendente' })
    else if (lt.cashAccounts.length === 0) items.push({ href: '/adm/financials/ledgers', code: 'CAIXA', label: 'Nenhum saldo de caixa lançado ainda', extra: 'Balanço sem linha de caixa' })
    else {
      const cutoff = new Date(Date.now() - 35 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      for (const a of lt.cashAccounts) if (a.date < cutoff)
        items.push({ href: '/adm/financials/ledgers', code: 'CAIXA', label: a.account, extra: 'último saldo ' + a.date, amount: a.balance })
    }
    // O Plaid grava saldo todo dia (o "último saldo" nunca envelhece mais) — a
    // disciplina que importa agora é o EXTRATO: âncora > 45 dias = lance o mês (revisão #23).
    for (const c of bank.cash || []) if (c.integrity) {
      const age = Math.round((Date.now() - Date.parse(c.integrity.anchor_date)) / 864e5)
      if (age > 45) items.push({ href: '/adm/financials/ledgers', code: 'EXTRATO', label: `${c.account}: último extrato lançado em ${c.integrity.anchor_date}`, extra: age + ' dias — lance o extrato do mês (é a âncora da régua)' })
    }
    checks.push({
      group: 'FINANCIAL', key: 'cash-stale', title: 'Saldo de caixa ausente ou velho', blocks: 'o Balanço mostra um caixa que já não existe',
      why: 'O Balanço usa o último saldo por conta. Saldo velho é caixa mentindo — lance o fechamento de cada mês em LEDGERS até o Plaid assumir.',
      items,
    })
  }

  // TAX · 1099-NEC — beneficiário com $600+ num ano sem classificação, ou
  // classificado SERVIÇO sem W-9. A classificação mora no TAX HUB (/adm/tax);
  // aqui é a cobrança. Prazo: 1099 até 31/jan do ano seguinte.
  {
    const items: Item[] = []
    if (tax.state === 'error') items.push({ href: '/adm/tax', code: 'SINAL', label: 'sinal do 1099 indisponível — verificação NÃO rodou', extra: 'recarregue; se persistir, veja TAX SHIELD' })
    if (tax.needsMigration) items.push({ href: '/adm/tax', code: 'MIGRATION', label: 'Rodar MIGRATION_tax_1099.sql no SQL Editor', extra: 'classificação/W-9 só gravam com a tabela criada' })
    for (const y of tax.years) for (const p of y.payees) {
      // Fricção final do João (25/ago): "parece só uma lista". Agora a linha AGE:
      // classificar e marcar W-9 aqui mesmo (o /api/tax/1099 grava e faz a trilha).
      if (!p.classification) items.push({
        href: '/adm/tax', code: y.year, label: `${p.name} recebeu ${usd(p.total)} em ${y.year}`,
        extra: 'o que foi? SERVIÇO exige 1099 + W-9; o resto não exige nada', amount: p.total, when: y.year,
        fix: { kind: 'select' as const, table: 'tax_contractors', rowId: p.key, field: 'classification', current: null, meta: { name: p.name, w9: p.w9_on_file }, options: [
          { value: 'SERVICE', label: 'SERVIÇO — trabalhou pra nós (pede 1099 + W-9)' },
          { value: 'GOODS', label: 'MERCADORIA — só compramos coisas (sem 1099)' },
          { value: 'CORPORATION', label: 'CORPORAÇÃO — empresa Inc./Corp (sem 1099)' },
          { value: 'PERSONAL', label: 'PESSOAL — não é gasto da empresa' },
          { value: 'IGNORE', label: 'IGNORAR — ruído do extrato' },
        ] },
      })
      else if (p.classification === 'SERVICE' && !p.w9_on_file) items.push({
        href: '/adm/tax', code: y.year, label: `${p.name}: SERVIÇO de ${usd(p.total)} em ${y.year} — falta o W-9`,
        extra: `peça o W-9 (o formulário com o SSN/EIN) e marque aqui quando chegar · 1099-NEC até 31/jan/${Number(y.year) + 1}`, amount: p.total, when: y.year,
        fix: { kind: 'select' as const, table: 'tax_contractors', rowId: p.key, field: 'w9_on_file', current: null, meta: { name: p.name, cls: p.classification }, options: [
          { value: 'yes', label: '✓ o W-9 chegou e está guardado' },
        ] },
      })
    }
    checks.push({
      group: 'TAX', key: 'tax-1099', title: 'Pagamos alguém $600+ no ano — o 1099 está em dia?',
      blocks: 'obrigação anual (31/jan) — 1099 não emitido dá multa',
      why: 'A LEI (EUA): pagou uma PESSOA ou empresa não-corporação $600+ no ano por SERVIÇO → a GZ28US é obrigada a emitir o formulário 1099-NEC até 31/jan do ano seguinte — e pra emitir precisa do W-9 dela (o cadastro onde ela informa SSN/EIN). Não emitir dá multa. ESTE CARD lê o extrato da Regions (Zelle, wire, cheque), soma quem recebeu $600+ e pergunta O QUE FOI: responda na própria linha. Mercadoria, corporação ou pessoal = sem obrigação nenhuma. A tela cheia (TAX SHIELD) tem o UNIR pra juntar grafias do mesmo beneficiário; a Drummond (contadora) confirma os casos duvidosos.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // RIDES · G4 — carro da frota (OWN/TOOL) sem natureza de ativo (25/ago): a
  // depreciação não sabe o que fazer com ele. As classes são as do João.
  {
    const items: Item[] = []
    let migrated = true
    for (const r of d.rides.values()) {
      if (r.title_scope !== 'OWN' && r.title_scope !== 'TOOL') continue
      if ((r as any).asset_class === undefined) { migrated = false; break }
      if (!(r as any).asset_class) items.push({
        href: '/rides/' + r.id, code: r.title_scope, label: `${r.project_code || ''} "${r.project_name || '—'}"`,
        extra: 'qual a natureza deste ativo?',
        fix: { kind: 'select' as const, table: 'rides', rowId: r.id, field: 'asset_class', current: null, options: [
          { value: 'TRABALHO', label: 'TRABALHO — transporte/serviço (deprecia, 60m)' },
          { value: 'DESENVOLVIMENTO', label: 'DESENVOLVIMENTO — laboratório (deprecia, 60m; marketing de quebra)' },
          { value: 'COLECIONAVEL', label: 'COLECIONÁVEL — chassi ao custo (valoriza fora dos livros); mods depreciam' },
          { value: 'MONUMENTO', label: 'MONUMENTO — permanente, nunca vendido (ao custo)' },
          { value: 'RESERVA', label: 'RESERVA — ativo em carteira, pode virar algo (ao custo)' },
        ] },
      })
    }
    if (migrated) checks.push({
      group: 'RIDES', key: 'fleet-class', title: 'Carro da frota sem natureza de ativo', blocks: 'a depreciação (G4) não sabe o que depreciar',
      why: 'Classificação do João (25/ago): TRABALHO e DESENVOLVIMENTO depreciam linear por linha de custo (vida padrão 60 meses; trailer 120); COLECIONÁVEL (Devil170 — produção única) mantém o CHASSI ao custo (valorização fica fora dos livros até a venda) e deprecia só os experimentos; MONUMENTO (a alma — GENEZIZ) e RESERVA ficam ao custo até virarem outra coisa. Todo carro OWN/TOOL novo cai aqui até ganhar a sua classe.',
      items,
    })
  }

  // INPUTS · O BLOB TÓXICO (João, 26/ago): 139 insumos num "CONSUMPTION" que
  // mistura comida (Equipe), óleo (ESTOQUE de verdade) e consumível de oficina.
  {
    // DC 1.45.0: dois leitores (texto + LOJA) em lib/inputsCategory — a mesma régua que o motor usa ao criar o insumo.
    const items: Item[] = []
    for (const x of d.inputs) {
      if (x.category && x.category !== 'CONSUMPTION' && x.category !== 'SHOP') continue   // SHOP: opção antiga do card, mesma coisa que CONSUMPTION
      const text = String(x.description || '')
      const v = classifyInput((x as any).supplier, text)
      // Consumível de oficina em loja de ferragem já está CERTO: silêncio (não é pergunta, não é escrita).
      if (v.tier === 'CERTAIN' && v.category === 'CONSUMPTION' && (x.category === 'CONSUMPTION' || x.category === 'SHOP')) continue
      // STOCK nunca é certo (mover é de gente); CONSUMPTION certo só entra sozinho onde a categoria está vazia.
      const certain = v.tier === 'CERTAIN' && v.category !== 'STOCK'
      const sug = v.category === 'STOCK' ? '__stock__' : v.category === 'CONSUMPTION' && !certain ? '__keep__' : (v.category || undefined)
      items.push({
        href: '/supplies', code: certain ? 'CERTA' : x.category ? 'BLOB' : 'SEM CAT.', label: text.slice(0, 70) || '(sem descrição)',
        extra: v.category === 'STOCK' ? 'é ESTOQUE (óleo/material de job) — mover · ' + v.why : certain ? v.why + ' — entra sozinho' : v.category ? 'palpite: ' + v.category + ' · ' + v.why : v.why,
        amount: qtyLine(x), suggest: sug, certain, signal: certain ? 'matched' : sug ? 'source' : undefined,
        fix: { kind: 'select' as const, table: 'inputs', rowId: x.id, field: 'category', current: x.category || null, meta: { description: x.description, supplier: (x as any).supplier, unit_price: x.unit_price, quantity: x.quantity, purchase_date: x.purchase_date, payment_date: x.payment_date, paid_from: x.paid_from, paid_to: (x as any).paid_to, source: (x as any).source, purchase_group: x.purchase_group, order_number: (x as any).order_number }, options: [
          { value: '__keep__', label: '✓ É CONSUMÍVEL DA OFICINA — fica em CONSUMPTION (o card para de perguntar)' },
          { value: 'TEAM', label: 'TEAM — comida & bem-estar (vira Equipe no DRE)' },
          { value: 'APARTMENT', label: 'APARTMENT — apto (moradia da equipe)' },
          { value: 'CATS', label: 'CATS — mascotes' },
          { value: '__stock__', label: '📦 É ESTOQUE — mover pra INVENTORY (óleo, material de job)' },
        ] },
      })
    }
    checks.push({
      group: 'INVENTORY', key: 'inputs-category', title: 'Insumo na categoria errada (o blob CONSUMPTION)',
      blocks: 'comida, óleo e consumível misturados envenenam o DRE (Equipe × Consumíveis × Estoque)',
      why: 'João achou o veneno (26/ago): insumos num balaio único misturando comida (que é EQUIPE), óleo de motor (que é ESTOQUE — material de job) e consumível de verdade (o que mantém a OFICINA rodando). Desde 8/set dois leitores decidem: o TEXTO e a LOJA. Ferragem (Ace, Harbor Freight, Home Depot) é consumível de oficina — fica calada; mercado e lanchonete são EQUIPE e pet é CATS — entram sozinhos; loja mista (Walmart, Target, Sams, Amazon, Temu, Dollar Tree) só sugere pelo texto. «É consumível da oficina» ensina: a linha some do card e fica na trilha. O motor do Bank Link cria o insumo já com a mesma régua.',
      items,
    })
  }

  // STAFF · DUTY WATCH — timer esquecido infla hora; o cron avisa a própria
  // pessoa no WhatsApp (um aviso por duty/dia, escalação pro grupo em 60min);
  // aqui é o retrato de agora. O conserto é na tela DUTIES.
  {
    const items: Item[] = []
    if (duty.state === 'error') items.push({ href: '/duties', code: 'SINAL', label: 'sinal das duties indisponível — verificação NÃO rodou', extra: 'recarregue; se persistir, veja DUTIES' })
    for (const i of duty.incidents) {
      const kindTxt = i.kind === 'OVERLAP' ? 'duas duties rodando ao mesmo tempo' : i.kind === 'OVERNIGHT' ? 'virou a noite ligada' : `rodando há ${i.hours}h (limite ${duty.maxHours}h)`
      items.push({ href: '/duties', code: i.kind === 'OVERLAP' ? 'SIMULT.' : i.kind === 'OVERNIGHT' ? 'NOITE' : 'TIMER', label: `${i.staff_name}: "${i.label}"${i.car ? ' · ' + i.car : ''} — ${kindTxt}`, extra: i.escalated ? 'avisado + escalado pro grupo' : i.nudged ? 'avisado no WhatsApp às ' + String(i.nudged).slice(11, 16) + 'Z' : 'aviso sai no próximo ciclo (30min, 07–22h)', when: i.key.slice(-10) })
    }
    // HISTÓRICO: segmento fechado acima do limite (FIX = aparar com o fim real)
    // e a compensação silenciosa que costuma vir atrás dele.
    const fmtDT = (iso: string) => new Date(iso).toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false }).slice(0, 16).replace(', ', 'T')
    for (const s of duty.history.absurd) items.push({
      href: '/duties', code: 'HISTÓRICO', when: s.start.slice(0, 10),
      label: `${s.staff_name}: "${s.label}"${s.car ? ' · ' + s.car : ''} — segmento de ${s.wall_h}h (${s.start.slice(0, 10)} → ${s.end.slice(0, 10)})`,
      extra: 'FIX apara pro fim real', suggest: fmtDT(new Date(Date.parse(s.start) + duty.maxHours * 36e5).toISOString()),
      fix: { kind: 'trim' as const, table: 'invoice_duties' as const, rowId: s.key, field: 'time_seconds' as const, dutyId: s.duty_id, segStart: s.start, segEnd: s.end, bankedStart: s.banked_start, bankedEnd: s.banked_end },
    })
    for (const c of duty.history.comps) items.push({
      href: '/duties', code: 'COMPENSA?', when: c.after,
      label: `${c.staff_name}: ${c.days.length} dia(s) sem NENHUM timer depois do estouro de ${c.after} (${c.days.join(', ')})`,
      extra: 'trabalho sem registro? reconstruir em DUTIES — nunca compensar',
    })
    checks.push({
      group: 'STAFF', key: 'staff-duties', title: 'Timer de trabalho esquecido, dobrado ou virando a noite',
      blocks: 'as horas da equipe ficam infladas e o relatório diário mente',
      why: `Timer que ninguém pausou vira hora que ninguém trabalhou. Regras (Márcio): ${duty.maxHours}h por duty, uma duty por vez, nada vira a noite ligado. O cron (30 em 30min, 07–22h de Orlando) avisa a PRÓPRIA pessoa no WhatsApp — um aviso por duty por dia — e escala pro grupo GZ28US - STAFF se seguir rodando 60min depois. O conserto (pausar/finalizar) é na tela DUTIES.`,
      items,
    })
  }

  // STAFF · AVISOS DE WHATSAPP QUE NÃO SAÍRAM (caso Gui, 31/ago: o RESUMED das
  // 12:28 morreu calado — só um toast de 3s no celular dele). Toda tentativa de
  // envio agora fica em wa_send_log; aqui aparecem as FALHAS dos últimos 14 dias.
  {
    const items: Item[] = []
    if (wa.state === 'missing') items.push({ href: '/whatsapp', code: 'MIGRATION', label: 'Rodar MIGRATION_wa_send_log.sql no SQL Editor', extra: 'sem a tabela, falha de envio morre sem registro — foi assim no caso do Gui' })
    if (wa.state === 'error') items.push({ href: '/whatsapp', code: 'SINAL', label: 'sinal do WA SEND LOG indisponível — verificação NÃO rodou', extra: 'recarregue a página' })
    for (const f of wa.fails) items.push({
      href: '/whatsapp', code: f.http_status ? 'HTTP ' + f.http_status : 'FALHA', when: String(f.at).slice(0, 10),
      label: `${String(f.at).slice(0, 16).replace('T', ' ')} · ${f.group_name || f.destination || 'destino?'} · "${String(f.body_head || '').slice(0, 60)}"`,
      extra: String(f.error || 'erro desconhecido').slice(0, 140),
    })
    if (items.length) checks.push({
      group: 'STAFF', key: 'wa-send-failures', title: 'Aviso de WhatsApp que NÃO saiu',
      blocks: 'o grupo não fica sabendo do que aconteceu (duty, relatório, alerta)',
      why: 'Márcio (01/ago): "o sistema deve saber de tudo sozinho" — mas o aviso de envio falho era um toast de 3 segundos no celular do funcionário. Agora TODA tentativa do /api/whatsapp fica em wa_send_log (sucesso e falha) e as falhas de 14 dias aparecem aqui. Causas típicas: telefone-host da instância UltraMsg desconectado (mensagem fica em fila — reconectar o aparelho no painel do UltraMsg), grupo renomeado no WhatsApp (a rota resolve por NOME), ou instância sem crédito.',
      items,
    })
  }

  // INVENTORY · LINKER — identidade de peças (pré-P1 do Crew Chief): estoque e
  // stream apontando pro catálogo. PN da peça no texto = CERTO (bulk); nome/
  // apelido = sugestão um a um. Também a higiene do catálogo (sem PN, PN dup).
  {
    const items: Item[] = []
    if (linker.state === 'error' && !linker.needsMigration) items.push({ href: '/parts', code: 'SINAL', label: 'sinal do LINKER indisponível — verificação NÃO rodou', extra: 'recarregue' })
    if (linker.needsMigration) items.push({ href: '/parts', code: 'MIGRATION', label: 'Rodar MIGRATION_parts_identity.sql no SQL Editor', extra: 'os ponteiros part_id precisam das colunas' })
    const mk = (r: LinkerRow, code: string) => {
      const best = r.candidates[0]
      // João, 25/ago: mesma receita do fornecedor — nunca beco sem saída. Sempre
      // dá pra buscar no catálogo INTEIRO ou criar a entrada mínima aqui mesmo.
      items.push({
        href: r.table === 'inventory' ? '/inventory' : '/stream', code, when: undefined,
        label: `${r.text.slice(0, 70)}${r.supplier ? ' · ' + r.supplier : ''}`,
        extra: best ? (best.certain ? 'PN no texto — certo' : 'candidato por nome — conferir') : 'sem candidato — busque no catálogo inteiro ou crie aqui',
        certain: !!best?.certain, suggest: best?.id, signal: best ? (best.certain ? 'matched' : 'source') : undefined,
        fix: { kind: 'select' as const, table: r.table, rowId: r.id, field: 'part_id', options: [...r.candidates.map(c => ({ value: c.id, label: (c.certain ? '✓ ' : '≈ ') + c.label })), { value: '__search__', label: '🔎 buscar no catálogo inteiro…' }, { value: '__new__', label: '➕ criar no catálogo (nasce mínima — PN e preços depois)…' }], current: null, spelling: r.text, sup: r.supplier || undefined },
      })
    }
    for (const r of linker.inventory) mk(r, 'STOCK')
    for (const r of linker.streams) mk(r, 'STREAM')
    for (const p of linker.no_pn) items.push({ href: '/parts', code: 'SEM PN', label: p.item || '(sem nome)', extra: 'peça do catálogo sem part number — preencher em PARTS' })
    for (const dp of linker.dup_pn) items.push({ href: '/parts', code: 'PN DUP', label: `${dp.pn}: ${dp.items.join(' × ')}`, extra: 'regra uma-linha-por-PN — unir em PARTS' })
    // PN DE ANÚNCIO (25/ago): identidade é cirurgia — sempre humano, nunca bulk.
    for (const e of linker.ebay_pn) items.push({
      href: '/parts', code: 'PN ANÚNCIO', label: `${e.item} · "${e.supplier}"`,
      extra: e.suggest ? `o PN gravado (${e.listing}) é o nº do anúncio — no texto o PN real parece ser ${e.suggest}` : `o PN gravado (${e.listing}) é o nº do anúncio — confira o PN real na página`,
      link: { href: `https://www.ebay.com/itm/${e.listing}`, label: 'ANÚNCIO ↗' },
      suggest: e.suggest || undefined, signal: 'source',
      fix: e.suggest ? { kind: 'select' as const, table: 'parts_database', rowId: e.id, field: 'part_number', options: [{ value: e.suggest, label: `${e.suggest} (achado no texto do item)` }], current: e.listing } : undefined,
    })
    checks.push({
      group: 'INVENTORY', key: 'parts-identity', title: 'Esta peça é qual peça do catálogo?',
      blocks: 'estoque e compras não conversam com o catálogo',
      why: 'O Crew Chief só funciona se estoque e stream APONTAREM pra peça do catálogo em vez de descrevê-la em texto (medido: 5/47 e 21/178 achavam). PN da peça no texto = certo — o botão resolve em massa; candidato por nome = confira um a um; sem candidato = cadastre a peça em PARTS e volte. Formulários novos vão escolher do catálogo — este card liga o legado.',
      items, impact: undefined,
    })
  }

  // INVENTORY · R1 — fornecedor com identidade + higiene do catálogo.
  {
    const items: Item[] = []
    if (linker.needsSupplierMigration) items.push({ href: '/parts', code: 'MIGRATION', label: 'Rodar MIGRATION_parts_refinement_r1.sql no SQL Editor', extra: 'o link peça → fornecedor precisa da coluna supplier_id' })
    for (const r of linker.suppliers_unlinked) {
      const best = r.candidates[0]
      // Fricção #4 (João, 25/ago): resolver AQUI — candidatos primeiro, depois a
      // lista oficial inteira, e "criar novo" sem sair da tela.
      const candIds = new Set(r.candidates.map(c => c.id))
      const options = [
        ...r.candidates.map(c => ({ value: c.id, label: (c.certain ? '✓ ' : '≈ ') + c.label })),
        ...linker.suppliers_all.filter(s => !candIds.has(s.id)).map(s => ({ value: s.id, label: s.name })),
        { value: '__new__', label: '➕ criar fornecedor novo…' },
      ]
      items.push({
        href: '/parts', code: r.ebay ? 'EBAY' : r.ebay_bare ? 'EBAY?' : 'FORN.', label: `"${r.text}" · ${r.part}`,
        extra: best ? (best.certain ? 'nome oficial bate — certo' : 'candidato — conferir')
          : r.ebay ? `vendedor do eBay "${r.ebay}" — crie o fornecedor REAL (fica marcado: via eBay)`
          : r.ebay_bare ? (r.ebay_item ? 'compra no eBay sem vendedor à vista — o vendedor está na página do anúncio' : 'compra no eBay sem vendedor à vista — ache-o no histórico de compras do eBay e crie aqui')
          : 'sem candidato — escolha na lista ou crie aqui',
        link: r.ebay_item ? { href: `https://www.ebay.com/itm/${r.ebay_item}`, label: 'ANÚNCIO ↗' } : undefined,
        certain: !!best?.certain, suggest: best?.id, signal: best ? (best.certain ? 'matched' : 'source') : undefined,
        fix: { kind: 'select' as const, table: 'parts_database', rowId: r.id, field: 'supplier_id', options, current: null, spelling: r.text, ebay: r.ebay || undefined },
      })
    }
    for (const m of linker.map_bad) items.push({ href: '/parts', code: 'MAP<CUSTO', label: `${m.item}: custo ${usd(m.cost)} > MAP ${usd(m.map)}`, extra: 'preço fora da lei da casa — conferir em PARTS', amount: m.cost - m.map })
    for (const s of linker.no_source) items.push({ href: '/parts', code: 'ORIGEM', label: `${s}: sem source_type`, extra: 'classificar em PARTS' })
    for (const k of linker.kit_mismatch) items.push({ href: '/parts', code: 'KIT?', label: `${k.item}: source_type ${k.st || '—'} × is_kit ${k.kit ? 'sim' : 'não'}`, extra: 'os dois campos discordam — acertar em PARTS' })
    checks.push({
      group: 'INVENTORY', key: 'parts-suppliers', title: 'Peça sem fornecedor oficial, ou com preço estranho',
      blocks: 'não sabemos de quem comprar nem se o preço respeita a regra da casa',
      why: 'O catálogo escreve 188 grafias pra 40 fornecedores oficiais — o link peça → fornecedor destrava o lead time aprendido do Crew Chief (nome oficial batendo = certo, bulk resolve). MAP menor que o custo fere a lei do preço; source_type vazio ou discordando do is_kit é sujeira que confunde o cadeado.',
      items, impact: undefined,
    })
  }

  // INVENTORY · CATEGORIAS — vocabulário fechado (13). DC 1.42.0 (João, 8/set): «é óbvio,
  // não precisa de gente». Dois leitores (palavra-chave + IA) concordando = CERTA, o app
  // preenche sozinho com trilha e DESFAZER por 7 dias; discordando ou só um sabendo =
  // PERGUNTA com as duas opiniões; a IA dizendo «não é peça» = pilha própria.
  {
    const items: Item[] = []
    const vocab = linker.category_vocab.length ? linker.category_vocab : []
    const opts = (first: (string | null | undefined)[]) => { const f = first.filter((x): x is string => !!x && vocab.includes(x)); return [...f, ...vocab.filter(v => !f.includes(v))].map(v => ({ value: v, label: v })) }
    if (!linker.auto_fill_enabled && (linker.certain_ready || 0) > 0) items.push({
      href: '/parts', code: 'LIGAR', label: (linker.certain_ready || 0) + ' peça(s) com os dois leitores concordando — prontas pra entrar sozinhas', extra: 'primeira rodada só leu; LIGAR grava estas agora e, daqui em diante, toda peça nova em que palavra-chave e IA concordarem entra sem perguntar (com trilha e DESFAZER por 7 dias)',
      fix: { kind: 'enable_autofill' as const, table: 'parts_database', rowId: 'auto-fill', field: 'ENABLED', confirmText: 'Ligar o preenchimento sozinho? Grava agora as ' + (linker.certain_ready || 0) + ' categorias em que palavra-chave e IA concordam e, daqui em diante, faz o mesmo com toda peça nova. Tudo fica na trilha; cada uma tem DESFAZER por 7 dias.' },
    })
    // As preenchidas sozinhas NÃO ficam aqui (8/set: 408 SOZINHO contavam como pendência e o número não caía) — vivem no card verde «O app preencheu sozinho», com DESFAZER.
    for (const c of linker.categories) {
      const both = c.keyword && c.ai && c.ai !== 'NOT_A_PART' && c.keyword !== c.ai
      const code = c.tier === 'CERTAIN' ? 'CERTA' : c.tier === 'NOT_PART' ? 'NÃO É PEÇA' : c.tier === 'PENDING' ? 'IA PENDENTE' : c.current ? 'FORA VOC.' : both ? 'DISCORDAM' : 'SEM CAT.'
      const extra = c.tier === 'CERTAIN' ? 'palavra-chave e IA concordam: ' + c.keyword + ' — entra sozinha quando o preenchimento estiver LIGADO (ou um clique aqui)' : c.tier === 'NOT_PART' ? 'a IA diz que isto não é peça nem serviço (frete, placa, texto solto) — OTHER ou apague em PARTS'
        : both ? 'palavra-chave: ' + c.keyword + ' · IA: ' + c.ai + ' — os dois leitores discordam, você decide'
        : c.keyword && !c.ai ? 'só a palavra-chave palpita: ' + c.keyword + (c.tier === 'PENDING' ? ' — a IA ainda não leu' : ' — a IA não soube')
        : c.ai && c.ai !== 'NOT_A_PART' ? 'só a IA palpita: ' + c.ai + ' — sem palavra-chave; confirme'
        : 'nenhum leitor soube — escolha'
      items.push({
        href: '/parts', code, label: c.item + (c.current ? ' · hoje: "' + c.current + '"' : ''), extra,
        suggest: c.suggest || undefined, signal: c.tier === 'CERTAIN' ? 'matched' : c.suggest ? 'source' : undefined, certain: c.tier === 'CERTAIN',
        fix: vocab.length ? { kind: 'select' as const, table: 'parts_database', rowId: c.id, field: 'category', options: opts([c.ai && c.ai !== 'NOT_A_PART' ? c.ai : null, c.keyword, c.tier === 'NOT_PART' ? 'OTHER' : null]), current: c.current } : undefined,
      })
    }
    const pend = linker.category_ai_pending || 0
    checks.push({
      group: 'INVENTORY', key: 'parts-category', title: 'Peça sem categoria', blocks: 'ninguém acha a peça na hora de montar um pacote',
      why: 'Decisão de 24/ago (categoria fechada, 13 valores) + 8/set (João: «é óbvio, não precisa de gente»). Dois leitores independentes — a palavra-chave e a IA — concordando é PROVA: a categoria entra sozinha, com trilha, e aparece no card verde «O app preencheu sozinho» por 7 dias, com DESFAZER — aqui só fica o que ainda pede gente. Quando discordam, ou só um sabe, a pergunta traz as duas opiniões; «não é peça» é pilha própria.'
        + (linker.needs_category_ai_migration ? ' RODE MIGRATION_parts_category_ai.sql — sem ela só a palavra-chave palpita.' : pend ? ' A IA ainda vai ler ' + pend + ' peça(s) (roda sozinha ao abrir o Data Checker).' : ''),
      items,
    })
  }

  // INVENTORY · O QUE É ESTA LINHA? (04/set/2026) — "ensine as regras pro robô".
  // A pergunta que faltava ANTES de "chegou?": PEÇA, SERVIÇO, DIGITAL, ENCARGO ou
  // DINHEIRO. Sem ela, todo custo pago vira BOUGHT por construção e o STREAM
  // mostra uma wire de Demon 170 na mesma fila de um jogo de velas.
  // O ITEM aqui é o GRUPO DE FORNECEDOR, não a linha: é o agrupamento que torna
  // o trabalho finito (medido: um punhado de grupos cobre a maior parte das
  // linhas e quase todo o dinheiro — a rota recalcula e o card mostra). O corpo
  // do card é próprio (<NatureWorkbench>): 5 botões por grupo, exceção por linha.
  {
    const items: Item[] = []
    if (nature.needsMigration) items.push({ href: '/stream', code: 'MIGRATION', label: 'Rodar MIGRATION_item_nature.sql no SQL Editor', extra: 'a coluna nature (6 tabelas de item) e suppliers.default_nature ainda não existem' })
    else if (nature.state === 'error') items.push({ href: '/stream', code: 'SINAL', label: 'sinal de /api/item-nature indisponível — verificação NÃO rodou', extra: 'recarregue; enquanto isso o card não sabe o que falta' })
    else for (const g of nature.groups) items.push({
      href: '/stream', code: String(g.count), label: g.name, amount: g.amount,
      extra: g.default_nature ? `palpite gravado: ${NATURE_LABEL[g.default_nature]}` : g.supplier_id ? 'sem palpite — decida' : 'fornecedor só em texto (sem cadastro)',
    })
    checks.push({
      group: 'INVENTORY', key: 'item-nature', title: 'O que é esta linha? (fornecedor com linha sem natureza)',
      // O dinheiro vai no texto, NÃO em `impact`: impact alimenta o ranking
      // "maior valor parado" do COMECE AQUI, e US$ 2 milhões de linhas ainda não
      // classificadas afogariam pra sempre o balde e o caixa — que são dinheiro
      // REALMENTE parado. Aqui o valor é contexto, não urgência de caixa.
      blocks: `wire, imposto e tune ficam no BOUGHT como se fossem peça a caminho${nature.totals ? ` · ${usd(nature.totals.money)} sem resposta` : ''}`,
      why: 'Ordem do Márcio (04/set): "matemos o problema na raiz, não fazer remendo". PEÇA é a única que tem STREAM; NULL quer dizer "ninguém disse ainda" e CONTINUA APARECENDO, marcado A CLASSIFICAR — poluir custa um clique, sumir custa um carro parado. O fornecedor dá o PALPITE (suppliers.default_nature, que só pré-seleciona), a LINHA dá a resposta: Kramer tem 5 carros e 1 imposto, Texas Speed vende peça e cobra frete, HHP vende tune e vende vela. Por isso: classifique a EXCEÇÃO primeiro, o botão do grupo leva o resto.',
      items,
    })
  }

  // BANK · AUTO-BOOK (BL 0.8.0): o motor registrou sozinho? Rodada parada ou
  // errada, erros de 7 dias, ÓRFÃO (lançamento do motor sem linha casada →
  // PURGAR) e DUPLA (o humano lançou depois do banco → TROCAR).
  {
    const ab = bank.autobook
    if (ab && !ab.needs_migration) {
      const items: Item[] = []
      const last = ab.runs[0]
      const stale = !last || (Date.now() - Date.parse(last.started_at)) > 12 * 3600e3
      const when = (iso: string) => String(iso).slice(0, 16).replace('T', ' ')
      if (stale) items.push({ href: '/adm/check', code: 'MOTOR', label: last ? `última rodada ${when(last.started_at)} (${last.trigger}) — mais de 12 h sem rodar` : 'nenhuma rodada registrada ainda', extra: 'o cron 6/6h ou o webhook do Plaid não chamaram o autoBook — confira a Vercel' })
      else if (['ERROR', 'ABORTED'].includes(last.status)) items.push({ href: '/adm/check', code: 'MOTOR', label: `última rodada ${last.status} (${last.trigger}, ${when(last.started_at)})`, extra: (last.errors || [])[0] ? String(last.errors![0]).slice(0, 140) : `${last.remaining ?? 0} linhas ficaram pra próxima` })
      for (const e of ab.errors) items.push({ href: '/adm/check', code: 'ERRO', label: String(e).slice(0, 160), extra: 'erro do motor nos últimos 7 dias' })
      for (const o of ab.orphans) {
        if (o.table === 'expenses') {
          // ELO SOLTO: passagem da folha ligada (CASAR COM AJUSTE) a uma linha do banco que não a aponta mais.
          items.push({ href: '/staff', code: o.code === 'SUBSTITUÍDA' ? 'SUBSTITUÍDA' : 'ELO SOLTO', label: o.label || '', extra: o.code === 'SUBSTITUÍDA' ? 'a linha do banco foi trocada pelo Plaid; a nova casa esta passagem e limpa o elo velho sozinha na próxima rodada — não solte' : 'a passagem diz que foi casada com uma linha do banco, mas a linha não a aponta mais (DESFAZER, reset ou linha trocada) — SOLTAR limpa o elo e a passagem volta a poder casar; nada é apagado', amount: o.amount,
            fix: o.code === 'SUBSTITUÍDA' ? undefined : { kind: 'unlink' as const, table: 'expenses', rowId: o.id, field: 'bank_transaction_id', confirmText: `Soltar o elo da passagem «${o.label}» (${usd(o.amount)})? A linha do banco não aponta mais pra ela. Nada é apagado; a passagem volta ao pool.` } })
          continue
        }
        const oHref = o.table === 'inputs' ? '/supplies' : o.table === 'inventory' ? '/inventory' : o.table === 'invoice_expenses' ? '/adm/bank' : '/costs/fixed'
        if (o.code === 'SUBSTITUÍDA') { items.push({ href: oHref, code: 'SUBSTITUÍDA', label: o.label || '', extra: `a linha do banco foi trocada pelo Plaid (pending → posted); a linha nova vai casar este lançamento na próxima rodada — não apague · ${usd(o.amount)}`, amount: o.amount }); continue }
        items.push({
          href: oHref, code: 'ÓRFÃO', label: o.label || '', extra: `lançamento criado pelo motor sem linha do banco casada apontando pra ele — ${usd(o.amount)}`, amount: o.amount,
          fix: { kind: 'purge' as const, table: o.table, rowId: o.id, field: 'DELETED', confirmText: `Apagar o lançamento ÓRFÃO do motor "${o.label}" (${usd(o.amount)})? Nenhuma linha do banco aponta pra ele — é sobra de um DESFAZER ou de uma rodada que falhou. Fica na trilha.` },
        })
      }
      for (const x of ab.dups) items.push({
        href: x.auto_table === 'inputs' ? '/supplies' : x.auto_table === 'invoice_expenses' ? '/adm/bank' : '/costs/fixed', code: 'DUPLA', label: `${x.auto_label || ''} ⇄ ${x.twin_label || ''}`, extra: `o motor criou e um humano lançou o mesmo (${usd(x.amount)}, ${x.days} dia(s) de diferença) — TROCAR desfaz o do motor e casa a linha com o registro humano`, amount: x.amount,
        fix: { kind: 'rematch' as const, table: x.twin_table, rowId: x.twin_id, field: 'match', bankId: x.bank_id, confirmText: `DESFAZ o lançamento do motor "${x.auto_label}" e casa a linha do banco com o registro humano "${x.twin_label}" (${usd(x.amount)})?` },
      })
      // BALDE (fase B): ponteiro morto (linha do banco apontando pra registro apagado),
      // valor mudado pelo Plaid depois do lançamento, e PADRÃO que não pôde ser semeado.
      for (const x of ab.dead_pointers || []) items.push({
        href: '/adm/bank', code: 'PONTEIRO MORTO', label: x.label || '', extra: (x.table === 'expenses' || x.table === 'expense_group') ? `a linha do banco aponta pra passagem da folha que não existe mais — DESFAZER em A CONFERIR e refaça CASAR COM AJUSTE (o motor não recria folha) · ${usd(x.amount)}` : `a linha do banco aponta pra ${x.table} que não existe mais (alguém apagou no editor) — DESFAZER devolve a linha ao banco e o motor recria · ${usd(x.amount)}`, amount: x.amount,
        fix: { kind: 'unmatch' as const, table: x.table, rowId: x.id, field: 'match_status', bankId: x.bank_id, confirmText: `Devolver a linha do banco «${x.label}» (${usd(x.amount)}) a SEM CASAMENTO? O registro apontado já não existe; o motor recria na próxima rodada.` },
      })
      for (const x of ab.amount_drift || []) items.push({ href: '/adm/bank', code: 'VALOR MUDOU', label: x.label || '', extra: /folha ×/.test(String(x.label || '')) ? `as passagens da folha somam ${usd(x.row_amount)} e o banco cobrou ${usd(x.bank_amount)} (alguém editou depois do casamento) — DESFAZER em A CONFERIR e refaça CASAR COM AJUSTE` : `o Plaid corrigiu a linha pra ${usd(x.bank_amount)} depois do lançamento de ${usd(x.row_amount)} — DESFAZER na fila e deixe o motor recriar`, amount: Math.abs(x.bank_amount - x.row_amount) })
      for (const k of (ab.seed && ab.seed.skipped) || []) items.push({ href: '/adm/bank', code: 'PADRÃO', label: k, extra: 'regra padrão não semeada — fornecedor ambíguo ou ausente; nomeie o fornecedor certo no ⚙ do Bank Link (regra humana)' })
      const b24 = Object.values(ab.booked_24h || {}).reduce((s, v) => s + v, 0), b7 = Object.values(ab.booked_7d || {}).reduce((s, v) => s + v, 0)
      checks.push({
        group: 'BANK', key: 'auto-book', title: 'AutoBook Engine — rodou? errou? deixou sobras?', blocks: 'linhas novas do banco ficam sem dono e o DRE atrasa',
        why: `Desde ${ab.floor} cada linha nova do banco é REGISTRADA pelo motor depois do sync (cron 6/6h + webhook), uma rodada por vez. Registradas: ${b24} nas últimas 24 h · ${b7} em 7 dias · ${ab.remaining} NEW restantes desde o piso. RULE/LEARN esperam 7 dias de maturidade (o humano ainda lança atrasado) — daí a DUPLA: quando o humano lança depois do banco, TROCAR desfaz o do motor e casa o humano. ÓRFÃO = lançamento do motor sem linha casada (sobra de DESFAZER ou falha): PURGAR. Tudo desfazível no Bank Link (A CONFERIR · DESFAZER LOTE).`,
        items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
      })
    }
  }
  // BANK · A ATRIBUIR (fase B): compra sem dono há mais de 7 dias. O balde é conta
  // de suspensão — caixa e DRE certos no dia, mas a margem do carro mente até o
  // dono ser dito. Cada item atribui na hora pela rota do Bank Link (o servidor
  // acha a linha do banco pelo row_id).
  if (Array.isArray(d.bucket)) {
    const rows = d.bucket as any[]
    const total = rows.reduce((s, e) => s + expLine(e), 0)
    // Idade = desde que ENTROU no balde (created_at), não a data do banco: o backlog de nov/2025
    // varrido em 4/set entrou há dias, não há meses — a missão gritava urgência falsa (8/set).
    const entry = (e: any) => String(e.created_at || e.payment_date || '').slice(0, 10)
    const ages = rows.map(e => entry(e) ? dayDiff(TODAY, entry(e)) : 0)
    const maxAge = ages.length ? Math.max(...ages) : 0
    // POR FORNECEDOR, com a sugestão da fila (afinidade de carro) e as invoices FECHADAS (82% das
    // compras são de carros já fechados — DC 1.44.0). «Qual carro» continua decisão de gente.
    const invs = bucketSig.state === 'ok' && bucketSig.invoices.length ? bucketSig.invoices : d.invoices.filter((i: any) => !i.is_quote && i.ride_id && i.origin !== 'BUCKET').map((i: any) => { const r = d.rides.get(i.ride_id); return { id: i.id, code: i.invoice_code, ride_code: r?.project_code || '', ride_name: r?.project_name || '', closed: i.live_status === 'CLOSED' } })
    const openOpts = invs.filter(i => !i.closed).sort((a, b) => a.ride_code.localeCompare(b.ride_code)).map(i => ({ value: i.id, label: `${i.ride_code} — ${i.ride_name} · ${i.code}` }))
    const closedOpts = invs.filter(i => i.closed).sort((a, b) => a.ride_code.localeCompare(b.ride_code)).map(i => ({ value: i.id, label: `${i.ride_code} — ${i.ride_name} · ${i.code} (FECHADA)` }))
    const options = [...openOpts, { value: '__stock__', label: '📦 ESTOQUE (vira inventário)' }, { value: '__supplies__', label: '🧴 SUPPLIES (insumo CONSUMPTION)' }, ...closedOpts]
    const items: Item[] = rows.filter(e => entry(e) && dayDiff(TODAY, entry(e)) > 7).sort((a, b) => String(a.supplier || '').localeCompare(String(b.supplier || '')) || entry(a).localeCompare(entry(b))).map(e => {
      const sg = bucketSig.sug.get(String(e.id))
      return {
        href: '/adm/bank', code: String(e.supplier || 'SEM DONO').slice(0, 14).toUpperCase(), label: [e.supplier, String(e.item || '').replace('(a atribuir · Bank Link)', '').trim()].filter(Boolean).join(' · '), when: e.payment_date, extra: `${dayDiff(TODAY, entry(e))} dias no balde (entrou ${entry(e)} · compra de ${String(e.payment_date || '').slice(0, 10)})` + (sg ? ` · a fila sugere ${sg.car} (${sg.why})` : ''), amount: expLine(e),
        suggest: sg && sg.score >= 60 ? sg.invoice_id : undefined, signal: sg && sg.score >= 60 ? 'source' : undefined,
        link: { href: `${BASE_PATH}/adm/bank#a-atribuir`, label: 'FILA ↗' },
        fix: { kind: 'select' as const, table: 'invoice_expenses', rowId: e.id, field: 'invoice_id', current: null, options },
      }
    })
    checks.push({
      group: 'BANK', key: 'bucket-aging', title: 'Compra sem dono há mais de 7 dias (A ATRIBUIR)', blocks: 'a margem do carro mente e o CPV carrega custo sem dono',
      why: `O motor registra toda compra do banco no mesmo dia — quando nenhuma regra sabe o dono, ela cai no balde «Compras a atribuir» (caixa e DRE certos na hora). Balde hoje: ${rows.length} compras · ${usd(total)} · mais antiga ${maxAge} d. Aqui só entra o que passou de 7 dias; a fila A ATRIBUIR do Bank Link tem CARRO (sugestões por fornecedor), ESTOQUE, SUPPLIES, FIXO e DIVIDIR — SUPPLIES e FIXO ensinam regra. O balde tem que zerar toda semana.`,
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
    // Balde fora do padrão: a pseudo-invoice A ATRIBUIR tem que ser UMA, sem carro,
    // sem cliente, nunca quote, nunca REALTIME/CLOSED (senão HOME/FUTURE/clientes contam).
    const inv = d.bucketInvoice
    const bad: Item[] = []
    if (!inv) bad.push({ href: '/adm/bank', code: 'SEM BALDE', label: 'invoice A ATRIBUIR não existe', extra: 'rode MIGRATION_auto_book_phase_b.sql no SQL Editor (US)' })
    else {
      if (inv.client_id) bad.push({ href: '/adm/bank', code: 'CLIENTE', label: 'a invoice do balde tem cliente', extra: 'apareceria na lista de compras de um cliente — rode MIGRATION_auto_book_phase_b.sql de novo (auto-cura) ou zere client_id no SQL Editor' })
      if (inv.ride_id) bad.push({ href: '/adm/bank', code: 'CARRO', label: 'a invoice do balde tem carro', extra: 'o balde nunca pertence a um ride — rode MIGRATION_auto_book_phase_b.sql de novo (auto-cura) ou zere ride_id no SQL Editor' })
      if (inv.is_quote) bad.push({ href: '/adm/bank', code: 'QUOTE', label: 'a invoice do balde virou quote', extra: 'quote sai de todos os números — o balde sumiria do DRE', fix: { kind: 'flag' as const, table: 'invoices', rowId: inv.id, field: 'is_quote', value: false, confirmText: 'Voltar a invoice A ATRIBUIR a NÃO-quote?' } })
      if (['REALTIME', 'CLOSED'].includes(String(inv.live_status))) bad.push({ href: '/adm/bank', code: 'STATUS', label: `live_status ${inv.live_status}`, extra: 'REALTIME/CLOSED entram na HOME, no FUTURE e nos relatórios — o balde tem que ficar INCOMPLETE', fix: { kind: 'select' as const, table: 'invoices', rowId: inv.id, field: 'live_status', current: inv.live_status, options: [{ value: 'INCOMPLETE', label: 'INCOMPLETE' }] } })
      if (inv.invoice_code !== 'A ATRIBUIR') bad.push({ href: '/adm/bank', code: 'CÓDIGO', label: `invoice_code ${inv.invoice_code}`, extra: 'o nome do balde é A ATRIBUIR' })
    }
    for (const e of rows) {
      const why = !e.payment_date ? 'sem payment_date' : String(e.paid_from || '') !== 'GZ28US' ? 'paid_from ≠ GZ28US' : !e.purchase_group ? 'sem elo com o banco (purchase_group)' : expLine(e) === 0 ? 'valor zero' : null
      if (why) bad.push({ href: '/adm/bank', code: 'LINHA', label: [e.supplier, e.item].filter(Boolean).join(' · '), extra: why + ' — o motor não escreve assim; alguém editou', amount: expLine(e), link: { href: `${BASE_PATH}/adm/bank#a-atribuir`, label: 'FILA ↗' } })
    }
    checks.push({ group: 'BANK', key: 'bucket-invariants', title: 'Balde fora do padrão (invoice A ATRIBUIR)', blocks: 'o balde vazaria pra HOME, clientes ou relatórios', why: 'A pseudo-invoice A ATRIBUIR é UMA só, sem cliente, sem carro, nunca quote, sempre INCOMPLETE; cada linha do balde tem a data do banco, paid_from GZ28US e o elo purchase_group. Fora disso, o balde contamina outros números.', items: bad, impact: bad.reduce((s, i) => s + (i.amount || 0), 0) })
  }
  // ── O APP PREENCHEU SOZINHO (DC 1.44.0): tudo que entrou sem clique nos últimos 7 dias, com DESFAZER ──
  {
    const KEY_LABEL: Record<string, string> = { 'paid-from': 'QUEM PAGOU', 'parts-suppliers': 'FORNECEDOR', 'parts-category': 'CATEGORIA', 'item-nature': 'NATUREZA', 'admission-mileage': 'MILHAGEM', 'sub-ended-scheduled': 'ASSINATURA', 'bank-drift': 'ADOTADA', 'paid-no-bank': 'CASADA', 'bank-auto': 'BANCO', 'sub-reopen': 'REABERTO', 'inputs-category': 'INSUMO' }
    const items: Item[] = auto.state === 'error' ? [{ href: '/adm/check', code: 'SINAL', label: 'sinal de /api/data-check/auto indisponível — a lista do que o app fez sozinho NÃO carregou', extra: 'recarregue' }]
      : auto.rows.map(a => ({
        href: a.table_name === 'bank_transactions' ? '/adm/bank' : a.table_name === 'parts_database' ? '/parts' : a.table_name === 'rides' ? '/rides/edit/' + a.row_id : a.table_name === 'fixed_cost_expenses' ? '/costs/fixed' : a.table_name === 'invoice_expenses' ? '/invoices' : '/adm/check',
        code: KEY_LABEL[a.check_key] || a.check_key.toUpperCase(), when: String(a.fixed_at).slice(0, 10),
        label: String(a.label || '').replace(/^AUTO · /, ''), extra: (a.field === 'DELETED' ? 'linha apagada (com foto — DESFAZER recria)' : `${a.field}: ${a.old_value ?? 'vazio'} → ${a.new_value ?? 'vazio'}`) + ' · ' + String(a.fixed_at).slice(0, 16).replace('T', ' '),
        fix: a.table_name === 'bank_transactions' ? undefined : { kind: 'undo_auto' as const, table: a.table_name, rowId: a.row_id, field: a.field, fixId: a.id, confirmText: `Desfazer «${String(a.label || '').replace(/^AUTO · /, '').slice(0, 90)}»? ${a.field}: volta a ${a.old_value ?? 'vazio'}. Fica na trilha.` },
        link: a.table_name === 'bank_transactions' ? { href: BASE_PATH + '/adm/bank', label: 'DESFAZER em A CONFERIR ↗' } : undefined,
      }))
    const cut = auto.state === 'ok' && auto.total != null && auto.total > auto.rows.length ? ` · mostrando as ${auto.rows.length.toLocaleString('en-US')} mais recentes de ${auto.total.toLocaleString('en-US')}` : ''
    checks.push({ group: 'FINANCIAL', key: 'auto-fills', good: true, title: 'O app preencheu sozinho (7 dias)', blocks: 'notícia boa, não pendência: cada linha tem a prova e DESFAZER por 7 dias — confira quando quiser' + cut, why: 'Lei de 8/set (João): o app age sozinho onde há PROVA — dois leitores concordando, identidade dura, hábito unânime, o banco como testemunha — e só pergunta o que é decisão de gente. Cada escrita sem clique aparece aqui por 7 dias com DESFAZER; casamentos do banco se desfazem em A CONFERIR.', items })
  }
  // ── TAX · IMPOSTO FL COBRADO, RECOLHIMENTO NÃO LANÇADO (DC 1.44.0, levantamento de 8/set) ──
  {
    const items: Item[] = []
    for (const i of d.invoices) {
      if (i.is_quote || i.origin === 'BUCKET' || i.live_status !== 'CLOSED' || !(Number(i.florida_taxes) > 0) || i.fl_tax_expense_date) continue
      // florida_taxes é ALÍQUOTA (%), não dinheiro: o imposto cobrado é o que invoiceTotals calcula (parts × alíquota).
      const tax = Math.round((Number(invoiceTotals(d, i).flTax) || 0) * 100) / 100
      if (tax < 0.005) continue
      const ref = String(i.conclusion_date || i.delivery_date || '').slice(0, 10)
      // Sugestão: uma saída da Regions pro FL Dept. of Revenue com o mesmo valor até 60 dias depois da conclusão.
      const dor = bank.lines.filter(x => /FL DEPT|FLORIDA DEPT|DEPT OF REV|DEPARTMENT OF REVENUE|FLDOR|FL DOR|MYFLORIDA/i.test(x.n) && Math.abs(x.a - tax) < 0.011 && (!ref || (x.d >= ref && dayDiff(x.d, ref) <= 60)))
      const r = d.rides.get(i.ride_id)
      items.push({
        href: i.ride_id ? `/rides/${i.ride_id}/invoices/${i.id}` : '/invoices', code: i.invoice_code || '—', when: ref || undefined,
        label: `${r?.project_code || ''} ${r?.project_name || ''} · ${i.invoice_code} · imposto FL ${usd(tax)}`.trim(),
        extra: dor.length === 1 ? `a Regions pagou o FL Dept. of Revenue em ${dor[0].d} (${usd(dor[0].a)}) — grave a data` : 'invoice fechada com imposto cobrado do cliente e nenhuma data de recolhimento (DR-15 vence dia 20 do mês seguinte) — confirme com a Drummond',
        amount: tax, suggest: dor.length === 1 ? dor[0].d : undefined, signal: dor.length === 1 ? 'matched' : undefined,
        fix: { kind: 'date' as const, table: 'invoices', rowId: i.id, field: 'fl_tax_expense_date' },
      })
    }
    checks.push({ group: 'TAX', key: 'fl-sales-tax', title: 'Imposto FL cobrado do cliente, recolhimento não lançado', blocks: 'o Sales Tax cobrado vira dívida com o estado; sem a data de recolhimento o app não sabe se foi pago', why: 'Toda invoice fechada com florida_taxes > 0 cobrou imposto do cliente; o recolhimento ao estado (DR-15, dia 20 do mês seguinte) tem que existir e ter data. O app só lista e sugere quando acha a saída pro FL Dept. of Revenue na Regions — quem confirma é a Drummond.', items, impact: items.reduce((s, x) => s + (x.amount || 0), 0) })
  }
  // ── SILÊNCIO (BL 0.10.0 · DC 1.40.0): «silêncio é promessa de que está tudo certo» (João, 4/set) ──
  // Nada fica parado calado: o que o motor não resolveu vira pergunta com motivo e
  // resposta de um clique; o que está certo mas fora do padrão também aparece.
  {
    const ab2 = bank.autobook
    if (ab2 && !ab2.needs_migration) {
      // Sinal que FALHOU não é sinal verde: os três cards mostram SINAL em vez de «nada pendente».
      const sigErr = ab2.silence_error || (ab2.questions === null ? 'o bloco do silêncio não respondeu' : null)
      const sinal: Item[] = sigErr ? [{ href: '/adm/bank', code: 'SINAL', label: 'o sinal do motor falhou — ' + sigErr, extra: 'sem sinal não há promessa: este card não sabe se está tudo certo; recarregue ou veja o card AUTO-BOOK', link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' } }] : []
      // PAGA NO BANCO, ABERTA NO APP — deriva das três datas (X vencimento, Y banco, Z registro).
      const dr = ab2.drift || []
      const di: Item[] = dr.map(x => ({
        href: '/costs/fixed/' + (x.supplier_id || ''), code: x.ambiguous ? 'AMBÍGUA' : x.late_fee ? 'MULTA' : 'DERIVA',
        label: x.supplier + ' · vence ' + x.due + ' · banco pagou ' + x.bank_date + ' (' + (x.days >= 0 ? '+' : '') + x.days + ' d)',
        extra: x.ambiguous ? 'duas contas iguais em aberto e UMA linha no banco — o motor não chuta: diga qual é (a outra segue a pagar)' : 'o app diz «a pagar» há ' + x.overdue_days + ' d; o banco já pagou — ADOTAR grava a data do banco e o elo (o vencimento fica na trilha)',
        amount: x.amount, signal: !x.ambiguous && x.name_ok && x.unique ? 'matched' : x.bank_status === 'QUEUED' ? 'TO BOOK' : undefined, certain: !x.ambiguous && !!x.name_ok && !!x.unique,
        link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' },
        fix: x.ambiguous ? undefined : { kind: 'adopt' as const, table: 'fixed_cost_expenses', rowId: x.row_id, field: 'payment_date', bankId: x.bank_id, confirmText: 'Adotar: a agendada de ' + x.supplier + ' (' + x.due + ', ' + usd(x.amount) + ') foi paga no banco em ' + x.bank_date + '? A linha do banco casa com ela; payment_date = ' + x.bank_date + '; DESFAZER no Bank Link volta tudo.' },
      }))
      checks.push({ group: 'BANK', key: 'bank-drift', title: 'Paga no banco, aberta no app (deriva das três datas)', blocks: 'multa e juros falsos no card de vencidas; DRE do mês errado; a conta parece atrasada quando o dinheiro já saiu', why: 'Toda conta tem três datas: X (vencimento, a promessa), Y (banco, o fato) e Z (registro no app). O motor iguala Z a Y — mas a agendada aberta ninguém adota sozinho. Aqui o banco já pagou (mesmo valor, no vencimento ou até 40 d depois) e o app ainda diz «a pagar». ADOTAR fecha; AMBÍGUA pergunta qual das duas.', items: sigErr ? sinal : di, impact: [...new Map(dr.map(x => [x.bank_id, x.amount])).values()].reduce((t, a) => t + a, 0) })   // impacto por LINHA do banco (a AMBÍGUA tem duas contas e um pagamento)
      // PERGUNTAS DO MOTOR — o que está parado NÃO está certo: está perguntando.
      const q = ab2.questions || { suppliers: 0, supplier_total: 0, money: 0, twins: 0, caps: 0, maturity: 0, other: 0, lines: 0 }
      {
        const qi: Item[] = []
        if (q.suppliers) qi.push({ href: '/adm/bank', code: 'FORNECEDOR', label: q.suppliers + ' fornecedor(es) sem regra · ' + usd(q.supplier_total), extra: 'quem é X pra nós? — FIXO (prestador), SUPPLIES, BALDE, PESSOAL (season) ou IGNORAR; uma resposta lança todas as linhas do fornecedor, hoje e sempre', amount: q.supplier_total, link: { href: BASE_PATH + '/adm/check#perguntas', label: 'RESPONDER ↗' } })
        if (q.money) qi.push({ href: '/adm/bank', code: 'DINHEIRO', label: q.money + ' linha(s) de dinheiro andando (transferência, wire, Zelle, entrada)', extra: 'o motor nunca chuta dinheiro-movimento: qual invoice, sócio ou conta? — escolha o candidato no Bank Link', link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' } })
        if (q.twins) qi.push({ href: '/adm/bank', code: 'GÊMEO', label: q.twins + ' linha(s) com gêmeo provável no app', extra: 'o motor achou um registro parecido (nome + valor na faixa) e parou: «é este?» — SIM casa, NÃO libera o motor pra lançar', link: { href: BASE_PATH + '/adm/bank', label: 'DECIDIR ↗' } })
        if (q.caps) qi.push({ href: '/adm/bank#a-atribuir', code: 'TETO', label: q.caps + ' linha(s) acima do teto da regra', extra: 'a regra entendeu o fornecedor mas o valor passou do teto; a linha vai pro balde com o motivo assim que madura — FIXO/CARRO na fila', link: { href: BASE_PATH + '/adm/bank#a-atribuir', label: 'FILA ↗' } })
        if (q.other) qi.push({ href: '/adm/bank', code: 'OUTRO', label: q.other + ' linha(s) paradas por outro motivo (feed duplicado, sem regra, sem classe)', extra: 'veja o chip de dúvida em cada linha no Bank Link', link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' } })
        checks.push({ group: 'BANK', key: 'engine-questions', title: 'Perguntas do motor (nada fica parado calado)', blocks: 'cada linha parada é um custo fora do DRE e uma promessa falsa de que está tudo certo', why: 'Lei da casa (4/set/2026): silêncio significa que está TUDO certo. O que o motor não resolve vira pergunta com motivo e resposta de um clique — por fornecedor, não por categoria.' + (q.maturity ? ' ' + q.maturity + ' linha(s) só esperam a maturidade de 7 dias (o humano ainda lança atrasado) — não contam aqui.' : ''), items: sigErr ? sinal : qi, impact: q.supplier_total || 0 })
      }
      // FORA DO PADRÃO (FINANCIAL): gasto do mês muito acima da média + linha quicando entre decisões.
      const an = ab2.anomalies || [], bo = ab2.bounce || []
      const fi: Item[] = [
        ...an.map(a => ({ href: '/costs/fixed/' + a.supplier_id, code: 'PICO', label: a.supplier + ' · ' + a.month + ' · ' + usd(a.current) + ' vs média ' + usd(a.avg3) + ' (×' + a.ratio + ')', extra: 'o mês passou de 2× a média dos 3 anteriores — conta dobrada, lançamento duplicado ou reajuste? confira antes de fechar o mês', amount: a.current })),
        ...bo.map(b => ({ href: '/adm/bank', code: 'QUICANDO', label: 'linha ' + b.bank_id.slice(0, 8) + ' casada ' + b.n + '× em 14 dias', extra: 'casa, desfaz, casa de novo — o motor e alguém discordam; decida uma vez e ensine a regra', link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' } })),
      ]
      checks.push({ group: 'FINANCIAL', key: 'out-of-pattern', title: 'Fora do padrão (pico de gasto · linha quicando)', blocks: 'um número estranho passa pro DRE sem ninguém olhar', why: 'O que é certo mas fora do padrão também merece pergunta: um prestador que custou o dobro este mês, uma linha que muda de dono toda semana. Sem correção automática — só a pergunta, com o link.', items: sigErr ? sinal : fi, impact: an.reduce((t, a) => t + a.current, 0) })
    }
    // PAGA NO APP, SEM BANCO — custo fixo «pago pela GZ28US» sem linha da Regions atrás.
    const fxs: any[] = (d as any).fixedExpenses || []
    const supMap: Map<string, any> = (d as any).fixedSuppliers instanceof Map ? (d as any).fixedSuppliers : new Map()
    const supName = new Map<string, string>([...supMap.values()].map((x: any) => [x.id, String(x.company || '')]))
    // Só com o sinal ?matched=1 vivo (sem ele o Set é vazio e TUDO viraria pergunta); só paid_from GZ28US
    // (sem origem é o card de paid_from); 3 dias de maturidade (a linha do banco posta em 1–3 dias).
    const cutoff3 = new Date(Date.parse(TODAY) - 3 * 864e5).toISOString().slice(0, 10)
    const pn: Item[] = matched.size === 0 ? [{ href: '/adm/bank', code: 'SINAL', label: 'sem o sinal do Bank Link (?matched=1) este card não sabe', extra: 'recarregue; se persistir, veja o card AUTO-BOOK' }] : fxs.filter((e: any) => e.payment_date && String(e.payment_date).slice(0, 10) >= REGIONS_OPENED && String(e.payment_date).slice(0, 10) <= cutoff3 && !e.bank_transaction_id && !matched.has('fixed_cost_expenses:' + e.id) && e.paid_from === 'GZ28US')
      .sort((a: any, b: any) => String(b.payment_date).localeCompare(String(a.payment_date)))
      .map((e: any) => {
        // PROVA (DC 1.44.0): UMA linha NEW da Regions com o valor exato, o nome do prestador e ±10 d — o casamento faltou, não o pagador.
        const amt = Math.abs(Number(e.amount) || 0), pd = String(e.payment_date).slice(0, 10)
        const toks = nameTok(supName.get(e.supplier_id) || '')
        // Nome por PALAVRA INTEIRA (APPLE não é APPLEBEES; DUKE não é DUKES BBQ).
        const cands = toks.length ? bank.lines.filter(x => { if (x.s !== 'NEW' || Math.abs(x.a - amt) >= 0.011 || dayDiff(x.d, pd) > 10) return false; const lt = new Set(nameTok(x.n)); return toks.some(t => lt.has(t)) }) : []
        const one = cands.length === 1 ? cands[0] : null
        return { href: '/costs/fixed/' + (e.supplier_id || ''), code: one ? 'CASAR' : e.paid_from ? 'GZ28US' : 'SEM ORIGEM', label: (supName.get(e.supplier_id) || '?') + ' · ' + pd + ' · ' + String(e.description || '').slice(0, 60), extra: one ? `a Regions tem exatamente uma linha ${one.d} ${usd(one.a)} «${one.n}» — o casamento faltou` : cands.length > 1 ? `${cands.length} linhas da Regions batem — escolha no Bank Link` : 'pago «pela GZ28US» mas nenhuma linha da Regions casa — pagou de outra conta (sócio? BR?) ou o casamento não foi feito', amount: amt, certain: !!one, signal: one ? 'matched' : undefined, suggest: one ? one.id : undefined, link: { href: BASE_PATH + '/adm/bank', label: 'BANK LINK ↗' },
          fix: one ? { kind: 'match' as const, table: 'fixed_cost_expenses', rowId: e.id, field: 'bank_transaction_id', bankId: one.id, confirmText: `Casar «${String(e.description || '').slice(0, 60)}» com a linha da Regions ${one.d} ${usd(one.a)} «${one.n}»? Fica em A CONFERIR com DESFAZER.` } : undefined }
      })
    checks.push({ group: 'BANK', key: 'paid-no-bank', title: 'Paga no app, sem linha no banco', blocks: 'o caixa da Regions e o DRE contam dinheiro que talvez saiu de outro bolso (sócio = empréstimo, BR = intercompany)', why: 'Desde 2025-11-10 tudo que a GZ28US paga sai da Regions. Um custo fixo pago «pela GZ28US» sem linha casada é um de dois erros: paid_from errado (foi um sócio ou a BR) ou casamento faltando. Sem correção automática — a prova mora no extrato.', items: pn, impact: pn.reduce((t, i) => t + (i.amount || 0), 0) })
  }
  return checks
}

// ── A BANCADA DA NATUREZA — "ensine as regras pro robô" (Márcio, 04/set/2026) ─
// O corpo próprio deste card existe por um motivo só: aqui a unidade de trabalho
// é o GRUPO DE FORNECEDOR, não a linha. Linha a linha são mais de mil decisões e
// ninguém começa; por fornecedor são algumas dezenas e o fim aparece na tela.
//
// As três leis que este componente não pode quebrar:
//   1. O botão do grupo só pega as linhas QUE SOBRARAM — a exceção sai antes,
//      classificada uma a uma ("ver as N linhas"). É o caso Kramer: 5 linhas de
//      carro (DINHEIRO) e uma de "Taxes & Fees" (ENCARGO) no mesmo fornecedor.
//   2. O palpite (suppliers.default_nature) PRÉ-SELECIONA e nada mais. Ele nunca
//      escreve em linha nenhuma sozinho — o anel branco no botão é sugestão.
//   3. Toda escrita vai pela rota /api/item-nature: é lá que mora a trava
//      .is('nature', null) (regra pode PÔR, nunca TIRAR) e a trilha data_fixes.
// ── O PAINEL DO AUTOBOOK ENGINE — corpo próprio do card (João, 8/set/2026: «parece uma
// lista de issues que não dá pra ler»). Três andares, em português de gente:
//   1. SAÚDE — rodou? quando? errou? quanto registrou sozinho (24 h / 7 d, por motor).
//   2. SOBRAS por FAMÍLIA — cada família recolhida, com «o que é» e «o que fazer» numa
//      linha; dentro, as linhas com o botão (PURGAR / TROCAR / DESFAZER) que já existia.
//   3. VAZIO honesto — quando não sobrou nada, diz isso com os números (lei do silêncio:
//      silêncio é promessa; aqui a promessa vem escrita).
// Os itens continuam os mesmos (missões e contadores não mudam); só a leitura muda.
const AB_ENGINE: Record<string, string> = { RULE: 'por regra', BUCKET: 'no balde', EXACT: 'casadas', NAME: 'pelo nome', FEE: 'tarifas', LEARN: 'aprendidas', TRANSFER: 'transferências', SET: 'em série' }
const AB_FAMILIES: { codes: string[]; title: string; what: string; action: string; tone: string }[] = [
  { codes: ['MOTOR', 'ERRO'], title: 'O motor parou ou errou', what: 'o cron (6/6 h) ou o webhook do Plaid não chamaram o motor, ou a rodada terminou em erro', action: 'confira a Vercel e o erro; até voltar, as linhas novas ficam sem dono', tone: 'border-red-800 bg-red-950/40 text-red-300' },
  { codes: ['ÓRFÃO'], title: 'Lançamento do motor sem linha do banco', what: 'sobra de um DESFAZER ou de uma rodada que falhou no meio — nenhuma linha do banco aponta pra ele', action: 'PURGAR apaga (fica na trilha)', tone: 'border-amber-800 bg-amber-950/40 text-amber-300' },
  { codes: ['SUBSTITUÍDA'], title: 'Linha trocada pelo Plaid (pending → posted)', what: 'o banco trocou o id da linha ao postar; a linha nova casa este lançamento na próxima rodada', action: 'nada — não apague', tone: 'border-gray-700 bg-gray-900 text-gray-300' },
  { codes: ['DUPLA'], title: 'O motor e uma pessoa lançaram a mesma compra', what: 'alguém lançou à mão depois que o banco já tinha lançado', action: 'TROCAR desfaz o do motor e casa a linha com o registro humano', tone: 'border-amber-800 bg-amber-950/40 text-amber-300' },
  { codes: ['PONTEIRO MORTO'], title: 'A linha do banco aponta pra um registro apagado', what: 'alguém apagou no editor o lançamento que o motor tinha criado', action: 'DESFAZER devolve a linha ao banco; o motor recria', tone: 'border-amber-800 bg-amber-950/40 text-amber-300' },
  { codes: ['VALOR MUDOU'], title: 'O Plaid corrigiu o valor depois do lançamento', what: 'o valor da linha do banco mudou e o lançamento ficou com o valor antigo', action: 'DESFAZER na fila A ATRIBUIR e deixe o motor recriar', tone: 'border-amber-800 bg-amber-950/40 text-amber-300' },
  { codes: ['ELO SOLTO'], title: 'Passagem da folha com elo solto', what: 'a passagem diz que foi casada com uma linha do banco, mas a linha não a aponta mais (DESFAZER, reset ou linha trocada)', action: 'SOLTAR limpa o elo (nada é apagado) — a passagem volta a poder casar', tone: 'border-amber-800 bg-amber-950/40 text-amber-300' },
  { codes: ['PADRÃO'], title: 'Regra padrão esperando um prestador', what: 'a regra conhece o comerciante mas não achou o cadastro do prestador pra apontar', action: 'crie o prestador em Custos Fixos (ou nomeie no ⚙ do Bank Link) — a regra nasce na próxima rodada', tone: 'border-purple-800 bg-purple-950/40 text-purple-300' },
]
// «def:saas:microsoft: 0 fornecedores batem» → «Microsoft · assinatura (APP) — nenhum prestador com esse nome»
function padraoLabel(k: string): string {
  const m = /^def:([a-z-]+)(?::([a-z0-9-]+))?/i.exec(k)
  if (!m) return k
  const fam = m[1] === 'saas' ? 'assinatura (APP)' : m[1]
  const name = (m[2] || m[1]).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const cnt = /(\d+) fornecedores/.exec(k)
  const n = cnt ? parseInt(cnt[1], 10) : NaN
  return name + ' · ' + fam + (n === 0 ? ' — nenhum prestador com esse nome: crie em Custos Fixos' : n >= 2 ? ' — ' + n + ' prestadores batem: escolha ou funda, e nomeie no ⚙' : /ambígu/i.test(k) ? ' — mais de um prestador bate, escolha' : ' — ' + k.replace(/^def:[^:]+(?::[^:]+)?:?\s*/, ''))
}
function AutoBookBoard({ ab, check, saving, done, onFix }: { ab: AutoBookSignal; check: Check; saving: boolean; done: Set<string>; onFix: (check: Check, item: Item) => void }) {
  const [openSec, setOpenSec] = useState<string | null>(null)
  const last = ab.runs[0]
  const now = Date.now()
  const stamp = (iso: string) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' (Orlando)' } catch { return String(iso).slice(0, 16).replace('T', ' ') } }
  const stale = !last || now - Date.parse(last.started_at) > 12 * 3600e3
  const bad = !!last && ['ERROR', 'ABORTED'].includes(last.status)
  const runs7 = ab.runs.filter(r => now - Date.parse(r.started_at) <= 7 * 864e5)
  const runs7n = ab.runs_7d ? ab.runs_7d.n : runs7.length
  const errs7 = ab.runs_7d ? ab.runs_7d.errors : runs7.filter(r => ['ERROR', 'ABORTED'].includes(r.status) || (Array.isArray(r.errors) && r.errors.length)).length
  const total = (m: Record<string, number> | undefined) => Object.values(m || {}).reduce((s, v) => s + v, 0)
  const say = (m: Record<string, number> | undefined) => Object.entries(m || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + ' ' + (AB_ENGINE[k] || k.toLowerCase())).join(' · ')
  const healthy = !stale && !bad && errs7 === 0 && (ab.errors || []).length === 0
  const fams = AB_FAMILIES.map(f => ({ ...f, items: check.items.filter(it => f.codes.includes(it.code)) })).filter(f => f.items.length)
  const leftover = fams.reduce((s, f) => s + f.items.length, 0)
  const b24 = total(ab.booked_24h), b7 = total(ab.booked_7d)
  return (
    <div className="space-y-3">
      <div className={'rounded-2xl border px-4 py-3 ' + (healthy ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-800 bg-red-950/30')}>
        <p className="font-bold">{healthy ? '● Motor vivo' : stale ? '● Motor parado' : '● Motor com erro'}<span className="text-xs text-gray-400 font-normal ml-3">{last ? 'última rodada ' + stamp(last.started_at) + ' (' + last.trigger + ', ' + last.status + ')' : 'nenhuma rodada registrada'} · {runs7n} rodada(s) em 7 dias{errs7 ? ', ' + errs7 + ' com erro' : ', nenhuma com erro'}{ab.remaining ? ' · ' + ab.remaining + ' linha(s) ainda sem decisão' : ''}</span></p>
        <p className="text-xs text-gray-300 mt-1">Registrou sozinho: <b>{b24}</b> linha(s) nas últimas 24 h{b24 ? ' (' + say(ab.booked_24h) + ')' : ''} · <b>{b7}</b> em 7 dias{b7 ? ' (' + say(ab.booked_7d) + ')' : ''}{ab.bucket ? ' · balde: ' + ab.bucket.total + ' compra(s) a atribuir, ' + usd(ab.bucket.balance) + (ab.bucket.older_7d ? ', ' + ab.bucket.older_7d + ' com 7+ dias' : '') : ''}</p>
      </div>
      {leftover === 0 ? (
        <p className="text-emerald-400 font-bold">Nenhuma sobra: o motor rodou, registrou e não deixou órfão, dupla, ponteiro morto nem valor mudado.</p>
      ) : fams.map(f => {
        const key = f.codes[0]
        const amt = f.items.reduce((s, it) => s + (it.amount || 0), 0)
        const isOpen = openSec === key
        const border = f.tone.split(' ').filter(c => c.startsWith('border')).join(' ')
        return (
          <div key={key} className={'rounded-2xl border bg-gray-900 ' + border}>
            <button onClick={() => setOpenSec(isOpen ? null : key)} className="w-full text-left px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className={'px-2 py-0.5 rounded-full text-[10px] font-bold border ' + f.tone}>{f.items.length}</span>
              <span className="font-bold flex-1">{f.title}{amt ? <span className="text-gray-500 font-normal text-sm"> · {usd(amt)}</span> : null}</span>
              <span className="text-gray-500">{isOpen ? '▴' : '▾'}</span>
              <span className="basis-full text-xs text-gray-400">{f.what} — <b className="text-gray-300">{f.action}</b></span>
            </button>
            {isOpen && (
              <div className="px-4 pb-3 divide-y divide-gray-800 max-h-[24rem] overflow-y-auto">
                {f.items.map((it, i) => {
                  const fx = it.fix
                  const isDone = !!fx && done.has(fx.rowId + '|' + fixField(fx))
                  const txt = fx && 'confirmText' in fx ? fx.confirmText : ''
                  const verb = fx ? (fx.kind === 'purge' ? 'PURGAR' : fx.kind === 'rematch' ? 'TROCAR' : fx.kind === 'unmatch' ? 'DESFAZER' : fx.kind === 'adopt' ? 'ADOTAR' : fx.kind === 'unlink' ? 'SOLTAR' : 'CONSERTAR') : ''
                  return (
                    <div key={i} className={'py-2 flex items-center gap-3 text-sm' + (isDone ? ' opacity-40' : '')}>
                      <span className="flex-1 min-w-0"><span className="block truncate" title={it.label}>{it.code === 'PADRÃO' ? padraoLabel(it.label) : it.label}</span>{it.extra && <span className="block text-[11px] text-gray-500 truncate" title={it.extra}>{it.extra}</span>}</span>
                      {it.amount ? <span className="text-gray-300 shrink-0">{usd(it.amount)}</span> : null}
                      {it.link && <a href={it.link.href} className="text-xs text-sky-300 underline shrink-0">{it.link.label}</a>}
                      {fx && !isDone && <button disabled={saving} onClick={() => { if (!txt || confirm(txt)) onFix(check, it) }} className={(fx.kind === 'purge' ? 'bg-red-800 hover:bg-red-700' : 'bg-emerald-700 hover:bg-emerald-600') + ' disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs shrink-0'}>{verb}</button>}
                      {isDone && <span className="text-xs text-emerald-400 font-bold shrink-0">feito</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function NatureWorkbench({ sig, setSig }: { sig: NatureSignal; setSig: Dispatch<SetStateAction<NatureSignal>> }) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [remember, setRemember] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')

  async function write(g: NatureGroup, rows: NatureRow[], nat: Nature, alsoRemember: boolean) {
    if (!rows.length || busy) return
    setBusy(g.key); setMsg('')
    try {
      const r = await fetch(`${BASE_PATH}/api/item-nature`, {
        method: 'POST', headers: await sessionHeaders(),
        body: JSON.stringify({ action: 'apply', nature: nat, label: g.name.slice(0, 40), rows: rows.map(x => ({ table: x.table, id: x.id })) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
      // O palpite é uma SEGUNDA escrita, e ela pode falhar sozinha (a coluna pode
      // não existir). Falhar aqui não desfaz a classificação — e o aviso diz isso.
      if (alsoRemember && g.supplier_id) {
        const rr = await fetch(`${BASE_PATH}/api/item-nature`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'remember', supplier_id: g.supplier_id, nature: nat }) })
        if (!rr.ok) setMsg('classificado — mas o palpite do fornecedor NÃO gravou (falta a coluna default_nature?)')
      }
      const gone = new Set(rows.map(x => x.table + ':' + x.id))
      const money = rows.reduce((s, x) => s + x.amount, 0)
      setSig(prev => {
        const groups = prev.groups
          .map(x => x.key !== g.key ? x : { ...x, default_nature: alsoRemember && x.supplier_id ? nat : x.default_nature, rows: x.rows.filter(y => !gone.has(y.table + ':' + y.id)) })
          .map(x => ({ ...x, count: x.rows.length, amount: x.rows.reduce((s, y) => s + y.amount, 0) }))
          .filter(x => x.count > 0)
        const t = prev.totals
        return { ...prev, groups, totals: t ? { ...t, rows: t.rows - rows.length, money: t.money - money, done_rows: t.done_rows + rows.length, done_money: t.done_money + money, groups: groups.length } : t }
      })
      setMsg(prev => prev || `${j.applied ?? rows.length} linha(s) marcadas ${NATURE_LABEL[nat]}${j.skipped ? ` · ${j.skipped} já tinham resposta e NÃO foram sobrescritas` : ''}`)
    } finally { setBusy('') }
  }

  if (sig.needsMigration) return (
    <div className="bg-amber-950/60 border border-amber-800 rounded-2xl p-5 text-amber-200">
      <p className="font-bold mb-1">MIGRATION PENDENTE</p>
      <p className="text-sm">Rode <b>MIGRATION_item_nature.sql</b> (raiz do projeto) no SQL Editor: ele cria <code className="bg-black/40 px-1.5 rounded">nature</code> nas 6 tabelas de item e <code className="bg-black/40 px-1.5 rounded">default_nature</code> em suppliers. Até lá ninguém consegue responder &quot;o que é esta linha?&quot; — e o STREAM segue mostrando wire de carro na mesma fila de um jogo de velas.</p>
    </div>
  )
  if (sig.state === 'loading') return <p className="text-gray-500 text-sm">Lendo as 6 tabelas de item…</p>
  if (sig.state === 'error' || !sig.totals) return <p className="text-red-400 text-sm">Sinal de /api/item-nature indisponível — a verificação NÃO rodou. Recarregue.</p>

  const t = sig.totals
  const needle = q.trim().toLowerCase()
  const groups = needle ? sig.groups.filter(g => g.name.toLowerCase().includes(needle)) : sig.groups

  return (
    <div>
      {/* O PLACAR HONESTO: o que falta, quanto vale, o que já foi feito — e
          quantos grupos bastam pra maior parte (é o que prova que isto acaba). */}
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3">
          <p className="text-2xl font-bold text-amber-300 tabular-nums">{t.rows.toLocaleString('en-US')}</p>
          <p className="text-xs text-gray-500">linhas sem natureza · {usd(t.money)} esperando resposta</p>
        </div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3">
          <p className={`text-2xl font-bold tabular-nums ${t.done_rows ? 'text-emerald-400' : 'text-gray-500'}`}>{t.done_rows.toLocaleString('en-US')}</p>
          <p className="text-xs text-gray-500">já classificadas · {usd(t.done_money)}</p>
        </div>
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3">
          <p className="text-2xl font-bold text-sky-300 tabular-nums">{t.groups.toLocaleString('en-US')}</p>
          <p className="text-xs text-gray-500">grupos de fornecedor · <b>{t.groups_80}</b> cobrem 80% das linhas · <b>{t.groups_90}</b> cobrem 90% do dinheiro</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="achar o fornecedor: HHP, Kramer, Texas Speed…" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-80" />
        <span className="text-xs text-gray-500">{groups.length} de {sig.groups.length} grupos · maior primeiro</span>
        {msg && <span className="text-xs text-emerald-300">{msg}</span>}
      </div>

      {groups.length === 0 ? <p className="text-emerald-400 font-bold">Nada pendente aqui.</p> : (
        <div className="space-y-3 max-h-[40rem] overflow-y-auto pr-1">
          {groups.map(g => {
            const open = openKey === g.key
            const rem = !!remember[g.key]
            return (
              <div key={g.key} className="border border-gray-800 rounded-2xl overflow-hidden">
                <div className="px-4 py-3 bg-gray-900/70 flex items-baseline gap-3 flex-wrap">
                  <span className="text-lg font-bold tabular-nums text-amber-300 w-10 shrink-0">{g.count}</span>
                  <span className="font-bold flex-1 min-w-0 truncate" title={g.name}>{g.name}</span>
                  {g.default_nature && <span className={`text-xs font-bold ${NATURE_TAG[g.default_nature]}`}>palpite do fornecedor: {NATURE_LABEL[g.default_nature]}</span>}
                  {!g.supplier_id && <span className="text-xs text-gray-600">só em texto — sem cadastro</span>}
                  <span className="tabular-nums font-bold text-sm shrink-0">{usd(g.amount)}</span>
                  <button onClick={() => setOpenKey(open ? null : g.key)} className="text-xs text-gray-400 hover:text-white underline shrink-0">{open ? 'esconder as linhas ▴' : `ver as ${g.count} linhas ▾`}</button>
                </div>
                <div className="px-4 py-3">
                  <div className="flex gap-2 flex-wrap items-center">
                    {NATURES.map(n => (
                      <button key={n} disabled={!!busy} title={NATURE_HINT[n]}
                        onClick={() => {
                          if (g.rows.length > 1 && !confirm(`Marcar as ${g.rows.length} linhas de "${g.name}" (${usd(g.amount)}) como ${NATURE_LABEL[n]}?\n\n${NATURE_HINT[n]}\n\nSó linha ainda em branco é escrita — quem já tem resposta não é sobrescrito. Se houver exceção neste fornecedor (imposto no meio dos carros, frete no meio das peças), cancele e classifique a exceção primeiro em "ver as ${g.count} linhas". Tudo vai pra trilha.`)) return
                          write(g, g.rows, n, rem)
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border disabled:opacity-40 ${NATURE_BTN[n]} ${g.default_nature === n ? 'ring-2 ring-white/70' : ''}`}>{NATURE_LABEL[n]}</button>
                    ))}
                    {busy === g.key && <span className="text-xs text-gray-400">gravando…</span>}
                  </div>
                  <label className={`flex items-center gap-2 mt-2 text-xs ${g.supplier_id ? 'text-gray-400' : 'text-gray-600'}`}>
                    <input type="checkbox" checked={rem} disabled={!g.supplier_id} onChange={e => setRemember({ ...remember, [g.key]: e.target.checked })} />
                    {g.supplier_id
                      ? 'lembrar para este fornecedor — grava só o PALPITE (pré-seleciona na próxima vez; nunca classifica sozinho)'
                      : 'fornecedor só existe como texto: não há cadastro onde lembrar o palpite (crie em SUPPLIERS)'}
                  </label>
                  {open && (
                    <div className="mt-3 border-t border-gray-800">
                      <p className="text-xs text-gray-500 py-2">A EXCEÇÃO VEM PRIMEIRO: classifique aqui a linha que foge do grupo — depois o botão de cima leva o resto. O <span className="text-gray-400">palpite</span> ao lado da linha é só uma etiqueta por palavra-chave; ele nunca aplica nada.</p>
                      <div className="max-h-96 overflow-y-auto divide-y divide-gray-800">
                        {g.rows.map(r => (
                          <div key={r.table + ':' + r.id} className="py-2 flex items-baseline gap-2 flex-wrap">
                            <span className="text-[10px] text-gray-600 w-28 shrink-0">{r.table}</span>
                            {r.ctx && <span className="text-[10px] font-bold text-gray-400 shrink-0">{r.ctx}</span>}
                            {/* O título carrega a GRAFIA CRUA do fornecedor: o grupo
                                junta "HHP", "High Horse Performance" e "HHP Racing",
                                e às vezes é ela que explica a linha estranha. */}
                            <a href={`${BASE_PATH}${r.href}`} target="_blank" rel="noreferrer" className="flex-1 min-w-[12rem] truncate text-sm hover:underline" title={`${r.supplier ? r.supplier + ' · ' : ''}${r.label}`}>{r.label}</a>
                            {r.date && <span className="text-xs text-gray-600 shrink-0">{String(r.date).slice(0, 10)}</span>}
                            <span className="tabular-nums text-sm font-bold shrink-0">{usd(r.amount)}</span>
                            {r.hint && <span className={`text-[10px] font-bold shrink-0 ${NATURE_TAG[r.hint]}`}>palpite {NATURE_LABEL[r.hint]}</span>}
                            <span className="flex gap-1 shrink-0">
                              {NATURES.map(n => (
                                <button key={n} disabled={!!busy} title={`só esta linha → ${NATURE_LABEL[n]}: ${NATURE_HINT[n]}`}
                                  onClick={() => write(g, [r], n, false)}
                                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border disabled:opacity-40 ${NATURE_BTN[n]}`}>{NATURE_LABEL[n]}</button>
                              ))}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function DataCheckPage() {
  const [d, setD] = useState<FinData | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)   // `${check}|${rowId}`
  const [auto, setAuto] = useState<AutoSignal>({ state: 'loading', rows: [], dismissed: {} })   // o que o app fez sozinho + dispensas
  const [bucketSig, setBucketSig] = useState<BucketSig>({ state: 'loading', sug: new Map(), invoices: [] })   // sugestões da fila A ATRIBUIR
  const [fixValue, setFixValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<Set<string>>(new Set())    // rowIds consertados nesta visita
  const [showHistory, setShowHistory] = useState(false)
  const [reloadN, setReloadN] = useState(0)
  const [bankCount, setBankCount] = useState(0)   // linhas NEW do banco (card próprio)
  const [bankAConferir, setBankAConferir] = useState(0)   // casamentos do motor aguardando OK
  const [bank, setBank] = useState<BankSignal>({ matched: new Set(), groups: new Map(), outflows: new Map(), lines: [], opened: REGIONS_OPENED, cash: null, cashState: 'loading' })   // sinal da Regions
  const [tax, setTax] = useState<TaxSignal>({ state: 'loading', needsMigration: false, years: [] })   // sinal do 1099 (TAX HUB)
  const [duty, setDuty] = useState<DutySignal>({ state: 'loading', maxHours: 10, incidents: [], history: { absurd: [], comps: [] } })   // sinal do STAFF DUTY WATCH
  const [linker, setLinker] = useState<LinkerSignal>({ state: 'loading', needsMigration: false, needsSupplierMigration: false, totals: null, inventory: [], streams: [], no_pn: [], dup_pn: [], suppliers_unlinked: [], suppliers_all: [], map_bad: [], no_source: [], kit_mismatch: [], ebay_pn: [], categories: [], category_vocab: [] })   // identidade de peças
  const [bulk, setBulk] = useState<string>('')   // progresso do bulk
  const [filter, setFilter] = useState<Record<string, string>>({})     // filtro por card
  const [sigFilter, setSigFilter] = useState<Record<string, string>>({})   // filtro por SINAL (exato, sem armadilha de substring — revisão #4)
  const [groupFilter, setGroupFilter] = useState<string | null>(null)      // chip de categoria
  const [whyOpen, setWhyOpen] = useState<string | null>(null)              // "entender esta checagem" aberto
  const [guided, setGuided] = useState<{ key: string; idx: number; start: number } | null>(null)   // MODO GUIADO
  const [gval, setGval] = useState('')                                     // valor escolhido no item guiado
  const [bulkValue, setBulkValue] = useState<Record<string, string>>({})   // valor do "marcar filtrados como" por card
  const [wa, setWa] = useState<WaSignal>({ state: 'loading', fails: [] })  // falhas de envio do WhatsApp (wa_send_log)
  const [nature, setNature] = useState<NatureSignal>({ state: 'loading', needsMigration: false, totals: null, groups: [] })   // "o que é esta linha?" agrupado por fornecedor

  useEffect(() => {
    setD(null); setError('')
    loadFinancials().then(setD).catch(e => setError(String(e?.message || e)))
    // WA SEND LOG (caso Gui, 31/ago): falhas de envio dos últimos 14 dias.
    ;(async () => {
      try {
        const since = new Date(Date.now() - 14 * 864e5).toISOString()
        const { data: wf, error: we } = await supabase.from('wa_send_log')
          .select('id, at, destination, group_name, kind, body_head, error, http_status')
          .eq('ok', false).gte('at', since).order('at', { ascending: false }).limit(200)
        if (we) setWa({ state: /does not exist|schema cache/i.test(we.message) ? 'missing' : 'error', fails: [] })
        else setWa({ state: 'ok', fails: (wf || []) as WaSignal['fails'] })
      } catch { setWa({ state: 'error', fails: [] }) }
    })()
    // NATUREZA DA LINHA (04/set): o que ainda ninguém disse, agrupado por
    // fornecedor. Vem em bloco PRÓPRIO, e não pendurado na corrente do banco: um
    // tropeço no Plaid lá em cima deixaria este card "carregando" para sempre —
    // e verificação que não roda tem de DIZER que não rodou, não ficar muda.
    // A migration pode não ter rodado ainda: a rota devolve needs_migration em
    // vez de erro, e o card vira um aviso com o nome do arquivo .sql.
    ;(async () => {
      try {
        // NATUREZA SOZINHA (DC 1.44.0): carro → dinheiro, PN → peça, hábito unânime — uma rodada por abertura, antes de ler o sinal.
        if (!AUTO_NATURE_RAN) { AUTO_NATURE_RAN = true; try { await fetch(`${BASE_PATH}/api/item-nature/auto`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ max: 800 }) }) } catch { /* sem rota/coluna: o card segue perguntando */ } }
        const r = await fetch(`${BASE_PATH}/api/item-nature`, { headers: await sessionHeaders() })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j.ok) setNature({ state: 'ok', needsMigration: !!j.needs_migration, totals: j.totals || null, groups: j.groups || [] })
        else setNature({ state: 'error', needsMigration: !!j.needs_migration, totals: null, groups: [] })
      } catch { setNature({ state: 'error', needsMigration: false, totals: null, groups: [] }) }
    })()
    // Pares casados com a Regions — melhor esforço (sem sessão/servidor o card só perde o "certo").
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/bank/reconcile?matched=1`, { headers: await sessionHeaders() })
        const j = await r.json().catch(() => ({}))
        if (r.ok && Array.isArray(j.matched)) {
          const outflows = new Map<string, string[]>()
          const lines: BankLine[] = []
          for (const o of (j.outflows || []) as { d: string; a: number; id?: string; n?: string; s?: string }[]) { const k = Number(o.a).toFixed(2); outflows.set(k, [...(outflows.get(k) || []), o.d]); lines.push({ d: o.d, a: Number(o.a), id: o.id || '', n: o.n || '', s: o.s || '' }) }
          // Grupo casado carrega o VALOR do banco: membro só é "certo" enquanto o
          // total do pedido ainda bate com o que o banco cobrou (revisão #1).
          const groups = new Map<string, number>()
          for (const m of j.matched as { table: string; id: string; amount: number }[]) if (m.table === 'purchase_group') groups.set(m.id, Number(m.amount) || 0)
          setBank(prev => ({ ...prev, matched: new Set((j.matched as { table: string; id: string }[]).map(m => m.table + ':' + m.id)), groups, outflows, lines, opened: j.account_opened || REGIONS_OPENED }))
        }
        // AUTO-BOOK (BL 0.8.0): rodadas, erros, órfãos e duplas do motor automático.
        try {
          const ra = await fetch(`${BASE_PATH}/api/bank/reconcile?autobook=1`, { headers: await sessionHeaders() })
          const ja = await ra.json().catch(() => ({}))
          if (ra.ok && ja.ok) setBank(prev => ({ ...prev, autobook: ja as AutoBookSignal }))
        } catch { /* sinal ausente = card não aparece */ }
        // Saldo REAL do banco × linhas do feed — o "caixa não bate" (João, 22/ago).
        // Estado explícito: sem resposta = verificação NÃO rodou (revisão #16).
        const rb = await fetch(`${BASE_PATH}/api/plaid/balance`, { headers: await sessionHeaders() })
        const jb = await rb.json().catch(() => ({}))
        if (rb.ok && Array.isArray(jb.items)) setBank(prev => ({ ...prev, cash: jb.items, cashState: 'ok' }))
        else setBank(prev => ({ ...prev, cashState: 'error' }))
        // 1099 (TAX HUB): beneficiários $600+/ano sem classificação ou serviço sem W-9.
        const rt = await fetch(`${BASE_PATH}/api/tax/1099`, { headers: await sessionHeaders() })
        const jt = await rt.json().catch(() => ({}))
        if (rt.ok && Array.isArray(jt.years)) setTax({ state: 'ok', needsMigration: !!jt.needs_migration, years: jt.years })
        else setTax(prev => ({ ...prev, state: 'error' }))
        // DUTY WATCH: timer esquecido / duties simultâneas / virada de noite (Márcio: 10h).
        const rd = await fetch(`${BASE_PATH}/api/staff-duties`, { headers: await sessionHeaders() })
        const jd = await rd.json().catch(() => ({}))
        if (rd.ok && Array.isArray(jd.incidents)) setDuty({ state: 'ok', maxHours: jd.max_hours || 10, incidents: jd.incidents, history: jd.history || { absurd: [], comps: [] } })
        else setDuty(prev => ({ ...prev, state: 'error' }))
        // LINKER: identidade de peças (pré-P1 do Crew Chief) — inventory/stream → catálogo.
        // O que o app fez sozinho + dispensas; e as sugestões da fila A ATRIBUIR (balde por fornecedor).
        try { const ra = await fetch(`${BASE_PATH}/api/data-check/auto`, { headers: await sessionHeaders() }); const ja = await ra.json().catch(() => ({})); setAuto(ra.ok ? { state: 'ok', rows: ja.auto || [], dismissed: ja.dismissed || {}, total: typeof ja.total === 'number' ? ja.total : undefined } : { state: 'error', rows: [], dismissed: {} }) } catch { setAuto({ state: 'error', rows: [], dismissed: {} }) }
        try {
          const rb = await fetch(`${BASE_PATH}/api/bank/reconcile?bucket=1`, { headers: await sessionHeaders() }); const jb = await rb.json().catch(() => ({}))
          if (rb.ok && Array.isArray(jb.rows)) { const sug = new Map<string, { invoice_id: string; code: string; car: string; why: string; score: number }>(); for (const row of jb.rows) { const best = (row.suggestions || []).filter((s: any) => s.kind === 'CAR').sort((a: any, b: any) => b.score - a.score)[0]; if (best) sug.set(String(row.row_id), { invoice_id: best.invoice_id, code: best.code, car: best.car, why: best.why, score: best.score }) } setBucketSig({ state: 'ok', sug, invoices: (jb.invoices || []).map((i: any) => ({ id: i.id, code: i.code, ride_code: i.ride_code, ride_name: i.ride_name, closed: !!i.closed })) }) }
          else setBucketSig(prev => ({ ...prev, state: 'error' }))
        } catch { setBucketSig(prev => ({ ...prev, state: 'error' })) }
        let rl = await fetch(`${BASE_PATH}/api/parts/link`, { headers: await sessionHeaders() })
        let jl = await rl.json().catch(() => ({}))
        // CATEGORIA SOZINHA (DC 1.42.0): peça sem veredito da IA → lê agora (até 80 por carga),
        // preenche as certas e recarrega o sinal. Uma vez por abertura da página.
        // Também quando o LIGAR está ligado e há certas já lidas esperando (o marcador pode ter sido ligado sem o clique — 8/set).
        if (rl.ok && jl.totals && ((jl.category_ai_pending || 0) > 0 || (jl.auto_fill_enabled && (jl.certain_ready || 0) > 0)) && !jl.needs_category_ai_migration && !AUTO_CAT_RAN) {
          AUTO_CAT_RAN = true
          try {
            const rc = await fetch(`${BASE_PATH}/api/parts/link`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'classify_categories', max: 80 }) })
            if (rc.ok) { rl = await fetch(`${BASE_PATH}/api/parts/link`, { headers: await sessionHeaders() }); jl = await rl.json().catch(() => ({})) }
          } catch { /* sem IA agora: fica IA PENDENTE, tenta na próxima abertura */ }
        }
        if (rl.ok && jl.totals) setLinker({ state: 'ok', needsMigration: !!jl.needs_migration, needsSupplierMigration: !!jl.needs_supplier_migration, totals: jl.totals, inventory: jl.inventory || [], streams: jl.streams || [], no_pn: jl.no_pn || [], dup_pn: jl.dup_pn || [], suppliers_unlinked: jl.suppliers_unlinked || [], suppliers_all: jl.suppliers_all || [], map_bad: jl.map_bad || [], no_source: jl.no_source || [], kit_mismatch: jl.kit_mismatch || [], ebay_pn: jl.ebay_pn || [], categories: jl.categories || [], category_vocab: jl.category_vocab || [], category_ai_pending: jl.category_ai_pending || 0, needs_category_ai_migration: !!jl.needs_category_ai_migration, auto_categories: jl.auto_categories || [] })
        else setLinker(prev => ({ ...prev, state: 'error', needsMigration: !!jl.needs_migration }))
      } catch { setBank(prev => ({ ...prev, cashState: 'error' })) /* sem banco, sem certeza */ }
    })()
  }, [reloadN])

  const checks = useMemo(() => (d ? applyDismiss(buildChecks(d, bank, tax, duty, linker, wa, nature, auto, bucketSig), auto, bank) : []).map(c => ({ ...c, items: c.items.filter(i => !(i.fix && done.has(i.fix.rowId + '|' + fixField(i.fix)))) })), [d, done, bank, tax, duty, linker, wa, nature, auto, bucketSig])
  // Card BOM (good) não entra em pendência nenhuma — nem no total, nem no chip do grupo.
  const totalIssues = checks.reduce((s, c) => s + (c.good ? 0 : c.items.length), 0) + bankCount
  const groupCount = (g: string) => (g === 'BANK' ? bankCount : 0) + checks.filter(c => c.group === g && !c.good).reduce((s, c) => s + c.items.length, 0)

  // Trilha agrupada por dia — a "sessão" do double-check.
  const history = useMemo(() => {
    if (!d?.dataFixes) return null
    const byDay = new Map<string, any[]>()          // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const fx of [...d.dataFixes].sort((a, b) => String(b.fixed_at).localeCompare(String(a.fixed_at)))) {
      const day = String(fx.fixed_at).slice(0, 10)
      const a = byDay.get(day) || []; a.push(fx); byDay.set(day, a)
    }
    return [...byDay.entries()]
  }, [d])

  // MODO GUIADO: pré-carrega a sugestão do item (um Enter resolve) ou a data prevista.
  const gPrefill = (it?: Item) => {
    if (!it || !it.fix) return ''
    if (it.fix.kind === 'select') { const s = it.suggest; return s && it.fix.options.some(o => o.value === s) ? s : '' }
    if (it.fix.kind === 'date') return (it.when || '').slice(0, 10)
    return ''
  }

  // COMECE AQUI (fase 3 da reforma, 25/ago): as 3 melhores próximas ações,
  // ranqueadas pelo que destravam — régua > martelo no motor > um-clique > volume.
  const missions = useMemo(() => {
    const out: { title: string; sub: string; group: string | null; open: string | null }[] = []
    const cash = checks.find(c => c.key === 'cash-match')
    if (cash && cash.items.length > 0) out.push({ title: 'O caixa não bate — conserte a régua primeiro', sub: 'enquanto ela estiver vermelha, nenhum outro número vale', group: 'BANK', open: 'cash-match' })
    const ab = checks.find(c => c.key === 'auto-book')
    if (ab && ab.items.some(i => i.code === 'MOTOR' || i.code === 'ERRO')) out.push({ title: 'AUTO-BOOK parou ou errou — veja o card', sub: 'o motor deixou de registrar as linhas novas do banco; até voltar, o DRE atrasa', group: 'BANK', open: 'auto-book' })
    const bk = checks.find(c => c.key === 'bucket-aging')
    if (bk && bk.items.length) out.push({ title: `${bk.items.length} compra(s) sem dono há 7+ dias — diga o carro`, sub: `${usd(bk.impact || 0)} parados no balde · CARRO / ESTOQUE / SUPPLIES / FIXO na fila A ATRIBUIR`, group: 'BANK', open: 'bucket-aging' })
    // Silêncio (DC 1.40.0): casamento do motor é prova, não pendência — a missão «conferir» morreu; nasceram as perguntas e a deriva.
    const dq = checks.find(c => c.key === 'engine-questions')
    if (dq && dq.items.length) out.push({ title: `${dq.items.reduce((t, i) => t + (parseInt(i.label, 10) || 0), 0)} perguntas do motor — responda por fornecedor`, sub: 'nada fica parado calado: FIXO / SUPPLIES / BALDE / PESSOAL / IGNORAR — uma resposta lança todas as linhas', group: 'BANK', open: 'engine-questions' })
    const dd = checks.find(c => c.key === 'bank-drift')
    if (dd && dd.items.length) out.push({ title: `${dd.items.length} conta(s) pagas no banco e abertas no app — ADOTAR`, sub: `${usd(dd.impact || 0)} em atrasos e multas falsos; um clique por conta`, group: 'BANK', open: 'bank-drift' })
    const certoChecks = checks.filter(c => c.items.some(i => i.certain))
    const certos = certoChecks.reduce((s, c) => s + c.items.filter(i => i.certain).length, 0)
    if (certos > 0) {
      const best = [...certoChecks].sort((a, b) => b.items.filter(i => i.certain).length - a.items.filter(i => i.certain).length)[0]
      out.push({ title: `${certos} respostas prontas — um clique por card`, sub: `PREENCHER CERTOS onde há prova; comece por "${best.title}"`, group: best.group, open: best.key })
    }
    if (bankCount > 50) out.push({ title: `Triagem por família: ${bankCount.toLocaleString('en-US')} linhas sem casamento`, sub: 'os chips (AMAZON, COMBUSTÍVEL…) explicam centenas de uma vez', group: 'BANK', open: null })
    const heavy = [...checks].filter(c => !c.good && c.items.length > 0 && c.key !== 'cash-match' && (c.impact || 0) > 0).sort((a, b) => (b.impact || 0) - (a.impact || 0))[0]
    if (heavy) out.push({ title: `Maior valor parado: ${heavy.title}`, sub: `${heavy.items.length} itens · ${usd(heavy.impact || 0)} — se ignorar: ${heavy.blocks}`, group: heavy.group, open: heavy.key })
    return out.slice(0, 3)
  }, [checks, bankCount, bankAConferir])
  // AUTO-RUN (DC 1.44.0): os itens CERTOS dos cards em AUTO_KEYS entram sozinhos, uma rodada por abertura,
  // depois que todos os sinais chegaram. select/number escrevem guardados por «campo ainda vazio» com
  // trilha «AUTO · <prova>»; casar/adotar vão pela rota (A CONFERIR com DESFAZER); apagar leva a foto
  // da linha na trilha (DESFAZER recria). Nada roda sem a Regions carregada (a prova mora nela).
  useEffect(() => {
    // Sem a MEMÓRIA (dispensas e desfeitos) carregada, nada é escrito: a máquina não passa por cima de uma decisão que não leu.
    if (AUTO_RAN || !d || !bank.matched.size || bank.cashState === 'loading' || linker.state !== 'ok' || auto.state !== 'ok') return
    const jobs: { check: Check; item: Item }[] = []
    for (const c of checks) if (AUTO_KEYS.has(c.key)) for (const it of c.items) if (it.certain && it.fix && !done.has(it.fix.rowId + '|' + fixField(it.fix)) && auto.dismissed[c.key + '|' + String(it.fix.rowId)] === undefined) jobs.push({ check: c, item: it })
    if (!jobs.length) return
    AUTO_RAN = true
    ;(async () => {
      let n = 0
      for (const { check, item } of jobs.slice(0, 300)) {
        const fix = item.fix!
        try {
          if ((fix.kind === 'select' || fix.kind === 'number') && item.suggest) {
            const val: any = fix.kind === 'number' ? (parseFloat(item.suggest) || 0) : item.suggest
            // Guarda pelo valor que o card viu: vazio → só se ainda vazio; CONSUMPTION → só se ainda CONSUMPTION (ninguém mexeu no meio).
            const cur = fix.kind === 'select' && fix.current != null ? String(fix.current) : null
            const q0 = supabase.from(fix.table).update({ [fix.field]: val }).eq('id', fix.rowId)
            const { data: ok, error } = await (cur != null ? q0.eq(fix.field, cur) : q0.is(fix.field, null)).select('id')
            if (error || !ok || !ok.length) continue
            await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field: fix.field, old_value: cur, new_value: String(val), label: ('AUTO · ' + (CERTAIN_PROOF[check.key] || 'prova') + ' · ' + item.code + ' · ' + item.label).slice(0, 200) }).then(() => undefined, () => undefined)
            n++
          } else if (fix.kind === 'trash') {
            // A FOTO antes do apagar: sem trilha gravada, nada é apagado (senão não há volta).
            const { data: row } = await supabase.from(fix.table).select('*').eq('id', fix.rowId).maybeSingle()
            if (!row) continue
            const snap = JSON.stringify(row); if (snap.length > 8000) continue
            const { data: tr, error: tErr } = await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field: 'DELETED', old_value: snap, new_value: null, label: ('AUTO · ' + (CERTAIN_PROOF[check.key] || 'prova') + ' · ' + item.label).slice(0, 200) }).select('id')
            if (tErr || !tr || !tr.length) continue
            const { error } = await supabase.from(fix.table).delete().eq('id', fix.rowId)
            if (error) { await supabase.from('data_fixes').delete().eq('id', tr[0].id); continue }
            n++
          } else if (fix.kind === 'adopt' || fix.kind === 'match') {
            // Direto pela rota (sem alert na carga); a trilha AUTO aponta pra linha do banco (DESFAZER em A CONFERIR).
            const body = fix.kind === 'match' ? { action: 'match', bank_id: fix.bankId, table: fix.table, row_id: fix.rowId, engine: 'AUTO', note: 'valor exato + nome + linha única (Data Checker)' } : { action: 'adopt_scheduled', bank_id: fix.bankId, row_id: fix.rowId, engine: 'AUTO' }
            const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
            if (!r.ok) continue
            // ADOTAR: a rota (adoptScheduled) já grava a trilha AUTO na linha do banco; aqui só o CASAR.
            if (fix.kind === 'match') await supabase.from('data_fixes').insert({ check_key: check.key, table_name: 'bank_transactions', row_id: fix.bankId, field: 'match_status', old_value: 'NEW', new_value: 'MATCHED', label: ('AUTO · ' + (CERTAIN_PROOF[check.key] || 'prova') + ' · ' + item.label).slice(0, 200) }).then(() => undefined, () => undefined)
            setDone(prev => new Set(prev).add(fix.rowId + '|' + fixField(fix)))
            n++
          }
        } catch { /* item que falhou continua no card, com o botão */ }
      }
      if (n) setReloadN(x => x + 1)
    })()
  }, [checks, d, bank, linker, auto, done])   // eslint-disable-line react-hooks/exhaustive-deps
  const fixesToday = useMemo(() => history?.find(([day]) => day === TODAY)?.[1].length || 0, [history])

  async function applyFix(check: Check, item: Item, value: string) {
    const fix = item.fix!
    // APARAR (trim) escreve pelo servidor (tabelas e regras do lado de lá).
    if (fix.kind === 'trim') {
      setSaving(true)
      try {
        const r = await fetch(`${BASE_PATH}/api/staff-duties`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'trim', duty_id: fix.dutyId, seg_start: fix.segStart, seg_end: fix.segEnd, banked_start: fix.bankedStart, banked_end: fix.bankedEnd, new_end_local: value }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // Detox dos insumos (João, 26/ago): reclassifica a categoria, ou 📦 MOVE a
    // linha pro estoque de verdade (cria em inventory, apaga o input, trilha).
    if (check.key === 'inputs-category' && fix.kind === 'select') {
      setSaving(true)
      try {
        if (value === '__keep__' && !fix.current) {
          // Sem categoria ainda: «é consumível da oficina» GRAVA CONSUMPTION (dispensar o vazio deixaria o buraco).
          const { error: e0 } = await supabase.from('inputs').update({ category: 'CONSUMPTION' }).eq('id', fix.rowId).is('category', null)
          if (e0) { alert(e0.message); return }
          await supabase.from('data_fixes').insert({ check_key: check.key, table_name: 'inputs', row_id: fix.rowId, field: 'category', old_value: null, new_value: 'CONSUMPTION', label: `${item.code} · ${item.label}`.slice(0, 200) })
          setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field)); setFixing(null); setFixValue('')
          return
        }
        if (value === '__keep__') {
          // Está certo como está: dispensa com memória (a linha some do card e fica na trilha).
          const r = await fetch(`${BASE_PATH}/api/data-check/auto`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'dismiss', check_key: check.key, row_id: fix.rowId, table: 'inputs', reason: 'consumível da oficina — fica em CONSUMPTION', label: item.label.slice(0, 120) }) })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
          setAuto(prev => ({ ...prev, dismissed: { ...prev.dismissed, [check.key + '|' + fix.rowId]: 'consumível da oficina' } }))
          setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field)); setFixing(null); setFixValue('')
          return
        }
        if (value === '__stock__') {
          const src = (fix.meta || {}) as any
          const { error: e1 } = await supabase.from('inventory').insert({
            description: src.description || '', supplier: src.supplier || null, source_type: 'PURCHASED',
            unit_price: src.unit_price ?? null, quantity: src.quantity ?? 1,
            purchase_date: src.purchase_date || null, payment_date: src.payment_date || null,
            paid_from: src.paid_from || null, paid_to: src.paid_to || null, source: src.source || null, purchase_group: src.purchase_group || null,
            // ORDER NUMBER é SAGRADO (29/ago/2026): mover o insumo pro estoque
            // leva o pedido junto — a linha PURCHASED nasce rastreável.
            order_number: src.order_number || null,
          })
          if (e1) { alert(e1.message); return }
          const { error: e2 } = await supabase.from('inputs').delete().eq('id', fix.rowId)
          if (e2) { alert('Criado no estoque, mas falhou apagar o insumo: ' + e2.message); return }
          await supabase.from('data_fixes').insert({ check_key: check.key, table_name: 'inputs', row_id: fix.rowId, field: 'MOVED', old_value: String(src.description || '').slice(0, 180), new_value: 'inventory', label: ('MOVIDO PRA ESTOQUE · ' + String(src.description || '')).slice(0, 200) }).then(() => undefined, () => undefined)
        } else {
          const { error: err } = await supabase.from('inputs').update({ category: value }).eq('id', fix.rowId)
          if (err) { alert(err.message); return }
          await supabase.from('data_fixes').insert({ check_key: check.key, table_name: 'inputs', row_id: fix.rowId, field: 'category', old_value: fix.current ?? null, new_value: value, label: `${item.code} · ${item.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
        }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // Card do 1099 (fricção final do João, 25/ago): tax_contractors é só-service-key
    // — escreve pela API, que faz o upsert + trilha. O meta carrega os valores
    // atuais (o upsert sobrescreve tudo — sem ele, classificar zeraria o W-9).
    if (check.key === 'tax-1099' && fix.kind === 'select') {
      setSaving(true)
      try {
        const body = fix.field === 'classification'
          ? { key: fix.rowId, name: String(fix.meta?.name || ''), classification: value, w9_on_file: !!fix.meta?.w9 }
          : { key: fix.rowId, name: String(fix.meta?.name || ''), classification: (fix.meta?.cls as string) || null, w9_on_file: true }
        const r = await fetch(`${BASE_PATH}/api/tax/1099`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // Card de identidade (João, 25/ago): buscar no catálogo inteiro (PartPicker no
    // painel) e criar entrada mínima — nasce MANUAL sem PN e as filas de higiene
    // (SEM PN, sem categoria, sem fornecedor oficial) perseguem até completar.
    if (check.key === 'parts-identity' && fix.kind === 'select') {
      if (value === '__search__') { alert('Digite na busca 🔎 que abriu no painel — 2+ letras, acha por PN, nome ou apelido.'); return }
      setSaving(true)
      try {
        if (value === '__new__') {
          const name = (window.prompt('Nome da peça nova no catálogo (nasce mínima — PN, preços e categoria entram depois pelas filas de higiene):', fix.spelling || '') || '').trim()
          if (!name) return
          const r = await fetch(`${BASE_PATH}/api/parts/link`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'create_part', item: name, supplier: fix.sup || '', link_table: fix.table, link_id: fix.rowId }) })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
          alert(`"${name}" criada no catálogo e linkada. Ela vai aparecer nas filas de higiene (sem PN, sem categoria) até ficar completa.`)
        } else {
          const { error: err } = await supabase.from(fix.table).update({ part_id: value }).eq('id', fix.rowId).is('part_id', null)
          if (err) { alert(err.message); return }
          await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field: 'part_id', old_value: null, new_value: value, label: `${item.code} · ${item.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
        }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // APAGAR (trash): remove a linha de verdade — o painel com o confirmText é a
    // confirmação; a trilha guarda o que era (old_value = rótulo).
    // AUTO-BOOK (BL 0.8.0): PURGAR e TROCAR passam pela rota do Bank Link — ela
    // re-checa o marcador/elo antes de apagar e casa o registro humano com trilha.
    // BALDE (fase B): o select do card «Compra sem dono» ATRIBUI pela rota do Bank
    // Link (o servidor acha a linha do banco pelo row_id): carro, estoque ou insumo.
    if (check.key === 'bucket-aging' && fix.kind === 'select') {
      if (!value) { alert('escolha o carro, ESTOQUE ou SUPPLIES'); return }
      setSaving(true)
      try {
        const dest = value === '__stock__' ? 'STOCK' : value === '__supplies__' ? 'SUPPLIES' : 'CAR'
        const optLabel = String((fix.options || []).find((o: any) => o.value === value)?.label || '')
        const closedInv = dest === 'CAR' ? (bucketSig.invoices.find(i => i.id === value && i.closed) || (optLabel.endsWith('(FECHADA)') ? { code: optLabel.replace(' (FECHADA)', ''), ride_code: '' } : null)) : null
        if (closedInv && !confirm(`A invoice ${closedInv.code} (${closedInv.ride_code}) está FECHADA — atribuir reabre o período e muda a margem fechada. Continuar?`)) { setSaving(false); return }
        const body = { action: 'assign', row_id: fix.rowId, dest, invoice_id: dest === 'CAR' ? value : undefined, category: 'CONSUMPTION', force_closed: !!closedInv }
        const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // DC 1.44.0: DESFAZER genérico, VISTO (dispensa) e CASAR por prova.
    if (fix.kind === 'undo_auto' || fix.kind === 'dismiss' || fix.kind === 'match') {
      setSaving(true)
      try {
        const url = fix.kind === 'match' ? `${BASE_PATH}/api/bank/reconcile` : `${BASE_PATH}/api/data-check/auto`
        const body = fix.kind === 'match' ? { action: 'match', bank_id: fix.bankId, table: fix.table, row_id: fix.rowId, engine: 'AUTO', note: 'valor exato + nome + linha única (Data Checker)' }
          : fix.kind === 'dismiss' ? { action: 'dismiss', check_key: fix.checkKey, row_id: fix.rowId, table: check.key, label: item.label.slice(0, 120), reason: value || 'visto, está certo' }
          : { action: 'undo', fix_id: fix.fixId }
        const r = await fetch(url, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
        if (fix.kind === 'dismiss') setAuto(prev => ({ ...prev, dismissed: { ...prev.dismissed, [fix.checkKey + '|' + fix.rowId]: value || 'visto' } }))
      } finally { setSaving(false) }
      return
    }
    if (fix.kind === 'undo_category' || fix.kind === 'enable_autofill') {
      setSaving(true)
      try {
        const r = await fetch(`${BASE_PATH}/api/parts/link`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(fix.kind === 'enable_autofill' ? { action: 'enable_auto_fill' } : { action: 'undo_category', row_id: fix.rowId }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
        if (fix.kind === 'enable_autofill') { alert((j.filled || 0) + ' categoria(s) preenchida(s) sozinhas agora. Daqui em diante entram sem perguntar.'); setReloadN(n => n + 1) }
      } finally { setSaving(false) }
      return
    }
    if (fix.kind === 'purge' || fix.kind === 'rematch' || fix.kind === 'unmatch' || fix.kind === 'adopt' || fix.kind === 'unlink') {
      setSaving(true)
      try {
        const body = fix.kind === 'unlink' ? { action: 'unlink_expense', row_id: fix.rowId } : fix.kind === 'adopt' ? { action: 'adopt_scheduled', bank_id: fix.bankId, row_id: fix.rowId } : fix.kind === 'purge' ? { action: 'purge_orphan', table: fix.table, row_id: fix.rowId } : fix.kind === 'unmatch' ? { action: 'unmatch', bank_id: fix.bankId } : { action: 'rematch', bank_id: fix.bankId, table: fix.table, row_id: fix.rowId }
        const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    if (fix.kind === 'trash') {
      setSaving(true)
      try {
        const { error: err } = await supabase.from(fix.table).delete().eq('id', fix.rowId)
        if (err) { alert(err.message); return }
        await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field: fix.field, old_value: item.label.slice(0, 200), new_value: 'DELETED', label: `${item.code} · ${item.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    // Fricção #4: fornecedor sem sair da tela — "criar novo" aqui mesmo, e toda
    // escolha manual ensina a grafia como apelido (o casador melhora sozinho).
    if (check.key === 'parts-suppliers' && fix.kind === 'select') {
      setSaving(true)
      try {
        if (value === '__new__') {
          const name = (window.prompt(fix.ebay ? `Nome OFICIAL do vendedor do eBay "${fix.ebay}":` : 'Nome OFICIAL do novo fornecedor:', fix.ebay || fix.spelling || '') || '').trim()
          if (!name) return
          const r = await fetch(`${BASE_PATH}/api/parts/link`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'create_supplier', name, link_part_id: fix.rowId, spellings: [fix.spelling, fix.ebay].filter(Boolean), via: fix.ebay ? 'eBay' : undefined }) })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) { alert(j.error || `Falhou (${r.status})`); return }
          if (j.supplier) setLinker(prev => prev.suppliers_all.some(s => s.id === j.supplier.id) ? prev : { ...prev, suppliers_all: [...prev.suppliers_all, j.supplier].sort((a, b) => a.name.localeCompare(b.name)) })
          alert(j.reused ? `"${j.supplier.name}" já existia — peça ligada a ele (sem duplicar).` : `Fornecedor "${j.supplier.name}" criado e ligado.`)
        } else {
          const { error: err } = await supabase.from(fix.table).update({ supplier_id: value }).eq('id', fix.rowId).is('supplier_id', null)
          if (err) { alert(err.message); return }
          await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field: 'supplier_id', old_value: null, new_value: value, label: `${item.code} · ${item.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
          fetch(`${BASE_PATH}/api/parts/link`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'teach_alias', supplier_id: value, spellings: [fix.spelling, fix.ebay].filter(Boolean) }) }).then(() => undefined, () => undefined)
        }
        setDone(prev => new Set(prev).add(fix.rowId + '|' + fix.field))
        setFixing(null); setFixValue('')
      } finally { setSaving(false) }
      return
    }
    setSaving(true)
    const newValue = fix.kind === 'received' ? new Date().toISOString() : fix.kind === 'flag' ? fix.value : fix.kind === 'number' ? (parseFloat(value) || 0) : value
    const field = fixField(fix)
    const { error: err } = await supabase.from(fix.table).update({ [field]: newValue }).eq('id', fix.rowId)
    if (err) { setSaving(false); alert(err.message); return }
    // Trilha — melhor esforço: sem a migration do data_fixes o conserto vale igual.
    await supabase.from('data_fixes').insert({
      check_key: check.key, table_name: fix.table, row_id: fix.rowId, field,
      old_value: (fix.kind === 'select' ? fix.current : null) ?? null, new_value: newValue,
      label: `${item.code} · ${item.label}`.slice(0, 200),
    }).then(() => undefined, () => undefined)
    setSaving(false)
    setDone(prev => new Set(prev).add(fix.rowId + '|' + field))
    setFixing(null); setFixValue('')
  }

  // PREENCHER CERTOS: só itens com certain (prova, não palpite). Uma escrita por
  // linha + trilha; o que falhar fica na lista com o erro no alert.
  // Bulk: uma escrita por linha (só onde o campo ainda está vazio) + trilha. O que
  // falhar fica na lista e aparece no alert. PREENCHER CERTOS = bulk dos itens com
  // prova; MARCAR FILTRADOS = bulk do que o filtro mostra, com o valor escolhido.
  async function applyBulk(check: Check, items: Item[], value: string, tag: string) {
    setSaving(true)
    const errors: string[] = []
    let n = 0
    for (const it of items) {
      const fix = it.fix!; const field = fixField(fix)
      setBulk(`${n + 1}/${items.length}`)
      const cur = fix.kind === 'select' && fix.current != null ? String(fix.current) : null
      const qb = supabase.from(fix.table).update({ [field]: value }).eq('id', fix.rowId)
      const { error: err } = await (cur != null ? qb.eq(field, cur) : qb.is(field, null))
      if (err) { errors.push(`${it.code} · ${it.label}: ${err.message}`); continue }
      await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field, old_value: cur, new_value: value, label: `${tag} · ${it.code} · ${it.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
      setDone(prev => new Set(prev).add(fix.rowId + '|' + field)); n++
    }
    setBulk(''); setSaving(false)
    if (errors.length) alert(`${n} preenchidas; ${errors.length} com erro:\n` + errors.slice(0, 8).join('\n'))
  }
  async function applyCertain(check: Check) {
    const items = check.items.filter(i => i.certain && i.suggest && i.fix && i.fix.kind === 'select')
    if (!items.length) return
    // LINKER/R1: cada linha tem o SEU valor certo — bulk um a um.
    if (check.key === 'parts-identity' || check.key === 'parts-suppliers' || check.key === 'paid-from' || check.key === 'parts-category' || check.key === 'inputs-category') {
      const msg = check.key === 'inputs-category'
        ? `Preencher ${items.length} categoria(s) de insumo? Prova por linha: identidade da loja (mercado → TEAM, pet → CATS) ou loja e texto concordando. Cada linha recebe a SUA categoria. Tudo na trilha.`
        : check.key === 'parts-category'
        ? `Preencher ${items.length} categoria(s) em que palavra-chave e IA concordam? Cada peça recebe a SUA categoria; tudo na trilha, com DESFAZER por 7 dias no card.`
        : check.key === 'parts-suppliers'
        ? `Linkar ${items.length} peças ao fornecedor oficial? Todas batem pelo nome/apelido exato. Tudo na trilha.`
        : check.key === 'paid-from'
        ? `Preencher ${items.length} "quem pagou?"? Prova por linha: casada com a Regions (o banco) ou o campo antigo SOURCE (o app já sabia). Cada linha recebe o SEU valor. Tudo na trilha.`
        : `Linkar ${items.length} linhas ao catálogo? Todas têm o PN da peça no próprio texto — o número não mente. Tudo na trilha.`
      if (!confirm(msg)) return
      setSaving(true)
      let n = 0
      for (const it of items) {
        const fix = it.fix!
        setBulk(`${n + 1}/${items.length}`)
        const field = fix.kind === 'select' ? fix.field : 'part_id'
        const cur = fix.kind === 'select' && fix.current != null ? String(fix.current) : null
        const qc = supabase.from(fix.table).update({ [field]: it.suggest }).eq('id', fix.rowId)
        const { error: err } = await (cur != null ? qc.eq(field, cur) : qc.is(field, null))
        if (err) continue
        await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field, old_value: cur, new_value: it.suggest, label: (check.key === 'parts-category' ? `AUTO · palavra-chave + IA concordam (PREENCHER CERTOS) · ${it.label}` : `LINK CERTO · ${it.code} · ${it.label}`).slice(0, 200) }).then(() => undefined, () => undefined)
        setDone(prev => new Set(prev).add(fix.rowId + '|' + field)); n++
      }
      setBulk(''); setSaving(false)
      return
    }
    if (!confirm(`Preencher ${items.length} linhas com ${items[0].suggest}? Todas já casaram com uma linha da Regions — o banco provou quem pagou.`)) return
    await applyBulk(check, items, items[0].suggest!, 'CERTO (Regions)')
  }
  const filtered = (c: Check) => {
    const needle = (filter[c.key] || '').trim().toLowerCase()
    const sig = sigFilter[c.key] || ''
    return c.items.filter(i => (!sig || i.signal === sig) && (!needle || [i.code, i.label, i.extra || '', i.when || '', i.amount !== undefined ? i.amount.toFixed(2) : ''].join(' ').toLowerCase().includes(needle)))
  }
  async function applyFiltered(c: Check) {
    const value = bulkValue[c.key] || ''
    const items = filtered(c).filter(i => i.fix && i.fix.kind === 'select')
    if (!value || !items.length) return
    if (!confirm(`Marcar ${items.length} linhas filtradas como ${value}? Só linhas ainda vazias são escritas; tudo vai pra trilha.`)) return
    await applyBulk(c, items, value, `FILTRO "${[sigFilter[c.key], (filter[c.key] || '').trim()].filter(Boolean).join(' + ')}" → ${value}`)
  }

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DATA CHECKER</h1>
        <DcBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">FINANCIAL HUB →</a>
      </div>
      <p className="text-gray-400 mb-6 max-w-3xl">Conserto de um campo acontece aqui dentro (FIX na linha). O que precisa de contexto abre em aba nova — esta tela não sai do lugar. Tudo que você conserta aqui vira HISTÓRICO lá embaixo.</p>

      <div className="flex items-center gap-4 flex-wrap mb-8">
        <div className={`rounded-2xl border px-5 py-3 ${totalIssues === 0 ? 'bg-emerald-950/50 border-emerald-800 text-emerald-200' : 'bg-gray-900 border-gray-700'}`}>
          <span className="text-2xl font-bold">{totalIssues === 0 ? 'TUDO LIMPO ✓' : `${totalIssues} pendências`}</span>
          {totalIssues > 0 && <span className="text-sm text-gray-400 ml-3">{checks.filter(c => !c.good && c.items.length > 0).length} de {checks.filter(c => !c.good).length} verificações</span>}
        </div>
        {fixesToday > 0 && <div className="rounded-2xl border border-sky-900 bg-sky-950/40 px-5 py-3"><span className="text-2xl font-bold text-sky-300">{fixesToday}</span><span className="text-sm text-gray-400 ml-2">conserto(s) hoje</span></div>}
        <button onClick={() => { setDone(new Set()); setReloadN(x => x + 1) }} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-5 py-3 rounded-2xl font-bold">↻ REFRESH</button>
        <button onClick={() => setShowHistory(h => !h)} className={`px-5 py-3 rounded-2xl font-bold border ${showHistory ? 'bg-white text-black border-white' : 'bg-gray-900 hover:bg-gray-700 border-gray-700'}`}>HISTÓRICO</button>
      </div>

      {/* ── COMECE AQUI (fase 3): a ordem de ataque, calculada — não adivinhada ── */}
      {missions.length > 0 && (
        <div className="mb-8 max-w-4xl">
          <p className="text-sm font-bold tracking-widest text-gray-500 mb-2">COMECE AQUI</p>
          <div className="grid sm:grid-cols-3 gap-3">
            {missions.map((m, i) => (
              <button key={i} onClick={() => { setGroupFilter(m.group); setOpen(m.open); document.getElementById('dc-cards')?.scrollIntoView({ behavior: 'smooth' }) }} className="text-left bg-gray-900 hover:bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3">
                <p className="font-bold text-sm">{i + 1}º · {m.title}</p>
                <p className="text-xs text-gray-500 mt-1">{m.sub}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── HISTÓRICO — sessões de conserto, pro double-check ─────────── */}
      {showHistory && (
        <div className="mb-8 max-w-4xl">
          {history === null ? (
            <div className="bg-amber-950/60 border border-amber-800 rounded-2xl p-5 text-amber-200">
              <p className="font-bold mb-1">MIGRATION PENDENTE</p>
              <p className="text-sm">A trilha de consertos precisa da tabela <code className="bg-black/40 px-1.5 rounded">data_fixes</code>. Rode <b>MIGRATION_data_fixes.sql</b> (raiz do projeto) no SQL Editor e os consertos passam a ficar registrados.</p>
            </div>
          ) : history.length === 0 ? (
            <p className="text-gray-500">Nenhum conserto registrado ainda — os próximos FIX desta tela aparecem aqui.</p>
          ) : history.map(([day, fixes]) => (
            <div key={day} className="border border-gray-800 rounded-2xl overflow-hidden mb-4">
              <div className="px-5 py-3 bg-gray-900 font-bold flex justify-between">
                <span>Sessão de {formatShortDate(day)}</span>
                <span className="text-gray-400">{fixes.length} conserto{fixes.length > 1 ? 's' : ''}</span>
              </div>
              {fixes.map((fx: any) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
                <div key={fx.id} className="px-5 py-2.5 border-t border-gray-900 flex items-baseline gap-3 text-sm">
                  <span className="text-gray-500 text-xs w-12 shrink-0">{String(fx.fixed_at).slice(11, 16)}</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-800 text-gray-300 shrink-0">{fx.check_key}</span>
                  <span className="flex-1 truncate">{fx.label}</span>
                  <span className="text-gray-400 whitespace-nowrap">{fx.field}: <span className="text-red-400">{fx.old_value ? String(fx.old_value).slice(0, 10) : '—'}</span> → <span className="text-emerald-400">{String(fx.new_value).slice(0, 10)}</span></span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div id="dc-cards" className="space-y-6 max-w-4xl">
        {/* Chips de categoria: contagem viva, clique filtra, ✓ = categoria limpa. */}
        <div className="flex gap-2 flex-wrap">
          {GROUP_ORDER.map(g => { const has = g === 'BANK' || checks.some(c => c.group === g); if (!has) return null; const n = groupCount(g); return (
            <button key={g} onClick={() => setGroupFilter(groupFilter === g ? null : g)} className={`px-3 py-1.5 rounded-full text-xs font-bold border ${groupFilter === g ? 'bg-white text-black border-white' : n === 0 ? 'bg-gray-900 border-emerald-900/60 text-emerald-300' : 'bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800'}`}>{g} {n === 0 ? '✓' : n.toLocaleString('en-US')}</button>
          ) })}
        </div>
        {GROUP_ORDER.filter(g => (g === 'BANK' || checks.some(c => c.group === g)) && (!groupFilter || g === groupFilter)).map(g => (
          <section key={g}>
            <div className="flex items-baseline gap-3 mb-2">
              <h2 className="text-lg font-bold tracking-widest text-gray-300">{g}</h2>
              <span className={`text-xs font-bold ${groupCount(g) === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>{groupCount(g) === 0 ? '✓ limpo' : groupCount(g).toLocaleString('en-US') + ' pendências'}</span>
            </div>
            <div className="space-y-4">
              {/* Conciliação bancária mora na categoria BANK — lê/escreve por /api/bank/reconcile. */}
              {g === 'BANK' && <BankReconcileCard onCount={(n, ac) => { setBankCount(n); setBankAConferir(ac || 0) }} />}   {/* fase B: o balde tem card próprio (bucket-aging); o 3º argumento fica por conta da fila */}
              {checks.filter(c => c.group === g).map(c => (
          <div key={c.key} className={`border rounded-2xl overflow-hidden ${c.good ? 'border-emerald-800 bg-emerald-950/20' : c.items.length === 0 ? 'border-emerald-900/60' : 'border-gray-700'}`}>
            <button onClick={() => setOpen(open === c.key ? null : c.key)} className={`w-full text-left px-5 py-4 flex items-center gap-4 ${c.good ? 'bg-emerald-950/40 hover:bg-emerald-950/70' : 'bg-gray-900 hover:bg-gray-800'}`}>
              <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${c.good || c.items.length === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>
                {c.good ? (c.items.length ? c.items.length.toLocaleString('en-US') : '✓') : c.items.length === 0 ? '✓' : c.items.length}
              </span>
              <span className="flex-1">
                <span className="font-bold block">{c.good && <span className="text-[10px] font-bold text-emerald-300 border border-emerald-700 rounded-full px-2 py-0.5 mr-2 align-middle">SOZINHO</span>}{c.title}</span>
                <span className={`text-xs ${c.good ? 'text-emerald-200/70' : 'text-gray-500'}`}>{c.good ? c.blocks : `se ignorar: ${c.blocks}`}{c.impact ? ` · impacto ${usd(c.impact)}` : ''}</span>
              </span>
              <span className="text-gray-500">{open === c.key ? '▴' : '▾'}</span>
            </button>
            {open === c.key && guided?.key === c.key && (() => {
              const list = filtered(c)
              const resolved = Math.max(0, guided.start - list.length)
              if (!list.length) return (
                <div className="px-5 py-8 border-t border-gray-800 text-center">
                  <p className="text-2xl font-bold text-emerald-400">Fila zerada aqui 🎉</p>
                  <p className="text-sm text-gray-400 mt-1">{resolved} resolvido(s) nesta sessão guiada.</p>
                  <button onClick={() => setGuided(null)} className="mt-4 bg-gray-800 hover:bg-gray-700 border border-gray-600 px-4 py-2 rounded-xl font-bold text-sm">VOLTAR À LISTA</button>
                </div>
              )
              const gi = Math.min(guided.idx, list.length - 1)
              const it = list[gi]
              const go = (n: number) => { const ni = (n + list.length) % list.length; setGuided({ ...guided, idx: ni }); setGval(gPrefill(list[ni])) }
              const apply = (v: string) => applyFix(c, it, v).then(() => setGval(''))
              return (
                <div className="px-5 py-6 border-t border-gray-800">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-xs font-bold text-gray-500 shrink-0">MODO GUIADO · item {gi + 1} de {list.length}{resolved ? ` · ${resolved} resolvido(s) agora` : ''}</span>
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden"><div className="h-full bg-indigo-600" style={{ width: `${guided.start ? Math.round(100 * resolved / guided.start) : 0}%` }} /></div>
                    <button onClick={() => setGuided(null)} className="text-xs text-gray-400 hover:text-white underline shrink-0">sair (lista completa)</button>
                  </div>
                  <div className="bg-black/40 border border-gray-800 rounded-2xl p-5">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-800 text-gray-300">{it.code}</span>
                      {it.when && <span className="text-xs text-gray-500">{String(it.when).slice(0, 10)}</span>}
                      {it.amount != null && it.amount !== 0 && <span className="tabular-nums font-bold text-amber-300">{usd(it.amount)}</span>}
                    </div>
                    <p className="text-xl font-bold mt-2">{it.label}</p>
                    {it.extra && <p className="text-sm text-gray-400 mt-1">{it.extra}</p>}
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <a href={`${BASE_PATH}${it.href}`} target="_blank" rel="noreferrer" className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1.5 rounded-xl font-bold text-xs">ABRIR REGISTRO ↗</a>
                      {it.link && <a href={it.link.href} target="_blank" rel="noreferrer" className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1.5 rounded-xl font-bold text-xs text-sky-300">{it.link.label}</a>}
                    </div>
                    <div className="mt-4">
                      {!it.fix ? <p className="text-sm text-gray-500">só leitura — confira pelo ABRIR e PULE quando estiver ok</p>
                        : it.fix.kind === 'select' ? (
                          <div className="flex gap-2 items-center flex-wrap">
                            <select value={gval} onChange={e => setGval(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && gval && gval !== '__search__' && !saving) { e.preventDefault(); apply(gval) } }} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm max-w-xl">
                              <option value="">— escolher —</option>
                              {it.fix.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <button disabled={saving || !gval || gval === '__search__'} onClick={() => apply(gval)} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">APLICAR</button>
                            {gval && gval === it.suggest && <span className="text-xs text-gray-500">sugestão pré-carregada — Enter aplica</span>}
                          </div>
                        ) : it.fix.kind === 'date' ? (
                          <div className="flex gap-2 items-center flex-wrap">
                            <input type="date" value={gval} onChange={e => setGval(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm" />
                            <button disabled={saving || !gval} onClick={() => apply(gval)} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">APLICAR</button>
                          </div>
                        ) : it.fix.kind === 'number' ? (
                          <div className="flex gap-2 items-center flex-wrap">
                            <input type="number" value={gval} onChange={e => setGval(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-40" />
                            <button disabled={saving || !gval} onClick={() => apply(gval)} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">APLICAR</button>
                          </div>
                        ) : it.fix.kind === 'trim' ? <p className="text-sm text-gray-500">este tipo (APARAR) tem controle próprio — use a lista completa</p>
                        : (
                          <div>
                            {(it.fix.kind === 'flag' || it.fix.kind === 'trash' || it.fix.kind === 'purge' || it.fix.kind === 'rematch' || it.fix.kind === 'unmatch' || it.fix.kind === 'adopt' || it.fix.kind === 'unlink' || it.fix.kind === 'undo_category' || it.fix.kind === 'enable_autofill' || it.fix.kind === 'undo_auto' || it.fix.kind === 'dismiss' || it.fix.kind === 'match') && <p className="text-sm text-gray-300 mb-2">{it.fix.confirmText}</p>}
                            <button disabled={saving} onClick={() => apply('')} className={`${it.fix.kind === 'trash' || it.fix.kind === 'purge' ? 'bg-red-800 hover:bg-red-700' : 'bg-emerald-700 hover:bg-emerald-600'} disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm`}>{it.fix.kind === 'received' ? 'CONFIRMAR BAIXA' : it.fix.kind === 'trash' ? 'APAGAR' : it.fix.kind === 'purge' ? 'PURGAR' : it.fix.kind === 'rematch' ? 'TROCAR' : it.fix.kind === 'unmatch' ? 'DESFAZER' : it.fix.kind === 'adopt' ? 'ADOTAR' : it.fix.kind === 'unlink' ? 'SOLTAR' : it.fix.kind === 'undo_category' ? 'DESFAZER' : it.fix.kind === 'enable_autofill' ? 'LIGAR' : it.fix.kind === 'undo_auto' ? 'DESFAZER' : it.fix.kind === 'dismiss' ? 'VISTO' : it.fix.kind === 'match' ? 'CASAR' : 'CONFIRMAR'}</button>
                          </div>
                        )}
                      {c.key === 'parts-identity' && gval === '__search__' && it.fix && (
                        <div className="mt-2 max-w-xl"><PartPicker onPick={p => apply(p.id)} placeholder="buscar a peça no catálogo (PN, nome, apelido)…" /></div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => go(gi - 1)} className="bg-gray-900 hover:bg-gray-800 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">← VOLTAR</button>
                    <button onClick={() => go(gi + 1)} className="bg-gray-900 hover:bg-gray-800 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">PULAR →</button>
                  </div>
                </div>
              )
            })()}
            {open === c.key && guided?.key !== c.key && (
              <div className="px-5 py-4 border-t border-gray-800">
                {/* UX it.2: uma linha, não um parágrafo — o porquê completo só pra quem pedir. */}
                <div className="mb-3 flex items-center gap-4 flex-wrap">
                  <button onClick={() => setWhyOpen(whyOpen === c.key ? null : c.key)} className="text-xs text-gray-500 hover:text-gray-300 underline">{whyOpen === c.key ? 'entender esta checagem ▴' : 'entender esta checagem ▾'}</button>
                  {/* item-nature não tem MODO GUIADO: o guiado é "um de cada vez",
                      e ali a unidade é o GRUPO — passar de fornecedor em fornecedor
                      com 5 botões já é o modo guiado dele. */}
                  {c.key !== 'item-nature' && !c.good && filtered(c).length > 1 && (
                    <button onClick={() => { const l = filtered(c); setGuided({ key: c.key, idx: 0, start: l.length }); setGval(gPrefill(l[0])) }} className="bg-indigo-800 hover:bg-indigo-700 px-3 py-1.5 rounded-xl font-bold text-xs">▶ MODO GUIADO — um de cada vez</button>
                  )}
                </div>
                {whyOpen === c.key && <p className="text-sm text-gray-400 -mt-1 mb-3 max-w-2xl">{c.why}</p>}
                {c.items.some(i => i.certain) && (
                  <div className="flex items-center gap-3 mb-3">
                    <button disabled={saving} onClick={() => applyCertain(c)} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                      {bulk ? `PREENCHENDO ${bulk}…` : `PREENCHER CERTOS (${c.items.filter(i => i.certain).length})`}
                    </button>
                    <span className="text-xs text-gray-500">{CERTAIN_PROOF[c.key] || 'itens com prova, não palpite'}</span>
                  </div>
                )}
                {c.key === 'paid-from' && c.items.length > 0 && (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <select value={sigFilter[c.key] || ''} onChange={e => setSigFilter({ ...sigFilter, [c.key]: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm">
                      <option value="">sinal: todos</option>
                      <option value="matched">casada / pedido casado (certo)</option>
                      <option value="pre-open">antes da Regions abrir</option>
                      <option value="absent">fora da Regions</option>
                      <option value="present">encontrada na Regions</option>
                      <option value="conflict">conflito com SOURCE</option>
                      <option value="source">só SOURCE</option>
                    </select>
                    <input value={filter[c.key] || ''} onChange={e => setFilter({ ...filter, [c.key]: e.target.value })} placeholder="filtrar: 2025-09, US.013, High Horse…" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-72" />
                    <select value={bulkValue[c.key] || ''} onChange={e => setBulkValue({ ...bulkValue, [c.key]: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm">
                      <option value="">— marcar como —</option>
                      {PAID_FROM_SELECT.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <button disabled={saving || !((filter[c.key] || '').trim() || sigFilter[c.key]) || !bulkValue[c.key]} onClick={() => applyFiltered(c)} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">
                      {bulk ? `MARCANDO ${bulk}…` : `MARCAR OS ${filtered(c).length} FILTRADOS`}
                    </button>
                    <span className="text-xs text-gray-500">{filtered(c).length} de {c.items.length} · {c.items.filter(i => i.signal === 'pre-open').length} antes da conta · {c.items.filter(i => i.signal === 'absent').length} fora · {c.items.filter(i => i.signal === 'present').length} encontradas · {c.items.filter(i => i.signal === 'conflict').length} em conflito</span>
                  </div>
                )}
                {/* O card "o que é esta linha?" tem corpo próprio: a unidade de
                    trabalho é o GRUPO DE FORNECEDOR (com exceção por linha), e a
                    lista padrão de itens não sabe fazer isso. */}
                {c.key === 'item-nature' ? <NatureWorkbench sig={nature} setSig={setNature} />
                : c.key === 'auto-book' && bank.autobook ? <AutoBookBoard ab={bank.autobook} check={c} saving={saving} done={done} onFix={(ck, it) => applyFix(ck, it, '')} />
                : c.items.length === 0 ? <p className="text-emerald-400 font-bold">{c.good ? 'O app não preencheu nada sozinho nos últimos 7 dias.' : 'Nada pendente aqui.'}</p> : (
                  <div className="max-h-[32rem] overflow-y-auto divide-y divide-gray-800">
                    {filtered(c).map((it, i) => {
                      const fixKey = it.fix ? c.key + '|' + it.fix.rowId : ''
                      return (
                        <div key={i}>
                          <div className="flex items-baseline gap-3 py-2 px-2">
                            <span className="text-gray-400 text-xs w-20 shrink-0 font-bold">{it.code}</span>
                            <a href={`${BASE_PATH}${it.href}`} target="_blank" rel="noreferrer" className="flex-1 truncate text-sm hover:text-white hover:underline" title={`${it.code} · ${it.label}${it.extra ? ' — ' + it.extra : ''} (abre em aba nova)`}>{it.label}</a>
                            {it.extra && <span className="text-xs text-gray-500 shrink-0">{it.extra}</span>}
                            {it.link && <a href={it.link.href} target="_blank" rel="noreferrer" className="text-xs font-bold text-sky-300 hover:underline shrink-0">{it.link.label}</a>}
                            {it.amount !== undefined && <span className="tabular-nums font-bold text-sm shrink-0">{usd(it.amount)}</span>}
                            {it.fix && (
                              <button onClick={() => { setFixing(fixing === fixKey ? null : fixKey); setFixValue(fixing === fixKey ? '' : (it.suggest || '')) }}
                                className={`px-3 py-1 rounded-xl text-xs font-bold shrink-0 ${fixing === fixKey ? 'bg-white text-black' : 'bg-blue-700 hover:bg-blue-600'}`}>
                                {it.fix.kind === 'received' ? 'BAIXA' : it.fix.kind === 'flag' ? 'MARCAR' : it.fix.kind === 'trim' ? 'APARAR' : it.fix.kind === 'trash' ? 'APAGAR' : it.fix.kind === 'purge' ? 'PURGAR' : it.fix.kind === 'rematch' ? 'TROCAR' : it.fix.kind === 'unmatch' ? 'DESFAZER' : it.fix.kind === 'adopt' ? 'ADOTAR' : it.fix.kind === 'unlink' ? 'SOLTAR' : it.fix.kind === 'undo_category' ? 'DESFAZER' : it.fix.kind === 'enable_autofill' ? 'LIGAR' : it.fix.kind === 'undo_auto' ? 'DESFAZER' : it.fix.kind === 'dismiss' ? 'VISTO' : it.fix.kind === 'match' ? 'CASAR' : 'FIX'}
                              </button>
                            )}
                          </div>
                          {it.fix && fixing === fixKey && (
                            <div className="bg-black/40 border border-gray-800 rounded-2xl p-4 mb-3 mx-2 grid grid-cols-1 gap-4">
                              {it.fix.kind === 'date' && (
                                <div>
                                  <DatePicker compact label={it.fix.field.toUpperCase()} value={fixValue} onChange={setFixValue} />
                                  {it.suggest && <p className="mt-1 text-xs text-sky-300">Sugestão pré-carregada: última atividade do invoice ({formatShortDate(it.suggest)}) — ajuste se precisar.</p>}
                                </div>
                              )}
                              {it.fix.kind === 'select' && (
                                <div>
                                  <label className="block mb-1 text-xs font-bold">{it.fix.field.toUpperCase()}</label>
                                  <select value={fixValue} onChange={e => setFixValue(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm">
                                    <option value="">— escolher —</option>
                                    {it.fix.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                  {c.key === 'parts-identity' && fixValue === '__search__' && (
                                    <div className="mt-2"><PartPicker onPick={p => applyFix(c, it, p.id)} placeholder="buscar a peça no catálogo (PN, nome, apelido)…" /></div>
                                  )}
                                  {it.suggest && <p className="mt-1 text-xs text-sky-300">{it.certain ? 'Certo: esta linha já casou com uma linha da Regions.' : `Sugestão pré-carregada: ${it.suggest} (${it.extra || 'campo SOURCE'}) — ajuste se precisar.`}</p>}
                                </div>
                              )}
                              {it.fix.kind === 'number' && (
                                <div>
                                  <label className="block mb-1 text-xs font-bold">{it.fix.field.toUpperCase()}{it.fix.suffix ? ` (${it.fix.suffix})` : ''}</label>
                                  <input type="text" inputMode="decimal" value={fixValue}
                                    onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setFixValue(e.target.value) }}
                                    className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm" placeholder="0" autoFocus />
                                </div>
                              )}
                              {it.fix.kind === 'trim' && (
                                <div>
                                  <label className="block mb-1 text-xs font-bold">FIM REAL DO SEGMENTO (hora de Orlando)</label>
                                  <input type="datetime-local" value={fixValue} onChange={e => setFixValue(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm" />
                                  <p className="mt-1 text-xs text-sky-300">Sugestão pré-carregada: início + limite. O aparo desconta só o excesso que o segmento bancou; tudo vai pra trilha e a história ganha um evento TRIMMED.</p>
                                </div>
                              )}
                              {(it.fix.kind === 'flag' || it.fix.kind === 'trash' || it.fix.kind === 'purge' || it.fix.kind === 'rematch' || it.fix.kind === 'unmatch' || it.fix.kind === 'adopt' || it.fix.kind === 'unlink' || it.fix.kind === 'undo_category' || it.fix.kind === 'enable_autofill' || it.fix.kind === 'undo_auto' || it.fix.kind === 'dismiss' || it.fix.kind === 'match') && <p className="text-sm text-gray-300">{it.fix.confirmText}</p>}
                              {it.fix.kind === 'received' && <p className="text-sm text-gray-300">Confirma que este pagamento FOI RECEBIDO? A baixa entra com data de hoje e o valor vira caixa no DFC.</p>}
                              <div className="flex gap-3 items-center">
                                <button onClick={() => { setFixing(null); setFixValue('') }} className="text-gray-400 font-bold px-2 text-sm">Cancel</button>
                                <button disabled={saving || (it.fix.kind !== 'received' && it.fix.kind !== 'flag' && it.fix.kind !== 'purge' && it.fix.kind !== 'rematch' && it.fix.kind !== 'unmatch' && it.fix.kind !== 'adopt' && it.fix.kind !== 'unlink' && it.fix.kind !== 'undo_category' && it.fix.kind !== 'enable_autofill' && it.fix.kind !== 'undo_auto' && it.fix.kind !== 'dismiss' && it.fix.kind !== 'match' && !fixValue)}
                                  onClick={() => applyFix(c, it, fixValue)}
                                  className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                                  {saving ? 'SAVING…' : it.fix.kind === 'received' ? 'CONFIRMAR BAIXA' : it.fix.kind === 'flag' ? 'CONFIRMAR' : it.fix.kind === 'trim' ? 'APARAR SEGMENTO' : it.fix.kind === 'trash' ? 'APAGAR AGORA' : it.fix.kind === 'purge' ? 'PURGAR AGORA' : it.fix.kind === 'rematch' ? 'TROCAR AGORA' : it.fix.kind === 'unmatch' ? 'DESFAZER AGORA' : it.fix.kind === 'adopt' ? 'ADOTAR AGORA' : it.fix.kind === 'unlink' ? 'SOLTAR AGORA' : it.fix.kind === 'undo_category' ? 'DESFAZER AGORA' : it.fix.kind === 'enable_autofill' ? 'LIGAR AGORA' : it.fix.kind === 'undo_auto' ? 'DESFAZER AGORA' : it.fix.kind === 'dismiss' ? 'VISTO, ESTÁ CERTO' : it.fix.kind === 'match' ? 'CASAR AGORA' : 'SALVAR'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm text-gray-500 max-w-3xl">Fora do checklist (são obra, não conserto): capital e empréstimos (lançar em LEDGERS) e a integração bancária Plaid, que vai conferir tudo isso contra o extrato de verdade.</p>

      {/* Changelog próprio — DATA CHECK versiona independente do FINANCIAL. */}
      <div className="mt-10 max-w-4xl">
        <h2 className="text-xl font-bold mb-3 text-gray-300">CHANGELOG</h2>
        <div className="border border-gray-800 rounded-2xl divide-y divide-gray-800">
          {DC_CHANGELOG.map(c => (
            <div key={c.version} className="px-4 py-3 flex gap-4 items-baseline">
              <span className="font-bold tabular-nums text-sky-300 w-16 shrink-0">v{c.version}</span>
              <span className="text-gray-500 text-xs w-20 shrink-0">{c.date}</span>
              <span className="text-sm text-gray-400">{c.notes}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
