'use client'

// DRE — Demonstração do Resultado, regime de competência, ACUMULADO DESDE O
// INÍCIO. Por mês/ano ainda não dá: 87 de 99 invoices não têm conclusion_date
// (gap G1 do blueprint) — sem data de conclusão não existe "mês do resultado".
// Os números são AS-BOOKED: toda despesa de projeto vira custo na hora, mesmo
// com o carro ainda na oficina. Quando D2 (reconhecer na entrega) fechar, o
// custo de invoice aberta migra pro Balanço como WIP e este resultado muda.
import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import FinBadge from '@/components/FinBadge'
import { BASE_PATH } from '@/lib/utils'
import { loadFinancials, invoiceTotals, isOurRide, ledgerTotals, qtyLine, CAP_FLOOR, FinData } from '@/lib/financials'
import { downloadStatementPdf } from '@/lib/statementPdf'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')

// Cascata: cada degrau da receita ao EBITDA como barra horizontal proporcional.
function Waterfall({ steps }: { steps: { label: string; value: number; kind: 'in' | 'out' | 'net' }[] }) {
  const max = Math.max(1, ...steps.map(s => Math.abs(s.value)))
  return (
    <div className="space-y-2.5">
      {steps.map(s => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="w-64 shrink-0 text-sm text-gray-400 text-right">{s.label}</span>
          <div className="flex-1 h-6 bg-gray-950 rounded overflow-hidden">
            <div className={`h-full rounded ${s.kind === 'in' ? 'bg-emerald-600' : s.kind === 'out' ? 'bg-red-700' : s.value < 0 ? 'bg-red-500' : 'bg-emerald-400'}`}
              style={{ width: `${Math.max(Math.abs(s.value) / max * 100, 0.5)}%` }} />
          </div>
          <span className={`w-28 shrink-0 text-sm font-bold tabular-nums ${s.value < 0 || s.kind === 'out' ? 'text-red-400' : 'text-emerald-400'}`}>
            {usd(s.kind === 'out' ? -Math.abs(s.value) : s.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function DrePage() {
  const [d, setD] = useState<FinData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { loadFinancials().then(setD).catch(e => setError(String(e?.message || e))) }, [])

  const m = useMemo(() => {
    if (!d) return null
    let parts = 0, services = 0, flTax = 0, discount = 0, cost = 0, wipOpen = 0, fleetCost = 0
    let missingConclusion = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const ours = isOurRide(d, inv)
      // Carro nosso (OWN/TOOL) não fatura pra ninguém — linha de preço em
      // invoice nossa é display, não receita. Só o custo entra (as-booked).
      if (!ours) { parts += t.parts; services += t.services; flTax += t.flTax; discount += t.discount }
      cost += t.cost
      if (!inv.conclusion_date) missingConclusion++
      if (ours) fleetCost += t.cost                                    // frota OWN/TOOL dentro do CPV as-booked
      else if (inv.live_status !== 'CLOSED') wipOpen += t.cost         // custo de job aberto (vira WIP sob D2)
    }
    const brutaTotal = parts + flTax + services
    const liquida = brutaTotal - discount - flTax
    const lucroBruto = liquida - cost
    const payroll = d.expenses.filter(e => e.origin !== 'PERSONAL').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
    const fixedBy: Record<string, number> = {}
    for (const f of d.fixedExpenses) {
      const ct = d.fixedSuppliers.get(f.supplier_id)?.cost_type || 'UNCLASSIFIED'
      fixedBy[ct] = (fixedBy[ct] || 0) + (parseFloat(f.amount) || 0)
    }
    // Complemento de APARTMENT/CATS: categoria nova ou nula cai aqui, nunca some.
    const consum = d.inputs.filter(x => x.category !== 'APARTMENT' && x.category !== 'CATS').reduce((s, x) => s + qtyLine(x), 0)
    const aptCats = d.inputs.filter(x => x.category === 'APARTMENT' || x.category === 'CATS').reduce((s, x) => s + qtyLine(x), 0)
    const smallTools = d.goods.filter(g => qtyLine(g) < CAP_FLOOR).reduce((s, g) => s + qtyLine(g), 0)
      + d.goodExpenses.filter(g => (parseFloat(g.amount) || 0) < CAP_FLOOR).reduce((s, g) => s + (parseFloat(g.amount) || 0), 0)
    const opex = payroll + (fixedBy.FIXED || 0) + (fixedBy.MARKETING || 0) + (fixedBy.APP || 0)
      + (fixedBy.ASSET || 0) + consum + aptCats + smallTools + (fixedBy.UNCLASSIFIED || 0)
    // Juros pagos vêm do livro de empréstimos (null até a migration rodar).
    const lt = ledgerTotals(d)
    const juros = lt ? lt.interestPaid : null
    return {
      juros, resultado: (lucroBruto - opex) - (juros || 0),
      parts, services, flTax, discount, brutaTotal, liquida, cost, lucroBruto,
      payroll, fixedBy, consum, aptCats, smallTools, opex, ebitda: lucroBruto - opex,
      margemPct: liquida ? (lucroBruto / liquida * 100).toFixed(1) + '%' : '—',
      wipOpen, fleetCost, missingConclusion, nInvoices: d.invoices.length,
    }
  }, [d])

  async function downloadPdf() {
    if (!m) return
    const rows = [
      { cells: ['Receita de peças & veículos', usd(m.parts)] },
      { cells: ['Receita de serviços', usd(m.services)] },
      { cells: ['Florida sales tax faturado', usd(m.flTax)] },
      { cells: ['RECEITA BRUTA', usd(m.brutaTotal)], bold: true },
      { cells: ['(−) Descontos globais', usd(-m.discount)] },
      { cells: ['(−) FL tax repassado ao estado', usd(-m.flTax)] },
      { cells: ['RECEITA LÍQUIDA', usd(m.liquida)], bold: true },
      { cells: ['(−) Custo dos produtos e serviços', usd(-m.cost)] },
      { cells: ['LUCRO BRUTO', usd(m.lucroBruto)], bold: true },
      { cells: ['(−) Pessoal', usd(-m.payroll)] },
      { cells: ['(−) Ocupação, seguros & profissionais', usd(-(m.fixedBy.FIXED || 0))] },
      { cells: ['(−) Marketing', usd(-(m.fixedBy.MARKETING || 0))] },
      { cells: ['(−) Software & assinaturas', usd(-(m.fixedBy.APP || 0))] },
      { cells: ['(−) Ativos & instalações (as-booked)', usd(-(m.fixedBy.ASSET || 0))] },
      { cells: ['(−) Consumíveis de oficina', usd(-m.consum)] },
      { cells: ['(−) Ferramental de baixo valor', usd(-m.smallTools)] },
      { cells: ['(−) Apartamento & mascotes', usd(-m.aptCats)] },
      { cells: ['(−) Não classificado', usd(-(m.fixedBy.UNCLASSIFIED || 0))] },
      { cells: ['EBITDA', usd(m.ebitda)], bold: true },
      { cells: ['(−) Depreciação', 'sem registro (G4)'] },
      { cells: ['(−) Resultado financeiro (juros)', m.juros === null ? 'sem lançamento (LEDGERS)' : usd(-m.juros)] },
      { cells: ['RESULTADO ACUMULADO', usd(m.resultado)], bold: true },
    ]
    await downloadStatementPdf({
      filename: 'GZ28US_DRE_acumulada.pdf',
      title: 'DRE — Demonstração do Resultado',
      subtitle: 'Acumulado desde o início · regime de competência, as-booked',
      kpis: [
        ['Receita líquida', usd(m.liquida)],
        ['Lucro bruto', `${usd(m.lucroBruto)} (${m.margemPct})`],
        ['Despesas operacionais', usd(-m.opex)],
        ['EBITDA', usd(m.ebitda)],
      ],
      tables: [{ head: ['', 'ACUMULADO'], rows }],
      notes: [
        `As-booked: ${usd(m.wipOpen)} de custo de jobs ABERTOS pesa no resultado — sob a decisão D2 (reconhecimento na entrega) migra para o Balanço como WIP.`,
        `O CPV inclui ${usd(m.fleetCost)} da frota própria (rides OWN/TOOL) — sai do custo quando D2/D3 fecharem.`,
        `${m.missingConclusion} de ${m.nInvoices} invoices sem conclusion_date (G1) — por isso o relatório é acumulado, sem colunas por período.`,
        'Margem deprimida porque o valor bruto dos carros de clientes passa pela receita e pelo custo (tratamento agência pendente — D2/D3).',
      ],
    })
  }

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d || !m) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  const Row = ({ label, value, sub, note }: { label: string; value: number | null; sub?: boolean; note?: string }) => (
    <div className={`px-4 py-2.5 flex justify-between gap-4 border-t border-gray-800 ${sub ? '' : 'bg-gray-900 font-bold'}`}>
      <span className={sub ? 'text-gray-400' : ''}>{label}{note && <span className="block text-xs text-gray-600 font-normal">{note}</span>}</span>
      <span className={`tabular-nums whitespace-nowrap ${value === null ? 'text-gray-600' : value < 0 ? 'text-red-400' : ''} ${sub ? '' : 'text-lg'}`}>
        {value === null ? '— sem registro' : usd(value)}
      </span>
    </div>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DRE — RESULTADO</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL</a>
      </div>
      <p className="text-gray-400 mb-5 max-w-3xl">Regime de competência, acumulado desde o início, as-booked. {m.nInvoices} invoices reais.</p>

      <div className="flex mb-6"><button onClick={downloadPdf} className="px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500">⬇ BAIXAR PDF</button></div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mb-6">
        {[['RECEITA LÍQUIDA', m.liquida, 'text-gray-200'],
          ['LUCRO BRUTO', m.lucroBruto, 'text-emerald-400'],
          ['DESPESAS OPERACIONAIS', -m.opex, 'text-red-400'],
          ['EBITDA', m.ebitda, m.ebitda < 0 ? 'text-red-400' : 'text-emerald-400']].map(([label, v, cls]) => (
          <div key={label as string} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <p className="text-xs font-bold text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{usd(v as number)}</p>
            {label === 'LUCRO BRUTO' && <p className="text-xs text-gray-500 mt-1">{m.margemPct} da receita líquida</p>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl mb-6 items-start">
        {/* Cascata receita → EBITDA */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DA RECEITA AO EBITDA</p>
          <Waterfall steps={[
            { label: 'Receita líquida', value: m.liquida, kind: 'in' },
            { label: 'Custo dos produtos e serviços', value: m.cost, kind: 'out' },
            { label: 'Lucro bruto', value: m.lucroBruto, kind: 'net' },
            { label: 'Despesas operacionais', value: m.opex, kind: 'out' },
            { label: 'EBITDA', value: m.ebitda, kind: 'net' },
          ]} />
        </div>
        {/* Abertura do OPEX */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">ONDE VIVE A DESPESA OPERACIONAL</p>
          <Waterfall steps={[
            { label: 'Ocupação, seguros & profissionais', value: m.fixedBy.FIXED || 0, kind: 'out' },
            { label: 'Pessoal', value: m.payroll, kind: 'out' },
            { label: 'Marketing', value: m.fixedBy.MARKETING || 0, kind: 'out' },
            { label: 'Software & assinaturas', value: m.fixedBy.APP || 0, kind: 'out' },
            { label: 'Ativos & instalações', value: m.fixedBy.ASSET || 0, kind: 'out' },
            { label: 'Ferramental de baixo valor', value: m.smallTools, kind: 'out' },
            { label: 'Consumíveis de oficina', value: m.consum, kind: 'out' },
            { label: 'Apartamento & mascotes', value: m.aptCats, kind: 'out' },
            { label: 'Não classificado', value: m.fixedBy.UNCLASSIFIED || 0, kind: 'out' },
          ]} />
        </div>
      </div>

      <div className="max-w-2xl">
        <div className="bg-amber-950/60 border border-amber-800 rounded-2xl p-4 mb-6 text-sm text-amber-200 space-y-1">
          <p className="font-bold">POR QUE AINDA NÃO TEM COLUNA POR MÊS (G1)</p>
          <p>{m.missingConclusion} de {m.nInvoices} invoices sem conclusion_date — sem a data de conclusão não existe o mês do resultado. Preenchendo as datas, esta tela ganha colunas por período.</p>
          <p className="pt-1">E o custo de jobs ABERTOS ({usd(m.wipOpen)}) ainda pesa aqui como despesa — sob a decisão D2 (reconhecer na entrega) ele migra pro Balanço como WIP e este resultado sobe.</p>
        </div>

        <div className="border border-gray-800 rounded-2xl overflow-hidden">
          <Row label="Receita de peças & veículos" value={m.parts} sub />
          <Row label="Receita de serviços" value={m.services} sub />
          <Row label="Florida sales tax faturado" value={m.flTax} sub />
          <Row label="RECEITA BRUTA" value={m.brutaTotal} />
          <Row label="(−) Descontos globais" value={-m.discount} sub />
          <Row label="(−) FL tax repassado ao estado" value={-m.flTax} sub note="pass-through — não é receita nossa (D5)" />
          <Row label="RECEITA LÍQUIDA" value={m.liquida} />
          <Row label="(−) Custo dos produtos e serviços" value={-m.cost} sub
            note={`inclui frota própria OWN/TOOL ${usd(m.fleetCost)} — sai do custo quando D2/D3 fecharem`} />
          <Row label="LUCRO BRUTO" value={m.lucroBruto} />
          <Row label="(−) Pessoal" value={-m.payroll} sub />
          <Row label="(−) Ocupação, seguros & profissionais" value={-(m.fixedBy.FIXED || 0)} sub />
          <Row label="(−) Marketing" value={-(m.fixedBy.MARKETING || 0)} sub />
          <Row label="(−) Software & assinaturas" value={-(m.fixedBy.APP || 0)} sub />
          <Row label="(−) Ativos & instalações (as-booked)" value={-(m.fixedBy.ASSET || 0)} sub note="capitaliza quando D8/G4 fecharem" />
          <Row label="(−) Consumíveis de oficina" value={-m.consum} sub />
          <Row label="(−) Ferramental de baixo valor" value={-m.smallTools} sub note={`GOODS abaixo do piso de $${CAP_FLOOR.toLocaleString()} (D8)`} />
          <Row label="(−) Apartamento & mascotes" value={-m.aptCats} sub note="D10 decide se é benefício ou retirada" />
          <Row label="(−) Não classificado" value={-(m.fixedBy.UNCLASSIFIED || 0)} sub />
          <Row label="EBITDA" value={m.ebitda} />
          <Row label="(−) Depreciação" value={null} sub note="sem registro de ativos ainda (G4)" />
          <Row label="(−) Resultado financeiro (juros)" value={m.juros === null ? null : -m.juros} sub note={m.juros === null ? 'lance os empréstimos no livro LEDGERS' : 'juros pagos, do livro de empréstimos'} />
          <Row label="RESULTADO ACUMULADO" value={m.resultado} />
        </div>

        <p className="mt-4 text-sm text-gray-500">Margem bruta as-booked: {m.margemPct} — deprimida porque o valor bruto dos carros de clientes passa pela receita e pelo custo (tratamento agência é a decisão D2/D3 do blueprint).</p>
      </div>
    </main>
  )
}
