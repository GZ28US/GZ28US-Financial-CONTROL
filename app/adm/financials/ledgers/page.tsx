'use client'

// LEDGERS — os três livros da Fase 2, lançados na mão até o Plaid assumir.
//   CAPITAL      aporte e retirada de sócio (G2)
//   EMPRÉSTIMOS  contratos + eventos: recebeu / amortizou / pagou juros (G3)
//   SALDOS       fim de mês por conta — é o "caixa" do Balanço (G5)
// Layout no idioma do app (padrão costs/fixed/new): formulário empilhado com
// input grande, DatePicker inteiro, valor com prefixo $, botão verde; listas
// em card rounded-3xl. Enquanto MIGRATION_financial_ledgers.sql não rodar,
// a tela mostra o aviso e mais nada.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import FinBadge from '@/components/FinBadge'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import DatePicker from '@/components/DatePicker'
import { PAYMENT_METHODS } from '@/components/PaymentFields'

// Os 3 sócios da GZ28US (João, 26/ago): vocabulário fechado > texto livre.
const PARTNERS = ['Dema', 'Beto', 'Heraldo'] as const

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US')
const n = (v: unknown) => parseFloat(String(v)) || 0
function isNumeric(v: string) { return v === '' || /^-?\d*\.?\d*$/.test(v) }

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
const saveBtn = 'w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-4 rounded-2xl text-xl font-bold'

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block mb-2 text-lg font-bold">{label}</label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder={placeholder} />
    </div>
  )
}

