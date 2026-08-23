'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import BlBadge from '@/components/BlBadge'
import { sessionHeaders } from '@/components/BankReconcileCard'

// ADM ▸ BANK — o UNIVERSO bancário (ordem do Márcio, 18/ago/2026): a Regions entra
// aqui via Plaid e toda transação vira uma linha de bank_transactions. Esta tela é
// a janela: conexões, placar do casamento e as últimas transações. O CONNECT BANK
// abre o Plaid Link (o único momento humano — o consentimento OAuth no banco).
type Account = { id: string; institution: string; display_name: string | null; accounts: Record<string, { name: string; mask: string | null; type: string }> | null; status: string; last_synced_at: string | null }
type Tx = { id: string; plaid_account_id: string | null; item_id: string; date: string; amount: number; name: string | null; merchant: string | null; pending: boolean; check_number: string | null; match_status: string; plaid_id: string | null }

declare global { interface Window { Plaid?: { create: (cfg: Record<string, unknown>) => { open: () => void } } } }

const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Vocabulário de conciliação na tela (o banco guarda NEW/MATCHED/…; NEW = ainda sem par no app)
const STATUS_LABEL: Record<string, string> = { NEW: 'UNMATCHED', MATCHED: 'MATCHED', POSTED: 'BOOKED', TRANSFER: 'TRANSFER', QUEUED: 'TO BOOK', IGNORED: 'IGNORED', REMOVED: 'REMOVED' }
const isStatement = (t: { plaid_id: string | null }) => String(t.plaid_id || '').startsWith('stmt:')
const STATUS_BADGE: Record<string, string> = {
  NEW: 'bg-amber-800 text-amber-200',
  MATCHED: 'bg-green-900 text-green-300',
  POSTED: 'bg-green-800 text-green-200',
  TRANSFER: 'bg-blue-900 text-blue-300',
  QUEUED: 'bg-fuchsia-900 text-fuchsia-300',
  IGNORED: 'bg-gray-800 text-gray-400',
  REMOVED: 'bg-gray-800 text-gray-500',
}

