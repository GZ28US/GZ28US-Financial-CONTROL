'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Part = {
  description: string
  unit_price: string
  quantity: string
}

type Service = {
  description: string
  price: string
}

type Payment = {
  amount: string
  payment_date: string
  source: string
}

type Note = {
  note: string
}

type Expense = {
  supplier: string
  item: string
  amount: string
  payment_date: string
}

const paymentSources = ['', 'CASH', 'ACH', 'ZELLE', 'CHECK']
const FULL_PROJECT_LABOR = 'Full Project Labor'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }

function isTodayOrPast(dateStr: string) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
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
  const [newExpense, setNewExpense] = useState<Expense>({ supplier: '', item: '', amount: '', payment_date: '' })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ supplier: '', item: '', amount: '', payment_date: '' })

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

  function isValidDate(d: string) { return !!d && d.match(/^\d{4}-\d{2}-\d{2}$/) !== null }

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

  // Calculations
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
    if (labor < 0) { alert('Target is lower than parts + other services already. Cannot calculate labor.'); return }
    const updated = [...services]
    if (laborIndex >= 0) updated[laborIndex] = { ...updated[laborIndex], price: labor.toFixed(2) }
    setServices(updated)
  }

  function updateIntuitiveExpenses() {
    const existingFlorida = expenses.find(e => e.supplier === 'Florida State' && e.item === 'Taxes')
    const existingPartExpenses: Record<string, Expense> = {}
    expenses.forEach(e => {
      if (!(e.supplier === 'Florida State' && e.item === 'Taxes')) existingPartExpenses[e.item] = e
    })
    const intuitiveExpenses: Expense[] = [
      { supplier: 'Florida State', item: 'Taxes', amount: floridaTaxesAmount.toFixed(2), payment_date: existingFlorida?.payment_date || '' },
      ...parts.map(p => {
        const existing = existingPartExpenses[p.description]
        return { supplier: existing?.supplier || '', item: p.description, amount: getPartTotal(p).toFixed(2), payment_date: existing?.payment_date || '' }
      }),
    ]
    const partDescriptions = parts.map(p => p.description)
    const userExpenses = expenses.filter(e => !(e.supplier === 'Florida State' && e.item === 'Taxes') && !partDescriptions.includes(e.item))
    setExpenses([...intuitiveExpenses, ...userExpenses])
  }

  // Parts
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

  // Services
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

  // Payments
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

  // Notes
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

  // Expenses
  function addExpense() {
    if (!newExpense.item || !newExpense.amount) { alert('Please enter at least item and amount'); return }
    setExpenses([...expenses, newExpense]); setNewExpense({ supplier: '', item: '', amount: '', payment_date: '' })
  }
  function removeExpense(index: number) { setExpenses(expenses.filter((_, i) => i !== index)) }
  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }) }
  function saveEditExpense() {
    if (!editingExpense.item || !editingExpense.amount) { alert('Please enter at least item and amount'); return }
    const updated = [...expenses]; updated[editingExpenseIndex!] = editingExpense; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', payment_date: '' })
  }
  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ supplier: '', item: '', amount: '', payment_date: '' }) }

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
      const { error: e } = await supabase.from('invoice_expenses').insert(expenses.map(ex => ({ invoice_id: invoice.id, expense_date: null, supplier: ex.supplier || null, item: ex.item, price: parseFloat(ex.amount) || 0, payment_date: isValidDate(ex.payment_date) ? ex.payment_date : null })))
      if (e) { alert(e.message); return }
    }

    router.push(`/rides/${rideId}/invoices`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'
  const selectClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
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

        {/* PARTS SECTION */}
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
                        <input type="text" placeholder="Description" value={editingPart.description} onChange={(e) => setEditingPart({ ...editingPart, description: e.target.value })} className={inputClass} />
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

        {/* SERVICES SECTION */}
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
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
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
                        <input type="text" placeholder="Description" value={editingService.description} onChange={(e) => setEditingService({ ...editingService, description: e.target.value })} className={inputClass} />
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
                          {svc.description === FULL_PROJECT_LABOR && (
                            <button onClick={calculateLabor} className="bg-yellow-700 hover:bg-yellow-600 px-3 py-1 rounded-xl font-bold text-sm">CALCULATE</button>
                          )}
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

        {/* TOTALS BOX */}
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

        {/* PAYMENTS SECTION */}
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

        {/* NOTES SECTION */}
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

        {/* CONCLUSION + DELIVERY DATES */}
        <DatePicker label="CONCLUSION DATE" value={conclusionDate} onChange={setConclusionDate} />
        <DatePicker label="DELIVERY DATE" value={deliveryDate} onChange={setDeliveryDate} />

        {/* EXPENSES SECTION */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <div><label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
              <input type="text" placeholder="Supplier (optional)" value={newExpense.supplier} onChange={(e) => setNewExpense({ ...newExpense, supplier: e.target.value })} className={inputClass} />
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
            <button onClick={updateIntuitiveExpenses} className="w-full bg-yellow-700 hover:bg-yellow-600 px-5 py-3 rounded-2xl font-bold text-lg">↻ UPDATE INTUITIVE EXPENSES</button>
            {expenses.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {expenses.map((exp, index) => {
                  const isPaid = isValidDate(exp.payment_date)
                  const rowColor = isPaid ? 'text-blue-400' : 'text-red-400'
                  return (
                    <div key={index}>
                      {editingExpenseIndex === index ? (
                        <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                          <div><label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                            <input type="text" value={editingExpense.supplier} onChange={(e) => setEditingExpense({ ...editingExpense, supplier: e.target.value })} className={inputClass} />
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
                          <div className="flex gap-3">
                            <button onClick={saveEditExpense} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                            <button onClick={cancelEditExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                          </div>
                        </div>
                      ) : (
                        <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <p className={`text-base font-bold truncate ${rowColor}`}>{exp.item}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
                            <p className={`text-sm ${rowColor}`}>{formatUSD(parseFloat(exp.amount))}</p>
                            <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                            <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
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