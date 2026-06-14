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
  // DUPLICATE QUOTE: arrives via ?duplicateFrom=<sourceInvoiceId>. We copy that
  // quote's config + items/services/expenses/notes onto a brand-new quote for the
  // picked ride and jump straight to EDIT — no NEW form is shown.
  const [duplicating, setDuplicating] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      setIsQuote(sp.get('mode') === 'quote')
      const dup = sp.get('duplicateFrom')
      if (dup) { setDuplicating(true); void duplicateQuote(dup); return }
    }
    loadOwner()
  }, [])

  // Copy an existing quote in full onto a new quote for this ride, then open EDIT.
  async function duplicateQuote(sourceId: string) {
    let createdId: string | null = null
    try {
      const { data: ride } = await supabase.from('rides').select('project_code').eq('id', ownerId).single()
      const code = ride?.project_code || ''
      const { data: existing } = await supabase.from('invoices').select('invoice_code').eq('ride_id', ownerId)
      const used = (existing || []).map((i: any) => { const m = i.invoice_code?.match(/\.(\d+)$/); return m ? Number(m[1]) : null })
      let n = 1; while (used.includes(n)) n++
      const newCode = `${code}.${n}`

      const { data: src } = await supabase.from('invoices').select('*').eq('id', sourceId).single()
      if (!src) { alert('Source quote not found.'); router.back(); return }

      const row: any = {
        invoice_code: newCode,
        ride_id: ownerId,
        is_quote: true,
        target_grand_total: src.target_grand_total ?? null,
        florida_taxes: src.florida_taxes ?? null,
        global_discount: src.global_discount ?? null,
        import_margin: src.import_margin ?? 0,
        service: src.service ?? null,
        // Fresh document: no dates, no payment, not report-ready.
        hiring_date: null, entry_date: null, conclusion_date: null, delivery_date: null,
        mileage: null, fl_tax_expense_date: null,
        live_status: 'INCOMPLETE', feed_status: 'INCOMPLETE',
      }
      const { data: inv, error } = await supabase.from('invoices').insert([row]).select().single()
      if (error || !inv) { alert(error?.message || 'Error duplicating quote'); router.back(); return }
      createdId = inv.id

      // Copy children with EXPLICIT, insertable columns only. invoice_parts.total is
      // a generated column and updated_at is server-managed — copying them verbatim
      // makes PostgREST reject the whole insert (which is why items went missing).
      const { data: parts } = await supabase.from('invoice_parts').select('*').eq('invoice_id', sourceId).order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
      const partRows = (parts || []).map((p: any) => ({
        invoice_id: inv.id, description: p.description, unit_price: p.unit_price, quantity: p.quantity,
        base_cost: p.base_cost, position: p.position, kit_group: p.kit_group, kit_name: p.kit_name,
        source_item: p.source_item, payment_date: null,
      }))
      if (partRows.length) { const { error: pe } = await supabase.from('invoice_parts').insert(partRows); if (pe) throw new Error('items: ' + pe.message) }

      const { data: svcs } = await supabase.from('invoice_services').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      let svcRows = (svcs || []).map((s: any) => ({ invoice_id: inv.id, description: s.description, price: s.price }))
      if (!svcRows.length) svcRows = [{ invoice_id: inv.id, description: FULL_PROJECT_LABOR, price: 0 }]
      { const { error: se } = await supabase.from('invoice_services').insert(svcRows); if (se) throw new Error('services: ' + se.message) }

      const { data: exps } = await supabase.from('invoice_expenses').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      const expRows = (exps || []).map((e: any) => ({
        invoice_id: inv.id, expense_date: null, supplier: e.supplier, item: e.item, price: e.price,
        tax: e.tax, extra: e.extra, quantity: e.quantity, item_discount: e.item_discount, part_number: e.part_number,
        export_status: e.export_status || 'FRESH', purchase_group: e.purchase_group, kit_group: e.kit_group,
        kit_name: e.kit_name, stock_source_type: e.stock_source_type, stock_donor: e.stock_donor,
        payment_date: null, receipt_url: null,
      }))
      if (expRows.length) { const { error: ee } = await supabase.from('invoice_expenses').insert(expRows); if (ee) throw new Error('expenses: ' + ee.message) }

      const { data: notes } = await supabase.from('invoice_notes').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      const noteRows = (notes || []).map((nt: any) => ({ invoice_id: inv.id, note: nt.note }))
      if (noteRows.length) { const { error: ne } = await supabase.from('invoice_notes').insert(noteRows); if (ne) throw new Error('notes: ' + ne.message) }

      router.replace(`${basePath}/edit/${inv.id}`)
    } catch (err) {
      // Roll back the half-created copy so a failed duplicate leaves nothing behind.
      if (createdId) { await supabase.from('invoices').delete().eq('id', createdId) }
      alert('Could not duplicate the quote:\n' + String(err))
      router.back()
    }
  }

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
      const { data: ride } = await supabase.from('rides').select('project_code, project_name, manufacturer, brand, model, version, year').eq('id', ownerId).single()
      if (ride) {
        setOwnerLabel(ride.project_code || '')
        setOwnerSubtitle(ride.project_name || '')
        await loadNextRideInvoiceCode(ride.project_code)
        await loadPacks({ manufacturer: ride.manufacturer || '', brand: ride.brand || '', model: ride.model || '', version: ride.version || '', year: ride.year != null ? String(ride.year) : '' })
      }
    }
  }

  // CLOSED packs that fit this ride's car, surfaced in the SERVICE dropdown so a
  // performance package can pre-fill the new quote/invoice.
  async function loadPacks(ride: { manufacturer: string; brand: string; model: string; version: string; year: string }) {
    const { data } = await supabase.from('packs').select('*').order('name')
    const norm = (s: any) => String(s ?? '').trim().toLowerCase()
    const eq = (a: any, b: any) => norm(a) === norm(b)
    // A car entry matches the ride. New shape carries brand/version + a years[]
    // list; only fields the entry actually specifies are required to match.
    const carMatches = (c: any) => {
      if (Array.isArray(c?.years)) {
        if (c.manufacturer && !eq(c.manufacturer, ride.manufacturer)) return false
        if (c.brand && !eq(c.brand, ride.brand)) return false
        if (c.model && !eq(c.model, ride.model)) return false
        if (c.version && !eq(c.version, ride.version)) return false
        return c.years.map(Number).includes(Number(ride.year))
      }
      // Legacy shape {manufacturer, model, year}.
      return eq(c?.manufacturer, ride.manufacturer) && eq(c?.model, ride.model) && eq(c?.year, ride.year)
    }
    const matched = (data || []).filter((p: any) => {
      if ((p.status || 'DRAFT') !== 'CLOSED') return false
      const carList = Array.isArray(p.cars) && p.cars.length ? p.cars : [{ manufacturer: p.manufacturer, model: p.model, year: p.year }]
      return carList.some(carMatches)
    })
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
    // Applying a pack copies its totals config onto the new invoice. Florida taxes
    // is NOT carried — a quote/invoice starts with no FL tax; the user adds it if wanted.
    if (pack) {
      row.target_grand_total = pack.target_grand_total ?? null
      row.florida_taxes = null
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
      kit_group: p.kit_group || null,
      kit_name: p.kit_name || null,
      source_item: p.source_item || null,
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
      // Carry the template's export status so already-exported expenses don't
      // re-import into ITEMS (which would duplicate items already copied in).
      export_status: e.export_status || 'FRESH',
      kit_group: e.kit_group || null,
      kit_name: e.kit_name || null,
    }))
    if (expenseRows.length > 0) await supabase.from('invoice_expenses').insert(expenseRows)

    const noteRows = (pack.notes || []).map((n: any) => ({ invoice_id: invoiceId, note: n.note }))
    if (noteRows.length > 0) await supabase.from('invoice_notes').insert(noteRows)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const noun = isQuote ? 'QUOTE' : 'INVOICE'

  if (duplicating) return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <p className="text-2xl text-gray-400">Duplicating quote…</p>
    </main>
  )

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
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
      </div>
    </main>
  )
}
