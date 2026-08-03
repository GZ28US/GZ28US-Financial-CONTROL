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
  // Invoice DELIVERY DATE with no CONCLUSION DATE = the PROMISED TO date —
  // carried on every duties report and update.
  promised: string | null
}
function fmtPromised(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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

// Ordering rule: PRIORITY first (P1 → StandBy); WITHIN the same priority, every duty of
// the SAME CAR stays together (grouped by carLabel), then by description for a stable
// order. So on a P1 (urgent) band, all of one car's duties show back-to-back.
function dutyOrder(a: { priority: string; carLabel: string; description: string }, b: { priority: string; carLabel: string; description: string }): number {
  const pr = (DUTY_PRIORITY_RANK[a.priority] ?? 0) - (DUTY_PRIORITY_RANK[b.priority] ?? 0)
  if (pr !== 0) return pr
  const car = (a.carLabel || '').localeCompare(b.carLabel || '')
  if (car !== 0) return car
  return (a.description || '').localeCompare(b.description || '')
}
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
  const [staffList, setStaffList] = useState<{ id: string; name: string; phone: string | null }[]>([])
  const [duties, setDuties] = useState<Duty[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'TODO' | 'DONE'>('TODO')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDuty, setEditingDuty] = useState<{ order: string; description: string; staff_id: string; priority: string }>({ order: '', description: '', staff_id: '', priority: '1' })
  // SEND WHATSAPP popups: the per-member duties-list send (asks up to which
  // priority) and the START/PAUSE/DONE notification. Every duties message goes
  // ONLY to the staff group, with the member @marked in the text.
  const [listPopup, setListPopup] = useState<{ staffId: string; name: string; maxPriority: string } | null>(null)
  const [notifyPopup, setNotifyPopup] = useState<{ title: string; body: string } | null>(null)
  const [sendingWa, setSendingWa] = useState(false)
  // Member groups start COLLAPSED; the user opens the one they want.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (key: string) => setOpenGroups(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  // 1s ticker so running timers count live on screen.
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t) }, [])

  useEffect(() => { void load() }, [])

  async function load() {
    const [{ data: dutyRows }, { data: staffRows }] = await Promise.all([
      supabase.from('invoice_duties').select('*').order('created_at', { ascending: true }),
      supabase.from('staff').select('id, name, phone').order('name'),
    ])
    const invoiceIds = [...new Set((dutyRows || []).map((d: any) => d.invoice_id).filter(Boolean))]
    let invs: any[] = []
    if (invoiceIds.length) {
      const { data } = await supabase.from('invoices').select('id, invoice_code, ride_id, client_id, delivery_date, conclusion_date').in('id', invoiceIds)
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
        promised: inv?.delivery_date && !inv?.conclusion_date ? inv.delivery_date : null,
      }
    }))
    setStaffList((staffRows || []) as { id: string; name: string; phone: string | null }[])
    setLoading(false)
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  // Every duties message goes ONLY to the staff group (resolved by NAME on the
  // UltraMsg instance), with the member @marked in the text. Delivery is only
  // reported as SENT when UltraMsg confirms it.
  const STAFF_GROUP_NAME = 'GZ28US - STAFF'
  // The @mark uses the member's PHONE (WhatsApp mention format, @<digits>);
  // falls back to the name when no phone is on file.
  function staffMark(id: string | null): string {
    const s = staffList.find(x => x.id === id)
    const digits = (s?.phone || '').replace(/\D/g, '')
    return digits ? `@+${digits}` : `@${s?.name || 'Unassigned'}`
  }
  async function waPost(payload: Record<string, string>): Promise<string | null> {
    const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    return !res.ok || data.error ? String(data.error || `HTTP ${res.status}`) : null
  }
  async function sendWhats(body: string): Promise<void> {
    setSendingWa(true)
    try {
      const err = await waPost({ toGroupName: STAFF_GROUP_NAME, body })
      if (err) alert(`WhatsApp send failed — ${err}`)
      else alert(`WhatsApp SENT ✅ to "${STAFF_GROUP_NAME}"`)
    } finally {
      setSendingWa(false)
    }
  }

  // SEND WHATSAPP (duties list): the group gets the report AND the member gets
  // his own duty-page link — he presses START/PAUSE/DONE there himself and each
  // press reports back to the group automatically.
  async function sendDutiesList(staffId: string, name: string, maxPriority: string) {
    const body = buildListBody(staffId, name, maxPriority)
    if (!body) return
    setSendingWa(true)
    try {
      const results: string[] = []
      const groupErr = await waPost({ toGroupName: STAFF_GROUP_NAME, body })
      results.push(groupErr ? `❌ group: ${groupErr}` : `✅ sent to "${STAFF_GROUP_NAME}"`)
      const digits = (staffList.find(s => s.id === staffId)?.phone || '').replace(/\D/g, '')
      if (digits) {
        const link = `${window.location.origin}${BASE_PATH}/duties/self/${staffId}${maxPriority !== 'STANDBY' ? `?max=${maxPriority}` : ''}`
        const memberBody = `${body}\n\n▶ OPEN YOUR DUTY PAGE — press START / PAUSE / DONE there and GZ28 gets notified automatically:\n${link}`
        const memberErr = await waPost({ to: digits, body: memberBody })
        results.push(memberErr ? `❌ member: ${memberErr}` : `✅ duty-page link sent to ${name}`)
      } else {
        results.push(`⚠ ${name} has no WhatsApp number — add it on the staff EDIT form to send his duty-page link`)
      }
      alert(results.join('\n'))
    } finally {
      setSendingWa(false)
    }
  }

  // The member's open duties list, ordered by priority, cut at the chosen
  // priority (StandBy = include everything).
  function buildListBody(staffId: string, name: string, maxPriority: string): string | null {
    // P1 THROUGH P3 always go to the member (Márcio, 02/ago/2026) — the cut can
    // narrow P4/StandBy, never below Priority 3.
    const maxRank = Math.max(DUTY_PRIORITY_RANK[maxPriority] ?? 3, DUTY_PRIORITY_RANK['3'])
    const rows = duties
      .filter(d => d.staff_id === staffId && !d.done && (DUTY_PRIORITY_RANK[d.priority] ?? 0) <= maxRank)
      .sort(dutyOrder)
    if (!rows.length) return null
    const lines = rows.map((d, i) =>
      `${i + 1}. [${dutyPriorityBadge(d.priority).label}] ${d.description}${d.invoiceCode !== '—' ? ` (${d.invoiceCode}${d.carLabel ? ' · ' + d.carLabel : ''})` : ''}${d.promised ? ` — 🗓 PROMISED TO ${fmtPromised(d.promised)}` : ''}`)
    return `📋 DUTIES — ${name} ${staffMark(staffId)}\n${rows.length} open, by priority${maxPriority === 'STANDBY' ? '' : ` (up to P${maxPriority})`}:\n\n${lines.join('\n')}`
  }

  function dutyEventBody(action: 'STARTED' | 'PAUSED' | 'DONE', d: Duty, secs: number, endIso?: string): string {
    const icon = action === 'STARTED' ? '▶' : action === 'PAUSED' ? '⏸' : '✅'
    // Formato do Márcio (01/ago/2026): nome em negrito sem @menção, e uma linha
    // "Carro - Tarefa" (só o nome do carro, sem códigos, sem badge [P1]/numeração).
    const carName = d.carLabel ? (d.carLabel.split(' — ').pop() || '') : ''
    const desc = d.description.replace(/^\s*\d+[.)]\s*/, '')
    const lines = [
      `${icon} DUTY ${action}`,
      `👤 *${staffNameOf(d.staff_id)}*`,
      `${carName ? `${carName} - ` : ''}${desc}`,
    ]
    if (d.promised) lines.push(`🗓 PROMISED TO: ${fmtPromised(d.promised)}`)
    if (action === 'STARTED') lines.push(`Started: ${fmtDT(new Date().toISOString())}`)
    if (action === 'PAUSED') lines.push(`⏱ ${fmtDur(secs)} so far`)
    if (action === 'DONE') {
      lines.push(`⏱ Total time: ${fmtDur(secs)}`)
      if (d.work_started_at) lines.push(`${fmtDT(d.work_started_at)} → ${fmtDT(endIso || new Date().toISOString())}`)
    }
    return lines.join('\n')
  }

  async function toggleDone(duty: Duty) {
    const { error } = await supabase.from('invoice_duties').update({ done: !duty.done }).eq('id', duty.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(d => d.id === duty.id ? { ...d, done: !d.done } : d))
  }

  // Ordem visual das duties (Márcio, 01/ago/2026): o dropdown 01–15 vira o
  // prefixo "NN. " da descrição — a ordenação alfanumérica existente faz o resto.
  const dutyOrderOf = (desc: string) => { const m = /^(\d{1,2})[.)]\s/.exec(desc || ''); return m ? m[1].padStart(2, '0') : '' }
  const stripDutyOrder = (desc: string) => (desc || '').replace(/^\d{1,2}[.)]\s*/, '')
  const withDutyOrder = (order: string, desc: string) => order ? `${order}. ${stripDutyOrder(desc).trim()}` : desc.trim()

  function startEdit(d: Duty) {
    const order = dutyOrderOf(d.description)
    setEditingId(d.id)
    setEditingDuty({ order, description: order ? stripDutyOrder(d.description) : d.description, staff_id: d.staff_id || '', priority: d.priority || '1' })
  }
  async function saveEdit() {
    if (!editingId) return
    if (!editingDuty.description.trim()) { alert('Enter the duty description'); return }
    if (!editingDuty.staff_id) { alert('Pick the STAFF member who will execute it'); return }
    const desc = withDutyOrder(editingDuty.order, editingDuty.description)
    const { error } = await supabase.from('invoice_duties').update({ description: desc, staff_id: editingDuty.staff_id, priority: editingDuty.priority }).eq('id', editingId)
    if (error) { alert(error.message); return }
    setDuties(duties.map(d => d.id === editingId ? { ...d, description: desc, staff_id: editingDuty.staff_id, priority: editingDuty.priority } : d))
    setEditingId(null)
  }
  async function removeDuty(d: Duty) {
    const { error } = await supabase.from('invoice_duties').delete().eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.filter(x => x.id !== d.id))
  }

  // duty_events: o sistema guarda TODO evento por conta própria (Márcio,
  // 01/ago/2026) — o grupo é aviso, o banco é a memória. Fire-and-forget.
  function logDutyEvent(action: 'STARTED' | 'RESUMED' | 'PAUSED' | 'DONE', d: Duty, secs: number | null) {
    void fetch(`${BASE_PATH}/api/duty-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duty_id: d.id, staff_id: d.staff_id, staff_name: staffNameOf(d.staff_id), action, seconds_banked: secs, description: d.description, car_label: d.carLabel, invoice_code: d.invoiceCode }),
    }).catch(() => {})
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
    setNotifyPopup({ title: '▶ DUTY STARTED', body: dutyEventBody('STARTED', d, 0) })
    for (const r of othersRunning) logDutyEvent('PAUSED', r, (Number(r.time_seconds) || 0) + segSeconds(r.time_started_at as string))
    logDutyEvent(d.work_started_at ? 'RESUMED' : 'STARTED', d, null)
  }

  async function pauseDuty(d: Duty) {
    if (!d.time_started_at) return
    const secs = (Number(d.time_seconds) || 0) + segSeconds(d.time_started_at)
    const { error } = await supabase.from('invoice_duties').update({ time_seconds: secs, time_started_at: null }).eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null } : x))
    setNotifyPopup({ title: '⏸ DUTY PAUSED', body: dutyEventBody('PAUSED', d, secs) })
    logDutyEvent('PAUSED', d, secs)
  }

  async function finishDuty(d: Duty) {
    const nowIso = new Date().toISOString()
    const secs = (Number(d.time_seconds) || 0) + (d.time_started_at ? segSeconds(d.time_started_at) : 0)
    const { error } = await supabase.from('invoice_duties').update({ time_seconds: secs, time_started_at: null, work_ended_at: nowIso, done: true }).eq('id', d.id)
    if (error) { alert(error.message); return }
    setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null, work_ended_at: nowIso, done: true } : x))
    setNotifyPopup({ title: '✅ DUTY DONE', body: dutyEventBody('DONE', d, secs, nowIso) })
    logDutyEvent('DONE', d, secs)
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
  // Header counts come from ALL of the member's duties (not the filtered rows),
  // so DONE doesn't read 0 just because the TO DO filter hides the done ones.
  const byPriority = (a: Duty, b: Duty) => dutyOrder(a, b)
  const groups: { key: string; name: string; rows: Duty[]; todoCount: number; doneCount: number }[] = []
  for (const s of staffList) {
    const rows = visible.filter(d => d.staff_id === s.id).sort(byPriority)
    const all = duties.filter(d => d.staff_id === s.id)
    if (rows.length) groups.push({ key: s.id, name: s.name, rows, todoCount: all.filter(d => !d.done).length, doneCount: all.filter(d => d.done).length })
  }
  const unassigned = visible.filter(d => !d.staff_id || !staffList.some(s => s.id === d.staff_id)).sort(byPriority)
  if (unassigned.length) {
    const allUn = duties.filter(d => !d.staff_id || !staffList.some(s => s.id === d.staff_id))
    groups.push({ key: 'none', name: 'Unassigned', rows: unassigned, todoCount: allUn.filter(d => !d.done).length, doneCount: allUn.filter(d => d.done).length })
  }

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
              <div className={`flex justify-between items-center gap-3 flex-wrap ${openGroups.has(g.key) ? 'border-b border-gray-700 pb-2 mb-2' : ''}`}>
                <button onClick={() => toggleGroup(g.key)} className="flex items-center gap-2 text-left">
                  <span className="text-gray-400 text-lg">{openGroups.has(g.key) ? '▾' : '▸'}</span>
                  <h2 className="text-2xl font-bold text-purple-300 hover:text-purple-200">👤 {g.name}</h2>
                </button>
                <div className="flex items-center gap-3">
                  {g.key !== 'none' && (
                    <button onClick={() => setListPopup({ staffId: g.key, name: g.name, maxPriority: '4' })} className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap">📱 SEND WHATSAPP</button>
                  )}
                  <p className="text-sm font-bold text-gray-400">{g.todoCount} TO DO · {g.doneCount} DONE</p>
                </div>
              </div>
              {openGroups.has(g.key) && g.rows.map((d, i) => (
                <div key={d.id} className={i < g.rows.length - 1 ? 'border-b border-gray-800/60' : ''}>
                  {editingId === d.id ? (
                    <div className="p-4 my-2 space-y-3 bg-gray-800 border-l-4 border-blue-600 rounded-2xl">
                      <div className="flex gap-3">
                        <select value={editingDuty.order} onChange={(e) => setEditingDuty({ ...editingDuty, order: e.target.value })} className={`${inputClass} shrink-0`} title="Order (01–15)">
                          <option value="">—</option>
                          {Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0')).map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <input type="text" list="duty-options" value={editingDuty.description} onChange={(e) => setEditingDuty({ ...editingDuty, description: e.target.value })} className={`${inputClass} flex-1 min-w-0`} />
                      </div>
                      <div className="flex gap-3">
                        <select value={editingDuty.staff_id} onChange={(e) => setEditingDuty({ ...editingDuty, staff_id: e.target.value })} className={`${inputClass} flex-1 min-w-0`}>
                          <option value="">— STAFF —</option>
                          {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <select value={editingDuty.priority} onChange={(e) => setEditingDuty({ ...editingDuty, priority: e.target.value })} className={`${inputClass} shrink-0`}>
                          <option value="1">Block Priority 1</option>
                          <option value="2">Block Priority 2</option>
                          <option value="3">Block Priority 3</option>
                          <option value="4">Block Priority 4</option>
                          <option value="STANDBY">Block StandBy</option>
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

      {/* SEND WHATSAPP — duties list for one member, cut at a chosen priority */}
      {listPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 max-w-md w-full flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-green-300">📱 SEND DUTIES LIST — {listPopup.name}</h2>
              <button onClick={() => setListPopup(null)} className="text-gray-400 hover:text-white text-xl font-bold px-1">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-xs font-bold text-gray-400">UP TO WHICH PRIORITY?</label>
              <select value={listPopup.maxPriority} onChange={(e) => setListPopup({ ...listPopup, maxPriority: e.target.value })} className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm w-full">
                <option value="3">Up to Priority 3 (minimum — P1–P3 always go)</option>
                <option value="4">Up to Priority 4</option>
                <option value="STANDBY">Everything (incl. StandBy)</option>
              </select>
            </div>
            <pre className="bg-black/40 border border-gray-800 rounded-xl p-3 text-xs text-gray-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{buildListBody(listPopup.staffId, listPopup.name, listPopup.maxPriority) || 'No open duties up to that priority.'}</pre>
            <div className="flex gap-2 flex-wrap">
              <button disabled={sendingWa || !buildListBody(listPopup.staffId, listPopup.name, listPopup.maxPriority)}
                onClick={async () => { await sendDutiesList(listPopup.staffId, listPopup.name, listPopup.maxPriority); setListPopup(null) }}
                className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-3 py-2 rounded-xl font-bold text-sm whitespace-nowrap">
                {sendingWa ? 'SENDING…' : `📢 SEND to GROUP + MEMBER's duty page`}
              </button>
              <button onClick={() => setListPopup(null)} className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-xl font-bold text-sm whitespace-nowrap">CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {/* START / PAUSE / DONE notification — asks the destination on every event */}
      {notifyPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 max-w-md w-full flex flex-col gap-3">
            <h2 className="text-lg font-bold text-green-300">📱 Send WhatsApp — {notifyPopup.title}?</h2>
            <pre className="bg-black/40 border border-gray-800 rounded-xl p-3 text-xs text-gray-300 whitespace-pre-wrap max-h-48 overflow-y-auto">{notifyPopup.body}</pre>
            <div className="flex gap-2 flex-wrap">
              <button disabled={sendingWa}
                onClick={async () => { await sendWhats(notifyPopup.body); setNotifyPopup(null) }}
                className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-3 py-2 rounded-xl font-bold text-sm whitespace-nowrap">
                {sendingWa ? 'SENDING…' : `📢 SEND to "${STAFF_GROUP_NAME}"`}
              </button>
              <button onClick={() => setNotifyPopup(null)} className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-xl font-bold text-sm whitespace-nowrap">DON'T SEND</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
