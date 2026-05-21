'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'

type Ride = {
  id: string
  project_code: string
  project_name: string | null
  manufacturer: string | null
  brand: string | null
  model: string | null
  version: string | null
  special_edition: string | null
  color: string | null
  vin: string | null
  plate: string | null
  year: number | null
  photo_url: string | null
  client_id: string | null
}

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

type Invoice = {
  id: string
  invoice_code: string
  entry_date: string | null
  delivery_date: string | null
  service: string | null
  mileage: number | null
  florida_taxes: number | null
  global_discount: number | null
}

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function isTodayOrPast(dateStr: string | null) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
}

export default function ViewRidePage() {
  const params = useParams()
  const rideId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [ride, setRide] = useState<Ride | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [invoiceStats, setInvoiceStats] = useState<Record<string, { totalPaid: number; grandTotal: number; currentIncome: number; currentDebt: number }>>({})

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const { data: rideData } = await supabase.from('rides').select('*').eq('id', rideId).single()
    if (!rideData) { setLoading(false); return }
    setRide(rideData)

    if (rideData.client_id) {
      const { data: clientData } = await supabase.from('clients').select('*').eq('id', rideData.client_id).single()
      if (clientData) setClient(clientData)
    }

    const { data: invoicesData } = await supabase
      .from('invoices').select('*').eq('ride_id', rideId).order('invoice_code', { ascending: true })
    if (invoicesData) {
      setInvoices(invoicesData)

      const stats: Record<string, any> = {}
      await Promise.all(invoicesData.map(async (inv) => {
        const [paymentsRes, expensesRes, partsRes, servicesRes] = await Promise.all([
          supabase.from('invoice_payments').select('amount, payment_date').eq('invoice_id', inv.id),
          supabase.from('invoice_expenses').select('price, payment_date').eq('invoice_id', inv.id),
          supabase.from('invoice_parts').select('unit_price, quantity').eq('invoice_id', inv.id),
          supabase.from('invoice_services').select('price').eq('invoice_id', inv.id),
        ])

        const totalPaid = (paymentsRes.data || []).filter(p => isTodayOrPast(p.payment_date)).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
        const expensesTotalPaid = (expensesRes.data || []).filter(e => e.payment_date).reduce((s, e) => s + (parseFloat(e.price) || 0), 0)
        const expensesUnpaid = (expensesRes.data || []).filter(e => !e.payment_date).reduce((s, e) => s + (parseFloat(e.price) || 0), 0)

        const partsSubTotal = (partsRes.data || []).reduce((s, p) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
        const floridaTaxesAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
        const partsTotal = partsSubTotal + floridaTaxesAmount
        const servicesTotal = (servicesRes.data || []).reduce((s, sv) => s + (parseFloat(sv.price) || 0), 0)
        const partsAndServicesTotal = partsTotal + servicesTotal
        const discountAmount = partsAndServicesTotal * ((inv.global_discount || 0) / 100)
        const grandTotal = partsAndServicesTotal - discountAmount

        stats[inv.id] = {
          totalPaid,
          grandTotal,
          currentIncome: totalPaid - expensesTotalPaid,
          currentDebt: expensesUnpaid,
        }
      }))
      setInvoiceStats(stats)
    }

    setLoading(false)
  }

  function getStatus(deliveryDate: string | null) {
    if (!deliveryDate) return 'OPEN'
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return new Date(deliveryDate + 'T00:00:00') <= today ? 'CLOSED' : 'OPEN'
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!ride) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Ride not found.</p></main>
  )

  const totalIncome = Object.values(invoiceStats).reduce((s, v) => s + v.currentIncome, 0)
  const totalDebt = Object.values(invoiceStats).reduce((s, v) => s + v.currentDebt, 0)

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold">{ride.project_code}{ride.project_name ? ` — ${ride.project_name}` : ''}</h1>
          <div className="flex gap-3 mt-2 flex-wrap">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${totalIncome >= 0 ? 'bg-blue-900 text-blue-300' : 'bg-red-900 text-red-300'}`}>
              CURRENT INCOME: {formatUSD(totalIncome)}
            </span>
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${totalDebt <= 0 ? 'bg-gray-700 text-gray-300' : 'bg-red-900 text-red-300'}`}>
              CURRENT DEBT: {formatUSD(totalDebt)}
            </span>
          </div>
        </div>
        <div className="flex gap-3">
          <Link href="/rides" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/rides/edit/${rideId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
          <Link href={`/rides/${rideId}/invoices`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">INVOICES</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* PHOTO */}
        {ride.photo_url && (
          <div className="rounded-2xl overflow-hidden border border-gray-700">
            <img src={ride.photo_url} alt={ride.project_name || ride.project_code} className="w-full max-h-80 object-cover" />
          </div>
        )}

        {/* VEHICLE */}
        <div>
          <label className="block mb-3 text-lg font-bold">VEHICLE</label>
          <div className={sectionClass}>
            {(ride.manufacturer || ride.brand) && <div className={rowClass}><span className={labelClass}>MAKE / BRAND</span><span className="font-bold">{[ride.manufacturer, ride.brand].filter(Boolean).join(' / ')}</span></div>}
            {ride.model && <div className={rowClass}><span className={labelClass}>MODEL</span><span className="font-bold">{ride.model}{ride.version ? ` — ${ride.version}` : ''}</span></div>}
            {ride.year && <div className={rowClass}><span className={labelClass}>YEAR</span><span className="font-bold">{ride.year}</span></div>}
            {ride.color && <div className={rowClass}><span className={labelClass}>COLOR</span><span className="font-bold">{ride.color}</span></div>}
            {ride.vin && <div className={rowClass}><span className={labelClass}>VIN</span><span className="font-bold">{ride.vin}</span></div>}
            {ride.plate && <div className={rowClass}><span className={labelClass}>PLATE</span><span className="font-bold">{ride.plate}</span></div>}
            {ride.special_edition && <div className={rowClass}><span className={labelClass}>PACK</span><span className="font-bold">{ride.special_edition}</span></div>}
          </div>
        </div>

        {/* CLIENT */}
        {client && (
          <div>
            <label className="block mb-3 text-lg font-bold">CLIENT</label>
            <div className={sectionClass}>
              <div className={rowClass}><span className={labelClass}>NAME</span><span className="font-bold">{client.name}</span></div>
              {client.phone && <div className={rowClass}><span className={labelClass}>PHONE</span><span className="font-bold">{client.phone}</span></div>}
              {client.email && <div className={rowClass}><span className={labelClass}>EMAIL</span><span className="font-bold">{client.email}</span></div>}
              {client.address && <div className={rowClass}><span className={labelClass}>ADDRESS</span><span className="font-bold">{client.address}</span></div>}
              {(client.city || client.state) && <div className={rowClass}><span className={labelClass}>CITY/ST</span><span className="font-bold">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
            </div>
          </div>
        )}

        {/* INVOICES */}
        {invoices.length > 0 && (
          <div>
            <label className="block mb-3 text-lg font-bold">INVOICES ({invoices.length})</label>
            <div className="space-y-3">
              {invoices.map((invoice) => {
                const s = invoiceStats[invoice.id]
                const status = getStatus(invoice.delivery_date)
                return (
                  <div key={invoice.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h3 className="text-xl font-bold">{invoice.invoice_code}</h3>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${status === 'CLOSED' ? 'bg-gray-700 text-gray-300' : 'bg-green-800 text-green-300'}`}>{status}</span>
                      </div>
                      <p className="text-gray-400">Entry: {formatDate(invoice.entry_date)}{invoice.delivery_date ? ` — Delivery: ${formatDate(invoice.delivery_date)}` : ''}</p>
                      {invoice.service && <p className="text-gray-400">{invoice.service}</p>}
                      {s && (
                        <div className="flex gap-2 mt-2 flex-wrap">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.currentIncome >= 0 ? 'bg-blue-900 text-blue-300' : 'bg-red-900 text-red-300'}`}>
                            INCOME: {formatUSD(s.currentIncome)}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.currentDebt <= 0 ? 'bg-gray-700 text-gray-300' : 'bg-red-900 text-red-300'}`}>
                            DEBT: {formatUSD(s.currentDebt)}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-700 text-gray-300">
                            BALANCE: {formatUSD(s.totalPaid - s.grandTotal)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Link href={`/rides/${rideId}/invoices/${invoice.id}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-xl font-bold text-sm">VIEW</Link>
                      <Link href={`/rides/${rideId}/invoices/edit/${invoice.id}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-xl font-bold text-sm">EDIT</Link>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {invoices.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 text-center text-gray-400 text-lg">
            No invoices yet.
          </div>
        )}

      </div>
    </main>
  )
}