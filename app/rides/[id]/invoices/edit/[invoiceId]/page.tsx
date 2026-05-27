'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Part = { id?: string; description: string; unit_price: string; quantity: string }
type Service = { id?: string; description: string; price: string }
type Payment = { id?: string; amount: string; payment_date: string; source: string }
type Note = { id?: string; note: string }
type Expense = { id?: string; supplier: string; item: string; amount: string; quantity: string; payment_date: string; receipt_urls: string[]; purchase_group?: string }
type StockItem = { id: string; description: string; quantity: number; unit_price: number; supplier: string | null; purchase_date: string | null }
type PartsToStock = { description: string; quantity: string; unit_price: string; date: string }
type ScannedPayment = { amount: string; source: string; date: string }

const paymentSources = ['', 'CASH', 'ACH', 'ZELLE', 'CHECK']
const FULL_PROJECT_LABOR = 'Full Project Labor'
const SKIP_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge/i

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isTodayOrPast(dateStr: string) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
}
function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}
function todayStr() { return new Date().toISOString().slice(0, 10) }

function dateSortKey(d: string): number {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return Number.POSITIVE_INFINITY
  return new Date(d + 'T00:00:00').getTime()
}

function sortByDateAsc<T>(rows: T[], getDate: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ka = dateSortKey(getDate(a.row))
      const kb = dateSortKey(getDate(b.row))
      return ka === kb ? a.i - b.i : ka - kb
    })
    .map(({ row }) => row)
}

function sortExpensesByDate(rows: Expense[]): Expense[] {
  type Block = { key: number; order: number; items: Expense[] }
  const groups = new Map<string, Block>()
  const blocks: Block[] = []
  rows.forEach((exp, i) => {
    const k = dateSortKey(exp.payment_date)
    if (exp.purchase_group) {
      let g = groups.get(exp.purchase_group)
      if (!g) {
        g = { key: k, order: i, items: [] }
        groups.set(exp.purchase_group, g)
        blocks.push(g)
      } else if (k < g.key) {
        g.key = k
      }
      g.items.push(exp)
    } else {
      blocks.push({ key: k, order: i, items: [exp] })
    }
  })
  return blocks
    .sort((a, b) => (a.key === b.key ? a.order - b.order : a.key - b.key))
    .flatMap(b => b.items)
}

