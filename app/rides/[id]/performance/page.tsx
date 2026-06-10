'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

const TABS = ['DYNO', '1/4 MILE', '1/8 MILE', '100-200'] as const
type Tab = typeof TABS[number]

const DYNO_OPTIONS = ['DynoSolutions DynoJet', 'GZ28US DynoJet']

const MONTHS: [string, string][] = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'], ['05', 'May'], ['06', 'June'],
  ['07', 'July'], ['08', 'August'], ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
const YEARS = Array.from({ length: new Date().getFullYear() - 2025 + 1 }, (_, i) => String(2025 + i))

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
// BHP (crank) = WHP / (1 - loss%). e.g. 850 whp @ 15% loss => 1000 bhp
function computeBhp(whp: string, loss: string): number | null {
  const w = parseFloat(whp)
  if (!isFinite(w)) return null
  const l = loss === '' ? 0 : parseFloat(loss)
  if (!isFinite(l)) return null
  const denom = 1 - l / 100
  if (denom <= 0) return null
  return Math.round((w / denom) * 100) / 100
}

type DynoPull = { id: string; pack: string | null; whp: number | null; loss_pct: number | null; bhp: number | null; pull_date: string | null; dyno: string | null }

function DynoSection({ rideId }: { rideId: string }) {
  const [pulls, setPulls] = useState<DynoPull[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ pack: '', whp: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
  const previewBhp = computeBhp(form.whp, form.loss)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('dyno_pulls')
      .select('*')
      .eq('ride_id', rideId)
      .order('pull_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setPulls((data || []) as DynoPull[])
    setLoading(false)
  }

  async function addPull() {
    if (!form.pack.trim() && !form.whp) { alert('Enter at least a PACK or a WHP figure.'); return }
    const pullDate = form.dyear && form.dmonth && form.dday ? `${form.dyear}-${form.dmonth}-${form.dday}` : null
    const { error } = await supabase.from('dyno_pulls').insert([{
      ride_id: rideId,
      pack: form.pack.trim() || null,
      whp: form.whp ? parseFloat(form.whp) : null,
      loss_pct: form.loss ? parseFloat(form.loss) : null,
      bhp: computeBhp(form.whp, form.loss),
      pull_date: pullDate,
      dyno: form.dyno || null,
    }])
    if (error) { alert(error.message); return }
    setForm({ pack: '', whp: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
    load()
  }

  async function removePull(id: string) {
    if (!window.confirm('Remove this pull?')) return
    const { error } = await supabase.from('dyno_pulls').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setPulls(prev => prev.filter(p => p.id !== id))
  }

  const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      {/* Add a pull */}
      <div className="flex flex-wrap gap-3 items-start mb-6">
        <div className="flex-1 min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">PACK</label>
          <input value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} className={inputClass} placeholder="e.g. Stage 2" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">WHP</label>
          <input value={form.whp} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, whp: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">LOSS (%)</label>
          <input value={form.loss} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, loss: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">BHP</label>
          <div className={`${inputClass} bg-gray-950 text-gray-300`}>{previewBhp != null ? previewBhp.toFixed(2) : '—'}</div>
        </div>
        <div className="min-w-[300px] flex-1">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DATE</label>
          <div className="flex gap-2">
            <select value={form.dmonth} onChange={(e) => setForm({ ...form, dmonth: e.target.value })} className={inputClass}>
              <option value="">Month</option>
              {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={form.dday} onChange={(e) => setForm({ ...form, dday: e.target.value })} className={inputClass}>
              <option value="">Day</option>
              {DAYS.map((d) => <option key={d} value={d}>{parseInt(d, 10)}</option>)}
            </select>
            <select value={form.dyear} onChange={(e) => setForm({ ...form, dyear: e.target.value })} className={inputClass}>
              <option value="">Year</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DYNO</label>
          <select value={form.dyno} onChange={(e) => setForm({ ...form, dyno: e.target.value })} className={inputClass}>
            {DYNO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">ADD</label>
          <button onClick={addPull} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD PULL</button>
        </div>
      </div>

      {/* Pulls table */}
      {loading ? (
        <p className="text-lg text-gray-400">Loading...</p>
      ) : pulls.length === 0 ? (
        <p className="text-lg text-gray-400">No pulls recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-gray-400 text-sm border-b border-gray-700">
                <th className="py-2 pr-4 font-bold">PACK</th>
                <th className="py-2 pr-4 font-bold">WHP</th>
                <th className="py-2 pr-4 font-bold">LOSS (%)</th>
                <th className="py-2 pr-4 font-bold">BHP</th>
                <th className="py-2 pr-4 font-bold">DATE</th>
                <th className="py-2 pr-4 font-bold">DYNO</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {pulls.map((p) => (
                <tr key={p.id} className="border-b border-gray-800">
                  <td className="py-3 pr-4 font-bold">{p.pack || '—'}</td>
                  <td className="py-3 pr-4">{p.whp != null ? `${p.whp.toFixed(2)} whp` : '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{p.loss_pct != null ? `${p.loss_pct}%` : '—'}</td>
                  <td className="py-3 pr-4">{p.bhp != null ? `${p.bhp.toFixed(2)} bhp` : '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{fmtDate(p.pull_date)}</td>
                  <td className="py-3 pr-4">{p.dyno || '—'}</td>
                  <td className="py-3 text-right">
                    <button onClick={() => removePull(p.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function RidePerformancePage() {
  const params = useParams()
  const rideId = String(params.id)
  const [ride, setRide] = useState<{ project_code: string | null; project_name: string | null } | null>(null)
  const [tab, setTab] = useState<Tab>('DYNO')

  useEffect(() => {
    supabase.from('rides').select('project_code, project_name').eq('id', rideId).single().then(({ data }) => setRide(data))
  }, [])

  const title = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">PERFORMANCE</h1>
        <div className="flex gap-3">
          <Link href="/rides" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/rides/${rideId}`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">VIEW RIDE</Link>
        </div>
      </div>
      {title && <p className="text-xl text-gray-400 mb-6">{title}</p>}

      <div className="flex gap-2 flex-wrap mb-8">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 rounded-2xl font-bold ${tab === t ? 'bg-white text-black' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'DYNO' ? (
        <DynoSection rideId={rideId} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8">
          <h2 className="text-2xl font-bold mb-2">{tab}</h2>
          <p className="text-xl text-gray-400">This section is under construction.</p>
        </div>
      )}
    </main>
  )
}
