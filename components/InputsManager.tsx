'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

type Input = {
  id: string
  description: string
  category: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  notes: string | null
  purchase_group?: string | null
  // STOCK rows carry an origin:
  //   PURCHASED = entered via EXPENSES -> SEND TO STOCK, or via this page
  //               (manual add / scanned purchase with category=STOCK).
  //   DONATED   = entered via PARTS TO STOCK box on a ride invoice. The donor
  //               column then holds the original donor (e.g. "GZ28-005 — Mustang").
  source_type?: string | null
  donor?: string | null
}

// After confirming a scanned purchase we queue an ExpenseReport for the optional
// WhatsApp share. One scan = one report (which can list multiple items).
type ExpenseReportItem = { item: string; amount: string; quantity: string }
type ExpenseReport = {
  category: string // STOCK or CONSUMPTION
  supplier: string
  date: string
  receipt_url: string
  items: ExpenseReportItem[]
  report: boolean
}
// Surfaced when a scan looks like a previously-registered purchase.
type DuplicateInfo = { title: string; details: string; proceed: () => void }

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// Shared list/manager used by two routes:
//   mode="CONSUMPTION"  -> /inputs    (titled INPUTS)
//   mode="STOCK"        -> /inventory (titled INVENTORY)
// Each route only shows, totals, scans and adds rows of its own category.
export default function InputsManager({ mode, table }: { mode: 'CONSUMPTION' | 'STOCK'; table: 'inputs' | 'inventory' }) {
  const isStockMode = mode === 'STOCK'
  const noun = isStockMode ? 'ITEM' : 'INPUT'
  // STOCK rows live in the `inventory` table; CONSUMPTION in `inputs`. The shared
  // /inputs/* detail pages switch table via ?src=inventory.
  const itemQuery = table === 'inventory' ? '?src=inventory' : ''
  const addQuery = `?category=${mode}${table === 'inventory' ? '&src=inventory' : ''}`

  const [inputs, setInputs] = useState<Input[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Group-level removal confirmation: stores the purchase_group UUID to delete.
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Group-level EDIT modal state. Editing a purchase updates supplier + date on
  // every item that shares the same purchase_group (mirroring the edit-invoice
  // page behavior). Per-item description/qty/price are still edited individually.
  const [editingPurchaseGroupId, setEditingPurchaseGroupId] = useState<string | null>(null)
  const [editingPurchaseSupplier, setEditingPurchaseSupplier] = useState('')
  const [editingPurchaseDate, setEditingPurchaseDate] = useState('')

  // ADD PURCHASE state
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{
    supplier: string
    date: string
    category: string
    items: { description: string; amount: string; quantity: string }[]
    receiptUrl: string
  } | null>(null)

  // WhatsApp + duplicate-warning state
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  const [soldIds, setSoldIds] = useState<Set<string>>(new Set())

  useEffect(() => { loadInputs() }, [])

  async function loadInputs() {
    // Order by the actual purchase_date (newest first), with created_at as a
    // tiebreaker so rows entered later for the same day still float to the top.
    // nullsFirst:false pushes inputs with no purchase_date to the bottom.
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('category', mode)
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }
    setInputs(data || [])
    setLoading(false)
    // Purchases start collapsed; the user expands the ones they want to inspect.
    setExpandedGroups(new Set())
    // STOCK: an item with any sale INCOME is SOLD (moves to the SOLD section at the bottom).
    if (isStockMode) {
      const ids = (data || []).map((i: Input) => i.id)
      if (ids.length) {
        const { data: sales } = await supabase.from('inventory_sales').select('inventory_id').eq('kind', 'INCOME').in('inventory_id', ids)
        setSoldIds(new Set((sales || []).map((x: any) => x.inventory_id)))
      } else setSoldIds(new Set())
    }
  }

  async function removeInput(id: string) {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadInputs()
  }

  // Group-level operations.
  function startEditPurchase(groupId: string, groupInputs: Input[]) {
    const first = groupInputs[0]
    setEditingPurchaseGroupId(groupId)
    setEditingPurchaseSupplier(first.supplier || '')
    setEditingPurchaseDate(first.purchase_date || '')
  }

  async function confirmEditPurchase() {
    if (!editingPurchaseGroupId) return
    const { error } = await supabase.from(table).update({
      supplier: editingPurchaseSupplier || null,
      purchase_date: isValidDate(editingPurchaseDate) ? editingPurchaseDate : null,
    }).eq('purchase_group', editingPurchaseGroupId)
    if (error) { alert(error.message); return }
    setEditingPurchaseGroupId(null)
    loadInputs()
  }

  async function removePurchaseGroup(groupId: string) {
    const { error } = await supabase.from(table).delete().eq('purchase_group', groupId)
    if (error) { alert(error.message); return }
    setConfirmGroupId(null)
    loadInputs()
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  async function handleAddPurchase(file: File) {
    setScanningPurchase(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `inputs/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      const receiptUrl = urlData.publicUrl

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: file.type }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPurchase(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const items = (parsed.items || []).map((i: any) => ({
        description: String(i.description || ''),
        amount: String(i.amount || '0'),
        quantity: String(i.quantity || '1'),
      }))
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)

      const openReview = () => setScannedPurchase({ supplier, date, category: mode, items, receiptUrl })

      // Duplicate check: any existing inputs row with the same supplier+date+total
      // (summed per purchase_group) is treated as a possible re-scan.
      if (supplier && date && total > 0) {
        const { data: existing } = await supabase
          .from(table)
          .select('id, supplier, purchase_date, unit_price, quantity, purchase_group')
          .ilike('supplier', supplier)
          .eq('purchase_date', date)

        if (existing && existing.length > 0) {
          const groupTotals = new Map<string, number>()
          existing.forEach(e => {
            const key = e.purchase_group || e.id
            const lineT = (parseFloat(e.unit_price) || 0) * (parseFloat(e.quantity) || 1)
            groupTotals.set(key, (groupTotals.get(key) || 0) + lineT)
          })
          const matches = Array.from(groupTotals.values()).some(t => Math.abs(t - total) < 0.01)
          if (matches) {
            setScanningPurchase(false)
            setDuplicateWarning({
              title: 'POSSIBLE DUPLICATE PURCHASE',
              details: `A purchase from "${supplier}" on ${formatDate(date)} for ${formatUSD(total)} already exists.\n\nIs this the same receipt being scanned again?`,
              proceed: openReview,
            })
            return
          }
        }
      }

      openReview()
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again.')
    }
    setScanningPurchase(false)
  }

  async function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const groupId = generateUUID()
    // STOCK purchases entered via this page are always PURCHASED (donor stays null).
    // CONSUMPTION rows don't use source_type at all.
    const isStock = scannedPurchase.category === 'STOCK'
    const { error } = await supabase.from(table).insert(
      scannedPurchase.items.map(item => ({
        description: item.description,
        category: scannedPurchase.category,
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        purchase_date: isValidDate(scannedPurchase.date) ? scannedPurchase.date : null,
        supplier: scannedPurchase.supplier || null,
        receipt_url: JSON.stringify([scannedPurchase.receiptUrl]),
        purchase_group: groupId,
        source_type: isStock ? 'PURCHASED' : null,
        donor: null,
      }))
    )
    if (error) { alert(error.message); return }

    // Queue the optional WhatsApp report for this purchase.
    const report: ExpenseReport = {
      category: scannedPurchase.category,
      supplier: scannedPurchase.supplier,
      date: scannedPurchase.date,
      receipt_url: scannedPurchase.receiptUrl,
      items: scannedPurchase.items.map(it => ({ item: it.description, amount: it.amount, quantity: it.quantity })),
      report: true,
    }

    setScannedPurchase(null)
    setExpenseReports([report])
    loadInputs()
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
    const amountStr = formatUSD(total)
    const lines: string[] = [
      `*EXPENSE — ${exp.category}*`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())

    // Item bullets — always shown, single or multiple.
    lines.push('')
    exp.items.forEach(it => {
      const qty = parseFloat(it.quantity) || 1
      const price = parseFloat(it.amount) || 0
      const itemTotal = price * qty
      lines.push(`• ${it.item} — ${qty} × ${formatUSD(price)} = ${formatUSD(itemTotal)}`)
    })

    return lines.join('\n') + '\n\nSent by GZ28 Control App'
  }

  async function sendExpenseReports() {
    const chosen = (expenseReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    for (const exp of chosen) {
      const caption = buildExpenseCaption(exp)
      const payload: any = { body: caption }
      if (exp.receipt_url) {
        payload.documentUrl = exp.receipt_url
        payload.filename = `expense-${exp.supplier || 'purchase'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
      }
      try {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!data.ok) failures++
      } catch {
        failures++
      }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The purchase was still saved.`)
    setExpenseReports(null)
  }

  // STOCK rows with 0 quantity are hidden (sold out). CONSUMPTION rows always show.
  const visibleInputs = inputs.filter(i => !(isStockMode && i.quantity <= 0))
  // SOLD stock items (those with a sale income) move to their own section and no longer
  // count toward the stock total.
  const total = visibleInputs.filter(i => !soldIds.has(i.id)).reduce((s, i) => s + i.quantity * i.unit_price, 0)

  // Optional text search across description / supplier / notes / donor. Totals stay
  // on the full inventory; only the displayed rows are narrowed.
  const term = search.trim().toLowerCase()
  const filteredInputs = term
    ? visibleInputs.filter(i => [i.description, i.supplier, i.notes, i.donor].some(f => (f || '').toLowerCase().includes(term)))
    : visibleInputs
  const activeFiltered = filteredInputs.filter(i => !soldIds.has(i.id))
  const soldFiltered = filteredInputs.filter(i => soldIds.has(i.id))

  // Build rows: group purchases together (active, non-sold items only)
  const rows: { type: 'single' | 'group'; input?: Input; groupId?: string; groupInputs?: Input[] }[] = []
  const seenGroups = new Set<string>()
  activeFiltered.forEach(input => {
    if (input.purchase_group) {
      if (!seenGroups.has(input.purchase_group)) {
        seenGroups.add(input.purchase_group)
        const groupInputs = activeFiltered.filter(i => i.purchase_group === input.purchase_group)
        rows.push({ type: 'group', groupId: input.purchase_group, groupInputs })
      }
    } else {
      rows.push({ type: 'single', input })
    }
  })

  // Returns the source-type badge JSX for a STOCK row. DONATED rows get an orange
  // badge plus a donor line; PURCHASED (or legacy/null) rows get a small gray badge.
  // Returns null for non-STOCK rows.
  function sourceBadge(input: Input) {
    if (input.category !== 'STOCK') return null
    const isDonated = input.source_type === 'DONATED'
    return (
      <span className={`px-3 py-1 rounded-full text-sm font-bold ${isDonated ? 'bg-orange-900 text-orange-300' : 'bg-gray-700 text-gray-300'}`}>
        {isDonated ? 'DONATED' : 'PURCHASED'}
      </span>
    )
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* CONFIRM DELETE SINGLE INPUT */}
      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove {noun.charAt(0) + noun.slice(1).toLowerCase()}</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this {noun.toLowerCase()}? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeInput(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM DELETE PURCHASE GROUP */}
      {confirmGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Purchase</h2>
            <p className="text-gray-400 text-lg mb-8">This will remove ALL items in this purchase. This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmGroupId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePurchaseGroup(confirmGroupId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT PURCHASE MODAL */}
      {editingPurchaseGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">EDIT PURCHASE</h2>
              <button onClick={() => setEditingPurchaseGroupId(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
              <input type="text" value={editingPurchaseSupplier} onChange={(e) => setEditingPurchaseSupplier(e.target.value)} className={inputClass} />
            </div>
            <DatePicker label="DATE" value={editingPurchaseDate} onChange={setEditingPurchaseDate} />
            <button onClick={confirmEditPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">SAVE</button>
          </div>
        </div>
      )}

      {/* DUPLICATE WARNING */}
      {duplicateWarning && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-2xl font-bold text-yellow-400">⚠ {duplicateWarning.title}</h2>
            <p className="text-gray-300 whitespace-pre-wrap text-base">{duplicateWarning.details}</p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setDuplicateWarning(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={() => { const p = duplicateWarning.proceed; setDuplicateWarning(null); p() }} className="flex-1 bg-yellow-700 hover:bg-yellow-600 px-5 py-3 rounded-2xl font-bold text-lg">REGISTER ANYWAY</button>
            </div>
          </div>
        </div>
      )}

      {/* REVIEW PURCHASE MODAL */}
      {scannedPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW PURCHASE</h2>
              <button onClick={() => setScannedPurchase(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                <input type="text" value={scannedPurchase.supplier} onChange={(e) => setScannedPurchase({ ...scannedPurchase, supplier: e.target.value })} className={inputClass} />
              </div>
              <div className="flex-1">
                <DatePicker label="DATE" value={scannedPurchase.date} onChange={(v) => setScannedPurchase({ ...scannedPurchase, date: v })} />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-2">
              {scannedPurchase.items.map((item, i) => (
                <div key={i} className="flex gap-3 items-center">
                  <input type="text" value={item.description} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], description: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} flex-1`} placeholder="Description" />
                  <div className="w-20">
                    <input type="text" inputMode="decimal" value={item.quantity} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], quantity: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} w-full text-center`} placeholder="Qty" />
                  </div>
                  <div className="relative w-32">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input type="text" value={item.amount} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], amount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} pl-8`} placeholder="0.00" />
                  </div>
                  <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: scannedPurchase.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2">✕</button>
                </div>
              ))}
              <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: [...scannedPurchase.items, { description: '', amount: '', quantity: '1' }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0))}
              </div>
              <button onClick={confirmScannedPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {/* REPORT ON WHATSAPP? */}
      {expenseReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            </div>
            <p className="text-gray-400 text-base">Choose whether to report this purchase to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const expTotal = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                const titleText = `${exp.supplier || 'Purchase'} — ${exp.items.length} item${exp.items.length === 1 ? '' : 's'}`
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — {exp.category} — {formatUSD(expTotal)}</p>
                      <p className="text-sm text-gray-400 truncate" title={titleText}>{titleText}</p>
                      <p className="text-sm text-gray-400">{isValidDate(exp.date) ? formatDate(exp.date) : 'No date'}</p>
                      <p className="text-sm text-gray-500">{exp.receipt_url ? '📎 Receipt attached' : 'No receipt (text only)'}</p>
                    </div>
                    <button
                      onClick={() => { const a = [...expenseReports]; a[i] = { ...a[i], report: !a[i].report }; setExpenseReports(a) }}
                      className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap ${exp.report ? 'bg-green-700 hover:bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                    >
                      {exp.report ? 'REPORT: YES' : 'REPORT: NO'}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-gray-400 font-bold self-center">
                {expenseReports.filter(r => r.report).length} of {expenseReports.length} will be reported
              </div>
              <button onClick={sendExpenseReports} disabled={sendingReports} className={`px-6 py-3 rounded-2xl font-bold text-lg ${sendingReports ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sendingReports ? 'SENDING...' : 'DONE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SCANNING OVERLAY */}
      {scanningPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">Scanning Receipt...</p>
            <p className="text-gray-400">Claude is reading your receipt</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">{isStockMode ? 'INVENTORY' : 'INPUTS'} ({filteredInputs.length})</h1>
        <div className="flex gap-3">
          <label className="bg-indigo-700 hover:bg-indigo-600 px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer">
            🧾 SCAN A NEW {noun}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleAddPurchase(e.target.files[0]) }} />
          </label>
          <Link href={`/inputs/new${addQuery}`} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW {noun}</Link>
        </div>
      </div>

      {visibleInputs.length > 0 && (
        <div className="flex gap-4 mb-6 flex-wrap">
          <div className={`${isStockMode ? 'bg-green-900' : 'bg-blue-900'} rounded-2xl px-6 py-4`}>
            <p className={`text-sm font-bold ${isStockMode ? 'text-green-300' : 'text-blue-300'}`}>{isStockMode ? 'STOCK TOTAL' : 'CONSUMPTION TOTAL'}</p>
            <p className="text-2xl font-bold">{formatUSD(total)}</p>
          </div>
        </div>
      )}

      {visibleInputs.length > 0 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${isStockMode ? 'inventory' : 'inputs'} by item, supplier or note...`}
          className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg mb-6"
        />
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filteredInputs.length === 0 ? (
        <p className="text-2xl text-gray-400">{visibleInputs.length === 0 ? `No ${isStockMode ? 'inventory items' : 'inputs'} found.` : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {rows.map((row) => {
            if (row.type === 'group' && row.groupId && row.groupInputs) {
              const groupId = row.groupId
              const groupInputs = row.groupInputs
              const first = groupInputs[0]
              const groupTotal = groupInputs.reduce((s, i) => s + i.quantity * i.unit_price, 0)
              const isExpanded = expandedGroups.has(groupId)
              return (
                <div key={groupId} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                  {/* Group header: text area is the toggle target; buttons live in their own
                      flex section so clicking EDIT or REMOVE doesn't expand/collapse. */}
                  <div className="p-6 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleGroup(groupId)}>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                        <h2 className="text-2xl font-bold">{first.supplier || 'Unknown Supplier'}</h2>
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${first.category === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`}>{first.category}</span>
                        {sourceBadge(first)}
                      </div>
                      <p className="text-lg text-gray-400 ml-7">{groupInputs.length} items — {formatUSD(groupTotal)} — {formatDate(first.purchase_date)}</p>
                    </div>
                    <div className="flex gap-3 flex-wrap shrink-0">
                      <Link href={`/inputs/group/${groupId}${itemQuery}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                      <button onClick={() => startEditPurchase(groupId, groupInputs)} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>
                      <button onClick={() => setConfirmGroupId(groupId)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-800">
                      {groupInputs.map((input, gi) => (
                        <div key={input.id} className={`flex items-center justify-between gap-6 px-6 py-4 ${gi < groupInputs.length - 1 ? 'border-b border-gray-800' : ''}`}>
                          <div className="flex-1 min-w-0 pl-5">
                            <h3 className="text-xl font-bold">{input.description}</h3>
                            <p className="text-lg text-gray-400">Qty: {input.quantity} × {formatUSD(input.unit_price)} = {formatUSD(input.quantity * input.unit_price)}</p>
                            {input.notes && (
                              <div className="mt-1 space-y-1">
                                {input.notes.split('\n').map((note, i) => (
                                  <p key={i} className="text-sm text-yellow-400">📦 {note}</p>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-3 shrink-0">
                            {isStockMode && <Link href={`/inventory/sell/${input.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-4 py-2 rounded-2xl font-bold text-sm">💲 SELL</Link>}
                            <Link href={`/inputs/${input.id}${itemQuery}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm">VIEW</Link>
                            <Link href={`/inputs/edit/${input.id}${itemQuery}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</Link>
                            <button onClick={() => setConfirmId(input.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            } else if (row.type === 'single' && row.input) {
              const input = row.input
              const isDonated = input.category === 'STOCK' && input.source_type === 'DONATED'
              return (
                <div key={input.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                      <h2 className="text-2xl font-bold">{input.description}</h2>
                      <span className={`px-3 py-1 rounded-full text-sm font-bold ${input.category === 'CONSUMPTION' ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'}`}>
                        {input.category}
                      </span>
                      {sourceBadge(input)}
                    </div>
                    {isDonated && input.donor && <p className="text-lg text-orange-400">Donor: {input.donor}</p>}
                    {input.supplier && !isDonated && <p className="text-lg text-gray-400">Supplier: {input.supplier}</p>}
                    <p className="text-lg text-gray-400">Qty: {input.quantity} × {formatUSD(input.unit_price)} = {formatUSD(input.quantity * input.unit_price)}</p>
                    <p className="text-lg text-gray-400">Purchased: {formatDate(input.purchase_date)}</p>
                    {input.notes && (
                      <div className="mt-2 space-y-1">
                        {input.notes.split('\n').map((note, i) => (
                          <p key={i} className="text-sm text-yellow-400">📦 {note}</p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 flex-wrap shrink-0">
                    {isStockMode && <Link href={`/inventory/sell/${input.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold">💲 SELL</Link>}
                    <Link href={`/inputs/${input.id}${itemQuery}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                    <Link href={`/inputs/edit/${input.id}${itemQuery}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                    <button onClick={() => setConfirmId(input.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                  </div>
                </div>
              )
            }
            return null
          })}
        </div>
      )}

      {isStockMode && soldFiltered.length > 0 && (
        <div className="mt-10">
          <h2 className="text-2xl font-bold mb-4 text-amber-400">SOLD ({soldFiltered.length})</h2>
          <div className="space-y-3">
            {soldFiltered.map((input) => (
              <div key={input.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-center justify-between gap-4 flex-wrap opacity-90">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-xl font-bold truncate">{input.description}</h3>
                    <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-700 text-black">SOLD</span>
                  </div>
                  <p className="text-gray-400">Qty: {input.quantity} × {formatUSD(input.unit_price)}{input.supplier ? ` · ${input.supplier}` : ''}</p>
                </div>
                <Link href={`/inventory/sell/${input.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold shrink-0">VIEW SALE</Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
