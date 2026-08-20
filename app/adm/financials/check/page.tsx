'use client'

// DATA CHECK — a lista do que está travando as demonstrações, linha por linha.
// O Márcio está deixando os dados pristinos na mão; esta tela transforma a
// caçada em checklist: cada card é UM problema, com contagem, impacto em $ e
// link direto pra linha que precisa de conserto. Card zerado fica verde.
// Tela só de leitura — consome o mesmo dataset das demonstrações.
import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import FinBadge from '@/components/FinBadge'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import { loadFinancials, invoiceTotals, invoiceMeta, ledgerTotals, expLine, qtyLine, FinData } from '@/lib/financials'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const TODAY = new Date().toISOString().slice(0, 10)

type Item = { href: string; code: string; label: string; extra?: string; amount?: number }
type Check = {
  key: string; title: string; why: string; blocks: string
  items: Item[]; impact?: number
}

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
        return { href: m.href, code: m.code, label: m.car || '—', extra: i.live_status + (i.live_status === 'CLOSED' ? ' — fechada sem data!' : '') }
      })
    checks.push({
      key: 'conclusion', title: 'Invoices sem CONCLUSION DATE', blocks: 'DRE por período (G1)',
      why: 'Sem data de conclusão não existe o mês do resultado — a DRE fica presa no acumulado. As CLOSED são as urgentes: já acabaram e não dizem quando.',
      items,
    })
  }

  // 2 · Rides sem CAR DESTINY (dono do carro indefinido). Quotes e vitrine SHOP
  // ficam fora — vitrine é deliberadamente sem destino pra não duplicar o ativo.
  {
    const withInvoice = new Set(d.invoices.map((i: any) => i.ride_id).filter(Boolean))
    const items: Item[] = []
    d.rides.forEach((r: any) => {
      if (r.is_quote || r.origin === 'SHOP' || r.title_scope || !withInvoice.has(r.id)) return
      items.push({ href: '/rides/edit/' + r.id, code: r.project_code || '—', label: r.project_name || [r.model, r.version].filter(Boolean).join(' '), extra: 'destino indefinido' })
    })
    d.rides.forEach((r: any) => {
      if (r.title_scope === 'DEALER') items.push({ href: '/rides/edit/' + r.id, code: r.project_code || '—', label: r.project_name || '', extra: 'valor legado DEALER — re-taguear (provável EXPORT)' })
    })
    checks.push({
      key: 'destiny', title: 'Rides sem CAR DESTINY', blocks: 'Balanço (WIP × frota × carro de cliente)',
      why: 'Sem destino o Balanço não sabe se o carro é nosso (OWN/TOOL → ativo), de cliente em exportação (EXPORT) ou de cliente americano. Vitrine SHOP fica sem destino de propósito.',
      items,
    })
  }

  // 3 · Despesas de projeto sem payment_date (G6) — devido de verdade ou só sem preencher?
  {
    const rows = d.invExpenses.filter((e: any) => !e.payment_date)
    const items = rows.map((e: any) => {
      const m = invoiceMeta(d, e.invoice_id)
      return { href: m.href, code: m.code, label: e.item || '', extra: e.supplier || '', amount: expLine(e) }
    }).sort((a: Item, b: Item) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      key: 'undated-inv', title: 'Despesas de projeto sem PAYMENT DATE', blocks: 'Fornecedores a pagar · DFC',
      why: 'Sem data de pagamento a linha vira contas a pagar no Balanço e fica FORA do fluxo de caixa. Se já foi paga, é só data faltando — e o caixa está subestimado.',
      items, impact: rows.reduce((s: number, e: any) => s + expLine(e), 0),
    })
  }

  // 4 · Custos fixos e folha sem payment_date.
  {
    const fx = d.fixedExpenses.filter((e: any) => !e.payment_date)
    const st = d.expenses.filter((e: any) => !e.payment_date && e.origin !== 'PERSONAL')
    const items: Item[] = [
      ...fx.map((e: any) => {
        const sup = d.fixedSuppliers.get(e.supplier_id)
        return { href: e.supplier_id ? '/costs/fixed/' + e.supplier_id : '/costs/fixed', code: 'FIXO', label: [sup?.company, e.description].filter(Boolean).join(' · '), amount: parseFloat(e.amount) || 0 }
      }),
      ...st.map((e: any) => ({ href: '/staff', code: 'FOLHA', label: e.description || e.type || '', amount: parseFloat(e.amount) || 0 })),
    ].sort((a, b) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      key: 'undated-fixed', title: 'Custos fixos & folha sem PAYMENT DATE', blocks: 'Fornecedores a pagar · DFC',
      why: 'Mesma história do card anterior, nas tabelas de custo fixo e folha.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 5 · Jobs legados: dinheiro recebido contra invoice sem linha nenhuma (D9).
  {
    const items: Item[] = []
    let impact = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const sched = d.payments.filter((p: any) => p.invoice_id === inv.id).reduce((s: number, p: any) => s + (parseFloat(p.amount) || 0), 0)
      if (t.grand < 0.005 && sched > 0) {
        const m = invoiceMeta(d, inv.id)
        items.push({ href: m.href, code: m.code, label: m.car || '—', extra: inv.live_status, amount: sched })
        impact += sched
      }
    }
    checks.push({
      key: 'zero-billed', title: 'Invoices com pagamento e SEM LINHAS', blocks: 'A/R · adiantamentos fantasmas (D9)',
      why: 'Dinheiro entrou mas a invoice não fatura nada — vira adiantamento de cliente eterno no Balanço. Ou as linhas são preenchidas, ou o job legado fecha contra resultado de abertura.',
      items: items.sort((a, b) => (b.amount || 0) - (a.amount || 0)), impact,
    })
  }

  // 6 · Fornecedores de custo fixo sem cost_type — caem em "não classificado".
  {
    const items: Item[] = []
    let impact = 0
    d.fixedSuppliers.forEach((s: any) => {
      if (s.cost_type) return
      const tot = d.fixedExpenses.filter((e: any) => e.supplier_id === s.id).reduce((x: number, e: any) => x + (parseFloat(e.amount) || 0), 0)
      items.push({ href: '/costs/fixed/' + s.id, code: 'FIXO', label: s.company || s.description || '—', extra: 'sem cost_type', amount: tot })
      impact += tot
    })
    checks.push({
      key: 'untyped-supplier', title: 'Fornecedores fixos sem TIPO', blocks: 'DRE (linha "não classificado")',
      why: 'Sem cost_type (FIXED/APP/MARKETING/ASSET) o gasto cai na linha genérica da DRE em vez da família certa.',
      items, impact,
    })
  }

  // 7 · Recebimentos agendados vencidos sem baixa — recebeu e não marcou?
  {
    const rows = d.payments.filter((p: any) => !p.paid_at && p.payment_date && p.payment_date < TODAY)
    const items = rows.map((p: any) => {
      const m = invoiceMeta(d, p.invoice_id)
      return { href: m.href, code: m.code, label: m.car || p.description || '', extra: 'vencido ' + formatShortDate(p.payment_date), amount: parseFloat(p.amount) || 0 }
    }).sort((a: Item, b: Item) => (b.amount || 0) - (a.amount || 0))
    checks.push({
      key: 'overdue-receipts', title: 'Recebimentos vencidos sem baixa', blocks: 'A/R · DFC (entradas)',
      why: 'Agendado pra uma data que já passou e sem paid_at. Se o dinheiro entrou, falta dar baixa — o caixa real está maior do que o app mostra. Se não entrou, é cobrança.',
      items, impact: items.reduce((s, i) => s + (i.amount || 0), 0),
    })
  }

  // 8 · Estoque comprado sem payment_date (sai do DFC de investimento).
  {
    const rows = d.inventory.filter((s: any) => s.source_type === 'PURCHASED' && !s.payment_date)
    checks.push({
      key: 'undated-stock', title: 'Estoque comprado sem PAYMENT DATE', blocks: 'DFC (investimentos)',
      why: 'Compra de estoque sem data de pagamento não entra no caixa de investimentos.',
      items: rows.map((r: any) => ({ href: '/inventory', code: 'STOCK', label: r.description || '', amount: qtyLine(r) })),
      impact: rows.reduce((s: number, r: any) => s + qtyLine(r), 0),
    })
  }

  // 9 · Caixa: migration pendente, nenhum saldo, ou saldo com mais de 35 dias.
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
  useEffect(() => { loadFinancials().then(setD).catch(e => setError(String(e?.message || e))) }, [])

  const checks = useMemo(() => (d ? buildChecks(d) : []), [d])
  const totalIssues = checks.reduce((s, c) => s + c.items.length, 0)

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DATA CHECK</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL</a>
      </div>
      <p className="text-gray-400 mb-6 max-w-3xl">Tudo que está travando as demonstrações, linha por linha, com link direto pro conserto. Zere os cards e as demonstrações contam a história certa sozinhas.</p>

      <div className={`rounded-2xl border p-4 mb-8 max-w-2xl ${totalIssues === 0 ? 'bg-emerald-950/50 border-emerald-800 text-emerald-200' : 'bg-gray-900 border-gray-700'}`}>
        <p className="text-3xl font-bold">{totalIssues === 0 ? 'TUDO LIMPO ✓' : `${totalIssues} pendências`}</p>
        {totalIssues > 0 && <p className="text-sm text-gray-400 mt-1">{checks.filter(c => c.items.length > 0).length} de {checks.length} verificações com pendência</p>}
      </div>

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
                  <div className="max-h-96 overflow-y-auto divide-y divide-gray-800">
                    {c.items.map((it, i) => (
                      <a key={i} href={`${BASE_PATH}${it.href}`} className="flex items-baseline gap-3 py-2 px-2 hover:bg-gray-800 rounded-lg">
                        <span className="text-gray-400 text-xs w-20 shrink-0 font-bold">{it.code}</span>
                        <span className="flex-1 truncate text-sm">{it.label}</span>
                        {it.extra && <span className="text-xs text-gray-500 shrink-0">{it.extra}</span>}
                        {it.amount !== undefined && <span className="tabular-nums font-bold text-sm shrink-0">{usd(it.amount)}</span>}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="mt-8 text-sm text-gray-500 max-w-3xl">Fora do checklist (são obra, não conserto): caixa/capital/empréstimos (Fase 2 — três livros novos) e a integração bancária Plaid, que vai conferir tudo isso contra o extrato de verdade.</p>
    </main>
  )
}
