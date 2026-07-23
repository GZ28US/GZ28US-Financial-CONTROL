'use client'

import Header from '@/components/Header'

// STREAM — placeholder. The page is reachable from PARTS ▸ STREAM while the
// feature is designed; nothing is wired to the database yet.
export default function StreamPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">STREAM</h1>
      </div>

      <div className="border border-gray-800 rounded-3xl bg-gray-900/40 px-8 py-16 text-center">
        <p className="text-6xl mb-4">🚧</p>
        <p className="text-3xl font-bold mb-2">UNDER CONSTRUCTION</p>
        <p className="text-xl text-gray-400">This page is being built.</p>
      </div>
    </main>
  )
}
