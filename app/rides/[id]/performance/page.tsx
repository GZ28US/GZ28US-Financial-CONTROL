'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

const TABS = ['DYNO', '1/4 MILE', '1/8 MILE', '100-200'] as const
type Tab = typeof TABS[number]

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

      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8">
        <h2 className="text-2xl font-bold mb-2">{tab}</h2>
        <p className="text-xl text-gray-400">This section is under construction.</p>
      </div>
    </main>
  )
}
