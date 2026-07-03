'use client'

// Staff DUTIES — every duty across all invoices, grouped by the STAFF member who
// executes it. Duties are created on each invoice's DUTIES box; here they can be
// searched, filtered (TO DO / DONE) and toggled, with a link to the car's invoice.
import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

type Duty = {
  id: string
  staff_id: string | null
  description: string
  done: boolean
  priority: string
  invoice_id: string
  invoiceCode: string
  carLabel: string
  href: string
  // Time tracking: accumulated seconds + the running segment's start (null when
  // not running), plus the very first START and the final DONE timestamps.
  time_seconds: number
  time_started_at: string | null
  work_started_at: string | null
  work_ended_at: string | null
}

function fmtDur(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : m > 0 ? `${m}m ${ss}s` : `${ss}s`
}
function fmtDT(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// Priority: 1 (highest) → 4, then StandBy. Drives the row color and sort order.
const DUTY_PRIORITY_RANK: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, 'STANDBY': 4 }
const dutyPriorityBadge = (p: string) => (
  p === 'STANDBY' ? { label: 'STANDBY', cls: 'bg-gray-700 text-gray-300' }
  : p === '4' ? { label: 'P4', cls: 'bg-blue-900 text-blue-300' }
  : p === '3' ? { label: 'P3', cls: 'bg-yellow-900 text-yellow-300' }
  : p === '2' ? { label: 'P2', cls: 'bg-orange-900 text-orange-300' }
  : { label: 'P1', cls: 'bg-red-900 text-red-300' })
const dutyTextColor = (p: string) => (
  p === 'STANDBY' ? 'text-gray-400'
  : p === '4' ? 'text-blue-300'
  : p === '3' ? 'text-yellow-200'
  : p === '2' ? 'text-orange-300'
  : 'text-red-300')

