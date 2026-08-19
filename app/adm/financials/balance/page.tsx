'use client'

// BALANÇO PATRIMONIAL — a foto de hoje, com o que o banco de dados já sabe
// derivar. As linhas de funding (caixa, capital, empréstimos) ainda não têm
// registro — gaps G2/G3/G5 do blueprint, Fase 2 — então o balanço NÃO FECHA
// por enquanto e diz isso na cara, em vez de fingir que fecha.
//
// CAR DESTINY dirige os veículos ao vivo: OWN = frota de marketing (ativo),
// TOOL = veículo de serviço (imobilizado); todo o custo dessas invoices sai
// do WIP e vira frota. Carro de cliente (USA/EXPORT/CLIENT) nunca é ativo
// nosso, mesmo titulado no nome da LLC.
import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { loadFinancials, invoiceTotals, rideScope, qtyLine, expLine, unpaidTotals, CAP_FLOOR, FinData } from '@/lib/financials'
import { downloadStatementPdf } from '@/lib/statementPdf'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const GZ = 'GZ28BR'

// Barra de composição: cada fatia proporcional ao peso na soma, com legenda.
const COMP_COLORS = ['bg-emerald-600', 'bg-sky-600', 'bg-amber-500', 'bg-purple-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-600', 'bg-indigo-500']
function Composition({ items }: { items: [string, number][] }) {
  const list = items.filter(([, v]) => v > 0)
  const total = list.reduce((s, [, v]) => s + v, 0) || 1
  return (
    <div>
      <div className="flex h-7 rounded-lg overflow-hidden mb-3">
        {list.map(([label, v], i) => (
          <div key={label} title={`${label}: ${usd(v)}`} className={COMP_COLORS[i % COMP_COLORS.length]} style={{ width: `${v / total * 100}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {list.map(([label, v], i) => (
          <div key={label} className="flex items-baseline gap-2 text-sm">
            <span className={`inline-block w-3 h-3 rounded-sm shrink-0 ${COMP_COLORS[i % COMP_COLORS.length]}`} />
            <span className="text-gray-400 flex-1 truncate">{label}</span>
            <span className="tabular-nums font-bold">{usd(v)}</span>
            <span className="text-gray-600 text-xs w-10 text-right">{(v / total * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function BalancePage() {
  const [d, setD] = useState<FinData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { loadFinancials().then(setD).catch(e => setError(String(e?.message || e))) }, [])

  const m = useMemo(() => {
    if (!d) return null
    let ar = 0, advances = 0, wip = 0, fleetOwn = 0, fleetTool = 0, flPayable = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const bal = t.grand - t.received
      if (bal > 0) ar += bal; else advances += -bal
      const scope = rideScope(d, inv)
      if (scope === 'OWN') fleetOwn += t.cost
      else if (scope === 'TOOL') fleetTool += t.cost
      else if (inv.live_status !== 'CLOSED') wip += t.cost
      if (t.flTax > 0 && !inv.fl_tax_expense_date) flPayable += t.flTax
    }
    // Conta corrente GZ28BR — mesmo algoritmo do GZ-FLOW, condensado:
    // GOT = receita nossa que entrou na conta deles; PAID = conta nossa que eles pagaram.
    const side = (r: { paid_from?: string | null; source?: string | null; paid_to?: string | null }) => {
      const by = r.paid_from || r.source || ''; const bill = r.paid_to || ''
      if (bill === GZ && by !== GZ) return 'GOT'
      if (by === GZ && bill !== GZ) return 'PAID'
      return null
    }
    let got = d.payments.filter(p => p.paid_to === GZ && p.paid_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    let paid = 0
    const scan = (rows: any[], amt: (r: any) => number) => {          // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const r of rows) { const sd = side(r); if (sd === 'PAID') paid += amt(r); else if (sd === 'GOT') got += amt(r) }
    }
    scan(d.invExpenses, expLine); scan(d.goods, qtyLine); scan(d.goodExpenses, r => parseFloat(r.amount) || 0)
    scan(d.inputs, qtyLine); scan(d.inventory, qtyLine)
    scan(d.fixedExpenses, r => parseFloat(r.amount) || 0); scan(d.expenses, r => parseFloat(r.amount) || 0)

    const stockPurch = d.inventory.filter(s => s.source_type === 'PURCHASED').reduce((s, r) => s + qtyLine(r), 0)
    const stockDon = d.inventory.filter(s => s.source_type === 'DONATED').reduce((s, r) => s + qtyLine(r), 0)
    const equip = d.goods.filter(g => qtyLine(g) >= CAP_FLOOR).reduce((s, g) => s + qtyLine(g), 0)
    const unpaid = unpaidTotals(d)
    const draws = d.expenses.filter(e => e.origin === 'PERSONAL').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
    const brNet = got - paid
    const totalAtivo = ar + Math.max(brNet, 0) + wip + stockPurch + stockDon + equip + fleetTool + fleetOwn
    const totalPassivo = unpaid.total + advances + flPayable + Math.max(-brNet, 0)
    return { ar, advances, wip, fleetOwn, fleetTool, flPayable, brNet, stockPurch, stockDon, equip, unpaid, draws, totalAtivo, totalPassivo }
  }, [d])

  async function downloadPdf() {
    if (!m) return
    const na = 'sem registro'
    await downloadStatementPdf({
      filename: 'GZ28US_Balanco.pdf',
      title: 'Balanço Patrimonial',
      subtitle: 'Posição de hoje · derivada ao vivo do Control App (não fecha até existirem caixa, capital e empréstimos — Fase 2)',
      kpis: [
        ['Total do ativo (ex-caixa)', usd(m.totalAtivo)],
        ['Passivo conhecido', usd(m.totalPassivo)],
        ['Conta corrente GZ28BR', usd(m.brNet)],
        ['Frota própria', usd(m.fleetOwn + m.fleetTool)],
      ],
      tables: [
        {
          title: 'ATIVO', head: ['', 'HOJE'], rows: [
            { cells: ['Caixa e equivalentes', `? (${na} — G5)`] },
            { cells: ['Contas a receber', usd(m.ar)] },
            ...(m.brNet > 0 ? [{ cells: ['Conta corrente GZ28BR', usd(m.brNet)] }] : []),
            { cells: ['Obras em andamento (WIP)', usd(m.wip)] },
            { cells: ['Estoque de peças', usd(m.stockPurch)] },
            { cells: ['Estoque doado', usd(m.stockDon)] },
            { cells: ['Imobilizado — equipamento', usd(m.equip)] },
            { cells: ['Imobilizado — veículos de serviço (TOOL)', usd(m.fleetTool)] },
            { cells: ['Frota de marketing (OWN)', usd(m.fleetOwn)] },
            { cells: ['TOTAL DO ATIVO (ex-caixa)', usd(m.totalAtivo)], bold: true },
          ],
        },
        {
          title: 'PASSIVO', head: ['', 'HOJE'], rows: [
            { cells: ['Fornecedores a pagar', usd(m.unpaid.total)] },
            { cells: ['Adiantamentos de clientes', usd(m.advances)] },
            { cells: ['FL sales tax a recolher', usd(m.flPayable)] },
            ...(m.brNet < 0 ? [{ cells: ['Devido à GZ28BR', usd(-m.brNet)] }] : []),
            { cells: ['Empréstimos e financiamentos', `? (${na} — G3)`] },
            { cells: ['TOTAL DO PASSIVO (conhecido)', usd(m.totalPassivo)], bold: true },
          ],
        },
        {
          title: 'PATRIMÔNIO LÍQUIDO', head: ['', 'HOJE'], rows: [
            { cells: ['Capital integralizado', `? (${na} — G2)`] },
            { cells: ['Retiradas dos sócios', usd(-m.draws)] },
            { cells: ['Resultado acumulado', 'deriva da DRE (D1–D3 pendentes)'] },
          ],
        },
      ],
      notes: [
        'Balanço parcial: caixa (G5), capital (G2) e empréstimos (G3) ainda não têm registro no Control App — sem eles a equação não fecha.',
        'CAR DESTINY separa dono de papelada: carro de cliente (USA/EXPORT/CLIENT) nunca é ativo da LLC, mesmo titulado no nosso nome; OWN/TOOL são nossos e capitalizam.',
        'Fornecedores a pagar inclui linhas sem payment_date que podem estar só sem preencher (G6).',
      ],
    })
  }

  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>
  if (!d || !m) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  const Chip = ({ kind, label }: { kind: 'ok' | 'gap' | 'dec'; label: string }) => (
    <span className={`px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap ${kind === 'ok' ? 'bg-emerald-950 text-emerald-400' : kind === 'gap' ? 'bg-red-950 text-red-400' : 'bg-amber-950 text-amber-300'}`}>{label}</span>
  )
  const Row = ({ label, value, chip, note, total }: { label: string; value: number | null; chip?: React.ReactNode; note?: string; total?: boolean }) => (
    <div className={`px-4 py-2.5 flex justify-between items-baseline gap-3 border-t border-gray-800 ${total ? 'bg-gray-900 font-bold' : ''}`}>
      <span className={`flex items-baseline gap-2 flex-wrap ${total ? '' : 'text-gray-300'}`}>{label}{chip}
        {note && <span className="block w-full text-xs text-gray-600">{note}</span>}</span>
      <span className={`tabular-nums whitespace-nowrap ${value === null ? 'text-gray-600' : ''} ${total ? 'text-lg' : ''}`}>{value === null ? '?' : usd(value)}</span>
    </div>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">BALANÇO PATRIMONIAL</h1>
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL</a>
      </div>
      <p className="text-gray-400 mb-5 max-w-3xl">Posição de hoje, derivada ao vivo. CAR DESTINY separa o que é nosso do que só está no nosso nome.</p>

      <div className="flex mb-6"><button onClick={downloadPdf} className="px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500">⬇ BAIXAR PDF</button></div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mb-6">
        {[['TOTAL DO ATIVO (EX-CAIXA)', m.totalAtivo, 'text-gray-200'],
          ['PASSIVO CONHECIDO', m.totalPassivo, 'text-red-400'],
          ['CONTA CORRENTE GZ28BR', m.brNet, m.brNet < 0 ? 'text-red-400' : 'text-emerald-400'],
          ['FROTA PRÓPRIA (OWN+TOOL)', m.fleetOwn + m.fleetTool, 'text-amber-300']].map(([label, v, cls]) => (
          <div key={label as string} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <p className="text-xs font-bold text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{usd(v as number)}</p>
          </div>
        ))}
      </div>

      <div className="bg-red-950/50 border border-red-900 rounded-2xl p-4 mb-6 text-sm text-red-200 max-w-2xl">
        <p className="font-bold">ESTE BALANÇO AINDA NÃO FECHA — de propósito.</p>
        <p>Caixa (G5), capital integralizado (G2) e empréstimos (G3) não têm registro no app. Sem eles não existe o outro lado da equação. Fase 2 do blueprint cria os três livros.</p>
      </div>

      {/* Composição do ativo e do passivo */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl mb-8 items-start">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DE QUE É FEITO O ATIVO</p>
          <Composition items={[
            ['Contas a receber', m.ar],
            ['WIP (jobs abertos)', m.wip],
            ['Conta corrente GZ28BR', Math.max(m.brNet, 0)],
            ['Frota de marketing (OWN)', m.fleetOwn],
            ['Estoque (comprado + doado)', m.stockPurch + m.stockDon],
            ['Equipamento', m.equip],
            ['Veículos de serviço (TOOL)', m.fleetTool],
          ]} />
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DE QUE É FEITO O PASSIVO CONHECIDO</p>
          <Composition items={[
            ['Fornecedores a pagar', m.unpaid.total],
            ['Adiantamentos de clientes', m.advances],
            ['FL sales tax a recolher', m.flPayable],
            ['Devido à GZ28BR', Math.max(-m.brNet, 0)],
          ]} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 max-w-6xl items-start">
        <div className="border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 bg-gray-900 font-bold text-lg">ATIVO</div>
          <Row label="Caixa e equivalentes" value={null} chip={<Chip kind="gap" label="G5" />} note="bank_transactions vazio — sync Plaid ou saldo mensal manual" />
          <Row label="Contas a receber" value={m.ar} chip={<Chip kind="ok" label="AO VIVO" />} note="faturado − recebido, por invoice" />
          {m.brNet > 0 && <Row label="Conta corrente GZ28BR" value={m.brNet} chip={<Chip kind="ok" label="GZ-FLOW" />} note="receita nossa na conta deles − contas nossas que eles pagaram" />}
          <Row label="Obras em andamento (WIP)" value={m.wip} chip={<Chip kind="dec" label="D2/D3" />} note="custo de jobs abertos de clientes — inclui carros EXPORT ainda não separados" />
          <Row label="Estoque de peças" value={m.stockPurch} chip={<Chip kind="ok" label="AO VIVO" />} />
          <Row label="Estoque doado" value={m.stockDon} chip={<Chip kind="dec" label="D6" />} note="valor creditado ao job doador" />
          <Row label="Imobilizado — equipamento" value={m.equip} chip={<Chip kind="dec" label="D8" />} note={`GOODS ≥ $${CAP_FLOOR.toLocaleString()} · sem depreciação ainda (G4)`} />
          <Row label="Imobilizado — veículos de serviço" value={m.fleetTool} chip={<Chip kind="ok" label="TOOL" />} note="todo o investido nas rides TOOL" />
          <Row label="Frota de marketing" value={m.fleetOwn} chip={<Chip kind="ok" label="OWN" />} note="todo o investido nas rides OWN — GENEZIZ não deprecia, nunca será vendido" />
          <Row label="TOTAL DO ATIVO (ex-caixa)" value={m.totalAtivo} total />
        </div>

        <div className="space-y-8">
          <div className="border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-900 font-bold text-lg">PASSIVO</div>
            <Row label="Fornecedores a pagar" value={m.unpaid.total} chip={<Chip kind="dec" label="G6" />}
              note={`projetos ${usd(m.unpaid.inv)} · fixos ${usd(m.unpaid.fixed)} · folha ${usd(m.unpaid.staff)} — sem payment_date pode ser devido OU só sem preencher`} />
            <Row label="Adiantamentos de clientes" value={m.advances} chip={<Chip kind="dec" label="D9" />} note="recebido > faturado — inclui os jobs legados sem linhas" />
            <Row label="FL sales tax a recolher" value={m.flPayable} chip={<Chip kind="ok" label="AO VIVO" />} note="faturado com fl_tax_expense_date vazio" />
            {m.brNet < 0 && <Row label="Devido à GZ28BR" value={-m.brNet} chip={<Chip kind="ok" label="GZ-FLOW" />} />}
            <Row label="Empréstimos e financiamentos" value={null} chip={<Chip kind="gap" label="G3" />} note="K&G Financing só existe como string de despesa" />
            <Row label="TOTAL DO PASSIVO (conhecido)" value={m.totalPassivo} total />
          </div>

          <div className="border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-900 font-bold text-lg">PATRIMÔNIO LÍQUIDO</div>
            <Row label="Capital integralizado" value={null} chip={<Chip kind="gap" label="G2" />} note="nenhuma tabela registra aporte dos sócios" />
            <Row label="Retiradas dos sócios" value={-m.draws} chip={<Chip kind="ok" label="AO VIVO" />} note="expenses origin PERSONAL — só o que foi capturado" />
            <Row label="Resultado acumulado" value={null} chip={<Chip kind="dec" label="DRE" />} note="deriva da DRE quando D1–D3 fecharem" />
          </div>
        </div>
      </div>
    </main>
  )
}
