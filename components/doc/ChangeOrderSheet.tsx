'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// QUOTE PORTAL M4 (06/11/2026) — the CHANGE ORDER sheet of /ca/doc/<id>. The signed lines with the staff's proposal (new price / qty /
// remove); lines inserted after the signature come in by themselves. PREVIEW shows the delta, the new plan (the last unpaid installment
// absorbs) and whether the change is inside the Fla. §559.909 band (staff may RECORD APPROVAL) or above it (the client approves on the
// link). FREEZE writes revision n+1 kind CHANGE_ORDER — nothing is sent; COPY LINK and paste it to the client yourself.
import { useState } from 'react'

type S = Record<string, any>
const usd = (n: number) => 'US$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inp = 'bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm'

export function ChangeOrderSheet({ s, act, close }: { s: S; act: (a: string, b?: Record<string, unknown>) => Promise<any>; close: () => void }) {
  const base: S[] = s.coBase?.lines || []
  const [ed, setEd] = useState<Record<string, S>>({})
  const [days, setDays] = useState(15)
  const [pv, setPv] = useState<S | null>(null)
  const set = (id: string, k: string, v: unknown) => { setPv(null); setEd(p => ({ ...p, [id]: { ...(p[id] || {}), [k]: v } })) }
  const edits = () => {
    const items: S[] = [], services: S[] = []
    for (const l of base) {
      const e = ed[l.id]; if (!e) continue
      const row: S = { id: l.id }
      if (e.remove) row.remove = true
      if (l.kind === 'item') { if (e.unit_price !== undefined && e.unit_price !== '') row.unit_price = Number(e.unit_price); if (e.quantity !== undefined && e.quantity !== '') row.quantity = Number(e.quantity) }
      else if (e.unit_price !== undefined && e.unit_price !== '') row.price = Number(e.unit_price)
      if (Object.keys(row).length > 1) (l.kind === 'item' ? items : services).push(row)
    }
    return { items, services }
  }
  const preview = async () => { const r = await act('change-order', { edits: edits(), valid_days: days, preview: true }); if (r) setPv(r) }
  const freeze = async () => { const r = await act('change-order', { edits: edits(), valid_days: days }); if (r) close() }
  const d = pv?.delta
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center" onClick={close}>
    <div className="bg-gray-950 border border-gray-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg p-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
      <div className="flex justify-between items-center mb-2"><h2 className="font-bold">+ CHANGE ORDER (on signed rev {s.coBase?.seq})</h2><button onClick={close} className="text-gray-400">✕</button></div>
      <p className="text-xs text-gray-400 mb-3">Lines added after the signature are included automatically. Change a signed line below, or remove it.</p>
      {base.map(l => { const e = ed[l.id] || {}; return <div key={l.id} className={`py-2 border-b border-gray-900 text-sm ${e.remove ? 'opacity-40' : ''}`}>
        <div className="flex justify-between gap-2"><span>{l.description}</span><span className="text-gray-400 shrink-0">{usd(l.total)}</span></div>
        <div className="flex gap-2 items-center mt-1 text-xs">
          {l.kind === 'item' && <input className={inp + ' w-16'} inputMode="decimal" placeholder={String(l.quantity)} value={e.quantity ?? ''} onChange={x => set(l.id, 'quantity', x.target.value)} />}
          <input className={inp + ' w-28'} inputMode="decimal" placeholder={String(l.unit_price)} value={e.unit_price ?? ''} onChange={x => set(l.id, 'unit_price', x.target.value)} />
          <label className="flex gap-1 items-center"><input type="checkbox" checked={!!e.remove} onChange={x => set(l.id, 'remove', x.target.checked)} /> remove</label>
        </div></div> })}
      <div className="flex gap-2 items-center mt-3 text-xs text-gray-400">client has
        {[7, 15, 30].map(n => <button key={n} onClick={() => setDays(n)} className={`px-2 py-1 rounded ${days === n ? 'bg-white text-black' : 'bg-gray-800'}`}>{n} d</button>)} to approve</div>
      {d && <div className="mt-3 text-sm bg-gray-900 border border-gray-800 rounded p-2">
        {d.added.map((l: S) => <div key={'a' + l.id} className="text-emerald-300">+ {l.description} · {usd(l.total)}</div>)}
        {d.removed.map((l: S) => <div key={'r' + l.id} className="text-red-300">− {l.description} · {usd(l.total)}</div>)}
        {d.changed.map((l: S) => <div key={'c' + l.id} className="text-amber-300">~ {l.after.description} · {usd(l.before.total)} → {usd(l.after.total)}</div>)}
        <div className="font-semibold mt-1">total {usd(d.grand_before)} → {usd(d.grand_after)} ({d.diff >= 0 ? '+' : ''}{usd(d.diff)})</div>
        <div className="text-xs text-gray-400 mt-1">{pv.installments.map((i: S) => `${i.seq} ${i.label} ${usd(i.amount_cents / 100)}${i.paid ? ' ✓' : ''}`).join(' · ')}</div>
        <div className={`text-xs mt-1 ${pv.band.staffMayRecord ? 'text-emerald-300' : 'text-amber-300'}`}>{pv.band.staffMayRecord
          ? `inside the §559.909 band (+${usd(pv.band.increase)} ≤ ${usd(pv.band.band)}) — you may RECORD APPROVAL after FREEZE, or the client approves on the link`
          : `above the §559.909 band (+${usd(pv.band.increase)} > ${usd(pv.band.band)}) — the client approves on the link`}</div>
        {pv.problems?.length > 0 && <div className="text-xs text-red-300 mt-1">{pv.problems.join(' · ')}</div>}
      </div>}
      <div className="flex gap-2 mt-4">
        <button onClick={preview} className="flex-1 min-h-[44px] rounded bg-gray-800 font-semibold">PREVIEW</button>
        <button disabled={!pv || pv.problems?.length > 0} onClick={freeze} className="flex-1 min-h-[44px] rounded bg-emerald-500 text-black font-bold disabled:opacity-40">FREEZE CHANGE ORDER</button>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">Nothing is sent. After FREEZE, COPY LINK and paste it to the client yourself.</p>
    </div>
  </div>
}
