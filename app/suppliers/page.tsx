'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { mirrorDeleteSupplier } from '@/lib/suppliersMirror'

type Supplier = {
  id: string
  name: string
  discount: number | null
  discount_type: string | null
  is_dealership: boolean | null
  account_number: number | null
  website: string | null
}

function pad3(n: number | null) { return n != null ? String(n).padStart(3, '0') : '—' }
// Ensure an external URL has a protocol so the link opens correctly.
function withProtocol(url: string) { return /^https?:\/\//i.test(url) ? url : `https://${url}` }

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { loadSuppliers() }, [])

  async function loadSuppliers() {
    const { data } = await supabase
      .from('suppliers')
      .select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setSuppliers((data || []) as Supplier[])
    setLoading(false)
  }

  async function removeSupplier(id: string) {
    const name = suppliers.find(s => s.id === id)?.name || ''
    const { error } = await supabase.from('suppliers').delete().eq('id', id)
    if (error) { alert(error.message); return }
    void mirrorDeleteSupplier(name)
    setConfirmId(null)
    loadSuppliers()
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Supplier</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this supplier? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeSupplier(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">SUPPLIERS ({suppliers.length})</h1>
        <div className="flex gap-3 flex-wrap">
          <Link href="/suppliers/dealership/new" className="bg-yellow-600 hover:bg-yellow-500 text-black px-6 py-4 rounded-2xl text-xl font-bold">+ ADD A NEW DEALERSHIP SUPPLIER</Link>
          <Link href="/suppliers/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW SUPPLIER</Link>
        </div>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : suppliers.length === 0 ? (
        <p className="text-2xl text-gray-400">No suppliers yet.</p>
      ) : (
        <div className="space-y-5">
          {suppliers.map((supplier) => {
            const isDealer = !!supplier.is_dealership
            const editHref = isDealer ? `/suppliers/dealership/edit/${supplier.id}` : `/suppliers/edit/${supplier.id}`
            return (
            <div key={supplier.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-2xl font-bold">{supplier.name}</h2>
                  {isDealer && <span className="px-3 py-1 rounded-full text-sm font-bold bg-yellow-600 text-black">DEALERSHIP · D-{pad3(supplier.account_number)}</span>}
                </div>
                <p className="text-lg text-gray-400">Discount: {supplier.discount_type === 'VARIABLE' ? 'VARIABLE (per item)' : `${supplier.discount || 0}%`}</p>
                {isDealer && supplier.website && (
                  <a href={withProtocol(supplier.website)} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-lg break-all">{supplier.website}</a>
                )}
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={editHref} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(supplier.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                <Link href={`/parts?supplierId=${supplier.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">PARTS</Link>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
