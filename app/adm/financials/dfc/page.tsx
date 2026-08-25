'use client'

// DFC — Demonstração do Fluxo de Caixa, método direto, regime de caixa.
// Cada célula é a soma de eventos reais (payment_date / paid_at) e clica para
// abrir as linhas de origem embaixo. Linha sem data de pagamento não é caixa —
// vive no Balanço como contas a pagar. Fase 1 do blueprint: sem decisão
// pendente, sem migração — só leitura do que já existe.
import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import FinBadge from '@/components/FinBadge'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import { loadFinancials, buildCashEvents, CashEvent } from '@/lib/financials'
import { sessionHeaders } from '@/components/BankReconcileCard'
import { downloadStatementPdf } from '@/lib/statementPdf'

const usd0 = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const MONTH_LABELS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']

// Estrutura da demonstração: linhas-folha (drill) e subtotais por seção.
type RowDef =
  | { kind: 'line'; key: string; label: string }
  | { kind: 'sub'; keys: string[]; label: string }
  | { kind: 'head'; label: string }
const ROWS: RowDef[] = [
  { kind: 'head', label: 'OPERAÇÕES' },
  { kind: 'line', key: 'RECEIPTS', label: 'Recebimentos de clientes' },
  { kind: 'line', key: 'RECEIPTS_BR', label: 'Recebimentos via GZ28BR' },
  { kind: 'line', key: 'JOB_COST', label: 'Fornecedores de projetos' },
  { kind: 'sub', keys: ['RECEIPTS', 'RECEIPTS_BR', 'JOB_COST'], label: 'Contribuição dos projetos' },
  { kind: 'line', key: 'PAYROLL', label: 'Folha (staff)' },
  { kind: 'line', key: 'FIXED', label: 'Ocupação, seguros & profissionais' },
  { kind: 'line', key: 'MARKETING', label: 'Marketing' },
  { kind: 'line', key: 'APPS', label: 'Software & assinaturas' },
  { kind: 'line', key: 'MISC', label: 'Consumíveis & diversos' },
  { kind: 'sub', keys: ['RECEIPTS', 'RECEIPTS_BR', 'JOB_COST', 'PAYROLL', 'FIXED', 'MARKETING', 'APPS', 'MISC'], label: 'Caixa das operações' },
  { kind: 'head', label: 'INVESTIMENTOS' },
  { kind: 'line', key: 'EQUIP', label: 'Equipamento de oficina (GOODS)' },
  { kind: 'line', key: 'STOCK', label: 'Estoque de peças comprado' },
  { kind: 'sub', keys: ['EQUIP', 'STOCK'], label: 'Caixa de investimentos' },
  { kind: 'head', label: 'FINANCIAMENTO' },
  { kind: 'line', key: 'CAPITAL', label: 'Aportes de capital' },
  { kind: 'line', key: 'DRAW', label: 'Retiradas (sócios & pessoal)' },
  { kind: 'line', key: 'LOAN_IN', label: 'Empréstimos recebidos' },
  { kind: 'line', key: 'LOAN_PAY', label: 'Empréstimos amortizados' },
  { kind: 'line', key: 'INTEREST', label: 'Juros pagos' },
  // FIN 0.9.8 (João, 25/ago): quem bancou por nós — a despesa fica nas operações,
  // o financiamento espelhado zera o efeito no caixa (e casa com o Balanço).
  { kind: 'line', key: 'FUND_BR', label: 'Conta corrente GZ28BR (bancou / recebeu por nós)' },
  { kind: 'line', key: 'FUND_BETO', label: 'Empréstimo de sócio — Beto (bancou por nós)' },
  { kind: 'sub', keys: ['CAPITAL', 'DRAW', 'LOAN_IN', 'LOAN_PAY', 'INTEREST', 'FUND_BR', 'FUND_BETO'], label: 'Caixa de financiamento' },
]
const ALL_KEYS = ['RECEIPTS', 'RECEIPTS_BR', 'JOB_COST', 'PAYROLL', 'FIXED', 'MARKETING', 'APPS', 'MISC', 'EQUIP', 'STOCK', 'CAPITAL', 'DRAW', 'LOAN_IN', 'LOAN_PAY', 'INTEREST', 'FUND_BR', 'FUND_BETO']

