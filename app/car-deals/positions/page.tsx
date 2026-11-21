'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'
import { DEAL_SELECT, DIRECTIONS, PARTY_LABEL, carDescription, carInternal, dealLabel, dealPositions, flatDeal, obligationDue } from '@/lib/carDeals'

// POSITIONS (CAR DEALS etapa 3, 21/11/2026) — o relatório pedido pelo Márcio: por carro e no total, quanto o Sidney manda
// à Tripa Trading, quanto o Sidney manda ao GZ28, quanto a Tripa Trading manda ao GZ28 e quanto o GZ28 manda à Tripa
// Trading — «tudo com as programações de pagamento e/ou condição de envio do $».
// VISÃO: GZ28 vê as 4 direções; a visão SIDNEY esconde a perna Tripa Trading ↔ GZ28US (o cliente não vê o acerto entre
// a casa e o exportador — e no RedHot ele nem sabe que o carro é do Tripa/Edison).
type View = 'GZ28' | 'SIDNEY' | 'TRIPA'
const HIDDEN: Record<View, string[]> = {
  GZ28: [],
  SIDNEY: ['TRIPA_TRADING>GZ28US', 'GZ28US>TRIPA_TRADING'],
  TRIPA: ['SIDNEY>GZ28US'],
}

export default function CarDealPositionsPage() {
  const [loading, setLoading] = useState(true)
  const [deals, setDeals] = useState<any[]>([])
  const [obligations, setObligations] = useState<any[]>([])
  const [movements, setMovements] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [view, setView] = useState<View>('GZ28')
  const [milestones, setMilestones] = useState<any[]>([])

  useEffect(() => {
    (async () => {
      const [d, ms, o, m, a] = await Promise.all([
        supabase.from('car_deals').select(DEAL_SELECT).neq('status', 'CANCELLED').order('deal_no'),
        supabase.from('deal_milestones').select('*'),
        supabase.from('deal_obligations').select('*'),
        supabase.from('deal_movements').select('*'),
        supabase.from('deal_allocations').select('*'),
      ])
      setMilestones(ms.data || [])
      setDeals((d.data || []).map(flatDeal).sort((a: any, b: any) => String(a.rides?.vin || '~').localeCompare(String(b.rides?.vin || '~')))); setObligations(o.data || []); setMovements(m.data || []); setAllocations(a.data || [])
      setLoading(false)
    })()
  }, [])

  const dirs = DIRECTIONS.filter(d => !HIDDEN[view].includes(d.key))
  const rows = useMemo(() => deals.map(d => ({ deal: d, pos: dealPositions(d.id, obligations, movements, allocations, milestones) })), [deals, obligations, movements, allocations, milestones])
  const totals = dirs.map(dir => Math.round(rows.reduce((s, r) => s + (r.pos.find(p => p.key === dir.key)?.open || 0), 0) * 100) / 100)
  // VIN primeiro; o apelido interno (US.0xx / Joker…) só na visão GZ28
  const carName = (d: any) => [d.rides?.vin ? `VIN ${d.rides.vin}` : 'no VIN', carDescription(d.rides), view === 'GZ28' ? carInternal(d.rides) : ''].filter(Boolean).join(' · ')
  const dealById = new Map(deals.map(d => [d.id, d]))
  // a programação: toda obrigação em aberto das direções visíveis, a vencida/datada primeiro, a condicionada depois
  const schedule = obligations
    .filter(o => !o.cancelled && dealById.has(o.deal_id) && dirs.some(d => d.from === o.from_party && d.to === o.to_party))
    .map(o => ({ ...o, _due: obligationDue(o, milestones) }))
    .sort((a, b) => (a._due.date ? 0 : 1) - (b._due.date ? 0 : 1) || String(a._due.date || '').localeCompare(String(b._due.date || '')))
  const when = (o: any) => o._due.label

  function exportPdf() {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' })
    const now = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(',', '')
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.text('CAR DEALS — POSITIONS', 12, 14)
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text(`Open amounts by car and direction · ${now} (Orlando)`, 12, 19)
    autoTable(doc, {
      startY: 23, styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [20, 20, 20] }, footStyles: { fillColor: [230, 230, 230], textColor: 0, fontStyle: 'bold' },
      head: [['Deal', 'Car', ...dirs.map(d => d.label)]],
      body: rows.map(r => [dealLabel(r.deal.deal_no), carName(r.deal), ...dirs.map(dir => { const p = r.pos.find(x => x.key === dir.key)!; return p.open === 0 ? '—' : `${formatUSD(p.open)}${p.next ? `\n${p.next}` : ''}` })]),
      foot: [['TOTAL', '', ...totals.map(t => t === 0 ? '—' : formatUSD(t))]],
      columnStyles: Object.fromEntries(dirs.map((_, i) => [i + 2, { halign: 'right' as const }])),
    })
    if (schedule.length) {
      autoTable(doc, {
        startY: (doc as any).lastAutoTable.finalY + 8, styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [20, 20, 20] },
        head: [['When', 'Deal', 'Car', 'From → To', 'What for', 'Amount']],
        body: schedule.map(o => { const d = dealById.get(o.deal_id); return [when(o), dealLabel(d.deal_no), carName(d), `${PARTY_LABEL[o.from_party]} → ${PARTY_LABEL[o.to_party]}`, o.label, formatUSD(Number(o.amount_usd) || 0)] }),
        columnStyles: { 5: { halign: 'right' } },
      })
    }
    doc.save(`CAR DEALS - POSITIONS${view === 'GZ28' ? '' : ` (${view})`}.pdf`)
  }

  const cell = (n: number) => n === 0 ? <span className="text-gray-600">—</span> : <span className={n > 0 ? 'text-amber-300 font-bold' : 'text-green-400 font-bold'}>{formatUSD(n)}</span>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-4xl font-bold">CAR DEALS — POSITIONS</h1>
          <p className="text-xl text-gray-400 mt-1">Who still owes whom, by car, with the date or the condition of each payment</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <select value={view} onChange={e => setView(e.target.value as View)} className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg font-bold">
            <option value="GZ28">VIEW: GZ28US (everything)</option>
            <option value="SIDNEY">VIEW: SIDNEY (no Tripa Trading ↔ GZ28US leg)</option>
            <option value="TRIPA">VIEW: TRIPA TRADING</option>
          </select>
          <button onClick={exportPdf} disabled={loading} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-5 py-3 rounded-2xl text-lg font-bold">EXPORT PDF</button>
          <Link href="/car-deals" className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">CAR DEALS</Link>
        </div>
      </div>

      {loading ? <p className="text-2xl text-gray-400">Loading...</p> : (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-sm text-gray-400 border-b border-gray-800">
                  <th className="p-4">DEAL</th><th className="p-4">CAR</th>
                  {dirs.map(d => <th key={d.key} className="p-4 text-right whitespace-nowrap">{d.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.deal.id} className="border-b border-gray-800">
                    <td className="p-4 whitespace-nowrap"><Link href={`/car-deals/${r.deal.id}`} className="text-xl font-bold underline">{dealLabel(r.deal.deal_no)}</Link></td>
                    <td className="p-4">{carName(r.deal)}</td>
                    {dirs.map(dir => { const p = r.pos.find(x => x.key === dir.key)!; return (
                      <td key={dir.key} className="p-4 text-right whitespace-nowrap">
                        {cell(p.open)}
                        {p.owed !== 0 && <div className="text-xs text-gray-500">owed {formatUSD(p.owed)} · paid {formatUSD(p.paid)}</div>}
                        {p.open !== 0 && p.next && <div className="text-xs text-gray-300">{p.next}</div>}
                      </td>
                    ) })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-lg font-bold">
                  <td className="p-4" colSpan={2}>OPEN, TOTAL</td>
                  {totals.map((t, i) => <td key={i} className="p-4 text-right whitespace-nowrap">{cell(t)}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-sm text-gray-500 mt-2">Open = owed minus confirmed movements allocated to that car. A negative number means more was paid in that direction than is recorded as owed.</p>

          <h2 className="text-2xl font-bold mt-8 mb-3">PAYMENT SCHEDULE ({schedule.length})</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="text-sm text-gray-400 border-b border-gray-800"><th className="p-4">WHEN</th><th className="p-4">DEAL</th><th className="p-4">CAR</th><th className="p-4">FROM → TO</th><th className="p-4">WHAT FOR</th><th className="p-4 text-right">AMOUNT</th></tr></thead>
              <tbody>
                {schedule.length === 0 && <tr><td colSpan={6} className="p-6 text-xl text-gray-400">No open obligations recorded.</td></tr>}
                {schedule.map(o => { const d = dealById.get(o.deal_id); return (
                  <tr key={o.id} className="border-b border-gray-800">
                    <td className={`p-4 whitespace-nowrap font-bold ${o._due.due ? 'text-red-400' : ''}`}>{when(o)}</td>
                    <td className="p-4 whitespace-nowrap">{dealLabel(d.deal_no)}</td>
                    <td className="p-4">{carName(d)}</td>
                    <td className="p-4 whitespace-nowrap">{PARTY_LABEL[o.from_party]} → {PARTY_LABEL[o.to_party]}</td>
                    <td className="p-4">{o.label}</td>
                    <td className="p-4 text-right font-bold">{formatUSD(Number(o.amount_usd) || 0)}</td>
                  </tr>
                ) })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  )
}
