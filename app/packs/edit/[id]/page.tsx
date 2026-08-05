'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH, partMatches, partStatusBadge } from '@/lib/utils'
import { carData, yearsForSpec, carLabel } from '@/lib/carData'
import { normPN } from '@/lib/partsDb'

// FULL pack editor — a standalone page that mirrors the invoice editor's item
// machinery (EXPENSES + PARTS + SERVICES + GRAND TOTAL + NOTES, auto-CALCULATE,
// live import-margin re-pricer) for a TEMPLATE pack. Box order matches the invoice
// edit page (EXPENSES first). Persists to the `packs` JSONB columns (no child
// tables). No dates / payments / reports / inventory moves. Kept deliberately
// separate from the invoice editor; changes meant for both go in both by hand.

type Car = { manufacturer: string; brand: string; model: string; version: string; years: number[] }
type Part = { description: string; unit_price: string; quantity: string; base_cost?: string; kit_group?: string; kit_name?: string; source_item?: string }
type Service = { description: string; price: string }
type Expense = { supplier: string; item: string; part_number?: string; amount: string; tax: string; extra: string; quantity: string; item_discount: string; export_status?: string; kit_group?: string; kit_name?: string }
type Note = { note: string }

const FULL_PROJECT_LABOR = 'Full Project Labor'
// Extra/charge rows never import into PARTS (shipping, tax, handling, etc.).
const SKIP_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i
function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }

const MANUFACTURERS = Object.keys(carData)
const brandsFor = (m: string) => (m && carData[m] ? Object.keys(carData[m]) : [])
const modelsFor = (m: string, b: string) => (m && b && carData[m]?.[b] ? Object.keys(carData[m][b]) : [])
const versionsFor = (m: string, b: string, mo: string) => (m && b && mo ? (carData[m]?.[b]?.[mo] || []) : [])

const inputClass = 'w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg disabled:opacity-50'
const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg disabled:opacity-50'
const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

