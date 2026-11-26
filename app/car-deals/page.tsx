'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD } from '@/lib/utils'
import { carDescription, carInternal, dealLabel, DEAL_SELECT, flatDeal, POSITION_EXPENSE_COLS, POSITION_INCOME_COLS, loadExporterIncomes, DIRECTIONS, MILESTONES, MILESTONE_LABEL, PARTY_LABEL, dealPositions, movementUnallocated, withPurchaseInvoices, dealInvoiceIds } from '@/lib/carDeals'

// CAR DEALS (21/11/2026): a compra dos carros, fora das invoices de oficina. Uma linha por compra, com as 4 posições
// (quem ainda deve a quem) e o total no rodapé. Invoice de compra ainda sem deal aparece embaixo, com o botão de criar.
export default function CarDealsPage() {
  const [loading, setLoading] = useState(true)
  const [deals, setDeals] = useState<any[]>([])
  const [purchases, setPurchases] = useState<any[]>([])
  const [obligations, setObligations] = useState<any[]>([])
  const [movements, setMovements] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [milestones, setMilestones] = useState<any[]>([])
  const [clients, setClients] = useState<Record<string, string>>({})
  const [fClient, setFClient] = useState('ALL')
  const [fExporter, setFExporter] = useState('ALL')
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [charges, setCharges] = useState<any[]>([])
  const [incomes, setIncomes] = useState<any[]>([])
  const [expenses, setExpenses] = useState<any[]>([])
  const [exporterIncomes, setExporterIncomes] = useState<any[]>([])

  useEffect(() => { load() }, [])

  async function load() {
    const [d, p, o, m, a, ms, c] = await Promise.all([
      supabase.from('car_deals').select(DEAL_SELECT).order('deal_no', { ascending: true }),
      supabase.from('invoices').select('id, invoice_code, service, ride_id, client_id, rides(project_code, project_name, vin)').eq('kind', 'CAR_PURCHASE').order('invoice_code'),
      supabase.from('deal_obligations').select('*'),
      supabase.from('deal_movements').select('*'),
      supabase.from('deal_allocations').select('*'),
      supabase.from('deal_milestones').select('*'),
      supabase.from('clients').select('id, name'),
    ])
    const flat = await withPurchaseInvoices(supabase, (d.data || []).map(flatDeal))
    setDeals(flat); setPurchases(p.data || []); setObligations(o.data || []); setMovements(m.data || [])
    setAllocations(a.data || []); setMilestones(ms.data || [])
    setClients(Object.fromEntries((c.data || []).map((x: any) => [x.id, x.name || ''])))
    // as 4 posições leem os custos dos deals e as rendas/despesas das invoices de compra
    const invIds = flat.flatMap(dealInvoiceIds)
    const [ch, inc, exp] = await Promise.all([
      supabase.from('deal_charges').select('*'),
      invIds.length ? supabase.from('invoice_incomes').select(POSITION_INCOME_COLS).in('invoice_id', invIds) : Promise.resolve({ data: [] as any[] }),
      invIds.length ? supabase.from('invoice_expenses').select(POSITION_EXPENSE_COLS).in('invoice_id', invIds) : Promise.resolve({ data: [] as any[] }),
    ])
    setCharges(ch.data || []); setIncomes(inc.data || []); setExpenses(exp.data || [])
    setExporterIncomes(await loadExporterIncomes(supabase, flat))
    setLoading(false)
  }

  async function createDeal(inv: any) {
    setBusy(inv.id)
    const { data, error } = await supabase.from('car_deals')
      .insert({ purchase_invoice_id: inv.id })
      .select('id').single()
    setBusy(null)
    if (error || !data) { alert(`Could not create the deal: ${error?.message || 'no row returned'}`); return }
    window.location.href = `${BASE_PATH}/car-deals/${data.id}`
  }

  // a invoice de cobrança do mesmo carro já pertence ao deal dele — não é compra sem deal
  const withDeal = new Set(deals.flatMap(dealInvoiceIds))
  const orphanPurchases = purchases.filter(p => !withDeal.has(p.id))
  const exporters = [...new Set(deals.map(d => d.exporter).filter(Boolean))] as string[]
  const clientIds = [...new Set(deals.map(d => d.client_id).filter(Boolean))] as string[]
  // o VIN é a referência principal: a busca casa VIN (inteiro ou os 4 finais), o número da compra e os dados do carro
  const q = search.trim().toLowerCase()
  const shown = deals.filter(d => (fClient === 'ALL' || d.client_id === fClient) && (fExporter === 'ALL' || (fExporter === 'NONE' ? !d.exporter : d.exporter === fExporter))
    && (!q || [d.rides?.vin, d.deal_no, carDescription(d.rides), carInternal(d.rides)].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => String(a.rides?.vin || '~').localeCompare(String(b.rides?.vin || '~')))

  const posByDeal = useMemo(() => Object.fromEntries(deals.map(d => [d.id, dealPositions(d, { charges, obligations, movements, allocations, milestones, incomes, expenses, exporterIncomes })])), [deals, charges, obligations, movements, allocations, milestones, incomes, expenses, exporterIncomes])
  const totals = DIRECTIONS.map((dir, i) => shown.reduce((s, d) => s + (posByDeal[d.id]?.[i]?.open || 0), 0))
  // movimentos propostos que ainda esperam alocação/confirmação humana (o robô nunca aloca sozinho)
  const pending = movements.filter(m => m.status === 'PROPOSED')
  const lastMilestone = (dealId: string) => {
    const done = milestones.filter(m => m.deal_id === dealId && m.done_at)
    const last = [...MILESTONES].reverse().find(k => done.some(m => m.kind === k.kind))
    return last ? MILESTONE_LABEL[last.kind] : null
  }
  const cell = (n: number) => n === 0 ? <span className="text-gray-600">—</span> : <span className={n > 0 ? 'text-amber-300 font-bold' : 'text-green-400 font-bold'}>{formatUSD(n)}</span>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-4xl font-bold">CAR DEALS</h1>
          <p className="text-xl text-gray-400 mt-1">Car purchases, apart from the shop invoices ({deals.length})</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search VIN, Compra, car…" className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg w-72" />
          <select value={fClient} onChange={e => setFClient(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg font-bold">
            <option value="ALL">ALL CLIENTS</option>
            {clientIds.map(id => <option key={id} value={id}>{clients[id] || id}</option>)}
          </select>
          <select value={fExporter} onChange={e => setFExporter(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg font-bold">
            <option value="ALL">ALL EXPORTERS</option>
            {exporters.map(x => <option key={x} value={x}>{PARTY_LABEL[x] || x}</option>)}
            <option value="NONE">NO EXPORTER</option>
          </select>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="bg-amber-950 border border-amber-700 rounded-3xl p-5 mb-6">
          <p className="text-lg font-bold text-amber-300">{pending.length} proposed movement{pending.length > 1 ? 's' : ''} waiting for a person to allocate and confirm</p>
          <p className="text-gray-300 mt-1">
            {pending.slice(0, 6).map(m => `${formatUSD(Number(m.amount_usd) || 0)} (${movementUnallocated(m, allocations) > 0 ? 'not fully allocated' : 'allocated, not confirmed'})`).join(' · ')}
            {pending.length > 6 ? ' · …' : ''} — open a deal, tab MOVEMENTS.
          </p>
        </div>
      )}

      {loading ? <p className="text-2xl text-gray-400">Loading...</p> : (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-sm text-gray-400 border-b border-gray-800">
                  <th className="p-4">VIN</th><th className="p-4">COMPRA</th><th className="p-4">CAR</th><th className="p-4">CLIENT</th><th className="p-4">EXPORTER</th><th className="p-4">STAGE</th>
                  {DIRECTIONS.map(d => <th key={d.key} className="p-4 text-right whitespace-nowrap">{d.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={10} className="p-6 text-xl text-gray-400">No deals yet.</td></tr>}
                {shown.map(d => (
                  <tr key={d.id} className="border-b border-gray-800 hover:bg-gray-800">
                    <td className="p-4 whitespace-nowrap">
                      <Link href={`/car-deals/${d.id}`} className="text-lg underline font-mono">{d.rides?.vin ? <>{String(d.rides.vin).slice(0, -4)}<span className="text-2xl font-bold text-white">{String(d.rides.vin).slice(-4)}</span></> : 'no VIN'}</Link>
                    </td>
                    <td className="p-4 whitespace-nowrap">
                      <Link href={`/car-deals/${d.id}`} className="text-xl font-bold underline">{dealLabel(d.deal_no)}</Link>
                      {d.status !== 'OPEN' && <span className="ml-2 px-2 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-300">{d.status}</span>}
                      <div className="text-sm text-gray-500">{d.invoices?.invoice_code || 'no purchase invoice'}</div>
                    </td>
                    <td className="p-4">
                      <div className="font-bold">{carDescription(d.rides) || '—'}</div>
                      <div className="text-sm text-gray-500">{carInternal(d.rides)}</div>
                    </td>
                    <td className="p-4">{clients[d.client_id] || '—'}</td>
                    <td className="p-4">{d.exporter ? (PARTY_LABEL[d.exporter] || d.exporter) : <span className="text-gray-600">—</span>}</td>
                    <td className="p-4">{lastMilestone(d.id) || <span className="text-gray-600">—</span>}</td>
                    {(posByDeal[d.id] || []).map((p: any) => (
                      <td key={p.key} className="p-4 text-right whitespace-nowrap">
                        {cell(p.open)}
                        {p.open !== 0 && p.next && <div className="text-xs text-gray-400">{p.next}</div>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {shown.length > 0 && (
                <tfoot>
                  <tr className="text-lg font-bold">
                    <td className="p-4" colSpan={6}>OPEN, TOTAL ({shown.length})</td>
                    {totals.map((t, i) => <td key={i} className="p-4 text-right whitespace-nowrap">{cell(Math.round(t * 100) / 100)}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="text-sm text-gray-500 mt-2">Client → Tripa Trading = their fees plus what they passed on to us, minus what he sent them (when they are the seller: all cost lines minus what he sent them). Client → GZ28US = open payments on the purchase invoice. Tripa Trading → GZ28US = open payments he already paid to them. GZ28US → Tripa Trading = our unpaid expenses to them on the purchase invoice. Proposed movements do not count.</p>

          {orphanPurchases.length > 0 && (
            <div className="mt-8">
              <h2 className="text-2xl font-bold mb-3">PURCHASE INVOICES WITHOUT A DEAL ({orphanPurchases.length})</h2>
              <div className="space-y-3">
                {orphanPurchases.map(p => (
                  <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-center justify-between gap-4 flex-wrap">
                    <div>
                      <div className="text-xl font-bold">{p.invoice_code} <span className="text-gray-400 font-normal">— {[p.rides?.project_code, p.rides?.project_name].filter(Boolean).join(' — ')}</span></div>
                      <div className="text-gray-400">{p.service || ''}{p.rides?.vin ? ` · VIN ${String(p.rides.vin).slice(-4)}` : ''} · {clients[p.client_id] || ''}</div>
                    </div>
                    <div className="flex gap-3">
                      {p.ride_id && <Link href={`/rides/${p.ride_id}/invoices/${p.id}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">OPEN INVOICE</Link>}
                      <button disabled={busy === p.id} onClick={() => createDeal(p)} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold">{busy === p.id ? 'CREATING…' : 'CREATE DEAL'}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  )
}
