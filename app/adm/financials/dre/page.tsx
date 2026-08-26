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
import { loadFinancials, invoiceTotals, invoiceMeta, rideScope, recognitionDate, ledgerTotals, qtyLine, expLine, isCarLine, fleetDepreciation, CAP_FLOOR, FinData } from '@/lib/financials'
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
  const [scope, setScope] = useState<'OFICINA' | 'COMPLETO'>('OFICINA')   // CARROS × OFICINA (João, 25/ago)
  useEffect(() => { loadFinancials().then(setD).catch(e => setError(String(e?.message || e))) }, [])

  const m = useMemo(() => {
    if (!d) return null
    let parts = 0, services = 0, flTax = 0, discount = 0, cost = 0, wipOpen = 0, fleetCost = 0
    let carRev = 0, carFlTax = 0, carDiscount = 0, carCost = 0
    let missingConclusion = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const rscope = rideScope(d, inv)
      const ours = rscope === 'OWN' || rscope === 'TOOL' || rscope === 'DONOR'
      // Carro nosso (OWN/TOOL) não fatura pra ninguém — linha de preço em
      // invoice nossa é display, não receita. Só o custo entra (as-booked).
      if (!ours) { parts += t.parts; services += t.services; flTax += t.flTax; discount += t.discount }
      cost += t.cost
      // CARROS × OFICINA (João, 25/ago): a linha do carro sai da visão OFICINA —
      // venda (invoice_parts) e custo (invoice_expenses) detectados por linha.
      const nick = (inv.ride_id && d.rides.get(inv.ride_id)?.project_name) || null
      if (!ours) {
        const cp = d.invParts.filter((p: any) => p.invoice_id === inv.id && isCarLine(p.description, (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 1), nick))
          .reduce((s: number, p: any) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 1), 0)
        const cft = cp * ((parseFloat(inv.florida_taxes) || 0) / 100)
        carRev += cp; carFlTax += cft
        carDiscount += (cp + cft) * ((parseFloat(inv.global_discount) || 0) / 100)
        carCost += d.invExpenses.filter((e: any) => e.invoice_id === inv.id && isCarLine(e.item, expLine(e), nick))
          .reduce((s: number, e: any) => s + expLine(e), 0)
      }
      if (inv.live_status === 'CLOSED' && !recognitionDate(d, inv)) missingConclusion++
      if (ours) fleetCost += t.cost                                    // frota OWN/TOOL dentro do CPV as-booked
      else if (inv.live_status !== 'CLOSED' && !(inv.ride_id && d.rides.get(inv.ride_id)?.exported)) wipOpen += t.cost   // job aberto e carro ainda aqui (EXPORTED = entregue)
    }
    const brutaTotal = parts + flTax + services
    const liquida = brutaTotal - discount - flTax
    const lucroBruto = liquida - cost
    // Decisão dos sócios (Marcio+Beto, 26/ago): retiradas ao mínimo — o pessoal
    // dos sócios é custo de equipe (sócio também é equipe). TUDO de expenses entra.
    const payroll = d.expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
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
      + (fixedBy.ASSET || 0) + (fixedBy.BANK || 0) + (fixedBy.VARIABLE || 0) + (fixedBy.STAFF || 0) + (fixedBy.FLEET || 0) + consum + aptCats + smallTools + (fixedBy.UNCLASSIFIED || 0)
    // Juros pagos vêm do livro de empréstimos (null até a migration rodar).
    const lt = ledgerTotals(d)
    const juros = lt ? lt.interestPaid : null
    return {
      juros, resultado: (lucroBruto - opex) - (juros || 0),
      parts, services, flTax, discount, brutaTotal, liquida, cost, lucroBruto,
      carRev, carFlTax, carDiscount, carCost,
      payroll, fixedBy, consum, aptCats, smallTools, opex, ebitda: lucroBruto - opex,
      margemPct: liquida ? (lucroBruto / liquida * 100).toFixed(1) + '%' : '—',
      wipOpen, fleetCost, missingConclusion, nInvoices: d.invoices.length,
    }
  }, [d])

  // Visão escolhida: OFICINA tira as linhas de carro dos dois lados; o OPEX é
  // da oficina nas duas visões. COMPLETO = como sempre foi.
  // G4: depreciação viva da frota (null até a migration rodar).
  const dep = useMemo(() => (d ? fleetDepreciation(d) : null), [d])

  const v = useMemo(() => {
    if (!m) return null
    const off = scope === 'OFICINA'
    const parts = m.parts - (off ? m.carRev : 0)
    const flTax = m.flTax - (off ? m.carFlTax : 0)
    const discount = m.discount - (off ? m.carDiscount : 0)
    // Frota própria (OWN/TOOL) FORA do CPV nas duas visões (João fechou a promessa
    // do D2/D3, 25/ago): não é custo de venda — é capitalização; o Balanço já a
    // carrega como Imobilizado. Volta ao resultado só via depreciação (G4).
    const cost = m.cost - m.fleetCost - (off ? m.carCost : 0)
    const brutaTotal = parts + flTax + m.services
    const liquida = brutaTotal - discount - flTax
    const lucroBruto = liquida - cost
    const ebitda = lucroBruto - m.opex
    const resultado = ebitda - (m.juros || 0) - (dep?.accum || 0)
    return { parts, flTax, discount, cost, brutaTotal, liquida, lucroBruto, ebitda, resultado, margemPct: liquida ? (lucroBruto / liquida * 100).toFixed(1) + '%' : '—' }
  }, [m, scope, dep])

  // DRILL (João, 26/ago): o que compõe cada linha, com valor por somador.
  const comp = useMemo((): Record<string, { label: string; amount: number; href?: string }[]> => {
    if (!d || !m) return {}
    type CompRow = { label: string; amount: number; href?: string }
    const off = scope === 'OFICINA'
    const cap = (list: CompRow[], n2 = 30): CompRow[] => {
      const s2 = list.filter(r => Math.abs(r.amount) > 0.004).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      if (s2.length <= n2) return s2
      const rest = s2.slice(n2)
      return [...s2.slice(0, n2), { label: `… mais ${rest.length} itens`, amount: rest.reduce((s3, r) => s3 + r.amount, 0) }]
    }
    const partsL: CompRow[] = [], svcL: CompRow[] = [], taxL: CompRow[] = [], discL: CompRow[] = [], costL: CompRow[] = []
    for (const inv of d.invoices) {
      const rscope2 = rideScope(d, inv)
      const ours = rscope2 === 'OWN' || rscope2 === 'TOOL' || rscope2 === 'DONOR'
      if (ours) continue
      const t = invoiceTotals(d, inv)
      const mm = invoiceMeta(d, inv.id)
      const nick = (inv.ride_id && d.rides.get(inv.ride_id)?.project_name) || null
      const lbl = `${mm.code} ${mm.car || ''}`.trim()
      const carP = off ? d.invParts.filter((p: any) => p.invoice_id === inv.id && isCarLine(p.description, (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 1), nick)).reduce((s3: number, p: any) => s3 + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 1), 0) : 0
      const carC = off ? d.invExpenses.filter((e: any) => e.invoice_id === inv.id && isCarLine(e.item, expLine(e), nick)).reduce((s3: number, e: any) => s3 + expLine(e), 0) : 0
      const cft = carP * ((parseFloat(inv.florida_taxes) || 0) / 100)
      partsL.push({ label: lbl, amount: t.parts - carP, href: mm.href })
      svcL.push({ label: lbl, amount: t.services, href: mm.href })
      taxL.push({ label: lbl, amount: t.flTax - cft, href: mm.href })
      discL.push({ label: lbl, amount: t.discount - (carP + cft) * ((parseFloat(inv.global_discount) || 0) / 100), href: mm.href })
      costL.push({ label: lbl, amount: t.cost - carC, href: mm.href })
    }
    const bySupplier = (ct: string): CompRow[] => {
      const acc = new Map<string, number>()
      for (const f of d.fixedExpenses) {
        const sup = d.fixedSuppliers.get(f.supplier_id)
        if ((sup?.cost_type || 'UNCLASSIFIED') !== ct) continue
        const k2 = sup?.company || sup?.description || '(sem fornecedor)'
        acc.set(k2, (acc.get(k2) || 0) + (parseFloat(f.amount) || 0))
      }
      return [...acc.entries()].map(([label, amount]) => ({ label, amount }))
    }
    const consumAcc = new Map<string, number>()
    for (const x of d.inputs) { if (x.category === 'APARTMENT' || x.category === 'CATS') continue; const k2 = x.category || 'SEM CATEGORIA'; consumAcc.set(k2, (consumAcc.get(k2) || 0) + qtyLine(x)) }
    return {
      parts: cap(partsL), services: cap(svcL), fltax: cap(taxL), discount: cap(discL), cost: cap(costL),
      payroll: cap([
        ...d.expenses.map((e: any) => ({ label: (e.origin === 'PERSONAL' ? 'PESSOAL · ' : '') + (e.description || e.type || '—'), amount: parseFloat(e.amount) || 0, href: '/staff' })),
        ...d.inputs.filter((x: any) => x.category === 'APARTMENT' || x.category === 'CATS').map((x: any) => ({ label: (x.category === 'CATS' ? 'MASCOTES · ' : 'APARTAMENTO · ') + (x.description || ''), amount: qtyLine(x), href: '/inputs' })),
        ...bySupplier('STAFF').map(r => ({ ...r, label: 'BENEFÍCIO · ' + r.label })),
      ]),
      fixed: cap(bySupplier('FIXED')), marketing: cap(bySupplier('MARKETING')), apps: cap(bySupplier('APP')), bank: cap(bySupplier('BANK')), fleetcost: cap(bySupplier('FLEET')), assets: cap(bySupplier('ASSET')), unclass: cap(bySupplier('UNCLASSIFIED')),
      consum: cap([...consumAcc.entries()].map(([label, amount]) => ({ label, amount, href: '/inputs' }))),
      apt: cap(d.inputs.filter((x: any) => x.category === 'APARTMENT' || x.category === 'CATS').map((x: any) => ({ label: `${x.category} · ${x.description || ''}`, amount: qtyLine(x), href: '/inputs' }))),
      tools: cap([
        ...d.goods.filter((g: any) => qtyLine(g) < CAP_FLOOR).map((g: any) => ({ label: g.description || '—', amount: qtyLine(g), href: '/goods' })),
        ...d.goodExpenses.filter((g: any) => (parseFloat(g.amount) || 0) < CAP_FLOOR).map((g: any) => ({ label: g.description || '—', amount: parseFloat(g.amount) || 0, href: '/goods' })),
      ]),
      dep: dep ? [{ label: 'Frota OWN (marketing & desenvolvimento)', amount: dep.own }, { label: 'Veículos TOOL (serviço)', amount: dep.tool }].filter(r => r.amount > 0) : [],
      juros: cap((d.financingEvents || []).filter((e: any) => e.kind === 'INTEREST').map((e: any) => ({ label: `${e.event_date} · ${e.description || 'juros'}`, amount: parseFloat(e.amount) || 0, href: '/adm/financials/ledgers' }))),
    }
  }, [d, m, scope, dep])
  const [dreDrill, setDreDrill] = useState<string | null>(null)

  async function downloadPdf() {
    if (!m || !v) return
    const rows = [
      { cells: [scope === 'OFICINA' ? 'Receita de peças (oficina)' : 'Receita de peças & veículos', usd(v.parts)] },
      { cells: ['Receita de serviços', usd(m.services)] },
      { cells: ['Florida sales tax faturado', usd(v.flTax)] },
      { cells: ['RECEITA BRUTA', usd(v.brutaTotal)], bold: true },
      { cells: ['(−) Descontos globais', usd(-v.discount)] },
      { cells: ['(−) FL tax repassado ao estado', usd(-v.flTax)] },
      { cells: ['RECEITA LÍQUIDA', usd(v.liquida)], bold: true },
      { cells: ['(−) Custo dos produtos e serviços', usd(-v.cost)] },
      { cells: ['LUCRO BRUTO', usd(v.lucroBruto)], bold: true },
      { cells: ['(−) Equipe — salários & bem-estar', usd(-(m.payroll + m.aptCats + (m.fixedBy.STAFF || 0)))] },
      { cells: ['(−) Ocupação, energia, seguros & contador', usd(-(m.fixedBy.FIXED || 0))] },
      { cells: ['(−) Marketing', usd(-(m.fixedBy.MARKETING || 0))] },
      { cells: ['(−) Software & assinaturas', usd(-(m.fixedBy.APP || 0))] },
      { cells: ['(−) Tarifas bancárias', usd(-(m.fixedBy.BANK || 0))] },
      { cells: ['(−) Frota — seguros & rodagem', usd(-(m.fixedBy.FLEET || 0))] },
      { cells: ['(−) Ativos & instalações (as-booked)', usd(-(m.fixedBy.ASSET || 0))] },
      { cells: ['(−) Consumíveis de oficina', usd(-m.consum)] },
      { cells: ['(−) Ferramental de baixo valor', usd(-m.smallTools)] },
      { cells: ['(−) Não classificado', usd(-(m.fixedBy.UNCLASSIFIED || 0))] },
      { cells: ['EBITDA', usd(v.ebitda)], bold: true },
      { cells: ['(−) Depreciação da frota', dep === null ? 'rode MIGRATION_g4_fleet.sql' : usd(-dep.accum)] },
      { cells: ['(−) Resultado financeiro (juros)', m.juros === null ? 'sem lançamento (LEDGERS)' : usd(-m.juros)] },
      { cells: ['RESULTADO ACUMULADO', usd(v.resultado)], bold: true },
    ]
    if (scope === 'OFICINA') rows.push({ cells: ['FORA DESTA VISÃO — carros (export): faturado', usd(m.carRev) + ' · custo ' + usd(m.carCost)] })
    await downloadStatementPdf({
      filename: 'GZ28US_DRE_acumulada.pdf',
      title: 'DRE — Demonstração do Resultado',
      subtitle: `Acumulado desde o início · regime de competência, as-booked · visão ${scope}`,
      kpis: [
        ['Receita líquida', usd(v.liquida)],
        ['Lucro bruto', `${usd(v.lucroBruto)} (${v.margemPct})`],
        ['Despesas operacionais', usd(-m.opex)],
        ['EBITDA', usd(v.ebitda)],
      ],
      tables: [{ head: ['', 'ACUMULADO'], rows }],
      notes: [
        `As-booked: ${usd(m.wipOpen)} de custo de jobs ABERTOS pesa no resultado — sob a decisão D2 (reconhecimento na entrega) migra para o Balanço como WIP.`,
        `O CPV inclui ${usd(m.fleetCost)} da frota própria (rides OWN/TOOL) — sai do custo quando D2/D3 fecharem.`,
        `G1 destravado: o mês do resultado de invoice FECHADO deriva do último recebimento quando falta conclusion_date (explícita vale mais). Fechadas sem data derivável: ${m.missingConclusion}. Colunas por período entram com D1/D2.`,
        'Margem deprimida porque o valor bruto dos carros de clientes passa pela receita e pelo custo (tratamento agência pendente — D2/D3).',
      ],
    })
  }

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d || !m || !v) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  // Linha clicável (João, 26/ago): ▸ abre os somadores da linha, com valor e link.
  const Row = ({ label, value, sub, note, k }: { label: string; value: number | null; sub?: boolean; note?: string; k?: string }) => {
    const rows = k ? comp[k] : undefined
    const openD = !!k && dreDrill === k
    return (
      <>
        <div onClick={rows?.length ? () => setDreDrill(openD ? null : k!) : undefined} className={`px-4 py-2.5 flex justify-between gap-4 border-t border-gray-800 ${sub ? '' : 'bg-gray-900 font-bold'} ${rows?.length ? 'cursor-pointer hover:bg-gray-800/60' : ''}`}>
          <span className={sub ? 'text-gray-400' : ''}>{rows?.length ? <span className="text-gray-600 mr-1">{openD ? '▾' : '▸'}</span> : null}{label}{note && <span className="block text-xs text-gray-600 font-normal">{note}</span>}</span>
          <span className={`tabular-nums whitespace-nowrap ${value === null ? 'text-gray-600' : value < 0 ? 'text-red-400' : ''} ${sub ? '' : 'text-lg'}`}>
            {value === null ? '— sem registro' : usd(value)}
          </span>
        </div>
        {openD && rows && (
          <div className="bg-black/40">
            {rows.map((r, i) => (
              <div key={i} className="px-4 py-1.5 pl-10 flex justify-between gap-4 text-sm border-t border-gray-900">
                {r.href ? <a href={`${BASE_PATH}${r.href}`} target="_blank" rel="noreferrer" className="truncate text-gray-400 hover:text-white hover:underline">{r.label}</a> : <span className="truncate text-gray-500">{r.label}</span>}
                <span className="tabular-nums text-gray-500 whitespace-nowrap">{usd(r.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DRE — RESULTADO</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL HUB</a>
      </div>
      <p className="text-gray-400 mb-5 max-w-3xl">Regime de competência, acumulado desde o início, as-booked. {m.nInvoices} invoices reais.</p>

      {/* CARROS × OFICINA (João, 25/ago): a gestão olha a oficina; o COMPLETO
          mostra todo o dinheiro que passou. O card dos carros fica sempre à vista. */}
      <div className="flex gap-2 mb-6 items-center flex-wrap">
        {(['OFICINA', 'COMPLETO'] as const).map(s => (
          <button key={s} onClick={() => setScope(s)} className={`px-4 py-2 rounded-xl font-bold border ${scope === s ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-700'}`}>{s === 'OFICINA' ? 'SÓ A OFICINA' : 'COMPLETO (com carros)'}</button>
        ))}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl px-4 py-2 text-xs text-gray-400">
          <span className="font-bold text-gray-300">CARROS (EXPORT):</span> faturado {usd(m.carRev)} · custo {usd(m.carCost)} · margem {usd(m.carRev - m.carDiscount - m.carCost)}
          {scope === 'OFICINA' && <span className="text-amber-300"> — fora da visão atual</span>}
        </div>
        <button onClick={downloadPdf} className="ml-auto px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500">⬇ BAIXAR PDF</button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mb-6">
        {[['RECEITA LÍQUIDA', v.liquida, 'text-gray-200'],
          ['LUCRO BRUTO', v.lucroBruto, 'text-emerald-400'],
          ['DESPESAS OPERACIONAIS', -m.opex, 'text-red-400'],
          ['EBITDA', v.ebitda, v.ebitda < 0 ? 'text-red-400' : 'text-emerald-400']].map(([label, val, cls]) => (
          <div key={label as string} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <p className="text-xs font-bold text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{usd(val as number)}</p>
            {label === 'LUCRO BRUTO' && <p className="text-xs text-gray-500 mt-1">{v.margemPct} da receita líquida</p>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl mb-6 items-start">
        {/* Cascata receita → EBITDA */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DA RECEITA AO EBITDA</p>
          <Waterfall steps={[
            { label: 'Receita líquida', value: v.liquida, kind: 'in' },
            { label: 'Custo dos produtos e serviços', value: v.cost, kind: 'out' },
            { label: 'Lucro bruto', value: v.lucroBruto, kind: 'net' },
            { label: 'Despesas operacionais', value: m.opex, kind: 'out' },
            { label: 'EBITDA', value: v.ebitda, kind: 'net' },
          ]} />
        </div>
        {/* Abertura do OPEX */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">ONDE VIVE A DESPESA OPERACIONAL</p>
          <Waterfall steps={[
            { label: 'Ocupação, energia, seguros & contador', value: m.fixedBy.FIXED || 0, kind: 'out' },
            { label: 'Equipe — salários & bem-estar', value: m.payroll + m.aptCats + (m.fixedBy.STAFF || 0), kind: 'out' },
            { label: 'Marketing', value: m.fixedBy.MARKETING || 0, kind: 'out' },
            { label: 'Software & assinaturas', value: m.fixedBy.APP || 0, kind: 'out' },
            { label: 'Tarifas bancárias', value: m.fixedBy.BANK || 0, kind: 'out' },
            { label: 'Frota — seguros & rodagem', value: m.fixedBy.FLEET || 0, kind: 'out' },
            { label: 'Ativos & instalações', value: m.fixedBy.ASSET || 0, kind: 'out' },
            { label: 'Ferramental de baixo valor', value: m.smallTools, kind: 'out' },
            { label: 'Consumíveis de oficina', value: m.consum, kind: 'out' },
            { label: 'Não classificado', value: m.fixedBy.UNCLASSIFIED || 0, kind: 'out' },
          ]} />
        </div>
      </div>

      <div className="max-w-2xl">
        <div className="bg-amber-950/60 border border-amber-800 rounded-2xl p-4 mb-6 text-sm text-amber-200 space-y-1">
          <p className="font-bold">G1 DESTRAVADO — datas deriváveis (insight do João, 20/ago)</p>
          <p>CLOSED exige todo income datado e recebido — então o mês do resultado de invoice fechado DERIVA do último recebimento quando falta conclusion_date explícita (que continua valendo mais: é a verdade do trabalho, não do caixa). Fechadas sem data derivável: {m.missingConclusion}. Colunas por período entram junto com as decisões D1/D2.</p>
          <p className="pt-1">E o custo de jobs ABERTOS ({usd(m.wipOpen)}) ainda pesa aqui como despesa — sob a decisão D2 (reconhecer na entrega) ele migra pro Balanço como WIP e este resultado sobe.</p>
        </div>

        <div className="border border-gray-800 rounded-2xl overflow-hidden">
          <Row label={scope === 'OFICINA' ? 'Receita de peças (oficina)' : 'Receita de peças & veículos'} value={v.parts} sub k="parts"
            note={scope === 'COMPLETO' ? `dos quais carros (export): ${usd(m.carRev)}` : undefined} />
          <Row label="Receita de serviços" value={m.services} sub k="services" />
          <Row label="Florida sales tax faturado" value={v.flTax} sub k="fltax" />
          <Row label="RECEITA BRUTA" value={v.brutaTotal} />
          <Row label="(−) Descontos globais" value={-v.discount} sub k="discount" />
          <Row label="(−) FL tax repassado ao estado" value={-v.flTax} sub note="pass-through — não é receita nossa (D5)" />
          <Row label="RECEITA LÍQUIDA" value={v.liquida} />
          <Row label="(−) Custo dos produtos e serviços" value={-v.cost} sub k="cost"
            note={`frota própria OWN/TOOL ${usd(m.fleetCost)} capitalizada no Balanço — FORA do CPV (volta via depreciação, G4)${scope === 'COMPLETO' ? ` · dos quais carros (export): ${usd(m.carCost)}` : ''}`} />
          <Row label="LUCRO BRUTO" value={v.lucroBruto} />
          <Row label="(−) Equipe — salários & bem-estar" value={-(m.payroll + m.aptCats + (m.fixedBy.STAFF || 0))} sub k="payroll" note="tudo que mantém a equipe operando e feliz: salários, diárias, comida, o dia a dia dos sócios e a MORADIA inteira (itens do apto + aluguel Luma via cost_type STAFF — D10 fechado por completo, 26/ago)" />
          <Row label="(−) Ocupação, energia, seguros & contador" value={-(m.fixedBy.FIXED || 0)} sub k="fixed" note="aluguéis (galpão + apto Luma), Duke Energy, Progressive e a Drummond — serviços contratados, NÃO folha (equipe é a linha acima)" />
          <Row label="(−) Marketing" value={-(m.fixedBy.MARKETING || 0)} sub k="marketing" />
          <Row label="(−) Software & assinaturas" value={-(m.fixedBy.APP || 0)} sub k="apps" />
          <Row label="(−) Frota — seguros & rodagem" value={-(m.fixedBy.FLEET || 0)} sub k="fleetcost" note="seguros, placas e rodagem dos carros NOSSOS (OWN/TOOL) — o carro é ativo; mantê-lo na rua é despesa (Progressive cobre RAMbo, GENEZIZ e Devil170)" />
          <Row label="(−) Tarifas bancárias" value={-(m.fixedBy.BANK || 0)} sub k="bank" note="wire fees, análise de conta — o motor FEE lança, linkado à linha do banco (João, 26/ago: não é custo fixo)" />
          <Row label="(−) Ativos & instalações (as-booked)" value={-(m.fixedBy.ASSET || 0)} sub k="assets" note="capitaliza quando D8/G4 fecharem" />
          <Row label="(−) Consumíveis de oficina" value={-m.consum} sub k="consum" />
          <Row label="(−) Ferramental de baixo valor" value={-m.smallTools} sub k="tools" note={`GOODS abaixo do piso de $${CAP_FLOOR.toLocaleString()} (D8)`} />
          <Row label="(−) Não classificado" value={-(m.fixedBy.UNCLASSIFIED || 0)} sub k="unclass" />
          <Row label="EBITDA" value={v.ebitda} />
          <Row label="(−) Depreciação da frota" value={dep === null ? null : -dep.accum} sub k="dep"
            note={dep === null ? 'rode MIGRATION_g4_fleet.sql e classifique a frota' : 'linear por linha de custo, da data de cada gasto · DESENVOLVIMENTO + TRABALHO depreciam · MONUMENTO e RESERVA ao custo (G4 vivo, 25/ago)'} />
          <Row label="(−) Resultado financeiro (juros)" value={m.juros === null ? null : -m.juros} sub k="juros" note={m.juros === null ? 'lance os empréstimos no livro LEDGERS' : 'juros pagos, do livro de empréstimos'} />
          <Row label="RESULTADO ACUMULADO" value={v.resultado} />
        </div>

        <p className="mt-4 text-sm text-gray-500">{scope === 'OFICINA' ? `Visão SÓ A OFICINA: as linhas de carro (export) estão fora dos dois lados — faturado ${usd(m.carRev)}, custo ${usd(m.carCost)}. Esta é a margem real da operação.` : `Visão COMPLETA: o valor bruto dos carros passa pela receita e pelo custo — a margem parece menor por isso. Troque pra SÓ A OFICINA pra ver a operação.`} (D2/D3 resolvido em 25/ago — separação por linha, validada contra o banco.)</p>
      </div>
    </main>
  )
}