function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block mb-2 text-lg font-bold">{label}</label>
      <div className="relative">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
        <input type="text" inputMode="decimal" value={value} onChange={(e) => { if (isNumeric(e.target.value)) onChange(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
      </div>
    </div>
  )
}

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

  if (ready === null) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading…</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">LEDGERS</h1>
        <FinBadge />
        <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">← FINANCIAL HUB</a>
      </div>
      <p className="text-gray-400 mb-8 max-w-3xl">Capital, empréstimos e saldos de caixa — o lado do funding que fecha o Balanço. Lançamento manual até a integração bancária assumir.</p>

      {!ready ? (
        <div className="bg-amber-950/60 border border-amber-800 rounded-3xl p-6 max-w-2xl text-amber-200">
          <p className="text-xl font-bold mb-2">MIGRATION PENDENTE</p>
          <p className="mb-2">As tabelas dos livros ainda não existem no Supabase. Rode <code className="bg-black/40 px-2 py-0.5 rounded">MIGRATION_financial_ledgers.sql</code> (raiz do projeto) no SQL Editor do projeto <b>fvgpkbpqacnqxtrjsmpi</b> e recarregue esta página.</p>
          <p className="text-sm text-amber-300/70">Idempotente e com rollback no rodapé do arquivo. Cria: capital_events, financing, financing_events, cash_balances — todas com RLS no padrão do app.</p>
        </div>
      ) : (
        <div className="max-w-2xl">

          {/* ── CAPITAL DOS SÓCIOS ──────────────────────────────────── */}
          <h2 className="text-2xl font-bold mb-1">CAPITAL DOS SÓCIOS</h2>
          <p className="text-gray-400 mb-5">Aporte entra no caixa e no patrimônio; retirada formal sai dos dois. Gasto pessoal miúdo continua em STAFF → PERSONAL.</p>
          <div className="grid grid-cols-1 gap-5 mb-5">
            <DatePicker label="DATE" value={cap.event_date} onChange={v => setCap({ ...cap, event_date: v })} />
            <div>
              <label className="block mb-2 text-lg font-bold">TYPE</label>
              <select value={cap.kind} onChange={e => setCap({ ...cap, kind: e.target.value })} className={inputClass}>
                <option value="CONTRIBUTION">APORTE — sócio colocou dinheiro</option>
                <option value="DRAW">RETIRADA — sócio tirou dinheiro</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block mb-2 text-lg font-bold">PARTNER</label>
                <select value={cap.member} onChange={e => setCap({ ...cap, member: e.target.value })} className={inputClass + (!cap.member ? ' border-amber-500 text-amber-300' : '')}>
                  {!cap.member && <option value="">— qual sócio? —</option>}
                  {PARTNERS.map(p2 => <option key={p2} value={p2}>{p2}</option>)}
                  {cap.member && !(PARTNERS as readonly string[]).includes(cap.member) && <option value={cap.member}>{cap.member}</option>}
                </select>
              </div>
              <MoneyField label="AMOUNT" value={cap.amount} onChange={v => setCap({ ...cap, amount: v })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block mb-2 text-lg font-bold">METHOD</label>
                <select value={cap.method} onChange={e => setCap({ ...cap, method: e.target.value })} className={inputClass}>
                  <option value="">— como veio/saiu? —</option>
                  {PAYMENT_METHODS.map(m2 => <option key={m2} value={m2}>{m2}</option>)}
                  {cap.method && !(PAYMENT_METHODS as readonly string[]).includes(cap.method) && <option value={cap.method}>{cap.method}</option>}
                </select>
              </div>
              <Field label="DESCRIPTION" value={cap.description} onChange={v => setCap({ ...cap, description: v })} placeholder="Optional note" />
            </div>
            <button disabled={saving || !cap.event_date || !cap.member.trim() || !n(cap.amount)} className={saveBtn}
              onClick={() => save('capital_events', { ...cap, member: cap.member.trim(), amount: n(cap.amount), method: cap.method.trim() || null, description: cap.description.trim() || null }, () => setCap({ event_date: '', kind: 'CONTRIBUTION', member: '', amount: '', method: '', description: '' }))}>
              {saving ? 'SAVING…' : cap.kind === 'CONTRIBUTION' ? 'ADD CONTRIBUTION' : 'ADD DRAW'}
            </button>
          </div>
          {capital.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden mb-2">
              {capital.map(c => (
                <div key={c.id} className="px-5 py-3 flex items-center gap-4 border-t border-gray-800 first:border-t-0">
                  <span className="text-gray-400 text-sm w-24 shrink-0">{formatShortDate(c.event_date)}</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-bold shrink-0 ${c.kind === 'CONTRIBUTION' ? 'bg-emerald-950 text-emerald-400' : 'bg-red-950 text-red-400'}`}>{c.kind === 'CONTRIBUTION' ? 'APORTE' : 'RETIRADA'}</span>
                  <span className="flex-1 truncate">{c.member}{c.description ? ` — ${c.description}` : ''}{c.method ? ` · ${c.method}` : ''}</span>
                  <span className="text-xl font-bold tabular-nums whitespace-nowrap">{usd(n(c.amount))}</span>
                  <button onClick={() => del('capital_events', c.id)} className="text-gray-600 hover:text-red-400 font-bold text-lg px-1">✕</button>
                </div>
              ))}
            </div>
          )}

          {/* ── EMPRÉSTIMOS & FINANCIAMENTOS ────────────────────────── */}
          <div className="border-t border-gray-800 pt-6 mt-8">
            <h2 className="text-2xl font-bold mb-1">EMPRÉSTIMOS &amp; FINANCIAMENTOS</h2>
            <p className="text-gray-400 mb-5">RECEBEU sobe caixa e dívida · AMORTIZOU desce os dois · JUROS sai do caixa e vira despesa na DRE.</p>

            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5 mb-6">
              <p className="text-lg font-bold mb-4">NEW CONTRACT</p>
              <div className="grid grid-cols-1 gap-5">
                <Field label="LENDER" value={loan.lender} onChange={v => setLoan({ ...loan, lender: v })} placeholder="K&G FINANCING, INC." />
                <DatePicker label="START DATE" value={loan.start_date} onChange={v => setLoan({ ...loan, start_date: v })} />
                <div>
                  <label className="block mb-2 text-lg font-bold">RATE % / YEAR</label>
                  <input type="text" inputMode="decimal" value={loan.rate_apr} onChange={e => { if (isNumeric(e.target.value)) setLoan({ ...loan, rate_apr: e.target.value }) }} className={inputClass} placeholder="Optional" />
                </div>
                {/* João, 26/ago (caso Heraldo/Advanced Transports): o estado e o save já
                    tinham description — faltava a CAIXA. Proveniência mora aqui. */}
                <Field label="NOTES" value={loan.description} onChange={v => setLoan({ ...loan, description: v })} placeholder="A história do contrato: de onde veio o dinheiro, pra que serve, nº de confirmação…" />
                <button disabled={saving || !loan.lender.trim()} className="w-full bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold"
                  onClick={() => save('financing', { lender: loan.lender.trim(), start_date: loan.start_date || null, rate_apr: loan.rate_apr ? n(loan.rate_apr) : null, description: loan.description.trim() || null }, () => setLoan({ lender: '', start_date: '', rate_apr: '', description: '' }))}>
                  + ADD CONTRACT
                </button>
              </div>
            </div>

            {financing.map(f => (
              <div key={f.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 mb-5">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xl font-bold">{f.lender}</span>
                  {f.rate_apr != null && <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-800 text-gray-300">{f.rate_apr}% a.a.</span>}
                  <span className="ml-auto px-3 py-1 rounded-full text-sm font-bold bg-amber-950 text-amber-300 tabular-nums">DEVEDOR {usd(loanBalance(f.id))}</span>
                  <button onClick={() => del('financing', f.id)} className="text-gray-600 hover:text-red-400 font-bold text-lg px-1" title="Apaga o contrato e os eventos">✕</button>
                </div>
                {f.description && <p className="text-sm text-gray-400 mt-1">{f.description}</p>}

                {finEvents.filter(e => e.financing_id === f.id).length > 0 && (
                  <div className="mt-4 border-t border-gray-800">
                    {finEvents.filter(e => e.financing_id === f.id).map(e => (
                      <div key={e.id} className="py-3 flex items-center gap-4 border-b border-gray-800 last:border-b-0">
                        <span className="text-gray-400 text-sm w-24 shrink-0">{formatShortDate(e.event_date)}</span>
                        <span className={`px-3 py-1 rounded-full text-sm font-bold shrink-0 ${e.kind === 'DISBURSEMENT' ? 'bg-emerald-950 text-emerald-400' : e.kind === 'PAYMENT' ? 'bg-sky-950 text-sky-400' : 'bg-red-950 text-red-400'}`}>{e.kind === 'DISBURSEMENT' ? 'RECEBEU' : e.kind === 'PAYMENT' ? 'AMORTIZOU' : 'JUROS'}</span>
                        <span className="flex-1 truncate text-gray-300">{e.description || ''}</span>
                        <span className="text-xl font-bold tabular-nums whitespace-nowrap">{usd(n(e.amount))}</span>
                        <button onClick={() => del('financing_events', e.id)} className="text-gray-600 hover:text-red-400 font-bold text-lg px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {evt.financing_id !== f.id ? (
                  <button onClick={() => setEvt({ financing_id: f.id, event_date: '', kind: 'DISBURSEMENT', amount: '', description: '' })}
                    className="mt-4 w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 px-6 py-3 rounded-2xl text-lg font-bold">+ ADD EVENT</button>
                ) : (
                  <div className="mt-4 bg-black/40 border border-gray-800 rounded-2xl p-4 grid grid-cols-1 gap-5">
                    <DatePicker label="DATE" value={evt.event_date} onChange={v => setEvt({ ...evt, event_date: v })} />
                    <div>
                      <label className="block mb-2 text-lg font-bold">EVENT</label>
                      <select value={evt.kind} onChange={e => setEvt({ ...evt, kind: e.target.value })} className={inputClass}>
                        <option value="DISBURSEMENT">RECEBEU — dinheiro entrou</option>
                        <option value="PAYMENT">AMORTIZOU — pagou principal</option>
                        <option value="INTEREST">JUROS — pagou juros</option>
                      </select>
                    </div>
                    <MoneyField label="AMOUNT" value={evt.amount} onChange={v => setEvt({ ...evt, amount: v })} />
                    <Field label="DESCRIPTION" value={evt.description} onChange={v => setEvt({ ...evt, description: v })} placeholder="Optional" />
                    <div className="flex gap-4 items-center">
                      <button onClick={() => setEvt({ financing_id: '', event_date: '', kind: 'DISBURSEMENT', amount: '', description: '' })} className="text-gray-400 text-lg font-bold px-2">Cancel</button>
                      <button disabled={saving || !evt.event_date || !n(evt.amount)} className={`flex-1 ${saveBtn}`}
                        onClick={() => save('financing_events', { financing_id: f.id, event_date: evt.event_date, kind: evt.kind, amount: n(evt.amount), description: evt.description.trim() || null }, () => setEvt({ financing_id: '', event_date: '', kind: 'DISBURSEMENT', amount: '', description: '' }))}>
                        {saving ? 'SAVING…' : 'ADD EVENT'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── SALDOS DE CAIXA ─────────────────────────────────────── */}
          <div className="border-t border-gray-800 pt-6 mt-8">
            <h2 className="text-2xl font-bold mb-1">SALDOS DE CAIXA</h2>
            <p className="text-gray-400 mb-5">Fim de mês, por conta, direto do extrato. O Balanço usa o último saldo de cada conta; a conciliação compara a variação real com a calculada pelo DFC.</p>
            <div className="grid grid-cols-1 gap-5 mb-5">
              <DatePicker label="BALANCE DATE" value={bal.balance_date} onChange={v => setBal({ ...bal, balance_date: v })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="ACCOUNT" value={bal.account} onChange={v => setBal({ ...bal, account: v })} placeholder="Regions •9336" />
                <MoneyField label="BALANCE" value={bal.balance} onChange={v => setBal({ ...bal, balance: v })} />
              </div>
              <Field label="NOTES" value={bal.notes} onChange={v => setBal({ ...bal, notes: v })} placeholder="Optional" />
              <button disabled={saving || !bal.balance_date || !bal.account.trim() || bal.balance === ''} className={saveBtn}
                onClick={() => save('cash_balances', { balance_date: bal.balance_date, account: bal.account.trim(), balance: n(bal.balance), notes: bal.notes.trim() || null }, () => setBal({ balance_date: '', account: '', balance: '', notes: '' }))}>
                {saving ? 'SAVING…' : 'ADD BALANCE'}
              </button>
            </div>
            {balances.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                {balances.map(b => (
                  <div key={b.id} className="px-5 py-3 flex items-center gap-4 border-t border-gray-800 first:border-t-0">
                    <span className="text-gray-400 text-sm w-24 shrink-0">{formatShortDate(b.balance_date)}</span>
                    <span className="flex-1 truncate font-bold">{b.account}{b.notes ? <span className="font-normal text-gray-400"> — {b.notes}</span> : null}{b.source === 'PLAID' ? <span className="px-2 py-0.5 ml-2 rounded-full text-xs font-bold bg-sky-950 text-sky-300">PLAID</span> : null}</span>
                    <span className="text-xl font-bold tabular-nums whitespace-nowrap">{usd(n(b.balance))}</span>
                    <button onClick={() => del('cash_balances', b.id)} className="text-gray-600 hover:text-red-400 font-bold text-lg px-1">✕</button>
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
