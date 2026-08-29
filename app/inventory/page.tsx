'use client'

// INVENTORY — resale stock ledger, rebuilt 2026-07-30 to the app's current
// standards, twin of the new SHOP INPUTS page (both replaced the shared
// InputsManager, one of the first components ever built).
//   * top line = title + SEARCH + action buttons; status chips on the line
//     below (ALL / PURCHASED / DONATED / SOLD) with the stock-value summary
//   * purchases grouped by receipt, newest purchase first, 📎 receipt link
//   * per-item 💲 SELL; items with a sale INCOME show under SOLD; sold-out
//     rows (qty ≤ 0) stay hidden
//   * scan flow kept: currency guard, duplicate warning, WhatsApp report

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'
import { OrderChip, StreamChip, loadStreamMap, streamFor, type StreamInfo } from '@/components/StreamChips'

type ItemRow = {
  id: string
  description: string
  category: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  notes: string | null
  purchase_group: string | null
  receipt_url: string | null
  created_at: string
  // PURCHASED = bought (EXPENSES → SEND TO STOCK, scan or manual add).
  // DONATED   = came from a ride invoice's PARTS TO STOCK box.
  // Either way the origin lives in ONE field — `supplier`: the vendor when bought, the
  // DONOR CAR when it came off a car's invoice (user law 22/aug/2026).
  source_type: string | null
  // Documento que trouxe a peça: o pedido do fornecedor, ou a INVOICE do carro que doou.
  order_number: string | null
}

type Purchase = {
  key: string
  groupId: string | null
  supplier: string | null
  date: string | null
  items: ItemRow[]
  total: number
  receipt: string | null
  donated: boolean
}

type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  items: { item: string; amount: string; quantity: string }[]
  report: boolean
}
type DuplicateInfo = { title: string; details: string; proceed: () => void }

const STATUSES = ['ALL', 'PURCHASED', 'DONATED', 'SOLD'] as const
type Status = typeof STATUSES[number]

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}
function firstReceipt(raw: string | null): string | null {
  if (!raw) return null
  try { const a = JSON.parse(raw); return Array.isArray(a) && a[0] ? String(a[0]) : null } catch { return null }
}

