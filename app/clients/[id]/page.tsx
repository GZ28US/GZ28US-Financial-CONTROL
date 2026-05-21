'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Client = {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
}

type Ride = {
  id: string
  project_code: string
  project_name: string | null
  manufacturer: string | null
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  plate: string | null
}

export default function ViewClientPage() {
  const params = useParams()
  const clientId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [client, setClient] = useState<Client | null>(null)
  const [rides, setRides] = useState<Ride[]>([])

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const { data: clientData } = await supabase.from('clients').select('*').eq('id', clientId).single()
    if (clientData) setClient(clientData)

    const { data: ridesData } = await supabase.from('rides').select('*').eq('client_id', clientId).order('project_code', { ascending: true })
    if (ridesData) setRides(ridesData)

    setLoading(false)
  }

  function formatPhone(phone: string | null) {
    if (!phone) return '-'
    const digits = phone.replace(/\D/g, '')
    const local = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits
    if (local.length === 11) return `(${local.slice(0,2)})${local.slice(2,7)}.${local.slice(7)}`
    if (local.length === 10) return `(${local.slice(0,2)})${local.slice(2,6)}.${local.slice(6)}`
    return phone
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  if (!client) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Client not found.</p></main>
  )

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">{client.name}</h1>
        <div className="flex gap-3">
          <Link href="/clients" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/clients/edit/${clientId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* Contact Info */}
        <div>
          <label className="block mb-3 text-lg font-bold">CONTACT</label>
          <div className={sectionClass}>
            {client.phone && <div className={rowClass}><span className={labelClass}>PHONE</span><span className="font-bold">{formatPhone(client.phone)}</span></div>}
            {client.email && <div className={rowClass}><span className={labelClass}>EMAIL</span><span className="font-bold">{client.email}</span></div>}
          </div>
        </div>

        {/* Address */}
        {(client.address || client.city || client.state || client.zip || client.country) && (
          <div>
            <label className="block mb-3 text-lg font-bold">ADDRESS</label>
            <div className={sectionClass}>
              {client.address && <div className={rowClass}><span className={labelClass}>STREET</span><span className="font-bold">{client.address}</span></div>}
              {(client.city || client.state) && <div className={rowClass}><span className={labelClass}>CITY / ST</span><span className="font-bold">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
              {client.country && <div className={rowClass}><span className={labelClass}>COUNTRY</span><span className="font-bold">{client.country}</span></div>}
            </div>
          </div>
        )}

        {/* Rides */}
        {rides.length > 0 && (
          <div>
            <label className="block mb-3 text-lg font-bold">RIDES ({rides.length})</label>
            <div className={sectionClass}>
              {rides.map((ride, index) => (
                <Link
                  key={ride.id}
                  href={`/rides/${ride.id}/invoices`}
                  className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-800 transition-colors ${index < rides.length - 1 ? 'border-b border-gray-700' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold">{ride.project_code}{ride.project_name ? ` — ${ride.project_name}` : ''}</p>
                    <p className="text-sm text-gray-400">
                      {[ride.manufacturer, ride.brand, ride.model, ride.year].filter(Boolean).join(' ')}
                      {ride.color ? ` — ${ride.color}` : ''}
                      {ride.plate ? ` — ${ride.plate}` : ''}
                    </p>
                  </div>
                  <span className="text-gray-400 font-bold text-sm shrink-0">INVOICES →</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {rides.length === 0 && (
          <p className="text-gray-400 text-xl">No rides linked to this client yet.</p>
        )}

      </div>
    </main>
  )
}