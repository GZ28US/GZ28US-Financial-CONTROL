'use client'

// STAFF DUTY SELF-SERVICE — the page WhatsApped to a staff member together with
// his duties list. No login (AuthGate public route, like the client self form).
// The member presses START / PAUSE / DONE himself; every press reports to the
// staff WhatsApp group (STARTED / RESUMED / PAUSED / FINISHED + ride + times).
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const STAFF_GROUP_NAME = 'GZ28US - STAFF'

type Duty = {
  id: string
  description: string
  done: boolean
  priority: string
  invoiceCode: string
  carLabel: string
  time_seconds: number
  time_started_at: string | null
  work_started_at: string | null
  work_ended_at: string | null
  // Invoice DELIVERY DATE with no CONCLUSION DATE = the PROMISED TO date —
  // carried on every update report.
  promised: string | null
}
function fmtPromised(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DUTY_PRIORITY_RANK: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, 'STANDBY': 4 }

// Same rule as the DUTIES list: priority first, then keep the SAME CAR's duties together
// within a priority band, then by description.
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

function fmtDur(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : m > 0 ? `${m}m ${ss}s` : `${ss}s`
}
function fmtDT(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function StaffDutySelfPage() {
  const params = useParams()
  const staffId = String(params.staffId)
  const [staff, setStaff] = useState<{ name: string; phone: string | null } | null>(null)
  const [duties, setDuties] = useState<Duty[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [maxPriority, setMaxPriority] = useState<string>('STANDBY')
  const [toast, setToast] = useState<string | null>(null)
  const busyRef = useRef(false)
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t) }, [])

  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('max')
    if (m && DUTY_PRIORITY_RANK[m] !== undefined) setMaxPriority(m)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function load() {
    // One scoped SECURITY DEFINER RPC returns the staff + their duties joined to
    // invoice_code / ride labels / promised-to — exposing ONLY those safe fields
    // (never invoice pricing). anon has no direct access to staff/invoices/rides.
    const { data } = await supabase.rpc('duties_self_load', { p_staff_id: staffId })
    if (!data) { setNotFound(true); setLoading(false); return }
    setStaff({ name: data.staff.name, phone: data.staff.phone })
    setDuties((data.duties || []).map((d: any) => ({
      id: d.id,
      description: d.description || '',
      done: !!d.done,
      priority: String(d.priority || '1'),
      invoiceCode: d.invoice_code || '—',
      carLabel: [d.ride_project_code, d.ride_project_name].filter(Boolean).join(' — '),
      time_seconds: Number(d.time_seconds) || 0,
      time_started_at: d.time_started_at || null,
      work_started_at: d.work_started_at || null,
      work_ended_at: d.work_ended_at || null,
      promised: d.delivery_date && !d.conclusion_date ? d.delivery_date : null,
    })))
    setLoading(false)
  }

  // ── group reporting ─────────────────────────────────────────────────────────
  const mark = () => {
    const digits = (staff?.phone || '').replace(/\D/g, '')
    return digits ? `@+${digits}` : `@${staff?.name || ''}`
  }
  function eventBody(action: 'STARTED' | 'RESUMED' | 'PAUSED' | 'FINISHED', d: Duty, secs: number, extra?: string): string {
    const icon = action === 'PAUSED' ? '⏸' : action === 'FINISHED' ? '✅' : '▶'
    // Formato do Márcio (01/ago/2026): nome em negrito sem @menção, e uma linha
    // "Carro - Tarefa" (só o nome do carro, sem códigos, sem badge [P1]/numeração).
    const carName = d.carLabel ? (d.carLabel.split(' — ').pop() || '') : ''
    const desc = d.description.replace(/^\s*\d+[.)]\s*/, '')
    const lines = [
      `${icon} DUTY ${action}`,
      `👤 *${staff?.name || ''}*`,
      `${carName ? `${carName} - ` : ''}${desc}`,
    ]
    if (d.promised) lines.push(`🗓 PROMISED TO: ${fmtPromised(d.promised)}`)
    if (action === 'STARTED' || action === 'RESUMED') lines.push(`At: ${fmtDT(new Date().toISOString())}`)
    if (action === 'PAUSED') lines.push(`⏱ ${fmtDur(secs)} so far`)
    if (action === 'FINISHED') {
      lines.push(`⏱ Total time: ${fmtDur(secs)}`)
      if (d.work_started_at) lines.push(`${fmtDT(d.work_started_at)} → ${fmtDT(new Date().toISOString())}`)
    }
    if (extra) lines.push(extra)
    return lines.join('\n')
  }
  async function report(body: string) {
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toGroupName: STAFF_GROUP_NAME, body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) setToast('⚠ Report to GZ28 failed — tell the shop.')
      else setToast('✅ Reported to GZ28')
    } catch {
      setToast('⚠ Report to GZ28 failed — tell the shop.')
    }
    setTimeout(() => setToast(null), 3000)
  }

  // ── timer actions (same rules as the shop's DUTIES page) ───────────────────
  const segSeconds = (startedAt: string) => Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))

  async function startDuty(d: Duty) {
    if (busyRef.current) return; busyRef.current = true
    try {
      const nowIso = new Date().toISOString()
      const resumed = !!d.work_started_at
      const othersRunning = duties.filter(x => x.id !== d.id && x.time_started_at)
      for (const r of othersRunning) {
        const secs = (Number(r.time_seconds) || 0) + segSeconds(r.time_started_at as string)
        const { error } = await supabase.rpc('duty_self_update', { p_id: r.id, p_time_seconds: secs, p_time_started_at: null, p_work_started_at: r.work_started_at, p_work_ended_at: r.work_ended_at, p_done: r.done })
        if (error) { alert(error.message); return }
      }
      const { error } = await supabase.rpc('duty_self_update', { p_id: d.id, p_time_seconds: Number(d.time_seconds) || 0, p_time_started_at: nowIso, p_work_started_at: d.work_started_at || nowIso, p_work_ended_at: null, p_done: d.done })
      if (error) { alert(error.message); return }
      setDuties(duties.map(x => {
        if (x.id === d.id) return { ...x, time_started_at: nowIso, work_started_at: x.work_started_at || nowIso, work_ended_at: null }
        if (othersRunning.some(r => r.id === x.id) && x.time_started_at) return { ...x, time_seconds: (Number(x.time_seconds) || 0) + segSeconds(x.time_started_at), time_started_at: null }
        return x
      }))
      const extra = othersRunning.length ? `⏸ auto-paused: ${othersRunning.map(r => r.description).join(', ')}` : undefined
      void report(eventBody(resumed ? 'RESUMED' : 'STARTED', d, 0, extra))
    } finally { busyRef.current = false }
  }

  async function pauseDuty(d: Duty) {
    if (!d.time_started_at || busyRef.current) return; busyRef.current = true
    try {
      const secs = (Number(d.time_seconds) || 0) + segSeconds(d.time_started_at)
      const { error } = await supabase.rpc('duty_self_update', { p_id: d.id, p_time_seconds: secs, p_time_started_at: null, p_work_started_at: d.work_started_at, p_work_ended_at: d.work_ended_at, p_done: d.done })
      if (error) { alert(error.message); return }
      setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null } : x))
      void report(eventBody('PAUSED', d, secs))
    } finally { busyRef.current = false }
  }

  async function finishDuty(d: Duty) {
    if (busyRef.current) return; busyRef.current = true
    try {
      const nowIso = new Date().toISOString()
      const secs = (Number(d.time_seconds) || 0) + (d.time_started_at ? segSeconds(d.time_started_at) : 0)
      const { error } = await supabase.rpc('duty_self_update', { p_id: d.id, p_time_seconds: secs, p_time_started_at: null, p_work_started_at: d.work_started_at, p_work_ended_at: nowIso, p_done: true })
      if (error) { alert(error.message); return }
      setDuties(duties.map(x => x.id === d.id ? { ...x, time_seconds: secs, time_started_at: null, work_ended_at: nowIso, done: true } : x))
      void report(eventBody('FINISHED', d, secs))
    } finally { busyRef.current = false }
  }

  // P1 AND P2 always reach the member (Márcio, 27/jul/2026) — the ?max= filter
  // from old links can narrow P3/P4/StandBy, but never below Priority 2.
  const maxRank = Math.max(DUTY_PRIORITY_RANK[maxPriority] ?? 4, DUTY_PRIORITY_RANK['2'])
  const byPriority = (a: Duty, b: Duty) => dutyOrder(a, b)
  const open = duties.filter(d => !d.done && (DUTY_PRIORITY_RANK[d.priority] ?? 0) <= maxRank).sort(byPriority)
  const finished = duties.filter(d => d.done).sort(byPriority)

  if (loading) return <main className="min-h-screen bg-black text-white p-6"><p className="text-xl text-gray-400">Loading…</p></main>
  if (notFound) return <main className="min-h-screen bg-black text-white p-6"><p className="text-xl text-gray-400">Link not valid.</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">🔧 GZ28 DUTIES</h1>
        <p className="text-purple-300 font-bold text-lg">👤 {staff?.name}</p>
        <p className="text-gray-500 text-sm">Press START when you begin, PAUSE when you stop, DONE when you finish. Every press reports to GZ28 automatically.</p>
      </div>

      {open.length === 0 ? (
        <p className="text-xl text-gray-400 bg-gray-900 border border-gray-700 rounded-2xl p-5">🎉 No open duties — all done!</p>
      ) : (
        <div className="space-y-3">
          {open.map(d => {
            const running = !!d.time_started_at
            const secsNow = (Number(d.time_seconds) || 0) + (d.time_started_at ? (Date.now() - new Date(d.time_started_at).getTime()) / 1000 : 0)
            return (
              <div key={d.id} className={`bg-gray-900 border rounded-2xl p-4 ${running ? 'border-amber-500' : 'border-gray-700'}`}>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${dutyPriorityBadge(d.priority).cls}`}>{dutyPriorityBadge(d.priority).label}</span>
                  <p className="font-bold text-base leading-tight">{d.description}</p>
                </div>
                <p className="text-sm text-gray-400 mt-1">{d.invoiceCode}{d.carLabel ? ` · ${d.carLabel}` : ''}</p>
                {(running || d.time_seconds > 0) && (
                  <p className={`text-sm mt-1 font-bold ${running ? 'text-amber-400' : 'text-gray-400'}`}>⏱ {fmtDur(secsNow)}{running ? ' · running' : ' · paused'}</p>
                )}
                <div className="flex gap-2 mt-3">
                  {!running && (
                    <button onClick={() => startDuty(d)} className="flex-1 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-500 px-4 py-3 rounded-xl font-black text-base">▶ {d.work_started_at ? 'RESUME' : 'START'}</button>
                  )}
                  {running && (
                    <button onClick={() => pauseDuty(d)} className="flex-1 bg-amber-600 hover:bg-amber-500 active:bg-amber-400 text-black px-4 py-3 rounded-xl font-black text-base">⏸ PAUSE</button>
                  )}
                  <button onClick={() => finishDuty(d)} className="flex-1 bg-green-700 hover:bg-green-600 active:bg-green-500 px-4 py-3 rounded-xl font-black text-base">✅ DONE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {finished.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-bold text-gray-500 mb-2">✅ DONE ({finished.length})</p>
          <div className="space-y-1.5">
            {finished.map(d => (
              <p key={d.id} className="text-sm text-green-400/80 line-through bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2">
                {d.description} <span className="text-gray-500 no-underline">· {d.invoiceCode}{d.time_seconds > 0 ? ` · ⏱ ${fmtDur(d.time_seconds)}` : ''}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-gray-600 text-xs mt-8 font-bold">GZ28 V8 SPEEDSHOP · Control App</p>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-gray-800 border border-gray-600 rounded-2xl px-5 py-3 font-bold text-sm shadow-2xl">
          {toast}
        </div>
      )}
    </main>
  )
}
