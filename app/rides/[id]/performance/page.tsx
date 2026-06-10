'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'

// Placeholder — to be built once the PERFORMANCE content is defined.
export default function RidePerformancePage() {
  const params = useParams()
  const rideId = String(params.id)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">PERFORMANCE</h1>
        <div className="flex gap-3">
          <Link href="/rides" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/rides/${rideId}`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">VIEW RIDE</Link>
        </div>
      </div>
      <p className="text-2xl text-gray-400">This section is under construction.</p>
    </main>
  )
}
