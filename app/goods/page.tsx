'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'
import SourceSelect, { DEFAULT_SOURCE, matchSource } from '@/components/SourceSelect'

function todayStr() { return new Date().toISOString().slice(0, 10) }

type Good = {
  id: string
  description: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  purchase_group?: string | null
  // Stored as a JSON-stringified array of URLs (scanned purchases set one URL).
  receipt_url?: string | null
}

type GoodWithStats = Good & {
  expensesTotal: number
}

// After confirming a scanned good purchase we queue an ExpenseReport for the
// optional WhatsApp share. One scan = one report (which can list multiple items).
type ExpenseReportItem = { item: string; amount: string; quantity: string }
type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  items: ExpenseReportItem[]
  report: boolean
}
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

// receipt_url is stored as a JSON-stringified array of URLs. Tolerant of older
// rows that may have a plain string instead of a JSON array.
function parseReceiptUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

export default function GoodsPage() {
  const [goods, setGoods] = useState<GoodWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Group-level removal confirmation
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Group-level EDIT modal state. Editing a purchase updates supplier + date on
  // every good that shares the same purchase_group (mirrors inputs page).
  const [editingPurchaseGroupId, setEditingPurchaseGroupId] = useState<string | null>(null)
  const [editingPurchaseSupplier, setEditingPurchaseSupplier] = useState('')
  const [editingPurchaseDate, setEditingPurchaseDate] = useState('')

  // SCAN PURCHASE state
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{
    supplier: string
    date: string
    source: string
    tax: string
    shipping: string
    items: { description: string; amount: string; quantity: string }[]
    receiptUrl: string
  } | null>(null)

  // WhatsApp + duplicate-warning state
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)

  useEffect(() => { loadGoods() }, [])

  async function loadGoods() {
    // Order by the actual purchase_date (newest first), with created_at as a
    // tiebreaker so rows entered later for the same day still float to the top.
    // nullsFirst:false pushes goods with no purchase_date to the bottom.
    const { data, error } = await supabase
      .from('goods')
      .select('*')
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }

    const goodsWithStats = await Promise.all((data || []).map(async (good) => {
      const { data: expenses } = await supabase.from('good_expenses').select('amount').eq('good_id', good.id)
      const expensesTotal = (expenses || []).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
      return { ...good, expensesTotal }
    }))

    setGoods(goodsWithStats)
    setLoading(false)
    // Groups start collapsed — the user opens the ones they want to inspect.
  }

  async function removeGood(id: string) {
    const { error } = await supabase.from('goods').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadGoods()
  }

  // Group-level operations.
  function startEditPurchase(groupId: string, groupGoods: GoodWithStats[]) {
    const first = groupGoods[0]
    setEditingPurchaseGroupId(groupId)
    setEditingPurchaseSupplier(first.supplier || '')
    setEditingPurchaseDate(first.purchase_date || '')
  }

  async function confirmEditPurchase() {
    if (!editingPurchaseGroupId) return
    const { error } = await supabase.from('goods').update({
      supplier: editingPurchaseSupplier || null,
      purchase_date: isValidDate(editingPurchaseDate) ? editingPurchaseDate : null,
    }).eq('purchase_group', editingPurchaseGroupId)
    if (error) { alert(error.message); return }
    setEditingPurchaseGroupId(null)
    loadGoods()
  }

  async function removePurchaseGroup(groupId: string) {
    const { error } = await supabase.from('goods').delete().eq('purchase_group', groupId)
    if (error) { alert(error.message); return }
    setConfirmGroupId(null)
    loadGoods()
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  async function handleScanGood(file: File) {
    setScanningPurchase(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `goods/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      const receiptUrl = urlData.publicUrl

      const { base64, mediaType } = await fileForScan(file)

      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // separateExtras keeps the item price clean and returns sales tax + shipping
        // separately (per item) so they can land as the good's extra cost lines.
        body: JSON.stringify({ base64, mediaType, separateExtras: true, today: todayStr() }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPurchase(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      // BRL-as-USD guard: foreign-currency documents never register raw numbers as dollars.
      const fx = await scanCurrencyFx(parsed.currency)
      if (fx == null) { setScanningPurchase(false); return }

      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const source = matchSource(String(parsed.source || '').trim())
      const rawItems = (parsed.items || [])
      const items = rawItems.map((i: any) => ({
        description: String(i.description || ''),
        amount: (((parseFloat(i.amount) || 0) * fx)).toFixed(2),
        quantity: String(i.quantity || '1'),
      }))
      // Sales tax + shipping/extra are summed across the items into the order-level
      // TAX and SHIPPING (each becomes one extra cost line on the good).
      const tax = rawItems.reduce((s: number, it: any) => s + (parseFloat(it.tax) || 0), 0) * fx
      const shipping = rawItems.reduce((s: number, it: any) => s + (parseFloat(it.extra) || 0), 0) * fx
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0) + tax + shipping

      const openReview = () => setScannedPurchase({ supplier, date, source, tax: tax > 0 ? tax.toFixed(2) : '', shipping: shipping > 0 ? shipping.toFixed(2) : '', items, receiptUrl })

      // Duplicate check: any existing goods row with the same supplier+date+total
      // (summed per purchase_group) is treated as a possible re-scan.
      if (supplier && date && total > 0) {
        const { data: existing } = await supabase
          .from('goods')
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
              title: 'POSSIBLE DUPLICATE GOOD',
              details: `A good from "${supplier}" on ${formatDate(date)} for ${formatUSD(total)} already exists.\n\nIs this the same receipt being scanned again?`,
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
    const source = scannedPurchase.source || DEFAULT_SOURCE
    const purchaseDate = isValidDate(scannedPurchase.date) ? scannedPurchase.date : null
    const { data: insertedGoods, error } = await supabase.from('goods').insert(
      scannedPurchase.items.map(item => ({
        description: item.description,
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        purchase_date: purchaseDate,
        supplier: scannedPurchase.supplier || null,
        source,
        receipt_url: JSON.stringify([scannedPurchase.receiptUrl]),
        purchase_group: groupId,
      }))
    ).select('id')
    if (error) { alert(error.message); return }

    // Sales tax + shipping land as extra cost lines (good_expenses) on the first good
    // of the purchase, carrying the same supplier/source/date.
    const firstGoodId = insertedGoods?.[0]?.id
    if (firstGoodId) {
      const extraLines = [
        { description: 'Sales Tax', amount: parseFloat(scannedPurchase.tax) || 0 },
        { description: 'Shipping', amount: parseFloat(scannedPurchase.shipping) || 0 },
      ].filter(x => x.amount > 0)
      if (extraLines.length > 0) {
        await supabase.from('good_expenses').insert(extraLines.map(x => ({
          good_id: firstGoodId,
          description: x.description,
          amount: x.amount,
          expense_date: purchaseDate,
          supplier: scannedPurchase.supplier || null,
          source,
        })))
      }
    }

    // Queue the optional WhatsApp report for this good purchase.
    const report: ExpenseReport = {
      supplier: scannedPurchase.supplier,
      date: scannedPurchase.date,
      receipt_url: scannedPurchase.receiptUrl,
      items: scannedPurchase.items.map(it => ({ item: it.description, amount: it.amount, quantity: it.quantity })),
      report: true,
    }

    setScannedPurchase(null)
    setExpenseReports([report])
    loadGoods()
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
    const amountStr = formatUSD(total)
    const lines: string[] = [
      `*EXPENSE — GOOD*`,
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
        payload.filename = `good-${exp.supplier || 'purchase'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
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
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The good was still saved.`)
    setExpenseReports(null)
  }

  // Build rows: group purchases together. Goods are already sorted by created_at
  // desc from the query; we walk them in order, and the FIRST time we see a
  // purchase_group we emit the whole group as a single row. Standalone goods
  // (no purchase_group) keep their own row. Net effect: most recent group/single
  // first, each group at the position of its newest item.
  const rows: { type: 'single' | 'group'; good?: GoodWithStats; groupId?: string; groupGoods?: GoodWithStats[] }[] = []
  const seenGroups = new Set<string>()
  goods.forEach(good => {
    if (good.purchase_group) {
      if (!seenGroups.has(good.purchase_group)) {
        seenGroups.add(good.purchase_group)
        const groupGoods = goods.filter(g => g.purchase_group === good.purchase_group)
        rows.push({ type: 'group', groupId: good.purchase_group, groupGoods })
      }
    } else {
      rows.push({ type: 'single', good })
    }
  })

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Good</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this good? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeGood(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {confirmGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Purchase</h2>
            <p className="text-gray-400 text-lg mb-8">This will remove ALL goods in this purchase. This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmGroupId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePurchaseGroup(confirmGroupId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

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
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                <input type="text" value={scannedPurchase.supplier} onChange={(e) => setScannedPurchase({ ...scannedPurchase, supplier: e.target.value })} className={inputClass} />
              </div>
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-sm text-gray-400">PAID FROM</label>
                <SourceSelect value={scannedPurchase.source} onChange={(v) => setScannedPurchase({ ...scannedPurchase, source: v })} className={inputClass} />
              </div>
              <div className="flex-1 min-w-[10rem]">
                <DatePicker label="DATE" value={scannedPurchase.date} onChange={(v) => setScannedPurchase({ ...scannedPurchase, date: v })} />
              </div>
            </div>
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[8rem]">
                <label className="block mb-1 text-sm text-gray-400">SALES TAX</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" value={scannedPurchase.tax} onChange={(e) => setScannedPurchase({ ...scannedPurchase, tax: e.target.value })} className={`${inputClass} pl-8`} placeholder="0.00" />
                </div>
              </div>
              <div className="flex-1 min-w-[8rem]">
                <label className="block mb-1 text-sm text-gray-400">SHIPPING</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" value={scannedPurchase.shipping} onChange={(e) => setScannedPurchase({ ...scannedPurchase, shipping: e.target.value })} className={`${inputClass} pl-8`} placeholder="0.00" />
                </div>
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
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0) + (parseFloat(scannedPurchase.tax) || 0) + (parseFloat(scannedPurchase.shipping) || 0))}
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
                const total = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                const titleText = `${exp.supplier || 'Purchase'} — ${exp.items.length} item${exp.items.length === 1 ? '' : 's'}`
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — GOOD — {formatUSD(total)}</p>
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

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">GOODS ({goods.length})</h1>
        <div className="flex gap-3">
          <label className="bg-indigo-700 hover:bg-indigo-600 px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer">
            🧾 SCAN A NEW GOOD
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanGood(e.target.files[0]) }} />
          </label>
          <Link href="/goods/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW GOOD</Link>
        </div>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : goods.length === 0 ? (
        <p className="text-2xl text-gray-400">No goods found.</p>
      ) : (
        <div className="space-y-5">
          {rows.map((row) => {
            if (row.type === 'group' && row.groupId && row.groupGoods) {
              const groupId = row.groupId
              const groupGoods = row.groupGoods
              const first = groupGoods[0]
              const groupItemsTotal = groupGoods.reduce((s, g) => s + g.quantity * g.unit_price, 0)
              const groupExpensesTotal = groupGoods.reduce((s, g) => s + g.expensesTotal, 0)
              const groupTotal = groupItemsTotal + groupExpensesTotal
              const isExpanded = expandedGroups.has(groupId)
              return (
                <div key={groupId} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                  {/* Group header: text area toggles expand/collapse; buttons live in
                      their own flex section so clicks don't bubble to the toggle. */}
                  <div className="p-6 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleGroup(groupId)}>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                        <h2 className="text-2xl font-bold">{first.supplier || 'Unknown Supplier'}</h2>
                      </div>
                      <p className="text-lg text-gray-400 ml-7">{groupGoods.length} items — {formatUSD(groupTotal)} — {formatDate(first.purchase_date)}</p>
                    </div>
                    <div className="flex gap-3 flex-wrap shrink-0">
                      {(() => {
                        // VIEW at the purchase level opens the scanned receipt in
                        // a new tab. Only rendered when there's a URL to open.
                        const urls = parseReceiptUrls(first.receipt_url)
                        const url = urls[0]
                        return url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</a>
                        ) : null
                      })()}
                      <button onClick={() => startEditPurchase(groupId, groupGoods)} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>
                      <button onClick={() => setConfirmGroupId(groupId)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-800">
                      {groupGoods.map((good, gi) => (
                        <div key={good.id} className={`flex items-center justify-between gap-6 px-6 py-4 ${gi < groupGoods.length - 1 ? 'border-b border-gray-800' : ''}`}>
                          <div className="flex-1 min-w-0 pl-5">
                            <h3 className="text-xl font-bold">{good.description}</h3>
                            <p className="text-lg text-gray-400">Qty: {good.quantity} × {formatUSD(good.unit_price)} = {formatUSD(good.quantity * good.unit_price)}</p>
                            {good.expensesTotal > 0 && <p className="text-lg text-gray-400">Expenses: {formatUSD(good.expensesTotal)}</p>}
                            <p className="text-lg font-bold mt-1">Total Cost: {formatUSD(good.quantity * good.unit_price + good.expensesTotal)}</p>
                          </div>
                          <div className="flex gap-3 shrink-0">
                            <Link href={`/goods/${good.id}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm">VIEW</Link>
                            <Link href={`/goods/edit/${good.id}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</Link>
                            <button onClick={() => setConfirmId(good.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            } else if (row.type === 'single' && row.good) {
              const good = row.good
              return (
                <div key={good.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-2xl font-bold mb-1">{good.description}</h2>
                    {good.supplier && <p className="text-lg text-gray-400">Supplier: {good.supplier}</p>}
                    <p className="text-lg text-gray-400">Qty: {good.quantity} × {formatUSD(good.unit_price)} = {formatUSD(good.quantity * good.unit_price)}</p>
                    <p className="text-lg text-gray-400">Purchased: {formatDate(good.purchase_date)}</p>
                    {good.expensesTotal > 0 && <p className="text-lg text-gray-400">Expenses: {formatUSD(good.expensesTotal)}</p>}
                    <p className="text-lg font-bold mt-1">Total Cost: {formatUSD(good.quantity * good.unit_price + good.expensesTotal)}</p>
                  </div>
                  <div className="flex gap-3 flex-wrap shrink-0">
                    <Link href={`/goods/${good.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                    <Link href={`/goods/edit/${good.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                    <button onClick={() => setConfirmId(good.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                  </div>
                </div>
              )
            }
            return null
          })}
        </div>
      )}
    </main>
  )
}
