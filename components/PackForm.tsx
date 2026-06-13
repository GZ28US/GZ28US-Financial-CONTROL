'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

// A performance-package template. Mirrors the pack-relevant content of an invoice
// (totals config + PARTS / SERVICES / EXPENSES / NOTES) plus the set of cars it
// applies to and a DRAFT/CLOSED lifecycle. CLOSED packs are the ones offered for
// import on the new-quote screen.

export type Car = { manufacturer: string; model: string; year: string }
type Part = { description: string; unit_price: string; quantity: string; base_cost: string }
type Service = { description: string; price: string }
type Expense = { supplier: string; item: string; amount: string; tax: string; extra: string; quantity: string; item_discount: string }
type Note = { note: string }

export type PackData = {
  name: string
  status: string
  cars: Car[]
  target_grand_total: number | null
  florida_taxes: number | null
  global_discount: number | null
  import_margin: number | null
  parts: any[]
  services: any[]
  expenses: any[]
  notes: any[]
}

const carKey = (c: { manufacturer?: any; model?: any; year?: any }) =>
  [c.manufacturer, c.model, c.year].map((s) => String(s ?? '').trim().toLowerCase()).join('|')
const carLabel = (c: Car) => [c.manufacturer, c.model, c.year].filter(Boolean).join(' ') || '—'

const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
const numClass = 'bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg'

