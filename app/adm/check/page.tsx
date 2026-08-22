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
  | { kind: 'select'; table: string; rowId: string; field: string; options: { value: string; label: string }[]; current?: string | null }
  | { kind: 'number'; table: string; rowId: string; field: string; suffix?: string }
  | { kind: 'flag'; table: string; rowId: string; field: string; value: boolean; confirmText: string }
  | { kind: 'received'; table: string; rowId: string }
// certain: a sugestão é prova, não palpite (ex.: a Regions já casou a linha) — entra no bulk PREENCHER CERTOS.
type Item = { href: string; code: string; label: string; extra?: string; amount?: number; fix?: Fix; suggest?: string; certain?: boolean }
const fixField = (f: Fix) => (f.kind === 'received' ? 'paid_at' : f.field)
type Check = { key: string; title: string; why: string; blocks: string; items: Item[]; impact?: number }

const DESTINY_OPTIONS = CAR_DESTINY.map(o => ({ value: o.value, label: o.option }))
const TYPE_OPTIONS = ['FIXED', 'APP', 'MARKETING', 'ASSET'].map(v => ({ value: v, label: v }))

const PAID_FROM_SELECT = PAID_FROM_OPTIONS.map(v => ({ value: v, label: v }))

// matched = pares "tabela:id" do app já casados com linha da Regions (/api/bank/reconcile?matched=1).
function buildChecks(d: FinData, matched: Set<string>): Check[] {
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
      key: 'conclusion', title: 'Invoices FECHADAS sem NENHUMA data derivável', blocks: 'DRE por período (G1)',
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
      key: 'destiny', title: 'Rides sem CAR DESTINY', blocks: 'Balanço (WIP × frota × carro de cliente)',
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
      key: 'destiny-review', title: 'DESTINY REVIEW — destinos contraditórios', blocks: 'Balanço · DRE (a classificação inteira)',
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
      key: 'admission-mileage', title: 'Export sem ADMISSION MILEAGE', blocks: 'validação de exportação (lei do 0km)',
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
      key: 'delivery-cycle', title: 'Ciclo de entrega inconsistente (delivery × EXPORTED)', blocks: 'Balanço (WIP) · ciclo do carro',
      why: 'Delivery date no passado em invoice FECHADA diz que o carro saiu — aí o selo EXPORTED tem que existir (um clique aqui confirma). E EXPORTED sem delivery date em invoice nenhuma não diz QUANDO saiu. Delivery em invoice aberta é promessa, não conta.',
      items,
    })
  }

  // 6 · Despesas de projeto sem payment_date (G6).
  {
    const rows = d.invExpenses.filter((e: any) => !e.payment_date)
    const items = rows.map((e: any) => {
      const m = invoiceMeta(d, e.invoice_id)
      return {
        href: m.href, code: m.code, label: e.item || '(despesa sem descrição)',
        extra: [whoFor(e.invoice_id), e.supplier].filter(Boolean).join(' · '), amount: expLine(e),
        fix: { kind: 'date' as const, table: 'invoice_expenses', rowId: e.id, field: 'payment_date' },
      }
    }).sort((a: Item, b: Item) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      key: 'undated-inv', title: 'Despesas de projeto sem PAYMENT DATE', blocks: 'Fornecedores a pagar · DFC',
      why: 'Sem data de pagamento a linha vira contas a pagar no Balanço e fica FORA do fluxo de caixa. Se já foi paga, lance a data aqui mesmo.',
      items, impact: rows.reduce((s: number, e: any) => s + expLine(e), 0),
    })
  }

  // 5 · Custos fixos e folha sem payment_date.
  {
    const fx = d.fixedExpenses.filter((e: any) => !e.payment_date)
    const st = d.expenses.filter((e: any) => !e.payment_date && e.origin !== 'PERSONAL')
    const items: Item[] = [
      ...fx.map((e: any) => {
        const sup = d.fixedSuppliers.get(e.supplier_id)
        return {
          href: e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', code: 'FIXO',
          label: [sup?.company, e.description].filter(Boolean).join(' · '), amount: parseFloat(e.amount) || 0,
          fix: { kind: 'date' as const, table: 'fixed_cost_expenses', rowId: e.id, field: 'payment_date' },
        }
      }),
      ...st.map((e: any) => ({
        href: '/staff', code: 'FOLHA', label: e.description || e.type || '', amount: parseFloat(e.amount) || 0,
        fix: { kind: 'date' as const, table: 'expenses', rowId: e.id, field: 'payment_date' },
      })),
    ].sort((a, b) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      key: 'undated-fixed', title: 'Custos fixos & folha sem PAYMENT DATE', blocks: 'Fornecedores a pagar · DFC',
      why: 'Mesma história do card anterior, nas tabelas de custo fixo e folha.',
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
      key: 'zero-billed', title: 'Invoices com pagamento e SEM LINHAS', blocks: 'A/R · adiantamentos fantasmas (D9)',
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
      key: 'untyped-supplier', title: 'Fornecedores fixos sem TIPO', blocks: 'DRE (linha "não classificado")',
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
      key: 'overdue-receipts', title: 'Recebimentos vencidos sem baixa', blocks: 'A/R · DFC (entradas)',
      why: 'Agendado pra uma data que já passou e sem paid_at. Se o dinheiro entrou, MARK RECEIVED dá a baixa agora (caixa de hoje). Se não entrou, é cobrança.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 9 · Estoque comprado sem payment_date.
  {
    const rows = d.inventory.filter((s: any) => s.source_type === 'PURCHASED' && !s.payment_date)
    checks.push({
      key: 'undated-stock', title: 'Estoque comprado sem PAYMENT DATE', blocks: 'DFC (investimentos)',
      why: 'Compra de estoque sem data de pagamento não entra no caixa de investimentos.',
      items: rows.map((r: any) => ({
        href: '/inventory', code: 'STOCK', label: r.description || '', amount: qtyLine(r),
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
    const mk = (table: string, r: any, code: string, href: string, label: string, amount: number): Item => {
      const certain = matched.has(table + ':' + r.id)
      const suggest = certain ? 'GZ28US' : (r.source === 'GZ28BR' || r.source === 'GZ28US') ? r.source : undefined
      return {
        href, code, label, amount, certain, suggest,
        extra: certain ? 'casada com a Regions' : suggest ? 'sugestão: ' + suggest : undefined,
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
      key: 'paid-from', title: 'Lançamentos sem PAID FROM (quem pagou?)', blocks: 'Bank Link (pool) · DFC por caixa',
      why: 'Sem "quem pagou" o motor do Bank Link trata a linha como possível Regions (ruído nos candidatos) e o DFC não separa o caixa dos EUA do Brasil. Linha já casada com a Regions é GZ28US na certa — o botão PREENCHER CERTOS resolve todas de uma vez; as outras têm a sugestão do campo SOURCE pré-carregada.',
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
    checks.push({
      key: 'cash-stale', title: 'Saldo de caixa ausente ou envelhecido', blocks: 'Balanço (caixa) · conciliação com o banco',
      why: 'O Balanço usa o último saldo por conta. Saldo velho é caixa mentindo — lance o fechamento de cada mês em LEDGERS até o Plaid assumir.',
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
  const [matched, setMatched] = useState<Set<string>>(new Set())   // "tabela:id" já casados com a Regions
  const [bulk, setBulk] = useState<string>('')   // progresso do PREENCHER CERTOS

  useEffect(() => {
    setD(null); setError('')
    loadFinancials().then(setD).catch(e => setError(String(e?.message || e)))
    // Pares casados com a Regions — melhor esforço (sem sessão/servidor o card só perde o "certo").
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/bank/reconcile?matched=1`, { headers: await sessionHeaders() })
        const j = await r.json().catch(() => ({}))
        if (r.ok && Array.isArray(j.matched)) setMatched(new Set(j.matched.map((m: { table: string; id: string }) => m.table + ':' + m.id)))
      } catch { /* sem banco, sem certeza */ }
    })()
  }, [reloadN])

  const checks = useMemo(() => (d ? buildChecks(d, matched) : []).map(c => ({ ...c, items: c.items.filter(i => !(i.fix && done.has(i.fix.rowId + '|' + fixField(i.fix)))) })), [d, done])
  const totalIssues = checks.reduce((s, c) => s + c.items.length, 0) + bankCount

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
  async function applyCertain(check: Check) {
    const items = check.items.filter(i => i.certain && i.suggest && i.fix && i.fix.kind === 'select')
    if (!items.length || !confirm(`Preencher ${items.length} linhas com ${items[0].suggest}? Todas já casaram com uma linha da Regions — o banco provou quem pagou.`)) return
    setSaving(true)
    const errors: string[] = []
    let n = 0
    for (const it of items) {
      const fix = it.fix!; const field = fixField(fix)
      setBulk(`${n + 1}/${items.length}`)
      const { error: err } = await supabase.from(fix.table).update({ [field]: it.suggest }).eq('id', fix.rowId).is(field, null)
      if (err) { errors.push(`${it.code} · ${it.label}: ${err.message}`); continue }
      await supabase.from('data_fixes').insert({ check_key: check.key, table_name: fix.table, row_id: fix.rowId, field, old_value: null, new_value: it.suggest, label: `CERTO (Regions) · ${it.code} · ${it.label}`.slice(0, 200) }).then(() => undefined, () => undefined)
      setDone(prev => new Set(prev).add(fix.rowId + '|' + field)); n++
    }
    setBulk(''); setSaving(false)
    if (errors.length) alert(`${n} preenchidas; ${errors.length} com erro:\n` + errors.slice(0, 8).join('\n'))
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

      <div className="space-y-4 max-w-4xl">
        {/* Conciliação bancária — lê/escreve por /api/bank/reconcile (tabelas só-service-key). */}
        <BankReconcileCard onCount={setBankCount} />
        {checks.map(c => (
          <div key={c.key} className={`border rounded-2xl overflow-hidden ${c.items.length === 0 ? 'border-emerald-900/60' : 'border-gray-700'}`}>
            <button onClick={() => setOpen(open === c.key ? null : c.key)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
              <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${c.items.length === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>
                {c.items.length === 0 ? '✓' : c.items.length}
              </span>
              <span className="flex-1">
                <span className="font-bold block">{c.title}</span>
                <span className="text-xs text-gray-500">trava: {c.blocks}{c.impact ? ` · impacto ${usd(c.impact)}` : ''}</span>
              </span>
              <span className="text-gray-500">{open === c.key ? '▴' : '▾'}</span>
            </button>
            {open === c.key && (
              <div className="px-5 py-4 border-t border-gray-800">
                <p className="text-sm text-gray-400 mb-3 max-w-2xl">{c.why}</p>
                {c.items.some(i => i.certain) && (
                  <div className="flex items-center gap-3 mb-3">
                    <button disabled={saving} onClick={() => applyCertain(c)} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                      {bulk ? `PREENCHENDO ${bulk}…` : `PREENCHER CERTOS (${c.items.filter(i => i.certain).length})`}
                    </button>
                    <span className="text-xs text-gray-500">linhas já casadas com a Regions → GZ28US; as demais seguem uma a uma pelo FIX</span>
                  </div>
                )}
                {c.items.length === 0 ? <p className="text-emerald-400 font-bold">Nada pendente aqui.</p> : (
                  <div className="max-h-[32rem] overflow-y-auto divide-y divide-gray-800">
                    {c.items.map((it, i) => {
                      const fixKey = it.fix ? c.key + '|' + it.fix.rowId : ''
                      return (
                        <div key={i}>
                          <div className="flex items-baseline gap-3 py-2 px-2">
                            <span className="text-gray-400 text-xs w-20 shrink-0 font-bold">{it.code}</span>
                            <a href={`${BASE_PATH}${it.href}`} target="_blank" rel="noreferrer" className="flex-1 truncate text-sm hover:text-white hover:underline" title={`${it.code} · ${it.label}${it.extra ? ' — ' + it.extra : ''} (abre em aba nova)`}>{it.label}</a>
                            {it.extra && <span className="text-xs text-gray-500 shrink-0">{it.extra}</span>}
                            {it.amount !== undefined && <span className="tabular-nums font-bold text-sm shrink-0">{usd(it.amount)}</span>}
                            {it.fix && (
                              <button onClick={() => { setFixing(fixing === fixKey ? null : fixKey); setFixValue(fixing === fixKey ? '' : (it.suggest || '')) }}
                                className={`px-3 py-1 rounded-xl text-xs font-bold shrink-0 ${fixing === fixKey ? 'bg-white text-black' : 'bg-blue-700 hover:bg-blue-600'}`}>
                                {it.fix.kind === 'received' ? 'BAIXA' : it.fix.kind === 'flag' ? 'MARCAR' : 'FIX'}
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
                                  {it.suggest && <p className="mt-1 text-xs text-sky-300">{it.certain ? 'Certo: esta linha já casou com uma linha da Regions.' : `Sugestão pré-carregada (campo SOURCE = ${it.suggest}) — ajuste se precisar.`}</p>}
                                </div>
                              )}
                              {it.fix.kind === 'number' && (
                                <div>
                                  <label className="block mb-1 text-xs font-bold">{it.fix.field.toUpperCase()}{it.fix.suffix ? ` (${it.fix.suffix})` : ''}</label>
                                  <input type="text" inputMode="decimal" value={fixValue}
                                    onChange={e => { if (/^d*.?d*$/.test(e.target.value)) setFixValue(e.target.value) }}
                                    className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm" placeholder="0" autoFocus />
                                </div>
                              )}
                              {it.fix.kind === 'flag' && <p className="text-sm text-gray-300">{it.fix.confirmText}</p>}
                              {it.fix.kind === 'received' && <p className="text-sm text-gray-300">Confirma que este pagamento FOI RECEBIDO? A baixa entra com data de hoje e o valor vira caixa no DFC.</p>}
                              <div className="flex gap-3 items-center">
                                <button onClick={() => { setFixing(null); setFixValue('') }} className="text-gray-400 font-bold px-2 text-sm">Cancel</button>
                                <button disabled={saving || (it.fix.kind !== 'received' && it.fix.kind !== 'flag' && !fixValue)}
                                  onClick={() => applyFix(c, it, fixValue)}
                                  className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                                  {saving ? 'SAVING…' : it.fix.kind === 'received' ? 'CONFIRMAR BAIXA' : it.fix.kind === 'flag' ? 'CONFIRMAR' : 'SALVAR'}
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
