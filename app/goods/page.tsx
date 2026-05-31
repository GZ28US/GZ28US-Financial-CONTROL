'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

type Good = {
  id: string
  description: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
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

export default function GoodsPage() {
  const [goods, setGoods] = useState<GoodWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // SCAN PURCHASE state
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{
    supplier: string
    date: string
    items: { description: string; amount: string; quantity: string }[]
    receiptUrl: string
  } | null>(null)

  // WhatsApp + duplicate-warning state
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)

  useEffect(() => { loadGoods() }, [])

  async function loadGoods() {
    const { data, error } = await supabase.from('goods').select('*').order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }

    const goodsWithStats = await Promise.all((data || []).map(async (good) => {
      const { data: expenses } = await supabase.from('good_expenses').select('amount').eq('good_id', good.id)
      const expensesTotal = (expenses || []).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
      return { ...good, expensesTotal }
    }))

    setGoods(goodsWithStats)
    setLoading(false)
  }

  async function removeGood(id: string) {
    const { error } = await supabase.from('goods').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadGoods()
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

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const response = await fetch('/api/scan-receipt', {
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
        quantity: '1',
      }))
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)

      const openReview = () => setScannedPurchase({ supplier, date, items, receiptUrl })

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
    const { error } = await supabase.from('goods').insert(
      scannedPurchase.items.map(item => ({
        description: item.description,
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        purchase_date: isValidDate(scannedPurchase.date) ? scannedPurchase.date : null,
        supplier: scannedPurchase.supplier || null,
        receipt_url: JSON.stringify([scannedPurchase.receiptUrl]),
        purchase_group: groupId,
      }))
    )
    if (error) { alert(error.message); return }

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

    return lines.join('\n')
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
        const res = await fetch('/api/whatsapp', {
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
                const total = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                const titleText = `${exp.supplier || 'Purchase'} — ${exp.items.length} item${exp.items.length === 1 ? '' : 's'}`
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — GOOD — {formatUSD(total)}</p>
                      <p className="text-sm text-gray-400 truncate">{titleText}</p>
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
          {goods.map((good) => (
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
          ))}
        </div>
      )}
    </main>
  )
}
