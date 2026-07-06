'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

// BUILDS — every ride's performance data is grouped into builds (Build.01, Build.02…).
// This page lists them; each opens the full performance page (BUILD SHEET / DYNO / times)
// scoped to that build in the shared bank (ride_builds, keyed by ride_code + build_no).
type Build = { id: string; build_no: number; created_at: string }
const buildLabel = (n: number) => `Build.${String(n).padStart(2, '0')}`

export default function RideBuildsPage() {
  const params = useParams()
  const rideId = String(params.id)
  const [ride, setRide] = useState<{ project_code: string | null; project_name: string | null } | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    supabase.from('rides').select('project_code, project_name').eq('id', rideId).single().then(({ data }) => setRide(data))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (ride) void load() }, [ride]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const { data } = await supabase.from('ride_builds').select('*').eq('ride_code', ride?.project_code || '').order('build_no')
    setBuilds((data || []) as Build[])
    setLoading(false)
  }

  async function addBuild() {
    if (!ride?.project_code) return
    setAdding(true)
    try {
      const next = builds.length ? Math.max(...builds.map((b) => b.build_no)) + 1 : 1
      const { error } = await supabase.from('ride_builds').insert([{ ride_code: ride.project_code, build_no: next }])
      if (error) { alert(error.message); return }
      await load()
    } finally {
      setAdding(false)
    }
  }

  const title = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">BUILDS</h1>
        <div className="flex gap-3">
          <Link href={`/rides/${rideId}`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <button onClick={addBuild} disabled={adding || !ride} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
            {adding ? 'ADDING…' : '+ ADD BUILD'}
          </button>
        </div>
      </div>
      {title && <p className="text-xl text-gray-400 mb-6">{title}</p>}

      {loading || !ride ? (
        <p className="text-xl text-gray-400">Loading…</p>
      ) : builds.length === 0 ? (
        <p className="text-xl text-gray-400">No builds yet — press ADD BUILD to start Build.01.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {builds.map((b) => (
            <Link key={b.id} href={`/rides/${rideId}/performance/${b.build_no}`} className="bg-gray-900 border border-gray-800 hover:border-gray-500 rounded-3xl p-6 block">
              <p className="text-3xl font-bold">🏁 {buildLabel(b.build_no)}</p>
              <p className="text-gray-400 mt-1">{new Date(b.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</p>
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}
