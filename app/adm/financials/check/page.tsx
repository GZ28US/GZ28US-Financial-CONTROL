'use client'

// DATA CHECK — bancada de conserto dos dados, não só checklist.
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
import FinBadge from '@/components/FinBadge'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, CAR_DESTINY, formatShortDate } from '@/lib/utils'
import { loadFinancials, invoiceTotals, invoiceMeta, ledgerTotals, expLine, qtyLine, FinData } from '@/lib/financials'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const TODAY = new Date().toISOString().slice(0, 10)
const CAR_RX = /car purchase|compra |challenger|charger|demon|hellcat|redeye|widebody|superstock|camaro|z\/28/i

type Fix =
  | { kind: 'date'; table: string; rowId: string; field: string }
  | { kind: 'select'; table: string; rowId: string; field: string; options: { value: string; label: string }[]; current?: string | null }
  | { kind: 'received'; table: string; rowId: string }
type Item = { href: string; code: string; label: string; extra?: string; amount?: number; fix?: Fix }
const fixField = (f: Fix) => (f.kind === 'received' ? 'paid_at' : f.field)
type Check = { key: string; title: string; why: string; blocks: string; items: Item[]; impact?: number }

const DESTINY_OPTIONS = CAR_DESTINY.map(o => ({ value: o.value, label: o.option }))
const TYPE_OPTIONS = ['FIXED', 'APP', 'MARKETING', 'ASSET'].map(v => ({ value: v, label: v }))

