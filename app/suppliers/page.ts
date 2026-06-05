'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Supplier = {
  id: string
  name: string
  discount: number | null
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { loadSuppliers() }, [])

  async function loadSuppliers() {
    const { data } = await supabase
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true })
    setSuppliers((data || []) as Supplier[])
    setLoading(false)
  }

  async function removeSupplier(id: string) {
    const { error } = await supabase.from('suppliers').delete().eq('id', id)
    if (error) { alert(error.message); return }
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

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">SUPPLIERS ({suppliers.length})</h1>
        <Link href="/suppliers/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW SUPPLIER</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : suppliers.length === 0 ? (
        <p className="text-2xl text-gray-400">No suppliers yet.</p>
      ) : (
        <div className="space-y-5">
          {suppliers.map((supplier) => (
            <div key={supplier.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-bold">{supplier.name}</h2>
                <p className="text-lg text-gray-400">Discount: {(supplier.discount || 0)}%</p>
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <Link href={`/suppliers/edit/${supplier.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(supplier.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
