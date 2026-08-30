'use client'

// SHOP INPUTS — consumables ledger, rebuilt 2026-07-30 to the app's current
// standards (was the shared InputsManager, one of the first pages ever built).
// Standards applied here:
//   * top line = title + SEARCH + action buttons; filter chips on the line below
//     with the money summary (THIS MONTH · MONTHLY AVG · ALL-TIME)
//   * purchases grouped by receipt (purchase_group), newest purchase first,
//     clickable 📎 receipt on every purchase
//   * scan flow kept: currency guard, duplicate warning, optional WhatsApp report
// /inventory still uses components/InputsManager — this page is INPUTS only.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'
import { OrderChip, DeliverChip, hasDeliverChip, type DeliverChipRow } from '@/components/DeliverChip'
import { pickedUpFromScan } from '@/lib/deliverStatus'

// DeliverChipRow: picked_up/tracking_number/carrier/eta/... são colunas DESTA tabela
// (inputs). Repare no que NÃO está mais na lista: deliver_status. Desde
// 30/ago/2026 o status não é campo, é interpretação — a tela lê estas colunas e
// chama deriveDeliverStatus. O select('*') abaixo traz tudo, payment_date e
// source_type inclusive, que são o degrau 1 da cascata.
type InputRow = DeliverChipRow & {
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
  order_number: string | null
  payment_method: string | null
  paid_from: string | null
  payment_date: string | null
}

type Purchase = {
  key: string            // purchase_group, or the row id for ungrouped rows
  groupId: string | null // null = single row without a group
  supplier: string | null
  date: string | null
  items: InputRow[]
  total: number
  receipt: string | null
}

type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  items: { item: string; amount: string; quantity: string }[]
  report: boolean
}
type DuplicateInfo = { title: string; details: string; proceed: () => void }

const PERIODS = ['ALL', 'THIS MONTH', 'LAST 3 MONTHS', 'THIS YEAR'] as const
type Period = typeof PERIODS[number]

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}
// receipt_url is stored as a JSON-stringified array of URLs (or null).
function firstReceipt(raw: string | null): string | null {
  if (!raw) return null
  try { const a = JSON.parse(raw); return Array.isArray(a) && a[0] ? String(a[0]) : null } catch { return null }
}

// ── Smart info placement (Márcio, 19/ago) — reduzido a PAGAMENTO em 29/ago ───
// LEI (Márcio, 29/ago/2026): "os badges de order number, tracking ou
// BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das compras,
// MESMO QUE SEJA REPETIDO EM TODOS. Este controle e gerenciamento e pros itens,
// nao pra compra, uma vez que podem gerar order numbers e tracking diferentes."
// O commonOf morreu: ORDER NUMBER e semáforo do STREAM renderizam SEMPRE na
// linha de cada item, nunca no título — repetir o chip em todos os itens é o
// comportamento certo. Sobrou aqui só o PAGAMENTO (info da compra, fora da
// lei): igual em todos os itens sobe pro título; divergente desce pra linha.
// DISPLAY apenas — o banco segue com um campo por info, nada gravado em dobro.
function commonPayOf(p: Purchase) {
  const payKeys = new Set(p.items.filter(i => i.payment_method).map(i => `${i.payment_method}|${i.paid_from || ''}|${i.payment_date || ''}`))
  return payKeys.size === 1 ? (p.items.find(i => i.payment_method) || null) : null
}

function PayChip({ i }: { i: InputRow }) {
  // No date here: purchase date and payment date are ONE (lei 18/ago) and the
  // single date already shows on the purchase header.
  return (
    <span className="px-2.5 py-0.5 rounded-lg text-sm font-bold bg-gray-800 text-gray-300 border border-gray-700">
      💳 {i.payment_method}{i.paid_from && i.paid_from !== 'GZ28US' ? ` · by ${i.paid_from}` : ''}
    </span>
  )
}

// O semáforo mora no MOLDE (components/DeliverChip.tsx), e a REGRA dele em
// lib/deliverStatus.ts — um lugar só. Esta página já foi dona de uma cópia local
// da regra; era assim que uma tela dizia uma coisa e a outra dizia outra sobre o
// mesmo item. Agora ninguém mais calcula status em lugar nenhum. E o join com part_streams
// que nascia AQUI morreu na virada de chave: "esqueca o stream... NAO USE NADA
// DO STREAM, nada" (Márcio, 29/ago/2026).

