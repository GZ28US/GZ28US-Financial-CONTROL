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
                <div key={d.id} className={`flex items-center justify-between gap-4 py-3 ${i < g.rows.length - 1 ? 'border-b border-gray-800/60' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${dutyPriorityBadge(d.priority).cls}`}>{dutyPriorityBadge(d.priority).label}</span>
                      <p className={`text-base font-bold truncate ${d.done ? 'text-green-400 line-through' : dutyTextColor(d.priority)}`} title={d.description}>{d.description}</p>
                    </div>
                    <p className="text-sm text-gray-400">
                      <a href={`${BASE_PATH}${d.href}`} className="text-gray-500 hover:text-blue-400 hover:underline">{d.invoiceCode}</a>
                      {d.carLabel ? ` · ${d.carLabel}` : ''}
                    </p>
                  </div>
                  <button onClick={() => toggleDone(d)} className={`px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap shrink-0 ${d.done ? 'bg-green-700 hover:bg-green-600' : 'bg-yellow-700 hover:bg-yellow-600'}`}>{d.done ? 'DONE' : 'TO DO'}</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
