'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { carData, yearsForSpec, carLabel } from '@/lib/carData'

// A performance-package template. Mirrors the pack-relevant content of an invoice
// (totals config + PARTS / SERVICES / EXPENSES / NOTES) plus the set of cars it
// applies to and a DRAFT/CLOSED lifecycle. CLOSED packs are the ones offered for
// import on the new-quote screen.

export type Car = { manufacturer: string; brand: string; model: string; version: string; years: number[] }
type Part = { description: string; unit_price: string; quantity: string; base_cost: string }
type Service = { description: string; price: string }
type Expense = { supplier: string; item: string; amount: string; tax: string; extra: string; quantity: string; item_discount: string }
type Note = { note: string }

export type PackData = {
  name: string
  status: string
  cars: any[]
  target_grand_total: number | null
  florida_taxes: number | null
  global_discount: number | null
  import_margin: number | null
  parts: any[]
  services: any[]
  expenses: any[]
  notes: any[]
}

// Cascade option lists, derived from the nested carData[manufacturer][brand][model] = versions map.
const MANUFACTURERS = Object.keys(carData)
const brandsFor = (m: string) => (m && carData[m] ? Object.keys(carData[m]) : [])
const modelsFor = (m: string, b: string) => (m && b && carData[m]?.[b] ? Object.keys(carData[m][b]) : [])
const versionsFor = (m: string, b: string, mo: string) => (m && b && mo ? (carData[m]?.[b]?.[mo] || []) : [])

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
const numClass = 'bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

