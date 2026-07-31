'use client'

import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { STREAM_STATUS_META, guessCarrier, carrierTrackUrl, type StreamRow, type StreamStatus } from '@/lib/stream'

// STREAM — the purchase follow-up board. One row per order: scanned purchases
// enroll themselves (the invoice editor asks after every scan), the row walks
// BOUGHT → SHIPPED → DELIVERED, and 17TRACK pushes the walk automatically once
// a tracking number is on the row.

type Chip = 'ALL' | StreamStatus
const CHIPS: Chip[] = ['ALL', 'BOUGHT', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']

type WhereInfo = { invoice_code: string; ride_name: string; ride_id: string | null }

function fmtD(d: string | null | undefined): string {
  if (!d) return '—'
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00')
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function StreamPage() {
  const [rows, setRows] = useState<StreamRow[]>([])
  const [where, setWhere] = useState<Record<string, WhereInfo>>({})
  const [loading, setLoading] = useState(true)
  const [chip, setChip] = useState<Chip>('ALL')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState<StreamRow | null>(null)
  const [editTracking, setEditTracking] = useState<{ id: string; value: string } | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ supplier: '', item: '', order_number: '', tracking_number: '' })
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void load()
    // Kick the mailbox watcher (throttled server-side): shipping emails from
    // gz28us@hotmail.com auto-fill tracking numbers on open rows.
    void fetch(`${BASE_PATH}/api/stream/mail-poll`, { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d?.updated > 0) { flash(`📬 ${d.updated} tracking${d.updated === 1 ? '' : 's'} captured from email`); void load() } })
      .catch(() => {})
  }, [])

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3000) }

  async function load() {
    // Only US purchases here — BR rows (app='BR', the PowerTrade pipeline) show
    // exclusively on the BR app's own /stream board.
    const { data } = await supabase.from('part_streams').select('*').eq('app', 'US').order('created_at', { ascending: false })
    const list = (data as StreamRow[]) || []
    setRows(list)
    const invIds = Array.from(new Set(list.map(r => r.invoice_id).filter((v): v is string => !!v)))
    if (invIds.length) {
      const { data: invs } = await supabase.from('invoices').select('id, invoice_code, ride_id').in('id', invIds)
      const rideIds = Array.from(new Set((invs || []).map(i => i.ride_id).filter(Boolean)))
      const { data: rides } = rideIds.length
        ? await supabase.from('rides').select('id, project_name').in('id', rideIds)
        : { data: [] as { id: string; project_name: string }[] }
      const rideName = new Map((rides || []).map(r => [r.id, r.project_name]))
      const map: Record<string, WhereInfo> = {}
      for (const i of invs || []) map[i.id] = { invoice_code: i.invoice_code, ride_name: rideName.get(i.ride_id) || '', ride_id: i.ride_id }
      setWhere(map)
    }
    setLoading(false)
  }

  const counts = useMemo(() => {
    // O quadro US só recebe linhas app='US' (3 status); os status BR existem no
    // tipo compartilhado, então o mapa cobre todos.
    const c: Record<Chip, number> = { ALL: rows.length, BOUGHT: 0, SHIPPED: 0, DELIVERED: 0, REPORTED_PT: 0, DELIVERED_BR: 0, CANCELLED: 0, REFUNDED: 0 } as Record<Chip, number>
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1
    return c
  }, [rows])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const today = todayYmd()
    // Most critical first: LATE (ETA passed, still moving) → BOUGHT (waiting
    // shipment) → SHIPPED (moving) → CANCELLED (money owed back) → DELIVERED →
    // REFUNDED (fully closed); newest first inside each.
    const rank = (r: StreamRow) => {
      if ((r.status === 'BOUGHT' || r.status === 'SHIPPED') && r.eta && r.eta < today) return 0
      return { BOUGHT: 1, SHIPPED: 2, CANCELLED: 3, DELIVERED: 4, REPORTED_PT: 5, DELIVERED_BR: 6, REFUNDED: 7 }[r.status]
    }
    return rows.filter(r => {
      if (chip !== 'ALL' && r.status !== chip) return false
      if (!q) return true
      const w = r.invoice_id ? where[r.invoice_id] : undefined
      return [r.item, r.supplier, r.order_number, r.tracking_number, r.carrier, w?.invoice_code, w?.ride_name]
        .some(v => (v || '').toLowerCase().includes(q))
    }).sort((a, b) => rank(a) - rank(b) || (a.created_at < b.created_at ? 1 : -1))
  }, [rows, chip, search, where])

  // Save a tracking number, then hand the row to the automation: 17TRACK
  // registration + SHIPPED flip + WhatsApp all happen server-side.
  async function saveTracking(id: string, raw: string) {
    const tracking = raw.trim()
    if (!tracking) { setEditTracking(null); return }
    setBusyId(id)
    const { error } = await supabase.from('part_streams')
      .update({ tracking_number: tracking, carrier: guessCarrier(tracking) })
      .eq('id', id)
    if (error) { alert(error.message); setBusyId(null); return }
    const r = await fetch(`${BASE_PATH}/api/stream/track`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'register' }),
    }).then(x => x.json()).catch(() => null)
    setEditTracking(null); setBusyId(null)
    flash(r?.ok ? '🚚 Tracking registered — follow-up is automatic now' : '🚚 Tracking saved')
    void load()
  }

  async function refreshRow(id: string) {
    setBusyId(id)
    const r = await fetch(`${BASE_PATH}/api/stream/track`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'refresh' }),
    }).then(x => x.json()).catch(() => null)
    setBusyId(null)
    if (r?.ok === false) flash(`⚠ ${r.reason || 'No update available'}`)
    void load()
  }

  // Manual DELIVERED — for pickups / carrier misses. Reports like the automatic path.
  async function markDelivered(row: StreamRow) {
    setBusyId(row.id)
    const { error } = await supabase.from('part_streams')
      .update({ status: 'DELIVERED', delivered_at: new Date().toISOString() })
      .eq('id', row.id)
    if (error) { alert(error.message); setBusyId(null); return }
    const w = row.invoice_id ? where[row.invoice_id] : undefined
    void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `✅ *STREAM — DELIVERED*\n${row.item}\n${[row.supplier, w?.invoice_code, w?.ride_name].filter(Boolean).join(' · ')}` }),
    }).catch(() => {})
    setBusyId(null)
    void load()
  }

  async function removeRow(id: string) {
    await supabase.from('part_streams').delete().eq('id', id)
    setConfirmRemove(null)
    void load()
  }

  // Order cancelled at the supplier: the row leaves the delivery ladder and the
  // mail watcher starts hunting the refund email (manual 💸 stays as fallback).
  async function cancelRow(row: StreamRow) {
    setBusyId(row.id)
    const { error } = await supabase.from('part_streams').update({
      status: 'CANCELLED',
      last_event: 'Order cancelled — watching the inbox for the refund',
      last_event_at: new Date().toISOString(),
    }).eq('id', row.id)
    setConfirmCancel(null)
    if (error) { alert(error.message); setBusyId(null); return }
    const w = row.invoice_id ? where[row.invoice_id] : undefined
    void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `🚫 *STREAM — ORDER CANCELLED*\n${row.item}\n${[row.supplier, w?.invoice_code, w?.ride_name].filter(Boolean).join(' · ')}\nWatching for the refund.` }),
    }).catch(() => {})
    setBusyId(null)
    void load()
  }

  // Manual REFUNDED — for refunds that arrive without an email the watcher can see.
  async function markRefunded(row: StreamRow) {
    setBusyId(row.id)
    const { error } = await supabase.from('part_streams').update({
      status: 'REFUNDED',
      last_event: 'Refund confirmed (manual)',
      last_event_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (error) { alert(error.message); setBusyId(null); return }
    const w = row.invoice_id ? where[row.invoice_id] : undefined
    void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `💸 *STREAM — REFUNDED*\n${row.item}\n${[row.supplier, w?.invoice_code, w?.ride_name].filter(Boolean).join(' · ')}` }),
    }).catch(() => {})
    setBusyId(null)
    void load()
  }

  async function addManual() {
    if (!addForm.item.trim()) { alert('Enter at least the item'); return }
    const tracking = addForm.tracking_number.trim()
    const { data, error } = await supabase.from('part_streams').insert([{
      supplier: addForm.supplier.trim() || null,
      item: addForm.item.trim(),
      order_number: addForm.order_number.trim() || null,
      tracking_number: tracking || null,
      carrier: tracking ? guessCarrier(tracking) : null,
      status: 'BOUGHT',
    }]).select('id').single()
    if (error) { alert(error.message); return }
    setShowAdd(false); setAddForm({ supplier: '', item: '', order_number: '', tracking_number: '' })
    if (tracking && data) {
      await fetch(`${BASE_PATH}/api/stream/track`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.id, action: 'register' }),
      }).catch(() => {})
    }
    void load()
  }

  const today = todayYmd()
  const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 rounded-2xl px-6 py-3 text-lg font-bold">{toast}</div>
      )}

      {confirmRemove && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove from STREAM</h2>
            <p className="text-gray-400 text-lg mb-8">Stop following this purchase? The invoice expense is not touched.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmRemove(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeRow(confirmRemove)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {confirmCancel && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-md w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">🚫 Order cancelled?</h2>
            <p className="text-gray-400 text-lg mb-2 break-words">{confirmCancel.item}</p>
            <p className="text-gray-400 text-lg mb-8">The row goes to CANCELLED and the system watches the inbox for the refund — it flips to REFUNDED automatically when the refund email lands. The invoice expense is not touched.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmCancel(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">BACK</button>
              <button onClick={() => cancelRow(confirmCancel)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCELLED</button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-lg w-full mx-4">
            <h2 className="text-2xl font-bold mb-6">📦 TRACK A PURCHASE</h2>
            <div className="space-y-4 mb-8">
              <div><label className="text-sm text-gray-400 font-bold">ITEM *</label><input value={addForm.item} onChange={e => setAddForm({ ...addForm, item: e.target.value })} className={inputClass} /></div>
              <div><label className="text-sm text-gray-400 font-bold">SUPPLIER</label><input value={addForm.supplier} onChange={e => setAddForm({ ...addForm, supplier: e.target.value })} className={inputClass} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-sm text-gray-400 font-bold">ORDER #</label><input value={addForm.order_number} onChange={e => setAddForm({ ...addForm, order_number: e.target.value })} className={inputClass} /></div>
                <div><label className="text-sm text-gray-400 font-bold">TRACKING #</label><input value={addForm.tracking_number} onChange={e => setAddForm({ ...addForm, tracking_number: e.target.value })} className={inputClass} /></div>
              </div>
            </div>
            <div className="flex gap-4">
              <button onClick={() => setShowAdd(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={addManual} className="flex-1 bg-green-700 hover:bg-green-600 px-5 py-4 rounded-2xl font-bold text-xl">ADD</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">STREAM ({rows.length})</h1>
        <div className="flex gap-3 flex-wrap items-center">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="SEARCH item, supplier, order, tracking…"
            className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-lg w-80"
          />
          <button onClick={() => setShowAdd(true)} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">+ ADD</button>
        </div>
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {CHIPS.map(c => (
          <button
            key={c}
            onClick={() => setChip(c)}
            className={`px-5 py-2 rounded-2xl font-bold text-sm border ${chip === c ? 'bg-white text-black border-white' : 'bg-gray-900 text-gray-300 border-gray-700 hover:border-gray-500'}`}
          >
            {c === 'ALL' ? 'ALL' : `${STREAM_STATUS_META[c].icon} ${c}`} ({counts[c]})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : visible.length === 0 ? (
        <div className="border border-gray-800 rounded-3xl bg-gray-900/40 px-8 py-16 text-center">
          <p className="text-5xl mb-4">📦</p>
          <p className="text-2xl font-bold mb-2">Nothing here yet</p>
          <p className="text-lg text-gray-400">Scan a purchase into an invoice — the system will ask to follow it here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map(r => {
            const meta = STREAM_STATUS_META[r.status]
            const w = r.invoice_id ? where[r.invoice_id] : undefined
            const late = (r.status === 'BOUGHT' || r.status === 'SHIPPED') && r.eta && r.eta < today
            const editing = editTracking?.id === r.id
            return (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`px-3 py-1 rounded-xl text-sm font-bold ${meta.cls}`}>{meta.icon} {meta.label}</span>
                      {late && <span className="px-3 py-1 rounded-xl text-sm font-bold bg-red-900 text-red-300">⚠ LATE — ETA was {fmtD(r.eta)}</span>}
                    </div>
                    <p className="text-xl font-bold mt-2 break-words">{r.item}</p>
                    <p className="text-gray-400 mt-0.5">
                      {[r.supplier, r.order_number ? `Order ${r.order_number}` : null].filter(Boolean).join(' · ') || '—'}
                      {w && (
                        <> · <a href={`${BASE_PATH}/rides/${w.ride_id}/invoices/edit/${r.invoice_id}`} className="text-blue-400 hover:underline">{w.invoice_code}{w.ride_name ? ` · ${w.ride_name}` : ''}</a></>
                      )}
                    </p>
                    <p className="text-gray-400 mt-1 text-sm">
                      {r.tracking_number ? (
                        <a href={carrierTrackUrl(r.carrier, r.tracking_number)} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                          {[r.carrier, r.tracking_number].filter(Boolean).join(' ')}
                        </a>
                      ) : 'No tracking yet'}
                      {r.eta && !late && <> · ETA <span className="text-gray-200 font-bold">{fmtD(r.eta)}</span></>}
                      {r.last_event && <> · {r.last_event}</>}
                    </p>
                    {r.ship_to && (
                      <p className={`mt-1 text-sm ${/11320|space\s*blvd/i.test(r.ship_to) ? 'text-gray-500' : 'text-red-400 font-bold'}`}>
                        📍 {r.ship_to}{/11320|space\s*blvd/i.test(r.ship_to) ? '' : ' — NOT the shop!'}
                      </p>
                    )}
                    <p className="text-gray-600 text-xs mt-1">
                      Bought {fmtD(r.created_at)}{r.shipped_at ? ` · Shipped ${fmtD(r.shipped_at)}` : ''}{r.delivered_at ? ` · Delivered ${fmtD(r.delivered_at)}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap items-center">
                    {editing ? (
                      <>
                        <input
                          autoFocus
                          value={editTracking.value}
                          onChange={e => setEditTracking({ id: r.id, value: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') void saveTracking(r.id, editTracking.value); if (e.key === 'Escape') setEditTracking(null) }}
                          placeholder="Paste tracking number"
                          className="bg-gray-800 border border-gray-600 rounded-xl px-4 py-2 text-lg w-64"
                        />
                        <button onClick={() => saveTracking(r.id, editTracking.value)} disabled={busyId === r.id} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold">SAVE</button>
                        <button onClick={() => setEditTracking(null)} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-xl font-bold">✕</button>
                      </>
                    ) : (
                      <>
                        {(r.status === 'BOUGHT' || r.status === 'SHIPPED') && (
                          <button onClick={() => setEditTracking({ id: r.id, value: r.tracking_number || '' })} className="bg-blue-800 hover:bg-blue-700 px-4 py-2 rounded-xl font-bold">
                            {r.tracking_number ? 'EDIT TRACKING' : '+ TRACKING'}
                          </button>
                        )}
                        {r.tracking_number && (r.status === 'BOUGHT' || r.status === 'SHIPPED') && (
                          <button onClick={() => refreshRow(r.id)} disabled={busyId === r.id} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold">{busyId === r.id ? '…' : '⟳ REFRESH'}</button>
                        )}
                        {r.status === 'SHIPPED' && (
                          <button onClick={() => markDelivered(r)} disabled={busyId === r.id} className="bg-green-800 hover:bg-green-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold">✓ DELIVERED</button>
                        )}
                        {(r.status === 'BOUGHT' || r.status === 'SHIPPED') && (
                          <button onClick={() => setConfirmCancel(r)} disabled={busyId === r.id} className="bg-red-900 hover:bg-red-800 disabled:opacity-40 px-4 py-2 rounded-xl font-bold">🚫 CANCELLED</button>
                        )}
                        {r.status === 'CANCELLED' && (
                          <button onClick={() => markRefunded(r)} disabled={busyId === r.id} className="bg-green-800 hover:bg-green-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold">💸 REFUNDED</button>
                        )}
                        <button onClick={() => setConfirmRemove(r.id)} className="bg-gray-800 hover:bg-red-900 px-4 py-2 rounded-xl font-bold text-gray-400">REMOVE</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