function buildChecks(d: FinData): Check[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const checks: Check[] = []

  // 1 · Invoices sem data de conclusão (G1) — CLOSED primeiro, que é o pior caso.
  {
    const items = d.invoices
      .filter((i: any) => !i.conclusion_date)
      .sort((a: any, b: any) => (a.live_status === 'CLOSED' ? -1 : 1) - (b.live_status === 'CLOSED' ? -1 : 1))
      .map((i: any) => {
        const m = invoiceMeta(d, i.id)
        return {
          href: m.href, code: m.code, label: m.car || '—',
          extra: i.live_status + (i.live_status === 'CLOSED' ? ' — fechada sem data!' : ''),
          fix: { kind: 'date' as const, table: 'invoices', rowId: i.id, field: 'conclusion_date' },
        }
      })
    checks.push({
      key: 'conclusion', title: 'Invoices sem CONCLUSION DATE', blocks: 'DRE por período (G1)',
      why: 'Sem data de conclusão não existe o mês do resultado — a DRE fica presa no acumulado. As CLOSED são as urgentes: já acabaram e não dizem quando.',
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
      let billed = 0, received = 0, carBuy = 0, minMiles = Infinity
      for (const inv of invs) {
        const t = invoiceTotals(d, inv)
        billed += t.grand; received += t.received
        carBuy += d.invExpenses.filter((e: any) => e.invoice_id === inv.id && expLine(e) >= 15000 && CAR_RX.test(e.item || ''))
          .reduce((s: number, e: any) => s + expLine(e), 0)
        const mi = parseFloat(inv.mileage)
        if (mi > 0 && mi < minMiles) minMiles = mi
      }
      const client = r.client_id ? d.clients.get(r.client_id) : null
      const flags: string[] = []
      if ((scope === 'OWN' || scope === 'TOOL') && (billed > 0.005 || received > 0.005))
        flags.push(`carro NOSSO com faturamento de cliente (${usd(billed)} faturado, ${usd(received)} recebido)`)
      if ((scope === 'USA' || scope === 'CLIENT') && carBuy > 0)
        flags.push(`a LLC comprou o carro (${usd(carBuy)}) num carro marcado como "do cliente" — devia ser EXPORT ou OWN?`)
      if (scope === 'EXPORT' && client?.country === 'USA')
        flags.push('EXPORT com cliente dos EUA — vai exportar mesmo?')
      // Lei brasileira (Márcio, 20/ago): SÓ CARRO 0KM pode ser exportado ao
      // Brasil. Cliente brasileiro com residência nos EUA mantendo carro usado
      // aqui é NORMAL (caso Badillac/Nivaldo) — por isso BR+USA/CLIENT não é
      // flag. A prova de 0km é o selo DECLARADO no ride (milhagem sozinha não
      // decide: 0km chega com 9 ou 46 mi); o teto de 100 mi confere o selo.
      if (scope === 'EXPORT') {
        if (r.is_brand_new === false)
          flags.push('declarado USADO e marcado EXPORT — usado não entra no Brasil')
        else if (r.is_brand_new == null)
          flags.push('EXPORT sem o selo DELIVERY MILES — marque no ride pra confirmar')
        if (minMiles !== Infinity && minMiles > 100)
          flags.push(`milhagem de entrada ${Math.round(minMiles).toLocaleString('en-US')} mi acima do teto de exportação (100 mi)${r.is_brand_new ? ' — apesar do selo DELIVERY MILES, confira' : ''}`)
      }
      if (!flags.length) return
      items.push({
        href: '/rides/edit/' + r.id, code: r.project_code || '—',
        label: `${r.project_name || ''} [${scope}] — ${flags.join(' · ')}`,
        fix: { kind: 'select', table: 'rides', rowId: r.id, field: 'title_scope', options: DESTINY_OPTIONS, current: scope },
      })
    })
    checks.push({
      key: 'destiny-review', title: 'DESTINY REVIEW — destinos contraditórios', blocks: 'Balanço · DRE (a classificação inteira)',
      why: 'Cruza cada destino com o dinheiro e com a lei: carro OWN/TOOL não fatura cliente; carro USA/CLIENT a LLC nunca comprou; EXPORT só existe em carro 0km (usado não entra no Brasil); DONOR pode ter crédito de peça puxada, isso é normal. Cliente brasileiro com carro nos EUA é normal — muitos têm residência. Zero aqui = a classificação passou.',
      items,
    })
  }

  // 4 · Despesas de projeto sem payment_date (G6).
  {
    const rows = d.invExpenses.filter((e: any) => !e.payment_date)
    const items = rows.map((e: any) => {
      const m = invoiceMeta(d, e.invoice_id)
      return {
        href: m.href, code: m.code, label: e.item || '', extra: e.supplier || '', amount: expLine(e),
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
        items.push({ href: m.href, code: m.code, label: m.car || '—', extra: inv.live_status + ' — precisa de linhas, abre em aba nova', amount: sched })
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
        href: m.href, code: m.code, label: m.car || p.description || '', extra: 'vencido ' + formatShortDate(p.payment_date), amount: parseFloat(p.amount) || 0,
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

  // 10 · Caixa: migration pendente, nenhum saldo, ou saldo com mais de 35 dias.
  {
    const lt = ledgerTotals(d)
    const items: Item[] = []
    if (!lt) items.push({ href: '/adm/financials/ledgers', code: 'LIVROS', label: 'Rodar MIGRATION_financial_ledgers.sql no Supabase e lançar os primeiros saldos', extra: 'migration pendente' })
    else if (lt.cashAccounts.length === 0) items.push({ href: '/adm/financials/ledgers', code: 'CAIXA', label: 'Nenhum saldo de caixa lançado ainda', extra: 'Balanço sem linha de caixa' })
    else {
      const cutoff = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10)
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

  useEffect(() => {
    setD(null); setError('')
    loadFinancials().then(setD).catch(e => setError(String(e?.message || e)))
  }, [reloadN])

  const checks = useMemo(() => (d ? buildChecks(d) : []).map(c => ({ ...c, items: c.items.filter(i => !(i.fix && done.has(i.fix.rowId + '|' + fixField(i.fix)))) })), [d, done])
  const totalIssues = checks.reduce((s, c) => s + c.items.length, 0)

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
    const newValue = fix.kind === 'received' ? new Date().toISOString() : value
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

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DATA CHECK</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL</a>
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
                {c.items.length === 0 ? <p className="text-emerald-400 font-bold">Nada pendente aqui.</p> : (
                  <div className="max-h-[32rem] overflow-y-auto divide-y divide-gray-800">
                    {c.items.map((it, i) => {
                      const fixKey = it.fix ? c.key + '|' + it.fix.rowId : ''
                      return (
                        <div key={i}>
                          <div className="flex items-baseline gap-3 py-2 px-2">
                            <span className="text-gray-400 text-xs w-20 shrink-0 font-bold">{it.code}</span>
                            <a href={`${BASE_PATH}${it.href}`} target="_blank" rel="noreferrer" className="flex-1 truncate text-sm hover:text-white hover:underline" title="Abre em aba nova">{it.label}</a>
                            {it.extra && <span className="text-xs text-gray-500 shrink-0">{it.extra}</span>}
                            {it.amount !== undefined && <span className="tabular-nums font-bold text-sm shrink-0">{usd(it.amount)}</span>}
                            {it.fix && (
                              <button onClick={() => { setFixing(fixing === fixKey ? null : fixKey); setFixValue('') }}
                                className={`px-3 py-1 rounded-xl text-xs font-bold shrink-0 ${fixing === fixKey ? 'bg-white text-black' : 'bg-blue-700 hover:bg-blue-600'}`}>
                                {it.fix.kind === 'received' ? 'BAIXA' : 'FIX'}
                              </button>
                            )}
                          </div>
                          {it.fix && fixing === fixKey && (
                            <div className="bg-black/40 border border-gray-800 rounded-2xl p-4 mb-3 mx-2 grid grid-cols-1 gap-4">
                              {it.fix.kind === 'date' && <DatePicker compact label={it.fix.field.toUpperCase()} value={fixValue} onChange={setFixValue} />}
                              {it.fix.kind === 'select' && (
                                <div>
                                  <label className="block mb-1 text-xs font-bold">{it.fix.field.toUpperCase()}</label>
                                  <select value={fixValue} onChange={e => setFixValue(e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm">
                                    <option value="">— escolher —</option>
                                    {it.fix.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                </div>
                              )}
                              {it.fix.kind === 'received' && <p className="text-sm text-gray-300">Confirma que este pagamento FOI RECEBIDO? A baixa entra com data de hoje e o valor vira caixa no DFC.</p>}
                              <div className="flex gap-3 items-center">
                                <button onClick={() => { setFixing(null); setFixValue('') }} className="text-gray-400 font-bold px-2 text-sm">Cancel</button>
                                <button disabled={saving || (it.fix.kind !== 'received' && !fixValue)}
                                  onClick={() => applyFix(c, it, fixValue)}
                                  className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-xl font-bold text-sm">
                                  {saving ? 'SAVING…' : it.fix.kind === 'received' ? 'CONFIRMAR BAIXA' : 'SALVAR'}
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
    </main>
  )
}