export default function PackForm({ packId, initial }: { packId?: string; initial?: PackData }) {
  const router = useRouter()

  const [name, setName] = useState(initial?.name || '')
  const [status, setStatus] = useState(initial?.status || 'DRAFT')
  const [cars, setCars] = useState<Car[]>(initial?.cars || [])
  const [targetGrandTotal, setTargetGrandTotal] = useState(initial?.target_grand_total != null ? String(initial.target_grand_total) : '')
  const [floridaTaxes, setFloridaTaxes] = useState(initial?.florida_taxes != null ? String(initial.florida_taxes) : '')
  const [globalDiscount, setGlobalDiscount] = useState(initial?.global_discount != null ? String(initial.global_discount) : '')
  const [importMargin, setImportMargin] = useState(initial?.import_margin != null ? String(initial.import_margin) : '0')

  const [parts, setParts] = useState<Part[]>((initial?.parts || []).map((p: any) => ({ description: p.description || '', unit_price: p.unit_price != null ? String(p.unit_price) : '', quantity: p.quantity != null ? String(p.quantity) : '1', base_cost: p.base_cost != null ? String(p.base_cost) : '' })))
  const [services, setServices] = useState<Service[]>((initial?.services || []).map((s: any) => ({ description: s.description || '', price: s.price != null ? String(s.price) : '' })))
  const [expenses, setExpenses] = useState<Expense[]>((initial?.expenses || []).map((e: any) => ({ supplier: e.supplier || '', item: e.item || '', amount: e.amount != null ? String(e.amount) : '', tax: e.tax != null ? String(e.tax) : '0', extra: e.extra != null ? String(e.extra) : '0', quantity: e.quantity != null ? String(e.quantity) : '1', item_discount: e.item_discount != null ? String(e.item_discount) : '0' })))
  const [notes, setNotes] = useState<Note[]>((initial?.notes || []).map((n: any) => ({ note: n.note || '' })))

  const [availableCars, setAvailableCars] = useState<Car[]>([])
  const [saving, setSaving] = useState(false)

  const locked = status === 'CLOSED'

  useEffect(() => { loadRideCars() }, [])

  // Distinct car specs that already exist on rides, for the car picker.
  async function loadRideCars() {
    const { data } = await supabase.from('rides').select('manufacturer, model, year')
    const seen = new Map<string, Car>()
    ;(data || []).forEach((r: any) => {
      const c: Car = { manufacturer: r.manufacturer || '', model: r.model || '', year: r.year != null ? String(r.year) : '' }
      if (!c.manufacturer && !c.model && !c.year) return
      const k = carKey(c)
      if (!seen.has(k)) seen.set(k, c)
    })
    setAvailableCars([...seen.values()].sort((a, b) => carLabel(a).localeCompare(carLabel(b))))
  }

  function toggleCar(c: Car) {
    const k = carKey(c)
    setCars((prev) => prev.some((x) => carKey(x) === k) ? prev.filter((x) => carKey(x) !== k) : [...prev, c])
  }

  function content() {
    return {
      name: name.trim(),
      cars,
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
    setSaving(true)
    const row: any = { ...content(), status: nextStatus || status, updated_at: new Date().toISOString() }
    const res = packId
      ? await supabase.from('packs').update(row).eq('id', packId)
      : await supabase.from('packs').insert([row])
    if (res.error) { alert(res.error.message); setSaving(false); return }
    router.push(`${BASE_PATH}/packs`)
  }

  return (
    <div className="grid grid-cols-1 gap-6 max-w-4xl">
      <div>
        <label className="block mb-2 text-lg font-bold">PACKAGE NAME</label>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="e.g. Stage 2 Turbo Kit" />
      </div>

      {/* CARS — pick from the specs that already exist on rides. */}
      <div>
        <label className="block mb-2 text-lg font-bold">CARS THIS PACKAGE FITS ({cars.length})</label>
        {availableCars.length === 0 ? (
          <p className="text-gray-500 text-lg">No car specs found on rides yet.</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {availableCars.map((c) => {
              const on = cars.some((x) => carKey(x) === carKey(c))
              return (
                <button key={carKey(c)} onClick={() => !locked && toggleCar(c)} disabled={locked}
                  className={`px-4 py-2 rounded-2xl font-bold text-sm ${on ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'} disabled:opacity-50`}>
                  {carLabel(c)}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* TOTALS CONFIG */}
      <div>
        <label className="block mb-3 text-lg font-bold">TOTALS CONFIG</label>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block mb-1 text-sm text-gray-400 font-bold">TARGET GRAND TOTAL</label>
            <input value={targetGrandTotal} onChange={(e) => setTargetGrandTotal(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="0" />
          </div>
          <div>
            <label className="block mb-1 text-sm text-gray-400 font-bold">FLORIDA TAXES (%)</label>
            <input value={floridaTaxes} onChange={(e) => setFloridaTaxes(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="0" />
          </div>
          <div>
            <label className="block mb-1 text-sm text-gray-400 font-bold">GLOBAL DISCOUNT (%)</label>
            <input value={globalDiscount} onChange={(e) => setGlobalDiscount(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="0" />
          </div>
          <div>
            <label className="block mb-1 text-sm text-gray-400 font-bold">IMPORT MARGIN (%)</label>
            <input value={importMargin} onChange={(e) => setImportMargin(e.target.value)} disabled={locked} className={`${inputClass} disabled:opacity-50`} placeholder="0" />
          </div>
        </div>
      </div>

      {/* PARTS */}
      <div>
        <label className="block mb-3 text-lg font-bold">PARTS ({parts.length})</label>
        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input value={p.description} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} disabled={locked} className={`${numClass} flex-1 disabled:opacity-50`} placeholder="Description" />
              <input value={p.quantity} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} disabled={locked} className={`${numClass} w-20 disabled:opacity-50`} placeholder="Qty" />
              <input value={p.unit_price} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, unit_price: e.target.value } : x))} disabled={locked} className={`${numClass} w-28 disabled:opacity-50`} placeholder="Unit $" />
              <input value={p.base_cost} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, base_cost: e.target.value } : x))} disabled={locked} className={`${numClass} w-28 disabled:opacity-50`} placeholder="Cost $" />
              {!locked && <button onClick={() => setParts(parts.filter((_, j) => j !== i))} className="bg-red-700 hover:bg-red-600 px-3 py-3 rounded-2xl font-bold">✕</button>}
            </div>
          ))}
        </div>
        {!locked && <button onClick={() => setParts([...parts, { description: '', unit_price: '', quantity: '1', base_cost: '' }])} className="mt-2 bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD ITEM</button>}
      </div>

      {/* SERVICES */}
      <div>
        <label className="block mb-3 text-lg font-bold">SERVICES ({services.length})</label>
        <div className="space-y-2">
          {services.map((s, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input value={s.description} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} disabled={locked} className={`${numClass} flex-1 disabled:opacity-50`} placeholder="Description" />
              <input value={s.price} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} disabled={locked} className={`${numClass} w-28 disabled:opacity-50`} placeholder="Price $" />
              {!locked && <button onClick={() => setServices(services.filter((_, j) => j !== i))} className="bg-red-700 hover:bg-red-600 px-3 py-3 rounded-2xl font-bold">✕</button>}
            </div>
          ))}
        </div>
        {!locked && <button onClick={() => setServices([...services, { description: '', price: '' }])} className="mt-2 bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD SERVICE</button>}
      </div>

      {/* EXPENSES */}
      <div>
        <label className="block mb-3 text-lg font-bold">EXPENSES ({expenses.length})</label>
        <div className="space-y-2">
          {expenses.map((e, i) => (
            <div key={i} className="flex gap-2 items-center flex-wrap">
              <input value={e.supplier} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, supplier: ev.target.value } : x))} disabled={locked} className={`${numClass} w-40 disabled:opacity-50`} placeholder="Supplier" />
              <input value={e.item} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, item: ev.target.value } : x))} disabled={locked} className={`${numClass} flex-1 min-w-40 disabled:opacity-50`} placeholder="Item" />
              <input value={e.quantity} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, quantity: ev.target.value } : x))} disabled={locked} className={`${numClass} w-16 disabled:opacity-50`} placeholder="Qty" />
              <input value={e.amount} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, amount: ev.target.value } : x))} disabled={locked} className={`${numClass} w-24 disabled:opacity-50`} placeholder="Amount $" />
              <input value={e.tax} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, tax: ev.target.value } : x))} disabled={locked} className={`${numClass} w-20 disabled:opacity-50`} placeholder="Tax $" />
              <input value={e.extra} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, extra: ev.target.value } : x))} disabled={locked} className={`${numClass} w-20 disabled:opacity-50`} placeholder="Extra $" />
              <input value={e.item_discount} onChange={(ev) => setExpenses(expenses.map((x, j) => j === i ? { ...x, item_discount: ev.target.value } : x))} disabled={locked} className={`${numClass} w-24 disabled:opacity-50`} placeholder="Disc $" />
              {!locked && <button onClick={() => setExpenses(expenses.filter((_, j) => j !== i))} className="bg-red-700 hover:bg-red-600 px-3 py-3 rounded-2xl font-bold">✕</button>}
            </div>
          ))}
        </div>
        {!locked && <button onClick={() => setExpenses([...expenses, { supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', item_discount: '0' }])} className="mt-2 bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>}
      </div>

      {/* NOTES */}
      <div>
        <label className="block mb-3 text-lg font-bold">NOTES ({notes.length})</label>
        <div className="space-y-2">
          {notes.map((n, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input value={n.note} onChange={(e) => setNotes(notes.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} disabled={locked} className={`${numClass} flex-1 disabled:opacity-50`} placeholder="Note" />
              {!locked && <button onClick={() => setNotes(notes.filter((_, j) => j !== i))} className="bg-red-700 hover:bg-red-600 px-3 py-3 rounded-2xl font-bold">✕</button>}
            </div>
          ))}
        </div>
        {!locked && <button onClick={() => setNotes([...notes, { note: '' }])} className="mt-2 bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD NOTE</button>}
      </div>

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
