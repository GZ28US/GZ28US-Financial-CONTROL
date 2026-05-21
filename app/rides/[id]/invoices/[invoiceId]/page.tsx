'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'

type Invoice = {
  id: string
  invoice_code: string
  hiring_date: string | null
  entry_date: string | null
  conclusion_date: string | null
  delivery_date: string | null
  mileage: number | null
  service: string | null
  florida_taxes: number | null
  global_discount: number | null
}

type Client = {
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
}

type Part = { id: string; description: string; unit_price: number; quantity: number }
type Service = { id: string; description: string; price: number }
type Payment = { id: string; amount: number; payment_date: string | null; source: string | null }
type Note = { id: string; note: string }
type Expense = { id: string; expense_date: string | null; supplier: string | null; item: string; price: number; payment_date: string | null }

function isTodayOrPast(dateStr: string | null) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
}

export default function ViewInvoicePage() {
  const params = useParams()
  const rideId = String(params.id)
  const invoiceId = String(params.invoiceId)

  const [loading, setLoading] = useState(true)
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [client, setClient] = useState<Client | null>(null)
  const [ride, setRide] = useState<any>(null)
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [parts, setParts] = useState<Part[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const { data: rideData } = await supabase.from('rides').select('*').eq('id', rideId).single()
    if (rideData) {
      setRide(rideData)
      setProjectCode(rideData.project_code || '')
      setProjectName(rideData.project_name || '')
      if (rideData.client_id) {
        const { data: clientData } = await supabase.from('clients').select('*').eq('id', rideData.client_id).single()
        if (clientData) setClient(clientData)
      }
    }

    const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single()
    if (inv) setInvoice(inv)

    const { data: partsData } = await supabase.from('invoice_parts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (partsData) setParts(partsData)

    const { data: servicesData } = await supabase.from('invoice_services').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (servicesData) setServices(servicesData)

    const { data: paymentsData } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (paymentsData) setPayments(paymentsData)

    const { data: notesData } = await supabase.from('invoice_notes').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (notesData) setNotes(notesData)

    const { data: expensesData } = await supabase.from('invoice_expenses').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: true })
    if (expensesData) setExpenses(expensesData)

    setLoading(false)
  }

  function formatDate(d: string | null) {
    if (!d) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  }

  function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

  function getStatus() {
    if (!invoice?.delivery_date) return 'OPEN'
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return new Date(invoice.delivery_date + 'T00:00:00') <= today ? 'CLOSED' : 'OPEN'
  }

  function handlePrint() {
    if (!invoice) return
    const code = invoice.invoice_code
    const project = ride?.project_name || ''
    const svc = invoice.service || ''
    const parts = [code, project, svc].filter(Boolean).join(' - ')
    const filename = `GZ28 V8 SpeedShop - INVOICE - ${parts}`
    const prev = document.title
    document.title = filename
    window.print()
    setTimeout(() => { document.title = prev }, 1000)
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!invoice) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Invoice not found.</p></main>
  )

  // Calculations
  const partsSubTotal = parts.reduce((s, p) => s + p.unit_price * p.quantity, 0)
  const floridaTaxesAmount = partsSubTotal * ((invoice.florida_taxes || 0) / 100)
  const partsTotal = partsSubTotal + floridaTaxesAmount
  const servicesTotal = services.reduce((s, sv) => s + sv.price, 0)
  const partsAndServicesTotal = partsTotal + servicesTotal
  const hasDiscount = (invoice.global_discount || 0) > 0
  const globalDiscountAmount = partsAndServicesTotal * ((invoice.global_discount || 0) / 100)
  const grandTotal = partsAndServicesTotal - globalDiscountAmount
  const totalPaid = payments.filter(p => isTodayOrPast(p.payment_date)).reduce((s, p) => s + p.amount, 0)
  const balance = totalPaid - grandTotal
  const expensesTotalGlobal = expenses.reduce((s, e) => s + e.price, 0)
  const expensesTotalPaid = expenses.filter(e => e.payment_date).reduce((s, e) => s + e.price, 0)
  const expensesBalance = expensesTotalPaid - expensesTotalGlobal
  const currentProfit = totalPaid - expensesTotalPaid
  const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = (val: number) => val < 0 ? 'text-red-500' : 'text-blue-400'
  const status = getStatus()

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden'

  return (
    <>
      <style>{`
        @media print {
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          body { background: white !important; margin: 0; }
          .no-print { display: none !important; }
          .print-page { display: block !important; }
          @page { margin: 0.25in; size: letter; }
        }
        .print-page { display: none; }

        .pi * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
        .pi { background: white; color: #111; font-size: 9px; position: relative; }

        .pi-watermark {
          position: fixed; top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          opacity: 0.055; width: 500px;
          pointer-events: none; z-index: 0;
        }
        .pi-content { position: relative; z-index: 1; }

        .pi-header {
          display: grid; grid-template-columns: 156px 1fr 156px;
          align-items: center; border-bottom: 2px solid #111;
          padding-bottom: 8px; margin-bottom: 8px; gap: 10px;
        }
        .pi-logo { width: 156px; height: auto; display: block; }
        .pi-company { text-align: center; }
        .pi-company-name { font-size: 13px; font-weight: 900; letter-spacing: 0.5px; margin-bottom: 2px; }
        .pi-company-sub { font-size: 8px; color: #555; line-height: 1.5; }
        .pi-inv-box { text-align: right; }
        .pi-inv-label { font-size: 7px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        .pi-inv-num { font-size: 20px; font-weight: 900; color: #cc0000; letter-spacing: 1px; line-height: 1; }
        .pi-inv-date { font-size: 8px; color: #555; margin-top: 2px; }

        .pi-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
        .pi-info-block { border: 0.5px solid #ccc; border-radius: 3px; padding: 5px 8px; }
        .pi-info-title { font-size: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #888; border-bottom: 0.5px solid #eee; padding-bottom: 2px; margin-bottom: 3px; }
        .pi-info-row { display: flex; gap: 3px; margin-bottom: 1px; }
        .pi-info-label { font-weight: 700; color: #666; min-width: 80px; font-size: 8px; flex-shrink: 0; }
        .pi-info-value { color: #111; font-size: 8px; }

        .pi-sec { margin-bottom: 7px; }
        .pi-sec-title { background: #111; color: white; font-weight: 700; font-size: 8px; letter-spacing: 1px; text-transform: uppercase; padding: 3px 8px; }

        .pi-table { width: 100%; border-collapse: collapse; font-size: 8px; }
        .pi-table thead tr { background: #e0e0e0; }
        .pi-table thead th { padding: 2px 6px; text-align: left; font-weight: 700; font-size: 7px; text-transform: uppercase; border: 0.5px solid #bbb; }
        .pi-table thead th.r { text-align: right; }
        .pi-table tbody td { padding: 2px 6px; border-left: 0.5px solid #e8e8e8; border-right: 0.5px solid #e8e8e8; border-bottom: 0.5px solid #ececec; }
        .pi-table tbody tr:nth-child(even) td { background: #fafafa; }
        .pi-table td.r { text-align: right; }
        .pi-subtotal td { background: #efefef !important; font-weight: 700; padding: 2px 6px; border-top: 1px solid #bbb !important; }
        .pi-taxes td { background: #cc0000 !important; color: white !important; font-weight: 700; padding: 2px 6px; }
        .pi-ptotal td { background: #111 !important; color: white !important; font-weight: 900; font-size: 9px; padding: 3px 6px; }
        .pi-stotal td { background: #111 !important; color: white !important; font-weight: 900; font-size: 9px; padding: 3px 6px; }

        .pi-totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 7px; }
        .pi-totals-tbl { width: 250px; border-collapse: collapse; font-size: 8px; }
        .pi-totals-tbl td { padding: 2px 6px; }
        .pi-totals-tbl .r { text-align: right; }
        .pi-psrow td { background: #f0f0f0; font-weight: 700; }
        .pi-discrow td { background: #f0f0f0; font-weight: 700; color: #cc0000; }
        .pi-grandrow td { background: #1a1a2e !important; color: #f0c040 !important; font-weight: 900; font-size: 11px; padding: 5px 6px; border-top: 2px solid #f0c040 !important; }

        .pi-pay-subtotal td { background: #efefef !important; font-weight: 700; padding: 2px 6px; border-top: 1px solid #bbb !important; }
        .pi-balance td { background: #1a1a2e !important; color: #4ade80 !important; font-weight: 900; font-size: 10px; padding: 4px 6px; }

        .pi-notes { border: 0.5px solid #ccc; border-radius: 3px; padding: 6px 12px; margin-bottom: 8px; text-align: center; }
        .pi-notes-title { font-weight: 700; text-transform: uppercase; font-size: 7px; letter-spacing: 0.5px; color: #888; margin-bottom: 4px; }
        .pi-notes p { font-size: 8px; margin-bottom: 1px; }

        .pi-sig { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 8px; page-break-inside: avoid; break-inside: avoid; }
        .pi-sig-block { text-align: center; }
        .pi-sig-line { border-bottom: 1px solid #333; height: 24px; margin-bottom: 3px; }
        .pi-sig-label { font-size: 7px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
      `}</style>

      {/* ── PRINT PAGE ── */}
      <div className="print-page">
        <div className="pi">
          <img src="/logo_gz28.jpg" className="pi-watermark" alt="" aria-hidden="true" />
          <div className="pi-content">
            <div className="pi-header">
              <img src="/logo_gz28.jpg" className="pi-logo" alt="GZ28 Logo" />
              <div className="pi-company">
                <div className="pi-company-name">GZ28 V8 SpeedShop USA LLC</div>
                <div className="pi-company-sub">11320 Space Blvd, 32837, Orlando / FL</div>
                <div className="pi-company-sub">PHONE: (321) 315.0973 · EMAIL: gz28us@hotmail.com</div>
                <div className="pi-company-sub">IG: @gz28us / @gz28br · FB: Dema De Maria</div>
              </div>
              <div className="pi-inv-box">
                <div className="pi-inv-label">Invoice #</div>
                <div className="pi-inv-num">{invoice.invoice_code}</div>
                <div className="pi-inv-date">Hiring: {formatDate(invoice.hiring_date)}</div>
                <div className="pi-inv-date">Entry: {formatDate(invoice.entry_date)}</div>
                {invoice.delivery_date && <div className="pi-inv-date">Delivery: {formatDate(invoice.delivery_date)}</div>}
              </div>
            </div>

            <div className="pi-two-col">
              <div className="pi-info-block">
                <div className="pi-info-title">Client</div>
                {client ? <>
                  <div className="pi-info-row"><span className="pi-info-label">Name:</span><span className="pi-info-value">{client.name}</span></div>
                  {client.address && <div className="pi-info-row"><span className="pi-info-label">Address:</span><span className="pi-info-value">{client.address}</span></div>}
                  {(client.city || client.state) && <div className="pi-info-row"><span className="pi-info-label">City/ST:</span><span className="pi-info-value">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
                  {client.phone && <div className="pi-info-row"><span className="pi-info-label">Phone:</span><span className="pi-info-value">{client.phone}</span></div>}
                  {client.email && <div className="pi-info-row"><span className="pi-info-label">E-Mail:</span><span className="pi-info-value">{client.email}</span></div>}
                </> : <div className="pi-info-value" style={{color:'#999',fontStyle:'italic'}}>No client linked</div>}
              </div>
              <div className="pi-info-block">
                <div className="pi-info-title">Vehicle{ride?.project_name && <span style={{color:'#111', fontWeight:900, textTransform:'none', letterSpacing:0}}> — {ride.project_name}</span>}</div>
                {(ride?.manufacturer || ride?.brand) && <div className="pi-info-row"><span className="pi-info-label">Make / Brand:</span><span className="pi-info-value">{[ride?.manufacturer, ride?.brand].filter(Boolean).join(' / ')}</span></div>}
                {ride?.model && <div className="pi-info-row"><span className="pi-info-label">Model:</span><span className="pi-info-value">{ride.model}{ride.version ? ` — ${ride.version}` : ''}</span></div>}
                {(ride?.year || ride?.vin) && <div className="pi-info-row"><span className="pi-info-label">Year / VIN:</span><span className="pi-info-value">{[ride?.year, ride?.vin].filter(Boolean).join(' — ')}</span></div>}
                {(ride?.color || ride?.plate || invoice.mileage) && <div className="pi-info-row"><span className="pi-info-label">Color / Plate / Mi:</span><span className="pi-info-value">{[ride?.color, ride?.plate, invoice.mileage ? Number(invoice.mileage).toLocaleString('en-US') : null].filter(Boolean).join(' — ')}</span></div>}
                {(ride?.special_edition || invoice.service) && <div className="pi-info-row"><span className="pi-info-label">Pack / Service:</span><span className="pi-info-value">{[ride?.special_edition, invoice.service].filter(Boolean).join(' — ')}</span></div>}
              </div>
            </div>

            {parts.length > 0 && <div className="pi-sec">
              <div className="pi-sec-title">Parts</div>
              <table className="pi-table">
                <thead><tr>
                  <th style={{width:'56%'}}>Description</th>
                  <th className="r" style={{width:'16%'}}>Unit Price</th>
                  <th className="r" style={{width:'8%'}}>Qt</th>
                  <th className="r" style={{width:'20%'}}>Total</th>
                </tr></thead>
                <tbody>
                  {parts.map(p => (
                    <tr key={p.id}>
                      <td>{p.description}</td>
                      <td className="r">{p.unit_price === 0 ? '—' : formatUSD(p.unit_price)}</td>
                      <td className="r">{p.quantity}</td>
                      <td className="r">{p.unit_price === 0 ? '—' : formatUSD(p.unit_price * p.quantity)}</td>
                    </tr>
                  ))}
                  <tr className="pi-subtotal"><td colSpan={3} className="r">Sub-Total</td><td className="r">{formatUSD(partsSubTotal)}</td></tr>
                  {(invoice.florida_taxes || 0) > 0 && <tr className="pi-taxes"><td colSpan={3} className="r">Florida Taxes {invoice.florida_taxes}%</td><td className="r">{formatUSD(floridaTaxesAmount)}</td></tr>}
                  <tr className="pi-ptotal"><td colSpan={3} className="r">Parts Total</td><td className="r">{formatUSD(partsTotal)}</td></tr>
                </tbody>
              </table>
            </div>}

            {services.length > 0 && <div className="pi-sec">
              <div className="pi-sec-title">Services</div>
              <table className="pi-table">
                <thead><tr>
                  <th style={{width:'80%'}}>Description</th>
                  <th className="r" style={{width:'20%'}}>Total</th>
                </tr></thead>
                <tbody>
                  {services.map(sv => (
                    <tr key={sv.id}>
                      <td>{sv.description}</td>
                      <td className="r">{sv.price === 0 ? 'COURTESY' : formatUSD(sv.price)}</td>
                    </tr>
                  ))}
                  <tr className="pi-stotal"><td className="r">Services Total</td><td className="r">{formatUSD(servicesTotal)}</td></tr>
                </tbody>
              </table>
            </div>}

            <div className="pi-totals-wrap">
              <table className="pi-totals-tbl">
                <tbody>
                  <tr className="pi-psrow"><td>Parts + Services</td><td className="r">{formatUSD(partsAndServicesTotal)}</td></tr>
                  {hasDiscount && <tr className="pi-discrow"><td>Discount ({invoice.global_discount}%)</td><td className="r">— {formatUSD(globalDiscountAmount)}</td></tr>}
                  <tr className="pi-grandrow"><td>Grand Total</td><td className="r">{formatUSD(grandTotal)}</td></tr>
                </tbody>
              </table>
            </div>

            {payments.length > 0 && <div className="pi-sec">
              <div className="pi-sec-title">Payments</div>
              <table className="pi-table">
                <thead><tr>
                  <th style={{width:'18%'}}>Date</th>
                  <th style={{width:'62%'}}>Source</th>
                  <th className="r" style={{width:'20%'}}>Amount</th>
                </tr></thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td>{formatDate(p.payment_date)}</td>
                      <td>{p.source || '—'}</td>
                      <td className="r">{formatUSD(p.amount)}</td>
                    </tr>
                  ))}
                  <tr className="pi-pay-subtotal"><td colSpan={2} className="r">Total Paid</td><td className="r">{formatUSD(totalPaid)}</td></tr>
                  <tr className="pi-balance"><td colSpan={2} className="r">Balance</td><td className="r">{balance === 0 ? '$ —' : formatUSD(balance)}</td></tr>
                </tbody>
              </table>
            </div>}

            {notes.length > 0 && <div className="pi-notes">
              <div className="pi-notes-title">Notes</div>
              {notes.map(n => <p key={n.id}>{n.note}</p>)}
            </div>}

            <div className="pi-sig">
              <div className="pi-sig-block"><div className="pi-sig-line"></div><div className="pi-sig-label">Delivery Date</div></div>
              <div className="pi-sig-block"><div className="pi-sig-line"></div><div className="pi-sig-label">Client — Printed Name</div></div>
            </div>
          </div>
        </div>
      </div>

      {/* ── SCREEN UI ── */}
      <main className="min-h-screen bg-black text-white p-8 no-print">
        <Header />

        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-4xl font-bold">{invoice.invoice_code}</h1>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${status === 'CLOSED' ? 'bg-gray-700 text-gray-300' : 'bg-green-800 text-green-300'}`}>{status}</span>
            </div>
            <p className="text-gray-400 text-xl">{projectCode}{projectName ? ` — ${projectName}` : ''}</p>
          </div>
          <div className="flex gap-3">
            <button onClick={handlePrint} className="bg-white text-black hover:bg-gray-200 px-6 py-4 rounded-2xl text-xl font-bold">🖨 PRINT</button>
            <Link href={`/rides/${rideId}/invoices`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
            <Link href={`/rides/${rideId}/invoices/edit/${invoiceId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 max-w-2xl">

          {/* DATES */}
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>HIRING DATE</span><span className="font-bold">{formatDate(invoice.hiring_date)}</span></div>
            <div className={rowClass}><span className={labelClass}>ENTRY DATE</span><span className="font-bold">{formatDate(invoice.entry_date)}</span></div>
            {invoice.mileage && <div className={rowClass}><span className={labelClass}>MILEAGE</span><span className="font-bold">{Number(invoice.mileage).toLocaleString('en-US')} mi</span></div>}
            {invoice.service && <div className={rowClass}><span className={labelClass}>SERVICE</span><span className="font-bold">{invoice.service}</span></div>}
          </div>

          {/* VEHICLE */}
          {ride && (
            <div>
              <label className="block mb-3 text-lg font-bold">VEHICLE</label>
              <div className={sectionClass}>
                {(ride.manufacturer || ride.brand) && <div className={rowClass}><span className={labelClass}>MAKE / BRAND</span><span className="font-bold">{[ride.manufacturer, ride.brand].filter(Boolean).join(' / ')}</span></div>}
                {ride.model && <div className={rowClass}><span className={labelClass}>MODEL</span><span className="font-bold">{ride.model}{ride.version ? ` — ${ride.version}` : ''}</span></div>}
                {ride.year && <div className={rowClass}><span className={labelClass}>YEAR</span><span className="font-bold">{ride.year}</span></div>}
                {ride.color && <div className={rowClass}><span className={labelClass}>COLOR</span><span className="font-bold">{ride.color}</span></div>}
                {ride.vin && <div className={rowClass}><span className={labelClass}>VIN</span><span className="font-bold">{ride.vin}</span></div>}
                {ride.plate && <div className={rowClass}><span className={labelClass}>PLATE</span><span className="font-bold">{ride.plate}</span></div>}
                {ride.special_edition && <div className={rowClass}><span className={labelClass}>PACK</span><span className="font-bold">{ride.special_edition}</span></div>}
              </div>
            </div>
          )}

          {/* CLIENT */}
          {client && (
            <div>
              <label className="block mb-3 text-lg font-bold">CLIENT</label>
              <div className={sectionClass}>
                <div className={rowClass}><span className={labelClass}>NAME</span><span className="font-bold">{client.name}</span></div>
                {client.phone && <div className={rowClass}><span className={labelClass}>PHONE</span><span className="font-bold">{client.phone}</span></div>}
                {client.email && <div className={rowClass}><span className={labelClass}>EMAIL</span><span className="font-bold">{client.email}</span></div>}
                {client.address && <div className={rowClass}><span className={labelClass}>ADDRESS</span><span className="font-bold">{client.address}</span></div>}
                {(client.city || client.state) && <div className={rowClass}><span className={labelClass}>CITY/ST</span><span className="font-bold">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
              </div>
            </div>
          )}

          {/* PARTS */}
          {parts.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">PARTS</label>
              <div className={sectionClass}>
                {parts.map((part, index) => (
                  <div key={part.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < parts.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold truncate">{part.description}</p>
                      <p className="text-sm text-gray-400">{part.unit_price === 0 ? 'INCLUDED' : formatUSD(part.unit_price)} × {part.quantity} = {part.unit_price === 0 ? '—' : formatUSD(part.unit_price * part.quantity)}</p>
                    </div>
                  </div>
                ))}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className="text-gray-400 font-bold">PARTS SUB-TOTAL</span><span className="font-bold">{formatUSD(partsSubTotal)}</span></div>
                {(invoice.florida_taxes || 0) > 0 && <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="text-gray-400 font-bold">FLORIDA PARTS TAXES ({invoice.florida_taxes}%)</span><span className="font-bold">{formatUSD(floridaTaxesAmount)}</span></div>}
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">PARTS TOTAL</span><span className="text-xl font-bold">{formatUSD(partsTotal)}</span></div>
              </div>
            </div>
          )}

          {/* SERVICES */}
          {services.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">SERVICES</label>
              <div className={sectionClass}>
                {services.map((svc, index) => (
                  <div key={svc.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < services.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <p className="text-base font-bold flex-1 truncate">{svc.description}</p>
                    <p className="text-gray-400 font-bold">{svc.price === 0 ? 'COURTESY' : formatUSD(svc.price)}</p>
                  </div>
                ))}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className="font-bold text-lg">SERVICES TOTAL</span><span className="text-xl font-bold">{formatUSD(servicesTotal)}</span></div>
              </div>
            </div>
          )}

          {/* TOTALS */}
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>PARTS + SERVICES TOTAL</span><span className="font-bold">{formatUSD(partsAndServicesTotal)}</span></div>
            {hasDiscount && <div className={rowClass}><span className={labelClass}>GLOBAL DISCOUNT ({invoice.global_discount}%)</span><span className="font-bold text-red-400">- {formatUSD(globalDiscountAmount)}</span></div>}
            <div className="px-4 py-3 flex justify-between"><span className="font-bold text-xl">GRAND TOTAL</span><span className="text-3xl font-bold">{formatUSD(grandTotal)}</span></div>
          </div>

          {/* PAYMENTS */}
          {payments.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">PAYMENTS</label>
              <div className={sectionClass}>
                {payments.map((payment, index) => {
                  const isPaid = isTodayOrPast(payment.payment_date)
                  return (
                    <div key={payment.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < payments.length - 1 ? 'border-b border-gray-700' : ''}`}>
                      <div>
                        <p className={`text-base font-bold ${isPaid ? '' : 'text-yellow-400'}`}>{formatUSD(payment.amount)}{!isPaid ? ' — PENDING' : ''}</p>
                        <p className="text-sm text-gray-400">{payment.source || ''}{payment.payment_date ? ` — ${formatDate(payment.payment_date)}` : ''}</p>
                      </div>
                    </div>
                  )
                })}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>TOTAL PAID</span><span className="font-bold">{formatUSD(totalPaid)}</span></div>
                <div className="px-4 py-3 flex justify-between"><span className="font-bold text-lg">BALANCE</span><span className={`text-2xl font-bold ${balance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(balance)}</span></div>
              </div>
            </div>
          )}

          {/* NOTES */}
          {notes.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">NOTES</label>
              <div className={sectionClass}>
                {notes.map((n, index) => (
                  <div key={n.id} className={`px-4 py-3 ${index < notes.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <p className="text-base text-gray-300 whitespace-pre-wrap">{n.note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CONCLUSION + DELIVERY */}
          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>CONCLUSION DATE</span><span className="font-bold">{formatDate(invoice.conclusion_date)}</span></div>
            <div className={rowClass}><span className={labelClass}>DELIVERY DATE</span><span className="font-bold">{formatDate(invoice.delivery_date)}</span></div>
          </div>

          {/* EXPENSES */}
          {expenses.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">EXPENSES</label>
              <div className={sectionClass}>
                {expenses.map((exp, index) => {
                  const isPaid = isValidDate(exp.payment_date)
                  const rowColor = isPaid ? 'text-blue-400' : 'text-red-400'
                  return (
                    <div key={exp.id} className={`px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                      <p className={`text-base font-bold truncate ${rowColor}`}>{exp.item}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
                      <p className={`text-sm ${rowColor}`}>{formatUSD(exp.price)}</p>
                      <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                    </div>
                  )
                })}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>TOTAL GLOBAL</span><span className="font-bold">{formatUSD(expensesTotalGlobal)}</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className={labelClass}>TOTAL PAID</span><span className="font-bold">{formatUSD(expensesTotalPaid)}</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">BALANCE</span><span className={`text-2xl font-bold ${expensesBalance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(expensesBalance)}</span></div>
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>CURRENT PROFIT</span><span className={`font-bold ${profitColor(currentProfit)}`}>{formatUSD(currentProfit)} / {currentProfitPct.toFixed(1)}%</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">FINAL PROFIT</span><span className={`text-xl font-bold ${profitColor(finalProfit)}`}>{formatUSD(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
              </div>
            </div>
          )}

        </div>
      </main>
    </>
  )
}