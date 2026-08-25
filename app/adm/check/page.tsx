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
import { useEffect, useMemo, useState } from 'react'
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

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
// Relógio do app = Orlando (regra de 20/08): depois das 20h o UTC já é amanhã.
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const CAR_RX = /car purchase|compra |challenger|charger|demon|hellcat|redeye|widebody|superstock|camaro|z\/28/i

type Fix =
  | { kind: 'date'; table: string; rowId: string; field: string }
  | { kind: 'select'; table: string; rowId: string; field: string; options: { value: string; label: string }[]; current?: string | null; spelling?: string; sup?: string; ebay?: string | null }
  | { kind: 'number'; table: string; rowId: string; field: string; suffix?: string }
  | { kind: 'flag'; table: string; rowId: string; field: string; value: boolean; confirmText: string }
  | { kind: 'trash'; table: string; rowId: string; field: string; confirmText: string }
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
}
const fixField = (f: Fix) => (f.kind === 'received' ? 'paid_at' : f.field)
// Categorias do Data Checker (João, 22/ago: inglês, casando com o menu do app).
// STAFF, TAX e SYSTEM já existem na ordem — os cards deles chegam com as features
// (duty timer, 1099, FL sales tax); seção sem card não aparece.
const GROUP_ORDER = ['BANK', 'FINANCIAL', 'RIDES', 'INVOICES', 'INVENTORY', 'STAFF', 'TAX', 'SYSTEM'] as const
type Group = typeof GROUP_ORDER[number]
type Check = { group: Group; key: string; title: string; why: string; blocks: string; items: Item[]; impact?: number }

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
type CatRow = { id: string; item: string; current: string | null; suggest: string | null }
type SupRow = { id: string; text: string; part: string; candidates: { id: string; label: string; certain: boolean }[]; ebay?: string | null; ebay_bare?: boolean; ebay_item?: string | null }
type LinkerSignal = { state: 'loading' | 'error' | 'ok'; needsMigration: boolean; needsSupplierMigration: boolean; totals: { parts: number; locked: number; inv_unlinked: number; inv_total: number; ps_unlinked: number; ps_total: number; no_pn: number; dup_pn: number; sup_unlinked?: number; map_bad?: number } | null; inventory: LinkerRow[]; streams: LinkerRow[]; no_pn: { id: string; item: string }[]; dup_pn: { pn: string; items: string[] }[]; suppliers_unlinked: SupRow[]; suppliers_all: { id: string; name: string }[]; map_bad: { id: string; item: string; cost: number; map: number }[]; no_source: string[]; kit_mismatch: { item: string; st: string | null; kit: boolean }[]; ebay_pn: { id: string; item: string; listing: string; suggest: string | null; supplier: string }[]; categories: CatRow[]; category_vocab: string[] }
type TaxPayee = { key: string; name: string; total: number; classification: string | null; w9_on_file: boolean }
type TaxSignal = { state: 'loading' | 'error' | 'ok'; needsMigration: boolean; years: { year: string; payees: TaxPayee[] }[] }
type BankSignal = { matched: Set<string>; groups: Map<string, number>; outflows: Map<string, string[]>; opened: string; cash: CashItem[] | null; cashState: 'loading' | 'error' | 'ok' }
const REGIONS_OPENED = '2025-11-10'
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
function buildChecks(d: FinData, bank: BankSignal, tax: TaxSignal, duty: DutySignal, linker: LinkerSignal): Check[] {
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
      items.push({
        href: '/rides/edit/' + r.id, code: r.project_code || '—',
        label: r.project_name || [r.model, r.version].filter(Boolean).join(' '),
        extra: r.title_scope === 'EXPORT' ? 'GZ28 EXPORT' : '3RD PARTY EXPORT',
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
    const fx = d.fixedExpenses.filter((e: any) => !e.payment_date && (!due(e) || due(e) <= TODAY) && !(supEnd(e) && due(e) && due(e) > supEnd(e)!))
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
      if (end && due2 && due2 > end) items.push({
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
        items.push({ href: m.href, code: m.code, label: whoFor(inv.id), extra: inv.live_status + ' — precisa de linhas, abre em aba nova', amount: sched })
        impact += sched
      }
    }
    checks.push({
      group: 'INVOICES', key: 'zero-billed', title: 'Invoice recebeu dinheiro mas não tem nenhuma linha', blocks: 'dinheiro entrou por um serviço que não existe no papel',
      why: 'Dinheiro entrou mas a invoice não fatura nada — vira adiantamento de cliente eterno no Balanço. Ou as linhas são preenchidas, ou o job legado fecha contra resultado de abertura.',
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
      const certain = matched.has(table + ':' + r.id) || groupCertain
      let suggest: string | undefined, extra: string | undefined, signal = 'source'
      if (certain) { suggest = 'GZ28US'; extra = groupCertain ? 'pedido casado com a Regions' : 'casada com a Regions'; signal = 'matched' }
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
          else { suggest = 'GZ28BR'; extra = 'fora da Regions'; signal = 'absent' }
        }
        else if (r.source === 'GZ28BR' || r.source === 'GZ28US') { suggest = r.source; extra = 'sugestão: ' + r.source; signal = 'source' }
      }
      return {
        href, code, label, amount, certain, suggest, extra, signal, when: date || undefined,
        fix: { kind: 'select' as const, table, rowId: r.id, field: 'paid_from', options: PAID_FROM_SELECT, current: null },
      }
    }
    const items: Item[] = [
      ...d.invExpenses.filter((e: any) => !e.paid_from).map((e: any) => { const m = invoiceMeta(d, e.invoice_id); return mk('invoice_expenses', e, 'PROJ', m.href, [m.code, m.car, e.item, e.supplier].filter(Boolean).join(' · '), expLine(e)) }),
      ...d.fixedExpenses.filter((e: any) => !e.paid_from).map((e: any) => mk('fixed_cost_expenses', e, 'FIXO', e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', [d.fixedSuppliers.get(e.supplier_id)?.company, e.description].filter(Boolean).join(' · '), parseFloat(e.amount) || 0)),
      ...d.expenses.filter((e: any) => !e.paid_from).map((e: any) => mk('expenses', e, e.origin === 'PERSONAL' ? 'PESSOAL' : 'FOLHA', '/staff', e.description || e.type || '', parseFloat(e.amount) || 0)),
      ...d.goods.filter((g: any) => !g.paid_from).map((g: any) => mk('goods', g, 'GOODS', '/goods', [g.description, g.supplier].filter(Boolean).join(' · '), qtyLine(g))),
      ...d.goodExpenses.filter((g: any) => !g.paid_from).map((g: any) => mk('good_expenses', g, 'GOODS', '/goods', g.description || '', parseFloat(g.amount) || 0)),
      ...d.inputs.filter((x: any) => !x.paid_from).map((x: any) => mk('inputs', x, 'INPUT', '/inputs', [x.description, x.category].filter(Boolean).join(' · '), qtyLine(x))),
      ...d.inventory.filter((x: any) => x.source_type === 'PURCHASED' && !x.paid_from).map((x: any) => mk('inventory', x, 'STOCK', '/inventory', x.description || '', qtyLine(x))),
    ].sort((a, b) => Number(!!b.certain) - Number(!!a.certain) || (b.amount || 0) - (a.amount || 0))
    checks.push({
      group: 'FINANCIAL', key: 'paid-from', title: 'Quem pagou esta conta?', blocks: 'o caixa por banco sai errado e a conciliação não fecha',
      why: 'Quem pagou define a conta corrente com a GZ28BR e o empréstimo de sócio (Beto) no Balanço — e sem isso o motor do Bank Link trata a linha como possível Regions. Sinais: casada/pedido casado com a Regions = GZ28US na certa (PREENCHER CERTOS); antes de 10/nov/2025 a conta nem existia = GZ28BR ou BETO (sem palpite — decidam); "fora da Regions" = provavelmente não foi GZ28US; conflito com SOURCE = conferir um a um. Use o filtro de SINAL + texto (mês, invoice, fornecedor) e marque os filtrados de uma vez.',
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
      if (!p.classification) items.push({ href: '/adm/tax', code: y.year, label: `${p.name}: ${usd(p.total)} no ano — classificar (serviço? mercadoria? corporação?)`, amount: p.total, when: y.year })
      else if (p.classification === 'SERVICE' && !p.w9_on_file) items.push({ href: '/adm/tax', code: y.year, label: `${p.name}: SERVIÇO ${usd(p.total)} sem W-9 em arquivo`, extra: `1099-NEC até 31/jan/${Number(y.year) + 1}`, amount: p.total, when: y.year })
    }
    checks.push({
      group: 'TAX', key: 'tax-1099', title: 'Pagamos alguém $600+ no ano — o 1099 está em dia?',
      blocks: 'obrigação anual (31/jan) — 1099 não emitido dá multa',
      why: 'Todo beneficiário pago por Zelle, wire ou cheque com $600+ no ano precisa de um veredito: serviço (pede 1099-NEC e W-9), mercadoria, corporação ou pessoal. O extrato lista quem recebeu; o TAX SHIELD grava a classificação; a Drummond confirma a lei. Sem W-9 na mão, janeiro vira correria.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
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

  // INVENTORY · CATEGORIAS — vocabulário fechado (13), 650 vazias com palpite
  // por palavra-chave. Palpite é palpite: martelo é humano, sem bulk cego.
  {
    const items: Item[] = []
    const vocab = linker.category_vocab.length ? linker.category_vocab : []
    for (const c of linker.categories) items.push({
      href: '/parts', code: c.current ? 'FORA VOC.' : 'SEM CAT.',
      label: `${c.item}${c.current ? ` · hoje: "${c.current}"` : ''}`,
      extra: c.suggest ? 'palpite: ' + c.suggest : 'sem palpite — escolha',
      suggest: c.suggest || undefined, signal: c.suggest ? 'source' : undefined,
      fix: vocab.length ? { kind: 'select' as const, table: 'parts_database', rowId: c.id, field: 'category', options: vocab.map(v => ({ value: v, label: v })), current: c.current } : undefined,
    })
    checks.push({
      group: 'INVENTORY', key: 'parts-category', title: 'Peça sem categoria', blocks: 'ninguém acha a peça na hora de montar um pacote',
      why: 'Decisão de 24/ago (João+Márcio): categoria entra pra valer, com 13 valores fechados. O app dá o palpite por palavra-chave (supercharger → ENGINE, injector → FUEL SYSTEM…); quem bate o martelo é você — por isso não tem bulk aqui: palpite não é prova.',
      items,
    })
  }

  return checks
}

export default function DataCheckPage() {
  const [d, setD] = useState<FinData | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)   // `${check}|${rowId}`
  const [fixValue, setFixValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<Set<string>>(new Set())    // rowIds consertados nesta visita
  const [showHistory, setShowHistory] = useState(false)
  const [reloadN, setReloadN] = useState(0)
  const [bankCount, setBankCount] = useState(0)   // linhas NEW do banco (card próprio)
  const [bank, setBank] = useState<BankSignal>({ matched: new Set(), groups: new Map(), outflows: new Map(), opened: REGIONS_OPENED, cash: null, cashState: 'loading' })   // sinal da Regions
  const [tax, setTax] = useState<TaxSignal>({ state: 'loading', needsMigration: false, years: [] })   // sinal do 1099 (TAX HUB)
  const [duty, setDuty] = useState<DutySignal>({ state: 'loading', maxHours: 10, incidents: [], history: { absurd: [], comps: [] } })   // sinal do STAFF DUTY WATCH
  const [linker, setLinker] = useState<LinkerSignal>({ state: 'loading', needsMigration: false, needsSupplierMigration: false, totals: null, inventory: [], streams: [], no_pn: [], dup_pn: [], suppliers_unlinked: [], suppliers_all: [], map_bad: [], no_source: [], kit_mismatch: [], ebay_pn: [], categories: [], category_vocab: [] })   // identidade de peças
  const [bulk, setBulk] = useState<string>('')   // progresso do bulk
  const [filter, setFilter] = useState<Record<string, string>>({})     // filtro por card
  const [sigFilter, setSigFilter] = useState<Record<string, string>>({})   // filtro por SINAL (exato, sem armadilha de substring — revisão #4)
  const [groupFilter, setGroupFilter] = useState<string | null>(null)      // chip de categoria
  const [whyOpen, setWhyOpen] = useState<string | null>(null)              // "entender esta checagem" aberto
  const [bulkValue, setBulkValue] = useState<Record<string, string>>({})   // valor do "marcar filtrados como" por card

  useEffect(() => {
    setD(null); setError('')
    loadFinancials().then(setD).catch(e => setError(String(e?.message || e)))
    // Pares casados com a Regions — melhor esforço (sem sessão/servidor o card só perde o "certo").
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/bank/reconcile?matched=1`, { headers: await sessionHeaders() })
        const j = await r.json().catch(() => ({}))
        if (r.ok && Array.isArray(j.matched)) {
          const outflows = new Map<string, string[]>()
          for (const o of (j.outflows || []) as { d: string; a: number }[]) { const k = Number(o.a).toFixed(2); outflows.set(k, [...(outflows.get(k) || []), o.d]) }
          // Grupo casado carrega o VALOR do banco: membro só é "certo" enquanto o
          // total do pedido ainda bate com o que o banco cobrou (revisão #1).
          const groups = new Map<string, number>()
          for (const m of j.matched as { table: string; id: string; amount: number }[]) if (m.table === 'purchase_group') groups.set(m.id, Number(m.amount) || 0)
          setBank(prev => ({ ...prev, matched: new Set((j.matched as { table: string; id: string }[]).map(m => m.table + ':' + m.id)), groups, outflows, opened: j.account_opened || REGIONS_OPENED }))
        }
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
        const rl = await fetch(`${BASE_PATH}/api/parts/link`, { headers: await sessionHeaders() })
        const jl = await rl.json().catch(() => ({}))
        if (rl.ok && jl.totals) setLinker({ state: 'ok', needsMigration: !!jl.needs_migration, needsSupplierMigration: !!jl.needs_supplier_migration, totals: jl.totals, inventory: jl.inventory || [], streams: jl.streams || [], no_pn: jl.no_pn || [], dup_pn: jl.dup_pn || [], suppliers_unlinked: jl.suppliers_unlinked || [], suppliers_all: jl.suppliers_all || [], map_bad: jl.map_bad || [], no_source: jl.no_source || [], kit_mismatch: jl.kit_mismatch || [], ebay_pn: jl.ebay_pn || [], categories: jl.categories || [], category_vocab: jl.category_vocab || [] })
        else setLinker(prev => ({ ...prev, state: 'error', needsMigration: !!jl.needs_migration }))
      } catch { setBank(prev => ({ ...prev, cashState: 'error' })) /* sem banco, sem certeza */ }
    })()
  }, [reloadN])

  const checks = useMemo(() => (d ? buildChecks(d, bank, tax, duty, linker) : []).map(c => ({ ...c, items: c.items.filter(i => !(i.fix && done.has(i.fix.rowId + '|' + fixField(i.fix)))) })), [d, done, bank, tax, duty, linker])
  const totalIssues = checks.reduce((s, c) => s + c.items.length, 0) + bankCount
  const groupCount = (g: string) => (g === 'BANK' ? bankCount : 0) + checks.filter(c => c.group === g).reduce((s, c) => s + c.items.length, 0)

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
      const { error: err } = await supabase.from(fix.table).update({ [field]: value }).eq('id', fix.rowId).is(field, null)
      if (err) { errors.push(`${it.code} · ${it.label}: ${err.message}`); continue }
      await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field, old_value: null, new_value: value, label: `${tag} · ${it.code} · ${it.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
      setDone(prev => new Set(prev).add(fix.rowId + '|' + field)); n++
    }
    setBulk(''); setSaving(false)
    if (errors.length) alert(`${n} preenchidas; ${errors.length} com erro:\n` + errors.slice(0, 8).join('\n'))
  }
  async function applyCertain(check: Check) {
    const items = check.items.filter(i => i.certain && i.suggest && i.fix && i.fix.kind === 'select')
    if (!items.length) return
    // LINKER/R1: cada linha tem o SEU valor certo — bulk um a um.
    if (check.key === 'parts-identity' || check.key === 'parts-suppliers') {
      const msg = check.key === 'parts-suppliers'
        ? `Linkar ${items.length} peças ao fornecedor oficial? Todas batem pelo nome/apelido exato. Tudo na trilha.`
        : `Linkar ${items.length} linhas ao catálogo? Todas têm o PN da peça no próprio texto — o número não mente. Tudo na trilha.`
      if (!confirm(msg)) return
      setSaving(true)
      let n = 0
      for (const it of items) {
        const fix = it.fix!
        setBulk(`${n + 1}/${items.length}`)
        const field = fix.kind === 'select' ? fix.field : 'part_id'
        const { error: err } = await supabase.from(fix.table).update({ [field]: it.suggest }).eq('id', fix.rowId).is(field, null)
        if (err) continue
        await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field, old_value: null, new_value: it.suggest, label: `LINK CERTO · ${it.code} · ${it.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
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
          {totalIssues > 0 && <span className="text-sm text-gray-400 ml-3">{checks.filter(c => c.items.length > 0).length} de {checks.length} verificações</span>}
        </div>
        <button onClick={() => { setDone(new Set()); setReloadN(x => x + 1) }} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-5 py-3 rounded-2xl font-bold">↻ REFRESH</button>
        <button onClick={() => setShowHistory(h => !h)} className={`px-5 py-3 rounded-2xl font-bold border ${showHistory ? 'bg-white text-black border-white' : 'bg-gray-900 hover:bg-gray-700 border-gray-700'}`}>HISTÓRICO</button>
      </div>

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

      <div className="space-y-6 max-w-4xl">
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
              {g === 'BANK' && <BankReconcileCard onCount={setBankCount} />}
              {checks.filter(c => c.group === g).map(c => (
          <div key={c.key} className={`border rounded-2xl overflow-hidden ${c.items.length === 0 ? 'border-emerald-900/60' : 'border-gray-700'}`}>
            <button onClick={() => setOpen(open === c.key ? null : c.key)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
              <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${c.items.length === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>
                {c.items.length === 0 ? '✓' : c.items.length}
              </span>
              <span className="flex-1">
                <span className="font-bold block">{c.title}</span>
                <span className="text-xs text-gray-500">se ignorar: {c.blocks}{c.impact ? ` · impacto ${usd(c.impact)}` : ''}</span>
              </span>
              <span className="text-gray-500">{open === c.key ? '▴' : '▾'}</span>
            </button>
            {open === c.key && (
              <div className="px-5 py-4 border-t border-gray-800">
                {/* UX it.2: uma linha, não um parágrafo — o porquê completo só pra quem pedir. */}
                <div className="mb-3">
                  <button onClick={() => setWhyOpen(whyOpen === c.key ? null : c.key)} className="text-xs text-gray-500 hover:text-gray-300 underline">{whyOpen === c.key ? 'entender esta checagem ▴' : 'entender esta checagem ▾'}</button>
                  {whyOpen === c.key && <p className="text-sm text-gray-400 mt-2 max-w-2xl">{c.why}</p>}
                </div>
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
                {c.items.length === 0 ? <p className="text-emerald-400 font-bold">Nada pendente aqui.</p> : (
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
                                {it.fix.kind === 'received' ? 'BAIXA' : it.fix.kind === 'flag' ? 'MARCAR' : it.fix.kind === 'trim' ? 'APARAR' : it.fix.kind === 'trash' ? 'APAGAR' : 'FIX'}
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
                              {(it.fix.kind === 'flag' || it.fix.kind === 'trash') && <p className="text-sm text-gray-300">{it.fix.confirmText}</p>}
                              {it.fix.kind === 'received' && <p className="text-sm text-gray-300">Confirma que este pagamento FOI RECEBIDO? A baixa entra com data de hoje e o valor vira caixa no DFC.</p>}
                              <div className="flex gap-3 items-center">
                                <button onClick={() => { setFixing(null); setFixValue('') }} className="text-gray-400 font-bold px-2 text-sm">Cancel</button>
                                <button disabled={saving || (it.fix.kind !== 'received' && it.fix.kind !== 'flag' && !fixValue)}
                                  onClick={() => applyFix(c, it, fixValue)}
                                  className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                                  {saving ? 'SAVING…' : it.fix.kind === 'received' ? 'CONFIRMAR BAIXA' : it.fix.kind === 'flag' ? 'CONFIRMAR' : it.fix.kind === 'trim' ? 'APARAR SEGMENTO' : it.fix.kind === 'trash' ? 'APAGAR AGORA' : 'SALVAR'}
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