// Gráfico: barras de entrada (verde) e saída (vermelho) por coluna + linha do
// caixa acumulado desde o início. SVG puro, mesmo espírito do GZ-FLOW.
function CashChart({ pts }: { pts: { label: string; inn: number; out: number; cum: number }[] }) {
  const W = 940, H = 240, PX = 42, PT = 14, PB = 30
  const maxBar = Math.max(1, ...pts.map(p => Math.max(p.inn, p.out)))
  const cumMin = Math.min(0, ...pts.map(p => p.cum))
  const cumMax = Math.max(1, ...pts.map(p => p.cum))
  const bw = (W - PX * 2) / Math.max(pts.length, 1)
  const yBar = (v: number) => H - PB - (v / maxBar) * (H - PT - PB)
  const yCum = (v: number) => H - PB - ((v - cumMin) / (cumMax - cumMin || 1)) * (H - PT - PB)
  const line = pts.map((p, i) => `${PX + i * bw + bw / 2},${yCum(p.cum)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1={PX} y1={H - PB} x2={W - PX} y2={H - PB} stroke="#374151" strokeWidth="1" />
      {cumMin < 0 && <line x1={PX} y1={yCum(0)} x2={W - PX} y2={yCum(0)} stroke="#4b5563" strokeWidth="0.5" strokeDasharray="4 4" />}
      {pts.map((p, i) => {
        const x = PX + i * bw
        return (
          <g key={i}>
            {p.inn > 0 && <rect x={x + bw * 0.14} width={bw * 0.3} y={yBar(p.inn)} height={H - PB - yBar(p.inn)} fill="#10b981" rx="2" />}
            {p.out > 0 && <rect x={x + bw * 0.54} width={bw * 0.3} y={yBar(p.out)} height={H - PB - yBar(p.out)} fill="#ef4444" rx="2" />}
            <text x={x + bw / 2} y={H - PB + 16} textAnchor="middle" fill="#6b7280" fontSize="10" fontWeight="bold">{p.label}</text>
          </g>
        )
      })}
      <polyline points={line} fill="none" stroke="#e5e7eb" strokeWidth="2" />
      {pts.map((p, i) => <circle key={i} cx={PX + i * bw + bw / 2} cy={yCum(p.cum)} r="3" fill="#e5e7eb" />)}
    </svg>
  )
}

export default function DfcPage() {
  const [events, setEvents] = useState<CashEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [year, setYear] = useState<string>('')          // '' = ALL (colunas viram anos)
  const [drill, setDrill] = useState<{ key: string; col: string; label: string } | null>(null)
  const [bankImplied, setBankImplied] = useState<number | null>(null)   // extrato + linhas postadas (leitura grátis)

  useEffect(() => {
    loadFinancials()
      .then(d => { const ev = buildCashEvents(d); setEvents(ev); setYear(ev.length ? ev[ev.length - 1].date.slice(0, 4) : ''); setLoading(false) })
      .catch(e => { setError(String(e?.message || e)); setLoading(false) })
    // Régua (pergunta do João, 25/ago): o acumulado do DFC deve CONVERGIR pro
    // saldo do banco — leitura grátis (cache 10min), nunca a chamada paga.
    ;(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/plaid/balance`, { headers: await sessionHeaders() })
        const j = await r.json().catch(() => ({}))
        if (r.ok && Array.isArray(j.items)) {
          const vals = j.items.map((i: any) => i?.integrity?.implied).filter((v: any) => typeof v === 'number')
          if (vals.length) setBankImplied(vals.reduce((s: number, v: number) => s + v, 0))
        }
      } catch { /* sem banco, sem régua — a tela segue viva */ }
    })()
  }, [])

  const years = useMemo(() => [...new Set(events.map(e => e.date.slice(0, 4)))].sort(), [events])

  // Colunas do modo atual + agregado linha×coluna + acumulado desde o início.
  const { cols, agg, cum, flow } = useMemo(() => {
    const cols = year
      ? Array.from({ length: 12 }, (_, i) => year + '-' + String(i + 1).padStart(2, '0'))
      : [...years]
    const colOf = (d: string) => (year ? d.slice(0, 7) : d.slice(0, 4))
    const agg: Record<string, Record<string, number>> = {}
    const flow: Record<string, { inn: number; out: number }> = {}
    for (const e of events) {
      const c = colOf(e.date)
      if (year && !c.startsWith(year)) continue
      ;(agg[e.line] ||= {})[c] = (agg[e.line][c] || 0) + e.amount
      const f = (flow[c] ||= { inn: 0, out: 0 })
      if (e.amount > 0) f.inn += e.amount; else f.out += -e.amount
    }
    // Acumulado geral (todas as linhas, história inteira) no FIM de cada coluna.
    const cum: Record<string, number> = {}
    for (const c of cols) {
      const end = year ? c + '-31' : c + '-12-31'
      cum[c] = events.filter(e => e.date <= end).reduce((s, e) => s + e.amount, 0)
    }
    return { cols, agg, cum, flow }
  }, [events, year, years])

  const cell = (key: string, col: string) => agg[key]?.[col] || 0
  const rowTotal = (key: string) => cols.reduce((s, c) => s + cell(key, c), 0)
  const subCell = (keys: string[], col: string) => keys.reduce((s, k) => s + cell(k, col), 0)

  const kpis = useMemo(() => {
    const inn = cols.reduce((s, c) => s + (flow[c]?.inn || 0), 0)
    const out = cols.reduce((s, c) => s + (flow[c]?.out || 0), 0)
    const endCum = cols.length ? cum[cols[cols.length - 1]] || 0 : 0
    return { inn, out, net: inn - out, endCum }
  }, [cols, flow, cum])

  const chartPts = useMemo(() => cols.map((c, i) => ({
    label: year ? MONTH_LABELS[i] : c,
    inn: flow[c]?.inn || 0, out: flow[c]?.out || 0, cum: cum[c] || 0,
  })), [cols, flow, cum, year])

  const drillRows = useMemo(() => {
    if (!drill) return []
    return events
      .filter(e => e.line === drill.key && (drill.col === 'TOTAL' ? (year ? e.date.startsWith(year) : true) : e.date.startsWith(drill.col)))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [drill, events, year])

  async function downloadPdf() {
    const label = year || 'Toda a história'
    const colLabels = year ? MONTH_LABELS.slice(0, cols.length) : cols
    const fmt = (v: number) => (v === 0 ? '—' : usd0(v))
    const rows = ROWS.filter(r => r.kind !== 'head').map(r => r.kind === 'line'
      ? { cells: [r.label, ...cols.map(c => fmt(cell(r.key, c))), fmt(rowTotal(r.key))] }
      : { cells: [r.label, ...cols.map(c => fmt(subCell((r as { keys: string[] }).keys, c))), fmt((r as { keys: string[] }).keys.reduce((s, k) => s + rowTotal(k), 0))], bold: true })
    rows.push({ cells: ['VARIAÇÃO LÍQUIDA', ...cols.map(c => fmt(subCell(ALL_KEYS, c))), fmt(ALL_KEYS.reduce((s, k) => s + rowTotal(k), 0))], bold: true })
    rows.push({ cells: ['Acumulado desde o início', ...cols.map(c => fmt(cum[c] || 0)), ''] })
    await downloadStatementPdf({
      filename: `GZ28US_DFC_${year || 'ALL'}.pdf`,
      title: 'DFC — Demonstração do Fluxo de Caixa',
      subtitle: `${label} · método direto, regime de caixa`,
      landscape: true,
      kpis: [['Entradas', usd0(kpis.inn)], ['Saídas', usd0(-kpis.out)], ['Variação líquida', usd0(kpis.net)], ['Acumulado no fim', usd0(kpis.endCum)]],
      tables: [{ head: ['', ...colLabels, 'TOTAL'], rows }],
      notes: [
        'Recebimentos de 2025 entraram na conta da GZ28BR — receita da GZ28US que virou saldo intercompany (GZ-FLOW).',
        'Aportes de capital e empréstimos entram pelo livro LEDGERS; sem eles lançados a variação líquida não bate com o extrato bancário.',
        'Linhas sem data de pagamento não são caixa e constam no Balanço como contas a pagar.',
      ],
    })
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>
  if (error) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-red-400">{error}</p></main>

  const money = (v: number, bold = false) => v === 0
    ? <span className="text-gray-700">—</span>
    : <span className={(v < 0 ? 'text-red-400' : 'text-emerald-400') + (bold ? ' font-bold' : '')}>{usd0(v)}</span>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">DFC — FLUXO DE CAIXA</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL HUB</a>
      </div>
      <p className="text-gray-400 mb-5 max-w-3xl">Método direto, regime de caixa (payment_date / paid_at). Clique numa célula para ver as linhas de origem. O que ainda não foi pago não aparece aqui — está no Balanço como contas a pagar.</p>

      {/* RÉGUA DA CONVERGÊNCIA (João, 25/ago): quando tudo estiver lançado e
          atribuído, acumulado do DFC = saldo do banco. A distância é a dívida
          de dados — e encolhe no Data Checker. */}
      {bankImplied != null && events.length > 0 && (() => {
        const cumAll = events.reduce((s, e) => s + e.amount, 0)
        const gap = cumAll - bankImplied
        const ok = Math.abs(gap) <= 1
        return (
          <div className={`border rounded-2xl px-5 py-3 mb-6 max-w-3xl ${ok ? 'bg-emerald-950/40 border-emerald-800' : 'bg-gray-900 border-gray-700'}`}>
            <p className="text-sm font-bold tracking-widest text-gray-500">O ACUMULADO BATE COM O BANCO? {ok ? <span className="text-emerald-300">BATE ✓</span> : <span className="text-amber-300">AINDA NÃO — distância {usd0(Math.abs(gap))}</span>}</p>
            <p className="text-xs text-gray-500 mt-1">DFC acumulado {usd0(cumAll)} · banco (extrato + linhas postadas) {usd0(bankImplied)}. A distância encolhe a cada linha do banco lançada (TO BOOK) e cada &quot;quem pagou?&quot; respondido — <a className="underline hover:text-white" href={`${BASE_PATH}/adm/check`}>DATA CHECKER →</a></p>
          </div>
        )
      })()}

      {/* Ano ou visão geral (colunas viram anos) + PDF */}
      <div className="flex gap-2 flex-wrap mb-6 items-center">
        {years.map(y => (
          <button key={y} onClick={() => { setYear(y); setDrill(null) }}
            className={`px-4 py-2 rounded-xl font-bold border ${year === y ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-700'}`}>{y}</button>
        ))}
        <button onClick={() => { setYear(''); setDrill(null) }}
          className={`px-4 py-2 rounded-xl font-bold border ${year === '' ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-700'}`}>TODOS OS ANOS</button>
        <button onClick={downloadPdf} className="ml-auto px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500">⬇ BAIXAR PDF</button>
      </div>

      {/* KPIs do período */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mb-6">
        {[['ENTRADAS', kpis.inn, 'text-emerald-400'], ['SAÍDAS', -kpis.out, 'text-red-400'],
          ['VARIAÇÃO LÍQUIDA', kpis.net, kpis.net < 0 ? 'text-red-400' : 'text-emerald-400'],
          ['ACUMULADO NO FIM', kpis.endCum, kpis.endCum < 0 ? 'text-red-400' : 'text-gray-200']].map(([label, v, cls]) => (
          <div key={label as string} className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <p className="text-xs font-bold text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{usd0(v as number)}</p>
          </div>
        ))}
      </div>

      {/* Entradas × saídas por período + acumulado */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-6 max-w-5xl">
        <div className="flex gap-5 text-xs font-bold text-gray-500 mb-2">
          <span><span className="inline-block w-3 h-3 rounded-sm bg-emerald-500 mr-1.5 align-middle" />ENTRADAS</span>
          <span><span className="inline-block w-3 h-3 rounded-sm bg-red-500 mr-1.5 align-middle" />SAÍDAS</span>
          <span><span className="inline-block w-6 h-0.5 bg-gray-200 mr-1.5 align-middle" />ACUMULADO</span>
        </div>
        <CashChart pts={chartPts} />
      </div>

      <div className="overflow-x-auto border border-gray-800 rounded-2xl">
        <table className="text-sm min-w-max">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left px-4 py-3 sticky left-0 bg-black text-gray-400 font-bold min-w-64">{year ? year : 'TODA A HISTÓRIA'}</th>
              {cols.map((c, i) => <th key={c} className="text-right px-3 py-3 text-gray-400 font-bold whitespace-nowrap">{year ? MONTH_LABELS[i] : c}</th>)}
              <th className="text-right px-4 py-3 text-gray-200 font-bold">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r, ri) => r.kind === 'head' ? (
              <tr key={ri}><td colSpan={cols.length + 2} className="px-4 pt-4 pb-1 text-xs font-bold text-gray-500 sticky left-0">{r.label}</td></tr>
            ) : r.kind === 'line' ? (
              <tr key={ri} className="border-t border-gray-900 hover:bg-gray-900/60">
                <td className="px-4 py-2 sticky left-0 bg-black text-gray-300 whitespace-nowrap">{r.label}</td>
                {cols.map(c => (
                  <td key={c} className="text-right px-3 py-2 tabular-nums whitespace-nowrap cursor-pointer hover:bg-gray-800"
                    onClick={() => setDrill({ key: r.key, col: c, label: r.label })}>{money(cell(r.key, c))}</td>
                ))}
                <td className="text-right px-4 py-2 tabular-nums font-bold cursor-pointer hover:bg-gray-800"
                  onClick={() => setDrill({ key: r.key, col: 'TOTAL', label: r.label })}>{money(rowTotal(r.key), true)}</td>
              </tr>
            ) : (
              <tr key={ri} className="border-t border-gray-700 bg-gray-900/80">
                <td className="px-4 py-2 sticky left-0 bg-gray-900 font-bold whitespace-nowrap">{r.label}</td>
                {cols.map(c => <td key={c} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">{money(subCell(r.keys, c), true)}</td>)}
                <td className="text-right px-4 py-2 tabular-nums">{money(r.keys.reduce((s, k) => s + rowTotal(k), 0), true)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-500 bg-gray-900">
              <td className="px-4 py-3 sticky left-0 bg-gray-900 font-bold text-lg whitespace-nowrap">VARIAÇÃO LÍQUIDA</td>
              {cols.map(c => <td key={c} className="text-right px-3 py-3 tabular-nums whitespace-nowrap">{money(subCell(ALL_KEYS, c), true)}</td>)}
              <td className="text-right px-4 py-3 tabular-nums text-lg">{money(ALL_KEYS.reduce((s, k) => s + rowTotal(k), 0), true)}</td>
            </tr>
            <tr className="border-t border-gray-800">
              <td className="px-4 py-2 sticky left-0 bg-black text-gray-500 font-bold whitespace-nowrap">ACUMULADO DESDE O INÍCIO</td>
              {cols.map(c => <td key={c} className="text-right px-3 py-2 tabular-nums text-gray-500 whitespace-nowrap">{usd0(cum[c] || 0)}</td>)}
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Drill-through: as linhas de origem da célula clicada */}
      {drill && (
        <div className="mt-6 bg-gray-900 border border-gray-700 rounded-2xl p-5 max-w-4xl">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <h2 className="text-xl font-bold">{drill.label} — {drill.col === 'TOTAL' ? (year || 'toda a história') : drill.col}</h2>
            <button onClick={() => setDrill(null)} className="text-gray-400 hover:text-white font-bold">FECHAR ✕</button>
          </div>
          {drillRows.length === 0 ? <p className="text-gray-500">Nada nesse período.</p> : (
            <div className="max-h-96 overflow-y-auto divide-y divide-gray-800">
              {drillRows.map((e, i) => (
                <a key={i} href={`${BASE_PATH}${e.href}`} className="flex items-baseline gap-3 py-2 hover:bg-gray-800 px-2 rounded-lg">
                  <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(e.date)}</span>
                  <span className="text-gray-400 text-xs w-20 shrink-0 font-bold">{e.code}</span>
                  <span className="flex-1 truncate text-sm">{e.label}</span>
                  <span className={`tabular-nums font-bold ${e.amount < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{usd0(e.amount)}</span>
                </a>
              ))}
              <div className="flex justify-between pt-3 px-2 font-bold">
                <span>{drillRows.length} linhas</span>
                <span className="tabular-nums">{usd0(drillRows.reduce((s, e) => s + e.amount, 0))}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 max-w-3xl text-sm text-gray-500 space-y-2">
        <p>· Recebimentos de 2025 entraram na conta da GZ28BR (linha própria) — são receita nossa que virou saldo intercompany, acompanhado no GZ-FLOW.</p>
        <p>· Contas nossas pagas pela GZ28BR contam como saída aqui e viram dívida deles no GZ-FLOW.</p>
        <p>· Aportes de capital e empréstimos entram pelo livro LEDGERS (ADM → FINANCIAL) — enquanto não estiverem lançados, a variação líquida não bate com o extrato do banco.</p>
      </div>
    </main>
  )
}