export default function EditInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const rideId = String(params.id)
  const invoiceId = String(params.invoiceId)

  const [loading, setLoading] = useState(true)
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [invoiceCode, setInvoiceCode] = useState('')
  const [hiringDate, setHiringDate] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [conclusionDate, setConclusionDate] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [mileage, setMileage] = useState('')
  const [service, setService] = useState('')
  const [feedStatus, setFeedStatus] = useState('INCOMPLETE')
  const [floridaTaxes, setFloridaTaxes] = useState('')
  const [globalDiscount, setGlobalDiscount] = useState('')
  const [targetGrandTotal, setTargetGrandTotal] = useState('')
  const [parts, setParts] = useState<Part[]>([])
  const [newPart, setNewPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [editingPartIndex, setEditingPartIndex] = useState<number | null>(null)
  const [editingPart, setEditingPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [services, setServices] = useState<Service[]>([])
  const [newService, setNewService] = useState<Service>({ description: '', price: '' })
  const [editingServiceIndex, setEditingServiceIndex] = useState<number | null>(null)
  const [editingService, setEditingService] = useState<Service>({ description: '', price: '' })
  const [payments, setPayments] = useState<Payment[]>([])
  const [newPayment, setNewPayment] = useState<Payment>({ amount: '', payment_date: '', source: '' })
  const [editingPaymentIndex, setEditingPaymentIndex] = useState<number | null>(null)
  const [editingPayment, setEditingPayment] = useState<Payment>({ amount: '', payment_date: '', source: '' })
  const [scanningPayment, setScanningPayment] = useState(false)
  const [scannedPayments, setScannedPayments] = useState<ScannedPayment[] | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [newNote, setNewNote] = useState('')
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ supplier: '', item: '', amount: '', quantity: '1', payment_date: '', receipt_urls: [] })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ supplier: '', item: '', amount: '', quantity: '1', payment_date: '', receipt_urls: [] })
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [showStockModal, setShowStockModal] = useState(false)
  const [stockItems, setStockItems] = useState<StockItem[]>([])
  const [stockQtyInput, setStockQtyInput] = useState<Record<string, string>>({})
  const [stockTarget, setStockTarget] = useState<'new' | number>('new')
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{ supplier: string; date: string; items: { description: string; amount: string; quantity: string }[]; receiptUrl: string } | null>(null)
  const [editingPurchaseGroupId, setEditingPurchaseGroupId] = useState<string | null>(null)
  const [editingPurchaseSupplier, setEditingPurchaseSupplier] = useState('')
  const [editingPurchaseDate, setEditingPurchaseDate] = useState('')
  const [editingGroupItemIndex, setEditingGroupItemIndex] = useState<number | null>(null)
  const [editingGroupItem, setEditingGroupItem] = useState<{ description: string; amount: string; quantity: string }>({ description: '', amount: '', quantity: '1' })
  const [sendToStockConfirm, setSendToStockConfirm] = useState<{ index: number; expense: Expense; qtyToSend: string } | null>(null)
  const [partsToStock, setPartsToStock] = useState<PartsToStock[]>([])
  const [newPartToStock, setNewPartToStock] = useState<PartsToStock>({ description: '', quantity: '1', unit_price: '', date: todayStr() })
  const [savedPartsToStock, setSavedPartsToStock] = useState<PartsToStock[]>([])
  const [flTaxExpenseDate, setFlTaxExpenseDate] = useState('')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const { data: rideData } = await supabase.from('rides').select('project_code, project_name').eq('id', rideId).single()
    const pCode = rideData?.project_code || ''
    const pName = rideData?.project_name || ''
    setProjectCode(pCode)
    setProjectName(pName)

    const { data, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).single()
    if (error || !data) { alert('Invoice not found'); router.push(`/rides/${rideId}/invoices`); return }
    setInvoiceCode(data.invoice_code || '')
    setHiringDate(data.hiring_date || '')
    setEntryDate(data.entry_date || '')
    setConclusionDate(data.conclusion_date || '')
    setDeliveryDate(data.delivery_date || '')
    setMileage(data.mileage ? Number(data.mileage).toLocaleString('en-US') : '')
    setService(data.service || '')
    setFeedStatus(data.feed_status === 'REAL_TIME' ? 'REAL_TIME' : 'INCOMPLETE')
    setFloridaTaxes(data.florida_taxes ? String(data.florida_taxes) : '')
    setGlobalDiscount(data.global_discount ? String(data.global_discount) : '')
    setFlTaxExpenseDate(data.fl_tax_expense_date || '')

    const { data: partsData } = await supabase.from('invoice_parts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (partsData) setParts(partsData.map(p => ({ id: p.id, description: p.description, unit_price: String(p.unit_price), quantity: String(p.quantity) })))

    const { data: servicesData } = await supabase.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (servicesData) setServices(servicesData.map(s => ({ id: s.id, description: s.description, price: String(s.price) })))

    const { data: paymentsData } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (paymentsData) setPayments(sortByDateAsc(paymentsData.map(p => ({ id: p.id, amount: String(p.amount), payment_date: p.payment_date || '', source: p.source || '' })), p => p.payment_date))

    const { data: notesData } = await supabase.from('invoice_notes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (notesData) setNotes(notesData.map(n => ({ id: n.id, note: n.note })))

    const { data: expensesData } = await supabase.from('invoice_expenses').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (expensesData) {
      setExpenses(sortExpensesByDate(expensesData.map(e => ({
        id: e.id,
        supplier: e.supplier || '',
        item: e.item,
        amount: String(e.price),
        quantity: String(e.quantity || 1),
        payment_date: e.payment_date || '',
        receipt_urls: parseReceiptUrls(e.receipt_url),
        purchase_group: e.purchase_group || undefined,
      }))))
      setExpandedGroups(new Set())
    }

    const iCode = data.invoice_code || ''
    const rName = pCode + (pName ? ` — ${pName}` : '')
    const prefix = `From ${iCode} — ${rName}`
    const { data: stockHistory } = await supabase.from('inputs').select('*').eq('supplier', rName).eq('category', 'STOCK').ilike('notes', `${prefix}%`)
    if (stockHistory) {
      const mapped = sortByDateAsc(stockHistory.map(s => ({
        description: s.description,
        quantity: String(s.quantity),
        unit_price: String(s.unit_price),
        date: s.purchase_date || '',
      })), p => p.date)
      setSavedPartsToStock(mapped)
      setPartsToStock(mapped)
    }

    setLoading(false)
  }

  async function openStockModal(target: 'new' | number) {
    setStockTarget(target)
    const { data } = await supabase.from('inputs').select('id, description, quantity, unit_price, supplier, purchase_date').eq('category', 'STOCK').gt('quantity', 0).order('description')
    setStockItems(data || [])
    setStockQtyInput({})
    setShowStockModal(true)
  }

  async function applyStockItem(item: StockItem) {
    const qty = parseFloat(stockQtyInput[item.id] || '1') || 1
    if (qty > item.quantity) { alert(`Only ${item.quantity} available`); return }
    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const amount = item.unit_price.toFixed(2)
    const expense: Expense = { supplier: 'STOCK', item: item.description, amount, quantity: String(qty), payment_date: item.purchase_date || '', receipt_urls: [] }
    if (stockTarget === 'new') {
      setExpenses(prev => [...prev, expense])
    } else {
      const updated = [...expenses]; updated[stockTarget as number] = { ...updated[stockTarget as number], ...expense }; setExpenses(updated)
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
      const ext = file.name.split('.').pop()
      const path = `${rideId}/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
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
      setScannedPurchase({
        supplier: parsed.supplier || '',
        date: parsed.date || '',
        items: (parsed.items || []).map((i: any) => ({ description: String(i.description || ''), amount: String(i.amount || '0'), quantity: String(i.quantity || '1') })),
        receiptUrl,
      })
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again or add items manually.')
    }
    setScanningPurchase(false)
  }

  async function handleScanPayment(file: File) {
    setScanningPayment(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const response = await fetch('/api/scan-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: file.type, mode: 'payment' }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPayment(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      const list: ScannedPayment[] = (parsed.payments || []).map((p: any) => ({
        amount: String(p.amount || ''),
        source: String(p.source || ''),
        date: String(p.date || ''),
      }))
      if (list.length === 0) list.push({ amount: '', source: '', date: '' })
      setScannedPayments(list)
    } catch (err) {
      console.error(err)
      alert('Failed to scan payment. Please try again or add it manually.')
    }
    setScanningPayment(false)
  }

  function confirmScannedPayments() {
    if (!scannedPayments) return
    const valid = scannedPayments.filter(p => p.amount !== '' && !isNaN(parseFloat(p.amount)))
    if (valid.length === 0) { setScannedPayments(null); return }
    const newRows: Payment[] = valid.map(p => ({ amount: p.amount, payment_date: p.date, source: p.source }))
    setPayments(prev => [...prev, ...newRows])
    setScannedPayments(null)
  }

  function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const groupId = generateUUID()
    const newItems: Expense[] = scannedPurchase.items.map(item => ({
      supplier: scannedPurchase.supplier,
      item: item.description,
      amount: item.amount,
      quantity: item.quantity || '1',
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

  async function removePurchaseGroup(groupItems: { index: number; expense: Expense }[]) {
    const indicesToRemove = new Set(groupItems.map(({ index }) => index))
    for (const { expense: exp } of groupItems) {
      if (exp.id) await supabase.from('invoice_expenses').delete().eq('id', exp.id)
    }
    setExpenses(prev => prev.filter((_, i) => !indicesToRemove.has(i)))
  }

  function startEditPurchase(groupId: string, groupItems: { expense: Expense }[]) {
    const first = groupItems[0].expense
    setEditingPurchaseGroupId(groupId)
    setEditingPurchaseSupplier(first.supplier)
    setEditingPurchaseDate(first.payment_date)
  }

  async function confirmEditPurchase() {
    setExpenses(prev => prev.map(e =>
      e.purchase_group === editingPurchaseGroupId
        ? { ...e, supplier: editingPurchaseSupplier, payment_date: editingPurchaseDate }
        : e
    ))
    const groupExpenses = expenses.filter(e => e.purchase_group === editingPurchaseGroupId)
    for (const exp of groupExpenses) {
      if (exp.id) {
        await supabase.from('invoice_expenses').update({
          supplier: editingPurchaseSupplier || null,
          payment_date: isValidDate(editingPurchaseDate) ? editingPurchaseDate : null,
        }).eq('id', exp.id)
      }
    }
    setEditingPurchaseGroupId(null)
  }

  function startEditGroupItem(expenseIndex: number, exp: Expense) {
    setEditingGroupItemIndex(expenseIndex)
    setEditingGroupItem({ description: exp.item, amount: exp.amount, quantity: exp.quantity || '1' })
  }

  async function saveEditGroupItem() {
    if (editingGroupItemIndex === null) return
    const exp = expenses[editingGroupItemIndex]
    if (exp.id) {
      await supabase.from('invoice_expenses').update({
        item: editingGroupItem.description,
        price: parseFloat(editingGroupItem.amount) || 0,
        quantity: parseFloat(editingGroupItem.quantity) || 1,
      }).eq('id', exp.id)
    }
    const updated = [...expenses]
    updated[editingGroupItemIndex] = { ...updated[editingGroupItemIndex], item: editingGroupItem.description, amount: editingGroupItem.amount, quantity: editingGroupItem.quantity }
    setExpenses(updated)
    setEditingGroupItemIndex(null)
  }

  async function confirmSendToStock(item: { index: number; expense: Expense; qtyToSend: string }) {
    const exp = item.expense
    const qtyToSend = parseFloat(item.qtyToSend) || 1
    const totalQty = parseFloat(exp.quantity) || 1
    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const note = `From ${invoiceCode} — ${rideName}`
    const receiptUrl = exp.receipt_urls.length > 0 ? JSON.stringify(exp.receipt_urls) : null
    await supabase.from('inputs').insert([{
      description: exp.item,
      category: 'STOCK',
      quantity: qtyToSend,
      unit_price: parseFloat(exp.amount) || 0,
      purchase_date: isValidDate(exp.payment_date) ? exp.payment_date : null,
      supplier: exp.supplier || null,
      notes: note,
      receipt_url: receiptUrl,
    }])
    const remainingQty = totalQty - qtyToSend
    if (remainingQty <= 0) {
      if (exp.id) await supabase.from('invoice_expenses').delete().eq('id', exp.id)
      setExpenses(prev => prev.filter((_, i) => i !== item.index))
    } else {
      if (exp.id) await supabase.from('invoice_expenses').update({ quantity: remainingQty }).eq('id', exp.id)
      const updated = [...expenses]
      updated[item.index] = { ...updated[item.index], quantity: String(remainingQty) }
      setExpenses(updated)
    }
    setSendToStockConfirm(null)
  }

  function importIntuitiveParts() {
    const sourceMap = new Map<string, { description: string; unit_price: string; quantity: number }>()
    expenses
      .filter(e => !SKIP_WORDS.test(e.item))
      .forEach(e => {
        const desc = (e.item || '').trim()
        if (!desc) return
        const price = parseFloat(e.amount) || 0
        const qty = parseFloat(e.quantity) || 1
        const key = `${desc.toLowerCase()}|${price.toFixed(2)}`
        const existing = sourceMap.get(key)
        if (existing) {
          existing.quantity += qty
        } else {
          sourceMap.set(key, { description: desc, unit_price: e.amount, quantity: qty })
        }
      })

    if (sourceMap.size === 0) { alert('No parts found in expenses to import.'); return }

    const existingQty = new Map<string, number>()
    parts.forEach(p => {
      const desc = (p.description || '').trim()
      const price = parseFloat(p.unit_price) || 0
      const key = `${desc.toLowerCase()}|${price.toFixed(2)}`
      existingQty.set(key, (existingQty.get(key) || 0) + (parseFloat(p.quantity) || 0))
    })

    const toAdd: Part[] = []
    sourceMap.forEach((src, key) => {
      const alreadyHave = existingQty.get(key) || 0
      const missing = src.quantity - alreadyHave
      if (missing > 0) {
        toAdd.push({
          description: src.description,
          unit_price: src.unit_price,
          quantity: String(missing),
        })
      }
    })

    if (toAdd.length === 0) { alert('All parts are already imported — nothing new to add.'); return }
    setParts(prev => [...prev, ...toAdd])
  }

  function addPartToStock() {
    if (!newPartToStock.description || !newPartToStock.unit_price || !newPartToStock.quantity) { alert('Please fill in all fields'); return }
    setPartsToStock(prev => [...prev, newPartToStock])
    setNewPartToStock({ description: '', quantity: '1', unit_price: '', date: todayStr() })
  }

  function removePartToStock(index: number) {
    setPartsToStock(prev => prev.filter((_, i) => i !== index))
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

  async function uploadReceiptsToEditing(files: FileList) {
    const urls: string[] = [...editingExpense.receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `${rideId}/${invoiceId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('expense-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setEditingExpense({ ...editingExpense, receipt_urls: urls })
  }

  function removeReceiptFromEditing(urlIndex: number) {
    setEditingExpense({ ...editingExpense, receipt_urls: editingExpense.receipt_urls.filter((_, i) => i !== urlIndex) })
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
  const flTaxExpenseAmount = floridaTaxesAmount
  const flTaxExpensePaid = isValidDate(flTaxExpenseDate)
  const expensesTotalGlobal = flTaxExpenseAmount + expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1), 0)
  const expensesTotalPaid = (flTaxExpensePaid ? flTaxExpenseAmount : 0) + expenses.filter(e => isValidDate(e.payment_date)).reduce((sum, e) => sum + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1), 0)
  const expensesBalance = expensesTotalPaid - expensesTotalGlobal
  const currentProfit = totalPaid - expensesTotalPaid
  const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = (val: number) => val < 0 ? 'text-red-500' : 'text-blue-400'

  async function calculateLabor() {
    const target = parseFloat(targetGrandTotal.replace(/,/g, ''))
    if (!target || target <= 0) { alert('Please enter a valid Target Grand Total'); return }
    const discountFactor = 1 - (globalDiscountPct / 100)
    const labor = discountFactor > 0 ? (target / discountFactor) - partsTotal - otherServicesTotal : 0
    if (labor < 0) { alert('Target is lower than parts + other services already.'); return }
    const updated = [...services]
    if (laborIndex >= 0) {
      updated[laborIndex] = { ...updated[laborIndex], price: labor.toFixed(2) }
      setServices(updated)
      const laborSvc = updated[laborIndex]
      if (laborSvc.id) await supabase.from('invoice_services').update({ price: labor }).eq('id', laborSvc.id)
    }
  }

  function addPart() {
    if (!newPart.description || !newPart.unit_price || !newPart.quantity) { alert('Please fill in all part fields'); return }
    setParts([...parts, newPart]); setNewPart({ description: '', unit_price: '', quantity: '1' })
  }
  async function removePart(index: number) {
    const part = parts[index]
    if (part.id) await supabase.from('invoice_parts').delete().eq('id', part.id)
    setParts(parts.filter((_, i) => i !== index))
  }
  function startEditPart(index: number) { setEditingPartIndex(index); setEditingPart({ ...parts[index] }) }
  async function saveEditPart() {
    if (!editingPart.description || !editingPart.unit_price || !editingPart.quantity) { alert('Please fill in all part fields'); return }
    const part = parts[editingPartIndex!]
    if (part.id) {
      const { error } = await supabase.from('invoice_parts').update({ description: editingPart.description, unit_price: parseFloat(editingPart.unit_price), quantity: parseFloat(editingPart.quantity) }).eq('id', part.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...parts]; updated[editingPartIndex!] = { ...editingPart, id: part.id }; setParts(updated)
    setEditingPartIndex(null); setEditingPart({ description: '', unit_price: '', quantity: '1' })
  }
  function cancelEditPart() { setEditingPartIndex(null); setEditingPart({ description: '', unit_price: '', quantity: '1' }) }

  function addService() {
    if (!newService.description) { alert('Please enter a description'); return }
    setServices([...services, newService]); setNewService({ description: '', price: '' })
  }
  async function removeService(index: number) {
    const svc = services[index]
    if (svc.id) await supabase.from('invoice_services').delete().eq('id', svc.id)
    setServices(services.filter((_, i) => i !== index))
  }
  function startEditService(index: number) { setEditingServiceIndex(index); setEditingService({ ...services[index] }) }
  async function saveEditService() {
    if (!editingService.description) { alert('Please enter a description'); return }
    const svc = services[editingServiceIndex!]
    if (svc.id) {
      const { error } = await supabase.from('invoice_services').update({ description: editingService.description, price: parseFloat(editingService.price) || 0 }).eq('id', svc.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...services]; updated[editingServiceIndex!] = { ...editingService, id: svc.id }; setServices(updated)
    setEditingServiceIndex(null); setEditingService({ description: '', price: '' })
  }
  function cancelEditService() { setEditingServiceIndex(null); setEditingService({ description: '', price: '' }) }

  function addPayment() {
    if (!newPayment.amount) { alert('Please enter an amount'); return }
    setPayments([...payments, newPayment]); setNewPayment({ amount: '', payment_date: '', source: '' })
  }
  async function removePayment(index: number) {
    const payment = payments[index]
    if (payment.id) await supabase.from('invoice_payments').delete().eq('id', payment.id)
    setPayments(payments.filter((_, i) => i !== index))
  }
  function startEditPayment(index: number) { setEditingPaymentIndex(index); setEditingPayment({ ...payments[index] }) }
  async function saveEditPayment() {
    if (!editingPayment.amount) { alert('Please enter an amount'); return }
    const payment = payments[editingPaymentIndex!]
    if (payment.id) {
      const { error } = await supabase.from('invoice_payments').update({ amount: parseFloat(editingPayment.amount), payment_date: isValidDate(editingPayment.payment_date) ? editingPayment.payment_date : null, source: editingPayment.source || null }).eq('id', payment.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...payments]; updated[editingPaymentIndex!] = { ...editingPayment, id: payment.id }; setPayments(updated)
    setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '' })
  }
  function cancelEditPayment() { setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '' }) }

  function addNote() {
    if (!newNote.trim()) { alert('Please enter a note'); return }
    setNotes([...notes, { note: newNote.trim() }]); setNewNote('')
  }
  async function removeNote(index: number) {
    const n = notes[index]
    if (n.id) await supabase.from('invoice_notes').delete().eq('id', n.id)
    setNotes(notes.filter((_, i) => i !== index))
  }
  function startEditNote(index: number) { setEditingNoteIndex(index); setEditingNote(notes[index].note) }
  async function saveEditNote() {
    if (!editingNote.trim()) { alert('Please enter a note'); return }
    const n = notes[editingNoteIndex!]
    if (n.id) {
      const { error } = await supabase.from('invoice_notes').update({ note: editingNote.trim() }).eq('id', n.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...notes]; updated[editingNoteIndex!] = { ...n, note: editingNote.trim() }; setNotes(updated)
    setEditingNoteIndex(null); setEditingNote('')
  }
  function cancelEditNote() { setEditingNoteIndex(null); setEditingNote('') }

  function addExpense() {
    if (!newExpense.item || !newExpense.amount) { alert('Please enter at least item and amount'); return }
    setExpenses([...expenses, newExpense]); setNewExpense({ supplier: '', item: '', amount: '', quantity: '1', payment_date: '', receipt_urls: [] })
  }
  async function removeExpense(index: number) {
    const exp = expenses[index]
    if (exp.id) await supabase.from('invoice_expenses').delete().eq('id', exp.id)
    setExpenses(expenses.filter((_, i) => i !== index))
  }
  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }); setOpenReceiptsIndex(null) }
  async function saveEditExpense() {
    if (!editingExpense.item || !editingExpense.amount) { alert('Please enter at least item and amount'); return }
    const exp = expenses[editingExpenseIndex!]
    if (exp.id) {
      const { error } = await supabase.from('invoice_expenses').update({
        expense_date: null, supplier: editingExpense.supplier || null,
        item: editingExpense.item, price: parseFloat(editingExpense.amount),
        quantity: parseFloat(editingExpense.quantity) || 1,
        payment_date: isValidDate(editingExpense.payment_date) ? editingExpense.payment_date : null,
        receipt_url: editingExpense.receipt_urls.length > 0 ? JSON.stringify(editingExpense.receipt_urls) : null,
      }).eq('id', exp.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...expenses]; updated[editingExpenseIndex!] = { ...editingExpense, id: exp.id }; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', quantity: '1', payment_date: '', receipt_urls: [] })
  }
  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', quantity: '1', payment_date: '', receipt_urls: [] }) }

  async function saveInvoice() {
    const { error } = await supabase.from('invoices').update({
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      conclusion_date: isValidDate(conclusionDate) ? conclusionDate : null,
      delivery_date: isValidDate(deliveryDate) ? deliveryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
      feed_status: feedStatus === 'REAL_TIME' ? 'REAL_TIME' : 'INCOMPLETE',
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
      fl_tax_expense_date: isValidDate(flTaxExpenseDate) ? flTaxExpenseDate : null,
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    if (error) { alert(error.message); return }

    const newParts = parts.filter(p => !p.id)
    if (newParts.length > 0) {
      const { error: e } = await supabase.from('invoice_parts').insert(newParts.map(p => ({ invoice_id: invoiceId, description: p.description, unit_price: parseFloat(p.unit_price), quantity: parseFloat(p.quantity) })))
      if (e) { alert(e.message); return }
    }
    const newServices = services.filter(s => !s.id)
    if (newServices.length > 0) {
      const { error: e } = await supabase.from('invoice_services').insert(newServices.map(s => ({ invoice_id: invoiceId, description: s.description, price: parseFloat(s.price) || 0 })))
      if (e) { alert(e.message); return }
    }
    const newPayments = payments.filter(p => !p.id)
    if (newPayments.length > 0) {
      const { error: e } = await supabase.from('invoice_payments').insert(newPayments.map(p => ({ invoice_id: invoiceId, amount: parseFloat(p.amount), payment_date: isValidDate(p.payment_date) ? p.payment_date : null, source: p.source || null })))
      if (e) { alert(e.message); return }
    }
    const newNotes = notes.filter(n => !n.id)
    if (newNotes.length > 0) {
      const { error: e } = await supabase.from('invoice_notes').insert(newNotes.map(n => ({ invoice_id: invoiceId, note: n.note })))
      if (e) { alert(e.message); return }
    }
    const newExpenses = expenses.filter(e => !e.id)
    if (newExpenses.length > 0) {
      const { error: e } = await supabase.from('invoice_expenses').insert(newExpenses.map(ex => ({
        invoice_id: invoiceId, expense_date: null,
        supplier: ex.supplier || null, item: ex.item,
        price: parseFloat(ex.amount),
        quantity: parseFloat(ex.quantity) || 1,
        payment_date: isValidDate(ex.payment_date) ? ex.payment_date : null,
        receipt_url: ex.receipt_urls.length > 0 ? JSON.stringify(ex.receipt_urls) : null,
        purchase_group: ex.purchase_group || null,
      })))
      if (e) { alert(e.message); return }
    }

    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const prefix = `From ${invoiceCode} — ${rideName}`
    await supabase.from('inputs').delete().eq('supplier', rideName).eq('category', 'STOCK').ilike('notes', `${prefix}%`)
    if (partsToStock.length > 0) {
      const { error: e } = await supabase.from('inputs').insert(partsToStock.map(p => ({
        description: p.description,
        category: 'STOCK',
        quantity: parseFloat(p.quantity) || 1,
        unit_price: parseFloat(p.unit_price) || 0,
        purchase_date: isValidDate(p.date) ? p.date : null,
        supplier: rideName,
        notes: `From ${invoiceCode} — ${rideName}`,
      })))
      if (e) { alert(e.message); return }
    }

    router.push(`/rides/${rideId}/invoices`)
  }

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

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

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

      {scannedPayments && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW PAYMENT</h2>
              <button onClick={() => setScannedPayments(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 space-y-3">
              {scannedPayments.map((p, i) => (
                <div key={i} className="border border-gray-700 rounded-2xl p-3 space-y-2">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                      <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input type="text" inputMode="decimal" value={p.amount} onChange={(e) => { if (isNumeric(e.target.value)) { const a = [...scannedPayments]; a[i] = { ...a[i], amount: e.target.value }; setScannedPayments(a) } }} className={`${smallInputClass} w-full pl-8`} placeholder="0.00" />
                      </div>
                    </div>
                    <div className="flex-1">
                      <label className="block mb-1 text-sm text-gray-400">SOURCE</label>
                      <select value={p.source} onChange={(e) => { const a = [...scannedPayments]; a[i] = { ...a[i], source: e.target.value }; setScannedPayments(a) }} className={`${selectClass} w-full`}>
                        {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <button onClick={() => setScannedPayments(scannedPayments.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300 font-bold text-lg px-2 self-end pb-3">✕</button>
                  </div>
                  <DatePicker label="DATE" value={p.date} onChange={(v) => { const a = [...scannedPayments]; a[i] = { ...a[i], date: v }; setScannedPayments(a) }} />
                </div>
              ))}
              <button onClick={() => setScannedPayments([...scannedPayments, { amount: '', source: '', date: '' }])} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD PAYMENT</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0))}
              </div>
              <button onClick={confirmScannedPayments} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {scannedPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
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

      {sendToStockConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">Send to Stock</h2>
            <p className="text-gray-400 text-lg mb-4"><span className="text-white font-bold">{sendToStockConfirm.expense.item}</span><br />Available qty: {sendToStockConfirm.expense.quantity}</p>
            <div className="mb-6">
              <label className="block mb-1 text-sm text-gray-400">QTY TO SEND TO STOCK</label>
              <input type="text" inputMode="decimal" value={sendToStockConfirm.qtyToSend} onChange={(e) => { if (isNumeric(e.target.value)) setSendToStockConfirm({ ...sendToStockConfirm, qtyToSend: e.target.value }) }} className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-5 py-4 text-xl text-center" />
            </div>
            <div className="flex gap-4">
              <button onClick={() => setSendToStockConfirm(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => confirmSendToStock(sendToStockConfirm)} className="flex-1 bg-green-700 hover:bg-green-600 px-5 py-4 rounded-2xl font-bold text-xl">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {(scanningPurchase || scanningPayment) && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">{scanningPayment ? 'Scanning Payment...' : 'Scanning Receipt...'}</p>
            <p className="text-gray-400">Claude is reading your {scanningPayment ? 'payment' : 'receipt'}</p>
          </div>
        </div>
      )}

      <h1 className="text-4xl font-bold mb-2">EDIT INVOICE</h1>
      <p className="text-gray-400 text-xl mb-8">{projectCode}{projectName ? ` — ${projectName}` : ''}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">INVOICE CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        {/* FEED STATUS SWITCH */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-bold">FEED STATUS</p>
            <p className="text-sm text-gray-400">Mark this invoice as a real-time feed once it is fully up to date.</p>
          </div>
          <button
            onClick={() => setFeedStatus(feedStatus === 'REAL_TIME' ? 'INCOMPLETE' : 'REAL_TIME')}
            className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap ${feedStatus === 'REAL_TIME' ? 'bg-green-700 hover:bg-green-600 text-white' : 'bg-red-700 hover:bg-red-600 text-white'}`}
          >
            {feedStatus === 'REAL_TIME' ? 'REAL-TIME FEED' : 'INCOMPLETE'}
          </button>
        </div>

        <DatePicker label="HIRING DATE" value={hiringDate} onChange={setHiringDate} />
        {isValidDate(hiringDate) && <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />}

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
            <div className="flex gap-3">
              <button onClick={addPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD PART</button>
              <button onClick={importIntuitiveParts} className="bg-purple-700 hover:bg-purple-600 px-5 py-3 rounded-2xl font-bold text-lg">⬆ IMPORT INTUITIVE PARTS</button>
            </div>
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
            <label className="flex items-center justify-center gap-2 w-full bg-indigo-700 hover:bg-indigo-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
              🧾 SCAN PAYMENT
              <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanPayment(e.target.files[0]) }} />
            </label>
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

        {isValidDate(entryDate) && <DatePicker label="CONCLUSION DATE" value={conclusionDate} onChange={setConclusionDate} />}
        {isValidDate(conclusionDate) && <DatePicker label="DELIVERY DATE" value={deliveryDate} onChange={setDeliveryDate} />}

        {/* PARTS TO STOCK */}
        <div>
          <label className="block mb-3 text-lg font-bold">PARTS TO STOCK</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <p className="text-sm text-gray-400">Parts removed from this car that go into our stock inventory.</p>
            <input type="text" placeholder="Description" value={newPartToStock.description} onChange={(e) => setNewPartToStock({ ...newPartToStock, description: e.target.value })} className={inputClass} />
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">UNIT PRICE</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newPartToStock.unit_price} onChange={(e) => { if (isNumeric(e.target.value)) setNewPartToStock({ ...newPartToStock, unit_price: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">QUANTITY</label>
                <input type="text" inputMode="decimal" placeholder="1" value={newPartToStock.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewPartToStock({ ...newPartToStock, quantity: e.target.value }) }} className={`${smallInputClass} w-full`} />
              </div>
            </div>
            <DatePicker label="DATE" value={newPartToStock.date} onChange={(v) => setNewPartToStock({ ...newPartToStock, date: v })} />
            <button onClick={addPartToStock} className="bg-orange-700 hover:bg-orange-600 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD TO STOCK</button>

            {partsToStock.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {partsToStock.map((p, index) => (
                  <div key={index} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < partsToStock.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold truncate text-orange-400">{p.description}</p>
                      <p className="text-sm text-orange-400">Qty: {p.quantity} × {formatUSD(parseFloat(p.unit_price) || 0)} — {formatDate(p.date)}</p>
                    </div>
                    <button onClick={() => removePartToStock(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm shrink-0">REMOVE</button>
                  </div>
                ))}
              </div>
            )}

            {savedPartsToStock.length > 0 && (
              <div className="border-t border-gray-700 pt-3">
                <p className="text-sm text-gray-500 mb-2">ALREADY IN STOCK FROM THIS INVOICE</p>
                <div className="border border-gray-700 rounded-2xl overflow-hidden">
                  {savedPartsToStock.map((p, index) => (
                    <div key={index} className={`flex items-center gap-4 px-4 py-3 ${index < savedPartsToStock.length - 1 ? 'border-b border-gray-700' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-bold truncate text-orange-300">{p.description}</p>
                        <p className="text-sm text-orange-300">Qty: {p.quantity} × {formatUSD(parseFloat(p.unit_price) || 0)} — {formatDate(p.date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* EXPENSES */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <label className="flex items-center justify-center gap-2 w-full bg-indigo-700 hover:bg-indigo-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
              🧾 SCAN EXPENSE
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
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
                </div>
              </div>
              <div className="w-28"><label className="block mb-1 text-sm text-gray-400">QTY</label>
                <input type="text" inputMode="decimal" placeholder="1" value={newExpense.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, quantity: e.target.value }) }} className={inputClass} />
              </div>
            </div>
            <DatePicker label="PAYMENT DATE" value={newExpense.payment_date} onChange={(v) => setNewExpense({ ...newExpense, payment_date: v })} />
            <button onClick={addExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>

            <div className="border border-gray-700 rounded-2xl overflow-visible mt-2 bg-gray-800">
              <div className="px-4 py-3 space-y-2">
                <div className="min-w-0">
                  <p className={`text-base font-bold truncate ${flTaxExpensePaid ? 'text-blue-400' : 'text-red-400'}`}>Florida State Taxes</p>
                  <p className={`text-sm ${flTaxExpensePaid ? 'text-blue-400' : 'text-red-400'}`}>{formatUSD(flTaxExpenseAmount)}</p>
                  <p className="text-sm text-gray-500">{flTaxExpensePaid ? `Paid: ${formatDate(flTaxExpenseDate)}` : 'Not paid yet'}</p>
                </div>
                <DatePicker label="PAYMENT DATE" value={flTaxExpenseDate} onChange={setFlTaxExpenseDate} />
              </div>
            </div>

            {expenseRows.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-visible mt-2">
                {expenseRows.map((row, rowIdx) => {
                  if (row.type === 'group' && row.groupExpenses && row.groupId) {
                    const groupId = row.groupId
                    const groupItems = row.groupExpenses
                    const firstItem = groupItems[0].expense
                    const groupTotal = groupItems.reduce((s, { expense: e }) => s + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1), 0)
                    const isExpanded = expandedGroups.has(groupId)
                    const receiptUrl = firstItem.receipt_urls[0]
                    return (
                      <div key={groupId} className={rowIdx < expenseRows.length - 1 ? 'border-b border-gray-700' : ''}>
                        <div className="px-4 py-3 bg-gray-800 flex items-center justify-between gap-4 cursor-pointer" onClick={() => toggleGroup(groupId)}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                              <p className="text-base font-bold text-blue-400">{firstItem.supplier} — {groupItems.length} items</p>
                            </div>
                            <p className="text-sm text-gray-400 ml-6">{formatDate(firstItem.payment_date)} — {formatUSD(groupTotal)}</p>
                          </div>
                          <div className="flex gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                            {receiptUrl && <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">RECEIPT</a>}
                            <button onClick={() => startEditPurchase(groupId, groupItems)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removePurchaseGroup(groupItems)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE PURCHASE</button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="border-t border-gray-700">
                            {groupItems.map(({ index, expense: exp }, gi) => (
                              <div key={index} className={`px-4 py-2 pl-10 ${gi < groupItems.length - 1 ? 'border-b border-gray-700' : ''}`}>
                                {editingGroupItemIndex === index ? (
                                  <div className="flex gap-2 items-center">
                                    <input type="text" value={editingGroupItem.description} onChange={(e) => setEditingGroupItem({ ...editingGroupItem, description: e.target.value })} className={`${smallInputClass} flex-1`} placeholder="Description" />
                                    <input type="text" inputMode="decimal" value={editingGroupItem.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, quantity: e.target.value }) }} className={`${smallInputClass} w-16 text-center`} placeholder="Qty" />
                                    <div className="relative w-28">
                                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                      <input type="text" inputMode="decimal" value={editingGroupItem.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-7`} placeholder="0.00" />
                                    </div>
                                    <button onClick={saveEditGroupItem} className="bg-green-700 hover:bg-green-600 px-3 py-2 rounded-xl font-bold text-sm">SAVE</button>
                                    <button onClick={() => setEditingGroupItemIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-2 rounded-xl font-bold text-sm">✕</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-bold truncate text-blue-300">{exp.item}</p>
                                      <p className="text-sm text-blue-300">Qty: {exp.quantity || '1'} × {formatUSD(parseFloat(exp.amount))} = {formatUSD((parseFloat(exp.amount) || 0) * (parseFloat(exp.quantity) || 1))}</p>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                      <button onClick={() => startEditGroupItem(index, exp)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                                      <button onClick={() => setSendToStockConfirm({ index, expense: exp, qtyToSend: '1' })} className="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded-xl font-bold text-sm">SEND TO STOCK</button>
                                      <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                                    </div>
                                  </div>
                                )}
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
                          <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600 rounded-2xl">
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
                            <div className="flex gap-3">
                              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                  <input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
                                </div>
                              </div>
                              <div className="w-28"><label className="block mb-1 text-sm text-gray-400">QTY</label>
                                <input type="text" inputMode="decimal" value={editingExpense.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, quantity: e.target.value }) }} className={inputClass} />
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
                                <p className={`text-sm ${rowColor}`}>Qty: {exp.quantity || '1'} × {formatUSD(parseFloat(exp.amount))} = {formatUSD((parseFloat(exp.amount) || 0) * (parseFloat(exp.quantity) || 1))}</p>
                                <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                              </div>
                              <div className="flex gap-2 shrink-0">
                                {exp.receipt_urls.length > 0 && (
                                  <div className="relative">
                                    <button onClick={() => setOpenReceiptsIndex(openReceiptsIndex === index ? null : index)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                                      RECEIPTS{exp.receipt_urls.length > 1 ? ` (${exp.receipt_urls.length})` : ''}
                                    </button>
                                    {openReceiptsIndex === index && (
                                      <div className="absolute right-0 top-9 bg-gray-800 border border-gray-600 rounded-xl p-3 z-50 min-w-48 shadow-xl space-y-2">
                                        {exp.receipt_urls.map((url, ui) => (
                                          <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                                <button onClick={() => setSendToStockConfirm({ index, expense: exp, qtyToSend: '1' })} className="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded-xl font-bold text-sm">SEND TO STOCK</button>
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

        <button onClick={saveInvoice} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        <a href={`/rides/${rideId}/invoices`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}
