'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// QUOTE PORTAL M3 (06/11/2026) — the full tabs of /ca/doc/<id>: ITEMS · SERVICES · EXPENSES · NOTES · DUTIES, and the STATUS ▾ sheet
// with the CLOSE checklist. Immediate writes, one row per tap, through /api/doc/<id>/<action> (the `act` prop). Lines frozen in the
// sent revision come greyed ("sent rev n — change order"); the DB lock is the real guard. EXPENSES is read-only here: its engine
// (scan born PAID, DB import, FROM STOCK, placeholders, tracking, receipts to Dropbox) stays in the editor until it is extracted.
import { useState } from 'react'
import Link from 'next/link'
import { fmtDay } from '@/lib/orlando'

type S = Record<string, any>
type Act = (action: string, body?: Record<string, unknown>) => Promise<any>
const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inp = 'bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm'
const btn = 'px-3 py-1.5 rounded text-xs font-semibold'

export type TabKey = 'ITEMS' | 'SERVICES' | 'EXPENSES' | 'NOTES' | 'DUTIES'
export const TAB_KEYS: TabKey[] = ['ITEMS', 'SERVICES', 'EXPENSES', 'NOTES', 'DUTIES']
export function tabLabel(k: TabKey, t: S) {
  if (k === 'ITEMS') return `ITEMS ${t.items.filter((i: S) => i.counts).length}`
  if (k === 'SERVICES') return `SERVICES ${t.services.length}`
  if (k === 'EXPENSES') return `EXPENSES ${t.expenses.length}`
  if (k === 'NOTES') return `NOTES ${t.notes.length}`
  return `DUTIES ${t.duties.filter((d: S) => !d.done).length}/${t.duties.length}`
}

function LockNote({ seq }: { seq?: number }) { return <span className="text-[10px] text-gray-500">🔒 sent rev {seq} — change order</span> }

function Row({ locked, children }: { locked?: boolean; children: React.ReactNode }) {
  return <div className={`py-2 border-b border-gray-900 ${locked ? 'opacity-60' : ''}`}>{children}</div>
}

