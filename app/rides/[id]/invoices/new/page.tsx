'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const FULL_PROJECT_LABOR = 'Full Project Labor'

type Pack = {
  id: string
  name: string
  target_grand_total: number | null
  florida_taxes: number | null
  global_discount: number | null
  import_margin: number | null
  parts: any[]
  services: any[]
  expenses: any[]
  notes: any[]
}

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// Client numbers display/store zero-padded to 3 digits (e.g. 9 -> "009").
function pad3(n: number | string) {
  const num = typeof n === 'number' ? n : parseInt(String(n), 10)
  return isNaN(num) ? String(n) : String(num).padStart(3, '0')
}

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
  // Quote mode arrives via ?mode=quote (the ADD A NEW QUOTE button on the list).
  // Read from window rather than useSearchParams to avoid the Suspense build
  // requirement on this client page.
  const [isQuote, setIsQuote] = useState(false)
  // Ride-only: saved packs for this car spec, and which one (if any) is chosen.
  // selectedPackId: '' = none, '__new__' = naming a brand-new pack, else a pack id.
  const [packs, setPacks] = useState<Pack[]>([])
  const [selectedPackId, setSelectedPackId] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsQuote(new URLSearchParams(window.location.search).get('mode') === 'quote')
    }
    loadOwner()
  }, [])

  async function loadOwner() {
    if (isClient) {
      const { data: client } = await supabase.from('clients').select('name, client_number').eq('id', ownerId).single()
      if (client) {
        const numStr = client.client_number != null ? pad3(client.client_number) : ''
        setOwnerLabel(numStr)
        setOwnerSubtitle(client.name || '')
        await loadNextClientInvoiceCode(numStr)
      }
    } else {
      const { data: ride } = await supabase.from('rides').select('project_code, project_name, manufacturer, model, year').eq('id', ownerId).single()
      if (ride) {
        setOwnerLabel(ride.project_code || '')
        setOwnerSubtitle(ride.project_name || '')
        await loadNextRideInvoiceCode(ride.project_code)
        await loadPacks(ride.manufacturer || '', ride.model || '', ride.year != null ? String(ride.year) : '')
      }
    }
  }

  // Packs registered for this exact car spec (manufacturer + model + year),
  // surfaced in the SERVICE dropdown so a past build can pre-fill a new invoice.
  async function loadPacks(manufacturer: string, model: string, year: string) {
    const { data } = await supabase.from('packs').select('*').order('name')
    const norm = (s: any) => String(s ?? '').trim().toLowerCase()
    const matched = (data || []).filter((p: any) =>
      norm(p.manufacturer) === norm(manufacturer) &&
      norm(p.model) === norm(model) &&
      norm(p.year) === norm(year))
    setPacks(matched as Pack[])
  }

  function onPackSelect(value: string) {
    setSelectedPackId(value)
    if (value === '__new__' || value === '') setService('')
    else setService(packs.find(p => p.id === value)?.name || '')
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
    // A real pack is selected when selectedPackId is a pack id (not '' / '__new__').
    const pack = packs.find(p => p.id === selectedPackId) || null
    const row: any = {
      invoice_code: invoiceCode,
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
      // Quote until a HIRING DATE is set; filling it at creation makes it an invoice immediately.
      is_quote: isQuote && !isValidDate(hiringDate),
    }
    // Applying a pack copies its totals config onto the new invoice.
    if (pack) {
      row.target_grand_total = pack.target_grand_total ?? null
      row.florida_taxes = pack.florida_taxes ?? null
      row.global_discount = pack.global_discount ?? null
      row.import_margin = pack.import_margin ?? 0
    }
    if (isClient) row.client_id = ownerId
    else row.ride_id = ownerId

    const { data: invoice, error } = await supabase.from('invoices').insert([row]).select().single()
    if (error || !invoice) { alert(error?.message || `Error creating ${isQuote ? 'quote' : 'invoice'}`); setSaving(false); return }

    if (pack) {
      await applyPack(invoice.id, pack)
    } else {
      // Seed the default Full Project Labor service so EDIT opens ready to fill.
      await supabase.from('invoice_services').insert([{ invoice_id: invoice.id, description: FULL_PROJECT_LABOR, price: 0 }])
    }

    router.push(`${basePath}/edit/${invoice.id}`)
  }

  // Copy a pack's PARTS / SERVICES / EXPENSES / NOTES onto the new invoice. All
  // dates are cleared and nothing is marked paid (no payments, no payment_date,
  // no fl_tax_expense_date) — the applied pack is a fresh, unpaid starting point.
  async function applyPack(invoiceId: string, pack: Pack) {
    const partRows = (pack.parts || []).map((p: any) => ({
      invoice_id: invoiceId,
      description: p.description,
      unit_price: Number(p.unit_price) || 0,
      quantity: Number(p.quantity) || 0,
      base_cost: (p.base_cost != null && p.base_cost !== '') ? Number(p.base_cost) : null,
    }))
    if (partRows.length > 0) await supabase.from('invoice_parts').insert(partRows)

    let serviceRows = (pack.services || []).map((s: any) => ({ invoice_id: invoiceId, description: s.description, price: Number(s.price) || 0 }))
    // Always keep a Full Project Labor row so EDIT's auto-CALCULATE has its anchor.
    if (serviceRows.length === 0) serviceRows = [{ invoice_id: invoiceId, description: FULL_PROJECT_LABOR, price: 0 }]
    await supabase.from('invoice_services').insert(serviceRows)

    const expenseRows = (pack.expenses || []).map((e: any) => ({
      invoice_id: invoiceId,
      expense_date: null,
      supplier: e.supplier || null,
      item: e.item,
      price: Number(e.amount) || 0,
      tax: Number(e.tax) || 0,
      extra: Number(e.extra) || 0,
      quantity: Number(e.quantity) || 1,
      item_discount: Number(e.item_discount) || 0,
      payment_date: null,
      receipt_url: null,
      export_status: 'FRESH',
    }))
    if (expenseRows.length > 0) await supabase.from('invoice_expenses').insert(expenseRows)

    const noteRows = (pack.notes || []).map((n: any) => ({ invoice_id: invoiceId, note: n.note }))
    if (noteRows.length > 0) await supabase.from('invoice_notes').insert(noteRows)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const noun = isQuote ? 'QUOTE' : 'INVOICE'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">ADD A NEW {noun}</h1>
      <p className="text-gray-400 text-xl mb-8">{ownerLabel}{ownerSubtitle ? ` — ${ownerSubtitle}` : ''}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">{noun} CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        {/* Shopping invoices use REQUEST DATE; ride invoices keep HIRING DATE. */}
        <DatePicker label={isClient ? 'REQUEST DATE' : 'HIRING DATE'} value={hiringDate} onChange={setHiringDate} />

        {/* ENTRY DATE is ride-only (a car physically entering the shop). */}
        {!isClient && (
          <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />
        )}

        {!isClient && (
          <div>
            <label className="block mb-2 text-lg font-bold">MILEAGE</label>
            <input type="text" value={mileage} onChange={(e) => setMileage(formatMileage(e.target.value))} className={inputClass} placeholder="0" />
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">{isClient ? 'PURCHASE' : 'SERVICE'}</label>
          {isClient ? (
            <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={inputClass} placeholder="Purchase description" />
          ) : (
            <>
              {/* Ride SERVICE: pick a saved pack for this car, or "new one" to name a new pack. */}
              <select value={selectedPackId} onChange={(e) => onPackSelect(e.target.value)} className={inputClass}>
                <option value="">— Select a pack / new one —</option>
                {packs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="__new__">new one</option>
              </select>
              {selectedPackId === '__new__' && (
                <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={`${inputClass} mt-3`} placeholder="New service / pack name" autoFocus />
              )}
            </>
          )}
        </div>

        <button onClick={createInvoice} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
          {saving ? 'CREATING...' : `CREATE ${noun}`}
        </button>
        <a href={`${BASE_PATH}${basePath}`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
