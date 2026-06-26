'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type FixedCostSupplier = {
  id: string
  description: string | null
  company: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
}

const CONTACTS = ['WhatsApp', 'Email', 'Phone'] as const

export default function FixedCostSuppliersPage() {
  const [rows, setRows] = useState<FixedCostSupplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'WhatsApp' | 'Email' | 'Phone'>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('fixed_cost_suppliers')
      .select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows((data || []) as FixedCostSupplier[])
    setLoading(false)
  }

  async function remove(id: string) {
    const { error } = await supabase.from('fixed_cost_suppliers').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const q = search.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    const contactOk = filter === 'ALL' || (r.preferred_contact || 'WhatsApp') === filter
    const searchOk = !q || [r.description, r.company, r.contact_name, r.phone, r.email].some((v) => (v || '').toLowerCase().includes(q))
    return contactOk && searchOk
  })

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Fixed Cost Supplier</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">FIXED COST SUPPLIERS ({rows.length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, company, contact…"
            className="w-64 sm:w-80 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <Link href="/costs/fixed/new" className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">ADD NEW FIXED COST SUPPLIER</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {(['ALL', ...CONTACTS] as const).map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-4 py-2 rounded-full font-bold ${filter === c ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No fixed cost suppliers yet.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {filtered.map((r) => (
            <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <Link href={`/costs/fixed/${r.id}`} className="flex-1 min-w-0 group">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold group-hover:text-blue-400 transition">{r.description || r.company || '—'}</h2>
                  <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700">{r.preferred_contact || 'WhatsApp'}</span>
                </div>
                <p className="text-lg text-gray-400">{[r.company, r.contact_name].filter(Boolean).join(' · ') || '—'}</p>
                <p className="text-base text-gray-500">{[r.phone, r.email].filter(Boolean).join(' · ')}</p>
              </Link>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/costs/fixed/${r.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                <Link href={`/costs/fixed/edit/${r.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
