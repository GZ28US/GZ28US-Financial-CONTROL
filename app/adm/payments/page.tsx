'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// /ca/adm/payments — QUOTE PORTAL M5 (06/11/2026; blueprint §2.2). Payouts → Regions, attempts, stuck events (REPLAY), stale bank
// payments, Stripe incomes not in a payout yet, test artefacts. REFUND lives here, staff only, typed confirmation; never automatic.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { fmtStamp, fmtDay } from '@/lib/orlando'

const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const box = 'mt-2 bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm'

export default function PaymentsAdmin() {
  const [d, setD] = useState<any | null>(null)
  const [err, setErr] = useState(''), [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const r = await fetch(`${BASE_PATH}/api/adm/payments`, { headers: await sessionHeaders(), cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return }
    setD(j)
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])
  const post = async (body: Record<string, unknown>) => {
    setMsg('')
    const r = await fetch(`${BASE_PATH}/api/adm/payments`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? '✓ ' + JSON.stringify(j.result).slice(0, 300) : '✖ ' + (j.error || r.status)); load()
  }
  const refund = (a: any) => {
    const ach = a.method_type === 'us_bank_account'
    const v = ach ? '' : prompt(`REFUND ${a.code} installment ${a.seq} — paid ${usd(a.amount_cents / 100)}.\nAmount in US$ (empty = everything left):`, '')
    if (v === null) return
    const cents = v.trim() ? Math.round(Number(v.replace(/[^0-9.]/g, '')) * 100) : null
    const typed = prompt(`This sends money back to the client through Stripe.\nType ${cents ?? 'FULL'} to confirm:`)
    if (typed === null) return
    post({ action: 'refund', attempt_id: a.id, amount_cents: cents, confirm: typed.trim() })
  }
  if (err) return <div className="min-h-screen bg-black text-white"><Header /><div className="p-6 text-red-400">{err}</div></div>
  return <div className="min-h-screen bg-black text-white pb-20"><Header />
    <div className="max-w-4xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-bold">PAYMENTS — Stripe · payouts · attempts</h1>
        <button onClick={() => post({ action: 'sync' })} className="px-3 py-2 rounded bg-gray-800 text-sm font-semibold">SYNC PAYOUTS</button></div>
      {d && <p className="text-xs text-gray-400 mt-1">Stripe key: {d.mode || 'off'} · today {fmtDay(d.today)} · test links live {d.test.links} · test documents {d.test.documents}</p>}
      {msg && <div className="mt-2 text-xs bg-gray-900 border border-gray-700 rounded p-2 break-all">{msg}</div>}
      {!d ? <p className="mt-4 text-gray-400">Loading…</p> : <>
        <h2 className="mt-5 text-sm font-bold text-gray-300">PAYOUTS ({d.payouts.length})</h2>
        <div className={box}>{d.payouts.map((p: any) => <div key={p.id} className="flex justify-between gap-3 py-1 border-b border-gray-900">
          <span>{p.id} · arrives {fmtDay(p.arrival_date)} · {p.status}{p.livemode ? '' : ' · test'} · {p.members} of ours{Math.abs(p.unresolved_amount) >= 0.005 ? ` · ${usd(p.unresolved_amount)} not ours (shop / adjustments)` : ''}</span>
          <span className={`shrink-0 ${p.bank_transaction_id ? 'text-emerald-400' : p.late ? 'text-red-300' : 'text-gray-400'}`}>{usd(p.amount)} {p.bank_transaction_id ? '✓ in Regions' : p.late ? '⚠ no Regions line yet' : ''}</span></div>)}
          {!d.payouts.length && <p className="text-gray-500">No payout mirrored yet — SYNC PAYOUTS reads them from Stripe.</p>}</div>

        <h2 className="mt-5 text-sm font-bold text-gray-300">NEEDS A LOOK</h2>
        <div className={box}>
          {d.events.map((e: any) => <div key={e.id} className="flex justify-between gap-3 py-1 border-b border-gray-900"><span className="text-amber-300">event {e.id} · {e.type} · {e.status}{e.error ? ' · ' + String(e.error).slice(0, 80) : ''} · tries {e.attempts ?? 0}</span>
            <button onClick={() => post({ action: 'replay', id: e.id })} className="shrink-0 text-xs underline">REPLAY</button></div>)}
          {d.stale.map((a: any) => <div key={a.id} className="py-1 border-b border-gray-900 text-amber-300">bank payment clearing &gt; 10 days · <Link href={`/doc/${a.invoice_id}`} className="underline">{a.code}</Link> · {usd(a.amount_cents / 100)} · since {fmtStamp(a.created_at)}</div>)}
          {d.unlinked.map((i: any) => <div key={i.id} className="py-1 border-b border-gray-900 text-gray-300">Stripe income not in a payout yet · <Link href={`/doc/${i.invoice_id}`} className="underline">open</Link> · {usd(i.amount)} · paid {fmtStamp(i.paid_at)}</div>)}
          {!d.events.length && !d.stale.length && !d.unlinked.length && <p className="text-emerald-400">Nothing waiting.</p>}
        </div>

        <h2 className="mt-5 text-sm font-bold text-gray-300">ATTEMPTS ({d.attempts.length})</h2>
        <div className={box}>{d.attempts.map((a: any) => <div key={a.id} className="flex justify-between gap-3 py-1 border-b border-gray-900">
          <span className={a.is_test ? 'text-gray-500' : ''}><Link href={`/doc/${a.invoice_id}`} className="underline">{a.code || '—'}</Link> · {a.seq ?? '—'} · {a.provider}{a.rail ? '/' + a.rail : ''} · {a.status}{a.livemode ? '' : ' · test'}{a.dispute_id ? ' · DISPUTED' : ''}{a.failure_code ? ' · ' + a.failure_code : ''} · {fmtStamp(a.created_at)}</span>
          <span className="shrink-0">{usd(a.amount_cents / 100)}{a.provider === 'STRIPE' && ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(a.status) && <button onClick={() => refund(a)} className="ml-2 text-xs text-red-300 underline">REFUND</button>}</span></div>)}</div>
      </>}
    </div></div>
}