export function DocTab({ k, s, act, blocked, editorUrl }: { k: TabKey; s: S; act: Act; blocked: boolean; editorUrl: string }) {
  const t = s.tabs, seq = s.live?.seq
  const [edit, setEdit] = useState<string | null>(null)
  const [f, setF] = useState<S>({})
  const go = async (a: string, body: S) => { const r = await act(a, body); if (r) { setEdit(null); setF({}) } return r }
  const ro = blocked
  const footer = <Link href={editorUrl} className="inline-block mt-3 text-xs underline text-gray-400">EDIT IN EDITOR → (re-price, TARGET total, kits, expense engine)</Link>

  if (k === 'ITEMS') return <div className="text-sm">
    {t.items.map((i: S) => <Row key={i.id} locked={i.locked || !i.counts}>
      {edit === i.id ? <div className="flex flex-wrap gap-2 items-center">
        <input className={inp + ' flex-1 min-w-[12rem]'} defaultValue={i.description} onChange={e => setF({ ...f, description: e.target.value })} />
        <input className={inp + ' w-16'} inputMode="decimal" defaultValue={i.quantity} onChange={e => setF({ ...f, quantity: e.target.value })} />
        <input className={inp + ' w-28'} inputMode="decimal" defaultValue={i.unit_price} onChange={e => setF({ ...f, unit_price: e.target.value })} />
        <button className={btn + ' bg-white text-black'} onClick={() => go('item-save', { item_id: i.id, ...f })}>SAVE</button>
        <button className={btn + ' bg-red-900'} onClick={() => confirm('Remove this line?') && go('item-del', { item_id: i.id })}>REMOVE</button>
        <button className={btn + ' bg-gray-800'} onClick={() => { setEdit(null); setF({}) }}>CANCEL</button>
      </div> : <div className="flex justify-between gap-3">
        <span>{i.kit_name ? <span className="text-gray-500">[{i.kit_name}] </span> : null}{i.description}{i.quantity != 1 ? ` × ${i.quantity}` : ''}{i.cancel_status ? <span className="text-red-300"> · {i.cancel_status}</span> : null}
          {i.locked && <> <LockNote seq={seq} /></>}{i.mirror && <span className="text-[10px] text-gray-500"> · from expense</span>}</span>
        <span className="shrink-0">{usd(i.total)}{!ro && !i.locked && !i.mirror && <button className="ml-2 text-xs underline text-gray-400" onClick={() => { setEdit(i.id); setF({}) }}>edit</button>}</span>
      </div>}
    </Row>)}
    {!ro && <AddLine fields={[['description', 'new item', 'flex-1 min-w-[12rem]'], ['quantity', 'qty', 'w-16'], ['unit_price', 'price', 'w-28']]} onAdd={b => act('item-add', b)} />}
    <div className="mt-2 text-xs text-gray-400">ITEMS total {usd(s.money?.parts)}</div>{footer}
  </div>

  if (k === 'SERVICES') return <div className="text-sm">
    {t.services.map((v: S) => <Row key={v.id} locked={v.locked}>
      {edit === v.id ? <div className="flex flex-wrap gap-2 items-center">
        <input className={inp + ' flex-1 min-w-[12rem]'} defaultValue={v.description} onChange={e => setF({ ...f, description: e.target.value })} />
        <input className={inp + ' w-28'} inputMode="decimal" defaultValue={v.price} onChange={e => setF({ ...f, price: e.target.value })} />
        <button className={btn + ' bg-white text-black'} onClick={() => go('service-save', { service_id: v.id, ...f })}>SAVE</button>
        <button className={btn + ' bg-red-900'} onClick={() => confirm('Remove this service?') && go('service-del', { service_id: v.id })}>REMOVE</button>
        <button className={btn + ' bg-gray-800'} onClick={() => { setEdit(null); setF({}) }}>CANCEL</button>
      </div> : <div className="flex justify-between gap-3"><span>{v.description}{v.locked && <> <LockNote seq={seq} /></>}</span>
        <span className="shrink-0">{usd(v.price)}{!ro && !v.locked && <button className="ml-2 text-xs underline text-gray-400" onClick={() => { setEdit(v.id); setF({}) }}>edit</button>}</span></div>}
    </Row>)}
    {!ro && <AddLine fields={[['description', 'new service', 'flex-1 min-w-[12rem]'], ['price', 'price', 'w-28']]} onAdd={b => act('service-add', b)} />}
    <div className="mt-2 text-xs text-gray-400">SERVICES total {usd(s.money?.services)}</div>{footer}
  </div>

  if (k === 'EXPENSES') {
    const paid = t.expenses.filter((e: S) => e.paid && !e.cancel_status), fore = t.expenses.filter((e: S) => !e.paid && !e.cancel_status)
    return <div className="text-sm">
      {s.stage?.sub === 'CLEARING' && <div className="mb-2 text-xs bg-amber-950 border border-amber-800 text-amber-200 rounded p-2">Deposit clearing — hold orders until it lands.</div>}
      {t.expenses.map((e: S) => <Row key={e.id} locked={!!e.cancel_status}>
        <div className="flex justify-between gap-3"><span>{e.item}{e.supplier ? <span className="text-gray-500"> · {e.supplier}</span> : null}{e.nature ? <span className="text-gray-500"> · {e.nature}</span> : null}
          {e.cancel_status ? <span className="text-red-300"> · {e.cancel_status}</span> : null}</span>
          <span className={`shrink-0 ${e.paid ? 'text-emerald-400' : 'text-gray-300'}`}>{usd(e.total)} {e.paid ? `✓ ${fmtDay(String(e.payment_date).slice(0, 10))}` : 'forecast'}</span></div>
      </Row>)}
      <div className="mt-2 text-xs text-gray-400">paid {usd(paid.reduce((a: number, e: S) => a + e.total, 0))} · forecast {usd(fore.reduce((a: number, e: S) => a + e.total, 0))}</div>
      <Link href={editorUrl} className="inline-block mt-3 px-3 py-2 rounded bg-white text-black font-semibold text-xs">EXPENSES IN THE EDITOR → (scan, import, stock, tracking)</Link>
    </div>
  }

  if (k === 'NOTES') return <div className="text-sm">
    {t.notes.map((n: S) => <Row key={n.id}>
      {edit === n.id ? <div className="flex flex-col gap-2">
        <textarea className={inp} rows={3} defaultValue={n.note} onChange={e => setF({ ...f, note: e.target.value })} />
        <div className="flex gap-2">
          <button className={btn + ' bg-white text-black'} onClick={() => go('note-save', { note_id: n.id, ...f })}>SAVE</button>
          <button className={btn + ' bg-red-900'} onClick={() => confirm('Remove this note?') && go('note-del', { note_id: n.id })}>REMOVE</button>
          <button className={btn + ' bg-gray-800'} onClick={() => { setEdit(null); setF({}) }}>CANCEL</button></div>
      </div> : <div className="flex justify-between gap-3"><span className="whitespace-pre-wrap">{n.note}</span>
        <span className="shrink-0 text-xs">{!ro ? <button className={`underline ${n.client_visible ? 'text-sky-300' : 'text-gray-500'}`} onClick={() => act('note-save', { note_id: n.id, client_visible: !n.client_visible })}>{n.client_visible ? 'client sees' : 'internal'}</button>
          : <span className="text-gray-500">{n.client_visible ? 'client sees' : 'internal'}</span>}
          {!ro && <button className="ml-2 underline text-gray-400" onClick={() => { setEdit(n.id); setF({}) }}>edit</button>}</span></div>}
    </Row>)}
    {!ro && <NoteAdd act={act} />}
    <div className="mt-2 text-[11px] text-gray-500">«client sees» notes print on the quote / PDF the client gets (frozen at SEND).</div>
  </div>

  // DUTIES
  const name = (id: string | null) => t.staff.find((x: S) => x.id === id)?.name || 'unassigned'
  return <div className="text-sm">
    {t.duties.map((d: S) => <Row key={d.id}>
      {edit === d.id ? <div className="flex flex-wrap gap-2 items-center">
        <input className={inp + ' flex-1 min-w-[12rem]'} defaultValue={d.description} onChange={e => setF({ ...f, description: e.target.value })} />
        <select className={inp} defaultValue={d.staff_id || ''} onChange={e => setF({ ...f, staff_id: e.target.value })}><option value="">unassigned</option>{t.staff.map((x: S) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select className={inp} defaultValue={d.priority} onChange={e => setF({ ...f, priority: e.target.value })}>{['1', '2', '3', '4', '5'].map(p => <option key={p} value={p}>P{p}</option>)}</select>
        <button className={btn + ' bg-white text-black'} onClick={() => go('duty-save', { duty_id: d.id, ...f })}>SAVE</button>
        <button className={btn + ' bg-red-900'} onClick={() => confirm('Remove this duty?') && go('duty-del', { duty_id: d.id })}>REMOVE</button>
        <button className={btn + ' bg-gray-800'} onClick={() => { setEdit(null); setF({}) }}>CANCEL</button>
      </div> : <div className="flex justify-between gap-3 items-start">
        <label className="flex gap-2 items-start"><input type="checkbox" className="mt-1" checked={!!d.done} disabled={ro} onChange={() => act('duty-toggle', { duty_id: d.id })} />
          <span className={d.done ? 'line-through text-gray-500' : ''}>P{d.priority} · {d.description} <span className="text-gray-500">· {name(d.staff_id)}</span></span></label>
        {!ro && <button className="text-xs underline text-gray-400 shrink-0" onClick={() => { setEdit(d.id); setF({}) }}>edit</button>}</div>}
    </Row>)}
    {!ro && <DutyAdd act={act} staff={t.staff} />}
    <Link href="/duties" className="inline-block mt-3 text-xs underline text-gray-400">STAFF DUTIES board →</Link>
  </div>
}

function AddLine({ fields, onAdd }: { fields: [string, string, string][]; onAdd: (b: S) => Promise<any> }) {
  const [v, setV] = useState<S>({}), [n, setN] = useState(0)
  return <div key={n} className="flex flex-wrap gap-2 items-center mt-3">
    {fields.map(([k, ph, w]) => <input key={k} className={inp + ' ' + w} placeholder={ph} inputMode={k === 'description' ? undefined : 'decimal'} onChange={e => setV({ ...v, [k]: e.target.value })} />)}
    <button className={btn + ' bg-emerald-500 text-black'} onClick={async () => { if (await onAdd(v)) { setV({}); setN(n + 1) } }}>+ ADD</button>
  </div>
}
function NoteAdd({ act }: { act: Act }) {
  const [v, setV] = useState(''), [vis, setVis] = useState(true)
  return <div className="flex flex-col gap-2 mt-3">
    <textarea className={inp} rows={2} placeholder="new note" value={v} onChange={e => setV(e.target.value)} />
    <div className="flex gap-3 items-center text-xs"><label className="flex gap-1 items-center"><input type="checkbox" checked={vis} onChange={e => setVis(e.target.checked)} /> client sees</label>
      <button className={btn + ' bg-emerald-500 text-black'} onClick={async () => { if (await act('note-add', { note: v, client_visible: vis })) setV('') }}>+ ADD NOTE</button></div>
  </div>
}
function DutyAdd({ act, staff }: { act: Act; staff: S[] }) {
  const [v, setV] = useState<S>({ priority: '1' }), [n, setN] = useState(0)
  return <div key={n} className="flex flex-wrap gap-2 items-center mt-3">
    <input className={inp + ' flex-1 min-w-[12rem]'} placeholder="new duty" onChange={e => setV({ ...v, description: e.target.value })} />
    <select className={inp} onChange={e => setV({ ...v, staff_id: e.target.value })}><option value="">unassigned</option>{staff.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
    <select className={inp} defaultValue="1" onChange={e => setV({ ...v, priority: e.target.value })}>{['1', '2', '3', '4', '5'].map(p => <option key={p} value={p}>P{p}</option>)}</select>
    <input className={inp + ' w-20'} placeholder="min" inputMode="numeric" onChange={e => setV({ ...v, estimated_minutes: e.target.value })} />
    <button className={btn + ' bg-emerald-500 text-black'} onClick={async () => { if (await act('duty-add', v)) { setV({ priority: '1' }); setN(n + 1) } }}>+ ADD</button>
  </div>
}

// STATUS ▾ — the C-18 gate as a checklist (§6.4): ONLINE ⇄ CLOSED, never a silent demotion.
export function StatusSheet({ s, act, close }: { s: S; act: Act; close: () => void }) {
  const c = s.tabs?.close, cur = s.invoice.live_status || 'INCOMPLETE'
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={close}>
    <div className="bg-gray-950 border border-gray-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md p-4" onClick={e => e.stopPropagation()}>
      <div className="flex justify-between items-center mb-3"><h2 className="font-bold">STATUS · now {cur === 'REALTIME' ? 'ONLINE' : cur}</h2><button onClick={close} className="text-gray-400">✕</button></div>
      {c && <div className="text-sm space-y-1">
        {c.items.map((i: S) => <div key={i.key} className={i.ok ? 'text-emerald-400' : 'text-red-300'}>{i.ok ? '✓' : '✖'} {i.label}{i.fix ? <div className="text-xs text-gray-400 ml-5">{i.fix}</div> : null}</div>)}
        {c.planUnpaid.length > 0 && <div className="text-red-400 text-xs mt-2">plan rows unpaid: {c.planUnpaid.map((p: S) => `${p.seq} ${p.label}`).join(' · ')} (A/R — does not block CLOSED)</div>}
      </div>}
      <div className="flex gap-2 mt-4">
        {cur !== 'REALTIME' && cur !== 'CLOSED' && <button className="flex-1 min-h-[44px] rounded bg-blue-700 font-bold" onClick={async () => { if (await act('status', { to: 'REALTIME' })) close() }}>SET ONLINE</button>}
        {cur !== 'CLOSED' && <button disabled={!c?.ok} className="flex-1 min-h-[44px] rounded bg-emerald-600 text-black font-bold disabled:opacity-40" onClick={async () => { if (await act('status', { to: 'CLOSED' })) close() }}>CLOSE</button>}
        {cur === 'CLOSED' && <button className="flex-1 min-h-[44px] rounded bg-gray-800 font-bold" onClick={async () => { if (confirm('Re-open this CLOSED invoice to ONLINE?') && await act('status', { to: 'REALTIME', reopen: true })) close() }}>RE-OPEN (ONLINE)</button>}
      </div>
    </div>
  </div>
}
