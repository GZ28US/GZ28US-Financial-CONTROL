'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Part = { id?: string; description: string; unit_price: string; quantity: string; base_cost?: string }
type Service = { id?: string; description: string; price: string }
// paid_at: ISO timestamp string when the user explicitly clicked PAID. Empty = UNPAID.
type Payment = { id?: string; amount: string; payment_date: string; source: string; paid_to: string; receipt_url: string; description: string; paid_at: string }
type Note = { id?: string; note: string }
// stock_source_type / stock_donor are the lineage carriers: when an item is
// pulled FROM STOCK into this expense list, we copy the stock row's source_type
// and donor here so that if it gets sent back via SEND TO -> STOCK later, it
// returns to stock with its original origin intact (never re-labeled by the
// intermediate car).
type Expense = {
  id?: string
  supplier: string
  item: string
  amount: string
  tax: string
  extra: string
  quantity: string
  payment_date: string
  receipt_urls: string[]
  purchase_group?: string
  stock_source_type?: string
  stock_donor?: string
  export_status?: string
  item_discount?: string
}
type StockItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  supplier: string | null
  purchase_date: string | null
  source_type: string | null
  donor: string | null
}
type PartsToStock = { description: string; quantity: string; unit_price: string; date: string }
type ScannedPayment = { amount: string; source: string; paid_to: string; date: string; receipt_url: string; description: string }
type IncomeReport = { amount: string; source: string; date: string; receipt_url: string; description: string; report: boolean }
type ExpenseReportItem = { item: string; amount: string; quantity: string; tax: string; extra: string }
type ExpenseReport = { supplier: string; date: string; receipt_url: string; items: ExpenseReportItem[]; report: boolean }
type DuplicateInfo = { title: string; details: string; proceed: () => void }

const paymentSources = ['', 'CASH', 'ACH', 'ZELLE', 'CHECK']
const paidToOptions = ['GZ28US', 'GZ28BR']
const FULL_PROJECT_LABOR = 'Full Project Labor'
const SKIP_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

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