export default function PackForm({ packId, initial }: { packId?: string; initial?: PackData }) {
  const router = useRouter()

  const [cars, setCars] = useState<Car[]>((initial?.cars || []).map((c: any) => ({
    manufacturer: c.manufacturer || '', brand: c.brand || '', model: c.model || '', version: c.version || '',
    years: Array.isArray(c.years) ? c.years.map(Number) : (c.year != null && c.year !== '' ? [Number(c.year)] : []),
  })))

  // The car currently being assembled in the cascade.
  const [bMan, setBMan] = useState('')
  const [bBrand, setBBrand] = useState('')
  const [bModel, setBModel] = useState('')
  const [bVersion, setBVersion] = useState('')
  const [bYears, setBYears] = useState<number[]>([])

  const [name, setName] = useState(initial?.name || '')
  const [status, setStatus] = useState(initial?.status || 'DRAFT')
  const [targetGrandTotal, setTargetGrandTotal] = useState(initial?.target_grand_total != null ? String(initial.target_grand_total) : '')
  const [floridaTaxes, setFloridaTaxes] = useState(initial?.florida_taxes != null ? String(initial.florida_taxes) : '')
  const [globalDiscount, setGlobalDiscount] = useState(initial?.global_discount != null ? String(initial.global_discount) : '')
  const [importMargin, setImportMargin] = useState(initial?.import_margin != null ? String(initial.import_margin) : '0')

  const [parts, setParts] = useState<Part[]>((initial?.parts || []).map((p: any) => ({ description: p.description || '', unit_price: p.unit_price != null ? String(p.unit_price) : '', quantity: p.quantity != null ? String(p.quantity) : '1', base_cost: p.base_cost != null ? String(p.base_cost) : '' })))
  const [services, setServices] = useState<Service[]>((initial?.services || []).map((s: any) => ({ description: s.description || '', price: s.price != null ? String(s.price) : '' })))
  const [expenses, setExpenses] = useState<Expense[]>((initial?.expenses || []).map((e: any) => ({ supplier: e.supplier || '', item: e.item || '', amount: e.amount != null ? String(e.amount) : '', tax: e.tax != null ? String(e.tax) : '0', extra: e.extra != null ? String(e.extra) : '0', quantity: e.quantity != null ? String(e.quantity) : '1', item_discount: e.item_discount != null ? String(e.item_discount) : '0' })))
  const [notes, setNotes] = useState<Note[]>((initial?.notes || []).map((n: any) => ({ note: n.note || '' })))

  const [saving, setSaving] = useState(false)
  const locked = status === 'CLOSED'

  // START FROM: when creating a NEW pack, offer the CLOSED packs that already fit
  // the picked cars so the user can copy one and tweak it (same pack + additions).
  const [closedPacks, setClosedPacks] = useState<any[]>([])
  const [startFrom, setStartFrom] = useState('')

  const builderYears = (bMan && bBrand && bModel && bVersion) ? yearsForSpec(bMan, bBrand, bModel, bVersion) : []
  const pendingComplete = !!(bMan && bBrand && bModel && bVersion && bYears.length)

  // Cascade selectors reset everything downstream.
  function pickMan(m: string) { setBMan(m); setBBrand(''); setBModel(''); setBVersion(''); setBYears([]) }
  function pickBrand(b: string) { setBBrand(b); setBModel(''); setBVersion(''); setBYears([]) }
  function pickModel(mo: string) { setBModel(mo); setBVersion(''); setBYears([]) }
  function pickVersion(v: string) { setBVersion(v); setBYears([]) }
  function toggleYear(y: number) { setBYears((prev) => prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y]) }
  function resetBuilder() { setBMan(''); setBBrand(''); setBModel(''); setBVersion(''); setBYears([]) }

  function addCar() {
    if (!pendingComplete) return
    setCars((prev) => [...prev, { manufacturer: bMan, brand: bBrand, model: bModel, version: bVersion, years: [...bYears].sort((a, b) => a - b) }])
    resetBuilder()
  }

  // ---- START FROM an existing CLOSED pack (new-pack mode only) ----
  useEffect(() => {
    if (packId) return
    supabase.from('packs').select('*').eq('status', 'CLOSED').order('name').then(({ data }) => setClosedPacks(data || []))
  }, [packId])

  const nrm = (s: any) => String(s ?? '').trim().toLowerCase()
  const eqv = (a: any, b: any) => nrm(a) === nrm(b)
  // Does a pack car entry cover one of the user's picked car+year specs?
  function carEntryCovers(c: any, spec: { manufacturer: string; brand: string; model: string; version: string; year: any }) {
    if (Array.isArray(c?.years)) {
      if (c.manufacturer && !eqv(c.manufacturer, spec.manufacturer)) return false
      if (c.brand && !eqv(c.brand, spec.brand)) return false
      if (c.model && !eqv(c.model, spec.model)) return false
      if (c.version && !eqv(c.version, spec.version)) return false
      return c.years.map(Number).includes(Number(spec.year))
    }
    return eqv(c?.manufacturer, spec.manufacturer) && eqv(c?.model, spec.model) && eqv(c?.year, spec.year)
  }
  // Match against the added cars PLUS a fully-filled-but-not-yet-added one, so the
  // dropdown appears as soon as the cascade is complete (before "+ ADD ANOTHER CAR").
  const effectiveCars = pendingComplete
    ? [...cars, { manufacturer: bMan, brand: bBrand, model: bModel, version: bVersion, years: bYears }]
    : cars
  // CLOSED packs that fit at least one of those cars.
  const matchingPacks = packId ? [] : closedPacks.filter((p) => {
    const carList = Array.isArray(p.cars) && p.cars.length ? p.cars : [{ manufacturer: p.manufacturer, model: p.model, year: p.year }]
    return effectiveCars.some((uc) => (uc.years.length ? uc.years : [undefined]).some((y) =>
      carList.some((c: any) => carEntryCovers(c, { manufacturer: uc.manufacturer, brand: uc.brand, model: uc.model, version: uc.version, year: y }))))
  })

  // Copy a chosen pack's whole content into the form (cars stay as the user picked).
  function applyStartFrom(id: string) {
    setStartFrom(id)
    const p = closedPacks.find((x) => x.id === id)
    if (!p) return
    setName(p.name || '')
    setTargetGrandTotal(p.target_grand_total != null ? String(p.target_grand_total) : '')
    setFloridaTaxes(p.florida_taxes != null ? String(p.florida_taxes) : '')
    setGlobalDiscount(p.global_discount != null ? String(p.global_discount) : '')
    setImportMargin(p.import_margin != null ? String(p.import_margin) : '0')
    setParts((p.parts || []).map((x: any) => ({ description: x.description || '', unit_price: x.unit_price != null ? String(x.unit_price) : '', quantity: x.quantity != null ? String(x.quantity) : '1', base_cost: x.base_cost != null ? String(x.base_cost) : '' })))
    setServices((p.services || []).map((x: any) => ({ description: x.description || '', price: x.price != null ? String(x.price) : '' })))
    setExpenses((p.expenses || []).map((x: any) => ({ supplier: x.supplier || '', item: x.item || '', amount: x.amount != null ? String(x.amount) : '', tax: x.tax != null ? String(x.tax) : '0', extra: x.extra != null ? String(x.extra) : '0', quantity: x.quantity != null ? String(x.quantity) : '1', item_discount: x.item_discount != null ? String(x.item_discount) : '0' })))
    setNotes((p.notes || []).map((x: any) => ({ note: x.note || '' })))
  }

  function content(finalCars: Car[]) {
    return {
      name: name.trim(),
      cars: finalCars,
      target_grand_total: targetGrandTotal ? parseFloat(targetGrandTotal.replace(/,/g, '')) : null,
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
      import_margin: parseFloat(importMargin) || 0,
      parts: parts.filter((p) => p.description.trim()).map((p) => ({ description: p.description.trim(), unit_price: parseFloat(p.unit_price) || 0, quantity: parseFloat(p.quantity) || 0, base_cost: p.base_cost !== '' ? parseFloat(p.base_cost) : null })),
      services: services.filter((s) => s.description.trim()).map((s) => ({ description: s.description.trim(), price: parseFloat(s.price) || 0 })),
      expenses: expenses.filter((e) => e.item.trim()).map((e) => ({ supplier: e.supplier.trim(), item: e.item.trim(), amount: parseFloat(e.amount) || 0, tax: parseFloat(e.tax) || 0, extra: parseFloat(e.extra) || 0, quantity: parseFloat(e.quantity) || 1, item_discount: parseFloat(e.item_discount) || 0 })),
      notes: notes.filter((n) => n.note.trim()).map((n) => ({ note: n.note.trim() })),
    }
  }

  async function save(nextStatus?: string) {
    if (saving) return
    if (!name.trim()) { alert('Give the package a name.'); return }
    // Fold a complete-but-not-yet-added car into the list so it isn't lost on save.
    const finalCars = pendingComplete ? [...cars, { manufacturer: bMan, brand: bBrand, model: bModel, version: bVersion, years: [...bYears].sort((a, b) => a - b) }] : cars
    setSaving(true)
    const row: any = { ...content(finalCars), status: nextStatus || status, updated_at: new Date().toISOString() }
    const res = packId
      ? await supabase.from('packs').update(row).eq('id', packId)
      : await supabase.from('packs').insert([row])
    if (res.error) { alert(res.error.message); setSaving(false); return }
    router.push('/packs')
  }

  return (
    <div className="grid grid-cols-1 gap-6 max-w-4xl">

      {/* CARS — the first area: manufacturer -> brand -> model -> version -> years cascade. */}
      <div>
        <label className="block mb-3 text-lg font-bold">CARS THIS PACKAGE FITS ({cars.length})</label>

        {cars.length > 0 && (
          <div className="space-y-2 mb-4">
            {cars.map((c, i) => (
              <div key={i} className="flex items-center justify-between gap-3 bg-gray-900 border border-gray-800 rounded-2xl px-4 py-3">
                <span className="text-lg">{carLabel(c)}</span>
                {!locked && <button onClick={() => setCars(cars.filter((_, j) => j !== i))} className="bg-red-700 hover:bg-red-600 px-3 py-2 rounded-2xl font-bold">✕</button>}
              </div>
            ))}
          </div>
        )}

        {!locked && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-3xl p-5 space-y-4">
            <div>
              <p className="mb-2 text-sm text-gray-400 font-bold">MANUFACTURER</p>
              <div className="flex gap-2 flex-wrap">
                {MANUFACTURERS.map((m) => <button key={m} onClick={() => pickMan(m)} className={chip(bMan === m)}>{m}</button>)}
              </div>
            </div>

            {bMan && (
              <div>
                <p className="mb-2 text-sm text-gray-400 font-bold">BRAND</p>
                <div className="flex gap-2 flex-wrap">
                  {brandsFor(bMan).map((b) => <button key={b} onClick={() => pickBrand(b)} className={chip(bBrand === b)}>{b}</button>)}
                </div>
              </div>
            )}

            {bBrand && (
              <div>
                <p className="mb-2 text-sm text-gray-400 font-bold">MODEL</p>
                <div className="flex gap-2 flex-wrap">
                  {modelsFor(bMan, bBrand).map((mo) => <button key={mo} onClick={() => pickModel(mo)} className={chip(bModel === mo)}>{mo}</button>)}
                </div>
              </div>
            )}

            {bModel && (
              <div>
                <p className="mb-2 text-sm text-gray-400 font-bold">VERSION</p>
                <div className="flex gap-2 flex-wrap">
                  {versionsFor(bMan, bBrand, bModel).map((v) => <button key={v} onClick={() => pickVersion(v)} className={chip(bVersion === v)}>{v}</button>)}
                </div>
              </div>
            )}

            {bVersion && (
              <div>
                <p className="mb-2 text-sm text-gray-400 font-bold">YEARS (pick as many as you want)</p>
                <div className="flex gap-2 flex-wrap">
                  {builderYears.map((y) => <button key={y} onClick={() => toggleYear(y)} className={chip(bYears.includes(y))}>{y}</button>)}
                </div>
              </div>
            )}

            {pendingComplete && (
              <button onClick={addCar} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold">+ ADD ANOTHER CAR</button>
            )}
          </div>
        )}
      </div>

      {/* START FROM — offered only when the picked cars already have CLOSED packs. */}
      {!packId && matchingPacks.length > 0 && (
        <div>
          <label className="block mb-2 text-lg font-bold">START FROM</label>
          <select value={startFrom} onChange={(e) => applyStartFrom(e.target.value)} className={inputClass}>
            <option value="">— none (build from scratch) —</option>
            {matchingPacks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="text-gray-500 text-sm mt-1">These CLOSED packs already fit the car(s) you picked. Choose one to copy all its content here as a starting point, then tweak it.</p>
        </div>
      )}

      <div>
        <label className="block mb-2 text-lg font-bold">PACKAGE NAME</label>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="e.g. Stage 2 Turbo Kit" />
      </div>

      {/* Totals config, parts, services, expenses & notes live on the EDIT page —
          the NEW form only captures the cars this pack fits and its name. */}

      {/* ACTIONS */}
      <div className="flex gap-4 flex-wrap items-center pt-2">
        {locked ? (
          <>
            <span className="px-4 py-2 rounded-full text-sm font-bold bg-green-700 text-white">CLOSED — locked</span>
            <button onClick={() => save('DRAFT')} disabled={saving} className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">REOPEN (back to DRAFT)</button>
          </>
        ) : (
          <>
            <button onClick={() => save()} disabled={saving} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{saving ? 'SAVING...' : 'SAVE DRAFT'}</button>
            <button onClick={() => save('CLOSED')} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{saving ? 'SAVING...' : 'CLOSE (lock as template)'}</button>
          </>
        )}
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
      </div>
    </div>
  )
}
