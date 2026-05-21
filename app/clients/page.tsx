'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Client = {
  id: string
  name: string
  email: string | null
  country: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { loadClients() }, [])

  async function loadClients() {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .order('name', { ascending: true })
    setClients(data || [])
    setLoading(false)
  }

  async function removeClient(id: string) {
    const { error } = await supabase.from('clients').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadClients()
  }

  function formatPhone(phone: string | null) {
    if (!phone) return '-'
    // Strip everything except digits
    const digits = phone.replace(/\D/g, '')
    // Handle country code +55 (Brazil)
    const local = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits
    if (local.length === 11) {
      // Mobile: (XX)XXXXX.XXXX
      return `(${local.slice(0,2)})${local.slice(2,7)}.${local.slice(7)}`
    } else if (local.length === 10) {
      // Landline: (XX)XXXX.XXXX
      return `(${local.slice(0,2)})${local.slice(2,6)}.${local.slice(6)}`
    }
    // Fallback: return as-is
    return phone
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Client</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this client? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeClient(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">CLIENTS ({clients.length})</h1>
        <Link href="/clients/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW CLIENT</Link>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : clients.length === 0 ? (
        <p className="text-2xl text-gray-400">No clients yet.</p>
      ) : (
        <div className="space-y-5">
          {clients.map((client) => (
            <div key={client.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">{client.name}</h2>
                <p className="text-lg text-gray-400">{client.email || '-'}</p>
                <p className="text-lg text-gray-400">{formatPhone(client.phone)}</p>
                <p className="text-lg text-gray-400">{[client.city, client.state, client.zip].filter(Boolean).join(', ')}</p>
                {client.country && <p className="text-lg text-gray-400">{client.country}</p>}
              </div>
              <div className="flex gap-3 flex-wrap">
                <Link href={`/clients/${client.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                <Link href={`/clients/edit/${client.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                <button onClick={() => setConfirmId(client.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}