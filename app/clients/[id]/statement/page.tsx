'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { BASE_PATH, formatUSD } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { STATEMENT_VIEWS, type StatementView } from '@/lib/statement'

// CONTA-CORRENTE DO CLIENTE (21/11/2026) — as três versões do mesmo livro: a nossa (cada centavo com destino), a do
// cliente (uma linha por pagamento) e a do contador (a do cliente sem as linhas pessoais), com o Excel no modelo do
// contador e o PDF. É só LEITURA do que já existe (lei «um campo pro info»): débito = a invoice; crédito = o movimento
// do livro ou a renda recebida da invoice. Nada se digita aqui e nada é enviado a ninguém.

const d2 = (iso: string | null) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }
const brl = (n: number | null) => n == null ? '' : `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function ClientStatementPage() {
  const clientId = String(useParams().id)
  const [view, setView] = useState<StatementView>('GZ28')
  const [ride, setRide] = useState('')
  const [st, setSt] = useState<any>(null)
  const [busy, setBusy] = useState('')

  useEffect(() => { load() }, [view, ride])

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
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || `Could not generate the ${format.toUpperCase()}: HTTP ${r.status}`); return }
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `Conta Corrente.${format}`
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } finally { setBusy('') }
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
      </div>

      {!st ? <p className="text-2xl text-gray-400">Loading… (reading every invoice of this client)</p> : st.error ? <p className="text-2xl text-red-400">Could not build the current account: {st.error}</p> : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">BALANCE</p><p className={`text-3xl font-bold mt-1 ${st.balance < 0 ? 'text-red-400' : 'text-green-400'}`}>{formatUSD(st.balance)}</p><p className="text-sm text-gray-400 mt-1">negative = the client owes</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">BILLED (debits)</p><p className="text-3xl font-bold mt-1">{formatUSD(st.debit)}</p><p className="text-sm text-gray-400 mt-1">{st.counts.invoices} invoices</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">PAID BY THE CLIENT (credits)</p><p className="text-3xl font-bold mt-1">{formatUSD(st.credit)}</p><p className="text-sm text-gray-400 mt-1">{st.counts.incomes} payments on invoices · {st.counts.movements} movements in the book</p></div>
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5"><p className="text-sm font-bold text-gray-400">STILL TO RECEIVE IN THE APP</p><p className="text-3xl font-bold mt-1">{formatUSD(openInApp)}</p><p className="text-sm text-gray-400 mt-1">of which already paid by the client to a third party: {formatUSD(st.thirdParty || 0)}</p><p className={`text-sm mt-1 ${Math.abs(st.balance + openInApp - (st.thirdParty || 0)) < 0.01 ? 'text-green-400' : 'text-amber-300'}`}>check: balance + open − third party = {formatUSD(Math.round((st.balance + openInApp - (st.thirdParty || 0)) * 100) / 100)} (should be 0)</p></div>
          </div>

          {(st.leaks || []).length > 0 && (
            <div className="bg-red-950 border border-red-700 rounded-3xl p-5 mb-6">
              <p className="text-lg font-bold text-red-300">{st.leaks.length} line{st.leaks.length > 1 ? 's' : ''} of this version mention the exporter (Tripa / Edison / Tamiami / EMC) — marked in red below</p>
              <p className="text-gray-300 mt-1">The Excel and the PDF of this version will not be generated until the text is fixed on the invoice (its SERVICE title).</p>
            </div>
          )}
          {rows.length === 0 ? <p className="text-xl text-gray-400">Nothing in this client&apos;s current account yet.</p> : (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="text-gray-400 border-b border-gray-800"><th className="p-3">CAR</th><th className="p-3">CODE</th><th className="p-3">DATE</th><th className="p-3">ITEM</th><th className="p-3 text-right">DEBIT</th><th className="p-3 text-right">CREDIT</th><th className="p-3 text-right">BALANCE</th><th className="p-3 text-right">R$</th><th className="p-3">OBS</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key} className={`border-b border-gray-800 ${(st.leaks || []).includes(r.key) ? 'bg-red-950' : r.kind === 'CREDIT' ? 'bg-green-950/40' : ''}`}>
                      <td className="p-3 whitespace-nowrap font-bold">{r.car}{r.personal && <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-300">personal</span>}</td>
                      <td className="p-3 whitespace-nowrap">{r.code}</td>
                      <td className="p-3 whitespace-nowrap">{d2(r.date)}</td>
                      <td className="p-3">{r.item}</td>
                      <td className="p-3 text-right whitespace-nowrap">{money(r.debit)}</td>
                      <td className="p-3 text-right whitespace-nowrap">{r.credit != null ? formatUSD(r.credit) : ''}</td>
                      <td className="p-3 text-right whitespace-nowrap font-bold">{money(r.balance)}</td>
                      <td className="p-3 text-right whitespace-nowrap text-gray-300">{brl(r.brl)}</td>
                      <td className="p-3 text-gray-400 max-w-md">{r.obs}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="text-base font-bold"><td className="p-3" colSpan={4}>TOTAIS</td><td className="p-3 text-right">{money(st.debit)}</td><td className="p-3 text-right">{formatUSD(st.credit)}</td><td className="p-3 text-right">{money(st.balance)}</td><td className="p-3 text-right">{brl(st.brl)}</td><td></td></tr></tfoot>
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