export default function InputsPage() {
  const [rows, setRows] = useState<InputRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState<Period>('ALL')
  const [category, setCategory] = useState('ALL')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [confirmItemId, setConfirmItemId] = useState<string | null>(null)
  const [confirmPurchase, setConfirmPurchase] = useState<Purchase | null>(null)

  // Purchase-level edit: supplier + date applied to every item of the group.
  const [editPurchase, setEditPurchase] = useState<Purchase | null>(null)
  const [editSupplier, setEditSupplier] = useState('')
  const [editDate, setEditDate] = useState('')

  // Scan flow
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState<{
    supplier: string
    date: string
    // ORDER NUMBER é SAGRADO (29/ago/2026): o scan lê e a compra grava.
    orderNumber: string
    // O QUE O DOCUMENTO DIZ SOBRE A ENTREGA: endereço de entrega, rastreio e
    // transportadora lidos do papel. shipTo NÃO é coluna — ele decide o picked_up
    // ("se nao teve endereco, e PickUp"). Rastreio e carrier, esses são colunas.
    shipTo: string
    trackingNumber: string
    carrier: string
    items: { description: string; amount: string; quantity: string }[]
    receiptUrl: string
  } | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('inputs')
      .select('*')
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }
    const loaded = (data || []) as InputRow[]
    setRows(loaded)
    setLoading(false)
    setExpanded(new Set())
    // NÃO HÁ MAIS SEGUNDA CONSULTA. O status de entrega vinha daqui por join com
    // part_streams; agora ele veio junto no select('*') acima, na própria linha.
  }

  // Category chips are data-driven: whatever categories exist in the bank.
  const categories = useMemo(() => ['ALL', ...Array.from(new Set(rows.map(r => r.category || 'CONSUMPTION'))).sort()], [rows])
  const catRows = useMemo(() => category === 'ALL' ? rows : rows.filter(r => (r.category || 'CONSUMPTION') === category), [rows, category])

  // ── Purchases: one card per receipt (group), singles become 1-item purchases ──
  const purchases = useMemo<Purchase[]>(() => {
    const list: Purchase[] = []
    const seen = new Set<string>()
    for (const r of catRows) {
      const key = r.purchase_group || r.id
      if (seen.has(key)) continue
      seen.add(key)
      const items = r.purchase_group ? catRows.filter(x => x.purchase_group === r.purchase_group) : [r]
      list.push({
        key,
        groupId: r.purchase_group,
        supplier: items[0].supplier,
        date: items[0].purchase_date,
        items,
        total: items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0),
        receipt: items.map(i => firstReceipt(i.receipt_url)).find(Boolean) || null,
      })
    }
    return list
  }, [catRows])

  // ── Money summary (independent of search/period so the numbers are stable) ──
  const td = todayYmd()
  const thisMonthKey = td.slice(0, 7)
  const allTime = purchases.reduce((s, p) => s + p.total, 0)
  const thisMonth = purchases.filter(p => (p.date || '').startsWith(thisMonthKey)).reduce((s, p) => s + p.total, 0)
  // Monthly average = all-time spent ÷ distinct months that had a purchase
  // (APPS-page convention: the number that survives a year, not "last 30 days").
  const monthsWithSpend = new Set(purchases.map(p => (p.date || '').slice(0, 7)).filter(Boolean)).size
  const monthlyAvg = monthsWithSpend > 0 ? allTime / monthsWithSpend : 0

  // ── Period + search filters (display only) ──
  const periodStart = (() => {
    const d = new Date(td + 'T00:00:00')
    if (period === 'THIS MONTH') return thisMonthKey + '-01'
    if (period === 'LAST 3 MONTHS') { d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10) }
    if (period === 'THIS YEAR') return `${d.getFullYear()}-01-01`
    return null
  })()
  const term = search.trim().toLowerCase()
  const visible = purchases.filter(p => {
    const periodOk = !periodStart || ((p.date || '') >= periodStart)
    const searchOk = !term || p.items.some(i =>
      [i.description, i.supplier, i.notes, i.order_number].some(f => (f || '').toLowerCase().includes(term)))
    return periodOk && searchOk
  })
  const visibleTotal = visible.reduce((s, p) => s + p.total, 0)
  const visibleItems = visible.reduce((s, p) => s + p.items.length, 0)

  // ── Actions ──
  function toggle(key: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  async function removeItem(id: string) {
    const { error } = await supabase.from('inputs').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmItemId(null)
    load()
  }

  async function removePurchase(p: Purchase) {
    const { error } = p.groupId
      ? await supabase.from('inputs').delete().eq('purchase_group', p.groupId)
      : await supabase.from('inputs').delete().eq('id', p.items[0].id)
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
    // Corrigir a data da compra move as DUAS — senão o pagamento fica apontando
    // pra um dia que a compra já não tem mais.
    const patch = {
      supplier: editSupplier || null,
      purchase_date: isValidDate(editDate) ? editDate : null,
      payment_date: isValidDate(editDate) ? editDate : null,
    }
    const { error } = editPurchase.groupId
      ? await supabase.from('inputs').update(patch).eq('purchase_group', editPurchase.groupId)
      : await supabase.from('inputs').update(patch).eq('id', editPurchase.items[0].id)
    if (error) { alert(error.message); return }
    setEditPurchase(null)
    load()
  }

  // ── Scan flow (receipt photo/PDF → Claude reads → review → save) ──
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType }),
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
      // O nº do pedido vem do scan como impresso (zeros à esquerda, hífens, sem '#').
      const orderNumber = String(parsed.order_number || '').trim()
      const items = (parsed.items || []).map((i: any) => ({
        description: String(i.description || ''),
        amount: (((parseFloat(i.amount) || 0) * fx)).toFixed(2),
        quantity: String(i.quantity || '1'),
      }))
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
      const openReview = () => setScanned({ supplier, date, orderNumber, shipTo: String(parsed.ship_to || '').trim(), trackingNumber: String(parsed.tracking_number || '').trim(), carrier: String(parsed.carrier || '').trim(), items, receiptUrl })

      // Same supplier + date + total (per purchase) = probable re-scan.
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
    const { error } = await supabase.from('inputs').insert(
      scanned.items.map(item => ({
        description: item.description,
        category: 'CONSUMPTION',
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        // UMA DATA SÓ (lei 18/ago, reafirmada 26/ago): a data da compra É a do
        // pagamento — insumo se paga no ato, no caixa da loja. O scan gravava só
        // purchase_date e deixava payment_date vazio, e 28 compras ficaram
        // parecendo "a pagar" no app. As duas andam sempre juntas.
        purchase_date: isValidDate(scanned.date) ? scanned.date : null,
        payment_date: isValidDate(scanned.date) ? scanned.date : null,
        supplier: scanned.supplier || null,
        // ORDER NUMBER sagrado: o scan grava o pedido lido.
        order_number: scanned.orderNumber || null,
        // PICKED UP pelo DOCUMENTO (Márcio, 30/ago/2026): "Se teve endereco de
        // entrega no escaneamento da compra, e Bought; se nao teve, e PickUp." A
        // nota do mercado não traz endereço ⇒ picked_up. Loja online nunca é
        // picked_up, nem sem endereço — não tem balcão. Status nenhum é gravado:
        // BOUGHT/SHIPPED/DELIVERED saem do rastreio e da entrega, sozinhos.
        picked_up: pickedUpFromScan({ supplier: scanned.supplier, shipTo: scanned.shipTo }),
        tracking_number: scanned.trackingNumber || null,
        carrier: scanned.carrier || null,
        receipt_url: JSON.stringify([scanned.receiptUrl]),
        purchase_group: groupId,
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
      `*EXPENSE — CONSUMPTION*`,
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

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* CONFIRM DELETE ONE ITEM */}
      {confirmItemId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Input</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmItemId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeItem(confirmItemId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM DELETE WHOLE PURCHASE */}
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

      {/* EDIT PURCHASE */}
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

      {/* REVIEW SCANNED PURCHASE */}
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

      {/* REPORT ON WHATSAPP? */}
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
                      <p className="text-base font-bold">EXPENSE — CONSUMPTION — {formatUSD(expTotal)}</p>
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

      {/* SCANNING OVERLAY */}
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
        <h1 className="text-4xl font-bold">SUPPLIES ({visible.length})</h1>
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
          <Link href={`/supplies/new?category=${category === 'ALL' ? 'CONSUMPTION' : category}`} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">ADD MANUALLY</Link>
        </div>
      </div>

      {/* CHIPS LINE: category filters + period filters + money summary */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-4 py-2 rounded-full font-bold ${category === c ? 'bg-purple-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c === 'ALL' ? 'ALL CATEGORIES' : c}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-4 py-2 rounded-full font-bold ${period === p ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {p}
          </button>
        ))}
        <span className="ml-2 text-lg font-bold text-gray-300">This month: {formatUSD(thisMonth)}</span>
        <span className="text-gray-600">·</span>
        <span className="text-lg font-bold text-gray-300">Monthly avg: {formatUSD(monthlyAvg)}</span>
        <span className="text-gray-600">·</span>
        <span className="text-lg font-bold text-gray-300">All-time: {formatUSD(allTime)}</span>
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="text-2xl text-gray-400">{purchases.length === 0 ? 'No inputs yet — scan a receipt to start.' : 'No matches.'}</p>
      ) : (
        <>
          {(term || period !== 'ALL') && (
            <p className="text-lg text-gray-400 mb-4">
              Showing {visible.length} purchase{visible.length === 1 ? '' : 's'} · {visibleItems} item{visibleItems === 1 ? '' : 's'} · {formatUSD(visibleTotal)}
            </p>
          )}
          <div className="space-y-5">
            {visible.map((p) => {
              const isExpanded = expanded.has(p.key)
              const commonPay = commonPayOf(p)
              const single = p.items.length === 1
              return (
                <div key={p.key} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                  <div className="p-6 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 cursor-pointer group" onClick={() => toggle(p.key)}>
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                        <h2 className="text-2xl font-bold group-hover:text-blue-400 transition">{p.supplier || 'Unknown Supplier'}</h2>
                        <span className="px-3 py-1 rounded-full text-sm font-bold bg-blue-900 text-blue-300">
                          {p.items.length} item{p.items.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="text-lg text-gray-400 ml-7">
                        {fmtDate(p.date)} — <span className="font-bold text-gray-300">{formatUSD(p.total)}</span>
                        {/* LEI 29/ago/2026: o chip de ORDER NUMBER saiu do título da compra —
                            ele mora na linha de cada item, mesmo repetido em todos. */}
                        {p.receipt && (
                          <>
                            {' · '}
                            <a href={p.receipt} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-400 hover:text-blue-300">📎 receipt</a>
                          </>
                        )}
                      </p>
                      {/* Só o PAGAMENTO comum à compra inteira vive no título; ORDER
                          NUMBER e STREAM nunca mais sobem pra cá (lei 29/ago/2026). */}
                      {commonPay && (
                        <div className="flex items-center gap-2 mt-2 ml-7 flex-wrap">
                          <PayChip i={commonPay} />
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3 flex-wrap shrink-0">
                      {single
                        ? <Link href={`/supplies/${p.items[0].id}`} title="View purchase" className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                        : p.groupId && <Link href={`/supplies/group/${p.groupId}`} title="View purchase" className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>}
                      {single
                        ? <Link href={`/supplies/edit/${p.items[0].id}`} title="Edit purchase" className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                        : <button onClick={() => startEdit(p)} title="Edit purchase" className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>}
                      <button onClick={() => setConfirmPurchase(p)} title="Remove purchase" className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-800">
                      {p.items.map((item, gi) => {
                        // LEI 29/ago/2026: ORDER NUMBER e BADGE DE ENTREGA SEMPRE na linha
                        // do item (chip de order só se a linha TEM order_number). Os dois
                        // vêm da PRÓPRIA LINHA — e quem não foi pago, ou foi doado, não
                        // acende badge porque a DERIVAÇÃO corta no degrau 1, não porque
                        // alguém gravou NULL num campo (30/ago/2026).
                        // Pagamento segue o smart placement: na linha só quando diverge.
                        const paid = !!item.payment_date
                        const ownOrder = (item.order_number || '').trim()
                        const ownPay = item.payment_method && !commonPay
                        const rcpt = firstReceipt(item.receipt_url)
                        const ownRcpt = rcpt && (p.items.length > 1 || rcpt !== p.receipt)
                        return (
                        <div key={item.id} className={`flex items-center justify-between gap-6 px-6 py-4 ${gi < p.items.length - 1 ? 'border-b border-gray-800' : ''}`}>
                          <div className="flex-1 min-w-0 pl-5">
                            <h3 className="text-xl font-bold">{item.description}</h3>
                            <p className="text-lg text-gray-400">Qty: {item.quantity} × {formatUSD(item.unit_price)} = {formatUSD(item.quantity * item.unit_price)}</p>
                            {(ownOrder || ownPay || hasDeliverChip(item) || ownRcpt) && (
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                {ownOrder && <OrderChip order={ownOrder} />}
                                <DeliverChip row={item} />
                                {ownPay && <PayChip i={item} />}
                                {ownRcpt && (
                                  <a href={rcpt!} target="_blank" rel="noopener noreferrer" className="px-2.5 py-0.5 rounded-lg text-sm font-bold bg-gray-800 text-blue-400 border border-gray-700 hover:text-blue-300">📎 receipt</a>
                                )}
                              </div>
                            )}
                            {item.notes && item.notes.split('\n').map((note, i) => (
                              <p key={i} className="text-sm text-yellow-400 mt-1">📝 {note}</p>
                            ))}
                          </div>
                          <div className="flex gap-3 shrink-0">
                            <Link href={`/supplies/${item.id}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm">VIEW</Link>
                            <Link href={`/supplies/edit/${item.id}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</Link>
                            <button onClick={() => setConfirmItemId(item.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </main>
  )
}
