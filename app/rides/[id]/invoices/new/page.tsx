'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

const FULL_PROJECT_LABOR = 'Full Project Labor'

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

export default function NewInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const pathname = usePathname()
  const ownerId = String(params.id)
  // Context: client personal invoice when URL is /clients/..., otherwise ride invoice.
  const isClient = (pathname || '').includes('/clients/')
  const basePath = isClient ? `/clients/${ownerId}/invoices` : `/rides/${ownerId}/invoices`

  const [ownerLabel, setOwnerLabel] = useState('')
  const [ownerSubtitle, setOwnerSubtitle] = useState('')
  const [invoiceCode, setInvoiceCode] = useState('')
  const [hiringDate, setHiringDate] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [mileage, setMileage] = useState('')
  const [service, setService] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadOwner() }, [])

  async function loadOwner() {
    if (isClient) {
      const { data: client } = await supabase.from('clients').select('name, client_number').eq('id', ownerId).single()
      if (client) {
        const numStr = client.client_number != null ? String(client.client_number) : ''
        setOwnerLabel(numStr)
        setOwnerSubtitle(client.name || '')
        await loadNextClientInvoiceCode(numStr)
      }
    } else {
      const { data: ride } = await supabase.from('rides').select('project_code, project_name').eq('id', ownerId).single()
      if (ride) {
        setOwnerLabel(ride.project_code || '')
        setOwnerSubtitle(ride.project_name || '')
        await loadNextRideInvoiceCode(ride.project_code)
      }
    }
  }

  async function loadNextRideInvoiceCode(code: string) {
    const { data } = await supabase.from('invoices').select('invoice_code').eq('ride_id', ownerId)
    const usedNumbers = data?.map((item) => {
      const match = item.invoice_code?.match(/\.(\d+)$/)
      return match ? Number(match[1]) : null
    }) || []
    let nextNumber = 1
    while (usedNumbers.includes(nextNumber)) nextNumber++
    setInvoiceCode(`${code}.${nextNumber}`)
  }

  async function loadNextClientInvoiceCode(numStr: string) {
    const { data } = await supabase.from('invoices').select('invoice_code').eq('client_id', ownerId)
    const usedNumbers = data?.map((item) => {
      const match = item.invoice_code?.match(/\.(\d+)$/)
      return match ? Number(match[1]) : null
    }) || []
    let nextNumber = 1
    while (usedNumbers.includes(nextNumber)) nextNumber++
    setInvoiceCode(`${numStr}.${nextNumber}`)
  }

  function formatMileage(value: string) {
    const clean = value.replace(/[^0-9.]/g, '')
    const partsArr = clean.split('.')
    const intPart = partsArr[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return partsArr.length > 1 ? `${intPart}.${partsArr[1]}` : intPart
  }

  async function createInvoice() {
    if (saving) return
    setSaving(true)
    const row: any = {
      invoice_code: invoiceCode,
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
    }
    if (isClient) row.client_id = ownerId
    else row.ride_id = ownerId

    const { data: invoice, error } = await supabase.from('invoices').insert([row]).select().single()
    if (error || !invoice) { alert(error?.message || 'Error creating invoice'); setSaving(false); return }

    // Seed the default Full Project Labor service so EDIT opens ready to fill.
    await supabase.from('invoice_services').insert([{ invoice_id: invoice.id, description: FULL_PROJECT_LABOR, price: 0 }])

    router.push(`${basePath}/edit/${invoice.id}`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">ADD A NEW INVOICE</h1>
      <p className="text-gray-400 text-xl mb-8">{ownerLabel}{ownerSubtitle ? ` — ${ownerSubtitle}` : ''}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">INVOICE CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        <DatePicker label="HIRING DATE" value={hiringDate} onChange={setHiringDate} />
        <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />

        {!isClient && (
          <div>
            <label className="block mb-2 text-lg font-bold">MILEAGE</label>
            <input type="text" value={mileage} onChange={(e) => setMileage(formatMileage(e.target.value))} className={inputClass} placeholder="0" />
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">SERVICE</label>
          <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={inputClass} placeholder="Service description" />
        </div>

        <button onClick={createInvoice} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
          {saving ? 'CREATING...' : 'CREATE INVOICE'}
        </button>
        <a href={basePath} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