export default function InventoryPage() {
  const [rows, setRows] = useState<ItemRow[]>([])
  // Semáforo do STREAM por order_number normalizado — só as linhas PURCHASED
  // usam (o order_number de uma DONATED é a invoice doadora, não um pedido).
  const [streams, setStreams] = useState<Record<string, StreamInfo>>({})
  const [soldIds, setSoldIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status>('ALL')


  const [confirmItemId, setConfirmItemId] = useState<string | null>(null)
  const [confirmPurchase, setConfirmPurchase] = useState<Purchase | null>(null)
  const [editPurchase, setEditPurchase] = useState<Purchase | null>(null)
  const [editSupplier, setEditSupplier] = useState('')
  const [editDate, setEditDate] = useState('')

  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState<{
    supplier: string
    date: string
    // ORDER NUMBER é SAGRADO (29/ago/2026): só linhas PURCHASED nascem por
    // aqui, e toda compra escaneada grava o pedido.
    orderNumber: string
    items: { description: string; amount: string; quantity: string }[]
    receiptUrl: string
  } | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('category', 'STOCK')
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }
    const all = (data || []) as ItemRow[]
    setRows(all)
    // An item with any sale INCOME is SOLD.
    const ids = all.map(i => i.id)
    if (ids.length) {
      const { data: sales } = await supabase.from('inventory_sales').select('inventory_id').eq('kind', 'INCOME').in('inventory_id', ids)
      setSoldIds(new Set((sales || []).map((x: any) => x.inventory_id)))
    } else setSoldIds(new Set())
    // Join com o STREAM (leitura pura): o tracking mora só em part_streams.
    setStreams(await loadStreamMap())
    setLoading(false)
  }

  // Sold-out rows (qty ≤ 0) never show; SOLD items render in their own view.
  const liveRows = useMemo(() => rows.filter(r => r.quantity > 0), [rows])
  const stockRows = useMemo(() => liveRows.filter(r => !soldIds.has(r.id)), [liveRows, soldIds])
  const soldRows = useMemo(() => liveRows.filter(r => soldIds.has(r.id)), [liveRows, soldIds])

  const purchases = useMemo<Purchase[]>(() => {
    const list: Purchase[] = []
    const seen = new Set<string>()
    for (const r of stockRows) {
      const key = r.purchase_group || r.id
      if (seen.has(key)) continue
      seen.add(key)
      const items = r.purchase_group ? stockRows.filter(x => x.purchase_group === r.purchase_group) : [r]
      list.push({
        key,
        groupId: r.purchase_group,
        supplier: items[0].supplier,
        date: items[0].purchase_date,
        items,
        total: items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0),
        receipt: items.map(i => firstReceipt(i.receipt_url)).find(Boolean) || null,
        donated: items.every(i => i.source_type === 'DONATED'),
      })
    }
    return list
  }, [stockRows])

  // Summary: value sitting in stock (sold and sold-out excluded), donated slice apart.
  const stockValue = stockRows.reduce((s, i) => s + i.quantity * i.unit_price, 0)
  const donatedValue = stockRows.filter(i => i.source_type === 'DONATED').reduce((s, i) => s + i.quantity * i.unit_price, 0)

  const term = search.trim().toLowerCase()
  const matches = (i: ItemRow) => !term || [i.description, i.supplier, i.notes, i.order_number].some(f => (f || '').toLowerCase().includes(term))
  const visible = status === 'SOLD' ? [] : purchases.filter(p => {
    const statusOk = status === 'ALL' || (status === 'DONATED' ? p.donated : !p.donated)
    return statusOk && p.items.some(matches)
  })
  const visibleSold = status === 'ALL' || status === 'SOLD' ? soldRows.filter(matches) : []


  async function removeItem(id: string) {
    const { error } = await supabase.from('inventory').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmItemId(null)
    load()
  }

  async function removePurchase(p: Purchase) {
    const { error } = p.groupId
      ? await supabase.from('inventory').delete().eq('purchase_group', p.groupId)
      : await supabase.from('inventory').delete().eq('id', p.items[0].id)
    if (error) { alert(error.message); return }
    setConfirmPurchase(null)
    load()
  }

  function startEdit(p: Purchase) {
    setEditPurchase(p)
    setEditSupplier(p.supplier || '')
    setEditDate(p.date || '')
  }

  async function confirmEdit() {
    if (!editPurchase) return
    // Corrigir a data da compra move as DUAS — a de pagamento não fica pra trás.
    const patch = {
      supplier: editSupplier || null,
      purchase_date: isValidDate(editDate) ? editDate : null,
      payment_date: isValidDate(editDate) ? editDate : null,
    }
    const { error } = editPurchase.groupId
      ? await supabase.from('inventory').update(patch).eq('purchase_group', editPurchase.groupId)
      : await supabase.from('inventory').update(patch).eq('id', editPurchase.items[0].id)
    if (error) { alert(error.message); return }
    setEditPurchase(null)
    load()
  }

  async function handleScan(file: File) {
    setScanning(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `inputs/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanning(false); return }
      const receiptUrl = supabase.storage.from('good-receipts').getPublicUrl(path).data.publicUrl

      const { base64, mediaType } = await fileForScan(file)
      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mediaType }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanning(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())

      // Foreign-currency guard: BRL numbers never register as raw dollars.
      const fx = await scanCurrencyFx(parsed.currency)
      if (fx == null) { setScanning(false); return }

      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      // Nº do pedido como impresso no documento (zeros à esquerda, hífens, sem '#').
      const orderNumber = String(parsed.order_number || '').trim()
      const items = (parsed.items || []).map((i: any) => ({
        description: String(i.description || ''),
        amount: (((parseFloat(i.amount) || 0) * fx)).toFixed(2),
        quantity: String(i.quantity || '1'),
      }))
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
      const openReview = () => setScanned({ supplier, date, orderNumber, items, receiptUrl })

      if (supplier && date && total > 0) {
        const match = purchases.find(p =>
          (p.supplier || '').toLowerCase() === supplier.toLowerCase() &&
          p.date === date && Math.abs(p.total - total) < 0.01)
        if (match) {
          setScanning(false)
          setDuplicateWarning({
            title: 'POSSIBLE DUPLICATE PURCHASE',
            details: `A purchase from "${supplier}" on ${fmtDate(date)} for ${formatUSD(total)} already exists.\n\nIs this the same receipt being scanned again?`,
            proceed: openReview,
          })
          return
        }
      }
      openReview()
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again.')
    }
    setScanning(false)
  }

  async function confirmScanned() {
    if (!scanned) return
    const groupId = generateUUID()
    const { error } = await supabase.from('inventory').insert(
      scanned.items.map(item => ({
        description: item.description,
        category: 'STOCK',
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        // UMA DATA SÓ (lei 18/ago, reafirmada 26/ago): a data da compra É a do
        // pagamento. O scan gravava só purchase_date e a peça ficava parecendo
        // não paga.
        purchase_date: isValidDate(scanned.date) ? scanned.date : null,
        payment_date: isValidDate(scanned.date) ? scanned.date : null,
        supplier: scanned.supplier || null,
        // ORDER NUMBER sagrado: o pedido REAL da compra (linhas PURCHASED).
        // Nunca confundir com o uso do campo nas DONATED (invoice doadora).
        order_number: scanned.orderNumber || null,
        receipt_url: JSON.stringify([scanned.receiptUrl]),
        purchase_group: groupId,
        source_type: 'PURCHASED',

      }))
    )
    if (error) { alert(error.message); return }
    setExpenseReports([{
      supplier: scanned.supplier,
      date: scanned.date,
      receipt_url: scanned.receiptUrl,
      items: scanned.items.map(it => ({ item: it.description, amount: it.amount, quantity: it.quantity })),
      report: true,
    }])
    setScanned(null)
    load()
  }

  function buildCaption(exp: ExpenseReport) {
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
    const lines = [
      `*EXPENSE — STOCK*`,
      `${isValidDate(exp.date) ? fmtDate(exp.date) : '—'} — *${formatUSD(total)}*`,
    ]
    if (exp.supplier.trim()) lines.push(exp.supplier.trim())
    lines.push('')
    exp.items.forEach(it => {
      const qty = parseFloat(it.quantity) || 1
      const price = parseFloat(it.amount) || 0
      lines.push(`• ${it.item} — ${qty} × ${formatUSD(price)} = ${formatUSD(price * qty)}`)
    })
    return lines.join('\n') + '\n\nSent by GZ28 Control App'
  }

  async function sendReports() {
    const chosen = (expenseReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    for (const exp of chosen) {
      const payload: any = { body: buildCaption(exp) }
      if (exp.receipt_url) {
        payload.documentUrl = exp.receipt_url
        payload.filename = `expense-${exp.supplier || 'purchase'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
      }
      try {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        if (!(await res.json()).ok) failures++
      } catch { failures++ }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The purchase was still saved.`)
    setExpenseReports(null)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  const originBadge = (i: ItemRow) => (
    <span className={`px-3 py-1 rounded-full text-sm font-bold ${i.source_type === 'DONATED' ? 'bg-orange-900 text-orange-300' : 'bg-gray-700 text-gray-300'}`}>
      {i.source_type === 'DONATED' ? 'DONATED' : 'PURCHASED'}
    </span>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmItemId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Item</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmItemId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeItem(confirmItemId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {confirmPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Purchase</h2>
            <p className="text-gray-400 text-lg mb-8">This removes ALL {confirmPurchase.items.length} item(s) of this purchase. This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmPurchase(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePurchase(confirmPurchase)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {editPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">EDIT PURCHASE</h2>
              <button onClick={() => setEditPurchase(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400 font-bold">SUPPLIER</label>
              <input type="text" value={editSupplier} onChange={(e) => setEditSupplier(e.target.value)} className={inputClass} />
            </div>
            <DatePicker label="DATE" value={editDate} onChange={setEditDate} />
            <button onClick={confirmEdit} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">SAVE</button>
          </div>
        </div>
      )}

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

      {scanned && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW PURCHASE</h2>
              <button onClick={() => setScanned(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block mb-1 text-sm text-gray-400 font-bold">SUPPLIER</label>
                <input type="text" value={scanned.supplier} onChange={(e) => setScanned({ ...scanned, supplier: e.target.value })} className={inputClass} />
              </div>
              <div className="flex-1">
                <DatePicker label="DATE" value={scanned.date} onChange={(v) => setScanned({ ...scanned, date: v })} />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-2">
              {scanned.items.map((item, i) => (
                <div key={i} className="flex gap-3 items-center">
                  <input type="text" value={item.description} onChange={(e) => { const items = [...scanned.items]; items[i] = { ...items[i], description: e.target.value }; setScanned({ ...scanned, items }) }} className={`${inputClass} flex-1`} placeholder="Description" />
                  <div className="w-20">
                    <input type="text" inputMode="decimal" value={item.quantity} onChange={(e) => { const items = [...scanned.items]; items[i] = { ...items[i], quantity: e.target.value }; setScanned({ ...scanned, items }) }} className={`${smallInputClass} w-full text-center`} placeholder="Qty" />
                  </div>
                  <div className="relative w-32">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input type="text" value={item.amount} onChange={(e) => { const items = [...scanned.items]; items[i] = { ...items[i], amount: e.target.value }; setScanned({ ...scanned, items }) }} className={`${inputClass} pl-8`} placeholder="0.00" />
                  </div>
                  <button onClick={() => setScanned({ ...scanned, items: scanned.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2">✕</button>
                </div>
              ))}
              <button onClick={() => setScanned({ ...scanned, items: [...scanned.items, { description: '', amount: '', quantity: '1' }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scanned.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0))}
              </div>
              <button onClick={confirmScanned} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {expenseReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            <p className="text-gray-400 text-base">Choose whether to report this purchase to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const expTotal = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — STOCK — {formatUSD(expTotal)}</p>
                      <p className="text-sm text-gray-400 truncate">{exp.supplier || 'Purchase'} — {exp.items.length} item{exp.items.length === 1 ? '' : 's'}</p>
                      <p className="text-sm text-gray-400">{isValidDate(exp.date) ? fmtDate(exp.date) : 'No date'}</p>
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
              <button onClick={sendReports} disabled={sendingReports} className={`px-6 py-3 rounded-2xl font-bold text-lg ${sendingReports ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sendingReports ? 'SENDING...' : 'DONE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scanning && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">Scanning Receipt...</p>
            <p className="text-gray-400">Claude is reading your receipt</p>
          </div>
        </div>
      )}

      {/* TOP LINE: title + search + actions */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">INVENTORY ({visible.length + visibleSold.length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item, supplier or note…"
            className="w-64 sm:w-80 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <label className="bg-indigo-700 hover:bg-indigo-600 px-6 py-3 rounded-2xl text-lg font-bold cursor-pointer whitespace-nowrap">
            🧾 SCAN PURCHASE
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScan(e.target.files[0]) }} />
          </label>
          <Link href="/supplies/new?category=STOCK&src=inventory" className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">ADD MANUALLY</Link>
        </div>
      </div>

      {/* CHIPS LINE: origin/status filters + stock summary */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-4 py-2 rounded-full font-bold ${status === s ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {s}
          </button>
        ))}
        <span className="ml-2 text-lg font-bold text-gray-300">Stock value: {formatUSD(stockValue)}</span>
        {donatedValue > 0 && (
          <>
            <span className="text-gray-600">·</span>
            <span className="text-lg font-bold text-orange-300">Donated (MSRP): {formatUSD(donatedValue)}</span>
          </>
        )}
        <span className="text-gray-600">·</span>
        <span className="text-lg font-bold text-amber-300">Sold: {soldRows.length}</span>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : visible.length === 0 && visibleSold.length === 0 ? (
        <p className="text-2xl text-gray-400">{purchases.length === 0 && soldRows.length === 0 ? 'No inventory yet — scan a purchase to start.' : 'No matches.'}</p>
      ) : (
        <>
          {visible.length > 0 && (
            <div className="space-y-5">
              {visible.map((p) => {
                // Molde da supplies page (commonOf): pedidos distintos das linhas
                // PURCHASED do grupo — o chip sobe pro cabeçalho; o semáforo do
                // STREAM sobe junto quando o pedido é um só. DONATED fica fora:
                // o order_number dela é a invoice doadora, não um pedido.
                const pOrders = Array.from(new Set(p.items.filter(i => i.source_type !== 'DONATED').map(i => (i.order_number || '').trim()).filter(Boolean)))
                const pStream = pOrders.length === 1 ? streamFor(streams, pOrders[0]) : undefined
                return (
                  <div key={p.key} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                    {/* DOAÇÃO não tem cabeçalho de grupo (ordem 22/ago/2026): o carro e a
                        invoice já estão na linha "From …" de cada item — repetir é ruído. */}
                    {!p.donated && (
                    <div className="p-6 flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1 flex-wrap">
                          <h2 className="text-2xl font-bold">{p.supplier || 'Unknown Supplier'}</h2>
                          <span className="px-3 py-1 rounded-full text-sm font-bold bg-green-900 text-green-300">
                            {p.items.length} item{p.items.length === 1 ? '' : 's'}
                          </span>
                          {originBadge(p.items[0])}
                        </div>
                        <p className="text-lg text-gray-400">
                          {fmtDate(p.date)} — <span className="font-bold text-gray-300">{formatUSD(p.total)}</span>
                          {p.receipt && (
                            <>
                              {' · '}
                              <a href={p.receipt} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-400 hover:text-blue-300">📎 receipt</a>
                            </>
                          )}
                        </p>
                        {/* ORDER NUMBER sempre visível na compra + semáforo do STREAM
                            (join por order_number — tracking nunca se digita aqui). */}
                        {pOrders.length > 0 && (
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {pOrders.map(o => <OrderChip key={o} order={o} />)}
                            {pStream && <StreamChip st={pStream} />}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-3 flex-wrap shrink-0">
                        {p.groupId && <Link href={`/supplies/group/${p.groupId}?src=inventory`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>}
                        <button onClick={() => startEdit(p)} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>
                        <button onClick={() => setConfirmPurchase(p)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                      </div>
                    </div>
                    )}
                    <div className={p.donated ? '' : 'border-t border-gray-800'}>
                        {p.items.map((item, gi) => (
                          <div key={item.id} className={`flex items-center justify-between gap-6 px-6 py-4 ${gi < p.items.length - 1 ? 'border-b border-gray-800' : ''}`}>
                            <div className={`flex-1 min-w-0 ${p.donated ? '' : 'pl-5'}`}>
                              <h3 className="text-xl font-bold">{item.description}</h3>
                              {/* Doada não tem custo: o número é MSRP, e o custo se escreve por extenso.
                                  Tudo sai dos campos que já existem — unit_price, quantity e source_type. */}
                              {item.source_type === 'DONATED' ? (
                                <p className="text-lg text-gray-400">OUR COST: <span className="font-bold text-orange-300">DONATED</span> — MSRP: <span className="font-bold text-gray-300">{formatUSD(item.unit_price)}</span>{item.quantity > 1 ? <> × {item.quantity} = <span className="font-bold text-gray-300">{formatUSD(item.quantity * item.unit_price)}</span></> : null}</p>
                              ) : (
                                <p className="text-lg text-gray-400">Qty: {item.quantity} × {formatUSD(item.unit_price)} = {formatUSD(item.quantity * item.unit_price)}</p>
                              )}
                              {/* Origem numa linha só: invoice (`order_number`) + quem entregou (`supplier`). */}
                              {item.source_type === 'DONATED'
                                ? (item.order_number || item.supplier) && <p className="text-sm text-yellow-400 mt-1">📦 {[item.order_number ? `From ${item.order_number}` : '', item.supplier].filter(Boolean).join(' — ')}</p>
                                : item.notes && item.notes.split('\n').map((note, i) => (
                                    <p key={i} className="text-sm text-yellow-400 mt-1">📦 {note}</p>
                                  ))}
                              {/* Molde commonOf: o chip do pedido desce pra linha só
                                  quando o grupo tem pedidos DIVERGENTES. DONATED nunca
                                  ganha chip (o campo dela é origem, não pedido). */}
                              {item.source_type !== 'DONATED' && (item.order_number || '').trim() && pOrders.length > 1 && (
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                  <OrderChip order={(item.order_number || '').trim()} />
                                  {(() => { const st = streamFor(streams, item.order_number); return st ? <StreamChip st={st} /> : null })()}
                                </div>
                              )}
                            </div>
                            <div className="flex gap-3 shrink-0">
                              <Link href={`/inventory/sell/${item.id}`} className="bg-amber-600 hover:bg-amber-500 text-black px-4 py-2 rounded-2xl font-bold text-sm">💲 SELL</Link>
                              <Link href={`/supplies/${item.id}?src=inventory`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm">VIEW</Link>
                              <Link href={`/supplies/edit/${item.id}?src=inventory`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</Link>
                              <button onClick={() => setConfirmItemId(item.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {visibleSold.length > 0 && (
            <div className={visible.length > 0 ? 'mt-10' : ''}>
              <h2 className="text-2xl font-bold mb-4 text-amber-400">SOLD ({visibleSold.length})</h2>
              <div className="space-y-3">
                {visibleSold.map((item) => (
                  <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-center justify-between gap-4 flex-wrap opacity-90">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-xl font-bold truncate">{item.description}</h3>
                        <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-700 text-black">SOLD</span>
                      </div>
                      <p className="text-gray-400">{item.source_type === 'DONATED' ? <>OUR COST: <span className="font-bold text-orange-300">DONATED</span> — MSRP: {formatUSD(item.unit_price)}{item.quantity > 1 ? ` × ${item.quantity}` : ''}</> : <>Qty: {item.quantity} × {formatUSD(item.unit_price)}</>}{item.supplier ? ` · ${item.supplier}` : ''}</p>
                    </div>
                    <Link href={`/inventory/sell/${item.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold shrink-0">VIEW SALE</Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  )
}
