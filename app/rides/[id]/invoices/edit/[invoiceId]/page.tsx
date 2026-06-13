'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH, PAID_VIA_OPTIONS, pad3, CODE_PREFIX } from '@/lib/utils'
import { enrollParts } from '@/lib/partsDb'

type Part = { id?: string; description: string; unit_price: string; quantity: string; base_cost?: string; payment_date?: string | null }
type Service = { id?: string; description: string; price: string }
// paid_at: ISO timestamp string when the user explicitly clicked PAID. Empty = UNPAID.
type Payment = { id?: string; amount: string; amount_brl?: string; payment_date: string; source: string; paid_to: string; receipt_url: string; description: string; paid_at: string }
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
  part_number?: string
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
type ScannedPayment = { amount: string; amount_brl?: string; source: string; paid_to: string; date: string; receipt_url: string; description: string }
type IncomeReport = { amount: string; source: string; date: string; receipt_url: string; description: string; report: boolean }
type ExpenseReportItem = { item: string; amount: string; quantity: string; tax: string; extra: string }
type ExpenseReport = { supplier: string; date: string; receipt_url: string; items: ExpenseReportItem[]; report: boolean }
type DuplicateInfo = { title: string; details: string; proceed: () => void }

const paymentSources = ['', ...PAID_VIA_OPTIONS]
const FULL_PROJECT_LABOR = 'Full Project Labor'
const SKIP_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
// Like isNumeric but allows a leading minus, for expense amounts (credits/refunds).
function isSignedNumeric(v: string) { return v === '' || v === '-' || /^-?\d*\.?\d*$/.test(v) }
// Implied exchange-rate label "R$ x.xx / US$" once both USD and BRL are entered.
function brlRate(usd: string, brl: string): string {
  const u = parseFloat(usd) || 0
  const b = parseFloat(brl) || 0
  if (u <= 0 || b <= 0) return ''
  return `R$ ${(b / u).toFixed(2)} / US$`
}
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
  // is_quote is the stored quote/invoice flag. A quote flips to an invoice on
  // SAVE once a valid HIRING DATE is present (handled in saveInvoice).
  const [isQuote, setIsQuote] = useState(false)
  const [hiringDate, setHiringDate] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [conclusionDate, setConclusionDate] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [mileage, setMileage] = useState('')
  const [service, setService] = useState('')
  const [feedStatus, setFeedStatus] = useState('INCOMPLETE')
  const [liveStatus, setLiveStatus] = useState('INCOMPLETE')
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
  const [newPayment, setNewPayment] = useState<Payment>({ amount: '', amount_brl: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  const [editingPaymentIndex, setEditingPaymentIndex] = useState<number | null>(null)
  const [editingPayment, setEditingPayment] = useState<Payment>({ amount: '', amount_brl: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
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
  const [suppliers, setSuppliers] = useState<{ name: string; discount: number; discount_type: string; aliases: string }[]>([])
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
  const [scannedPurchase, setScannedPurchase] = useState<{ supplier: string; date: string; items: { description: string; part_number?: string; amount: string; quantity: string; tax: string; extra: string; item_discount: string }[]; receiptUrl: string } | null>(null)
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
  // REMOVE only stages a deletion: the row's id is parked here and the actual DB
  // delete happens in saveInvoice (SAVE CHANGES). CANCEL never persists, so a
  // removed line reappears exactly as it was — matching the editor's intent that
  // nothing is written until SAVE.
  const [removedPartIds, setRemovedPartIds] = useState<string[]>([])
  const [removedServiceIds, setRemovedServiceIds] = useState<string[]>([])
  const [removedPaymentIds, setRemovedPaymentIds] = useState<string[]>([])
  const [removedNoteIds, setRemovedNoteIds] = useState<string[]>([])
  const [removedExpenseIds, setRemovedExpenseIds] = useState<string[]>([])
  const [newPartToStock, setNewPartToStock] = useState<PartsToStock>({ description: '', quantity: '1', unit_price: '', date: todayStr() })
  const [savedPartsToStock, setSavedPartsToStock] = useState<PartsToStock[]>([])
  const [flTaxExpenseDate, setFlTaxExpenseDate] = useState('')
  const [incomeReports, setIncomeReports] = useState<IncomeReport[] | null>(null)
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  // packPrompt: after a successful save, asks whether to snapshot this invoice's
  // content as a reusable pack for the car. proceed() resumes the normal post-save
  // flow. rideMatch carries the car spec (manufacturer+model+year) used to scope packs.
  const [packPrompt, setPackPrompt] = useState<{ mode: 'create' | 'update'; packId?: string; proceed: () => void } | null>(null)
  const [rideMatch, setRideMatch] = useState<{ manufacturer: string; model: string; year: string }>({ manufacturer: '', model: '', year: '' })
  // Parts data bank: alias map (item -> alias) for IMPORT INTUITIVE PARTS, and
  // the IMPORT FROM DATABASE picker modal.
  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map())
  const [showDbModal, setShowDbModal] = useState(false)
  const [dbItems, setDbItems] = useState<any[]>([])
  const [dbSearch, setDbSearch] = useState('')
  const rideNameRef = useRef('')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    if (isClient) {
      const { data: clientData } = await supabase.from('clients').select('name, client_number').eq('id', ownerId).single()
      setClientName(clientData?.name || '')
      setClientNumber(clientData?.client_number ?? null)
    } else {
      const { data: rideData } = await supabase.from('rides').select('project_code, project_name, manufacturer, model, year').eq('id', ownerId).single()
      const pCode = rideData?.project_code || ''
      const pName = rideData?.project_name || ''
      setProjectCode(pCode)
      setProjectName(pName)
      setRideMatch({ manufacturer: rideData?.manufacturer || '', model: rideData?.model || '', year: rideData?.year != null ? String(rideData.year) : '' })
      rideNameRef.current = pCode + (pName ? ` — ${pName}` : '')
    }

    const { data, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).single()
    if (error || !data) { alert('Invoice not found'); router.push(basePath); return }
    setInvoiceCode(data.invoice_code || '')
    setIsQuote(!!data.is_quote)
    setHiringDate(data.hiring_date || '')
    setEntryDate(data.entry_date || '')
    setConclusionDate(data.conclusion_date || '')
    setDeliveryDate(data.delivery_date || '')
    setMileage(data.mileage ? Number(data.mileage).toLocaleString('en-US') : '')
    setService(data.service || '')
    setFeedStatus(data.feed_status === 'REAL_TIME' ? 'REAL_TIME' : 'INCOMPLETE')
    setLiveStatus(data.live_status === 'REALTIME' ? 'REALTIME' : 'INCOMPLETE')
    setFloridaTaxes(data.florida_taxes != null ? String(data.florida_taxes) : '6.5')
    setGlobalDiscount(data.global_discount ? String(data.global_discount) : '')
    setTargetGrandTotal(data.target_grand_total ? String(data.target_grand_total) : '')
    setImportMargin(data.import_margin ? String(data.import_margin) : '')
    setFlTaxExpenseDate(data.fl_tax_expense_date || '')

    const { data: partsData } = await supabase.from('invoice_parts').select('*').eq('invoice_id', invoiceId).order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
    if (partsData) setParts(partsData.map(p => ({ id: p.id, description: p.description, unit_price: String(p.unit_price), quantity: String(p.quantity), base_cost: p.base_cost != null ? String(p.base_cost) : undefined, payment_date: p.payment_date ?? null })))

    const { data: servicesData } = await supabase.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (servicesData) setServices(servicesData.map(s => ({ id: s.id, description: s.description, price: String(s.price) })))

    const { data: paymentsData } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (paymentsData) setPayments(sortByDateAsc(paymentsData.map(p => ({
      id: p.id,
      amount: String(p.amount),
      payment_date: p.payment_date || '',
      source: (p.source === 'GZ28BR' || p.paid_to === 'GZ28BR') ? 'GZ28BR' : (p.source || ''),
      paid_to: p.paid_to || 'GZ28US',
      amount_brl: p.amount_brl != null ? String(p.amount_brl) : '',
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
        part_number: e.part_number || '',
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

    const { data: suppliersData } = await supabase.from('suppliers').select('name, discount, discount_type, aliases')
    if (suppliersData) setSuppliers(suppliersData.map((s: any) => ({ name: s.name || '', discount: Number(s.discount) || 0, discount_type: s.discount_type === 'VARIABLE' ? 'VARIABLE' : 'FIXED', aliases: s.aliases || '' })))

    const iCode = data.invoice_code || ''
    const rName = isClient ? iCode : rideNameRef.current
    const prefix = `From ${iCode} — ${rName}`
    const { data: stockHistory } = await supabase.from('inventory').select('*').eq('supplier', rName).eq('category', 'STOCK').ilike('notes', `${prefix}%`)
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

    // Aliases from the parts data bank, applied as part descriptions when
    // IMPORT INTUITIVE PARTS runs.
    const { data: dbParts } = await supabase.from('parts_database').select('item, alias')
    const am = new Map<string, string>()
    for (const d of dbParts || []) { if (d.alias) am.set((d.item || '').trim().toLowerCase(), d.alias) }
    setAliasMap(am)

    setLoading(false)
  }

  async function openDbModal() {
    const { data } = await supabase.from('parts_database').select('*').order('created_at', { ascending: false, nullsFirst: false })
    setDbItems(data || [])
    setDbSearch('')
    setShowDbModal(true)
  }

  // Insert a parts-database item as a fresh, unpaid expense on this invoice.
  function addDbItem(it: any) {
    setExpenses(prev => [...prev, {
      supplier: it.supplier || '',
      item: it.item,
      part_number: it.part_number || '',
      amount: String(it.unit_price ?? 0),
      tax: String(it.tax ?? 0),
      extra: String(it.extra ?? 0),
      quantity: String(it.quantity ?? 1),
      payment_date: '',
      receipt_urls: [],
      export_status: 'FRESH',
      item_discount: String(it.item_discount ?? 0),
    }])
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
      .from('inventory')
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
    const { data: inputData } = await supabase.from('inventory').select('notes').eq('id', item.id).single()
    const existingNote = inputData?.notes || ''
    const usageNote = `Used ${qty} in ${rideName || ownerLabel()}`
    const updatedNotes = existingNote ? `${existingNote}\n${usageNote}` : usageNote
    await supabase.from('inventory').update({ quantity: item.quantity - qty, notes: updatedNotes, updated_at: new Date().toISOString() }).eq('id', item.id)
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
      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
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
      const items = (parsed.items || []).map((i: any) => ({ description: String(i.description || ''), part_number: String(i.part_number || ''), amount: String(i.amount || '0'), quantity: String(i.quantity || '1'), tax: String(i.tax || '0'), extra: String(i.extra || '0'), item_discount: String(i.item_discount || '0') }))
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
      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
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
      return { amount: p.amount, amount_brl: p.amount_brl || '', payment_date: p.date, source: p.source, paid_to: p.paid_to || 'GZ28US', receipt_url: p.receipt_url || '', description: p.description || '', paid_at: paidAt }
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
      part_number: item.part_number || '',
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
    // Override: an official purchase replaces the matching quote estimate. Match
    // by part number (or item name when a line has no PN); drop those lines — and
    // delete already-saved ones from the DB — before adding the official items.
    const norm = (s: string | undefined | null) => (s || '').trim().toLowerCase()
    const scannedPNs = new Set(scannedPurchase.items.map(i => norm(i.part_number)).filter(Boolean))
    const scannedNames = new Set(scannedPurchase.items.map(i => norm(i.description)).filter(Boolean))
    const replaced = expenses.filter(e => {
      const epn = norm(e.part_number)
      return epn ? scannedPNs.has(epn) : scannedNames.has(norm(e.item))
    })
    for (const e of replaced) { if (e.id) supabase.from('invoice_expenses').delete().eq('id', e.id) }
    setExpenses(prev => [...prev.filter(e => !replaced.includes(e)), ...newItems])
    setExpandedGroups(prev => new Set([...prev, groupId]))
    // Enroll the scanned items into the parts data bank (last purchase for parts,
    // cheapest for extras).
    void enrollParts(scannedPurchase.items.map(it => ({
      item: it.description,
      part_number: it.part_number,
      supplier: scannedPurchase.supplier,
      unit_price: it.amount,
      tax: it.tax,
      extra: it.extra,
      quantity: it.quantity,
      item_discount: it.item_discount,
      purchase_date: /^\d{4}-\d{2}-\d{2}$/.test(scannedPurchase.date) ? scannedPurchase.date : null,
    })))
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

  function removePurchaseGroup(groupItems: { index: number; expense: Expense }[]) {
    const indicesToRemove = new Set(groupItems.map(({ index }) => index))
    const ids = groupItems.map(({ expense }) => expense.id).filter((id): id is string => !!id)
    if (ids.length) setRemovedExpenseIds(prev => [...prev, ...ids])
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
      const { error } = await supabase.from('inventory').insert([{
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
        description: aliasMap.get(src.description.trim().toLowerCase()) || src.description,
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
    // Normalize away case, spaces and punctuation; match against the supplier's
    // name AND its aliases (one per line / comma) so variant spellings and
    // acronyms (e.g. "HHP Racing" vs "HighHorsePerformance Racing") unify.
    const norm = (s: string | undefined | null) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const target = norm(name)
    if (!target) return null
    const m = suppliers.find(s => {
      const variants = [s.name, ...(s.aliases || '').split(/[\n,]/)]
      return variants.some(v => norm(v) === target)
    })
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
  // The parts-database alias (if any) for an expense item, shown next to its name.
  function aliasFor(item: string): string { return aliasMap.get((item || '').trim().toLowerCase()) || '' }

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
  // Owed amount NOT covered by any listed payment (paid or pending): all listed
  // payments minus the grand total. Negative = still owed once pending clears.
  const pendingBalance = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) - grandTotal
  // ONLINE is allowed only when there's no PENDING BALANCE still owed (>= 0).
  // While a pending balance is owed (negative), the invoice is locked OFFLINE.
  const noPendingBalance = pendingBalance >= 0
  // REPORT READY (ON) also requires every income (payment) to carry a date.
  const allIncomesDated = payments.every(p => isValidDate(p.payment_date))
  const canBeOnline = noPendingBalance && allIncomesDated
  // CLOSED forces REPORT READY ON; otherwise it's the manual feed toggle, gated.
  const feedOnline = liveStatus === 'CLOSED' ? true : (feedStatus === 'REAL_TIME' && canBeOnline)
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
    if (!newPart.description || !newPart.unit_price || !newPart.quantity) { alert('Please fill in all item fields'); return }
    setParts([...parts, newPart]); setNewPart({ description: '', unit_price: '', quantity: '1' })
  }
  // Reorder a PARTS row up (-1) or down (+1). Local only; the new order is
  // persisted (position column) on SAVE CHANGES. Editing is cancelled to avoid
  // an index mismatch with the edit form.
  function movePart(index: number, dir: -1 | 1) {
    const j = index + dir
    if (j < 0 || j >= parts.length) return
    const next = [...parts]
    const tmp = next[index]; next[index] = next[j]; next[j] = tmp
    setParts(next)
    if (editingPartIndex !== null) setEditingPartIndex(null)
  }
  function removePart(index: number) {
    const part = parts[index]
    if (part.id) setRemovedPartIds(prev => [...prev, part.id!])
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
    if (!editingPart.description || !editingPart.unit_price || !editingPart.quantity) { alert('Please fill in all item fields'); return }
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
  // Toggle a part's PAID status (payment_date = today / cleared). Persists immediately for saved parts.
  async function togglePartPaid(index: number) {
    const p = parts[index]
    const next = isValidDate(p.payment_date || '') ? null : todayStr()
    if (p.id) {
      const { error } = await supabase.from('invoice_parts').update({ payment_date: next }).eq('id', p.id)
      if (error) { alert(error.message); return }
    }
    setParts(prev => prev.map((x, i) => i === index ? { ...x, payment_date: next } : x))
  }

  function addService() {
    if (!newService.description) { alert('Please enter a description'); return }
    setServices([...services, newService]); setNewService({ description: '', price: '' })
  }
  function removeService(index: number) {
    const svc = services[index]
    if (svc.id) setRemovedServiceIds(prev => [...prev, svc.id!])
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
    setPayments(sortByDateAsc([...payments, newPayment], p => p.payment_date)); setNewPayment({ amount: '', amount_brl: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  }
  function removePayment(index: number) {
    const payment = payments[index]
    if (payment.id) setRemovedPaymentIds(prev => [...prev, payment.id!])
    setPayments(payments.filter((_, i) => i !== index))
  }
  function startEditPayment(index: number) { setEditingPaymentIndex(index); setEditingPayment({ ...payments[index] }) }
  async function saveEditPayment() {
    if (!editingPayment.amount) { alert('Please enter an amount'); return }
    const payment = payments[editingPaymentIndex!]
    if (payment.id) {
      const { error } = await supabase.from('invoice_payments').update({ amount: parseFloat(editingPayment.amount), payment_date: isValidDate(editingPayment.payment_date) ? editingPayment.payment_date : null, source: editingPayment.source || null, paid_to: editingPayment.source === 'GZ28BR' ? 'GZ28BR' : 'GZ28US', amount_brl: editingPayment.source === 'GZ28BR' ? (parseFloat(editingPayment.amount_brl || '') || null) : null, description: editingPayment.description || null }).eq('id', payment.id)
      if (error) { alert(error.message); return }
    }
    const updated = [...payments]; updated[editingPaymentIndex!] = { ...editingPayment, id: payment.id }; setPayments(sortByDateAsc(updated, p => p.payment_date))
    setEditingPaymentIndex(null); setEditingPayment({ amount: '', amount_brl: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' })
  }
  function cancelEditPayment() { setEditingPaymentIndex(null); setEditingPayment({ amount: '', amount_brl: '', payment_date: '', source: '', paid_to: 'GZ28US', receipt_url: '', description: '', paid_at: '' }) }

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
  function removeNote(index: number) {
    const n = notes[index]
    if (n.id) setRemovedNoteIds(prev => [...prev, n.id!])
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
  function removeExpense(index: number) {
    const exp = expenses[index]
    if (exp.id) setRemovedExpenseIds(prev => [...prev, exp.id!])
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

  // Before a quote converts to an invoice, archive its full content exactly as
  // currently stored (invoice row + line items, payments, notes) into
  // quote_backups so the original quote is never lost. Reads from the DB, so the
  // snapshot is the pristine pre-conversion quote — this save's edits (including
  // the HIRING DATE that triggers the conversion) haven't been written yet.
  async function backupQuoteBeforeConversion() {
    const [invRes, partsRes, servicesRes, paymentsRes, notesRes, expensesRes] = await Promise.all([
      supabase.from('invoices').select('*').eq('id', invoiceId).single(),
      supabase.from('invoice_parts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
      supabase.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
      supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
      supabase.from('invoice_notes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
      supabase.from('invoice_expenses').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true }),
    ])
    const snapshot = {
      invoice: invRes.data || null,
      parts: partsRes.data || [],
      services: servicesRes.data || [],
      payments: paymentsRes.data || [],
      notes: notesRes.data || [],
      expenses: expensesRes.data || [],
    }
    const { error } = await supabase.from('quote_backups').insert([{
      invoice_id: invoiceId,
      invoice_code: invoiceCode,
      snapshot,
    }])
    if (error) alert('Note: the quote backup could not be saved (' + error.message + '). The invoice was still saved.')
  }

  // On quote -> invoice approval, migrate the still-quote ride & client to PROJECT:
  // flip their is_quote, assign FRESH project numbers, and re-code every invoice on
  // the ride to the new ride code. Entities already on the project side are untouched.
  async function migrateQuoteToProject() {
    if (isClient) {
      const { data: c } = await supabase.from('clients').select('client_number, is_quote').eq('id', ownerId).single()
      if (c?.is_quote) {
        const { data: mx } = await supabase.from('clients').select('client_number').eq('is_quote', false).order('client_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
        const newNum = (mx?.client_number ?? 0) + 1
        const oldPad = pad3(c.client_number ?? 0)
        const newPad = pad3(newNum)
        await supabase.from('clients').update({ client_number: newNum, is_quote: false }).eq('id', ownerId)
        // re-code this client's shopping invoices ("<oldnum>.<n>" -> "<newnum>.<n>")
        const { data: cinvs } = await supabase.from('invoices').select('id, invoice_code').eq('client_id', ownerId).is('ride_id', null)
        for (const inv of (cinvs || [])) {
          if (inv.invoice_code?.startsWith(oldPad + '.')) {
            await supabase.from('invoices').update({ invoice_code: newPad + inv.invoice_code.slice(oldPad.length) }).eq('id', inv.id)
          }
        }
      }
      return
    }
    const { data: ride } = await supabase.from('rides').select('id, project_code, is_quote, client_id').eq('id', ownerId).single()
    if (!ride?.is_quote) return
    const { data: pr } = await supabase.from('rides').select('project_code').eq('is_quote', false).not('project_code', 'is', null)
    let maxN = 0
    for (const r of (pr || [])) { const m = r.project_code?.match(/\.(\d+)$/); if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n } }
    const newRideCode = `${CODE_PREFIX}.${pad3(maxN + 1)}`
    const oldRideCode = ride.project_code || ''
    await supabase.from('rides').update({ project_code: newRideCode, is_quote: false }).eq('id', ride.id)
    // Cascade: re-code every invoice on this ride from the old ride code to the new one.
    const { data: invs } = await supabase.from('invoices').select('id, invoice_code').eq('ride_id', ride.id)
    for (const inv of (invs || [])) {
      if (oldRideCode && inv.invoice_code?.startsWith(oldRideCode + '.')) {
        await supabase.from('invoices').update({ invoice_code: newRideCode + inv.invoice_code.slice(oldRideCode.length) }).eq('id', inv.id)
      }
    }
    // Migrate the ride's client too, if it was still a quote client.
    if (ride.client_id) {
      const { data: c } = await supabase.from('clients').select('is_quote').eq('id', ride.client_id).single()
      if (c?.is_quote) {
        const { data: mx } = await supabase.from('clients').select('client_number').eq('is_quote', false).order('client_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
        await supabase.from('clients').update({ client_number: (mx?.client_number ?? 0) + 1, is_quote: false }).eq('id', ride.client_id)
      }
    }
  }

  async function saveInvoice() {
    // Quote -> invoice transition: a quote with a valid HIRING DATE becomes an
    // invoice (one-way; an invoice never reverts to a quote).
    const nextIsQuote = isQuote && !isValidDate(hiringDate)
    // On that transition, archive the quote, then migrate its quote ride/client to project.
    if (isQuote && !nextIsQuote) { await backupQuoteBeforeConversion(); await migrateQuoteToProject() }
    const { error } = await supabase.from('invoices').update({
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      conclusion_date: isValidDate(conclusionDate) ? conclusionDate : null,
      delivery_date: isValidDate(deliveryDate) ? deliveryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
      feed_status: feedOnline ? 'REAL_TIME' : 'INCOMPLETE',
      live_status: liveStatus,
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
      target_grand_total: targetGrandTotal ? parseFloat(targetGrandTotal.replace(/,/g, '')) : null,
      import_margin: parseFloat(importMargin) || 0,
      fl_tax_expense_date: isValidDate(flTaxExpenseDate) ? flTaxExpenseDate : null,
      is_quote: nextIsQuote,
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    if (error) { alert(error.message); return }
    setIsQuote(nextIsQuote)

    // Persist parts in their current order: insert new ones with their position,
    // and for existing ones write position (always) plus refreshed margin-managed
    // unit_price/base_cost (which may have shifted with the live IMPORT MARGIN).
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (!p.id) {
        const { error: e } = await supabase.from('invoice_parts').insert({
          invoice_id: invoiceId,
          description: p.description,
          unit_price: parseFloat(p.unit_price) || 0,
          quantity: parseFloat(p.quantity) || 0,
          base_cost: (p.base_cost != null && p.base_cost !== '') ? parseFloat(p.base_cost) : null,
          payment_date: isValidDate(p.payment_date || '') ? p.payment_date : null,
          position: i,
        })
        if (e) { alert(e.message); return }
      } else {
        const upd: any = { position: i, payment_date: isValidDate(p.payment_date || '') ? p.payment_date : null }
        if (p.base_cost != null && p.base_cost !== '') {
          upd.unit_price = parseFloat(p.unit_price) || 0
          upd.base_cost = parseFloat(p.base_cost) || 0
        }
        const { error: e } = await supabase.from('invoice_parts').update(upd).eq('id', p.id)
        if (e) { alert(e.message); return }
      }
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
        paid_to: p.source === 'GZ28BR' ? 'GZ28BR' : 'GZ28US',
        amount_brl: p.source === 'GZ28BR' ? (parseFloat(p.amount_brl || '') || null) : null,
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
        part_number: ex.part_number || null,
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
    await supabase.from('inventory').delete().eq('supplier', rideName).eq('category', 'STOCK').ilike('notes', `${prefix}%`)
    if (partsToStock.length > 0) {
      const { error: e } = await supabase.from('inventory').insert(partsToStock.map(p => ({
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

    // Commit staged REMOVEs now (not at click time) so CANCEL leaves them intact.
    for (const id of removedPartIds) await supabase.from('invoice_parts').delete().eq('id', id)
    for (const id of removedServiceIds) await supabase.from('invoice_services').delete().eq('id', id)
    for (const id of removedPaymentIds) await supabase.from('invoice_payments').delete().eq('id', id)
    for (const id of removedNoteIds) await supabase.from('invoice_notes').delete().eq('id', id)
    for (const id of removedExpenseIds) await supabase.from('invoice_expenses').delete().eq('id', id)
    setRemovedPartIds([]); setRemovedServiceIds([]); setRemovedPaymentIds([]); setRemovedNoteIds([]); setRemovedExpenseIds([])

    await maybePromptPackThenFinish(newPayments, newExpenses, nextIsQuote)
  }

  // After a successful save, offer to snapshot this ride invoice's content as a
  // reusable pack for the car's spec (manufacturer + model + year) when its
  // SERVICE name isn't already a saved pack. The normal post-save flow (income /
  // expense report prompts, then redirect) runs afterward via `proceed`.
  async function maybePromptPackThenFinish(newPayments: Payment[], newExpenses: Expense[], stillQuote: boolean) {
    const proceed = () => finishSave(newPayments, newExpenses, stillQuote)
    const name = service.trim()
    const hasContent = parts.length > 0 || services.length > 0 || expenses.length > 0 || notes.length > 0 || !!targetGrandTotal
    if (!isClient && name && hasContent) {
      const existing = await findPackForCar(name)
      if (!existing) { setPackPrompt({ mode: 'create', proceed }); return }
      // Pack (matrix) exists: if the considered data changed, offer to update it.
      if (!sameAsPack(existing)) { setPackPrompt({ mode: 'update', packId: existing.id, proceed }); return }
    }
    proceed()
  }

  // The matching pack for the current car spec + service name, or null.
  async function findPackForCar(name: string): Promise<any | null> {
    const { data } = await supabase.from('packs').select('*')
    const norm = (s: any) => String(s ?? '').trim().toLowerCase()
    return (data || []).find((p: any) =>
      norm(p.manufacturer) === norm(rideMatch.manufacturer) &&
      norm(p.model) === norm(rideMatch.model) &&
      norm(p.year) === norm(rideMatch.year) &&
      norm(p.name) === norm(name)) || null
  }

  // The pack-relevant content of the current invoice (no dates / payments). Used
  // both to write a pack and to detect changes against an existing one.
  function currentPackContent() {
    return {
      target_grand_total: targetGrandTotal ? parseFloat(targetGrandTotal.replace(/,/g, '')) : null,
      florida_taxes: floridaTaxes ? parseFloat(floridaTaxes) : null,
      global_discount: globalDiscount ? parseFloat(globalDiscount) : null,
      import_margin: parseFloat(importMargin) || 0,
      parts: parts.map(p => ({ description: p.description, unit_price: parseFloat(p.unit_price) || 0, quantity: parseFloat(p.quantity) || 0, base_cost: (p.base_cost != null && p.base_cost !== '') ? parseFloat(p.base_cost) : null })),
      services: services.map(s => ({ description: s.description, price: parseFloat(s.price) || 0 })),
      expenses: expenses.map(e => ({ supplier: e.supplier || '', item: e.item, amount: parseFloat(e.amount) || 0, tax: parseFloat(e.tax) || 0, extra: parseFloat(e.extra) || 0, quantity: parseFloat(e.quantity) || 1, item_discount: parseFloat(e.item_discount || '0') || 0 })),
      notes: notes.map(n => ({ note: n.note })),
    }
  }

  // The same shape rebuilt from a stored pack row, so the two can be compared.
  function packRowContent(pk: any) {
    return {
      target_grand_total: pk.target_grand_total ?? null,
      florida_taxes: pk.florida_taxes ?? null,
      global_discount: pk.global_discount ?? null,
      import_margin: pk.import_margin ?? 0,
      parts: (pk.parts || []).map((p: any) => ({ description: p.description, unit_price: Number(p.unit_price) || 0, quantity: Number(p.quantity) || 0, base_cost: (p.base_cost != null && p.base_cost !== '') ? Number(p.base_cost) : null })),
      services: (pk.services || []).map((s: any) => ({ description: s.description, price: Number(s.price) || 0 })),
      expenses: (pk.expenses || []).map((e: any) => ({ supplier: e.supplier || '', item: e.item, amount: Number(e.amount) || 0, tax: Number(e.tax) || 0, extra: Number(e.extra) || 0, quantity: Number(e.quantity) || 1, item_discount: Number(e.item_discount) || 0 })),
      notes: (pk.notes || []).map((n: any) => ({ note: n.note })),
    }
  }

  function sameAsPack(pk: any): boolean {
    return JSON.stringify(currentPackContent()) === JSON.stringify(packRowContent(pk))
  }

  // Insert the current invoice content as a new pack template.
  async function savePackFromCurrent() {
    const { error } = await supabase.from('packs').insert([{
      name: service.trim(),
      manufacturer: rideMatch.manufacturer || null,
      model: rideMatch.model || null,
      year: rideMatch.year || null,
      cars: [{ manufacturer: rideMatch.manufacturer || '', brand: '', model: rideMatch.model || '', version: '', years: rideMatch.year ? [Number(rideMatch.year)] : [] }],
      ...currentPackContent(),
    }])
    if (error) alert('Could not save pack: ' + error.message)
  }

  // Overwrite an existing pack (the "matrix") with the current content.
  async function updatePackContent(packId: string) {
    const { error } = await supabase.from('packs').update({
      ...currentPackContent(),
      updated_at: new Date().toISOString(),
    }).eq('id', packId)
    if (error) alert('Could not update pack: ' + error.message)
  }

  // Pack prompt YES/NO; either way continue the normal post-save flow.
  async function resolvePackPrompt(save: boolean) {
    const prompt = packPrompt
    setPackPrompt(null)
    if (save && prompt) {
      if (prompt.mode === 'update' && prompt.packId) await updatePackContent(prompt.packId)
      else await savePackFromCurrent()
    }
    prompt?.proceed()
  }

  function finishSave(newPayments: Payment[], newExpenses: Expense[], stillQuote: boolean) {
    // Quotes don't generate WhatsApp income/expense reports — just save & return.
    if (stillQuote) { router.push(basePath); return }
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
    return lines.join('\n') + '\n\nSent by GZ28 Control App'
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
    return lines.join('\n') + '\n\nSent by GZ28 Control App'
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
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
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
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
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
                      <label className="block mb-1 text-sm text-gray-400">PAID VIA</label>
                      <select value={p.source} onChange={(e) => { const a = [...scannedPayments]; a[i] = { ...a[i], source: e.target.value }; setScannedPayments(a) }} className={`${selectClass} w-full`}>
                        {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  {p.source === 'GZ28BR' && (
                    <div className="flex gap-3 items-end">
                      <div className="flex-1">
                        <label className="block mb-1 text-sm text-gray-400">AMOUNT (R$)</label>
                        <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">R$</span>
                          <input type="text" inputMode="decimal" placeholder="0.00" value={p.amount_brl || ''} onChange={(e) => { if (isNumeric(e.target.value)) { const a = [...scannedPayments]; a[i] = { ...a[i], amount_brl: e.target.value }; setScannedPayments(a) } }} className={`${smallInputClass} w-full pl-12`} />
                        </div>
                      </div>
                      <p className="text-sm text-gray-400 pb-3 whitespace-nowrap">{brlRate(p.amount, p.amount_brl || '')}</p>
                    </div>
                  )}
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

      {packPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-amber-600 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-2xl font-bold text-amber-400">{packPrompt.mode === 'update' ? 'UPDATE THE MATRIX?' : 'SAVE AS PACK?'}</h2>
            <p className="text-gray-300 text-base">
              {packPrompt.mode === 'update'
                ? <>The pack “{service.trim()}”{[rideMatch.manufacturer, rideMatch.model, rideMatch.year].filter(Boolean).length > 0 ? ` for ${[rideMatch.manufacturer, rideMatch.model, rideMatch.year].filter(Boolean).join(' ')}` : ''} already exists and the considered data changed. Update the matrix (PARTS, SERVICES, EXPENSES, NOTES and totals) with the current values? Other invoices keep their own data — only the pack template changes.</>
                : <>Save “{service.trim()}” as a reusable pack{[rideMatch.manufacturer, rideMatch.model, rideMatch.year].filter(Boolean).length > 0 ? ` for ${[rideMatch.manufacturer, rideMatch.model, rideMatch.year].filter(Boolean).join(' ')}` : ' for this car'}? Its PARTS, SERVICES, EXPENSES, NOTES and totals can then pre-fill future quotes/invoices for the same car.</>}
            </p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => resolvePackPrompt(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg">NO, JUST SAVE</button>
              <button onClick={() => resolvePackPrompt(true)} className="flex-1 bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold text-lg">{packPrompt.mode === 'update' ? 'YES, UPDATE MATRIX' : 'YES, SAVE PACK'}</button>
            </div>
          </div>
        </div>
      )}

      {showDbModal && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-teal-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-bold text-teal-300">IMPORT FROM DATABASE</h2>
              <button onClick={() => setShowDbModal(false)} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-2xl font-bold shrink-0">CLOSE</button>
            </div>
            <input value={dbSearch} onChange={(e) => setDbSearch(e.target.value)} placeholder="Search item or alias..." className={inputClass} />
            {(() => {
              const t = dbSearch.trim().toLowerCase()
              const list = t ? dbItems.filter((d: any) => (d.item || '').toLowerCase().includes(t) || (d.alias || '').toLowerCase().includes(t)) : dbItems
              if (list.length === 0) return <p className="text-gray-400">No items in the database.</p>
              return list.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between gap-4 border-b border-gray-800 py-2">
                  <div className="min-w-0">
                    <p className="font-bold truncate">{d.item}{d.is_extra ? ' — EXTRA' : ''}</p>
                    {d.alias && <p className="text-sm text-teal-300 truncate">alias: {d.alias}</p>}
                    <p className="text-sm text-gray-400">{formatUSD(Number(d.unit_price) || 0)}{d.supplier ? ` · ${d.supplier}` : ''}</p>
                  </div>
                  <button onClick={() => addDbItem(d)} className="bg-teal-700 hover:bg-teal-600 px-4 py-2 rounded-2xl font-bold text-sm shrink-0">ADD</button>
                </div>
              ))
            })()}
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

      <h1 className="text-4xl font-bold mb-2">EDIT {isQuote ? 'QUOTE' : 'INVOICE'}</h1>
      <p className="text-gray-400 text-xl mb-8">{isClient ? `${clientNumber ?? ''}${clientName ? ` — ${clientName}` : ''}` : `${projectCode}${projectName ? ` — ${projectName}` : ''}`}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">{isQuote ? 'QUOTE' : 'INVOICE'} CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-bold">REALTIME STATUS</p>
            <p className="text-sm text-gray-400">Cycle this {isQuote ? 'quote' : 'invoice'}: INCOMPLETE → REALTIME → CLOSED. CLOSED forces REPORT READY ON (needs no pending balance and every income dated).</p>
          </div>
          <button
            onClick={() => {
              if (liveStatus === 'INCOMPLETE') { setLiveStatus('REALTIME'); return }
              if (liveStatus === 'REALTIME') {
                if (!canBeOnline) { alert(noPendingBalance ? 'CLOSED requires every income to have a date.' : 'CLOSED requires no PENDING BALANCE owed. Settle it first.'); return }
                setLiveStatus('CLOSED'); setFeedStatus('REAL_TIME'); return
              }
              setLiveStatus('INCOMPLETE'); setFeedStatus('INCOMPLETE')
            }}
            className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap text-white ${liveStatus === 'CLOSED' ? 'bg-green-700 hover:bg-green-600' : liveStatus === 'REALTIME' ? 'bg-blue-700 hover:bg-blue-600' : 'bg-gray-600 hover:bg-gray-500'}`}
          >
            {liveStatus === 'CLOSED' ? 'CLOSED' : liveStatus === 'REALTIME' ? 'REALTIME' : 'INCOMPLETE'}
          </button>
        </div>

        {liveStatus === 'REALTIME' && (
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-lg font-bold">REPORT READY</p>
              <p className="text-sm text-gray-400">Turn ON once this {isQuote ? 'quote' : 'invoice'} is fully up to date.{!canBeOnline ? ` Locked OFF until ${!noPendingBalance ? 'the PENDING BALANCE is settled' : 'every income has a date'}.` : ''}</p>
            </div>
            <button
              onClick={() => {
                if (feedStatus === 'REAL_TIME') { setFeedStatus('INCOMPLETE'); return }
                if (!canBeOnline) { alert(noPendingBalance ? 'REPORT READY can be ON only when every income has a date.' : 'REPORT READY can be ON only when there is no PENDING BALANCE owed. Settle it first.'); return }
                setFeedStatus('REAL_TIME')
              }}
              className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap text-white ${feedOnline ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-600 hover:bg-gray-500'} ${!canBeOnline && !feedOnline ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              {feedOnline ? 'ON' : 'OFF'}
            </button>
          </div>
        )}

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
            <button onClick={openDbModal} className="flex items-center justify-center gap-2 w-full bg-teal-700 hover:bg-teal-600 px-5 py-3 rounded-2xl font-bold text-lg">📚 IMPORT FROM DATABASE</button>
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
                  <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.amount} onChange={(e) => { if (isSignedNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
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
                                      <input type="text" inputMode="decimal" value={editingGroupItem.amount} onChange={(e) => { if (isSignedNumeric(e.target.value)) setEditingGroupItem({ ...editingGroupItem, amount: e.target.value }) }} className={`${smallInputClass} w-full pl-7`} placeholder="0.00" />
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
                                      <p className="text-sm font-bold truncate text-blue-300">{exp.item}{aliasFor(exp.item) ? ` (${aliasFor(exp.item)})` : ''}</p>
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
                                  <input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(e) => { if (isSignedNumeric(e.target.value)) setEditingExpense({ ...editingExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
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
                                <p className={`text-base font-bold truncate ${rowColor}`}>{exp.item}{aliasFor(exp.item) ? ` (${aliasFor(exp.item)})` : ''}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
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
          <label className="block mb-3 text-lg font-bold">ITEMS</label>
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
              <button onClick={addPart} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD ITEM</button>
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
                          <p className={`text-base font-bold truncate ${isValidDate(part.payment_date || '') ? '' : 'text-yellow-400'}`}>{part.description}{isValidDate(part.payment_date || '') ? '' : ' — PENDING'}</p>
                          <p className="text-sm text-gray-400">{formatUSD(parseFloat(part.unit_price))} × {part.quantity} = {formatUSD(getPartTotal(part))}</p>
                          <p className="text-sm text-gray-500">{isValidDate(part.payment_date || '') ? `Paid: ${formatDate(part.payment_date || '')}` : 'Not paid yet'}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => togglePartPaid(index)} className={`${isValidDate(part.payment_date || '') ? 'bg-green-700 hover:bg-green-600' : 'bg-yellow-700 hover:bg-yellow-600'} px-3 py-1 rounded-xl font-bold text-sm`} title="Toggle paid">{isValidDate(part.payment_date || '') ? 'PAID' : 'PENDING'}</button>
                          <button onClick={() => movePart(index, -1)} disabled={index === 0} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1 rounded-xl font-bold text-sm" title="Move up">▲</button>
                          <button onClick={() => movePart(index, 1)} disabled={index === parts.length - 1} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed px-3 py-1 rounded-xl font-bold text-sm" title="Move down">▼</button>
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
              <span className="text-gray-400 font-bold">ITEMS SUB-TOTAL</span>
              <span className="text-xl font-bold">{formatUSD(partsSubTotal)}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-gray-400 font-bold whitespace-nowrap">FLORIDA TAXES</span>
              <div className="relative w-28">
                <input type="text" inputMode="decimal" value={floridaTaxes} onChange={(e) => { if (isNumeric(e.target.value)) setFloridaTaxes(e.target.value) }} className={`${smallInputClass} w-full pr-6`} placeholder="0.00" />
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
            <span className="text-gray-400 font-bold">ITEMS + SERVICES TOTAL</span>
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
              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAID VIA</label>
                <select value={newPayment.source} onChange={(e) => setNewPayment({ ...newPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                  {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            {newPayment.source === 'GZ28BR' && (
              <div className="flex gap-3 items-end">
                <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT (R$)</label>
                  <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">R$</span>
                    <input type="text" inputMode="decimal" placeholder="0.00" value={newPayment.amount_brl || ''} onChange={(e) => { if (isNumeric(e.target.value)) setNewPayment({ ...newPayment, amount_brl: e.target.value }) }} className={`${smallInputClass} w-full pl-12`} />
                  </div>
                </div>
                <p className="text-sm text-gray-400 pb-3 whitespace-nowrap">{brlRate(newPayment.amount, newPayment.amount_brl || '')}</p>
              </div>
            )}
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
                            <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">PAID VIA</label>
                              <select value={editingPayment.source} onChange={(e) => setEditingPayment({ ...editingPayment, source: e.target.value })} className={`${selectClass} w-full`}>
                                {paymentSources.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                          </div>
                          {editingPayment.source === 'GZ28BR' && (
                            <div className="flex gap-3 items-end">
                              <div className="flex-1"><label className="block mb-1 text-sm text-gray-400">AMOUNT (R$)</label>
                                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">R$</span>
                                  <input type="text" inputMode="decimal" placeholder="0.00" value={editingPayment.amount_brl || ''} onChange={(e) => { if (isNumeric(e.target.value)) setEditingPayment({ ...editingPayment, amount_brl: e.target.value }) }} className={`${smallInputClass} w-full pl-12`} />
                                </div>
                              </div>
                              <p className="text-sm text-gray-400 pb-3 whitespace-nowrap">{brlRate(editingPayment.amount, editingPayment.amount_brl || '')}</p>
                            </div>
                          )}
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
                            <p className="text-sm text-gray-400">{payment.source}{payment.source === 'GZ28BR' && payment.amount_brl ? ` · R$ ${(parseFloat(payment.amount_brl) || 0).toFixed(2)}` : ''}{payment.payment_date ? ` — ${formatDate(payment.payment_date)}` : ''}</p>
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
              <span className="text-gray-400 font-bold">PENDING BALANCE</span>
              <span className={`text-xl font-bold ${pendingBalance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(pendingBalance)}</span>
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
          <label className="block mb-3 text-lg font-bold">ITEMS TO INVENTORY</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <p className="text-sm text-gray-400">Items removed from this car that go into our inventory as DONATED.</p>
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
            <button onClick={addPartToStock} className="bg-orange-700 hover:bg-orange-600 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD TO INVENTORY</button>

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
                <p className="text-sm text-gray-500 mb-2">ALREADY IN INVENTORY FROM THIS {isQuote ? 'QUOTE' : 'INVOICE'}</p>
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
            <div className="flex justify-between gap-3"><span className="text-gray-400 font-bold">FINAL MARKUP</span><span className={`font-bold ${profitColor(finalProfit)}`}>{formatUSD(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
          </div>
          <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
          <button onClick={saveInvoice} className="flex-1 bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        </div>
      </div>
    </main>
  )
}
