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
import FinBadge from '@/components/FinBadge'
import { BASE_PATH } from '@/lib/utils'
import { loadFinancials, invoiceTotals, rideScope, ledgerTotals, qtyLine, expLine, unpaidTotals, isCarLine, fleetDepreciation, CAP_FLOOR, FinData } from '@/lib/financials'
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
    let ar = 0, advances = 0, wip = 0, wipCars = 0, fleetOwn = 0, fleetTool = 0, donorCost = 0, flPayable = 0
    for (const inv of d.invoices) {
      const t = invoiceTotals(d, inv)
      const scope = rideScope(d, inv)
      // DONOR entra no guard: crédito de peça puxada do doador não é
      // adiantamento de cliente, e doador não gera A/R.
      const ours = scope === 'OWN' || scope === 'TOOL' || scope === 'DONOR'
      // Carro nosso não gera A/R, adiantamento nem FL tax — ninguém nos deve
      // pelo nosso próprio carro; linha de preço em invoice nossa é display.
      if (!ours) {
        const bal = t.grand - t.received
        if (bal > 0) ar += bal; else advances += -bal
        if (t.flTax > 0 && !inv.fl_tax_expense_date) flPayable += t.flTax
      }
      if (scope === 'OWN') fleetOwn += t.cost
      else if (scope === 'TOOL') fleetTool += t.cost
      else if (scope === 'DONOR') donorCost += t.cost
      // Carro EXPORTED embarcou: trabalho entregue, custo não é mais obra
      // em andamento — fica no CPV as-booked, fora do WIP.
      else if (inv.live_status !== 'CLOSED' && !(inv.ride_id && d.rides.get(inv.ride_id)?.exported)) {
        wip += t.cost
        // CARROS × OFICINA (João, 25/ago): quanto do WIP é carro de export parado.
        const nick = (inv.ride_id && d.rides.get(inv.ride_id)?.project_name) || null
        wipCars += d.invExpenses.filter((e: any) => e.invoice_id === inv.id && isCarLine(e.item, expLine(e), nick)).reduce((s: number, e: any) => s + expLine(e), 0)
      }
    }
    // G4 (25/ago): a frota entra LÍQUIDA de depreciação — o bruto virou custo
    // consumido; MONUMENTO e RESERVA seguem ao custo (a classe decide no motor).
    const fdep = fleetDepreciation(d)
    const depOwn = fdep?.own || 0, depTool = fdep?.tool || 0
    fleetOwn = Math.max(0, fleetOwn - depOwn)
    fleetTool = Math.max(0, fleetTool - depTool)

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
    // Sócio (Beto) pagou conta da LLC do bolso: a LLC deve a ele — Empréstimo de
    // sócio no passivo. RAFA era sócio da GZ28BR (assunto do lado de lá), fica fora.
    let beto = 0, heraldo = 0
    const scan = (rows: any[], amt: (r: any) => number) => {          // eslint-disable-line @typescript-eslint/no-explicit-any
      // Sem payment_date ainda não foi pago — está em Fornecedores a Pagar;
      // contar aqui também seria o mesmo passivo duas vezes.
      for (const r of rows) { if (!r.payment_date) continue; if (r.paid_from === 'BETO') { beto += amt(r); continue } if (r.paid_from === 'HERALDO') { heraldo += amt(r); continue } const sd = side(r); if (sd === 'PAID') paid += amt(r); else if (sd === 'GOT') got += amt(r) }
    }
    scan(d.invExpenses, expLine); scan(d.goods, qtyLine); scan(d.goodExpenses, r => parseFloat(r.amount) || 0)
    scan(d.inputs, qtyLine); scan(d.inventory, qtyLine)
    scan(d.fixedExpenses, r => parseFloat(r.amount) || 0); scan(d.expenses, r => parseFloat(r.amount) || 0)

    const stockPurch = d.inventory.filter(s => s.source_type === 'PURCHASED').reduce((s, r) => s + qtyLine(r), 0)
    const stockDon = d.inventory.filter(s => s.source_type === 'DONATED').reduce((s, r) => s + qtyLine(r), 0)
    const equip = d.goods.filter(g => qtyLine(g) >= CAP_FLOOR).reduce((s, g) => s + qtyLine(g), 0)
      + d.goodExpenses.filter(g => (parseFloat(g.amount) || 0) >= CAP_FLOOR).reduce((s, g) => s + (parseFloat(g.amount) || 0), 0)
    const unpaid = unpaidTotals(d)
    const draws = d.expenses.filter(e => e.origin === 'PERSONAL').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
    const brNet = got - paid
    const lt = ledgerTotals(d)
    const cash = lt ? lt.cashTotal : 0
    const loans = lt ? lt.loanBalance : 0
    const totalAtivo = cash + ar + Math.max(brNet, 0) + wip + stockPurch + stockDon + equip + fleetTool + fleetOwn + donorCost
    const totalPassivo = unpaid.total + advances + flPayable + Math.max(-brNet, 0) + Math.max(loans, 0) + beto + heraldo
    // Residual = ativo − passivo − capital líquido. É o resultado acumulado
    // MAIS tudo que ainda não foi lançado — vai convergindo conforme os
    // livros e o DATA CHECK zeram. Só existe com os livros vivos.
    const residual = lt ? totalAtivo - totalPassivo - (lt.contributions - lt.capDraws - draws) : null
    return { ar, advances, wip, wipCars, fleetOwn, fleetTool, depOwn, depTool, donorCost, flPayable, brNet, beto, heraldo, stockPurch, stockDon, equip, unpaid, draws, totalAtivo, totalPassivo, lt, residual }
  }, [d])

  async function downloadPdf() {
    if (!m) return
    const na = 'sem registro'
    await downloadStatementPdf({
      filename: 'GZ28US_Balanco.pdf',
      title: 'Balanço Patrimonial',
      subtitle: 'Posição de hoje · derivada ao vivo do Control App (não fecha até existirem caixa, capital e empréstimos — Fase 2)',
      kpis: [
        [m.lt ? 'Total do ativo' : 'Total do ativo (ex-caixa)', usd(m.totalAtivo)],
        ['Passivo conhecido', usd(m.totalPassivo)],
        ['Conta corrente GZ28BR', usd(m.brNet)],
        ['Frota própria', usd(m.fleetOwn + m.fleetTool)],
      ],
      tables: [
        {
          title: 'ATIVO', head: ['', 'HOJE'], rows: [
            { cells: ['Caixa e equivalentes', m.lt ? usd(m.lt.cashTotal) : `? (${na} — G5)`] },
            { cells: ['Contas a receber', usd(m.ar)] },
            ...(m.brNet > 0 ? [{ cells: ['Conta corrente GZ28BR', usd(m.brNet)] }] : []),
            { cells: [m.wipCars > 0 ? `Obras em andamento (WIP) — oficina ${usd(m.wip - m.wipCars)} + carros export ${usd(m.wipCars)}` : 'Obras em andamento (WIP)', usd(m.wip)] },
            { cells: ['Estoque de peças', usd(m.stockPurch)] },
            { cells: ['Estoque doado', usd(m.stockDon)] },
            { cells: ['Imobilizado — equipamento', usd(m.equip)] },
            { cells: [m.depTool > 0 ? `Imobilizado — veículos de serviço (TOOL, líquido de dep. ${usd(m.depTool)})` : 'Imobilizado — veículos de serviço (TOOL)', usd(m.fleetTool)] },
            { cells: [m.depOwn > 0 ? `Frota de marketing & desenvolvimento (OWN, líquido de dep. ${usd(m.depOwn)})` : 'Frota de marketing & desenvolvimento (OWN)', usd(m.fleetOwn)] },
            { cells: ['Carros doadores — part-out (DONOR)', usd(m.donorCost)] },
            { cells: [m.lt ? 'TOTAL DO ATIVO' : 'TOTAL DO ATIVO (ex-caixa)', usd(m.totalAtivo)], bold: true },
          ],
        },
        {
          title: 'PASSIVO', head: ['', 'HOJE'], rows: [
            { cells: ['Fornecedores a pagar', usd(m.unpaid.total)] },
            { cells: ['Adiantamentos de clientes', usd(m.advances)] },
            { cells: ['FL sales tax a recolher', usd(m.flPayable)] },
            ...(m.brNet < 0 ? [{ cells: ['Devido à GZ28BR', usd(-m.brNet)] }] : []),
            ...(m.beto > 0 ? [{ cells: ['Empréstimo de sócio — Beto', usd(m.beto)] }] : []),
            ...(m.heraldo > 0 ? [{ cells: ['Empréstimo de sócio — Heraldo', usd(m.heraldo)] }] : []),
            { cells: ['Empréstimos e financiamentos', m.lt ? usd(m.lt.loanBalance) : `? (${na} — G3)`] },
            { cells: ['TOTAL DO PASSIVO (conhecido)', usd(m.totalPassivo)], bold: true },
          ],
        },
        {
          title: 'PATRIMÔNIO LÍQUIDO', head: ['', 'HOJE'], rows: [
            { cells: ['Capital integralizado', m.lt ? usd(m.lt.contributions) : `? (${na} — G2)`] },
            { cells: ['Retiradas dos sócios', usd(-(m.draws + (m.lt ? m.lt.capDraws : 0)))] },
            { cells: ['Resultado acumulado + não lançado (residual)', m.residual === null ? 'aguarda os livros' : usd(m.residual)] },
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
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL HUB</a>
      </div>
      <p className="text-gray-400 mb-5 max-w-3xl">Posição de hoje, derivada ao vivo. CAR DESTINY separa o que é nosso do que só está no nosso nome.</p>

      <div className="flex mb-6"><button onClick={downloadPdf} className="px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500">⬇ BAIXAR PDF</button></div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mb-6">
        {[[m.lt ? 'TOTAL DO ATIVO' : 'TOTAL DO ATIVO (EX-CAIXA)', m.totalAtivo, 'text-gray-200'],
          ['PASSIVO CONHECIDO', m.totalPassivo, 'text-red-400'],
          ['CONTA CORRENTE GZ28BR', m.brNet, m.brNet < 0 ? 'text-red-400' : 'text-emerald-400'],
          ['FROTA PRÓPRIA (OWN+TOOL)', m.fleetOwn + m.fleetTool, 'text-amber-300']].map(([label, v, cls]) => (
          <div key={label as string} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <p className="text-xs font-bold text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{usd(v as number)}</p>
          </div>
        ))}
      </div>

      {!m.lt ? (
        <div className="bg-red-950/50 border border-red-900 rounded-2xl p-4 mb-6 text-sm text-red-200 max-w-2xl">
          <p className="font-bold">ESTE BALANÇO AINDA NÃO FECHA — de propósito.</p>
          <p>Caixa (G5), capital (G2) e empréstimos (G3) não têm registro. Rode MIGRATION_financial_ledgers.sql e lance os livros em LEDGERS — aí a equação ganha o outro lado.</p>
        </div>
      ) : (
        <div className="bg-sky-950/40 border border-sky-900 rounded-2xl p-4 mb-6 text-sm text-sky-200 max-w-2xl">
          <p className="font-bold">LIVROS ATIVOS.</p>
          <p>Caixa, capital e empréstimos vêm de LEDGERS. O residual do patrimônio é o resultado acumulado MAIS o que ainda não foi lançado — ele converge pro resultado real conforme os livros e o DATA CHECK zeram.</p>
        </div>
      )}

      {/* Composição do ativo e do passivo */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl mb-8 items-start">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DE QUE É FEITO O ATIVO</p>
          <Composition items={[
            ['Caixa', m.lt ? m.lt.cashTotal : 0],
            ['Contas a receber', m.ar],
            ['WIP — oficina', m.wip - m.wipCars],
            ['WIP — carros de export', m.wipCars],
            ['Conta corrente GZ28BR', Math.max(m.brNet, 0)],
            ['Frota de marketing & desenvolvimento (OWN)', m.fleetOwn],
            ['Estoque (comprado + doado)', m.stockPurch + m.stockDon],
            ['Equipamento', m.equip],
            ['Veículos de serviço (TOOL)', m.fleetTool],
            ['Doadores (part-out)', m.donorCost],
          ]} />
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <p className="text-sm font-bold text-gray-400 mb-4">DE QUE É FEITO O PASSIVO CONHECIDO</p>
          <Composition items={[
            ['Fornecedores a pagar', m.unpaid.total],
            ['Adiantamentos de clientes', m.advances],
            ['FL sales tax a recolher', m.flPayable],
            ['Devido à GZ28BR', Math.max(-m.brNet, 0)],
            ['Empréstimo de sócio — Beto', m.beto],
            ['Empréstimo de sócio — Heraldo', m.heraldo],
          ]} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 max-w-6xl items-start">
        <div className="border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 bg-gray-900 font-bold text-lg">ATIVO</div>
          {m.lt
            ? <Row label="Caixa e equivalentes" value={m.lt.cashTotal} chip={<Chip kind="ok" label="LEDGERS" />}
                note={m.lt.cashAccounts.length ? m.lt.cashAccounts.map(a => `${a.account}: ${usd(a.balance)} em ${a.date}`).join(' · ') : 'nenhum saldo lançado ainda — LEDGERS → SALDOS DE CAIXA'} />
            : <Row label="Caixa e equivalentes" value={null} chip={<Chip kind="gap" label="G5" />} note="rode MIGRATION_financial_ledgers.sql e lance os saldos em LEDGERS" />}
          <Row label="Contas a receber" value={m.ar} chip={<Chip kind="ok" label="AO VIVO" />} note="faturado − recebido, por invoice" />
          {m.brNet > 0 && <Row label="Conta corrente GZ28BR" value={m.brNet} chip={<Chip kind="ok" label="GZ-FLOW" />} note="receita nossa na conta deles − contas nossas que eles pagaram" />}
          <Row label="Obras em andamento (WIP)" value={m.wip} chip={<Chip kind="dec" label="D2/D3" />} note="custo de jobs abertos de clientes — carro EXPORTED já saiu daqui" />
          <Row label="Estoque de peças" value={m.stockPurch} chip={<Chip kind="ok" label="AO VIVO" />} />
          <Row label="Estoque doado" value={m.stockDon} chip={<Chip kind="dec" label="D6" />} note="valor creditado ao job doador" />
          <Row label="Imobilizado — equipamento" value={m.equip} chip={<Chip kind="dec" label="D8" />} note={`GOODS ≥ $${CAP_FLOOR.toLocaleString()} · sem depreciação ainda (G4)`} />
          <Row label="Imobilizado — veículos de serviço" value={m.fleetTool} chip={<Chip kind="ok" label="TOOL" />} note="todo o investido nas rides TOOL" />
          <Row label="Frota de marketing & desenvolvimento" value={m.fleetOwn} chip={<Chip kind="ok" label="OWN" />} note="todo o investido nas rides OWN — GENEZIZ não deprecia, nunca será vendido" />
          <Row label="Carros doadores (part-out)" value={m.donorCost} chip={<Chip kind="ok" label="DONOR" />} note="carcaça comprada pra virar estoque de peças; crédito de peça puxada abate via fluxo de doador" />
          <Row label={m.lt ? 'TOTAL DO ATIVO' : 'TOTAL DO ATIVO (ex-caixa)'} value={m.totalAtivo} total />
        </div>

        <div className="space-y-8">
          <div className="border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-900 font-bold text-lg">PASSIVO</div>
            <Row label="Fornecedores a pagar" value={m.unpaid.total} chip={<Chip kind="dec" label="G6" />}
              note={`projetos ${usd(m.unpaid.inv)} · fixos ${usd(m.unpaid.fixed)} · folha ${usd(m.unpaid.staff)} · compras ${usd(m.unpaid.purchases)} — sem payment_date pode ser devido OU só sem preencher`} />
            <Row label="Adiantamentos de clientes" value={m.advances} chip={<Chip kind="dec" label="D9" />} note="recebido > faturado — inclui os jobs legados sem linhas" />
            <Row label="FL sales tax a recolher" value={m.flPayable} chip={<Chip kind="ok" label="AO VIVO" />} note="faturado com fl_tax_expense_date vazio" />
            {m.brNet < 0 && <Row label="Devido à GZ28BR" value={-m.brNet} chip={<Chip kind="ok" label="GZ-FLOW" />} />}
            {m.beto > 0 && <Row label="Empréstimo de sócio — Beto" value={m.beto} chip={<Chip kind="ok" label="PAID FROM" />} note="contas da LLC que o Beto pagou do bolso (paid_from = BETO) — a LLC deve a ele" />}
            {m.heraldo > 0 && <Row label="Empréstimo de sócio — Heraldo" value={m.heraldo} chip={<Chip kind="ok" label="PAID FROM" />} note="contas da LLC que o Heraldo pagou do bolso (paid_from = HERALDO) — a LLC deve a ele; depósitos dele entram pelo livro de empréstimos (LEDGERS)" />}
            {m.lt
              ? <Row label="Empréstimos e financiamentos" value={m.lt.loanBalance} chip={<Chip kind="ok" label="LEDGERS" />} note="saldo devedor: recebido − amortizado, por contrato" />
              : <Row label="Empréstimos e financiamentos" value={null} chip={<Chip kind="gap" label="G3" />} note="rode a migration e lance os contratos em LEDGERS" />}
            <Row label="TOTAL DO PASSIVO (conhecido)" value={m.totalPassivo} total />
          </div>

          <div className="border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-900 font-bold text-lg">PATRIMÔNIO LÍQUIDO</div>
            {m.lt
              ? <Row label="Capital integralizado" value={m.lt.contributions} chip={<Chip kind="ok" label="LEDGERS" />} note="aportes lançados no livro de capital" />
              : <Row label="Capital integralizado" value={null} chip={<Chip kind="gap" label="G2" />} note="rode a migration e lance os aportes em LEDGERS" />}
            <Row label="Retiradas dos sócios" value={-(m.draws + (m.lt ? m.lt.capDraws : 0))} chip={<Chip kind="ok" label="AO VIVO" />} note="retiradas formais (LEDGERS) + expenses origin PERSONAL" />
            <Row label="Resultado acumulado + não lançado" value={m.residual} chip={<Chip kind="dec" label="RESIDUAL" />} note="ativo − passivo − capital líquido; converge pro resultado real conforme os livros enchem" />
          </div>
        </div>
      </div>
    </main>
  )
}