export default function StaffDutiesPage() {
  const [staffList, setStaffList] = useState<{ id: string; name: string }[]>([])
  const [duties, setDuties] = useState<Duty[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'TODO' | 'DONE'>('TODO')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDuty, setEditingDuty] = useState<{ description: string; staff_id: string; priority: string }>({ description: '', staff_id: '', priority: '1' })
  // 1s ticker so running timers count live on screen.
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t) }, [])

  useEffect(() => { void load() }, [])

  async function load() {
    const [{ data: dutyRows }, { data: staffRows }] = await Promise.all([
      supabase.from('invoice_duties').select('*').order('created_at', { ascending: true }),
      supabase.from('staff').select('id, name').order('name'),
    ])
    const invoiceIds = [...new Set((dutyRows || []).map((d: any) => d.invoice_id).filter(Boolean))]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id').in('id', invoiceIds)
      invs = data || []
    }
    const invById = new Map<string, any>(); invs.forEach((i: any) => invById.set(i.id, i))
    const rideIds = [...new Set(invs.map((i: any) => i.ride_id).filter(Boolean))]
    let rides: any[] = []
    if (rideIds.length) {
      const { data } = await supabase.from('rides').select('id, project_code, project_name').in('id', rideIds)
      rides = data || []
    }
    const rideById = new Map<string, any>(); rides.forEach((r: any) => rideById.set(r.id, r))

    setDuties((dutyRows || []).map((d: any) => {
      const inv = invById.get(d.invoice_id)
      const ride = inv?.ride_id ? rideById.get(inv.ride_id) : null
      const carLabel = ride ? [ride.project_code, ride.project_name].filter(Boolean).join(' — ') : ''
      const ownerSeg = inv?.ride_id ? `rides/${inv.ride_id}` : `clients/${inv?.client_id}`
      return {
        id: d.id,
        staff_id: d.staff_id,
        description: d.description || '',
        done: !!d.done,
        priority: String(d.priority || '1'),
        invoice_id: d.invoice_id,
        invoiceCode: inv?.invoice_code || '—',
        carLabel,
        href: inv ? `/${ownerSeg}/invoices/edit/${inv.id}` : '#',
        time_seconds: Number(d.time_seconds) || 0,
        time_started_at: d.time_started_at || null,
        work_started_at: d.work_started_at || null,
        work_ended_at: d.work_ended_at || null,
      }
    }))
    setStaffList((staffRows || []) as { id: string; name: string }[])
    setLoading(false)
  }

  async function toggleDone(duty: Duty) {
    const { error } = await supabase.from('invoice_duties').update({ done: !duty.done }).eq('id', duty.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(d => d.id === duty.id ? { ...d, done: !d.done } : d))
  }

  function startEdit(d: Duty) { setEditingId(d.id); setEditingDuty({ description: d.description, staff_id: d.staff_id || '', priority: d.priority || '1' }) }
  async function saveEdit() {
    if (!editingId) return
    if (!editingDuty.description.trim()) { alert('Enter the duty description'); return }
    if (!editingDuty.staff_id) { alert('Pick the STAFF member who will execute it'); return }
    const { error } = await supabase.from('invoice_duties').update({ description: editingDuty.description.trim(), staff_id: editingDuty.staff_id, priority: editingDuty.priority }).eq('id', editingId)
    if (error) { alert(error.message); return }
    setDuties(duties.map(d => d.id === editingId ? { ...d, description: editingDuty.description.trim(), staff_id: editingDuty.staff_id, priority: editingDuty.priority } : d))
    setEditingId(null)
  }
  async function removeDuty(d: Duty) {
    const { error } = await supabase.from('invoice_duties').delete().eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.filter(x => x.id !== d.id))
  }

  // ── Time tracking ──────────────────────────────────────────────────────────
  // START begins (or resumes) the counter; starting a duty AUTO-PAUSES any other
  // duty the same staff member has running. PAUSE banks the elapsed segment.
  // DONE banks it, stamps the end time and marks the duty done.
  const segSeconds = (startedAt: string) => Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))

  async function startDuty(d: Duty) {
    const nowIso = new Date().toISOString()
    const othersRunning = duties.filter(x => x.id !== d.id && x.staff_id === d.staff_id && x.time_started_at)
    for (const r of othersRunning) {
      const secs = (Number(r.time_seconds) || 0) + segSeconds(r.time_started_at as string)
      const { error } = await supabase.from('invoice_duties').update({ time_seconds: secs, time_started_at: null }).eq('id', r.id)
      if (error) { alert(error.message); return }
    }
    const { error } = await supabase.from('invoice_duties').update({ time_started_at: nowIso, work_started_at: d.work_started_at || nowIso, work_ended_at: null }).eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(x => {
      if (x.id === d.id) return { ...x, time_started_at: nowIso, work_started_at: x.work_started_at || nowIso, work_ended_at: null }
      if (othersRunning.some(r => r.id === x.id) && x.time_started_at) return { ...x, time_seconds: (Number(x.time_seconds) || 0) + segSeconds(x.time_started_at), time_started_at: null }
      return x
    }))
  }

  async function pauseDuty(d: Duty) {
    if (!d.time_started_at) return
    const secs = (Number(d.time_seconds) || 0) + segSeconds(d.time_started_at)
    const { error } = await supabase.from('invoice_duties').update({ time_seconds: secs, time_started_at: null }).eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null } : x))
  }

  async function finishDuty(d: Duty) {
    const nowIso = new Date().toISOString()
    const secs = (Number(d.time_seconds) || 0) + (d.time_started_at ? segSeconds(d.time_started_at) : 0)
    const { error } = await supabase.from('invoice_duties').update({ time_seconds: secs, time_started_at: null, work_ended_at: nowIso, done: true }).eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null, work_ended_at: nowIso, done: true } : x))
  }

  const q = search.trim().toLowerCase()
  const visible = duties.filter(d =>
    (filter === 'ALL' || (filter === 'TODO' ? !d.done : d.done)) &&
    (!q || [d.description, d.carLabel, d.invoiceCode, staffNameOf(d.staff_id)].some(v => (v || '').toLowerCase().includes(q))))

  function staffNameOf(id: string | null): string {
    return staffList.find(s => s.id === id)?.name || 'Unassigned'
  }

  // Group by staff, staff order = staff table order (by name); Unassigned last.
  // Within each member the duties are sorted by priority (1 → 4 → StandBy).
  const byPriority = (a: Duty, b: Duty) => (DUTY_PRIORITY_RANK[a.priority] ?? 0) - (DUTY_PRIORITY_RANK[b.priority] ?? 0)
  const groups: { key: string; name: string; rows: Duty[] }[] = []
  for (const s of staffList) {
    const rows = visible.filter(d => d.staff_id === s.id).sort(byPriority)
    if (rows.length) groups.push({ key: s.id, name: s.name, rows })
  }
  const unassigned = visible.filter(d => !d.staff_id || !staffList.some(s => s.id === d.staff_id)).sort(byPriority)
  if (unassigned.length) groups.push({ key: 'none', name: 'Unassigned', rows: unassigned })

  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`
  const openCount = duties.filter(d => !d.done).length
  const dutySuggestions = [...new Set(duties.map(d => d.description.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const inputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center gap-4 mb-2 flex-wrap">
        <h1 className="text-4xl font-bold">Staff DUTIES</h1>
        <input
          type="text"
          placeholder="Search duty, car, staff..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[16rem] max-w-xl bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
        />
      </div>
      <div className="flex gap-2 flex-wrap mb-6">
        {(['TODO', 'DONE', 'ALL'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={chip(filter === f)}>{f === 'TODO' ? 'TO DO' : f}</button>
        ))}
        <span className="self-center text-gray-400 text-sm font-bold ml-2">{openCount} open in total</span>
      </div>
      <datalist id="duty-options">{dutySuggestions.map(d => <option key={d} value={d} />)}</datalist>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : groups.length === 0 ? (
        <p className="text-2xl text-gray-400">No duties{filter !== 'ALL' ? ' in this filter' : ' yet — add them on each invoice’s DUTIES box'}.</p>
      ) : (
        <div className="space-y-6 max-w-4xl">
          {groups.map(g => (
            <div key={g.key} className="bg-gray-900 border border-gray-700 rounded-3xl p-5">
              <div className="flex justify-between items-baseline border-b border-gray-700 pb-2 mb-2">
                <h2 className="text-2xl font-bold text-purple-300">👤 {g.name}</h2>
                <p className="text-sm font-bold text-gray-400">{g.rows.filter(r => !r.done).length} TO DO · {g.rows.filter(r => r.done).length} DONE</p>
              </div>
              {g.rows.map((d, i) => (
                <div key={d.id} className={i < g.rows.length - 1 ? 'border-b border-gray-800/60' : ''}>
                  {editingId === d.id ? (
                    <div className="p-4 my-2 space-y-3 bg-gray-800 border-l-4 border-blue-600 rounded-2xl">
                      <input type="text" list="duty-options" value={editingDuty.description} onChange={(e) => setEditingDuty({ ...editingDuty, description: e.target.value })} className={`${inputClass} w-full`} />
                      <div className="flex gap-3 flex-wrap">
                        <select value={editingDuty.staff_id} onChange={(e) => setEditingDuty({ ...editingDuty, staff_id: e.target.value })} className={`${inputClass} flex-1 min-w-[12rem]`}>
                          <option value="">— STAFF —</option>
                          {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <select value={editingDuty.priority} onChange={(e) => setEditingDuty({ ...editingDuty, priority: e.target.value })} className={inputClass}>
                          <option value="1">Priority 1</option>
                          <option value="2">Priority 2</option>
                          <option value="3">Priority 3</option>
                          <option value="4">Priority 4</option>
                          <option value="STANDBY">StandBy</option>
                        </select>
                      </div>
                      <div className="flex gap-3">
                        <button onClick={saveEdit} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                        <button onClick={() => setEditingId(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${dutyPriorityBadge(d.priority).cls}`}>{dutyPriorityBadge(d.priority).label}</span>
                          <p className={`text-base font-bold truncate ${d.done ? 'text-green-400 line-through' : dutyTextColor(d.priority)}`} title={d.description}>{d.description}</p>
                        </div>
                        <p className="text-sm text-gray-400">
                          <a href={`${BASE_PATH}${d.href}`} className="text-gray-500 hover:text-blue-400 hover:underline">{d.invoiceCode}</a>
                          {d.carLabel ? ` · ${d.carLabel}` : ''}
                        </p>
                        {(d.time_started_at || d.time_seconds > 0 || d.work_started_at) && (
                          <p className="text-sm">
                            <span className={d.time_started_at ? 'text-amber-400 font-bold' : 'text-gray-400 font-bold'}>
                              ⏱ {fmtDur((Number(d.time_seconds) || 0) + (d.time_started_at ? (Date.now() - new Date(d.time_started_at).getTime()) / 1000 : 0))}
                              {d.time_started_at ? ' · running' : d.done ? '' : ' · paused'}
                            </span>
                            {d.work_started_at && <span className="text-gray-500"> · {fmtDT(d.work_started_at)}{d.work_ended_at ? ` → ${fmtDT(d.work_ended_at)}` : ''}</span>}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0 flex-wrap justify-end">
                        {!d.done && !d.time_started_at && (
                          <button onClick={() => startDuty(d)} className="bg-emerald-700 hover:bg-emerald-600 px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap">▶ START</button>
                        )}
                        {d.time_started_at ? (
                          <>
                            <button onClick={() => pauseDuty(d)} className="bg-amber-600 hover:bg-amber-500 text-black px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap">⏸ PAUSE</button>
                            <button onClick={() => finishDuty(d)} className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap">✅ DONE</button>
                          </>
                        ) : (
                          <button onClick={() => toggleDone(d)} className={`px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap ${d.done ? 'bg-green-700 hover:bg-green-600' : 'bg-yellow-700 hover:bg-yellow-600'}`}>{d.done ? 'DONE' : 'TO DO'}</button>
                        )}
                        <button onClick={() => startEdit(d)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                        <button onClick={() => removeDuty(d)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
