'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { STATEMENT_VIEWS, type StatementView } from '@/lib/statement'

// CONTA-CORRENTE DO CLIENTE (21/11/2026) — as três versões do mesmo livro: a nossa (cada centavo com destino), a do
// cliente (uma linha por pagamento) e a do contador (a do cliente sem as linhas pessoais), com o Excel no modelo do
// contador e o PDF. Nada aqui é enviado a ninguém: os arquivos descem para este computador.
// Os CRÉDITOS vêm dos movimentos confirmados do livro (CARS → CAR DEALS → deal → MOVEMENTS); os DÉBITOS, de statement_charges.

const inp = 'bg-black border border-gray-700 rounded-xl px-3 py-2 text-base'
const btn = 'px-4 py-2 rounded-xl font-bold'
const d2 = (iso: string | null) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }
const brl = (n: number | null) => n == null ? '' : `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function ClientStatementPage() {
  const clientId = String(useParams().id)
  const [view, setView] = useState<StatementView>('GZ28')
  const [ride, setRide] = useState('')
  const [st, setSt] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [rides, setRides] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [nc, setNc] = useState<any>({ charged_on: today(), ride_id: '', invoice_id: '', car_name: '', code: '', label: '', amount: '', nf_number: '', note: '', personal: false })

  useEffect(() => { load() }, [view, ride])
  useEffect(() => {
    (async () => {
      const [r, i] = await Promise.all([
        supabase.from('rides').select('id, project_code, project_name, model, color, statement_name').eq('client_id', clientId).order('project_code'),
        supabase.from('invoices').select('id, invoice_code, service, ride_id').eq('client_id', clientId).eq('is_quote', false).order('invoice_code'),
      ])
      setRides(r.data || []); setInvoices(i.data || [])
    })()
  }, [])

  async function load() {
    setSt(null)
    const r = await fetch(`${BASE_PATH}/api/statement?client=${clientId}&view=${view}${ride ? `&ride=${ride}` : ''}`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    setSt(r.ok ? j : { error: j.error || `HTTP ${r.status}` })
  }
  async function download(format: 'xlsx' | 'pdf') {
    setBusy(format)
    try {
      const r = await fetch(`${BASE_PATH}/api/statement?client=${clientId}&view=${view}${ride ? `&ride=${ride}` : ''}&format=${format}`, { headers: await sessionHeaders() })
      if (!r.ok) { alert(`Could not generate the ${format.toUpperCase()}: HTTP ${r.status}`); return }
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `Conta Corrente.${format}`
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } finally { setBusy('') }
  }
  async function addCharge() {
    const amount = parseFloat(String(nc.amount).replace(/,/g, ''))
    if (!nc.charged_on || !nc.label.trim() || !Number.isFinite(amount) || amount <= 0) { alert('A debit needs a date, a description and an amount above zero.'); return }
    const { error } = await supabase.from('statement_charges').insert({
      client_id: clientId, charged_on: nc.charged_on, ride_id: nc.ride_id || null, invoice_id: nc.invoice_id || null, car_name: nc.car_name.trim() || null,
      code: nc.code.trim() || null, label: nc.label.trim(), amount_usd: amount, nf_number: nc.nf_number.trim() || null, note: nc.note.trim() || null, personal: !!nc.personal,
    })
    if (error) { alert(error.message); return }
    setNc({ ...nc, label: '', amount: '', nf_number: '', note: '', personal: false }); load()
  }
  async function removeCharge(key: string) {
    if (!key.startsWith('c:') || !confirm('Remove this debit line from the current account?')) return
    const { error } = await supabase.from('statement_charges').delete().eq('id', key.slice(2))
    if (error) alert(error.message); else load()
  }

  const rows: any[] = st?.rows || []
  const scheduled = (st?.schedule || []).filter((s: any) => s.date), unscheduled = (st?.schedule || []).filter((s: any) => !s.date)
  const sum = (a: any[]) => Math.round(a.reduce((s, x) => s + (Number(x.amount) || 0), 0) * 100) / 100
  const openInApp = sum(st?.schedule || [])
  const money = (n: number | null) => n == null ? '' : <span className={n < 0 ? 'text-red-400' : ''}>{formatUSD(n)}</span>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-4xl font-bold">CONTA-CORRENTE{st?.client?.name ? ` — ${st.client.name}` : ''}</h1>
          <p className="text-xl text-gray-400 mt-1">One book, three readings: ours, the client&apos;s and the accountant&apos;s</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => download('xlsx')} disabled={!rows.length || !!busy} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-5 py-3 rounded-2xl text-lg font-bold">{busy === 'xlsx' ? 'GENERATING…' : 'DOWNLOAD EXCEL'}</button>
          <button onClick={() => download('pdf')} disabled={!rows.length || !!busy} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-5 py-3 rounded-2xl text-lg font-bold">{busy === 'pdf' ? 'GENERATING…' : 'DOWNLOAD PDF'}</button>
          <Link href={`/clients/${clientId}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">BACK</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap items-center">
        {STATEMENT_VIEWS.map(v => (
          <button key={v.key} onClick={() => setView(v.key)} className={`px-5 py-3 rounded-2xl text-lg font-bold border ${view === v.key ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-700'}`}>{v.label}</button>
        ))}
        <select value={ride} onChange={e => setRide(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg font-bold ml-2">
          <option value="">ALL CARS</option>
          {(st?.cars || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={() => setShowAdd(!showAdd)} className="bg-gray-900 border border-gray-700 hover:bg-gray-700 px-5 py-3 rounded-2xl text-lg font-bold">{showAdd ? 'CLOSE' : 'ADD A DEBIT'}</button>
      </div>

      {showAdd && (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 mb-6">
          <h2 className="text-2xl font-bold mb-1">NEW DEBIT LINE</h2>
          <p className="text-gray-400 mb-4">What was billed to the client. Payments are not entered here: they are movements of the book (CARS → CAR DEALS → deal → MOVEMENTS).</p>
          <div className="flex gap-3 flex-wrap items-end">
            <label className="flex flex-col text-xs text-gray-400">DATE<input type="date" className={inp} value={nc.charged_on} onChange={e => setNc({ ...nc, charged_on: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400">CAR<select className={inp} value={nc.ride_id} onChange={e => setNc({ ...nc, ride_id: e.target.value })}><option value="">—</option>{rides.map(r => <option key={r.id} value={r.id}>{r.statement_name || [r.model, r.color].filter(Boolean).join(' ')} ({r.project_code})</option>)}</select></label>
            <label className="flex flex-col text-xs text-gray-400">INVOICE<select className={inp} value={nc.invoice_id} onChange={e => setNc({ ...nc, invoice_id: e.target.value })}><option value="">—</option>{invoices.filter(i => !nc.ride_id || i.ride_id === nc.ride_id).map(i => <option key={i.id} value={i.id}>{i.invoice_code}</option>)}</select></label>
            <label className="flex flex-col text-xs text-gray-400">CAR NAME (if not in the list)<input className={`${inp} w-44`} value={nc.car_name} onChange={e => setNc({ ...nc, car_name: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400">CODE<input className={`${inp} w-28`} placeholder="Motor 20" value={nc.code} onChange={e => setNc({ ...nc, code: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400 flex-1 min-w-52">ITEM<input className={inp} placeholder="Preparação" value={nc.label} onChange={e => setNc({ ...nc, label: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400">US$<input className={`${inp} w-32`} value={nc.amount} onChange={e => setNc({ ...nc, amount: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400"># NF<input className={`${inp} w-24`} value={nc.nf_number} onChange={e => setNc({ ...nc, nf_number: e.target.value })} /></label>
            <label className="flex flex-col text-xs text-gray-400 flex-1 min-w-52">OBS (the client reads it)<input className={inp} value={nc.note} onChange={e => setNc({ ...nc, note: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-gray-300 pb-2"><input type="checkbox" checked={nc.personal} onChange={e => setNc({ ...nc, personal: e.target.checked })} /> personal (hidden from the accountant)</label>
            <button onClick={addCharge} className={`${btn} bg-green-700 hover:bg-green-600`}>ADD</button>
          </div>
        </div>
      )}

      {!st ? <p className="text-2xl text-gray-400">Loading...</p> : st.error ? <p className="text-2xl text-red-400">Could not build the current account: {st.error}</p> : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">BALANCE</p><p className={`text-3xl font-bold mt-1 ${st.balance < 0 ? 'text-red-400' : 'text-green-400'}`}>{formatUSD(st.balance)}</p><p className="text-sm text-gray-400 mt-1">negative = the client owes</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">BILLED (debits)</p><p className="text-3xl font-bold mt-1">{formatUSD(st.debit)}</p><p className="text-sm text-gray-400 mt-1">{st.counts.charges} lines in the book</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">PAID BY THE CLIENT (credits)</p><p className="text-3xl font-bold mt-1">{formatUSD(st.credit)}</p><p className="text-sm text-gray-400 mt-1">{st.counts.movements} movements · {st.counts.allocations} allocations</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">STILL TO RECEIVE IN THE APP</p><p className="text-3xl font-bold mt-1">{formatUSD(openInApp)}</p><p className="text-sm text-gray-400 mt-1">gap to the balance: {formatUSD(Math.round((openInApp + st.balance) * 100) / 100)} (paid by the client, not yet received by us)</p></div>
          </div>

          {rows.length === 0 ? <p className="text-xl text-gray-400">Nothing in this client&apos;s current account yet.</p> : (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="text-gray-400 border-b border-gray-800"><th className="p-3">CAR</th><th className="p-3">CODE</th><th className="p-3">DATE</th><th className="p-3">ITEM</th><th className="p-3 text-right">DEBIT</th><th className="p-3 text-right">CREDIT</th><th className="p-3 text-right">BALANCE</th><th className="p-3"># NF</th><th className="p-3 text-right">R$</th><th className="p-3">OBS</th><th className="p-3"></th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key} className={`border-b border-gray-800 ${r.kind === 'CREDIT' ? 'bg-green-950/40' : ''}`}>
                      <td className="p-3 whitespace-nowrap font-bold">{r.car}{r.personal && <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-300">personal</span>}</td>
                      <td className="p-3 whitespace-nowrap">{r.code}</td>
                      <td className="p-3 whitespace-nowrap">{d2(r.date)}</td>
                      <td className="p-3">{r.item}</td>
                      <td className="p-3 text-right whitespace-nowrap">{money(r.debit)}</td>
                      <td className="p-3 text-right whitespace-nowrap">{r.credit != null ? formatUSD(r.credit) : ''}</td>
                      <td className="p-3 text-right whitespace-nowrap font-bold">{money(r.balance)}</td>
                      <td className="p-3 whitespace-nowrap">{r.nf}</td>
                      <td className="p-3 text-right whitespace-nowrap text-gray-300">{brl(r.brl)}</td>
                      <td className="p-3 text-gray-400 max-w-md">{r.obs}</td>
                      <td className="p-3">{r.key.startsWith('c:') && <button onClick={() => removeCharge(r.key)} className="text-gray-600 hover:text-red-400 font-bold">×</button>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="text-base font-bold"><td className="p-3" colSpan={4}>TOTAIS</td><td className="p-3 text-right">{money(st.debit)}</td><td className="p-3 text-right">{formatUSD(st.credit)}</td><td className="p-3 text-right">{money(st.balance)}</td><td></td><td className="p-3 text-right">{brl(st.brl)}</td><td colSpan={2}></td></tr></tfoot>
              </table>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
            {[{ title: 'NEXT SCHEDULED PAYMENTS', list: scheduled }, { title: 'OPEN WITH NO DATE (current account)', list: unscheduled }].map(b => (
              <div key={b.title} className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
                <h2 className="text-xl font-bold mb-3">{b.title} — {formatUSD(sum(b.list))}</h2>
                {b.list.length === 0 && <p className="text-gray-500">None.</p>}
                {b.list.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-4 border-b border-gray-800 py-2">
                    <span className="w-28 text-gray-300">{d2(s.date) || '—'}</span>
                    <span className="flex-1">{s.what}</span>
                    <span className="font-bold">{formatUSD(Number(s.amount) || 0)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  )
}