// Same as sortByDateAsc but newest first. Empty/invalid dates still go LAST so
// they don't bubble to the top of a "most recent first" list.
function sortByDateDesc<T>(rows: T[], getDate: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ka = dateSortKey(getDate(a.row))
      const kb = dateSortKey(getDate(b.row))
      const aMissing = !isFinite(ka)
      const bMissing = !isFinite(kb)
      if (aMissing && !bMissing) return 1
      if (!aMissing && bMissing) return -1
      return ka === kb ? a.i - b.i : kb - ka
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

function paymentStatus(p: Payment): 'PAID' | 'DELAYED' | 'PENDING' {
  if (p.paid_at) return 'PAID'
  if (p.payment_date && /^\d{4}-\d{2}-\d{2}$/.test(p.payment_date) && isTodayOrPast(p.payment_date)) return 'DELAYED'
  return 'PENDING'
}

function formatTsDate(ts: string) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function EditInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const pathname = usePathname()
  const ownerId = String(params.id)
  const invoiceId = String(params.invoiceId)
  const isClient = (pathname || '').includes('/clients/')
  const basePath = isClient ? `/clients/${ownerId}/invoices` : `/rides/${ownerId}/invoices`

  const [loading, setLoading] = useState(true)
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientNumber, setClientNumber] = useState<number | null>(null)
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
  const [importMargin, setImportMargin] = useState('')
  const [editingPartIndex, setEditingPartIndex] = useState<number | null>(null)
  const [editingPart, setEditingPart] = useState<Part>({ description: '', unit_price: '', quantity: '1' })
  const [services, setServices] = useState<Service[]>([])
  const [newService, setNewService] = useState<Service>({ description: '', price: '' })
  const [editingServiceIndex, setEditingServiceIndex] = useState<number | null>(null)
  const [editingService, setEditingService] = useState<Service>({ description: '', price: '' })
  const [payments, setPayments] = useState<Payment[]>([])
  const [newPayment, setNewPayment] = useState<Payment>({ amount: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  const [editingPaymentIndex, setEditingPaymentIndex] = useState<number | null>(null)
  const [editingPayment, setEditingPayment] = useState<Payment>({ amount: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  // paidInConfirm: clicking UNPAID (to mark PAID) opens a "PAID IN?" date box,
  // defaulting to today. The chosen date sets paid_at; payment_date is untouched.
  // Going PAID -> UNPAID just clears paid_at with no box.
  const [paidInConfirm, setPaidInConfirm] = useState<{ index: number; date: string } | null>(null)
  const [scanningPayment, setScanningPayment] = useState(false)
  const [scannedPayments, setScannedPayments] = useState<ScannedPayment[] | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [newNote, setNewNote] = useState('')
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [suppliers, setSuppliers] = useState<{ name: string; discount: number; discount_type: string }[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', payment_date: '', receipt_urls: [], export_status: 'FRESH', item_discount: '0' })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', payment_date: '', receipt_urls: [], export_status: 'FRESH', item_discount: '0' })
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [showStockModal, setShowStockModal] = useState(false)
  const [stockItems, setStockItems] = useState<StockItem[]>([])
  const [stockQtyInput, setStockQtyInput] = useState<Record<string, string>>({})
  const [stockTarget, setStockTarget] = useState<'new' | number>('new')
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{ supplier: string; date: string; items: { description: string; amount: string; quantity: string; tax: string; extra: string; item_discount: string }[]; receiptUrl: string } | null>(null)
  const [editingPurchaseGroupId, setEditingPurchaseGroupId] = useState<string | null>(null)
  const [editingPurchaseSupplier, setEditingPurchaseSupplier] = useState('')
  const [editingPurchaseDate, setEditingPurchaseDate] = useState('')
  const [editingGroupItemIndex, setEditingGroupItemIndex] = useState<number | null>(null)
  const [editingGroupItem, setEditingGroupItem] = useState<{ description: string; amount: string; quantity: string; tax: string; extra: string; item_discount: string }>({ description: '', amount: '', quantity: '1', tax: '0', extra: '0', item_discount: '0' })
  // sendToConfirm: the SEND TO button on an expense row opens this modal. The user
  // enters a quantity and chooses STOCK or GOODS as the destination. STOCK applies
  // the DONATED/PURCHASED lineage rules; GOODS inserts a fresh row into the goods
  // table without lineage tracking (goods are always purchased).
  const [sendToConfirm, setSendToConfirm] = useState<{ index: number; expense: Expense; qtyToSend: string } | null>(null)
  // Confirmation gates for expense removal. confirmRemoveExpenseIndex covers both
  // standalone expense rows and individual items inside an expanded group;
  // confirmRemovePurchaseGroupId covers the REMOVE PURCHASE button that wipes
  // every item in a scanned group at once.
  const [confirmRemoveExpenseIndex, setConfirmRemoveExpenseIndex] = useState<number | null>(null)
  const [confirmRemovePurchaseGroupId, setConfirmRemovePurchaseGroupId] = useState<string | null>(null)
  const [partsToStock, setPartsToStock] = useState<PartsToStock[]>([])
  const [newPartToStock, setNewPartToStock] = useState<PartsToStock>({ description: '', quantity: '1', unit_price: '', date: todayStr() })
  const [savedPartsToStock, setSavedPartsToStock] = useState<PartsToStock[]>([])
  const [flTaxExpenseDate, setFlTaxExpenseDate] = useState('')
  const [incomeReports, setIncomeReports] = useState<IncomeReport[] | null>(null)
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  const rideNameRef = useRef('')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    if (isClient) {
      const { data: clientData } = await supabase.from('clients').select('name, client_number').eq('id', ownerId).single()
      setClientName(clientData?.name || '')
      setClientNumber(clientData?.client_number ?? null)
    } else {
      const { data: rideData } = await supabase.from('rides').select('project_code, project_name').eq('id', ownerId).single()
      const pCode = rideData?.project_code || ''
      const pName = rideData?.project_name || ''
      setProjectCode(pCode)
      setProjectName(pName)
      rideNameRef.current = pCode + (pName ? ` — ${pName}` : '')
    }

    const { data, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).single()
    if (error || !data) { alert('Invoice not found'); router.push(basePath); return }
    setInvoiceCode(data.invoice_code || '')
    setHiringDate(data.hiring_date || '')
    setEntryDate(data.entry_date || '')
    setConclusionDate(data.conclusion_date || '')
    setDeliveryDate(data.delivery_date || '')
    setMileage(data.mileage ? Number(data.mileage).toLocaleString('en-US') : '')
    setService(data.service || '')
    setFeedStatus(data.feed_status === 'REAL_TIME' ? 'REAL_TIME' : 'INCOMPLETE')
    setFloridaTaxes(data.florida_taxes != null ? String(data.florida_taxes) : '6.5')
    setGlobalDiscount(data.global_discount ? String(data.global_discount) : '')
    setTargetGrandTotal(data.target_grand_total ? String(data.target_grand_total) : '')
    setImportMargin(data.import_margin ? String(data.import_margin) : '')
    setFlTaxExpenseDate(data.fl_tax_expense_date || '')

    const { data: partsData } = await supabase.from('invoice_parts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (partsData) setParts(partsData.map(p => ({ id: p.id, description: p.description, unit_price: String(p.unit_price), quantity: String(p.quantity), base_cost: p.base_cost != null ? String(p.base_cost) : undefined })))

    const { data: servicesData } = await supabase.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (servicesData) setServices(servicesData.map(s => ({ id: s.id, description: s.description, price: String(s.price) })))

    const { data: paymentsData } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (paymentsData) setPayments(sortByDateAsc(paymentsData.map(p => ({
      id: p.id,
      amount: String(p.amount),
      payment_date: p.payment_date || '',
      source: p.source || '',
      paid_to: p.paid_to || 'GZ28US',
      receipt_url: p.receipt_url || '',
      description: p.description || '',
      paid_at: p.paid_at || '',
    })), p => p.payment_date))

    const { data: notesData } = await supabase.from('invoice_notes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (notesData) setNotes(notesData.map(n => ({ id: n.id, note: n.note })))

    const { data: expensesData } = await supabase.from('invoice_expenses').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (expensesData) {
      setExpenses(sortExpensesByDate(expensesData.map(e => ({
        id: e.id,
        supplier: e.supplier || '',
        item: e.item,
        amount: String(e.price),
        tax: String(e.tax ?? 0),
        extra: String(e.extra ?? 0),
        item_discount: String(e.item_discount ?? 0),
        quantity: String(e.quantity || 1),
        payment_date: e.payment_date || '',
        receipt_urls: parseReceiptUrls(e.receipt_url),
        purchase_group: e.purchase_group || undefined,
        stock_source_type: e.stock_source_type || undefined,
        stock_donor: e.stock_donor || undefined,
        export_status: e.export_status || 'FRESH',
      }))))
      setExpandedGroups(new Set())
    }

    const { data: suppliersData } = await supabase.from('suppliers').select('name, discount, discount_type')
    if (suppliersData) setSuppliers(suppliersData.map((s: any) => ({ name: s.name || '', discount: Number(s.discount) || 0, discount_type: s.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED' })))

    const iCode = data.invoice_code || ''
    const rName = isClient ? iCode : rideNameRef.current
    const prefix = `From ${iCode} — ${rName}`
    const { data: stockHistory } = await supabase.from('inputs').select('*').eq('supplier', rName).eq('category', 'STOCK').ilike('notes', `${prefix}%`)
    if (stockHistory) {
      // Newest first — both for the editable PARTS TO STOCK list and the
      // "already in stock from this invoice" recap below it.
      const mapped = sortByDateDesc(stockHistory.map(s => ({
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

  // Returns the canonical "owner label" string used as the donor identifier.
  // For ride invoices: "PROJECT_CODE — Project Name". For client goods invoices:
  // "CLIENT_NUMBER — Client Name". Empty parts are stripped.
  function ownerLabel(): string {
    if (isClient) {
      const num = clientNumber != null ? String(clientNumber) : ''
      return [num, clientName].filter(Boolean).join(' — ')
    }
    return projectCode + (projectName ? ` — ${projectName}` : '')
  }

  async function openStockModal(target: 'new' | number) {
    setStockTarget(target)
    const { data } = await supabase
      .from('inputs')
      .select('id, description, quantity, unit_price, supplier, purchase_date, source_type, donor')
      .eq('category', 'STOCK')
      .gt('quantity', 0)
      .order('description')
    setStockItems((data || []) as StockItem[])
    setStockQtyInput({})
    setShowStockModal(true)
  }

  async function applyStockItem(item: StockItem) {
    const qty = parseFloat(stockQtyInput[item.id] || '1') || 1
    if (qty > item.quantity) { alert(`Only ${item.quantity} available`); return }
    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const amount = item.unit_price.toFixed(2)
    // Carry the stock row's origin onto the expense so a future SEND TO -> STOCK
    // restores it instead of falsely re-labeling.
    const expense: Expense = {
      supplier: 'STOCK',
      item: item.description,
      amount,
      tax: '0',
      extra: '0',
      quantity: String(qty),
      payment_date: item.purchase_date || '',
      receipt_urls: [],
      stock_source_type: item.source_type || undefined,
      stock_donor: item.donor || undefined,
      export_status: 'FRESH',
      item_discount: '0',
    }
    if (stockTarget === 'new') {
      setExpenses(prev => [...prev, expense])
    } else {
      const updated = [...expenses]; updated[stockTarget as number] = { ...updated[stockTarget as number], ...expense }; setExpenses(updated)
    }
    const { data: inputData } = await supabase.from('inputs').select('notes').eq('id', item.id).single()
    const existingNote = inputData?.notes || ''
    const usageNote = `Used ${qty} in ${rideName || ownerLabel()}`
    const updatedNotes = existingNote ? `${existingNote}\n${usageNote}` : usageNote
    await supabase.from('inputs').update({ quantity: item.quantity - qty, notes: updatedNotes, updated_at: new Date().toISOString() }).eq('id', item.id)
    setShowStockModal(false)
  }

  async function handleAddPurchase(file: File) {
    setScanningPurchase(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${ownerId}/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
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
        body: JSON.stringify({ base64, mediaType: file.type, separateExtras: true }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPurchase(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const items = (parsed.items || []).map((i: any) => ({ description: String(i.description || ''), amount: String(i.amount || '0'), quantity: String(i.quantity || '1'), tax: String(i.tax || '0'), extra: String(i.extra || '0'), item_discount: String(i.item_discount || '0') }))
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)

      const openReview = () => setScannedPurchase({ supplier, date, items, receiptUrl })

      if (supplier && date && total > 0) {
        const { data: existing } = await supabase
          .from('invoice_expenses')
          .select('id, supplier, payment_date, price, quantity, purchase_group')
          .ilike('supplier', supplier)
          .eq('payment_date', date)

        if (existing && existing.length > 0) {
          const groupTotals = new Map<string, number>()
          existing.forEach(e => {
            const key = e.purchase_group || e.id
            const lineT = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1)
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
      alert('Failed to scan receipt. Please try again or add items manually.')
    }
    setScanningPurchase(false)
  }

  async function handleScanPayment(file: File) {
    setScanningPayment(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${ownerId}/incomes/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPayment(false); return }
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
        paid_to: 'GZ28US',
        date: String(p.date || ''),
        receipt_url: receiptUrl,
        description: '',
      }))
      if (list.length === 0) list.push({ amount: '', source: '', paid_to: 'GZ28US', date: '', receipt_url: receiptUrl, description: '' })

      const openReview = () => setScannedPayments(list)

      const matchedRows: string[] = []
      for (const p of list) {
        const amount = parseFloat(p.amount) || 0
        if (amount <= 0 || !p.date) continue
        const { data: existing } = await supabase
          .from('invoice_payments')
          .select('amount, payment_date, source')
          .eq('payment_date', p.date)
        const match = (existing || []).find(e =>
          Math.abs((parseFloat(e.amount) || 0) - amount) < 0.01 &&
          (e.source || '') === (p.source || '')
        )
        if (match) {
          matchedRows.push(`${formatUSD(amount)}${p.source ? ` (${p.source})` : ''} on ${formatDate(p.date)}`)
        }
      }

      if (matchedRows.length > 0) {
        setScanningPayment(false)
        setDuplicateWarning({
          title: 'POSSIBLE DUPLICATE INCOME',
          details: `The following income(s) appear to already exist:\n\n${matchedRows.map(s => `• ${s}`).join('\n')}\n\nIs this the same document being scanned again?`,
          proceed: openReview,
        })
        return
      }

      openReview()
    } catch (err) {
      console.error(err)
      alert('Failed to scan income. Please try again or add it manually.')
    }
    setScanningPayment(false)
  }

  function confirmScannedPayments() {
    if (!scannedPayments) return
    const valid = scannedPayments.filter(p => p.amount !== '' && !isNaN(parseFloat(p.amount)))
    if (valid.length === 0) { setScannedPayments(null); return }
    const newRows: Payment[] = valid.map(p => {
      const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(p.date)
        ? new Date(p.date + 'T12:00:00Z').toISOString()
        : new Date().toISOString()
      return { amount: p.amount, payment_date: p.date, source: p.source, paid_to: p.paid_to || 'GZ28US', receipt_url: p.receipt_url || '', description: p.description || '', paid_at: paidAt }
    })
    setPayments(prev => sortByDateAsc([...prev, ...newRows], p => p.payment_date))
    setScannedPayments(null)
  }

  function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const groupId = generateUUID()
    const newItems: Expense[] = scannedPurchase.items.map(item => ({
      supplier: scannedPurchase.supplier,
      item: item.description,
      amount: item.amount,
      tax: item.tax || '0',
      extra: item.extra || '0',
      quantity: item.quantity || '1',
      payment_date: scannedPurchase.date,
      receipt_urls: [scannedPurchase.receiptUrl],
      purchase_group: groupId,
      export_status: 'FRESH',
      item_discount: item.item_discount || '0',
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
    setEditingGroupItem({ description: exp.item, amount: exp.amount, quantity: exp.quantity || '1', tax: exp.tax || '0', extra: exp.extra || '0', item_discount: exp.item_discount || '0' })
  }

  async function saveEditGroupItem() {
    if (editingGroupItemIndex === null) return
    const exp = expenses[editingGroupItemIndex]
    if (exp.id) {
      await supabase.from('invoice_expenses').update({
        item: editingGroupItem.description,
        price: parseFloat(editingGroupItem.amount) || 0,
        tax: parseFloat(editingGroupItem.tax) || 0,
        extra: parseFloat(editingGroupItem.extra) || 0,
        quantity: parseFloat(editingGroupItem.quantity) || 1,
        item_discount: parseFloat(editingGroupItem.item_discount) || 0,
      }).eq('id', exp.id)
    }
    const updated = [...expenses]
    updated[editingGroupItemIndex] = { ...updated[editingGroupItemIndex], item: editingGroupItem.description, amount: editingGroupItem.amount, tax: editingGroupItem.tax, extra: editingGroupItem.extra, quantity: editingGroupItem.quantity, item_discount: editingGroupItem.item_discount }
    setExpenses(updated)
    setEditingGroupItemIndex(null)
  }

  // SEND TO confirmation handler. The destination is STOCK or GOODS.
  //  - STOCK: insert into the inputs table with DONATED/PURCHASED lineage. If
  //    the expense carried stock_source_type='DONATED' (i.e. it was pulled from
  //    stock as DONATED via FROM STOCK), we restore DONATED and the original
  //    stock_donor. Otherwise the item is recorded as PURCHASED.
  //  - GOODS: insert into the goods table (goods are always purchased, no
  //    lineage to track). Fields mirror what a manual goods entry looks like.
  // The original expense row is then reduced by qtyToSend (or removed if zero).
  async function confirmSendTo(item: { index: number; expense: Expense; qtyToSend: string }, target: 'STOCK' | 'GOODS') {
    const exp = item.expense
    const qtyToSend = parseFloat(item.qtyToSend) || 1
    const totalQty = parseFloat(exp.quantity) || 1
    if (qtyToSend <= 0) { alert('Quantity must be greater than zero.'); return }
    if (qtyToSend > totalQty) { alert(`Only ${totalQty} available.`); return }

    const receiptUrlsJson = exp.receipt_urls.length > 0 ? JSON.stringify(exp.receipt_urls) : null

    if (target === 'STOCK') {
      const camFromDonated = exp.stock_source_type === 'DONATED'
      const sourceType = camFromDonated ? 'DONATED' : 'PURCHASED'
      const donor = camFromDonated ? (exp.stock_donor || null) : null
      const note = `From ${invoiceCode} — ${ownerLabel()}`
      const { error } = await supabase.from('inputs').insert([{
        description: exp.item,
        category: 'STOCK',
        quantity: qtyToSend,
        unit_price: parseFloat(exp.amount) || 0,
        purchase_date: isValidDate(exp.payment_date) ? exp.payment_date : null,
        supplier: exp.supplier || null,
        notes: note,
        receipt_url: receiptUrlsJson,
        source_type: sourceType,
        donor: donor,
      }])
      if (error) { alert(error.message); return }
    } else {
      const { error } = await supabase.from('goods').insert([{
        description: exp.item,
        quantity: qtyToSend,
        unit_price: parseFloat(exp.amount) || 0,
        purchase_date: isValidDate(exp.payment_date) ? exp.payment_date : null,
        supplier: exp.supplier || null,
        receipt_url: receiptUrlsJson,
      }])
      if (error) { alert(error.message); return }
    }

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
    setSendToConfirm(null)
  }

  // Sets export_status on the given expense indices in LOCAL state only. The
  // change is persisted on SAVE CHANGES (see saveInvoice) — never written to the
  // DB immediately, so importing without saving leaves nothing behind on reload.
  function markExportStatus(indices: number[], status: string) {
    if (indices.length === 0) return
    const idxSet = new Set(indices)
    setExpenses(prev => prev.map((e, i) => idxSet.has(i) ? { ...e, export_status: status } : e))
  }

  function resetExportStatus(index: number) {
    markExportStatus([index], 'FRESH')
  }

  // Small status line shown on every expense item: FRESH (gray), EXPORTED
  // (green), or REMOVED (red), with a RESET link (back to FRESH) when not FRESH.
  function exportStatusLine(exp: Expense, index: number) {
    const st = exp.export_status || 'FRESH'
    const color = st === 'EXPORTED' ? 'text-green-400' : st === 'REMOVED' ? 'text-red-400' : 'text-gray-400'
    return (
      <p className="text-xs mt-0.5">
        <span className={`font-bold ${color}`}>{st}</span>
        {st !== 'FRESH' && (
          <button onClick={() => resetExportStatus(index)} className="ml-2 text-gray-400 underline hover:text-white">RESET</button>
        )}
      </p>
    )
  }

  function importIntuitiveParts() {
    // Import each FRESH expense row at its pre-margin landed cost per unit
    // (amount*qty + tax + extra)/qty, stored as base_cost. The displayed unit_price
    // is base_cost * (1 + MARGIN/100) and is kept live by the effect below, so
    // changing MARGIN later re-prices every imported part without re-importing.
    // Only FRESH items import; each imported item flips to EXPORTED.
    const margin = parseFloat(importMargin) || 0
    const factor = 1 + margin / 100
    const sourceMap = new Map<string, { description: string; base: number; quantity: number }>()
    const importedIndices: number[] = []
    expenses.forEach((e, idx) => {
      if (SKIP_WORDS.test(e.item)) return
      if ((e.export_status || 'FRESH') !== 'FRESH') return
      const desc = (e.item || '').trim()
      if (!desc) return
      const amount = parseFloat(e.amount) || 0
      const qty = parseFloat(e.quantity) || 1
      const tax = parseFloat(e.tax) || 0
      const extra = parseFloat(e.extra) || 0
      // Gross the ITEM PRICE back up to its market (pre-discount) value:
      // market = amount / (1 - discount%). For a FIXED supplier the discount is the
      // supplier's single %; for a VARIABLE supplier it's this item's own % (e.item_discount);
      // unregistered suppliers get no gross-up. Tax and extra are real costs and are
      // NOT grossed up. The market price becomes the part's base cost, on top of
      // which the live MARGIN is then applied.
      const info = supplierInfo(e.supplier)
      const disc = info ? (info.type === 'VARIABLE' ? (parseFloat(e.item_discount || '0') || 0) : info.discount) : 0
      const discFactor = (disc > 0 && disc < 100) ? (1 - disc / 100) : 1
      const marketAmount = amount / discFactor
      const unitBase = qty > 0 ? (marketAmount * qty + tax + extra) / qty : marketAmount
      const key = `${desc.toLowerCase()}|${unitBase.toFixed(4)}`
      const existing = sourceMap.get(key)
      if (existing) existing.quantity += qty
      else sourceMap.set(key, { description: desc, base: unitBase, quantity: qty })
      importedIndices.push(idx)
    })

    if (importedIndices.length === 0) { alert('No FRESH parts to import.'); return }

    const toAdd: Part[] = []
    sourceMap.forEach(src => {
      toAdd.push({
        description: src.description,
        unit_price: (src.base * factor).toFixed(2),
        quantity: String(src.quantity),
        base_cost: String(src.base),
      })
    })
    setParts(prev => [...prev, ...toAdd])
    markExportStatus(importedIndices, 'EXPORTED')
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
  // Returns the registered discount (%) for a supplier name if it exists in the
  // suppliers database (case-insensitive match), otherwise null. Display only —
  // no math is applied to the prices.
  // Returns the registered supplier's discount config, or null if unregistered.
  function supplierInfo(name: string | undefined | null): { discount: number; type: 'FIXED' | 'VARIABLE' } | null {
    if (!name) return null
    const n = name.trim().toLowerCase()
    if (!n) return null
    const m = suppliers.find(s => s.name.trim().toLowerCase() === n)
    if (!m) return null
    return { discount: m.discount, type: m.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED' }
  }
  // The fixed % for a FIXED-type supplier (null for VARIABLE or unregistered).
  function supplierDiscount(name: string | undefined | null): number | null {
    const i = supplierInfo(name)
    return i && i.type === 'FIXED' ? i.discount : null
  }
  function supplierIsVariable(name: string | undefined | null): boolean {
    const i = supplierInfo(name)
    return !!i && i.type === 'VARIABLE'
  }
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
  // Display-only: shopping (client) invoices show the Full Project Labor row as
  // "HANDLING". The stored description stays FULL_PROJECT_LABOR so the auto-CALCULATE
  // lookup, labor index, and save logic keep matching on the real key.
  function serviceDisplayName(desc: string) { return isClient && desc === FULL_PROJECT_LABOR ? 'HANDLING' : desc }

  async function uploadReceiptsToEditing(files: FileList) {
    const urls: string[] = [...editingExpense.receipt_urls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `${ownerId}/${invoiceId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
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
  const totalPaid = payments.filter(p => !!p.paid_at).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0)
  const balance = totalPaid - grandTotal
  const flTaxExpenseAmount = floridaTaxesAmount
  const flTaxExpensePaid = isValidDate(flTaxExpenseDate)
  const expensesTotalGlobal = flTaxExpenseAmount + expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
  const expensesTotalPaid = (flTaxExpensePaid ? flTaxExpenseAmount : 0) + expenses.filter(e => isValidDate(e.payment_date)).reduce((sum, e) => sum + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
  const expensesBalance = expensesTotalPaid - expensesTotalGlobal
  const currentProfit = totalPaid - expensesTotalPaid
  const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = (val: number) => val < 0 ? 'text-red-500' : 'text-blue-400'

  // Live IMPORT MARGIN: whenever the margin changes, re-price every imported part
  // (those carrying a base_cost) as base_cost * (1 + margin/100). Manually-added
  // parts (no base_cost) are untouched. Depends only on importMargin, so it can't
  // loop. Persisted on SAVE CHANGES.
  useEffect(() => {
    if (loading) return
    const margin = parseFloat(importMargin) || 0
    const factor = 1 + margin / 100
    setParts(prev => {
      let changed = false
      const next = prev.map(p => {
        if (p.base_cost == null || p.base_cost === '') return p
        const base = parseFloat(p.base_cost) || 0
        const newPrice = (base * factor).toFixed(2)
        if (newPrice === p.unit_price) return p
        changed = true
        return { ...p, unit_price: newPrice }
      })
      return changed ? next : prev
    })
  }, [importMargin, loading])

  // Auto-CALCULATE: keep Full Project Labor solved so the grand total hits the
  // saved TARGET GRAND TOTAL. Recomputes whenever any non-labor input that feeds
  // the grand total changes (parts, other services, discount, target). The labor
  // row is excluded from otherServicesTotal, so setting it here can't feed back
  // into this effect's inputs — no loop. Persisted on SAVE CHANGES.
  useEffect(() => {
    if (loading) return
    const target = parseFloat((targetGrandTotal || '').replace(/,/g, ''))
    if (!target || target <= 0) return
    const discountFactor = 1 - (globalDiscountPct / 100)
    if (discountFactor <= 0) return
    const labor = (target / discountFactor) - partsTotal - otherServicesTotal
    const laborStr = (labor < 0 ? 0 : labor).toFixed(2)
    setServices(prev => {
      const li = prev.findIndex(s => s.description === FULL_PROJECT_LABOR)
      if (li < 0) {
        // No labor line on this invoice yet — create one so the target is met.
        return [...prev, { description: FULL_PROJECT_LABOR, price: laborStr }]
      }
      if (prev[li].price === laborStr) return prev
      const updated = [...prev]
      updated[li] = { ...updated[li], price: laborStr }
      return updated
    })
  }, [targetGrandTotal, partsTotal, otherServicesTotal, globalDiscountPct, laborIndex, loading])

  function addPart() {
    if (!newPart.description || !newPart.unit_price || !newPart.quantity) { alert('Please fill in all part fields'); return }
    setParts([...parts, newPart]); setNewPart({ description: '', unit_price: '', quantity: '1' })
  }
  async function removePart(index: number) {
    const part = parts[index]
    if (part.id) await supabase.from('invoice_parts').delete().eq('id', part.id)
    setParts(parts.filter((_, i) => i !== index))
    // Any EXPORTED expense item that produced this part (matched by description)
    // flips to REMOVED so the user can see it was exported then pulled from PARTS.
    const desc = (part.description || '').trim().toLowerCase()
    if (desc) {
      const matchIdx: number[] = []
      expenses.forEach((e, i) => {
        if ((e.export_status || 'FRESH') === 'EXPORTED' && (e.item || '').trim().toLowerCase() === desc) matchIdx.push(i)
      })
      if (matchIdx.length) markExportStatus(matchIdx, 'REMOVED')
    }
  }
  function startEditPart(index: number) { setEditingPartIndex(index); setEditingPart({ ...parts[index] }) }
  async function saveEditPart() {
    if (!editingPart.description || !editingPart.unit_price || !editingPart.quantity) { alert('Please fill in all part fields'); return }
    const part = parts[editingPartIndex!]
    if (part.id) {
      // A manual edit detaches the part from the live margin (base_cost -> null),
      // so the entered price sticks and won't be re-priced by margin changes.
      const { error } = await supabase.from('invoice_parts').update({ description: editingPart.description, unit_price: parseFloat(editingPart.unit_price), quantity: parseFloat(editingPart.quantity), base_cost: null }).eq('id', part.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...parts]; updated[editingPartIndex!] = { ...editingPart, id: part.id, base_cost: undefined }; setParts(updated)
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
    setPayments(sortByDateAsc([...payments, newPayment], p => p.payment_date)); setNewPayment({ amount: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
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
      const { error } = await supabase.from('invoice_payments').update({ amount: parseFloat(editingPayment.amount), payment_date: isValidDate(editingPayment.payment_date) ? editingPayment.payment_date : null, source: editingPayment.source || null, paid_to: editingPayment.paid_to || 'GZ28US', description: editingPayment.description || null }).eq('id', payment.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...payments]; updated[editingPaymentIndex!] = { ...editingPayment, id: payment.id }; setPayments(sortByDateAsc(updated, p => p.payment_date))
    setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  }
  function cancelEditPayment() { setEditingPaymentIndex(null); setEditingPayment({ amount: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' }) }

  async function togglePaid(index: number) {
    const p = payments[index]
    if (p.paid_at) {
      // Unmark — clear paid_at, no box.
      if (p.id) {
        const { error } = await supabase.from('invoice_payments').update({ paid_at: null }).eq('id', p.id)
        if (error) { alert(error.message); return }
      }
      const updated = [...payments]
      updated[index] = { ...updated[index], paid_at: '' }
      setPayments(updated)
    } else {
      // Mark paid — ask for the paid date (PAID IN?), default today.
      setPaidInConfirm({ index, date: todayStr() })
    }
  }

  async function confirmPaidIn() {
    if (!paidInConfirm) return
    const { index, date } = paidInConfirm
    const p = payments[index]
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(date + 'T12:00:00Z').toISOString()
      : new Date().toISOString()
    if (p.id) {
      const { error } = await supabase.from('invoice_payments').update({ paid_at: paidAt }).eq('id', p.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...payments]
    updated[index] = { ...updated[index], paid_at: paidAt }
    setPayments(updated)
    setPaidInConfirm(null)
  }

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
    setExpenses([...expenses, newExpense]); setNewExpense({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', payment_date: '', receipt_urls: [], export_status: 'FRESH', item_discount: '0' })
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
        tax: parseFloat(editingExpense.tax) || 0,
        extra: parseFloat(editingExpense.extra) || 0,
        quantity: parseFloat(editingExpense.quantity) || 1,
        item_discount: parseFloat(editingExpense.item_discount || '0') || 0,
        payment_date: isValidDate(editingExpense.payment_date) ? editingExpense.payment_date : null,
        receipt_url: editingExpense.receipt_urls.length > 0 ? JSON.stringify(editingExpense.receipt_urls) : null,
      }).eq('id', exp.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...expenses]; updated[editingExpenseIndex!] = { ...editingExpense, id: exp.id }; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', payment_date: '', receipt_urls: [], export_status: 'FRESH', item_discount: '0' })
  }
  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', tax: '0', extra: '0', quantity: '1', payment_date: '', receipt_urls: [], export_status: 'FRESH', item_discount: '0' }) }

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
      target_grand_total: targetGrandTotal ? parseFloat(targetGrandTotal.replace(/,/g, '')) : null,
      import_margin: parseFloat(importMargin) || 0,
      fl_tax_expense_date: isValidDate(flTaxExpenseDate) ? flTaxExpenseDate : null,
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    if (error) { alert(error.message); return }

    const newParts = parts.filter(p => !p.id)
    if (newParts.length > 0) {
      const { error: e } = await supabase.from('invoice_parts').insert(newParts.map(p => ({ invoice_id: invoiceId, description: p.description, unit_price: parseFloat(p.unit_price), quantity: parseFloat(p.quantity), base_cost: (p.base_cost != null && p.base_cost !== '') ? parseFloat(p.base_cost) : null })))
      if (e) { alert(e.message); return }
    }
    // Re-persist margin-managed existing parts whose unit_price may have shifted
    // because the live IMPORT MARGIN changed since they were last saved.
    const existingMarginParts = parts.filter(p => p.id && p.base_cost != null && p.base_cost !== '')
    for (const p of existingMarginParts) {
      await supabase.from('invoice_parts').update({ unit_price: parseFloat(p.unit_price) || 0, base_cost: parseFloat(p.base_cost!) || 0 }).eq('id', p.id)
    }
    const newServices = services.filter(s => !s.id)
    if (newServices.length > 0) {
      const { error: e } = await supabase.from('invoice_services').insert(newServices.map(s => ({ invoice_id: invoiceId, description: s.description, price: parseFloat(s.price) || 0 })))
      if (e) { alert(e.message); return }
    }
    // Persist the auto-calculated Full Project Labor on an existing row (the
    // CALCULATE button that used to write inline is gone).
    const laborSvc = services.find(s => s.id && s.description === FULL_PROJECT_LABOR)
    if (laborSvc) {
      const { error: e } = await supabase.from('invoice_services').update({ price: parseFloat(laborSvc.price) || 0 }).eq('id', laborSvc.id)
      if (e) { alert(e.message); return }
    }
    const newPayments = payments.filter(p => !p.id)
    if (newPayments.length > 0) {
      const { error: e } = await supabase.from('invoice_payments').insert(newPayments.map(p => ({
        invoice_id: invoiceId,
        amount: parseFloat(p.amount),
        payment_date: isValidDate(p.payment_date) ? p.payment_date : null,
        source: p.source || null,
        paid_to: p.paid_to || 'GZ28US',
        receipt_url: p.receipt_url || null,
        description: p.description || null,
        paid_at: p.paid_at || null,
      })))
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
        tax: parseFloat(ex.tax) || 0,
        extra: parseFloat(ex.extra) || 0,
        quantity: parseFloat(ex.quantity) || 1,
        item_discount: parseFloat(ex.item_discount || '0') || 0,
        payment_date: isValidDate(ex.payment_date) ? ex.payment_date : null,
        receipt_url: ex.receipt_urls.length > 0 ? JSON.stringify(ex.receipt_urls) : null,
        purchase_group: ex.purchase_group || null,
        stock_source_type: ex.stock_source_type || null,
        stock_donor: ex.stock_donor || null,
        export_status: ex.export_status || 'FRESH',
      })))
      if (e) { alert(e.message); return }
    }

    // Persist export_status changes (IMPORT -> EXPORTED, part removal -> REMOVED,
    // RESET -> FRESH) for already-saved expense rows. These are intentionally NOT
    // written until SAVE CHANGES, so importing without saving leaves no trace.
    const existingExpenses = expenses.filter(e => e.id)
    for (const ex of existingExpenses) {
      await supabase.from('invoice_expenses').update({ export_status: ex.export_status || 'FRESH' }).eq('id', ex.id)
    }

    // PARTS TO STOCK: these are always DONATED. The donor is the current
    // owner (ride or, if this section ever opens up to clients, the client).
    // Delete-then-reinsert is fine because partsToStock is the full intended
    // state of the "from this invoice" stock rows.
    const rideName = projectCode + (projectName ? ` — ${projectName}` : '')
    const donorLabel = ownerLabel()
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
        source_type: 'DONATED',
        donor: donorLabel,
      })))
      if (e) { alert(e.message); return }
    }

    const pendingIncomes: IncomeReport[] = newPayments
      .filter(p => !!p.paid_at)
      .map(p => ({
        amount: p.amount,
        source: p.source,
        date: p.payment_date,
        receipt_url: p.receipt_url || '',
        description: p.description || '',
        report: true,
      }))

    const groupMap = new Map<string, ExpenseReport>()
    const pendingExpenses: ExpenseReport[] = []
    newExpenses.forEach(ex => {
      const item: ExpenseReportItem = { item: ex.item, amount: ex.amount, quantity: ex.quantity || '1', tax: ex.tax || '0', extra: ex.extra || '0' }
      if (ex.purchase_group) {
        const existing = groupMap.get(ex.purchase_group)
        if (existing) {
          existing.items.push(item)
        } else {
          const rep: ExpenseReport = {
            supplier: ex.supplier,
            date: ex.payment_date,
            receipt_url: ex.receipt_urls[0] || '',
            items: [item],
            report: true,
          }
          groupMap.set(ex.purchase_group, rep)
          pendingExpenses.push(rep)
        }
      } else {
        pendingExpenses.push({
          supplier: ex.supplier,
          date: ex.payment_date,
          receipt_url: ex.receipt_urls[0] || '',
          items: [item],
          report: true,
        })
      }
    })

    if (pendingIncomes.length > 0) {
      if (pendingExpenses.length > 0) setExpenseReports(pendingExpenses)
      setIncomeReports(pendingIncomes)
      return
    }
    if (pendingExpenses.length > 0) {
      setExpenseReports(pendingExpenses)
      return
    }

    router.push(basePath)
  }

  function buildIncomeCaption(inc: IncomeReport) {
    const dateStr = isValidDate(inc.date) ? formatDate(inc.date) : '—'
    const amountStr = formatUSD(parseFloat(inc.amount) || 0)
    const ownerLbl = isClient ? clientName : projectName
    const lines: string[] = [
      '*INCOME*',
      `${invoiceCode}${ownerLbl ? ` — ${ownerLbl}` : ''}`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (inc.description && inc.description.trim()) lines.push(inc.description.trim())

    if (feedStatus === 'REAL_TIME') {
      const due = balance < 0 ? -balance : 0
      lines.push('')
      lines.push(`DUE: ${formatUSD(due)}`)
      lines.push(`*CURRENT Profit: ${formatUSD(currentProfit)} / ${currentProfitPct.toFixed(1)}%*`)
      lines.push(`FINAL Profit: ${formatUSD(finalProfit)} / ${finalProfitPct.toFixed(1)}%`)
    }
    return lines.join('\n')
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1) + (parseFloat(i.tax) || 0) + (parseFloat(i.extra) || 0), 0)
    const amountStr = formatUSD(total)
    const ownerLbl = isClient ? clientName : projectName
    const lines: string[] = [
      '*EXPENSE*',
      `${invoiceCode}${ownerLbl ? ` — ${ownerLbl}` : ''}`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())

    lines.push('')
    const orderedReportItems = [...exp.items].sort((a, b) =>
      (SKIP_WORDS.test(a.item) ? 1 : 0) - (SKIP_WORDS.test(b.item) ? 1 : 0)
    )
    orderedReportItems.forEach(it => {
      const qty = parseFloat(it.quantity) || 1
      const price = parseFloat(it.amount) || 0
      const itemTax = parseFloat(it.tax) || 0
      const itemExtra = parseFloat(it.extra) || 0
      const itemTotal = price * qty
      const taxStr = itemTax > 0 ? ` (+tax ${formatUSD(itemTax)})` : ''
      const extraStr = itemExtra > 0 ? ` (+extra ${formatUSD(itemExtra)})` : ''
      lines.push(`• ${it.item} — ${qty} × ${formatUSD(price)} = ${formatUSD(itemTotal)}${taxStr}${extraStr}`)
    })

    if (!isClient && feedStatus === 'REAL_TIME') {
      const due = balance < 0 ? -balance : 0
      lines.push('')
      lines.push(`DUE: ${formatUSD(due)}`)
      lines.push(`*CURRENT Profit: ${formatUSD(currentProfit)} / ${currentProfitPct.toFixed(1)}%*`)
      lines.push(`FINAL Profit: ${formatUSD(finalProfit)} / ${finalProfitPct.toFixed(1)}%`)
    }
    return lines.join('\n')
  }

  async function sendIncomeReports() {
    const chosen = (incomeReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    const errors: string[] = []
    for (const inc of chosen) {
      const caption = buildIncomeCaption(inc)
      const payload: any = { body: caption }
      if (inc.receipt_url) { payload.documentUrl = inc.receipt_url; payload.filename = `income-${invoiceCode}.${inc.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}` }
      try {
        const res = await fetch('/api/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!data.ok) {
          failures++
          const detailErr = data?.detail?.error
          errors.push(typeof detailErr === 'object' ? JSON.stringify(detailErr) : String(detailErr || data?.error || data?.raw || `HTTP ${res.status}`))
        }
      } catch (err) {
        failures++
        errors.push(String(err))
      }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} income report(s) failed to send. The income was still saved.\n\nReason: ${errors.join(' | ')}`)
    setIncomeReports(null)
    if (!expenseReports) router.push(basePath)
  }

  async function sendExpenseReports() {
    const chosen = (expenseReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    const errors: string[] = []
    for (const exp of chosen) {
      const caption = buildExpenseCaption(exp)
      const payload: any = { body: caption }
      if (exp.receipt_url) { payload.documentUrl = exp.receipt_url; payload.filename = `expense-${invoiceCode}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}` }
      try {
        const res = await fetch('/api/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!data.ok) {
          failures++
          const detailErr = data?.detail?.error
          errors.push(typeof detailErr === 'object' ? JSON.stringify(detailErr) : String(detailErr || data?.error || data?.raw || `HTTP ${res.status}`))
        }
      } catch (err) {
        failures++
        errors.push(String(err))
      }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The expense was still saved.\n\nReason: ${errors.join(' | ')}`)
    setExpenseReports(null)
    router.push(basePath)
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
    <main className="min-h-screen bg-black text-white p-8 pb-32">
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
                      {item.source_type === 'DONATED' && item.donor && <p className="text-sm text-orange-400">DONATED by {item.donor}</p>}
                      {item.supplier && item.source_type !== 'DONATED' && <p className="text-sm text-gray-400">{item.supplier}</p>}
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
              <h2 className="text-2xl font-bold">REVIEW INCOME</h2>
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
                    <button onClick={() => setScannedPayments(scannedPayments.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300 font-bold text-lg px-2 self-end pb-3">✕</button>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block mb-1 text-sm text-gray-400">PAYMENT METHOD</label>
                      <select value={p.source} onChange={(e) => { const a = [...scannedPayments]; a[i] = { ...a[i], source: e.target.value }; setScannedPayments(a) }} className={`${selectClass} w-full`}>
                        {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block mb-1 text-sm text-gray-400">PAID TO</label>
                      <select value={p.paid_to} onChange={(e) => { const a = [...scannedPayments]; a[i] = { ...a[i], paid_to: e.target.value }; setScannedPayments(a) }} className={`${selectClass} w-full`}>
                        {paidToOptions.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  <DatePicker label="DATE" value={p.date} onChange={(v) => { const a = [...scannedPayments]; a[i] = { ...a[i], date: v }; setScannedPayments(a) }} />
                  <div>
                    <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
                    <input type="text" value={p.description} onChange={(e) => { const a = [...scannedPayments]; a[i] = { ...a[i], description: e.target.value }; setScannedPayments(a) }} className={`${smallInputClass} w-full`} placeholder="Optional note" />
                  </div>
                </div>
              ))}
              <button onClick={() => setScannedPayments([...scannedPayments, { amount: '', source: '', paid_to: 'GZ28US', date: '', receipt_url: '', description: '' }])} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD INCOME</button>
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

      {incomeReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            </div>
            <p className="text-gray-400 text-base">Choose which new incomes to report to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {incomeReports.map((inc, i) => (
                <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold">INCOME — {formatUSD(parseFloat(inc.amount) || 0)}</p>
                    <p className="text-sm text-gray-400">{inc.source ? `${inc.source} — ` : ''}{isValidDate(inc.date) ? formatDate(inc.date) : 'No date'}</p>
                    {inc.description && <p className="text-sm text-gray-400 truncate">{inc.description}</p>}
                    <p className="text-sm text-gray-500">{inc.receipt_url ? '📎 Document attached' : 'No document (text only)'}</p>
                  </div>
                  <button
                    onClick={() => { const a = [...incomeReports]; a[i] = { ...a[i], report: !a[i].report }; setIncomeReports(a) }}
                    className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap ${inc.report ? 'bg-green-700 hover:bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                  >
                    {inc.report ? 'REPORT: YES' : 'REPORT: NO'}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-gray-400 font-bold self-center">
                {incomeReports.filter(r => r.report).length} of {incomeReports.length} will be reported
              </div>
              <button onClick={sendIncomeReports} disabled={sendingReports} className={`px-6 py-3 rounded-2xl font-bold text-lg ${sendingReports ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sendingReports ? 'SENDING...' : (expenseReports ? 'NEXT' : 'DONE')}
              </button>
            </div>
          </div>
        </div>
      )}

      {!incomeReports && expenseReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            </div>
            <p className="text-gray-400 text-base">Choose which new expenses to report to the WhatsApp group. Grouped purchases (scanned receipts) are reported as a single message listing all items.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const total = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1) + (parseFloat(it.tax) || 0) + (parseFloat(it.extra) || 0), 0)
                const isGroup = exp.items.length > 1
                const titleText = isGroup
                  ? `${exp.supplier || 'Purchase'} — ${exp.items.length} items`
                  : `${exp.items[0].item}${exp.supplier ? ` — ${exp.supplier}` : ''}`
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — {formatUSD(total)}</p>
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
                {supplierIsVariable(scannedPurchase.supplier)
                  ? <p className="text-sm font-bold text-yellow-300 mt-1">★ Supplier discount: VARIABLE (enter % per item)</p>
                  : supplierDiscount(scannedPurchase.supplier) != null && <p className="text-sm font-bold text-yellow-300 mt-1">★ Supplier discount: {supplierDiscount(scannedPurchase.supplier)}%</p>}
              </div>
              <div className="flex-1">
                <DatePicker label="DATE" value={scannedPurchase.date} onChange={(v) => setScannedPurchase({ ...scannedPurchase, date: v })} />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-2">
              {scannedPurchase.items.map((item, i) => (
                <div key={i} className="border border-gray-700 rounded-2xl p-2 space-y-2">
                  <div className="flex gap-2 items-center">
                    <input type="text" value={item.description} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], description: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} flex-1 min-w-0`} placeholder="Description" />
                    <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: scannedPurchase.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2 shrink-0">✕</button>
                  </div>
                  <div className="flex gap-2 items-center flex-wrap">
                    <div className="w-16">
                      <input type="text" inputMode="decimal" value={item.quantity} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], quantity: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} w-full text-center`} placeholder="Qty" />
                    </div>
                    <div className="relative w-28">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input type="text" value={item.amount} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], amount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} w-full pl-8`} placeholder="0.00" />
                    </div>
                    <div className="relative w-28">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">Tax $</span>
                      <input type="text" inputMode="decimal" value={item.tax} onChange={(e) => { if (isNumeric(e.target.value)) { const items = [...scannedPurchase.items]; items[i] = { ...items[i], tax: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) } }} className={`${smallInputClass} w-full pl-12`} placeholder="0.00" />
                    </div>
                    <div className="relative w-32">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">Extra $</span>
                      <input type="text" inputMode="decimal" value={item.extra} onChange={(e) => { if (isNumeric(e.target.value)) { const items = [...scannedPurchase.items]; items[i] = { ...items[i], extra: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) } }} className={`${smallInputClass} w-full pl-14`} placeholder="0.00" />
                    </div>
                    {supplierIsVariable(scannedPurchase.supplier) && (
                      <div className="relative w-24">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-yellow-300 text-sm">Disc</span>
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
                        <input type="text" inputMode="decimal" value={item.item_discount} onChange={(e) => { if (isNumeric(e.target.value)) { const items = [...scannedPurchase.items]; items[i] = { ...items[i], item_discount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) } }} className={`${smallInputClass} w-full pl-11 pr-6`} placeholder="0" />
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: [...scannedPurchase.items, { description: '', amount: '', quantity: '1', tax: '0', extra: '0', item_discount: '0' }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1) + (parseFloat(i.tax) || 0) + (parseFloat(i.extra) || 0), 0))}
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

      {/* SEND TO modal: one qty input, three actions. STOCK applies DONATED/PURCHASED
          lineage, GOODS just inserts a fresh row into the goods table. */}
      {sendToConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">Send To</h2>
            <p className="text-gray-400 text-lg mb-4">
              <span className="text-white font-bold">{sendToConfirm.expense.item}</span><br />
              Available qty: {sendToConfirm.expense.quantity}
            </p>
            <div className="mb-6">
              <label className="block mb-1 text-sm text-gray-400">QTY TO SEND</label>
              <input
                type="text"
                inputMode="decimal"
                value={sendToConfirm.qtyToSend}
                onChange={(e) => { if (isNumeric(e.target.value)) setSendToConfirm({ ...sendToConfirm, qtyToSend: e.target.value }) }}
                className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-5 py-4 text-xl text-center"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <button onClick={() => setSendToConfirm(null)} className="bg-gray-700 hover:bg-gray-600 px-4 py-4 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={() => confirmSendTo(sendToConfirm, 'GOODS')} className="bg-blue-700 hover:bg-blue-600 px-4 py-4 rounded-2xl font-bold text-lg">GOODS</button>
              <button onClick={() => confirmSendTo(sendToConfirm, 'STOCK')} className="bg-orange-700 hover:bg-orange-600 px-4 py-4 rounded-2xl font-bold text-lg">STOCK</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation gate for removing a single expense row OR an individual
          item inside an expanded grouped purchase. Both call removeExpense by
          index; the only difference is the click site that set the state. */}
      {confirmRemoveExpenseIndex !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this expense? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmRemoveExpenseIndex(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => { const i = confirmRemoveExpenseIndex; setConfirmRemoveExpenseIndex(null); if (i !== null) removeExpense(i) }} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation gate for the REMOVE PURCHASE button — wipes every item in
          a scanned group at once. We recompute the groupItems from the current
          expenses at confirm time so the index references are still accurate. */}
      {confirmRemovePurchaseGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">Remove Purchase</h2>
            <p className="text-gray-400 text-lg mb-8">This will remove ALL items in this purchase. This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmRemovePurchaseGroupId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => {
                const gid = confirmRemovePurchaseGroupId
                setConfirmRemovePurchaseGroupId(null)
                if (!gid) return
                const groupItems = expenses.map((e, i) => ({ index: i, expense: e })).filter(({ expense: e }) => e.purchase_group === gid)
                removePurchaseGroup(groupItems)
              }} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {paidInConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">PAID IN?</h2>
            <p className="text-gray-400 text-base mb-4">Enter the date this payment was received.</p>
            <DatePicker label="PAID DATE" value={paidInConfirm.date} onChange={(v) => setPaidInConfirm({ ...paidInConfirm, date: v })} />
            <div className="flex gap-3 pt-4">
              <button onClick={() => setPaidInConfirm(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={confirmPaidIn} className="flex-1 bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
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

      {(scanningPurchase || scanningPayment) && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">{scanningPayment ? 'Scanning Income...' : 'Scanning Receipt...'}</p>
            <p className="text-gray-400">Claude is reading your {scanningPayment ? 'income' : 'receipt'}</p>
          </div>
        </div>
      )}

      <h1 className="text-4xl font-bold mb-2">EDIT INVOICE</h1>
      <p className="text-gray-400 text-xl mb-8">{isClient ? `${clientNumber ?? ''}${clientName ? ` — ${clientName}` : ''}` : `${projectCode}${projectName ? ` — ${projectName}` : ''}`}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">INVOICE CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

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

        <DatePicker label={isClient ? 'REQUEST DATE' : 'HIRING DATE'} value={hiringDate} onChange={setHiringDate} />
        {!isClient && isValidDate(hiringDate) && <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />}

        {!isClient && (
          <div>
            <label className="block mb-2 text-lg font-bold">MILEAGE</label>
            <input type="text" value={mileage} onChange={(e) => setMileage(formatMileage(e.target.value))} className={inputClass} placeholder="0" />
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">SERVICE</label>
          <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={inputClass} placeholder="Service description" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">TARGET GRAND TOTAL</label>
          <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input type="text" inputMode="decimal" placeholder="0.00" value={targetGrandTotal} onChange={(e) => { if (isNumeric(e.target.value)) setTargetGrandTotal(e.target.value) }} className={`${inputClass} pl-10`} />
          </div>
        </div>

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
              <div className="w-24"><label className="block mb-1 text-sm text-gray-400">QTY</label>
                <input type="text" inputMode="decimal" placeholder="1" value={newExpense.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, quantity: e.target.value }) }} className={inputClass} />
              </div>
              <div className="w-32"><label className="block mb-1 text-sm text-gray-400">TAX</label>
                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.tax} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, tax: e.target.value }) }} className={`${inputClass} pl-10`} />
                </div>
              </div>
              <div className="w-36"><label className="block mb-1 text-sm text-gray-400">EXTRA COSTS</label>
                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.extra} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, extra: e.target.value }) }} className={`${inputClass} pl-10`} />
                </div>
              </div>
              {supplierIsVariable(newExpense.supplier) && (
                <div className="w-32"><label className="block mb-1 text-sm text-yellow-300">DISCOUNT</label>
                  <div className="relative">
                    <input type="text" inputMode="decimal" placeholder="0" value={newExpense.item_discount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, item_discount: e.target.value }) }} className={`${inputClass} pr-9`} />
                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                  </div>
                </div>
              )}
            </div>
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
                    // Extras (shipping, handling, insurance, tax, etc.) always render
                    // AFTER all parts, regardless of stored order. Stable sort keeps
                    // parts in their existing order and pushes extras to the bottom.
                    const orderedItems = [...groupItems].sort((a, b) =>
                      (SKIP_WORDS.test(a.expense.item) ? 1 : 0) - (SKIP_WORDS.test(b.expense.item) ? 1 : 0)
                    )
                    const firstItem = groupItems[0].expense
                    const groupTotal = groupItems.reduce((s, { expense: e }) => s + (parseFloat(e.amount) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0), 0)
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
                            {supplierIsVariable(firstItem.supplier) ? (
                              <p className="text-sm font-bold text-yellow-300 ml-6">★ Supplier discount: VARIABLE (per item)</p>
                            ) : supplierDiscount(firstItem.supplier) != null && (
                              <p className="text-sm font-bold text-yellow-300 ml-6">★ Supplier discount: {supplierDiscount(firstItem.supplier)}%</p>
                            )}
                          </div>
                          <div className="flex gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                            {receiptUrl && <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">RECEIPT</a>}
                            <button onClick={() => startEditPurchase(groupId, groupItems)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => setConfirmRemovePurchaseGroupId(groupId)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE PURCHASE</button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="border-t border-gray-700">
                            {orderedItems.map(({ index, expense: exp }, gi) => (
                              <div key={index} className={`px-4 py-2 pl-10 ${gi < orderedItems.length - 1 ? 'border-b border-gray-700' : ''}`}>
                                {editingGroupItemIndex === index ? (
                                  <div className="flex gap-2 items-center">
                                    <input type="text" value={editingGroupItem.description} onChange={(e) => setEditingGroupItem({ ...editingGroupItem, description: e.target.value })} className={`${smallInputClass} flex-1`} placeholder="Description" />
                                    <input type="text" inputMode="decimal" value={editingGroupItem.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, quantity: e.target.value }) }} className={`${smallInputClass} w-14 text-center`} placeholder="Qty" />
                                    <div className="relative w-24">
                                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                      <input type="text" inputMode="decimal" value={editingGroupItem.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-7`} placeholder="0.00" />
                                    </div>
                                    <div className="relative w-24">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">Tax$</span>
                                      <input type="text" inputMode="decimal" value={editingGroupItem.tax} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, tax: e.target.value }) }} className={`${smallInputClass} w-full pl-9`} placeholder="0.00" />
                                    </div>
                                    <div className="relative w-28">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">Extra$</span>
                                      <input type="text" inputMode="decimal" value={editingGroupItem.extra} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, extra: e.target.value }) }} className={`${smallInputClass} w-full pl-11`} placeholder="0.00" />
                                    </div>
                                    {supplierIsVariable(exp.supplier) && (
                                      <div className="relative w-20">
                                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-yellow-300 text-xs">Disc</span>
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">%</span>
                                        <input type="text" inputMode="decimal" value={editingGroupItem.item_discount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, item_discount: e.target.value }) }} className={`${smallInputClass} w-full pl-9 pr-5`} placeholder="0" />
                                      </div>
                                    )}
                                    <button onClick={saveEditGroupItem} className="bg-green-700 hover:bg-green-600 px-3 py-2 rounded-xl font-bold text-sm">SAVE</button>
                                    <button onClick={() => setEditingGroupItemIndex(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-2 rounded-xl font-bold text-sm">✕</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-bold truncate text-blue-300">{exp.item}</p>
                                      <p className="text-sm text-blue-300">Qty: {exp.quantity || '1'} × {formatUSD(parseFloat(exp.amount))} = {formatUSD((parseFloat(exp.amount) || 0) * (parseFloat(exp.quantity) || 1))}{(parseFloat(exp.tax) || 0) > 0 ? ` · Tax: ${formatUSD(parseFloat(exp.tax))}` : ''}{(parseFloat(exp.extra) || 0) > 0 ? ` · Extra Costs: ${formatUSD(parseFloat(exp.extra))}` : ''}{supplierIsVariable(exp.supplier) ? ` · Disc: ${parseFloat(exp.item_discount || '0') || 0}%` : ''}</p>
                                      {exportStatusLine(exp, index)}
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                      <button onClick={() => startEditGroupItem(index, exp)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                                      <button onClick={() => setSendToConfirm({ index, expense: exp, qtyToSend: '1' })} className="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded-xl font-bold text-sm">SEND TO</button>
                                      <button onClick={() => setConfirmRemoveExpenseIndex(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
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
                              <div className="w-24"><label className="block mb-1 text-sm text-gray-400">QTY</label>
                                <input type="text" inputMode="decimal" value={editingExpense.quantity} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, quantity: e.target.value }) }} className={inputClass} />
                              </div>
                              <div className="w-32"><label className="block mb-1 text-sm text-gray-400">TAX</label>
                                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                  <input type="text" inputMode="decimal" value={editingExpense.tax} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, tax: e.target.value }) }} className={`${inputClass} pl-10`} />
                                </div>
                              </div>
                              <div className="w-36"><label className="block mb-1 text-sm text-gray-400">EXTRA COSTS</label>
                                <div className="relative"><span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                                  <input type="text" inputMode="decimal" value={editingExpense.extra} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, extra: e.target.value }) }} className={`${inputClass} pl-10`} />
                                </div>
                              </div>
                              {supplierIsVariable(editingExpense.supplier) && (
                                <div className="w-32"><label className="block mb-1 text-sm text-yellow-300">DISCOUNT</label>
                                  <div className="relative">
                                    <input type="text" inputMode="decimal" value={editingExpense.item_discount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, item_discount: e.target.value }) }} className={`${inputClass} pr-9`} placeholder="0" />
                                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                                  </div>
                                </div>
                              )}
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
                                <p className={`text-sm ${rowColor}`}>Qty: {exp.quantity || '1'} × {formatUSD(parseFloat(exp.amount))} = {formatUSD((parseFloat(exp.amount) || 0) * (parseFloat(exp.quantity) || 1))}{(parseFloat(exp.tax) || 0) > 0 ? ` · Tax: ${formatUSD(parseFloat(exp.tax))}` : ''}{(parseFloat(exp.extra) || 0) > 0 ? ` · Extra Costs: ${formatUSD(parseFloat(exp.extra))}` : ''}</p>
                                <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                                {exportStatusLine(exp, index)}
                                {supplierIsVariable(exp.supplier)
                                  ? <p className="text-sm font-bold text-yellow-300">★ Supplier discount: VARIABLE — item {parseFloat(exp.item_discount || '0') || 0}%</p>
                                  : supplierDiscount(exp.supplier) != null && <p className="text-sm font-bold text-yellow-300">★ Supplier discount: {supplierDiscount(exp.supplier)}%</p>}
                                {exp.stock_source_type === 'DONATED' && exp.stock_donor && <p className="text-sm text-orange-400">From stock — DONATED by {exp.stock_donor}</p>}
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
                                <button onClick={() => setSendToConfirm({ index, expense: exp, qtyToSend: '1' })} className="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded-xl font-bold text-sm">SEND TO</button>
                                <button onClick={() => setConfirmRemoveExpenseIndex(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
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
          </div>
        </div>

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
            <div className="flex gap-3 items-center flex-wrap">
              <button onClick={addPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD PART</button>
              <button onClick={importIntuitiveParts} className="bg-purple-700 hover:bg-purple-600 px-5 py-3 rounded-2xl font-bold text-lg">⬆ IMPORT INTUITIVE PARTS</button>
              <div className="flex items-center gap-2">
                <span className="text-gray-400 font-bold text-sm">MARGIN</span>
                <div className="relative w-24">
                  <input type="text" inputMode="decimal" value={importMargin} onChange={(e) => { if (isNumeric(e.target.value)) setImportMargin(e.target.value) }} className={`${smallInputClass} w-full pr-7`} placeholder="0" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                </div>
              </div>
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
                          <p className="text-base font-bold truncate">{serviceDisplayName(svc.description)}</p>
                          <p className="text-sm text-gray-400">{!svc.price || parseFloat(svc.price) === 0 ? 'COURTESY' : formatUSD(parseFloat(svc.price))}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
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

        <div>
          <label className="block mb-3 text-lg font-bold">INCOME</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <label className="flex items-center justify-center gap-2 w-full bg-indigo-700 hover:bg-indigo-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
              🧾 SCAN INCOME
              <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanPayment(e.target.files[0]) }} />
            </label>
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newPayment.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewPayment({ ...newPayment, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-8`} />
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAYMENT METHOD</label>
                <select value={newPayment.source} onChange={(e) => setNewPayment({ ...newPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                  {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAID TO</label>
                <select value={newPayment.paid_to} onChange={(e) => setNewPayment({ ...newPayment, paid_to: e.target.value })} className={`${selectClass} w-full`}>
                  {paidToOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <DatePicker label="DATE" value={newPayment.payment_date} onChange={(v) => setNewPayment({ ...newPayment, payment_date: v })} />
            <div>
              <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
              <input type="text" value={newPayment.description} onChange={(e) => setNewPayment({ ...newPayment, description: e.target.value })} className={inputClass} placeholder="Optional note" />
            </div>
            <button onClick={addPayment} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD INCOME</button>
            {payments.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {payments.map((payment, index) => {
                  const status = paymentStatus(payment)
                  const statusColor = status === 'PAID' ? 'text-green-400' : status === 'DELAYED' ? 'text-red-400' : 'text-yellow-400'
                  const isPaid = status === 'PAID'
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
                          </div>
                          <div className="flex gap-3">
                            <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAYMENT METHOD</label>
                              <select value={editingPayment.source} onChange={(e) => setEditingPayment({ ...editingPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                                {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                            <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAID TO</label>
                              <select value={editingPayment.paid_to} onChange={(e) => setEditingPayment({ ...editingPayment, paid_to: e.target.value })} className={`${selectClass} w-full`}>
                                {paidToOptions.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                          </div>
                          <DatePicker label="DATE" value={editingPayment.payment_date} onChange={(v) => setEditingPayment({ ...editingPayment, payment_date: v })} />
                          <div>
                            <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
                            <input type="text" value={editingPayment.description} onChange={(e) => setEditingPayment({ ...editingPayment, description: e.target.value })} className={`${smallInputClass} w-full`} placeholder="Optional note" />
                          </div>
                          <div className="flex gap-3">
                            <button onClick={saveEditPayment} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                            <button onClick={cancelEditPayment} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                          </div>
                        </div>
                      ) : (
                        <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < payments.length - 1 ? 'border-b border-gray-700' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <p className={`text-base font-bold ${statusColor}`}>{formatUSD(parseFloat(payment.amount))} — {status}</p>
                            <p className="text-sm text-gray-400">{payment.source}{payment.payment_date ? ` — ${formatDate(payment.payment_date)}` : ''}</p>
                            {isPaid && <p className="text-sm text-green-400">Paid: {formatTsDate(payment.paid_at)}</p>}
                            {payment.description && <p className="text-sm text-gray-500 truncate">{payment.description}</p>}
                          </div>
                          <div className="flex gap-2 shrink-0">
                            {payment.receipt_url && <a href={payment.receipt_url} target="_blank" rel="noopener noreferrer" className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">DOC</a>}
                            <button
                              onClick={() => togglePaid(index)}
                              className={`px-3 py-1 rounded-xl font-bold text-sm whitespace-nowrap ${isPaid ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-600 hover:bg-gray-500'}`}
                            >
                              {isPaid ? 'PAID' : 'UNPAID'}
                            </button>
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

        {!isClient && isValidDate(entryDate) && <DatePicker label="CONCLUSION DATE" value={conclusionDate} onChange={setConclusionDate} />}
        {!isClient && <DatePicker label="DELIVERY DATE" value={deliveryDate} onChange={setDeliveryDate} />}

        {!isClient && (
        <div>
          <label className="block mb-3 text-lg font-bold">PARTS TO STOCK</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <p className="text-sm text-gray-400">Parts removed from this car that go into our stock inventory as DONATED.</p>
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
        )}

      </div>

      {/* Fixed action bar — keeps SAVE CHANGES reachable without scrolling the
          whole invoice. z-40 is below the modal layer (z-50) so dialogs cover
          it when open. The page itself uses pb-32 so the last visible section
          doesn't slip under this bar. */}
      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-4">
          <div className="shrink-0 text-xs leading-tight">
            <div className="flex justify-between gap-3"><span className="text-gray-400 font-bold">CURRENT CASH FLOW</span><span className={`font-bold ${profitColor(currentProfit)}`}>{formatUSD(currentProfit)} / {currentProfitPct.toFixed(1)}%</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-400 font-bold">FINAL PROFIT RESULT</span><span className={`font-bold ${profitColor(finalProfit)}`}>{formatUSD(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
          </div>
          <a href={basePath} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={saveInvoice} className="flex-1 bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        </div>
      </div>
    </main>
  )
}