export default function EditPackPage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params.id || '')

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [status, setStatus] = useState('DRAFT')
  const [cars, setCars] = useState<Car[]>([])
  const locked = status === 'CLOSED'

  const [bMan, setBMan] = useState(''); const [bBrand, setBBrand] = useState('')
  const [bModel, setBModel] = useState(''); const [bVersion, setBVersion] = useState('')
  const [bYears, setBYears] = useState<number[]>([])

  const [targetGrandTotal, setTargetGrandTotal] = useState('')
  const [floridaTaxes, setFloridaTaxes] = useState('')
  const [globalDiscount, setGlobalDiscount] = useState('')
  const [importMargin, setImportMargin] = useState('')

  const [parts, setParts] = useState<Part[]>([])
  const [newPart, setNewPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [editingPartIndex, setEditingPartIndex] = useState<number | null>(null)
  const [editingPart, setEditingPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })

  const [services, setServices] = useState<Service[]>([])
  const [newService, setNewService] = useState<Service>({ description: '', price: '' })
  const [editingServiceIndex, setEditingServiceIndex] = useState<number | null>(null)
  const [editingService, setEditingService] = useState<Service>({ description: '', price: '' })

  const [expenses, setExpenses] = useState<Expense[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', item_discount: '0', export_status: 'FRESH' })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', item_discount: '0', export_status: 'FRESH' })

  const [notes, setNotes] = useState<Note[]>([])
  const [newNote, setNewNote] = useState('')
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState('')

  const [suppliers, setSuppliers] = useState<{ name: string; discount: number; discount_type: string; aliases: string }[]>([])

  // Parts-DB reference (MAP / OUR COST / % / WEIGHT) shown under every expense row.
  const [dbRef, setDbRef] = useState<any[]>([])
  useEffect(() => {
    supabase.from('parts_database').select('item, part_number, unit_price, map_price, part_discount, weight_lbs').limit(3000).then(({ data }) => setDbRef(data || []))
  }, [])
  // The Parts-DB record for an expense (normalized PN match, suffix-tolerant; item-name fallback).
  function dbRefFor(pn?: string | null, item?: string | null) {
    const key = normPN(pn || '')
    if (key) {
      const hit = dbRef.find((p: any) => { const k = normPN(p.part_number || ''); if (!k) return false; const min = Math.min(k.length, key.length); return k === key || (min >= 6 && (k.endsWith(key) || key.endsWith(k))) })
      if (hit) return hit
    }
    const nm = String(item || '').trim().toLowerCase()
    return nm ? (dbRef.find((p: any) => String(p.item || '').trim().toLowerCase() === nm) || null) : null
  }
  // One-line DB reference: MAP · OUR COST · % · WEIGHT (USD — the bank's native currency).
  function dbRefLine(pn?: string | null, item?: string | null) {
    const di = dbRefFor(pn, item)
    if (!di) return null
    return (
      <p className="text-xs text-teal-300">
        DB: MAP {Number(di.map_price) > 0 ? `US$ ${Number(di.map_price).toFixed(2)}` : '—'}
        {' · '}OUR COST {Number(di.unit_price) > 0 ? `US$ ${Number(di.unit_price).toFixed(2)}` : '—'}
        {di.part_discount != null && Number(di.part_discount) !== 0 ? ` · ${Number(di.part_discount)}%` : ''}
        {Number(di.weight_lbs) > 0 ? ` · ${Number(di.weight_lbs)} lbs` : ''}
      </p>
    )
  }

  // IMPORT FROM PARTS DB picker
  const [showDbModal, setShowDbModal] = useState(false)
  const [dbItems, setDbItems] = useState<any[]>([])
  const [dbSearch, setDbSearch] = useState('')
  // Collapse state for kit groups in the EXPENSES and PARTS lists.
  const [expExpandedKits, setExpExpandedKits] = useState<Set<string>>(new Set())
  const [partExpandedKits, setPartExpandedKits] = useState<Set<string>>(new Set())
  const [dbQty, setDbQty] = useState<Record<string, string>>({})
  // parts_database item -> alias, applied as the part description on import.
  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map())
  // parts_database part_number -> MAP FINAL price (delivered MAP, pre-tax = MAP +
  // shipping + handling), so IMPORT ITEMS FROM EXPENSES sets the part's sell base
  // to the price an ordinary buyer pays delivered (the pack's FL TAXES line then
  // adds the tax). This is above our cost; the bare MAP alone is not.
  const [mapByPN, setMapByPN] = useState<Map<string, number>>(new Map())
  // MAP by item NAME — fallback for bank rows without a part number (e.g. Kong
  // parts), so IMPORT ITEMS FROM EXPENSES still prices them at MAP, not cost.
  const [mapByName, setMapByName] = useState<Map<string, number>>(new Map())

  useEffect(() => { if (id) load(id) }, [id])

  async function load(packId: string) {
    const { data } = await supabase.from('packs').select('*').eq('id', packId).maybeSingle()
    if (!data) { setNotFound(true); setLoading(false); return }
    setName(data.name || '')
    setStatus(data.status || 'DRAFT')
    setCars(Array.isArray(data.cars) ? data.cars.map((c: any) => ({
      manufacturer: c.manufacturer || '', brand: c.brand || '', model: c.model || '', version: c.version || '',
      years: Array.isArray(c.years) ? c.years.map(Number) : (c.year != null && c.year !== '' ? [Number(c.year)] : []),
    })) : [])
    setTargetGrandTotal(data.target_grand_total != null ? String(data.target_grand_total) : '')
    setFloridaTaxes(data.florida_taxes != null ? String(data.florida_taxes) : '')
    setGlobalDiscount(data.global_discount != null ? String(data.global_discount) : '')
    setImportMargin(data.import_margin != null ? String(data.import_margin) : '')
    // Any part without a stored base_cost gets one derived from its current price at
    // the saved margin (base = price / (1 + savedMargin/100)), re-attaching every item
    // to the live MARGIN re-pricer with no price jump at the saved margin.
    const savedFactor = 1 + (parseFloat(data.import_margin != null ? String(data.import_margin) : '0') || 0) / 100
    setParts((data.parts || []).map((p: any) => ({ description: p.description || '', unit_price: p.unit_price != null ? String(p.unit_price) : '', quantity: p.quantity != null ? String(p.quantity) : '1', base_cost: p.base_cost != null ? String(p.base_cost) : (savedFactor !== 0 ? ((Number(p.unit_price) || 0) / savedFactor).toFixed(2) : (p.unit_price != null ? String(p.unit_price) : undefined)), kit_group: p.kit_group || undefined, kit_name: p.kit_name || undefined, source_item: p.source_item || undefined })))
    setServices((data.services || []).map((s: any) => ({ description: s.description || '', price: s.price != null ? String(s.price) : '' })))
    setExpenses((data.expenses || []).map((e: any) => ({ supplier: e.supplier || '', item: e.item || '', part_number: e.part_number || '', amount: e.amount != null ? String(e.amount) : '', tax: e.tax != null ? String(e.tax) : '0', extra: e.extra != null ? String(e.extra) : '0', quantity: e.quantity != null ? String(e.quantity) : '1', item_discount: e.item_discount != null ? String(e.item_discount) : '0', export_status: e.export_status || 'FRESH', kit_group: e.kit_group || undefined, kit_name: e.kit_name || undefined })))
    setNotes((data.notes || []).map((n: any) => ({ note: n.note || '' })))

    const { data: sup } = await supabase.from('suppliers').select('name, discount, discount_type, aliases')
    if (sup) setSuppliers(sup.map((s: any) => ({ name: s.name || '', discount: Number(s.discount) || 0, discount_type: s.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED', aliases: s.aliases || '' })))

    const { data: dbParts } = await supabase.from('parts_database').select('item, alias, part_number, map_price, shipping, handling')
    const am = new Map<string, string>()
    const mp = new Map<string, number>()
    const mn = new Map<string, number>()
    for (const d of dbParts || []) {
      if (d.alias) am.set((d.item || '').trim().toLowerCase(), d.alias)
      // Normalized PN key (same normPN as the dedupe) so formatting differences
      // ("GM-12612350" vs "12612350") still hit the part's MAP.
      const pn = normPN(d.part_number || '')
      // RULE: tax follows how WE bought it. HUNT parts are bought tax-exempt
      // (reseller), so they enter the parts table WITHOUT tax: MAP + freight only.
      // The pack's FL TAXES line then adds the CUSTOMER's tax. (A future "bought
      // with tax" flag from hunt/scan will switch this to a tax-inclusive base.)
      const mapFinal = (Number(d.map_price) || 0) + (Number(d.shipping) || 0) + (Number(d.handling) || 0)
      if (pn && mapFinal > 0) mp.set(pn, mapFinal)
      const nm = (d.item || '').trim().toLowerCase()
      if (nm && mapFinal > 0 && !mn.has(nm)) mn.set(nm, mapFinal)
    }
    setAliasMap(am)
    setMapByPN(mp)
    setMapByName(mn)

    setLoading(false)
  }

  // ---- Car cascade ----
  const builderYears = (bMan && bBrand && bModel && bVersion) ? yearsForSpec(bMan, bBrand, bModel, bVersion) : []
  const pendingComplete = !!(bMan && bBrand && bModel && bVersion && bYears.length)
  function pickMan(m: string) { setBMan(m); setBBrand(''); setBModel(''); setBVersion(''); setBYears([]) }
  function pickBrand(b: string) { setBBrand(b); setBModel(''); setBVersion(''); setBYears([]) }
  function pickModel(mo: string) { setBModel(mo); setBVersion(''); setBYears([]) }
  function pickVersion(v: string) { setBVersion(v); setBYears([]) }
  function toggleYear(y: number) { setBYears(prev => prev.includes(y) ? prev.filter(x => x !== y) : [...prev, y]) }
  function addCar() {
    if (!pendingComplete) return
    setCars(prev => [...prev, { manufacturer: bMan, brand: bBrand, model: bModel, version: bVersion, years: [...bYears].sort((a, b) => a - b) }])
    setBMan(''); setBBrand(''); setBModel(''); setBVersion(''); setBYears([])
  }

  // ---- Supplier discount (display only) ----
  function supplierInfo(nm: string | undefined | null): { discount: number; type: 'FIXED' | 'VARIABLE' } | null {
    const norm = (s: string | undefined | null) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const target = norm(nm); if (!target) return null
    const m = suppliers.find(s => [s.name, ...(s.aliases || '').split(/[\n,]/)].some(v => norm(v) === target))
    return m ? { discount: m.discount, type: m.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED' } : null
  }

  // ---- IMPORT FROM PARTS DB ----
  async function openDbModal() {
    const { data } = await supabase.from('parts_database').select('*').order('created_at', { ascending: false, nullsFirst: false })
    setDbItems(data || [])
    setDbSearch('')
    setDbQty({})
    setShowDbModal(true)
  }
  // Resolve a kit member (kit_items entry) to its parts_database row in the picker.
  function kitMemberRow(m: any) {
    if (m.part_number) { const k = normPN(m.part_number); return dbItems.find((d: any) => !d.is_kit && d.part_number && normPN(d.part_number) === k) }
    const nm = (m.item || '').trim().toLowerCase()
    return dbItems.find((d: any) => !d.is_kit && !d.part_number && (d.item || '').trim().toLowerCase() === nm)
  }
  // A parts_database row's OUR cost (dealer net for hunt, unit price otherwise).
  function dbOurCost(d: any) { return d ? (Number(d.source_type === 'HUNT' ? (d.our_cost ?? d.map_price ?? 0) : (d.unit_price ?? 0)) || 0) : 0 }
  // A kit's summed OUR cost (members × their qty), for the picker display.
  function kitOurTotal(kit: any) { return (kit.kit_items || []).reduce((s: number, m: any) => s + dbOurCost(kitMemberRow(m)) * (Number(m.quantity) || 1), 0) }
  // Build an expense row from a parts_database item (shared by single + kit import).
  // HUNT parts carry dealer pricing (our_cost/dealer_supplier/freight, tax-exempt;
  // the MAP→net discount % rides along so the PARTS gross-up recovers the RETAIL);
  // scanned parts carry unit_price/supplier/tax/extra/own discount.
  function expenseFromDbRow(it: any, quantity: number, kitGroup?: string, kitName?: string): Expense {
    const isHunt = it?.source_type === 'HUNT'
    const supplier = it ? ((isHunt ? it.dealer_supplier : it.supplier) || it.supplier || '') : ''
    const amount = it ? (isHunt ? (it.our_cost ?? it.unit_price ?? 0) : (it.unit_price ?? 0)) : 0
    const extra = it ? (isHunt ? ((Number(it.shipping) || 0) + (Number(it.handling) || 0)) : (Number(it.extra) || 0)) : 0
    const tax = it ? (isHunt ? 0 : (Number(it.tax) || 0)) : 0
    return {
      supplier: String(supplier || ''), item: it?.item || '', part_number: it?.part_number || '',
      amount: String(amount ?? 0), tax: String(tax), extra: String(extra), quantity: String(quantity || 1),
      item_discount: String(isHunt ? (it?.part_discount ?? 0) : (it?.item_discount ?? 0)),
      export_status: 'FRESH', kit_group: kitGroup, kit_name: kitName,
    }
  }
  // Pull a parts_database row in as an expense. A KIT expands into a grouped set.
  function importDbItem(it: any, qty: string) {
    const factor = parseFloat(qty) || 1
    if (it.is_kit) {
      // Use a real UUID for the group id: it's valid for both uuid and text columns,
      // so it survives applyPack/duplicate into invoice_parts/expenses without the
      // "invalid input syntax for type uuid" error.
      const group = crypto.randomUUID()
      const name = it.item || 'Kit'
      const rows = (it.kit_items || []).map((m: any) => {
        const mr = kitMemberRow(m)
        const row = expenseFromDbRow(mr, (Number(m.quantity) || 1) * factor, group, name)
        if (!mr) { row.item = m.item || m.part_number || 'Part'; row.part_number = m.part_number || '' }
        return row
      })
      setExpenses(prev => [...prev, ...rows])
      setExpExpandedKits(prev => new Set(prev).add(group))
      setShowDbModal(false)
      return
    }
    setExpenses(prev => [...prev, expenseFromDbRow(it, factor)])
    setShowDbModal(false)
  }
  function toggleExpKit(g: string) { setExpExpandedKits(prev => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n }) }
  function togglePartKit(g: string) { setPartExpandedKits(prev => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n }) }
  function removeExpenseGroup(g: string) { setExpenses(prev => prev.filter(e => e.kit_group !== g)) }
  function removePartGroup(g: string) {
    const keys = new Set(parts.filter(p => p.kit_group === g).map(p => (p.source_item || p.description || '').trim().toLowerCase()).filter(Boolean))
    setParts(prev => prev.filter(p => p.kit_group !== g))
    if (keys.size) {
      const matchIdx: number[] = []
      expenses.forEach((e, i) => { if ((e.export_status || 'FRESH') === 'EXPORTED' && keys.has((e.item || '').trim().toLowerCase())) matchIdx.push(i) })
      if (matchIdx.length) markExportStatus(matchIdx, 'REMOVED')
    }
  }

  // ---- Export status (which expenses have been imported into PARTS) ----
  function markExportStatus(indices: number[], status: string) {
    const set = new Set(indices)
    setExpenses(prev => prev.map((e, i) => set.has(i) ? { ...e, export_status: status } : e))
  }
  function resetExportStatus(index: number) { markExportStatus([index], 'FRESH') }

  // IMPORT ITEMS FROM EXPENSES — bring each FRESH expense into PARTS at its market
  // (pre-discount) landed cost as base_cost, priced unit_price = base_cost*(1+MARGIN).
  // Skips extras/charges (SKIP_WORDS) and anything already EXPORTED. The MARGIN field
  // then manipulates every imported part at once (live re-pricer). Imported expenses
  // flip to EXPORTED so they won't import twice.
  function importItemsFromExpenses() {
    const margin = parseFloat(importMargin) || 0
    const factor = 1 + margin / 100
    const sourceMap = new Map<string, { description: string; base: number; quantity: number; kit_group?: string; kit_name?: string; source_item: string }>()
    const importedIndices: number[] = []
    expenses.forEach((e, idx) => {
      if (SKIP_WORDS.test(e.item)) return
      if ((e.export_status || 'FRESH') !== 'FRESH') return
      const desc = (e.item || '').trim(); if (!desc) return
      const amount = parseFloat(e.amount) || 0
      const qty = parseFloat(e.quantity) || 1
      // Sell-side base = the part's MAP FINAL price matched by part number in the
      // Parts DB. Tax follows how WE bought it (RULE): tax-exempt purchases (HUNT)
      // give a NO-tax base (MAP + freight); the pack's FL TAXES line adds the
      // customer's tax. If the part isn't known, gross the cost up to market by
      // the supplier/item discount.
      const pn = normPN(e.part_number || '')
      const mapFinal = (pn ? (mapByPN.get(pn) || 0) : 0) || mapByName.get(desc.toLowerCase()) || 0
      let unitBase: number
      if (mapFinal > 0) {
        unitBase = mapFinal
      } else {
        // No typed supplier % — the discount is per ITEM (real invoice / line entry).
        const disc = parseFloat(e.item_discount || '0') || 0
        const discFactor = (disc > 0 && disc < 100) ? (1 - disc / 100) : 1
        unitBase = amount / discFactor
      }
      const key = `${e.kit_group || ''}|${desc.toLowerCase()}|${unitBase.toFixed(4)}`
      const existing = sourceMap.get(key)
      if (existing) existing.quantity += qty
      else sourceMap.set(key, { description: desc, base: unitBase, quantity: qty, kit_group: e.kit_group, kit_name: e.kit_name, source_item: desc })
      importedIndices.push(idx)
    })
    if (importedIndices.length === 0) { alert('No FRESH expenses to import.'); return }
    const toAdd: Part[] = []
    sourceMap.forEach(src => toAdd.push({
      description: aliasMap.get(src.description.trim().toLowerCase()) || src.description,
      unit_price: (src.base * factor).toFixed(2),
      quantity: String(src.quantity),
      base_cost: String(src.base),
      kit_group: src.kit_group,
      kit_name: src.kit_name,
      source_item: src.source_item,
    }))
    setParts(prev => [...prev, ...toAdd])
    setPartExpandedKits(prev => { const n = new Set(prev); toAdd.forEach(p => { if (p.kit_group) n.add(p.kit_group) }); return n })
    markExportStatus(importedIndices, 'EXPORTED')
  }

  // ---- Totals math (mirrors the invoice editor) ----
  const getPartTotal = (p: Part) => (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0)
  const partsSubTotal = parts.reduce((sum, p) => sum + getPartTotal(p), 0)
  const floridaTaxesPct = parseFloat(floridaTaxes) || 0
  const floridaTaxesAmount = partsSubTotal * (floridaTaxesPct / 100)
  const partsTotal = partsSubTotal + floridaTaxesAmount
  const laborIndex = services.findIndex(s => s.description === FULL_PROJECT_LABOR)
  const otherServicesTotal = services.reduce((sum, s, i) => i === laborIndex ? sum : sum + (parseFloat(s.price) || 0), 0)
  const servicesTotal = services.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0)
  const partsAndServicesTotal = partsTotal + servicesTotal
  const globalDiscountPct = parseFloat(globalDiscount) || 0
  const globalDiscountAmount = partsAndServicesTotal * (globalDiscountPct / 100)
  const grandTotal = partsAndServicesTotal - globalDiscountAmount
  // Florida taxes are a pass-through: collected as revenue (in the grand total) AND
  // owed as an expense, so they net to zero profit. Count them on the expense side.
  const expensesTotal = floridaTaxesAmount + expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
  const finalProfit = grandTotal - expensesTotal
  const finalProfitPct = expensesTotal > 0 ? (finalProfit / expensesTotal) * 100 : 0

  // ---- Live IMPORT MARGIN re-pricer (same as invoice) ----
  useEffect(() => {
    if (loading || locked) return
    const factor = 1 + (parseFloat(importMargin) || 0) / 100
    setParts(prev => {
      let changed = false
      const next = prev.map(p => {
        if (p.base_cost == null || p.base_cost === '') return p
        const np = ((parseFloat(p.base_cost) || 0) * factor).toFixed(2)
        if (np === p.unit_price) return p
        changed = true
        return { ...p, unit_price: np }
      })
      return changed ? next : prev
    })
  }, [importMargin, loading, locked])

  // ---- Auto-CALCULATE Full Project Labor to hit TARGET GRAND TOTAL (same as invoice) ----
  useEffect(() => {
    if (loading || locked) return
    const target = parseFloat((targetGrandTotal || '').replace(/,/g, ''))
    if (!target || target <= 0) return
    const discountFactor = 1 - (globalDiscountPct / 100)
    if (discountFactor <= 0) return
    const labor = (target / discountFactor) - partsTotal - otherServicesTotal
    const laborStr = (labor < 0 ? 0 : labor).toFixed(2)
    setServices(prev => {
      const li = prev.findIndex(s => s.description === FULL_PROJECT_LABOR)
      if (li < 0) return [...prev, { description: FULL_PROJECT_LABOR, price: laborStr }]
      if (prev[li].price === laborStr) return prev
      const updated = [...prev]; updated[li] = { ...updated[li], price: laborStr }; return updated
    })
  }, [targetGrandTotal, partsTotal, otherServicesTotal, globalDiscountPct, laborIndex, loading, locked])

  // ---- Item handlers ----
  function addPart() {
    if (!newPart.description || !newPart.unit_price || !newPart.quantity) { alert('Please fill in all item fields'); return }
    // Capture base_cost from the entered price at the current margin so the item
    // scales with the live MARGIN re-pricer. base = price / (1 + margin/100).
    const f = 1 + (parseFloat(importMargin) || 0) / 100
    const base = f !== 0 ? ((parseFloat(newPart.unit_price) || 0) / f).toFixed(2) : newPart.unit_price
    setParts([...parts, { ...newPart, base_cost: base }]); setNewPart({ description: '', unit_price: '', quantity: '1' })
  }
  // Move a SINGLE row up/down. If the neighbor belongs to a kit, hop the whole kit
  // block so a loose item never lands between a kit's members.
  function moveRow<T extends { kit_group?: string }>(arr: T[], index: number, dir: -1 | 1): T[] {
    const next = [...arr]
    if (dir === -1) {
      if (index <= 0) return next
      const prev = next[index - 1]
      let insertAt = index - 1
      if (prev.kit_group) { while (insertAt > 0 && next[insertAt - 1].kit_group === prev.kit_group) insertAt-- }
      const [item] = next.splice(index, 1)
      next.splice(insertAt, 0, item)
    } else {
      if (index >= next.length - 1) return next
      const nx = next[index + 1]
      let afterIdx = index + 1
      if (nx.kit_group) { while (afterIdx < next.length - 1 && next[afterIdx + 1].kit_group === nx.kit_group) afterIdx++ }
      const [item] = next.splice(index, 1)
      next.splice(afterIdx, 0, item)
    }
    return next
  }
  function movePart(index: number, dir: -1 | 1) {
    setParts(prev => moveRow(prev, index, dir))
    if (editingPartIndex !== null) setEditingPartIndex(null)
  }
  // Reorder an EXPENSE row up (-1) / down (+1). Local; the new order is the array
  // order, persisted as-is on SAVE (pack expenses are a JSONB array).
  function moveExpense(index: number, dir: -1 | 1) {
    setExpenses(prev => moveRow(prev, index, dir))
    if (editingExpenseIndex !== null) setEditingExpenseIndex(null)
  }
  // Move a whole KIT block up/down as one unit, hopping over the adjacent row OR the
  // entire adjacent kit (so two kits swap cleanly and members stay contiguous).
  function moveBlock<T extends { kit_group?: string }>(arr: T[], g: string, dir: -1 | 1): T[] {
    const next = [...arr]
    const idxs = next.map((x, i) => (x.kit_group === g ? i : -1)).filter(i => i >= 0)
    if (!idxs.length) return next
    const start = idxs[0], end = idxs[idxs.length - 1]
    const block = next.slice(start, end + 1)
    if (dir === -1) {
      if (start === 0) return next
      const prev = next[start - 1]
      let insertAt = start - 1
      if (prev.kit_group) { while (insertAt > 0 && next[insertAt - 1].kit_group === prev.kit_group) insertAt-- }
      next.splice(start, block.length)
      next.splice(insertAt, 0, ...block)
    } else {
      if (end === next.length - 1) return next
      const nx = next[end + 1]
      let afterIdx = end + 1
      if (nx.kit_group) { while (afterIdx < next.length - 1 && next[afterIdx + 1].kit_group === nx.kit_group) afterIdx++ }
      next.splice(start, block.length)
      next.splice(afterIdx - block.length + 1, 0, ...block)
    }
    return next
  }
  function moveExpenseGroup(g: string, dir: -1 | 1) { setExpenses(prev => moveBlock(prev, g, dir)); if (editingExpenseIndex !== null) setEditingExpenseIndex(null) }
  function movePartGroup(g: string, dir: -1 | 1) { setParts(prev => moveBlock(prev, g, dir)); if (editingPartIndex !== null) setEditingPartIndex(null) }
  function removePart(index: number) {
    const part = parts[index]
    setParts(parts.filter((_, i) => i !== index))
    // An EXPORTED expense that produced this part flips to REMOVED. Match by source_item
    // (the original expense name stamped at import) so the link survives renames; fall
    // back to the current description for legacy parts that predate source_item.
    const desc = (part.source_item || part.description || '').trim().toLowerCase()
    if (desc) {
      const matchIdx: number[] = []
      expenses.forEach((e, i) => { if ((e.export_status || 'FRESH') === 'EXPORTED' && (e.item || '').trim().toLowerCase() === desc) matchIdx.push(i) })
      if (matchIdx.length) markExportStatus(matchIdx, 'REMOVED')
    }
  }
  function startEditPart(index: number) { setEditingPartIndex(index); setEditingPart({ ...parts[index] }) }
  function saveEditPart() {
    if (!editingPart.description || !editingPart.unit_price || !editingPart.quantity) { alert('Please fill in all item fields'); return }
    // Re-capture base_cost from the edited price at the current margin so the item
    // stays attached to the live MARGIN re-pricer. base = price / (1 + margin/100).
    const f = 1 + (parseFloat(importMargin) || 0) / 100
    const base = f !== 0 ? ((parseFloat(editingPart.unit_price) || 0) / f).toFixed(2) : editingPart.unit_price
    const updated = [...parts]; updated[editingPartIndex!] = { ...editingPart, base_cost: base }; setParts(updated)
    setEditingPartIndex(null); setEditingPart({ description: '', unit_price: '', quantity: '1' })
  }

  function addService() {
    if (!newService.description) { alert('Please enter a description'); return }
    setServices([...services, newService]); setNewService({ description: '', price: '' })
  }
  function removeService(index: number) { setServices(services.filter((_, i) => i !== index)) }
  function startEditService(index: number) { setEditingServiceIndex(index); setEditingService({ ...services[index] }) }
  function saveEditService() {
    if (!editingService.description) { alert('Please enter a description'); return }
    const updated = [...services]; updated[editingServiceIndex!] = { ...editingService }; setServices(updated)
    setEditingServiceIndex(null); setEditingService({ description: '', price: '' })
  }

  function addExpense() {
    if (!newExpense.item) { alert('Please enter an item'); return }
    setExpenses([...expenses, newExpense]); setNewExpense({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', item_discount: '0', export_status: 'FRESH' })
  }
  function removeExpense(index: number) { setExpenses(expenses.filter((_, i) => i !== index)) }
  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }) }
  function saveEditExpense() {
    if (!editingExpense.item) { alert('Please enter an item'); return }
    const updated = [...expenses]; updated[editingExpenseIndex!] = { ...editingExpense }; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', item_discount: '0', export_status: 'FRESH' })
  }
  const expenseLineTotal = (e: Expense) => (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)

  function addNote() {
    if (!newNote.trim()) return
    setNotes([...notes, { note: newNote.trim() }]); setNewNote('')
  }
  function removeNote(index: number) { setNotes(notes.filter((_, i) => i !== index)) }
  function startEditNote(index: number) { setEditingNoteIndex(index); setEditingNote(notes[index].note) }
  function saveEditNote() {
    const updated = [...notes]; updated[editingNoteIndex!] = { note: editingNote }; setNotes(updated)
    setEditingNoteIndex(null); setEditingNote('')
  }

  // ---- Save ----
  async function save(nextStatus?: string) {
    if (saving) return
    if (!name.trim()) { alert('Give the package a name.'); return }
    setSaving(true)
    const row: any = {
      name: name.trim(),
      cars,
      status: nextStatus || status,
      target_grand_total: targetGrandTotal ? parseFloat(targetGrandTotal.replace(/,/g, '')) : null,
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
      import_margin: parseFloat(importMargin) || 0,
      parts: parts.filter(p => p.description.trim()).map(p => ({ description: p.description.trim(), unit_price: parseFloat(p.unit_price) || 0, quantity: parseFloat(p.quantity) || 0, base_cost: (p.base_cost != null && p.base_cost !== '') ? parseFloat(p.base_cost) : null, kit_group: p.kit_group || null, kit_name: p.kit_name || null, source_item: p.source_item || null })),
      services: services.filter(s => s.description.trim()).map(s => ({ description: s.description.trim(), price: parseFloat(s.price) || 0 })),
      expenses: expenses.filter(e => e.item.trim()).map(e => ({ supplier: e.supplier.trim(), item: e.item.trim(), part_number: (e.part_number || '').trim() || null, amount: parseFloat(e.amount) || 0, tax: parseFloat(e.tax) || 0, extra: parseFloat(e.extra) || 0, quantity: parseFloat(e.quantity) || 1, item_discount: parseFloat(e.item_discount) || 0, export_status: e.export_status || 'FRESH', kit_group: e.kit_group || null, kit_name: e.kit_name || null })),
      notes: notes.filter(n => n.note.trim()).map(n => ({ note: n.note.trim() })),
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('packs').update(row).eq('id', id)
    if (error) { alert(error.message); setSaving(false); return }
    router.push('/packs')
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading...</p></main>
  if (notFound) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Pack not found.</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />

      {/* IMPORT FROM PARTS DB modal */}
      {showDbModal && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-teal-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-bold text-teal-300">IMPORT FROM PARTS DB</h2>
              <button onClick={() => setShowDbModal(false)} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-2xl font-bold shrink-0">CLOSE</button>
            </div>
            <input value={dbSearch} onChange={(e) => setDbSearch(e.target.value)} placeholder="Search item, alias or part number..." className={inputClass} />
            {(() => {
              const t = dbSearch.trim()
              // Word-order-tolerant: every typed word must appear somewhere across
              // item + alias + PN — "belt gates" finds "Gates ... Serpentine Belt".
              const list = t ? dbItems.filter((d: any) => partMatches(t, d.item, d.alias, d.part_number)) : dbItems
              if (list.length === 0) return <p className="text-gray-400">No items in the parts database.</p>
              return list.map((d: any) => {
                const isKit = !!d.is_kit
                const isHunt = d.source_type === 'HUNT'
                const cost = isKit ? kitOurTotal(d) : (isHunt ? (d.our_cost ?? d.map_price ?? 0) : (d.unit_price ?? 0))
                const sup = isKit ? '' : (isHunt ? (d.dealer_supplier || d.supplier) : d.supplier)
                const badge = partStatusBadge(d)
                return (
                  <div key={d.id} className="flex items-center justify-between gap-4 border-b border-gray-800 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${badge.cls}`}>{badge.label}</span>
                        <p className="font-bold truncate" title={d.item}>{d.item}</p>
                      </div>
                      {d.alias && <p className="text-sm text-teal-300 truncate" title={d.alias}>alias: {d.alias}</p>}
                      <p className="text-sm text-gray-400">{formatUSD(Number(cost) || 0)}{isKit ? ` · ${(d.kit_items || []).length} parts` : ''}{sup ? ` · ${sup}` : ''}{d.part_number ? ` · PN ${d.part_number}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div><label className="block mb-1 text-xs text-gray-400 text-center">QTY</label>
                        <input type="text" inputMode="decimal" value={dbQty[d.id] ?? '1'} onChange={(ev) => { if (isNumeric(ev.target.value)) setDbQty({ ...dbQty, [d.id]: ev.target.value }) }} className={`${smallInputClass} w-16 text-center`} />
                      </div>
                      <button onClick={() => importDbItem(d, dbQty[d.id] ?? '1')} className="bg-teal-700 hover:bg-teal-600 px-4 py-2 rounded-2xl font-bold text-sm self-end">ADD</button>
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mb-8 flex-wrap">
        <h1 className="text-4xl font-bold">EDIT PACK</h1>
        <span className={`px-3 py-1 rounded-full text-sm font-bold ${locked ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{locked ? 'CLOSED — locked' : 'DRAFT'}</span>
      </div>

      <div className="grid grid-cols-1 gap-6 max-w-2xl">

        {/* CARS */}
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
              <div><p className="mb-2 text-sm text-gray-400 font-bold">MANUFACTURER</p><div className="flex gap-2 flex-wrap">{MANUFACTURERS.map(m => <button key={m} onClick={() => pickMan(m)} className={chip(bMan === m)}>{m}</button>)}</div></div>
              {bMan && <div><p className="mb-2 text-sm text-gray-400 font-bold">BRAND</p><div className="flex gap-2 flex-wrap">{brandsFor(bMan).map(b => <button key={b} onClick={() => pickBrand(b)} className={chip(bBrand === b)}>{b}</button>)}</div></div>}
              {bBrand && <div><p className="mb-2 text-sm text-gray-400 font-bold">MODEL</p><div className="flex gap-2 flex-wrap">{modelsFor(bMan, bBrand).map(mo => <button key={mo} onClick={() => pickModel(mo)} className={chip(bModel === mo)}>{mo}</button>)}</div></div>}
              {bModel && <div><p className="mb-2 text-sm text-gray-400 font-bold">VERSION</p><div className="flex gap-2 flex-wrap">{versionsFor(bMan, bBrand, bModel).map(v => <button key={v} onClick={() => pickVersion(v)} className={chip(bVersion === v)}>{v}</button>)}</div></div>}
              {bVersion && <div><p className="mb-2 text-sm text-gray-400 font-bold">YEARS (pick as many as you want)</p><div className="flex gap-2 flex-wrap">{builderYears.map(y => <button key={y} onClick={() => toggleYear(y)} className={chip(bYears.includes(y))}>{y}</button>)}</div></div>}
              {pendingComplete && <button onClick={addCar} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold">+ ADD ANOTHER CAR</button>}
            </div>
          )}
        </div>

        {/* NAME */}
        <div>
          <label className="block mb-2 text-lg font-bold">PACKAGE NAME</label>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={locked} className={inputClass} placeholder="e.g. Stage 2 Turbo Kit" />
        </div>

        {/* EXPENSES (first box, matching the invoice edit page) */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            {!locked && <button onClick={openDbModal} className="flex items-center justify-center gap-2 w-full bg-teal-700 hover:bg-teal-600 px-5 py-3 rounded-2xl font-bold text-lg">📚 IMPORT FROM PARTS DB</button>}
            <div className="flex gap-3 flex-wrap">
              <input type="text" placeholder="Supplier" value={newExpense.supplier} onChange={(e) => setNewExpense({ ...newExpense, supplier: e.target.value })} disabled={locked} className={`${smallInputClass} w-40`} />
              <input type="text" placeholder="Item" value={newExpense.item} onChange={(e) => setNewExpense({ ...newExpense, item: e.target.value })} disabled={locked} className={`${smallInputClass} flex-1 min-w-40`} />
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="w-16"><label className="block mb-1 text-xs text-gray-400">QTY</label><input type="text" inputMode="decimal" value={newExpense.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, quantity: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full`} /></div>
              <div className="w-24"><label className="block mb-1 text-xs text-gray-400">AMOUNT</label><input type="text" inputMode="decimal" value={newExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full`} placeholder="0" /></div>
              <div className="w-20"><label className="block mb-1 text-xs text-gray-400">TAX</label><input type="text" inputMode="decimal" value={newExpense.tax} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, tax: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full`} /></div>
              <div className="w-20"><label className="block mb-1 text-xs text-gray-400">EXTRA</label><input type="text" inputMode="decimal" value={newExpense.extra} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, extra: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full`} /></div>
            </div>
            {!locked && <button onClick={addExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>}
            {expenses.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {expenses.map((e, index) => {
                  const info = supplierInfo(e.supplier)
                  const firstOfKit = !!e.kit_group && expenses.findIndex(x => x.kit_group === e.kit_group) === index
                  const collapsed = !!e.kit_group && !expExpandedKits.has(e.kit_group)
                  return (
                    <div key={index}>
                      {firstOfKit && (() => { const members = expenses.filter(x => x.kit_group === e.kit_group); const total = members.reduce((s, x) => s + expenseLineTotal(x), 0); return (
                        <div className="flex items-center gap-2 px-4 py-3 bg-gray-800/50 border-b border-gray-700">
                          <button onClick={() => toggleExpKit(e.kit_group!)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                            <span className="text-gray-300">{expExpandedKits.has(e.kit_group!) ? '▾' : '▸'}</span>
                            <span className="text-base font-bold truncate" title={`📦 ${e.kit_name || 'Kit'}`}>📦 {e.kit_name || 'Kit'}</span>
                            <span className="text-xs text-gray-400">({members.length} parts)</span>
                          </button>
                          <span className="text-base font-bold shrink-0">{formatUSD(total)}</span>
                          {!locked && <>
                            <button onClick={() => moveExpenseGroup(e.kit_group!, -1)} disabled={index === 0} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm shrink-0">▲</button>
                            <button onClick={() => moveExpenseGroup(e.kit_group!, 1)} disabled={index + members.length >= expenses.length} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm shrink-0">▼</button>
                          </>}
                          {!locked && <button onClick={() => removeExpenseGroup(e.kit_group!)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm shrink-0">REMOVE</button>}
                        </div>
                      ) })()}
                      {!collapsed && (
                        <div className={e.kit_group ? 'pl-5 border-l-2 border-teal-800 ml-3' : ''}>
                      {editingExpenseIndex === index ? (
                        <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                          <div className="flex gap-3 flex-wrap">
                            <input type="text" placeholder="Supplier" value={editingExpense.supplier} onChange={(ev) => setEditingExpense({ ...editingExpense, supplier: ev.target.value })} className={`${smallInputClass} w-40`} />
                            <input type="text" placeholder="Item" value={editingExpense.item} onChange={(ev) => setEditingExpense({ ...editingExpense, item: ev.target.value })} className={`${smallInputClass} flex-1 min-w-40`} />
                          </div>
                          <div className="flex gap-3 flex-wrap">
                            <div className="w-16"><label className="block mb-1 text-xs text-gray-400">QTY</label><input type="text" inputMode="decimal" value={editingExpense.quantity} onChange={(ev) => { if (isNumeric(ev.target.value)) setEditingExpense({ ...editingExpense, quantity: ev.target.value }) }} className={`${smallInputClass} w-full`} /></div>
                            <div className="w-24"><label className="block mb-1 text-xs text-gray-400">AMOUNT</label><input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(ev) => { if (isNumeric(ev.target.value)) setEditingExpense({ ...editingExpense, amount: ev.target.value }) }} className={`${smallInputClass} w-full`} /></div>
                            <div className="w-20"><label className="block mb-1 text-xs text-gray-400">TAX</label><input type="text" inputMode="decimal" value={editingExpense.tax} onChange={(ev) => { if (isNumeric(ev.target.value)) setEditingExpense({ ...editingExpense, tax: ev.target.value }) }} className={`${smallInputClass} w-full`} /></div>
                            <div className="w-20"><label className="block mb-1 text-xs text-gray-400">EXTRA</label><input type="text" inputMode="decimal" value={editingExpense.extra} onChange={(ev) => { if (isNumeric(ev.target.value)) setEditingExpense({ ...editingExpense, extra: ev.target.value }) }} className={`${smallInputClass} w-full`} /></div>
                          </div>
                          <div className="flex gap-3">
                            <button onClick={saveEditExpense} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                            <button onClick={() => setEditingExpenseIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                          </div>
                        </div>
                      ) : (
                        <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <p className="text-base font-bold truncate" title={e.item}>{e.item}{e.part_number ? <span className="text-xs text-gray-500"> · PN {e.part_number}</span> : ''}</p>
                            <p className="text-sm text-gray-400">{e.quantity} × {formatUSD(parseFloat(e.amount) || 0)} = {formatUSD(expenseLineTotal(e))}{e.supplier ? ` · ${e.supplier}` : ''}{(parseFloat(e.item_discount || '0') || 0) > 0 ? ` · ${parseFloat(e.item_discount || '0')}% off` : ''}</p>
                            {dbRefLine(e.part_number, e.item)}
                            {(() => { const st = e.export_status || 'FRESH'; const color = st === 'EXPORTED' ? 'text-green-400' : st === 'REMOVED' ? 'text-red-400' : 'text-gray-400'; return (
                              <p className="text-xs mt-0.5"><span className={`font-bold ${color}`}>{st}</span>{st !== 'FRESH' && !locked && <button onClick={() => resetExportStatus(index)} className="ml-2 text-gray-400 underline hover:text-white">RESET</button>}</p>
                            ) })()}
                          </div>
                          {!locked && (
                            <div className="flex gap-2 shrink-0">
                              {!e.kit_group && <button onClick={() => moveExpense(index, -1)} disabled={index === 0} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm">▲</button>}
                              {!e.kit_group && <button onClick={() => moveExpense(index, 1)} disabled={index === expenses.length - 1} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm">▼</button>}
                              <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                              <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                            </div>
                          )}
                        </div>
                      )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {floridaTaxesAmount > 0 && (
              <div className="flex justify-between items-center text-gray-300">
                <span>Florida State Taxes</span>
                <span className="font-bold">{formatUSD(floridaTaxesAmount)}</span>
              </div>
            )}
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="font-bold text-lg">EXPENSES TOTAL</span>
              <span className="text-2xl font-bold">{formatUSD(expensesTotal)}</span>
            </div>
          </div>
        </div>

        {/* PARTS */}
        <div>
          <label className="block mb-3 text-lg font-bold">PARTS</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            {!locked && <button onClick={importItemsFromExpenses} className="flex items-center justify-center gap-2 w-full bg-purple-700 hover:bg-purple-600 px-5 py-3 rounded-2xl font-bold text-lg">⬆ IMPORT ITEMS FROM EXPENSES</button>}
            <input type="text" placeholder="Description" value={newPart.description} onChange={(e) => setNewPart({ ...newPart, description: e.target.value })} disabled={locked} className={inputClass} />
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">UNIT PRICE</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newPart.unit_price} onChange={(e) => { if (isNumeric(e.target.value)) setNewPart({ ...newPart, unit_price: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">QUANTITY</label>
                <input type="text" inputMode="decimal" placeholder="1" value={newPart.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewPart({ ...newPart, quantity: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full`} />
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">TOTAL</label>
                <div className={`${smallInputClass} w-full opacity-50`}>{newPart.unit_price && newPart.quantity ? formatUSD(parseFloat(newPart.unit_price || '0') * parseFloat(newPart.quantity || '0')) : '$0.00'}</div>
              </div>
            </div>
            {!locked && (
              <div className="flex gap-3 items-center flex-wrap">
                <button onClick={addPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD ITEM</button>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 font-bold text-sm">MARGIN</span>
                  <div className="relative w-24">
                    <input type="text" inputMode="decimal" value={importMargin} onChange={(e) => { if (isNumeric(e.target.value)) setImportMargin(e.target.value) }} className={`${smallInputClass} w-full pr-7`} placeholder="0" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                  </div>
                </div>
              </div>
            )}
            {parts.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {parts.map((part, index) => {
                  const firstOfKit = !!part.kit_group && parts.findIndex(x => x.kit_group === part.kit_group) === index
                  const collapsed = !!part.kit_group && !partExpandedKits.has(part.kit_group)
                  return (
                  <div key={index}>
                    {firstOfKit && (() => { const members = parts.filter(x => x.kit_group === part.kit_group); const total = members.reduce((s, x) => s + getPartTotal(x), 0); return (
                      <div className="flex items-center gap-2 px-4 py-3 bg-gray-800/50 border-b border-gray-700">
                        <button onClick={() => togglePartKit(part.kit_group!)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                          <span className="text-gray-300">{partExpandedKits.has(part.kit_group!) ? '▾' : '▸'}</span>
                          <span className="text-base font-bold truncate" title={`📦 ${part.kit_name || 'Kit'}`}>📦 {part.kit_name || 'Kit'}</span>
                          <span className="text-xs text-gray-400">({members.length} parts)</span>
                        </button>
                        <span className="text-base font-bold shrink-0">{formatUSD(total)}</span>
                        {!locked && <>
                          <button onClick={() => movePartGroup(part.kit_group!, -1)} disabled={index === 0} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm shrink-0">▲</button>
                          <button onClick={() => movePartGroup(part.kit_group!, 1)} disabled={index + members.length >= parts.length} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm shrink-0">▼</button>
                        </>}
                        {!locked && <button onClick={() => removePartGroup(part.kit_group!)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm shrink-0">REMOVE</button>}
                      </div>
                    ) })()}
                    {!collapsed && (
                      <div className={part.kit_group ? 'pl-5 border-l-2 border-teal-800 ml-3' : ''}>
                    {editingPartIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <input type="text" value={editingPart.description} onChange={(e) => setEditingPart({ ...editingPart, description: e.target.value })} className={inputClass} />
                        <div className="flex gap-3">
                          <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">UNIT PRICE</label>
                            <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                              <input type="text" inputMode="decimal" value={editingPart.unit_price} onChange={(e) => { if (isNumeric(e.target.value)) setEditingPart({ ...editingPart, unit_price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                            </div>
                          </div>
                          <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">QUANTITY</label>
                            <input type="text" inputMode="decimal" value={editingPart.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setEditingPart({ ...editingPart, quantity: e.target.value }) }} className={`${smallInputClass} w-full`} />
                          </div>
                          <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">TOTAL</label>
                            <div className={`${smallInputClass} w-full opacity-50`}>{formatUSD((parseFloat(editingPart.unit_price || '0')) * (parseFloat(editingPart.quantity || '0')))}</div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={saveEditPart} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={() => setEditingPartIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < parts.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold truncate" title={part.description}>{part.description}</p>
                          <p className="text-sm text-gray-400">{formatUSD(parseFloat(part.unit_price))} × {part.quantity} = {formatUSD(getPartTotal(part))}</p>
                        </div>
                        {!locked && (
                          <div className="flex gap-2 shrink-0">
                            {!part.kit_group && <button onClick={() => movePart(index, -1)} disabled={index === 0} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm">▲</button>}
                            {!part.kit_group && <button onClick={() => movePart(index, 1)} disabled={index === parts.length - 1} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-sm">▼</button>}
                            <button onClick={() => startEditPart(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removePart(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        )}
                      </div>
                    )}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="text-gray-400 font-bold">ITEMS SUB-TOTAL</span>
              <span className="text-xl font-bold">{formatUSD(partsSubTotal)}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-gray-400 font-bold whitespace-nowrap">FLORIDA TAXES</span>
              <div className="relative w-28">
                <input type="text" inputMode="decimal" value={floridaTaxes} onChange={(e) => { if (isNumeric(e.target.value)) setFloridaTaxes(e.target.value) }} disabled={locked} className={`${smallInputClass} w-full pr-6`} placeholder="0.00" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
              </div>
              <span className="text-xl font-bold ml-auto">{formatUSD(floridaTaxesAmount)}</span>
            </div>
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="font-bold text-lg">ITEMS TOTAL</span>
              <span className="text-2xl font-bold">{formatUSD(partsTotal)}</span>
            </div>
          </div>
        </div>

        {/* SERVICES */}
        <div>
          <label className="block mb-3 text-lg font-bold">SERVICES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <input type="text" placeholder="Description" value={newService.description} onChange={(e) => setNewService({ ...newService, description: e.target.value })} disabled={locked} className={inputClass} />
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newService.price} onChange={(e) => { if (isNumeric(e.target.value)) setNewService({ ...newService, price: e.target.value }) }} disabled={locked} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
            </div>
            {!locked && <button onClick={addService} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD SERVICE</button>}
            {services.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {services.map((svc, index) => (
                  <div key={index}>
                    {editingServiceIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <input type="text" value={editingService.description} onChange={(e) => setEditingService({ ...editingService, description: e.target.value })} className={inputClass} />
                        <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                          <input type="text" inputMode="decimal" value={editingService.price} onChange={(e) => { if (isNumeric(e.target.value)) setEditingService({ ...editingService, price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                        </div>
                        <div className="flex gap-3">
                          <button onClick={saveEditService} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={() => setEditingServiceIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < services.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold truncate" title={svc.description}>{svc.description}</p>
                          <p className="text-sm text-gray-400">{!svc.price || parseFloat(svc.price) === 0 ? 'COURTESY' : formatUSD(parseFloat(svc.price))}</p>
                        </div>
                        {!locked && (
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => startEditService(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removeService(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="font-bold text-lg">SERVICES TOTAL</span>
              <span className="text-2xl font-bold">{formatUSD(servicesTotal)}</span>
            </div>
          </div>
        </div>

        {/* TARGET GRAND TOTAL */}
        <div>
          <label className="block mb-2 text-lg font-bold">TARGET GRAND TOTAL</label>
          <div className="relative max-w-xs"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input type="text" inputMode="decimal" value={targetGrandTotal} onChange={(e) => { if (isNumeric(e.target.value)) setTargetGrandTotal(e.target.value) }} disabled={locked} className={`${inputClass} pl-8`} placeholder="0.00" />
          </div>
          <p className="text-gray-500 text-sm mt-1">Auto-solves a “{FULL_PROJECT_LABOR}” service so the grand total hits this target.</p>
        </div>

        {/* GRAND TOTAL */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">ITEMS + SERVICES TOTAL</span>
            <span className="text-xl font-bold">{formatUSD(partsAndServicesTotal)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-gray-400 font-bold whitespace-nowrap">GLOBAL DISCOUNT</span>
            <div className="relative w-28">
              <input type="text" inputMode="decimal" value={globalDiscount} onChange={(e) => { if (isNumeric(e.target.value)) setGlobalDiscount(e.target.value) }} disabled={locked} className={`${smallInputClass} w-full pr-6`} placeholder="0.00" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
            </div>
            <span className="text-xl font-bold ml-auto text-red-400">- {formatUSD(globalDiscountAmount)}</span>
          </div>
          <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
            <span className="font-bold text-xl">GRAND TOTAL</span>
            <span className="text-3xl font-bold">{formatUSD(grandTotal)}</span>
          </div>
        </div>

        {/* NOTES */}
        <div>
          <label className="block mb-3 text-lg font-bold">NOTES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <textarea placeholder="Enter a note..." value={newNote} onChange={(e) => setNewNote(e.target.value)} disabled={locked} rows={3} className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg resize-none disabled:opacity-50" />
            {!locked && <button onClick={addNote} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD NOTE</button>}
            {notes.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {notes.map((n, index) => (
                  <div key={index}>
                    {editingNoteIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <textarea value={editingNote} onChange={(e) => setEditingNote(e.target.value)} rows={3} className="w-full bg-gray-900 border border-gray-600 rounded-2xl px-4 py-3 text-lg resize-none" />
                        <div className="flex gap-3">
                          <button onClick={saveEditNote} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={() => setEditingNoteIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-start justify-between gap-4 px-4 py-3 ${index < notes.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <p className="flex-1 text-base text-gray-300 whitespace-pre-wrap">{n.note}</p>
                        {!locked && (
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => startEditNote(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removeNote(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ACTION BAR */}
      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">MARKUP (grand total − expenses)</span>
            <span className={`text-xl font-bold ${finalProfit < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(finalProfit)}{expensesTotal > 0 ? ` · ${finalProfitPct.toFixed(2)}%` : ''}</span>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
            {locked ? (
              <button onClick={() => save('DRAFT')} disabled={saving} className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">REOPEN (back to DRAFT)</button>
            ) : (
              <>
                <button onClick={() => save()} disabled={saving} className="flex-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{saving ? 'SAVING...' : 'SAVE DRAFT'}</button>
                <button onClick={() => save('CLOSED')} disabled={saving} className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{saving ? 'SAVING...' : 'CLOSE (lock as template)'}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
