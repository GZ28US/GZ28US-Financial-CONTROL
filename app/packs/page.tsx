'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { carLabel } from '@/lib/carData'

// Catalog of the performance packages we sell, as reusable templates. A CLOSED
// pack is a finished template offered for import on the new-quote screen; a DRAFT
// is still being built and is editable.
export default function PacksPage() {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | 'DRAFT' | 'CLOSED'>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase.from('packs').select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }

  // Copy a pack's whole content into a brand-new DRAFT and open it in the editor,
  // so it can be the starting point for a new package. Cars/totals/parts/services/
  // expenses/notes all carry over; the copy is always DRAFT regardless of the source.
  async function duplicatePack(p: any) {
    if (duplicatingId) return
    setDuplicatingId(p.id)
    const { id, created_at, updated_at, ...rest } = p
    const row = { ...rest, name: `${p.name || 'Pack'} (copy)`, status: 'DRAFT' }
    const { data, error } = await supabase.from('packs').insert([row]).select('id').single()
    if (error || !data) { alert(error?.message || 'Could not duplicate the package.'); setDuplicatingId(null); return }
    router.push(`/packs/edit/${data.id}`)
  }

  async function removePack(id: string) {
    const { error } = await supabase.from('packs').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const filtered = rows.filter((p) => filter === 'ALL' || (p.status || 'DRAFT') === filter)
  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Package</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this package? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePack(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 mb-8 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-4xl font-bold">PERFORMANCE PACKAGES ({filtered.length})</h1>
          <div className="flex gap-2 flex-wrap">
            {(['ALL', 'DRAFT', 'CLOSED'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={chip(filter === f)}>{f}</button>
            ))}
          </div>
        </div>
        <Link href="/packs/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW PACK</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">No packages yet.</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((p) => {
            const closed = (p.status || 'DRAFT') === 'CLOSED'
            const cars = Array.isArray(p.cars) ? p.cars : []
            return (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{p.name || '—'}</h2>
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${closed ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{closed ? 'CLOSED' : 'DRAFT'}</span>
                  </div>
                  <p className="text-lg text-gray-400">{cars.length ? cars.map(carLabel).filter(Boolean).join('  ·  ') : 'No cars selected'}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <button onClick={() => duplicatePack(p)} disabled={duplicatingId === p.id} className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-black px-5 py-3 rounded-2xl font-bold">{duplicatingId === p.id ? 'DUPLICATING…' : '⧉ DUPLICATE'}</button>
                  <Link href={`/packs/${p.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/packs/edit/${p.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(p.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
