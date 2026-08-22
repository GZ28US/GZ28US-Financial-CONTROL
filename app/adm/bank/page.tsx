'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'

// ADM ▸ BANK — o UNIVERSO bancário (ordem do Márcio, 18/ago/2026): a Regions entra
// aqui via Plaid e toda transação vira uma linha de bank_transactions. Esta tela é
// a janela: conexões, placar do casamento e as últimas transações. O CONNECT BANK
// abre o Plaid Link (o único momento humano — o consentimento OAuth no banco).
type Account = { id: string; institution: string; display_name: string | null; accounts: Record<string, { name: string; mask: string | null; type: string }> | null; status: string; last_synced_at: string | null }
type Tx = { id: string; plaid_account_id: string | null; item_id: string; date: string; amount: number; name: string | null; merchant: string | null; pending: boolean; check_number: string | null; match_status: string }

declare global { interface Window { Plaid?: { create: (cfg: Record<string, unknown>) => { open: () => void } } } }

const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  const [showAll, setShowAll] = useState(false)
  async function load(all = showAll) {
    const r = await fetch(`${BASE_PATH}/api/plaid/accounts?limit=${all ? 5000 : 300}`)
    const d = await r.json().catch(() => ({}))
    setConfigured(Boolean(d.configured))
    setEnv(String(d.env || ''))
    setAccounts(d.accounts || [])
    setRecent(d.recent || [])
    setCounts(d.counts || {})
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

  // HISTÓRICO COMPLETO (21/ago): reabre o Link em update mode pedindo 730 dias.
  // Sem exchange — é a mesma conexão. O Plaid busca o passado em segundo plano e
  // o webhook HISTORICAL_UPDATE sincroniza; o SYNC aqui pega o que já veio.
  async function expandHistory(itemId: string) {
    setBusy('history')
    try {
      const r = await fetch(`${BASE_PATH}/api/plaid/link-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id: itemId }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) { alert(d.error || 'Could not create the update link token.'); return }
      withPlaidScript(() => {
        window.Plaid!.create({
          token: d.link_token,
          onSuccess: async () => {
            await fetch(`${BASE_PATH}/api/plaid/accounts`, { method: 'POST' }).catch(() => null)
            await load()
            alert('Histórico de 24 meses solicitado. O Plaid busca o passado em segundo plano — as transações antigas entram sozinhas nos próximos minutos (webhook) ou no SYNC NOW.')
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
      const r = await fetch(`${BASE_PATH}/api/plaid/accounts`, { method: 'POST' })
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
        <h1 className="text-4xl font-bold">BANK</h1>
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

      {configured === false && (
        <div className="bg-amber-950/40 border border-amber-700 rounded-3xl p-6 mb-6">
          <p className="text-lg font-bold text-amber-300">Plaid keys not set yet</p>
          <p className="text-gray-300 mt-1">Set <span className="font-mono">PLAID_CLIENT_ID</span>, <span className="font-mono">PLAID_SECRET</span> and <span className="font-mono">PLAID_ENV=production</span> in Vercel. Until then this screen is dormant — nothing breaks.</p>
        </div>
      )}
      {env === 'sandbox' && configured && (
        <p className="text-sm font-bold text-fuchsia-300 mb-4">⚠️ SANDBOX mode — test data only, no real bank.</p>
      )}

      {/* Placar do universo */}
      {Object.keys(counts).length > 0 && (
        <div className="flex gap-3 mb-6 flex-wrap">
          {Object.entries(counts).map(([k, v]) => (
            <span key={k} className={`px-4 py-2 rounded-full text-sm font-bold ${STATUS_BADGE[k] || 'bg-gray-800 text-gray-300'}`}>{k}: {v}</span>
          ))}
        </div>
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
            <p className="text-xs text-gray-500 mt-2">last sync {a.last_synced_at ? new Date(a.last_synced_at).toLocaleString('en-US') : 'never'}</p>
            {a.status === 'NEEDS_REAUTH' && (
              <button onClick={connectBank} className="mt-3 bg-amber-600 hover:bg-amber-500 text-black px-4 py-2 rounded-2xl font-bold text-sm">RECONNECT</button>
            )}
            {a.status === 'ACTIVE' && (
              <button onClick={() => expandHistory(a.id)} disabled={busy !== null} className="mt-3 bg-sky-800 hover:bg-sky-700 disabled:opacity-50 px-4 py-2 rounded-2xl font-bold text-sm" title="Reabre o consentimento pedindo 24 meses de histórico (o padrão da primeira conexão era 90 dias)">
                {busy === 'history' ? 'OPENING…' : '⟲ FULL HISTORY — 24 MONTHS'}
              </button>
            )}
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
          <h2 className="text-2xl font-bold mb-4">LATEST TRANSACTIONS</h2>
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
                  </td>
                  <td className={`py-2.5 pr-4 text-right font-bold ${t.amount > 0 ? 'text-red-300' : 'text-green-300'}`}>{t.amount > 0 ? '−' : '+'}{usd(t.amount)}</td>
                  <td className="py-2.5 pr-4"><span className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_BADGE[t.match_status] || 'bg-gray-800 text-gray-300'}`}>{t.match_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
