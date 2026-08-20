'use client'

// LEDGERS — os três livros da Fase 2, lançados na mão até o Plaid assumir.
//   CAPITAL      aporte e retirada de sócio (G2)
//   EMPRÉSTIMOS  contratos + eventos: recebeu / amortizou / pagou juros (G3)
//   SALDOS       fim de mês por conta — é o "caixa" do Balanço (G5)
// Enquanto MIGRATION_financial_ledgers.sql não rodar no Supabase, a tela
// mostra o aviso e mais nada — sem migration não há onde escrever.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import FinBadge from '@/components/FinBadge'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import DatePicker from '@/components/DatePicker'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const n = (v: unknown) => parseFloat(String(v)) || 0

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function LedgersPage() {
  const [ready, setReady] = useState<boolean | null>(null)
  const [capital, setCapital] = useState<any[]>([])
  const [financing, setFinancing] = useState<any[]>([])
  const [finEvents, setFinEvents] = useState<any[]>([])
  const [balances, setBalances] = useState<any[]>([])
  const [saving, setSaving] = useState(false)

  // formulários
  const [cap, setCap] = useState({ event_date: '', kind: 'CONTRIBUTION', member: '', amount: '', method: '', description: '' })
  const [loan, setLoan] = useState({ lender: '', start_date: '', rate_apr: '', description: '' })
  const [evt, setEvt] = useState({ financing_id: '', event_date: '', kind: 'DISBURSEMENT', amount: '', description: '' })
  const [bal, setBal] = useState({ balance_date: '', account: '', balance: '', notes: '' })

  useEffect(() => { load() }, [])

  async function load() {
    const [c, f, e, b] = await Promise.all([
      supabase.from('capital_events').select('*').order('event_date', { ascending: false }),
      supabase.from('financing').select('*').order('created_at'),
      supabase.from('financing_events').select('*').order('event_date', { ascending: false }),
      supabase.from('cash_balances').select('*').order('balance_date', { ascending: false }),
    ])
    if (c.error || f.error || e.error || b.error) { setReady(false); return }
    setCapital(c.data || []); setFinancing(f.data || []); setFinEvents(e.data || []); setBalances(b.data || [])
    setReady(true)
  }

  async function save(table: string, row: any, reset: () => void) {
    setSaving(true)
    const { error } = await supabase.from(table).insert(row)
    setSaving(false)
    if (error) { alert(error.message); return }
    reset(); load()
  }
  async function del(table: string, id: string) {
    if (!confirm('Apagar este lançamento?')) return
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) { alert(error.message); return }
    load()
  }

  const loanBalance = (fid: string) => finEvents.filter(e => e.financing_id === fid)
    .reduce((s, e) => s + (e.kind === 'DISBURSEMENT' ? n(e.amount) : e.kind === 'PAYMENT' ? -n(e.amount) : 0), 0)

  const inputCls = 'bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 w-full'
  const btnCls = 'px-4 py-2 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-600 border border-emerald-500 disabled:opacity-50'
  const secCls = 'bg-gray-900 border border-gray-700 rounded-2xl p-5'

  if (ready === null) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">LEDGERS</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL</a>
      </div>
      <p className="text-gray-400 mb-6 max-w-3xl">Capital, empréstimos e saldos de caixa — o lado do funding que fecha o Balanço. Lançamento manual até a integração bancária assumir.</p>

      {!ready ? (
        <div className="bg-amber-950/60 border border-amber-800 rounded-2xl p-6 max-w-2xl text-amber-200">
          <p className="text-xl font-bold mb-2">MIGRATION PENDENTE</p>
          <p className="mb-2">As tabelas dos livros ainda não existem no Supabase. Rode <code className="bg-black/40 px-2 py-0.5 rounded">MIGRATION_financial_ledgers.sql</code> (raiz do projeto) no SQL Editor do projeto <b>fvgpkbpqacnqxtrjsmpi</b> e recarregue esta página.</p>
          <p className="text-sm text-amber-300/70">Idempotente e com rollback no rodapé do arquivo. Cria: capital_events, financing, financing_events, cash_balances — todas com RLS no padrão do app.</p>
        </div>
      ) : (
        <div className="space-y-8 max-w-4xl">

          {/* ── CAPITAL ─────────────────────────────────────────────── */}
          <div className={secCls}>
            <h2 className="text-2xl font-bold mb-1">CAPITAL DOS SÓCIOS</h2>
            <p className="text-sm text-gray-500 mb-4">Aporte entra no caixa e no patrimônio; retirada formal sai dos dois. (Gasto pessoal miúdo continua em STAFF → PERSONAL.)</p>
            <div className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-4">
              <div className="col-span-2"><DatePicker compact label="DATA" value={cap.event_date} onChange={v => setCap({ ...cap, event_date: v })} /></div>
              <div><label className="block mb-2 font-bold text-sm">TIPO</label>
                <select value={cap.kind} onChange={e => setCap({ ...cap, kind: e.target.value })} className={inputCls}>
                  <option value="CONTRIBUTION">APORTE</option><option value="DRAW">RETIRADA</option>
                </select></div>
              <div><label className="block mb-2 font-bold text-sm">SÓCIO</label><input value={cap.member} onChange={e => setCap({ ...cap, member: e.target.value })} className={inputCls} placeholder="Márcio" /></div>
              <div><label className="block mb-2 font-bold text-sm">VALOR $</label><input type="number" value={cap.amount} onChange={e => setCap({ ...cap, amount: e.target.value })} className={inputCls} /></div>
              <div><label className="block mb-2 font-bold text-sm">MÉTODO</label><input value={cap.method} onChange={e => setCap({ ...cap, method: e.target.value })} className={inputCls} placeholder="WIRE / ZELLE / CASH" /></div>
              <div className="flex items-end"><button disabled={saving || !cap.event_date || !cap.member || !n(cap.amount)} className={btnCls}
                onClick={() => save('capital_events', { ...cap, amount: n(cap.amount), method: cap.method || null, description: cap.description || null }, () => setCap({ event_date: '', kind: 'CONTRIBUTION', member: '', amount: '', method: '', description: '' }))}>LANÇAR</button></div>
            </div>
            {capital.length > 0 && (
              <div className="divide-y divide-gray-800">
                {capital.map(c => (
                  <div key={c.id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="text-gray-500 w-20 shrink-0 text-xs">{formatShortDate(c.event_date)}</span>
                    <span className={`font-bold w-24 shrink-0 ${c.kind === 'CONTRIBUTION' ? 'text-emerald-400' : 'text-red-400'}`}>{c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'}</span>
                    <span className="flex-1 truncate">{c.member}{c.description ? ` · ${c.description}` : ''}{c.method ? ` · ${c.method}` : ''}</span>
                    <span className="tabular-nums font-bold">{usd(n(c.amount))}</span>
                    <button onClick={() => del('capital_events', c.id)} className="text-gray-600 hover:text-red-400 font-bold px-2">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── EMPRÉSTIMOS ─────────────────────────────────────────── */}
          <div className={secCls}>
            <h2 className="text-2xl font-bold mb-1">EMPRÉSTIMOS & FINANCIAMENTOS</h2>
            <p className="text-sm text-gray-500 mb-4">RECEBEU sobe caixa e dívida · AMORTIZOU desce os dois · JUROS sai do caixa e vira despesa na DRE.</p>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <div className="md:col-span-2"><label className="block mb-2 font-bold text-sm">CREDOR (novo contrato)</label><input value={loan.lender} onChange={e => setLoan({ ...loan, lender: e.target.value })} className={inputCls} placeholder="K&G FINANCING, INC." /></div>
              <div className="col-span-2"><DatePicker compact label="INÍCIO" value={loan.start_date} onChange={v => setLoan({ ...loan, start_date: v })} /></div>
              <div><label className="block mb-2 font-bold text-sm">TAXA % a.a.</label><input type="number" value={loan.rate_apr} onChange={e => setLoan({ ...loan, rate_apr: e.target.value })} className={inputCls} /></div>
              <div className="flex items-end"><button disabled={saving || !loan.lender} className={btnCls}
                onClick={() => save('financing', { lender: loan.lender, start_date: loan.start_date || null, rate_apr: loan.rate_apr ? n(loan.rate_apr) : null, description: loan.description || null }, () => setLoan({ lender: '', start_date: '', rate_apr: '', description: '' }))}>CRIAR</button></div>
            </div>

            {financing.map(f => (
              <div key={f.id} className="border border-gray-800 rounded-xl p-4 mb-3">
                <div className="flex items-baseline gap-3 flex-wrap mb-3">
                  <span className="font-bold text-lg">{f.lender}</span>
                  {f.rate_apr != null && <span className="text-xs text-gray-500">{f.rate_apr}% a.a.</span>}
                  <span className="ml-auto tabular-nums font-bold text-amber-300">saldo devedor {usd(loanBalance(f.id))}</span>
                  <button onClick={() => del('financing', f.id)} className="text-gray-600 hover:text-red-400 font-bold px-2" title="Apaga o contrato e os eventos">✕</button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
                  <div className="col-span-2"><DatePicker compact label="DATA" value={evt.financing_id === f.id ? evt.event_date : ''} onChange={v => setEvt({ ...evt, financing_id: f.id, event_date: v })} /></div>
                  <div><label className="block mb-2 font-bold text-sm">EVENTO</label>
                    <select value={evt.financing_id === f.id ? evt.kind : 'DISBURSEMENT'} onChange={e => setEvt({ ...evt, financing_id: f.id, kind: e.target.value })} className={inputCls}>
                      <option value="DISBURSEMENT">RECEBEU</option><option value="PAYMENT">AMORTIZOU</option><option value="INTEREST">JUROS</option>
                    </select></div>
                  <div><label className="block mb-2 font-bold text-sm">VALOR $</label><input type="number" value={evt.financing_id === f.id ? evt.amount : ''} onChange={e => setEvt({ ...evt, financing_id: f.id, amount: e.target.value })} className={inputCls} /></div>
                  <div><label className="block mb-2 font-bold text-sm">DESCRIÇÃO</label><input value={evt.financing_id === f.id ? evt.description : ''} onChange={e => setEvt({ ...evt, financing_id: f.id, description: e.target.value })} className={inputCls} /></div>
                  <div className="flex items-end"><button disabled={saving || evt.financing_id !== f.id || !evt.event_date || !n(evt.amount)} className={btnCls}
                    onClick={() => save('financing_events', { financing_id: f.id, event_date: evt.event_date, kind: evt.kind, amount: n(evt.amount), description: evt.description || null }, () => setEvt({ financing_id: '', event_date: '', kind: 'DISBURSEMENT', amount: '', description: '' }))}>LANÇAR</button></div>
                </div>
                <div className="divide-y divide-gray-800">
                  {finEvents.filter(e => e.financing_id === f.id).map(e => (
                    <div key={e.id} className="flex items-baseline gap-3 py-1.5 text-sm">
                      <span className="text-gray-500 w-20 shrink-0 text-xs">{formatShortDate(e.event_date)}</span>
                      <span className={`font-bold w-24 shrink-0 ${e.kind === 'DISBURSEMENT' ? 'text-emerald-400' : e.kind === 'PAYMENT' ? 'text-sky-400' : 'text-red-400'}`}>{e.kind === 'DISBURSEMENT' ? 'RECEBEU' : e.kind === 'PAYMENT' ? 'AMORTIZOU' : 'JUROS'}</span>
                      <span className="flex-1 truncate text-gray-400">{e.description || ''}</span>
                      <span className="tabular-nums font-bold">{usd(n(e.amount))}</span>
                      <button onClick={() => del('financing_events', e.id)} className="text-gray-600 hover:text-red-400 font-bold px-2">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ── SALDOS DE CAIXA ─────────────────────────────────────── */}
          <div className={secCls}>
            <h2 className="text-2xl font-bold mb-1">SALDOS DE CAIXA</h2>
            <p className="text-sm text-gray-500 mb-4">Fim de mês, por conta, direto do extrato. O Balanço usa o último saldo de cada conta; a conciliação compara a variação real com a calculada pelo DFC.</p>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <div className="col-span-2"><DatePicker compact label="DATA DO SALDO" value={bal.balance_date} onChange={v => setBal({ ...bal, balance_date: v })} /></div>
              <div><label className="block mb-2 font-bold text-sm">CONTA</label><input value={bal.account} onChange={e => setBal({ ...bal, account: e.target.value })} className={inputCls} placeholder="Regions •9336" /></div>
              <div><label className="block mb-2 font-bold text-sm">SALDO $</label><input type="number" value={bal.balance} onChange={e => setBal({ ...bal, balance: e.target.value })} className={inputCls} /></div>
              <div><label className="block mb-2 font-bold text-sm">NOTAS</label><input value={bal.notes} onChange={e => setBal({ ...bal, notes: e.target.value })} className={inputCls} /></div>
              <div className="flex items-end"><button disabled={saving || !bal.balance_date || !bal.account || bal.balance === ''} className={btnCls}
                onClick={() => save('cash_balances', { balance_date: bal.balance_date, account: bal.account, balance: n(bal.balance), notes: bal.notes || null }, () => setBal({ balance_date: '', account: '', balance: '', notes: '' }))}>LANÇAR</button></div>
            </div>
            {balances.length > 0 && (
              <div className="divide-y divide-gray-800">
                {balances.map(b => (
                  <div key={b.id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="text-gray-500 w-20 shrink-0 text-xs">{formatShortDate(b.balance_date)}</span>
                    <span className="font-bold flex-1 truncate">{b.account}{b.notes ? ` · ${b.notes}` : ''}{b.source === 'PLAID' ? ' · PLAID' : ''}</span>
                    <span className="tabular-nums font-bold">{usd(n(b.balance))}</span>
                    <button onClick={() => del('cash_balances', b.id)} className="text-gray-600 hover:text-red-400 font-bold px-2">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
