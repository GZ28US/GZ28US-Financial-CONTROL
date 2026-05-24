'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Part = { description: string; unit_price: string; quantity: string }
type Service = { description: string; price: string }
type Payment = { amount: string; payment_date: string; source: string }
type Note = { note: string }
type Expense = { supplier: string; item: string; amount: string; payment_date: string; receipt_urls: string[]; purchase_group?: string }
type StockItem = { id: string; description: string; quantity: number; unit_price: number; supplier: string | null; purchase_date: string | null }

const paymentSources = ['', 'CASH', 'ACH', 'ZELLE', 'CHECK']
const FULL_PROJECT_LABOR = 'Full Project Labor'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isTodayOrPast(dateStr: string) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
}
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

export default function NewInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const rideId = String(params.id)

  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [invoiceCode, setInvoiceCode] = useState('')
  const [hiringDate, setHiringDate] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [conclusionDate, setConclusionDate] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [mileage, setMileage] = useState('')
  const [service, setService] = useState('')
  const [floridaTaxes, setFloridaTaxes] = useState('')
  const [globalDiscount, setGlobalDiscount] = useState('')
  const [targetGrandTotal, setTargetGrandTotal] = useState('')
  const [parts, setParts] = useState<Part[]>([])
  const [newPart, setNewPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [editingPartIndex, setEditingPartIndex] = useState<number | null>(null)
  const [editingPart, setEditingPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [services, setServices] = useState<Service[]>([{ description: FULL_PROJECT_LABOR, price: '' }])
  const [newService, setNewService] = useState<Service>({ description: '', price: '' })
  const [editingServiceIndex, setEditingServiceIndex] = useState<number | null>(null)
  const [editingService, setEditingService] = useState<Service>({ description: '', price: '' })
  const [payments, setPayments] = useState<Payment[]>([])
  const [newPayment, setNewPayment] = useState<Payment>({ amount: '', payment_date: '', source: '' })
  const [editingPaymentIndex, setEditingPaymentIndex] = useState<number | null>(null)
  const [editingPayment, setEditingPayment] = useState<Payment>({ amount: '', payment_date: '', source: '' })
  const [notes, setNotes] = useState<Note[]>([])
  const [newNote, setNewNote] = useState('')
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ supplier: '', item: '', amount: '', payment_date: '', receipt_urls: [] })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ supplier: '', item: '', amount: '', payment_date: '', receipt_urls: [] })
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null)
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Stock modal
  const [showStockModal, setShowStockModal] = useState(false)
  const [stockItems, setStockItems] = useState<StockItem[]>([])
  const [stockQtyInput, setStockQtyInput] = useState<Record<string, string>>({})
  const [stockTarget, setStockTarget] = useState<'new' | number>('new')

  // Purchase scan
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{ supplier: string; date: string; items: { description: string; amount: string }[]; receiptUrl: string } | null>(null)

  useEffect(() => { loadRide() }, [])

  async function loadRide() {
    const { data: ride } = await supabase.from('rides').select('project_code, project_name').eq('id', rideId).single()
    if (ride) {
      setProjectCode(ride.project_code || '')
      setProjectName(ride.project_name || '')
      await loadNextInvoiceCode(ride.project_code)
    }
  }

  async function loadNextInvoiceCode(code: string) {
    const { data } = await supabase.from('invoices').select('invoice_code').eq('ride_id', rideId)
    const usedNumbers = data?.map((item) => {
      const match = item.invoice_code?.match(/\.(\d+)$/)
      return match ? Number(match[1]) : null
    }) || []
    let nextNumber = 1
    while (usedNumbers.includes(nextNumber)) nextNumber++
    setInvoiceCode(`${code}.${nextNumber}`)
  }

  async function openStockModal(target: 'new' | number) {
    setStockTarget(target)
    const { data } = await supabase
      .from('inputs')
      .select('id, description, quantity, unit_price, supplier, purchase_date')
      .eq('category', 'STOCK')
      .gt('quantity', 0)
      .order('description')
    setStockItems(data || [])
    setStockQtyInput({})
    setShowStockModal(true)
  }

  async function applyStockItem(item: StockItem) {
    const qty = parseFloat(stockQtyInput[item.id] || '1') || 1
    if (qty > item.quantity) { alert(`Only ${item.quantity} available`); return }
    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const amount = (item.unit_price * qty).toFixed(2)
    const expense: Expense = { supplier: 'STOCK', item: item.description, amount, payment_date: item.purchase_date || '', receipt_urls: [] }
    if (stockTarget === 'new') {
      setExpenses(prev => [...prev, expense])
    } else {
      const updated = [...expenses]; updated[stockTarget as number] = expense; setExpenses(updated)
    }
    const { data: inputData } = await supabase.from('inputs').select('notes').eq('id', item.id).single()
    const existingNote = inputData?.notes || ''
    const usageNote = `Used ${qty} in ${rideName}`
    const updatedNotes = existingNote ? `${existingNote}\n${usageNote}` : usageNote
    await supabase.from('inputs').update({ quantity: item.quantity - qty, notes: updatedNotes, updated_at: new Date().toISOString() }).eq('id', item.id)
    setShowStockModal(false)
  }

  async function handleAddPurchase(file: File) {
    setScanningPurchase(true)
    try {
      // Upload receipt
      const ext = file.name.split('.').pop()
      const path = `${rideId}/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      const receiptUrl = urlData.publicUrl

      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const isPDF = file.type === 'application/pdf'

      // Call Claude API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              ...(isPDF ? [{
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 }
              }] : [{
                type: 'image',
                source: { type: 'base64', media_type: file.type, data: base64 }
              }]),
              {
                type: 'text',
                text: `You are scanning a purchase receipt for an auto shop. Extract the following information and return ONLY valid JSON, no other text:
{
  "supplier": "store/supplier name",
  "date": "YYYY-MM-DD format, or empty string if not found",
  "items": [
    { "description": "item name", "amount": "price as number string like 12.99" }
  ]
}
Extract ALL line items from the receipt. For each item include the full description and its price. If you cannot determine a value, use an empty string. Do not include tax as a line item — skip it. Return only the JSON object.`
              }
            ]
          }]
        })
      })

      const data = await response.json()
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      setScannedPurchase({
        supplier: parsed.supplier || '',
        date: parsed.date || '',
        items: (parsed.items || []).map((i: any) => ({ description: String(i.description || ''), amount: String(i.amount || '0') })),
        receiptUrl,
      })
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again or add items manually.')
    }
    setScanningPurchase(false)
  }

  function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const groupId = generateUUID()
    const newItems: Expense[] = scannedPurchase.items.map(item => ({
      supplier: scannedPurchase.supplier,
      item: item.description,
      amount: item.amount,
      payment_date: scannedPurchase.date,
      receipt_urls: [scannedPurchase.receiptUrl],
      purchase_group: groupId,
    }))
    setExpenses(prev => [...prev, ...newItems])
    setExpandedGroups(prev => new Set([...prev, groupId]))
    setScannedPurchase(null)
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
  function formatMileage(value: string) {
    const clean = value.replace(/[^0-9.]/g, '')
    const partsArr = clean.split('.')
    const intPart = partsArr[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return partsArr.length > 1 ? `${intPart}.${partsArr[1]}` : intPart
  }
  function formatDate(d: string) {
    if (!isValidDate(d)) return '-'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  function getPartTotal(part: Part) { return (parseFloat(part.unit_price) || 0) * (parseFloat(part.quantity) || 0) }

  async function uploadReceipts(files: FileList, index: number) {
    setUploadingIndex(index)
    const urls: string[] = [...expenses[index].receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    const updated = [...expenses]; updated[index] = { ...updated[index], receipt_urls: urls }; setExpenses(updated)
    setUploadingIndex(null)
  }

  async function uploadReceiptsToEditing(files: FileList) {
    const urls: string[] = [...editingExpense.receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setEditingExpense({ ...editingExpense, receipt_urls: urls })
  }

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
  const totalPaid = payments.filter(p => isTodayOrPast(p.payment_date)).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0)
  const balance = totalPaid - grandTotal
  const expensesTotalGlobal = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0)
  const expensesTotalPaid = expenses.filter(e => isValidDate(e.payment_date)).reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0)
  const expensesBalance = expensesTotalPaid - expensesTotalGlobal
  const currentProfit = totalPaid - expensesTotalPaid
  const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = (val: number) => val < 0 ? 'text-red-500' : 'text-blue-400'

  function calculateLabor() {
    const target = parseFloat(targetGrandTotal.replace(/,/g, ''))
    if (!target || target <= 0) { alert('Please enter a valid Target Grand Total'); return }
    const discountFactor = 1 - (globalDiscountPct / 100)
    const labor = discountFactor > 0 ? (target / discountFactor) - partsTotal - otherServicesTotal : 0
    if (labor < 0) { alert('Target is lower than parts + other services already.'); return }
    const updated = [...services]
    if (laborIndex >= 0) updated[laborIndex] = { ...updated[laborIndex], price: labor.toFixed(2) }
    setServices(updated)
  }

  function addPart() {
    if (!newPart.description || !newPart.unit_price || !newPart.quantity) { alert('Please fill in all part fields'); return }
    setParts([...parts, newPart]); setNewPart({ description: '', unit_price: '', quantity: '1' })
  }
  function removePart(index: number) { setParts(parts.filter((_, i) => i !== index)) }
  function startEditPart(index: number) { setEditingPartIndex(index); setEditingPart({ ...parts[index] }) }
  function saveEditPart() {
    if (!editingPart.description || !editingPart.unit_price || !editingPart.quantity) { alert('Please fill in all part fields'); return }
    const updated = [...parts]; updated[editingPartIndex!] = editingPart; setParts(updated)
    setEditingPartIndex(null); setEditingPart({ description: '', unit_price: '', quantity: '1' })
  }
  function cancelEditPart() { setEditingPartIndex(null); setEditingPart({ description: '', unit_price: '', quantity: '1' }) }

  function addService() {
    if (!newService.description) { alert('Please enter a description'); return }
    setServices([...services, newService]); setNewService({ description: '', price: '' })
  }
  function removeService(index: number) { setServices(services.filter((_, i) => i !== index)) }
  function startEditService(index: number) { setEditingServiceIndex(index); setEditingService({ ...services[index] }) }
  function saveEditService() {
    if (!editingService.description) { alert('Please enter a description'); return }
    const updated = [...services]; updated[editingServiceIndex!] = editingService; setServices(updated)
    setEditingServiceIndex(null); setEditingService({ description: '', price: '' })
  }
  function cancelEditService() { setEditingServiceIndex(null); setEditingService({ description: '', price: '' }) }

  function addPayment() {
    if (!newPayment.amount) { alert('Please enter an amount'); return }
    setPayments([...payments, newPayment]); setNewPayment({ amount: '', payment_date: '', source: '' })
  }
  function removePayment(index: number) { setPayments(payments.filter((_, i) => i !== index)) }
  function startEditPayment(index: number) { setEditingPaymentIndex(index); setEditingPayment({ ...payments[index] }) }
  function saveEditPayment() {
    if (!editingPayment.amount) { alert('Please enter an amount'); return }
    const updated = [...payments]; updated[editingPaymentIndex!] = editingPayment; setPayments(updated)
    setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '' })
  }
  function cancelEditPayment() { setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '' }) }

  function addNote() {
    if (!newNote.trim()) { alert('Please enter a note'); return }
    setNotes([...notes, { note: newNote.trim() }]); setNewNote('')
  }
  function removeNote(index: number) { setNotes(notes.filter((_, i) => i !== index)) }
  function startEditNote(index: number) { setEditingNoteIndex(index); setEditingNote(notes[index].note) }
  function saveEditNote() {
    if (!editingNote.trim()) { alert('Please enter a note'); return }
    const updated = [...notes]; updated[editingNoteIndex!] = { note: editingNote.trim() }; setNotes(updated)
    setEditingNoteIndex(null); setEditingNote('')
  }
  function cancelEditNote() { setEditingNoteIndex(null); setEditingNote('') }

  function addExpense() {
    if (!newExpense.item || !newExpense.amount) { alert('Please enter at least item and amount'); return }
    setExpenses([...expenses, newExpense]); setNewExpense({ supplier: '', item: '', amount: '', payment_date: '', receipt_urls: [] })
  }
  function removeExpense(index: number) { setExpenses(expenses.filter((_, i) => i !== index)) }
  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }) }
  function saveEditExpense() {
    if (!editingExpense.item || !editingExpense.amount) { alert('Please enter at least item and amount'); return }
    const updated = [...expenses]; updated[editingExpenseIndex!] = editingExpense; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', payment_date: '', receipt_urls: [] })
  }
  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', payment_date: '', receipt_urls: [] }) }
  function removeReceiptFromEditing(urlIndex: number) {
    setEditingExpense({ ...editingExpense, receipt_urls: editingExpense.receipt_urls.filter((_, i) => i !== urlIndex) })
  }

  async function saveInvoice() {
    const { data: invoice, error } = await supabase.from('invoices').insert([{
      invoice_code: invoiceCode, ride_id: rideId,
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      conclusion_date: isValidDate(conclusionDate) ? conclusionDate : null,
      delivery_date: isValidDate(deliveryDate) ? deliveryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
    }]).select().single()
    if (error || !invoice) { alert(error?.message || 'Error saving invoice'); return }

    if (parts.length > 0) {
      const { error: e } = await supabase.from('invoice_parts').insert(parts.map(p => ({ invoice_id: invoice.id, description: p.description, unit_price: parseFloat(p.unit_price), quantity: parseFloat(p.quantity) })))
      if (e) { alert(e.message); return }
    }
    if (services.length > 0) {
      const { error: e } = await supabase.from('invoice_services').insert(services.map(s => ({ invoice_id: invoice.id, description: s.description, price: parseFloat(s.price) || 0 })))
      if (e) { alert(e.message); return }
    }
    if (payments.length > 0) {
      const { error: e } = await supabase.from('invoice_payments').insert(payments.map(p => ({ invoice_id: invoice.id, amount: parseFloat(p.amount), payment_date: isValidDate(p.payment_date) ? p.payment_date : null, source: p.source || null })))
      if (e) { alert(e.message); return }
    }
    if (notes.length > 0) {
      const { error: e } = await supabase.from('invoice_notes').insert(notes.map(n => ({ invoice_id: invoice.id, note: n.note })))
      if (e) { alert(e.message); return }
    }
    if (expenses.length > 0) {
      const { error: e } = await supabase.from('invoice_expenses').insert(expenses.map(ex => ({
        invoice_id: invoice.id, expense_date: null,
        supplier: ex.supplier || null, item: ex.item,
        price: parseFloat(ex.amount) || 0,
        payment_date: isValidDate(ex.payment_date) ? ex.payment_date : null,
        receipt_url: ex.receipt_urls.length > 0 ? JSON.stringify(ex.receipt_urls) : null,
        purchase_group: ex.purchase_group || null,
      })))
      if (e) { alert(e.message); return }
    }
    router.push(`/rides/${rideId}/invoices`)
  }

  // Group expenses for display
  const expenseRows: { type: 'single' | 'group'; index?: number; groupId?: string; groupExpenses?: { index: number; expense: Expense }[]; expense?: Expense }[] = []
  const seenGroups = new Set<string>()
  expenses.forEach((exp, index) => {
    if (exp.purchase_group) {
      if (!seenGroups.has(exp.purchase_group)) {
        seenGroups.add(exp.purchase_group)
        const groupExpenses = expenses.map((e, i) => ({ index: i, expense: e })).filter(({ expense: e }) => e.purchase_group === exp.purchase_group)
        expenseRows.push({ type: 'group', groupId: exp.purchase_group, groupExpenses })
      }
    } else {
      expenseRows.push({ type: 'single', index, expense: exp })
    }
  })

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'
  const selectClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* STOCK MODAL */}
      {showStockModal && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold">FROM STOCK</h2>
              <button onClick={() => setShowStockModal(false)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            {stockItems.length === 0 ? (
              <p className="text-gray-400 text-lg">No stock items available.</p>
            ) : (
              <div className="overflow-y-auto space-y-3 flex-1">
                {stockItems.map(item => (
                  <div key={item.id} className="bg-gray-800 border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold truncate">{item.description}</p>
                      {item.supplier && <p className="text-sm text-gray-400">{item.supplier}</p>}
                      <p className="text-sm text-gray-400">Available: {item.quantity} — {formatUSD(item.unit_price)} each</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input type="text" inputMode="decimal" placeholder="Qty" value={stockQtyInput[item.id] || ''} onChange={(e) => setStockQtyInput(prev => ({ ...prev, [item.id]: e.target.value }))} className="bg-gray-700 border border-gray-600 rounded-xl px-3 py-2 text-base w-20 text-center" />
                      <button onClick={() => applyStockItem(item)} className="bg-green-700 hover:bg-green-600 px-4 py-2 rounded-xl font-bold text-sm">USE</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SCANNED PURCHASE REVIEW MODAL */}
      {scannedPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg max-h-[85vh] flex flex-col gap-4">
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
                <label className="block mb-1 text-sm text-gray-400">DATE</label>
                <input type="text" value={scannedPurchase.date} onChange={(e) => setScannedPurchase({ ...scannedPurchase, date: e.target.value })} className={inputClass} placeholder="YYYY-MM-DD" />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-2">
              {scannedPurchase.items.map((item, i) => (
                <div key={i} className="flex gap-3 items-center">
                  <input type="text" value={item.description} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], description: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} flex-1`} placeholder="Description" />
                  <div className="relative w-32">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input type="text" value={item.amount} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], amount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} pl-8`} placeholder="0.00" />
                  </div>
                  <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: scannedPurchase.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2">✕</button>
                </div>
              ))}
              <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: [...scannedPurchase.items, { description: '', amount: '' }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0))}
              </div>
              <button onClick={confirmScannedPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
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

      <h1 className="text-4xl font-bold mb-2">ADD A NEW INVOICE</h1>
      <p className="text-gray-400 text-xl mb-8">{projectCode}{projectName ? ` — ${projectName}` : ''}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">INVOICE CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        <DatePicker label="HIRING DATE" value={hiringDate} onChange={setHiringDate} />
        <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />

        <div>
          <label className="block mb-2 text-lg font-bold">MILEAGE</label>
          <input type="text" value={mileage} onChange={(e) => setMileage(formatMileage(e.target.value))} className={inputClass} placeholder="0" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SERVICE</label>
          <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={inputClass} placeholder="Service description" />
        </div>

        {/* PARTS */}
        <div>
          <label className="block mb-3 text-lg font-bold">PARTS</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <input type="text" placeholder="Description" value={newPart.description} onChange={(e) => setNewPart({ ...newPart, description: e.target.value })} className={inputClass} />
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">UNIT PRICE</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newPart.unit_price} onChange={(e) => { if (isNumeric(e.target.value)) setNewPart({ ...newPart, unit_price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">QUANTITY</label>
                <input type="text" inputMode="decimal" placeholder="1" value={newPart.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewPart({ ...newPart, quantity: e.target.value }) }} className={`${smallInputClass} w-full`} />
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">TOTAL</label>
                <div className={`${smallInputClass} w-full opacity-50`}>{newPart.unit_price && newPart.quantity ? formatUSD(parseFloat(newPart.unit_price || '0') * parseFloat(newPart.quantity || '0')) : '$0.00'}</div>
              </div>
            </div>
            <button onClick={addPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD PART</button>
            {parts.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {parts.map((part, index) => (
                  <div key={index}>
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
                          <button onClick={cancelEditPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < parts.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold truncate">{part.description}</p>
                          <p className="text-sm text-gray-400">{formatUSD(parseFloat(part.unit_price))} × {part.quantity} = {formatUSD(getPartTotal(part))}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => startEditPart(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                          <button onClick={() => removePart(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="text-gray-400 font-bold">PARTS SUB-TOTAL</span>
              <span className="text-xl font-bold">{formatUSD(partsSubTotal)}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-gray-400 font-bold whitespace-nowrap">FLORIDA PARTS TAXES</span>
              <div className="relative w-28">
                <input type="text" inputMode="decimal" value={floridaTaxes} onChange={(e) => { if (isNumeric(e.target.value)) setFloridaTaxes(e.target.value) }} className={`${smallInputClass} w-full pr-6`} placeholder="0.00" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
              </div>
              <span className="text-xl font-bold ml-auto">{formatUSD(floridaTaxesAmount)}</span>
            </div>
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="font-bold text-lg">PARTS TOTAL</span>
              <span className="text-2xl font-bold">{formatUSD(partsTotal)}</span>
            </div>
          </div>
        </div>

        {/* SERVICES */}
        <div>
          <label className="block mb-3 text-lg font-bold">SERVICES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <input type="text" placeholder="Description" value={newService.description} onChange={(e) => setNewService({ ...newService, description: e.target.value })} className={inputClass} />
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newService.price} onChange={(e) => { if (isNumeric(e.target.value)) setNewService({ ...newService, price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
            </div>
            <div className="flex items-end gap-3">
              <button onClick={addService} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg shrink-0">+ ADD SERVICE</button>
              <div className="flex-1">
                <label className="block mb-1 text-sm text-gray-400">TARGET GRAND TOTAL</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={targetGrandTotal} onChange={(e) => { if (isNumeric(e.target.value)) setTargetGrandTotal(e.target.value) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
            </div>
            {services.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {services.map((svc, index) => (
                  <div key={index}>
                    {editingServiceIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <input type="text" value={editingService.description} onChange={(e) => setEditingService({ ...editingService, description: e.target.value })} className={inputClass} />
                        <div className="flex gap-3">
                          <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                            <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                              <input type="text" inputMode="decimal" value={editingService.price} onChange={(e) => { if (isNumeric(e.target.value)) setEditingService({ ...editingService, price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <button onClick={saveEditService} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={cancelEditService} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < services.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold truncate">{svc.description}</p>
                          <p className="text-sm text-gray-400">{!svc.price || parseFloat(svc.price) === 0 ? 'COURTESY' : formatUSD(parseFloat(svc.price))}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          {svc.description === FULL_PROJECT_LABOR && <button onClick={calculateLabor} className="bg-yellow-700 hover:bg-yellow-600 px-3 py-1 rounded-xl font-bold text-sm">CALCULATE</button>}
                          <button onClick={() => startEditService(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                          <button onClick={() => removeService(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                        </div>
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

        {/* TOTALS */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">PARTS + SERVICES TOTAL</span>
            <span className="text-xl font-bold">{formatUSD(partsAndServicesTotal)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-gray-400 font-bold whitespace-nowrap">GLOBAL DISCOUNT</span>
            <div className="relative w-28">
              <input type="text" inputMode="decimal" value={globalDiscount} onChange={(e) => { if (isNumeric(e.target.value)) setGlobalDiscount(e.target.value) }} className={`${smallInputClass} w-full pr-6`} placeholder="0.00" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
            </div>
            <span className="text-xl font-bold ml-auto text-red-400">- {formatUSD(globalDiscountAmount)}</span>
          </div>
          <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
            <span className="font-bold text-xl">GRAND TOTAL</span>
            <span className="text-3xl font-bold">{formatUSD(grandTotal)}</span>
          </div>
        </div>

        {/* PAYMENTS */}
        <div>
          <label className="block mb-3 text-lg font-bold">PAYMENTS</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newPayment.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewPayment({ ...newPayment, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">SOURCE</label>
                <select value={newPayment.source} onChange={(e) => setNewPayment({ ...newPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                  {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <DatePicker label="DATE" value={newPayment.payment_date} onChange={(v) => setNewPayment({ ...newPayment, payment_date: v })} />
            <button onClick={addPayment} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD PAYMENT</button>
            {payments.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {payments.map((payment, index) => {
                  const isPaid = isTodayOrPast(payment.payment_date)
                  return (
                    <div key={index}>
                      {editingPaymentIndex === index ? (
                        <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                          <div className="flex gap-3">
                            <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                              <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                <input type="text" inputMode="decimal" value={editingPayment.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingPayment({ ...editingPayment, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                              </div>
                            </div>
                            <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">SOURCE</label>
                              <select value={editingPayment.source} onChange={(e) => setEditingPayment({ ...editingPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                                {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                          </div>
                          <DatePicker label="DATE" value={editingPayment.payment_date} onChange={(v) => setEditingPayment({ ...editingPayment, payment_date: v })} />
                          <div className="flex gap-3">
                            <button onClick={saveEditPayment} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                            <button onClick={cancelEditPayment} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                          </div>
                        </div>
                      ) : (
                        <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < payments.length - 1 ? 'border-b border-gray-700' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <p className={`text-base font-bold ${isPaid ? '' : 'text-yellow-400'}`}>{formatUSD(parseFloat(payment.amount))}{!isPaid ? ' — PENDING' : ''}</p>
                            <p className="text-sm text-gray-400">{payment.source}{payment.payment_date ? ` — ${formatDate(payment.payment_date)}` : ''}</p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => startEditPayment(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removePayment(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="text-gray-400 font-bold">TOTAL PAID</span>
              <span className="text-xl font-bold">{formatUSD(totalPaid)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="font-bold text-lg">BALANCE</span>
              <span className={`text-2xl font-bold ${balance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(balance)}</span>
            </div>
          </div>
        </div>

        {/* NOTES */}
        <div>
          <label className="block mb-3 text-lg font-bold">NOTES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <textarea placeholder="Enter a note..." value={newNote} onChange={(e) => setNewNote(e.target.value)} rows={3} className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg resize-none" />
            <button onClick={addNote} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD NOTE</button>
            {notes.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {notes.map((n, index) => (
                  <div key={index}>
                    {editingNoteIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <textarea value={editingNote} onChange={(e) => setEditingNote(e.target.value)} rows={3} className="w-full bg-gray-900 border border-gray-600 rounded-2xl px-4 py-3 text-lg resize-none" />
                        <div className="flex gap-3">
                          <button onClick={saveEditNote} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={cancelEditNote} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-start justify-between gap-4 px-4 py-3 ${index < notes.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <p className="flex-1 text-base text-gray-300 whitespace-pre-wrap">{n.note}</p>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => startEditNote(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                          <button onClick={() => removeNote(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DatePicker label="CONCLUSION DATE" value={conclusionDate} onChange={setConclusionDate} />
        <DatePicker label="DELIVERY DATE" value={deliveryDate} onChange={setDeliveryDate} />

        {/* EXPENSES */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">

            {/* ADD PURCHASE button */}
            <label className="flex items-center justify-center gap-2 w-full bg-indigo-700 hover:bg-indigo-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
              🧾 ADD PURCHASE
              <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleAddPurchase(e.target.files[0]) }} />
            </label>

            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                <input type="text" placeholder="Supplier (optional)" value={newExpense.supplier} onChange={(e) => setNewExpense({ ...newExpense, supplier: e.target.value })} className={inputClass} />
              </div>
              <button onClick={() => openStockModal('new')} className="bg-green-800 hover:bg-green-700 px-4 py-4 rounded-2xl font-bold text-sm shrink-0 whitespace-nowrap">📦 FROM STOCK</button>
            </div>
            <div><label className="block mb-1 text-sm text-gray-400">ITEM</label>
              <input type="text" placeholder="Item description" value={newExpense.item} onChange={(e) => setNewExpense({ ...newExpense, item: e.target.value })} className={inputClass} />
            </div>
            <div><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
              <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
              </div>
            </div>
            <DatePicker label="PAYMENT DATE" value={newExpense.payment_date} onChange={(v) => setNewExpense({ ...newExpense, payment_date: v })} />
            <button onClick={addExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>

            {expenseRows.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-visible mt-2">
                {expenseRows.map((row, rowIdx) => {
                  if (row.type === 'group' && row.groupExpenses && row.groupId) {
                    const groupId = row.groupId
                    const groupItems = row.groupExpenses
                    const firstItem = groupItems[0].expense
                    const groupTotal = groupItems.reduce((s, { expense: e }) => s + (parseFloat(e.amount) || 0), 0)
                    const isExpanded = expandedGroups.has(groupId)
                    const receiptUrl = firstItem.receipt_urls[0]
                    return (
                      <div key={groupId} className={rowIdx < expenseRows.length - 1 ? 'border-b border-gray-700' : ''}>
                        {/* Group header */}
                        <div className="px-4 py-3 bg-gray-800 flex items-center justify-between gap-4 cursor-pointer" onClick={() => toggleGroup(groupId)}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                              <p className="text-base font-bold text-blue-400">{firstItem.supplier} — {groupItems.length} items</p>
                            </div>
                            <p className="text-sm text-gray-400 ml-6">{formatDate(firstItem.payment_date)} — {formatUSD(groupTotal)}</p>
                          </div>
                          <div className="flex gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                            {receiptUrl && (
                              <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">RECEIPT</a>
                            )}
                            <button onClick={() => { groupItems.forEach(({ index }) => removeExpense(index)) }} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE ALL</button>
                          </div>
                        </div>
                        {/* Group items */}
                        {isExpanded && (
                          <div className="border-t border-gray-700">
                            {groupItems.map(({ index, expense: exp }, gi) => (
                              <div key={index} className={`flex items-center justify-between gap-4 px-4 py-2 pl-10 ${gi < groupItems.length - 1 ? 'border-b border-gray-700' : ''}`}>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-bold truncate text-blue-300">{exp.item}</p>
                                  <p className="text-sm text-blue-300">{formatUSD(parseFloat(exp.amount))}</p>
                                </div>
                                <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm shrink-0">REMOVE</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  } else if (row.type === 'single' && row.index !== undefined && row.expense) {
                    const index = row.index
                    const exp = row.expense
                    const isPaid = isValidDate(exp.payment_date)
                    const rowColor = isPaid ? 'text-blue-400' : 'text-red-400'
                    return (
                      <div key={index} className={rowIdx < expenseRows.length - 1 ? 'border-b border-gray-700' : ''}>
                        {editingExpenseIndex === index ? (
                          <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                            <div className="flex gap-3 items-end">
                              <div className="flex-1">
                                <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                                <input type="text" value={editingExpense.supplier} onChange={(e) => setEditingExpense({ ...editingExpense, supplier: e.target.value })} className={inputClass} />
                              </div>
                              <button onClick={() => openStockModal(index)} className="bg-green-800 hover:bg-green-700 px-4 py-4 rounded-2xl font-bold text-sm shrink-0 whitespace-nowrap">📦 FROM STOCK</button>
                            </div>
                            <div><label className="block mb-1 text-sm text-gray-400">ITEM</label>
                              <input type="text" value={editingExpense.item} onChange={(e) => setEditingExpense({ ...editingExpense, item: e.target.value })} className={inputClass} />
                            </div>
                            <div><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                              <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                <input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
                              </div>
                            </div>
                            <DatePicker label="PAYMENT DATE" value={editingExpense.payment_date} onChange={(v) => setEditingExpense({ ...editingExpense, payment_date: v })} />
                            <div>
                              <label className="block mb-1 text-sm text-gray-400">RECEIPTS</label>
                              <label className="inline-flex items-center gap-2 bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer">
                                📎 ADD FILES
                                <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadReceiptsToEditing(e.target.files) }} />
                              </label>
                              {editingExpense.receipt_urls.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {editingExpense.receipt_urls.map((url, ui) => (
                                    <div key={ui} className="flex items-center gap-2">
                                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate">File {ui + 1}</a>
                                      <button onClick={() => removeReceiptFromEditing(ui)} className="text-red-400 hover:text-red-300 text-xs font-bold px-2">✕</button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="flex gap-3">
                              <button onClick={saveEditExpense} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                              <button onClick={cancelEditExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                            </div>
                          </div>
                        ) : (
                          <div className="px-4 py-3">
                            <div className="flex items-center justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <p className={`text-base font-bold truncate ${rowColor}`}>{exp.item}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
                                <p className={`text-sm ${rowColor}`}>{formatUSD(parseFloat(exp.amount))}</p>
                                <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                              </div>
                              <div className="flex gap-2 shrink-0">
                                {exp.receipt_urls.length > 0 && (
                                  <div className="relative">
                                    <button onClick={() => setOpenReceiptsIndex(openReceiptsIndex === index ? null : index)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                                      RECEIPTS{exp.receipt_urls.length > 1 ? ` (${exp.receipt_urls.length})` : ''}
                                    </button>
                                    {openReceiptsIndex === index && (
                                      <div className="absolute right-0 top-8 bg-gray-800 border border-gray-600 rounded-xl p-2 z-10 min-w-40 space-y-1">
                                        {exp.receipt_urls.map((url, ui) => (
                                          <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                                <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  }
                  return null
                })}
              </div>
            )}

            <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
              <span className="text-gray-400 font-bold">TOTAL GLOBAL</span>
              <span className="text-xl font-bold">{formatUSD(expensesTotalGlobal)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400 font-bold">TOTAL PAID</span>
              <span className="text-xl font-bold">{formatUSD(expensesTotalPaid)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="font-bold text-lg">BALANCE</span>
              <span className={`text-2xl font-bold ${expensesBalance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(expensesBalance)}</span>
            </div>
            <div className="border-t border-gray-700 pt-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-400 font-bold">CURRENT PROFIT</span>
                <span className={`text-xl font-bold ${profitColor(currentProfit)}`}>{formatUSD(currentProfit)} / {currentProfitPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-bold text-lg">FINAL PROFIT</span>
                <span className={`text-2xl font-bold ${profitColor(finalProfit)}`}>{formatUSD(finalProfit)} / {finalProfitPct.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>

        <button onClick={saveInvoice} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE INVOICE</button>
        <a href={`/rides/${rideId}/invoices`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}