export default function BankPage() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [env, setEnv] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [recent, setRecent] = useState<Tx[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [sources, setSources] = useState<{ STATEMENT: number; PLAID: number }>({ STATEMENT: 0, PLAID: 0 })
  const [balances, setBalances] = useState<Record<string, { balance: number; date: string; source: string; notes: string | null }>>({})
  // Saldo REAL (Plaid agora) + integridade do feed, por conexão — /api/plaid/balance
  type LiveItem = { id: string; account: string; live: { current: number; available: number; as_of: string; realtime: boolean; cached: boolean } | null; live_error: string | null; last: { date: string; balance: number; source: string } | null; integrity: { anchor_date: string; anchor_balance: number; lines_after: number; net_after: number; implied: number; pending_out: number; gap: number | null } | null }
  const [liveItems, setLiveItems] = useState<LiveItem[] | null>(null)
  const [liveErr, setLiveErr] = useState('')
  async function loadLive(force = false) {
    // force = consulta PAGA ao Plaid (produto Balance, ~$0,10) — só com confirmação e dentro do teto diário.
    if (force && !confirm('Consultar o banco AGORA custa uma chamada paga ao Plaid (~$0,10). O saldo grátis (última atualização do item) já está na tela. Continuar?')) return
    setLiveErr('')
    try {
      const r = await fetch(`${BASE_PATH}/api/plaid/balance${force ? '?force=1' : ''}`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLiveItems(d.items || [])
    } catch (e) { setLiveErr(String((e as Error).message || e)); setLiveItems([]) }
  }
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => { void load(); void loadLive() }, [])

  const [showAll, setShowAll] = useState(false)
  async function load(all = showAll) {
    const r = await fetch(`${BASE_PATH}/api/plaid/accounts?limit=${all ? 5000 : 300}`, { headers: await sessionHeaders() })
    const d = await r.json().catch(() => ({}))
    setConfigured(Boolean(d.configured))
    setEnv(String(d.env || ''))
    setAccounts(d.accounts || [])
    setRecent(d.recent || [])
    setCounts(d.counts || {})
    setSources(d.sources || { STATEMENT: 0, PLAID: 0 })
    setBalances(d.balances || {})
  }

  // Carrega o script do Plaid Link uma vez, sob demanda.
  function withPlaidScript(fn: () => void) {
    if (window.Plaid) { fn(); return }
    const s = document.createElement('script')
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    s.onload = fn
    s.onerror = () => alert('Could not load the Plaid Link script — check the connection.')
    document.head.appendChild(s)
  }

  async function connectBank() {
    setBusy('connect')
    try {
      const r = await fetch(`${BASE_PATH}/api/plaid/link-token`, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) { alert(d.error || 'Could not create the link token.'); return }
      withPlaidScript(() => {
        window.Plaid!.create({
          token: d.link_token,
          onSuccess: async (public_token: string, metadata: any) => {
            const ex = await fetch(`${BASE_PATH}/api/plaid/exchange`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token, institution_name: metadata?.institution?.name || '' }),
            })
            const ed = await ex.json().catch(() => ({}))
            if (!ex.ok || ed.error) alert(ed.error || 'Exchange failed.')
            await load()
          },
          onExit: () => setBusy(null),
        }).open()
      })
    } finally {
      setBusy(null)
    }
  }

  async function syncNow() {
    setBusy('sync')
    try {
      const r = await fetch(`${BASE_PATH}/api/plaid/accounts`, { method: 'POST', headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (d.results?.some((x: any) => x.error)) alert('Sync issues:\n' + d.results.filter((x: any) => x.error).map((x: any) => `${x.account}: ${x.error}`).join('\n'))
      await load()
    } finally {
      setBusy(null)
    }
  }

  const accName = (tx: Tx) => {
    const acc = accounts.find((a) => a.id === tx.item_id)
    const sub = tx.plaid_account_id && acc?.accounts ? acc.accounts[tx.plaid_account_id] : null
    return sub ? `${sub.name}${sub.mask ? ' •' + sub.mask : ''}` : (acc?.display_name || '—')
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <div className="flex items-baseline gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">BANK LINK</h1>
          <BlBadge />
          <a href={`${BASE_PATH}/adm/financials`} className="text-gray-400 hover:text-white font-bold">FINANCIAL HUB →</a>
        </div>
        <div className="flex gap-3">
          <Link href="/adm/reports" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          {accounts.length > 0 && (
            <button onClick={syncNow} disabled={busy !== null} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
              {busy === 'sync' ? 'SYNCING…' : 'SYNC NOW'}
            </button>
          )}
          <button onClick={connectBank} disabled={busy !== null || configured === false} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
            {busy === 'connect' ? 'OPENING…' : '+ CONNECT BANK'}
          </button>
        </div>
      </div>
      <p className="text-xl text-gray-400 mb-6">The banking universe — every transaction the bank posts lands here by itself.</p>

      {/* CAIXA CONSOLIDADO — manchete da página (Márcio, 22/ago): o que a empresa tem
          agora somando todas as conexões. Não é card: os cards são só os bancos. */}
      {accounts.length > 0 && (() => {
        // O número grande é o que o BANCO diz agora (Plaid). Se o Plaid não responder,
        // mostra o último saldo gravado com aviso — nunca um número "calculado".
        const items = liveItems || []
        const liveOnes = items.filter((i) => i.live)
        const total = liveOnes.reduce((s, i) => s + i.live!.current, 0)
        const avail = liveOnes.reduce((s, i) => s + i.live!.available, 0)
        const asOf = liveOnes.map((i) => i.live!.as_of).sort()[0]
        const fallback = items.filter((i) => !i.live && i.last)
        const fbTotal = fallback.reduce((s, i) => s + i.last!.balance, 0)
        const loading = liveItems === null
        const gapTotal = items.reduce((s, i) => s + (i.integrity?.gap ?? 0), 0)
        const pendTotal = items.reduce((s, i) => s + (i.integrity?.pending_out ?? 0), 0)
        const bate = Math.abs(gapTotal) <= pendTotal + 1
        return (
          <div className="flex items-end justify-between gap-6 flex-wrap border-b border-gray-800 pb-6 mb-8">
            <div>
              <p className="text-sm font-bold tracking-widest text-gray-500">CAIXA CONSOLIDADO <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full border border-sky-900 bg-sky-950 text-sky-300 align-middle">SALDO DO BANCO · PLAID</span></p>
              {loading ? <p className="text-6xl font-bold tabular-nums leading-none mt-2 text-gray-600">…</p>
                : liveOnes.length > 0 ? <p className={`text-6xl font-bold tabular-nums leading-none mt-2 ${total < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{total < 0 ? '−' : ''}{usd(total)}</p>
                : <p className="text-6xl font-bold tabular-nums leading-none mt-2 text-amber-300">{fallback.length ? (fbTotal < 0 ? '−' : '') + usd(fbTotal) : '—'}</p>}
              <p className="text-xs text-gray-500 mt-2">
                {loading ? 'consultando o banco…'
                  : liveOnes.length > 0 ? <>disponível <span className="text-gray-300 font-bold tabular-nums">{usd(avail)}</span> · {liveOnes.every((i) => i.live!.realtime) ? 'banco consultado agora (chamada paga)' : <span title="Leitura grátis: saldo da última atualização do item pelo Plaid (normalmente do mesmo dia). A consulta em tempo real é paga e fica no botão.">Plaid · última atualização (grátis)</span>} às {asOf ? new Date(asOf).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'} · <button onClick={() => loadLive(true)} className="underline hover:text-white" title="chamada paga ao Plaid (~$0,10) · teto 3/dia">consultar o banco agora ($)</button></>
                  : <span className="text-amber-300">Plaid sem resposta{liveErr ? ' — ' + liveErr : items[0]?.live_error ? ' — ' + items[0].live_error : ''} · mostrando o último saldo gravado{fallback[0] ? ` (${fallback[0].last!.date}, ${fallback[0].last!.source === 'PLAID' ? 'Plaid' : 'extrato'})` : ''} · <button onClick={() => loadLive(true)} className="underline">tentar de novo</button></span>}
              </p>
            </div>
            {items.some((i) => i.integrity) && (
              <div className="text-right text-xs text-gray-500">
                <p className="font-bold tracking-widest text-gray-500 mb-1">O FEED BATE? <span className={`ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${liveOnes.length === 0 ? 'bg-gray-800 text-gray-400' : bate ? 'bg-emerald-950 text-emerald-300 border border-emerald-900' : 'bg-red-950 text-red-300 border border-red-900'}`}>{liveOnes.length === 0 ? 'SEM SALDO REAL' : bate ? 'BATE' : 'NÃO BATE'}</span></p>
                {items.filter((i) => i.integrity).map((i) => (
                  <p key={i.id}>extrato {i.integrity!.anchor_date} {usd(i.integrity!.anchor_balance)} + {i.integrity!.lines_after} linhas = <span className="text-gray-300 tabular-nums">{usd(i.integrity!.implied)}</span>{i.integrity!.gap != null ? <> · diferença <span className={`tabular-nums font-bold ${Math.abs(i.integrity!.gap) <= i.integrity!.pending_out + 1 ? 'text-emerald-300' : 'text-red-300'}`}>{i.integrity!.gap < 0 ? '−' : '+'}{usd(i.integrity!.gap)}</span> (pendente {usd(i.integrity!.pending_out)})</> : null}</p>
                ))}
                <p className="mt-1">diferença além do pendente = linha faltando ou sobrando no feed → Data Checker</p>
              </div>
            )}
          </div>
        )
      })()}

      {configured === false && (
        <div className="bg-amber-950/40 border border-amber-700 rounded-3xl p-6 mb-6">
          <p className="text-lg font-bold text-amber-300">Plaid keys not set yet</p>
          <p className="text-gray-300 mt-1">Set <span className="font-mono">PLAID_CLIENT_ID</span>, <span className="font-mono">PLAID_SECRET</span> and <span className="font-mono">PLAID_ENV=production</span> in Vercel. Until then this screen is dormant — nothing breaks.</p>
        </div>
      )}
      {env === 'sandbox' && configured && (
        <p className="text-sm font-bold text-fuchsia-300 mb-4">⚠️ SANDBOX mode — test data only, no real bank.</p>
      )}


      {/* Conexões */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        {accounts.map((a) => (
          <div key={a.id} className={`rounded-3xl p-5 border ${a.status === 'ACTIVE' ? 'bg-gray-900 border-gray-800' : 'bg-red-950/40 border-red-800'}`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-bold">{a.display_name || a.institution}</h2>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${a.status === 'ACTIVE' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-200'}`}>{a.status}</span>
            </div>
            <p className="text-sm text-gray-400 mt-1">
              {a.accounts ? Object.values(a.accounts).map((s) => `${s.name}${s.mask ? ' •' + s.mask : ''}`).join(' · ') : '—'}
            </p>
            {(() => { const li = (liveItems || []).find((i) => i.id === a.id); return li && li.live ? (
              <div className="mt-3">
                <p className="text-xs font-bold text-gray-500">BALANCE <span className="text-sky-300">· real</span></p>
                <p className={`text-2xl font-bold tabular-nums ${li.live.current < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{li.live.current < 0 ? '−' : ''}{usd(li.live.current)}</p>
                <p className="text-xs text-gray-500">disponível {usd(li.live.available)} · Plaid agora</p>
              </div>
            ) : null })()}
            {!(liveItems || []).find((i) => i.id === a.id && i.live) && balances[a.id] ? (
              <div className="mt-3">
                <p className="text-xs font-bold text-gray-500">BALANCE <span className="text-amber-300">· último gravado</span></p>
                <p className={`text-2xl font-bold tabular-nums ${balances[a.id].balance < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{balances[a.id].balance < 0 ? '−' : ''}{usd(balances[a.id].balance)}</p>
                <p className="text-xs text-gray-500">em {balances[a.id].date} · {balances[a.id].source === 'PLAID' ? 'Plaid' : 'extrato'}{balances[a.id].notes ? ` · ${balances[a.id].notes}` : ''}</p>
              </div>
            ) : <p className="text-xs text-gray-600 mt-3">sem saldo ainda — SYNC NOW busca</p>}
            <p className="text-xs text-gray-500 mt-2">last sync {a.last_synced_at ? new Date(a.last_synced_at).toLocaleString('en-US') : 'never'}</p>
            {a.status === 'NEEDS_REAUTH' && (
              <button onClick={connectBank} className="mt-3 bg-amber-600 hover:bg-amber-500 text-black px-4 py-2 rounded-2xl font-bold text-sm">RECONNECT</button>
            )}
            <p className="text-xs text-gray-600 mt-2">histórico online da Regions: 90 dias — o resto entra por extrato</p>
          </div>
        ))}
        {accounts.length === 0 && configured !== false && (
          <p className="text-gray-400 text-lg col-span-full">No bank connected yet — press CONNECT BANK and sign in to Regions once. After that, everything is automatic.</p>
        )}
      </div>

      {/* Últimas transações */}
      {recent.length > 0 && (() => { const total = Object.values(counts).reduce((s, n) => s + n, 0); return (
        <div className="flex items-center gap-3 mb-2 text-sm text-gray-400">
          <span>Mostrando {recent.length} de {total} transações{showAll ? '' : ' (as mais recentes)'}</span>
          {total > recent.length && <button onClick={() => { setShowAll(true); load(true) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-1 rounded-xl font-bold text-xs">SHOW ALL ({total})</button>}
          {showAll && <button onClick={() => { setShowAll(false); load(false) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-1 rounded-xl font-bold text-xs">SÓ RECENTES</button>}
        </div>
      ) })()}
      {recent.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 overflow-x-auto">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <div>
              <h2 className="text-2xl font-bold">LATEST TRANSACTIONS</h2>
              <p className="text-xs text-gray-500 mt-1">
                {(sources.STATEMENT + sources.PLAID).toLocaleString('en-US')} lines · <span className="text-gray-400 font-bold">{sources.STATEMENT.toLocaleString('en-US')}</span> imported from PDF statements (Nov/2025 → May/2026, badged) · the rest live from Plaid
              </p>
            </div>
            {/* Conciliação: quantas linhas já têm par no app. O trabalho acontece no Data Checker. */}
            {Object.keys(counts).length > 0 && (
              <div className="text-right">
                <p className="text-xs font-bold text-gray-500 mb-1">RECONCILIATION</p>
                <div className="flex gap-2 flex-wrap justify-end">
                  {Object.entries(counts).map(([k, v]) => (
                    <span key={k} className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_BADGE[k] || 'bg-gray-800 text-gray-300'}`}>{STATUS_LABEL[k] || k}: {v.toLocaleString('en-US')}</span>
                  ))}
                  <Link href="/adm/check" className="px-3 py-1 rounded-full text-xs font-bold bg-gray-800 hover:bg-gray-700 border border-gray-700">→ DATA CHECKER</Link>
                </div>
              </div>
            )}
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="text-gray-400 text-sm border-b border-gray-700">
                <th className="py-2 pr-4 font-bold">DATE</th>
                <th className="py-2 pr-4 font-bold">ACCOUNT</th>
                <th className="py-2 pr-4 font-bold">DESCRIPTION</th>
                <th className="py-2 pr-4 font-bold text-right">AMOUNT</th>
                <th className="py-2 pr-4 font-bold">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className="border-b border-gray-800">
                  <td className="py-2.5 pr-4 text-gray-400 whitespace-nowrap">{t.date}</td>
                  <td className="py-2.5 pr-4 text-gray-400 whitespace-nowrap">{accName(t)}</td>
                  <td className="py-2.5 pr-4">
                    {t.merchant || t.name || '—'}
                    {t.check_number ? <span className="ml-2 text-xs text-gray-500">check #{t.check_number}</span> : null}
                    {t.pending ? <span className="ml-2 text-xs text-amber-400">pending</span> : null}
                    {isStatement(t) ? <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-800 text-gray-400 border border-gray-700 align-middle" title="Importada do extrato em PDF — antes do Plaid">STATEMENT</span> : null}
                  </td>
                  <td className={`py-2.5 pr-4 text-right font-bold ${t.amount > 0 ? 'text-red-300' : 'text-green-300'}`}>{t.amount > 0 ? '−' : '+'}{usd(t.amount)}</td>
                  <td className="py-2.5 pr-4"><span className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_BADGE[t.match_status] || 'bg-gray-800 text-gray-300'}`}>{STATUS_LABEL[t.match_status] || t.match_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
