'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// /ca/doc/<invoiceId> — THE DOCUMENT PAGE (06/11/2026; blueprint §2.2, §6.6 B). M1 shell: header + chips, the stage-driven action
// bar, PLAN & TERMS, PAYMENT PLAN (→ INCOMES after hire), read-only summaries of the other tabs (EDIT IN EDITOR), ACTIVITY.
// Every mutation goes to /api/doc/<id>/<action> (staff only; real documents need app_settings qi_v2.actions — test documents
// don't). Nothing here sends a message: SEND freezes the revision and hands you the link + text to paste yourself.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { STAGE_LABEL, SUB_LABEL } from '@/lib/quoteStage'
import { fmtStamp, fmtDay } from '@/lib/orlando'
import { DocTab, StatusSheet, TAB_KEYS, tabLabel, type TabKey } from '@/components/doc/DocTabs'
import { ChangeOrderSheet } from '@/components/doc/ChangeOrderSheet'

type S = Record<string, any>
const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cents = (c: number) => usd(Number(c || 0) / 100)

export default function DocPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const [s, setS] = useState<S | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [tab, setTab] = useState<'PLAN' | 'ACTIVITY' | TabKey>('PLAN')
  const [sheet, setSheet] = useState<'' | 'send' | 'plan' | 'deposit' | 'approve' | 'extend' | 'void' | 'more' | 'status' | 'co'>('')
  const [out, setOut] = useState<{ url?: string; text?: string } | null>(null)

  const load = useCallback(async () => {
    const r = await fetch(`${BASE_PATH}/api/doc/${invoiceId}/state`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return }
    setS(j); setErr('')
  }, [invoiceId])
  useEffect(() => { const tm = setTimeout(load, 0); return () => clearTimeout(tm) }, [load])

  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setMsg('')
    const r = await fetch(`${BASE_PATH}/api/doc/${invoiceId}/${action}`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg('✖ ' + (j.problems ? j.problems.join(' · ') : j.error || `HTTP ${r.status}`)); return null }
    await load()
    return j
  }
  const copyLink = async () => {
    const r = await fetch(`${BASE_PATH}/api/doc/${invoiceId}/link`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg('✖ ' + (j.error || r.status)); return }
    setOut(j); try { await navigator.clipboard.writeText(j.text) } catch { /* shown below */ }
    setMsg('✓ text + link copied — paste it to the client yourself'); load()
  }

  if (err) return <div className="min-h-screen bg-black text-white"><Header /><div className="p-6 text-red-400">{err}</div></div>
  if (!s) return <div className="min-h-screen bg-black"><Header /></div>

  const st = s.stage || {}
  const stageText = `${STAGE_LABEL[st.stage as keyof typeof STAGE_LABEL] || st.stage}${st.sub ? ' · ' + SUB_LABEL[st.sub as keyof typeof SUB_LABEL] : st.stage === 'SIGNED' ? ' · awaiting deposit' : ''}`
  const inv = s.invoice, client = s.client, ride = s.ride
  const live = s.revisions?.find((r: S) => r.id === s.live?.id)
  const frozen: S[] = live?.installments || []
  const editorUrl = inv.ride_id ? `/rides/${inv.ride_id}/invoices/edit/${inv.id}?from=doc` : `/clients/${inv.client_id}/invoices/edit/${inv.id}?from=doc`
  const viewUrl = inv.ride_id ? `/rides/${inv.ride_id}/invoices/${inv.id}` : `/clients/${inv.client_id}/invoices/${inv.id}`
  const isQuote = inv.is_quote
  const blocked = !s.actionsAllowed

  const primary = !isQuote ? ['deposit', 'RECORD PAYMENT'] : st.stage === 'DRAFT' ? ['send', 'SEND'] : st.stage === 'SIGNED' ? ['deposit', 'RECORD DEPOSIT']
    : st.stage === 'EXPIRED' ? ['extend', 'EXTEND'] : ['copy', 'COPY LINK']

  return (
    <div className="min-h-screen bg-black text-white pb-32">
      <Header />
      <div className="max-w-3xl mx-auto px-4 py-4">
        <div className="flex items-center gap-3 text-sm text-gray-400"><Link href="/doc" className="underline">← ACTION NEEDED</Link><span>·</span><Link href={viewUrl} className="underline">legacy view</Link></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{inv.invoice_code}{s.live ? ` · rev ${s.live.seq}` : ''}</h1>
          <span className="px-2 py-0.5 rounded bg-sky-900 text-sky-200 text-xs font-bold">{stageText}</span>
          {!isQuote && <button onClick={() => setSheet('status')} className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 text-xs">{inv.live_status === 'REALTIME' ? 'ONLINE' : inv.live_status || 'INCOMPLETE'} ▾</button>}
          {s.isTest && <span className="px-2 py-0.5 rounded bg-yellow-800 text-yellow-100 text-xs font-bold">TEST</span>}
          {s.presentedDrift && <span className="px-2 py-0.5 rounded bg-red-800 text-red-100 text-xs">unsent changes</span>}
          {s.planDrift !== 0 && !isQuote && <span className="px-2 py-0.5 rounded bg-red-800 text-red-100 text-xs">balance ≠ plan ({cents(s.planDrift)})</span>}
          {Math.abs(s.signedDrift || 0) > 0.005 && <span className="px-2 py-0.5 rounded bg-red-800 text-red-100 text-xs">signed total ≠ live total</span>}
        </div>
        <div className="text-sm text-gray-300 mt-1">{client?.name}{client?.client_number ? ` #${client.client_number}` : ''} · {ride ? `${[ride.year, ride.brand, ride.model, ride.version].filter(Boolean).join(' ')} (${ride.project_code})` : 'parts'} · {inv.service}</div>
        <div className="text-xs text-gray-400 mt-1">
          {s.terms?.valid_until ? `valid until ${fmtDay(s.terms.valid_until)} · ` : ''}plan {s.plan.map((p: S) => p.pct != null ? `${p.pct}%` : usd(p.amount)).join('/')} · fees {s.terms?.fee_policy} · pays by {(s.terms?.rails || []).join('/')} · tax {s.money?.status}
          {s.liveLink?.gate === 'CONTACT' ? ` · gate ${s.liveLink.gate_tier === 'PHONE4' ? 'phone' : 'e-mail'}` : ''} · Stripe {s.stripeMode || 'off'}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div><div className="text-xs text-gray-400">GRAND TOTAL</div><div className="text-2xl font-bold">{usd(s.money?.grand)}</div></div>
          {!isQuote && <div className="text-right text-sm"><div className="text-emerald-400">received {usd(s.received)}</div><div className="text-amber-300">open {usd(s.openBalance)}</div>
            {inv.expected_conclusion_date && <div className="text-xs text-gray-300">🗓 PROMISED TO {fmtDay(String(inv.expected_conclusion_date).slice(0, 10))}</div>}</div>}
        </div>
        {blocked && <div className="mt-3 text-xs bg-amber-950 border border-amber-800 text-amber-200 rounded p-2">Actions on real documents are OFF (app_settings qi_v2.actions). You can read everything; test documents work.</div>}
        {s.readiness?.length > 0 && isQuote && !s.live && <div className="mt-2 text-xs text-red-300">Not ready to send: {s.readiness.join(' · ')}</div>}
        {msg && <div className="mt-3 text-sm bg-gray-900 border border-gray-700 rounded p-2 whitespace-pre-wrap">{msg}</div>}
        {out?.url && <div className="mt-2 text-xs bg-gray-950 border border-gray-800 rounded p-2 break-all"><div className="text-gray-400 mb-1">ready to paste (copied):</div>{out.text}</div>}

        <div className="mt-5 flex gap-2 flex-wrap text-xs">
          {(['PLAN', ...TAB_KEYS, 'ACTIVITY'] as const).map(k => <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 rounded ${tab === k ? 'bg-white text-black' : 'bg-gray-900 text-gray-300'}`}>
            {k === 'PLAN' ? (isQuote ? 'PAYMENT PLAN' : 'INCOMES') : k === 'ACTIVITY' ? `ACTIVITY ${s.events.length}` : s.tabs ? tabLabel(k, s.tabs) : k}</button>)}
          <Link href={`/doc/${invoiceId}/preview`} className="px-3 py-2 rounded bg-gray-900 text-gray-300">CLIENT VIEW</Link>
        </div>

        {tab === 'PLAN' && <div className="mt-3 bg-gray-950 border border-gray-800 rounded-xl p-3">
          {isQuote ? <>
            {(frozen.length ? frozen : s.plan).map((p: S) => (
              <div key={p.id} className="flex justify-between py-1.5 text-sm border-b border-gray-900">
                <span>{p.seq} · {p.label_text || p.label || p.label_key} · {p.due_rule}{p.pct != null ? ` · ${p.pct}%` : ''}</span>
                <span>{p.amount_cents != null ? cents(p.amount_cents) : p.amount != null ? usd(p.amount) : ''} · {p.paid_to}</span></div>))}
            <div className="text-xs text-gray-500 mt-2">{s.live ? `locked — sent rev ${s.live.seq} (NEW REVISION to change)` : 'editable until SEND'}</div>
          </> : <>
            {s.incomes.map((i: S) => <div key={i.id} className="flex justify-between py-1.5 text-sm border-b border-gray-900">
              <span>{i.description || '—'} {i.installment_id ? '· plan' : ''}{i.refund_id ? ' · refund' : ''}</span>
              <span className={i.paid_at ? 'text-emerald-400' : 'text-gray-300'}>{usd(i.amount)} {i.paid_at ? `✓ ${fmtDay(String(i.paid_at).slice(0, 10))}` : 'open'}</span></div>)}
          </>}
        </div>}

        {TAB_KEYS.includes(tab as TabKey) && s.tabs && <div className="mt-3 bg-gray-950 border border-gray-800 rounded-xl p-3">
          <DocTab k={tab as TabKey} s={s} act={act} blocked={blocked} editorUrl={editorUrl} /></div>}

        {tab === 'ACTIVITY' && <div className="mt-3 bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm">
          {s.events.filter((e: S) => e.actor !== 'SYSTEM' && e.actor !== 'STRIPE').map((e: S) => <Ev key={e.id} e={e} />)}
          <details className="mt-2"><summary className="text-xs text-gray-500 cursor-pointer">▸ system ({s.events.filter((e: S) => e.actor === 'SYSTEM' || e.actor === 'STRIPE').length})</summary>
            {s.events.filter((e: S) => e.actor === 'SYSTEM' || e.actor === 'STRIPE').map((e: S) => <Ev key={e.id} e={e} />)}</details>
          {s.clientNotes.length > 0 && <div className="mt-3">{s.clientNotes.map((n: S) => <blockquote key={n.id} className={`border-l-2 border-gray-600 pl-2 my-2 text-gray-300 ${n.hidden_at ? 'opacity-40' : ''}`}>
            <div className="text-xs text-gray-500">{n.kind} · {fmtStamp(n.created_at)}{n.reason ? ' · ' + n.reason : ''}</div>{n.text}
            {!n.hidden_at && <button onClick={() => act('note-hide', { note_id: n.id })} className="ml-2 text-xs underline text-gray-500">hide</button>}</blockquote>)}</div>}
        </div>}

        {sheet === 'send' && <SendSheet s={s} close={() => setSheet('')} act={act} setOut={setOut} />}
        {sheet === 'plan' && <PlanSheet s={s} close={() => setSheet('')} act={act} />}
        {sheet === 'deposit' && <DepositSheet s={s} close={() => setSheet('')} act={act} />}
        {sheet === 'approve' && <ApproveSheet close={() => setSheet('')} act={act} name={client?.name || ''} />}
        {sheet === 'extend' && <Sheet title="EXTEND" close={() => setSheet('')}>{[7, 15, 30].map(d => <button key={d} onClick={async () => { if (await act('extend', { days: d })) setSheet('') }} className="mr-2 px-4 py-2 rounded bg-white text-black">+{d} days</button>)}</Sheet>}
        {sheet === 'void' && <VoidSheet s={s} close={() => setSheet('')} act={act} />}
        {sheet === 'status' && <StatusSheet s={s} close={() => setSheet('')} act={act} />}
        {sheet === 'co' && <ChangeOrderSheet s={s} close={() => setSheet('')} act={act} />}
        {sheet === 'more' && <Sheet title="⋯" close={() => setSheet('')}>
          <div className="grid gap-2 text-sm">
            <Link href={editorUrl} className="px-3 py-2 rounded bg-gray-800">EDIT IN EDITOR →</Link>
            <a href={`${BASE_PATH}${viewUrl}`} className="px-3 py-2 rounded bg-gray-800">PRINT (legacy view)</a>
            {s.live && <button onClick={async () => { const r = await fetch(`${BASE_PATH}/api/doc/${invoiceId}/pdf`, { headers: await sessionHeaders() }); if (!r.ok) { setMsg('✖ PDF ' + r.status); return } window.open(URL.createObjectURL(await r.blob()), '_blank') }} className="px-3 py-2 rounded bg-gray-800 text-left">PDF — rev {s.live.seq} + full certificate</button>}
            {isQuote && !s.live && <button onClick={() => setSheet('plan')} className="px-3 py-2 rounded bg-gray-800 text-left">PLAN & TERMS</button>}
            {isQuote && s.live && !s.approvalOnLive && <button onClick={async () => { const j = await act('revision', { kind: 'QUOTE' }); if (j?.editor_url) window.location.href = BASE_PATH + j.editor_url }} className="px-3 py-2 rounded bg-gray-800 text-left">NEW REVISION → editor</button>}
            {isQuote && s.live && <button onClick={() => setSheet('extend')} className="px-3 py-2 rounded bg-gray-800 text-left">EXTEND</button>}
            {isQuote && !s.approvalOnLive && <button onClick={() => setSheet('approve')} className="px-3 py-2 rounded bg-gray-800 text-left">RECORD APPROVAL (phone / in person / text / e-mail)</button>}
            {s.liveLink && <button onClick={copyLink} className="px-3 py-2 rounded bg-gray-800 text-left">COPY LINK</button>}
            {s.liveLink?.gate === 'CONTACT' && <button onClick={() => act('gate-unlock')} className="px-3 py-2 rounded bg-gray-800 text-left">UNLOCK GATE</button>}
            {s.liveLink && <button onClick={() => act('rotate')} className="px-3 py-2 rounded bg-gray-800 text-left">ROTATE LINK (old link stops working)</button>}
            {!isQuote && s.coBase && <button onClick={() => setSheet('co')} className="px-3 py-2 rounded bg-gray-800 text-left">+ CHANGE ORDER</button>}
            {!isQuote && s.live?.kind === 'CHANGE_ORDER' && !s.approvalOnLive && <button onClick={() => setSheet('approve')} className="px-3 py-2 rounded bg-gray-800 text-left">RECORD CHANGE-ORDER APPROVAL (inside the §559.909 band)</button>}
            {!isQuote && <button onClick={() => setSheet('status')} className="px-3 py-2 rounded bg-gray-800 text-left">STATUS ▾ (ONLINE / CLOSE checklist)</button>}
            {isQuote && <button onClick={() => setSheet('void')} className="px-3 py-2 rounded bg-red-900 text-left">VOID</button>}
          </div></Sheet>}
      </div>

      <div className="fixed bottom-0 inset-x-0 bg-black/95 border-t border-gray-800 p-3 flex gap-2 justify-center">
        <button onClick={() => primary[0] === 'copy' ? copyLink() : setSheet(primary[0] as any)} className="flex-1 max-w-xs min-h-[48px] rounded-lg bg-emerald-500 text-black font-bold">{primary[1]}</button>
        {s.liveLink && primary[0] !== 'copy' && <button onClick={copyLink} className="flex-1 max-w-xs min-h-[48px] rounded-lg bg-gray-800 font-semibold">{s.approvalOnLive || !isQuote ? 'COPY PAY LINK' : 'COPY LINK'}</button>}
        {!s.liveLink && isQuote && <button onClick={() => setSheet('plan')} className="flex-1 max-w-xs min-h-[48px] rounded-lg bg-gray-800 font-semibold">PLAN & TERMS</button>}
        <button onClick={() => setSheet('more')} className="w-14 min-h-[48px] rounded-lg bg-gray-800 font-bold">⋯</button>
      </div>
    </div>
  )
}

function Ev({ e }: { e: S }) {
  const p = e.payload || {}
  const txt = e.kind === 'SENT' ? `rev ${p.seq} sent · ${p.channel}` : e.kind === 'HIRED' ? `hired ${p.invoice_code_before || p.old_code} → ${p.new_code || '(same car code)'} · plan ${p.plan?.n} × ${(p.plan?.amounts || []).map((a: number) => usd(a)).join(' / ')}`
    : e.kind === 'SIGNED' ? `✍ signed · ${p.method}${p.gate_tier ? ' · gate ' + p.gate_tier : ''}` : e.kind === 'VIEWED' ? `👁 opened · ${p.ua_class || ''}` : e.kind === 'SIDE_EFFECT' ? `${p.step} · ${p.status}${p.reason ? ' · ' + String(p.reason).slice(0, 80) : ''}`
    : e.kind === 'PAYMENT_ANOMALY' ? `⚠ ${p.anomaly}` : `${e.kind.toLowerCase().replace(/_/g, ' ')}${p.amount_cents ? ' · ' + cents(Number(p.amount_cents)) : ''}`
  return <div className="py-1 border-b border-gray-900 flex gap-3"><span className="text-gray-500 shrink-0 w-32">{fmtStamp(e.at)}</span><span>{txt}{p.test ? ' · test' : ''}{e.actor_id && e.actor === 'STAFF' ? ` · ${String(e.actor_id).split('@')[0]}` : ''}</span></div>
}

function Sheet({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={close}>
    <div className="bg-gray-950 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-lg p-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
      <div className="flex justify-between mb-3"><div className="font-bold">{title}</div><button onClick={close} className="text-gray-400">✕</button></div>{children}</div></div>
}
const inp = 'w-full bg-black border border-gray-700 rounded px-3 py-2 text-white text-sm'

function SendSheet({ s, close, act, setOut }: { s: S; close: () => void; act: any; setOut: any }) {
  const c = s.client || {}
  const pref = String(c.preferred_message_method || '').toUpperCase()
  const [channel, setChannel] = useState(pref.includes('FACE') ? 'FACEBOOK' : pref.includes('INSTA') ? 'INSTAGRAM' : pref.includes('MAIL') ? 'EMAIL' : pref.includes('SMS') ? 'SMS' : pref ? 'WHATSAPP' : 'COPY')
  const [to, setTo] = useState(channel === 'EMAIL' ? c.email || '' : channel === 'FACEBOOK' ? (c.facebook ? `m.me/${c.facebook}` : '') : channel === 'INSTAGRAM' ? c.instagram || '' : c.phone || '')
  const [days, setDays] = useState(String(s.terms?.valid_days || 30))
  const [aa, setAa] = useState(false), [method, setMethod] = useState('SHOP_TEXT'), [note, setNote] = useState(''), [name, setName] = useState(c.name || '')
  return <Sheet title="SEND" close={close}>
    <p className="text-xs text-gray-400 mb-3">Freezes revision {(s.revisions?.length || 0) + 1} and gives you the link and a ready text. The app sends nothing — you paste it.</p>
    {s.readiness?.length > 0 && <p className="text-xs text-red-300 mb-2">{s.readiness.join(' · ')}</p>}
    <label className="text-xs text-gray-400">Channel</label>
    <select value={channel} onChange={e => setChannel(e.target.value)} className={inp}>{['WHATSAPP', 'EMAIL', 'SMS', 'FACEBOOK', 'INSTAGRAM', 'COPY'].map(x => <option key={x}>{x}</option>)}</select>
    <label className="text-xs text-gray-400 mt-2 block">Sent to</label><input value={to} onChange={e => setTo(e.target.value)} className={inp} />
    <label className="text-xs text-gray-400 mt-2 block">Valid for (days)</label><input value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} className={inp} />
    <div className="text-xs text-gray-400 mt-2">{s.liveLink?.gate === 'CONTACT' || (s.money?.grand >= 25000 && (c.phone || c.email)) ? `identity gate: ${c.phone ? 'phone' : 'weak gate (e-mail)'}` : 'no identity gate'}</div>
    <label className="flex gap-2 items-center mt-3 text-sm"><input type="checkbox" checked={aa} onChange={e => setAa(e.target.checked)} /> Client already approved</label>
    {aa && <div className="mt-2 grid gap-2">
      <select value={method} onChange={e => setMethod(e.target.value)} className={inp}>{[['SHOP_TEXT', 'by text'], ['SHOP_PHONE', 'by phone'], ['SHOP_IN_PERSON', 'in person'], ['SHOP_EMAIL', 'by e-mail']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="who approved" className={inp} />
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (what he said, where)" className={inp} /></div>}
    <button onClick={async () => {
      const j = await act('send', { channel, sent_to: to, valid_days: Number(days) || 30, ...(aa ? { already_approved: { method, signer_name: name, note } } : {}) })
      if (j?.url) { setOut({ url: j.url, text: j.text }); try { await navigator.clipboard.writeText(j.text) } catch { } close() }
    }} className="mt-4 w-full min-h-[48px] rounded-lg bg-emerald-500 text-black font-bold">FREEZE & COPY TEXT</button>
  </Sheet>
}

function PlanSheet({ s, close, act }: { s: S; close: () => void; act: any }) {
  const [rows, setRows] = useState<S[]>(s.plan.map((p: S) => ({ ...p })))
  const [rails, setRails] = useState<string[]>(s.terms?.rails || [])
  const set = (i: number, k: string, v: any) => setRows(rows.map((r, j) => j === i ? { ...r, [k]: v } : r))
  const sum = rows.reduce((a, r) => a + (Number(r.pct) || 0), 0)
  return <Sheet title="PLAN & TERMS" close={close}>
    {rows.map((r, i) => <div key={i} className="grid grid-cols-6 gap-1 mb-2 text-xs">
      <select value={r.label_key} onChange={e => set(i, 'label_key', e.target.value)} className={inp + ' col-span-2'}>{['DEPOSIT', 'ARRIVAL', 'CONCLUSION', 'CUSTOM'].map(x => <option key={x}>{x}</option>)}</select>
      <input value={r.pct ?? ''} onChange={e => set(i, 'pct', e.target.value)} placeholder="%" className={inp} />
      <select value={r.due_rule} onChange={e => set(i, 'due_rule', e.target.value)} className={inp + ' col-span-2'}>{['ON_APPROVAL', 'ON_ARRIVAL', 'ON_CONCLUSION', 'DATE', 'NET_DAYS'].map(x => <option key={x}>{x}</option>)}</select>
      <select value={r.paid_to} onChange={e => set(i, 'paid_to', e.target.value)} className={inp}><option>GZ28US</option><option>GZ28BR</option></select>
      {r.due_rule === 'DATE' && <input type="date" value={r.due_date || ''} onChange={e => set(i, 'due_date', e.target.value)} className={inp + ' col-span-3'} />}
      {r.due_rule === 'NET_DAYS' && <input value={r.net_days ?? ''} onChange={e => set(i, 'net_days', e.target.value)} placeholder="net days" className={inp + ' col-span-3'} />}
    </div>)}
    <div className="flex gap-2 text-xs mb-3"><button onClick={() => setRows([...rows, { label_key: 'CUSTOM', pct: 0, due_rule: 'NET_DAYS', net_days: 30, paid_to: rows[0]?.paid_to || 'GZ28US' }])} className="px-2 py-1 bg-gray-800 rounded">+ row</button>
      {rows.length > 1 && <button onClick={() => setRows(rows.slice(0, -1))} className="px-2 py-1 bg-gray-800 rounded">− row</button>}
      <span className={Math.abs(sum - 100) < 0.001 ? 'text-emerald-400' : 'text-red-400'}>Σ {sum}%</span></div>
    <div className="text-xs text-gray-400 mb-1">Rails</div>
    <div className="flex gap-2 flex-wrap text-xs mb-3">{['card', 'us_bank_account', 'ZELLE', 'WIRE', 'PIX_BR'].map(r => <label key={r} className="flex gap-1 items-center"><input type="checkbox" checked={rails.includes(r)} onChange={e => setRails(e.target.checked ? [...rails, r] : rails.filter(x => x !== r))} />{r}</label>)}</div>
    <button onClick={async () => { if (await act('plan', { installments: rows, terms: { rails } })) close() }} className="w-full min-h-[44px] rounded-lg bg-white text-black font-bold">SAVE PLAN</button>
  </Sheet>
}

function ApproveSheet({ close, act, name }: { close: () => void; act: any; name: string }) {
  const [method, setMethod] = useState('SHOP_TEXT'), [n, setN] = useState(name), [note, setNote] = useState('')
  return <Sheet title="RECORD APPROVAL" close={close}>
    <select value={method} onChange={e => setMethod(e.target.value)} className={inp}>{[['SHOP_TEXT', 'by text'], ['SHOP_PHONE', 'by phone'], ['SHOP_IN_PERSON', 'in person'], ['SHOP_EMAIL', 'by e-mail']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    <input value={n} onChange={e => setN(e.target.value)} placeholder="who approved" className={inp + ' mt-2'} />
    <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (mandatory)" className={inp + ' mt-2'} />
    <button onClick={async () => { if (await act('approve-manual', { method, signer_name: n, note })) close() }} className="mt-3 w-full min-h-[44px] rounded-lg bg-white text-black font-bold">RECORD</button>
  </Sheet>
}

function DepositSheet({ s, close, act }: { s: S; close: () => void; act: any }) {
  const frozen: S[] = s.revisions?.find((r: S) => r.id === s.live?.id)?.installments || []
  const paid = s.stage?.paidBySeq || {}
  const due = frozen.find(p => !paid[p.seq])
  const openIncomes: S[] = (s.incomes || []).filter((i: S) => !i.paid_at && Number(i.amount) > 0)
  const [amount, setAmount] = useState(due ? String(due.amount_cents / 100) : openIncomes[0] ? String(openIncomes[0].amount) : '')
  const [source, setSource] = useState('ZELLE'), [paidTo, setPaidTo] = useState(due?.paid_to || 'GZ28US'), [brl, setBrl] = useState('')
  const [paidOn, setPaidOn] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()))
  const [ref, setRef] = useState(''), [incomeId, setIncomeId] = useState(openIncomes[0]?.id || '')
  const [method, setMethod] = useState('SHOP_TEXT'), [note, setNote] = useState('')
  const needsApproval = s.invoice.is_quote && !s.approvalOnLive
  return <Sheet title={s.invoice.is_quote ? 'RECORD DEPOSIT' : 'RECORD PAYMENT'} close={close}>
    {needsApproval && <div className="mb-3"><div className="text-xs text-amber-300 mb-1">How did the client approve?</div>
      <select value={method} onChange={e => setMethod(e.target.value)} className={inp}>{[['SHOP_TEXT', 'by text'], ['SHOP_PHONE', 'by phone'], ['SHOP_IN_PERSON', 'in person'], ['SHOP_EMAIL', 'by e-mail']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (mandatory)" className={inp + ' mt-2'} /></div>}
    {!s.live && !s.invoice.is_quote && openIncomes.length > 0 && <select value={incomeId} onChange={e => { setIncomeId(e.target.value); const i = openIncomes.find(x => x.id === e.target.value); if (i) setAmount(String(i.amount)) }} className={inp + ' mb-2'}>
      {openIncomes.map(i => <option key={i.id} value={i.id}>{i.description || 'income'} · {usd(i.amount)}</option>)}<option value="">+ new paid row</option></select>}
    <div className="grid grid-cols-2 gap-2">
      <select value={source} onChange={e => setSource(e.target.value)} className={inp}>{['ZELLE', 'WIRE', 'CASH', 'CHECK', 'PIX', 'OTHER'].map(x => <option key={x}>{x}</option>)}</select>
      <select value={paidTo} onChange={e => setPaidTo(e.target.value)} className={inp}><option>GZ28US</option><option>GZ28BR</option></select>
      <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="amount US$" className={inp} />
      <input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className={inp} />
      {paidTo === 'GZ28BR' && <input value={brl} onChange={e => setBrl(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="R$" className={inp} />}
      <input value={ref} onChange={e => setRef(e.target.value)} placeholder="confirmation #" className={inp} />
    </div>
    <button onClick={async () => {
      const j = await act('deposit-manual', { amount: Number(amount), source, paid_to: paidTo, amount_brl: brl ? Number(brl) : undefined, paid_on: paidOn, reference: ref || undefined,
        seq: due?.seq, income_id: !s.live && incomeId ? incomeId : undefined, ...(needsApproval ? { approval: { method, note, signer_name: s.client?.name } } : {}) })
      if (j) close()
    }} className="mt-4 w-full min-h-[48px] rounded-lg bg-emerald-500 text-black font-bold">CONFIRM</button>
  </Sheet>
}

function VoidSheet({ s, close, act }: { s: S; close: () => void; act: any }) {
  const [v, setV] = useState('')
  const num = String(s.invoice.invoice_code || '').match(/(\d{3})(?:\.\d+)?$/)?.[1] || ''
  return <Sheet title="VOID" close={close}>
    <p className="text-sm text-gray-300 mb-2">The public link stops working and any open payment session is closed. Type <b>{num}</b> to confirm.</p>
    <input value={v} onChange={e => setV(e.target.value)} className={inp} />
    <button disabled={v !== num} onClick={async () => { if (await act('void', { confirm: v })) close() }} className="mt-3 w-full min-h-[44px] rounded-lg bg-red-600 font-bold disabled:opacity-40">VOID</button>
  </Sheet>
}
