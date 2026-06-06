'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, usePathname } from 'next/navigation'
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
  feed_status: string | null
  fl_tax_expense_date: string | null
  is_quote: boolean | null
}

type Client = {
  name: string
  email: string | null
  instagram: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  client_number: number | null
  preferred_message_method: string | null
}

type Part = { id: string; description: string; unit_price: number; quantity: number }
type Service = { id: string; description: string; price: number }
type Payment = { id: string; amount: number; payment_date: string | null; source: string | null; description: string | null; paid_at: string | null }
type Note = { id: string; note: string }
type Expense = { id: string; expense_date: string | null; supplier: string | null; item: string; price: number; tax: number; extra: number; quantity: number; payment_date: string | null; receipt_url: string | null }

function isTodayOrPast(dateStr: string | null) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return new Date(dateStr + 'T00:00:00') <= today
}

function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

// Status ladder (first match wins):
//   no entry_date            -> AWAITING CAR (gray)
//   entry but no conclusion  -> ON DUTY (blue)
//   conclusion but no delivery -> DONE (green)
//   delivery                 -> DELIVERED (white)
function getStatusBadge(inv: { entry_date: string | null; conclusion_date: string | null; delivery_date: string | null; is_quote?: boolean | null }) {
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)
  // QUOTE is the first rung of the ladder (no HIRING DATE yet → still a quote).
  if (inv.is_quote) return { label: 'QUOTE', cls: 'bg-amber-600 text-black' }
  if (!valid(inv.entry_date)) return { label: 'AWAITING CAR', cls: 'bg-gray-700 text-gray-300' }
  if (!valid(inv.conclusion_date)) return { label: 'ON DUTY', cls: 'bg-blue-800 text-blue-200' }
  if (!valid(inv.delivery_date)) return { label: 'DONE', cls: 'bg-green-800 text-green-300' }
  return { label: 'DELIVERED', cls: 'bg-white text-black' }
}

function getFeedBadge(feedStatus: string | null) {
  return feedStatus === 'REAL_TIME'
    ? { label: 'REAL-TIME FEED', cls: 'bg-green-800 text-green-300' }
    : { label: 'INCOMPLETE', cls: 'bg-red-800 text-red-200' }
}

// Normalize a stored phone string into the digits-only form UltraMsg expects as
// `to` for an individual WhatsApp chat. US default: a bare 10-digit number gets
// a leading 1. Numbers that already include a country code are passed through.
function toWaNumber(phone: string | null | undefined): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return '1' + digits
  return digits
}

function pad3(n: number) { return String(n).padStart(3, '0') }

export default function ViewInvoicePage() {
  const params = useParams()
  const pathname = usePathname()
  const ownerId = String(params.id)
  const invoiceId = String(params.invoiceId)
  const isClient = (pathname || '').includes('/clients/')
  const basePath = isClient ? `/clients/${ownerId}/invoices` : `/rides/${ownerId}/invoices`

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
  const [openReceiptsIndex, setOpenReceiptsIndex] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  // Archived pre-conversion quote (if this invoice was once a quote) + its modal.
  const [quoteBackup, setQuoteBackup] = useState<any | null>(null)
  const [showQuoteBackup, setShowQuoteBackup] = useState(false)
  // Ref to the hidden .print-page container. SEND temporarily un-hides it
  // off-screen so html2canvas can capture the exact print layout to a PDF.
  const printPageRef = useRef<HTMLDivElement>(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    if (isClient) {
      const { data: clientData } = await supabase.from('clients').select('*').eq('id', ownerId).single()
      if (clientData) {
        setClient(clientData)
        setProjectName(clientData.name || '')
      }
    } else {
      const { data: rideData } = await supabase.from('rides').select('*').eq('id', ownerId).single()
      if (rideData) {
        setRide(rideData)
        setProjectCode(rideData.project_code || '')
        setProjectName(rideData.project_name || '')
        if (rideData.client_id) {
          const { data: clientData } = await supabase.from('clients').select('*').eq('id', rideData.client_id).single()
          if (clientData) setClient(clientData)
        }
      }
    }
    const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single()
    if (inv) setInvoice(inv)
    // If this invoice was converted from a quote, surface the archived original.
    const { data: backup } = await supabase.from('quote_backups').select('*').eq('invoice_id', invoiceId).order('archived_at', { ascending: false }).limit(1).maybeSingle()
    if (backup) setQuoteBackup(backup)
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

  function handlePrint() {
    if (!invoice) return
    const code = invoice.invoice_code
    const project = ride?.project_name || ''
    const svc = invoice.service || ''
    const parts = [code, project, svc].filter(Boolean).join(' - ')
    const noun = invoice.is_quote ? 'QUOTE' : 'INVOICE'
    const filename = `GZ28 V8 SpeedShop - ${noun} - ${parts}`
    const prev = document.title
    document.title = filename
    window.print()
    setTimeout(() => { document.title = prev }, 1000)
  }

  // The exact name the recipient sees on the delivered file. Storage keys are
  // sanitized separately (see handleSend) — this human name is only used as the
  // WhatsApp document filename and the email subject.
  function deliveredFilename(): string {
    const code = invoice?.invoice_code || ''
    const noun = invoice?.is_quote ? 'QUOTE' : 'INVOICE'
    if (isClient) {
      const cc = client?.client_number != null ? pad3(client.client_number) : ''
      const cn = client?.name || ''
      return `GZ28 V8 SpeedShop ${cc}.${cn} - Shopping ${noun} ${code}.pdf`
    }
    const rn = projectName || ''
    return `GZ28 V8 SpeedShop ${projectCode}.${rn} - ${noun} ${code}.pdf`
  }

  // Render the hidden print layout to a one-or-more-page letter PDF, entirely in
  // the browser. html2canvas can't capture a display:none node, so we briefly
  // reveal .print-page off-screen, rasterize the .pi block, then restore it.
  async function generatePdfBlob(): Promise<Blob> {
    const html2canvas = (await import('html2canvas')).default
    const jsPDFmod: any = await import('jspdf')
    const JsPDF = jsPDFmod.jsPDF || jsPDFmod.default
    const page = printPageRef.current
    if (!page) throw new Error('Print layout not available')
    const target = page.querySelector('.pi') as HTMLElement | null
    if (!target) throw new Error('Print content not found')
    const wm = page.querySelector('.pi-watermark') as HTMLElement | null

    // Reveal off-screen at letter width (8.5in * 96dpi = 816px) for capture.
    page.style.display = 'block'
    page.style.position = 'fixed'
    page.style.left = '-10000px'
    page.style.top = '0'
    page.style.width = '816px'
    page.style.background = '#ffffff'
    page.style.zIndex = '-1'
    if (wm) wm.style.position = 'absolute'  // keep watermark inside the captured node

    try {
      const canvas = await html2canvas(target, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        windowWidth: 816,
      })
      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      const pdf = new JsPDF({ unit: 'pt', format: 'letter' })
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const margin = 18  // ~0.25in, matching the print @page margin
      const usableW = pageW - margin * 2
      const imgH = (canvas.height / canvas.width) * usableW
      const pageContentH = pageH - margin * 2
      let heightLeft = imgH
      let position = 0
      pdf.addImage(imgData, 'JPEG', margin, margin + position, usableW, imgH)
      heightLeft -= pageContentH
      while (heightLeft > 0) {
        position -= pageContentH
        pdf.addPage()
        pdf.addImage(imgData, 'JPEG', margin, margin + position, usableW, imgH)
        heightLeft -= pageContentH
      }
      return pdf.output('blob')
    } finally {
      page.style.display = ''
      page.style.position = ''
      page.style.left = ''
      page.style.top = ''
      page.style.width = ''
      page.style.background = ''
      page.style.zIndex = ''
      if (wm) wm.style.position = ''
    }
  }

  // SEND: build the PDF, upload it to the public invoice-pdfs bucket, then deliver
  // by the client's preferred method:
  //   WhatsApp -> automatic UltraMsg document send to the client's number
  //   SMS      -> open the SMS composer prefilled with a link to the PDF
  //   E-Mail   -> open the mail composer prefilled with a link to the PDF
  async function handleSend() {
    if (!invoice) return
    const method = client?.preferred_message_method || 'WhatsApp'
    setSending(true)
    try {
      const blob = await generatePdfBlob()
      // Sanitized storage key (no spaces/slashes/quotes); the human name rides
      // along as the WhatsApp document filename / email subject instead.
      const key = `${invoiceId}-${Date.now()}.pdf`
      const { error: upErr } = await supabase.storage.from('invoice-pdfs').upload(key, blob, { contentType: 'application/pdf', upsert: true })
      if (upErr) { alert('Could not upload the PDF:\n' + upErr.message); setSending(false); return }
      const { data: urlData } = supabase.storage.from('invoice-pdfs').getPublicUrl(key)
      const pdfUrl = urlData.publicUrl
      const fname = deliveredFilename()

      const ownerLbl = isClient ? (client?.name || '') : `${projectCode}${projectName ? ` — ${projectName}` : ''}`
      const docNoun = invoice.is_quote ? 'Quote' : 'Invoice'
      const caption = `*GZ28 V8 SpeedShop*\n${isClient ? 'Shopping ' : ''}${docNoun} ${invoice.invoice_code}${ownerLbl ? ` — ${ownerLbl}` : ''}\nGrand Total: *${formatUSD(grandTotal)}*`

      if (method === 'SMS') {
        const text = `${caption.replace(/\*/g, '')}\n\nView/download your invoice:\n${pdfUrl}`
        window.location.href = `sms:${client?.phone || ''}?&body=${encodeURIComponent(text)}`
        setSending(false)
        return
      }

      if (method === 'E-Mail') {
        const subject = fname.replace(/\.pdf$/, '')
        const body = `Hello${client?.name ? ` ${client.name}` : ''},\n\nPlease find your ${invoice.is_quote ? 'quote' : 'invoice'} ${invoice.invoice_code} at the link below:\n${pdfUrl}\n\nThank you,\nGZ28 V8 SpeedShop`
        window.location.href = `mailto:${client?.email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        setSending(false)
        return
      }

      if (method === 'Instagram') {
        // Instagram has no document-send API or prefill link — copy the invoice
        // link to the clipboard and open the client's DM/profile to paste & send.
        const linkText = `${caption.replace(/\*/g, '')}\n\nView/download: ${pdfUrl}`
        try { await navigator.clipboard.writeText(linkText) } catch {}
        const handle = (client?.instagram || '').replace(/^@/, '').trim()
        window.open(handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/direct/inbox/', '_blank')
        alert('Invoice link copied to clipboard. Instagram opened — paste it into the client’s DM to send.')
        setSending(false)
        return
      }

      // WhatsApp (default) — automatic via UltraMsg through the existing route.
      const to = toWaNumber(client?.phone)
      if (!to) {
        alert('This client has no phone number for WhatsApp.\nAdd a phone on the client page, or change their preferred method to SMS / E-Mail.')
        setSending(false)
        return
      }
      const res = await fetch('/api/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body: caption, documentUrl: pdfUrl, filename: fname }),
      })
      const data = await res.json()
      if (!data.ok) {
        const detailErr = data?.detail?.error
        alert('WhatsApp send failed:\n' + (typeof detailErr === 'object' ? JSON.stringify(detailErr) : String(detailErr || data?.error || data?.raw || `HTTP ${res.status}`)))
        setSending(false)
        return
      }
      alert(`${invoice.is_quote ? 'Quote' : 'Invoice'} sent on WhatsApp ✓`)
    } catch (err) {
      alert('Could not generate or send the PDF:\n' + String(err))
    }
    setSending(false)
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!invoice) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Invoice not found.</p></main>
  )

  const partsSubTotal = parts.reduce((s, p) => s + p.unit_price * p.quantity, 0)
  const floridaTaxesAmount = partsSubTotal * ((invoice.florida_taxes || 0) / 100)
  const partsTotal = partsSubTotal + floridaTaxesAmount
  const servicesTotal = services.reduce((s, sv) => s + sv.price, 0)
  const partsAndServicesTotal = partsTotal + servicesTotal
  const hasDiscount = (invoice.global_discount || 0) > 0
  const globalDiscountAmount = partsAndServicesTotal * ((invoice.global_discount || 0) / 100)
  const grandTotal = partsAndServicesTotal - globalDiscountAmount
  // Match the edit page exactly: income counts only payments explicitly marked
  // PAID (paid_at), and the Florida parts tax is itself an expense GZ28 owes —
  // included in both the global and paid expense totals.
  const totalPaid = payments.filter(p => !!p.paid_at).reduce((s, p) => s + p.amount, 0)
  const balance = totalPaid - grandTotal
  const flTaxExpenseAmount = floridaTaxesAmount
  const flTaxExpensePaid = isValidDate(invoice.fl_tax_expense_date)
  const expensesTotalGlobal = flTaxExpenseAmount + expenses.reduce((s, e) => s + e.price * (e.quantity || 1) + (e.tax || 0) + (e.extra || 0), 0)
  const expensesTotalPaid = (flTaxExpensePaid ? flTaxExpenseAmount : 0) + expenses.filter(e => isValidDate(e.payment_date)).reduce((s, e) => s + e.price * (e.quantity || 1) + (e.tax || 0) + (e.extra || 0), 0)
  const expensesBalance = expensesTotalPaid - expensesTotalGlobal
  const currentProfit = totalPaid - expensesTotalPaid
  const currentProfitPct = expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0
  const finalProfit = grandTotal - expensesTotalGlobal
  const finalProfitPct = expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0
  const profitColor = (val: number) => val < 0 ? 'text-red-500' : 'text-blue-400'
  const statusBadge = getStatusBadge(invoice)
  const feedBadge = getFeedBadge(invoice.feed_status)
  const sendMethod = client?.preferred_message_method || 'WhatsApp'

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
        .pi-watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0.055; width: 500px; pointer-events: none; z-index: 0; }
        .pi-content { position: relative; z-index: 1; }
        .pi-header { display: grid; grid-template-columns: 156px 1fr 156px; align-items: center; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 8px; gap: 10px; }
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

      {/* PRINT PAGE */}
      <div className="print-page" ref={printPageRef}>
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
                <div className="pi-inv-label">{invoice.is_quote ? 'Quote #' : 'Invoice #'}</div>
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
              {!isClient && <div className="pi-info-block">
                <div className="pi-info-title">Vehicle{ride?.project_name && <span style={{color:'#111', fontWeight:900, textTransform:'none', letterSpacing:0}}> — {ride.project_name}</span>}</div>
                {(ride?.manufacturer || ride?.brand) && <div className="pi-info-row"><span className="pi-info-label">Make / Brand:</span><span className="pi-info-value">{[ride?.manufacturer, ride?.brand].filter(Boolean).join(' / ')}</span></div>}
                {ride?.model && <div className="pi-info-row"><span className="pi-info-label">Model:</span><span className="pi-info-value">{ride.model}{ride.version ? ` — ${ride.version}` : ''}</span></div>}
                {(ride?.year || ride?.vin) && <div className="pi-info-row"><span className="pi-info-label">Year / VIN:</span><span className="pi-info-value">{[ride?.year, ride?.vin].filter(Boolean).join(' — ')}</span></div>}
                {(ride?.color || ride?.plate || invoice.mileage) && <div className="pi-info-row"><span className="pi-info-label">Color / Plate / Mi:</span><span className="pi-info-value">{[ride?.color, ride?.plate, invoice.mileage ? Number(invoice.mileage).toLocaleString('en-US') : null].filter(Boolean).join(' — ')}</span></div>}
                {(ride?.special_edition || invoice.service) && <div className="pi-info-row"><span className="pi-info-label">Pack / Service:</span><span className="pi-info-value">{[ride?.special_edition, invoice.service].filter(Boolean).join(' — ')}</span></div>}
              </div>}
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
                      <td className="r">{p.unit_price === 0 ? 'COURTESY' : formatUSD(p.unit_price)}</td>
                      <td className="r">{p.quantity}</td>
                      <td className="r">{p.unit_price === 0 ? 'COURTESY' : formatUSD(p.unit_price * p.quantity)}</td>
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
                  <th style={{width:'16%'}}>Date</th>
                  <th style={{width:'22%'}}>Source</th>
                  <th style={{width:'42%'}}>Description</th>
                  <th className="r" style={{width:'20%'}}>Amount</th>
                </tr></thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td>{formatDate(p.payment_date)}</td>
                      <td>{p.source || '—'}</td>
                      <td>{p.description || '—'}</td>
                      <td className="r">{formatUSD(p.amount)}</td>
                    </tr>
                  ))}
                  <tr className="pi-pay-subtotal"><td colSpan={3} className="r">Total Paid</td><td className="r">{formatUSD(totalPaid)}</td></tr>
                  <tr className="pi-balance"><td colSpan={3} className="r">Balance</td><td className="r">{balance === 0 ? '$ —' : formatUSD(balance)}</td></tr>
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

      {/* SCREEN UI */}
      <main className="min-h-screen bg-black text-white p-8 no-print">
        <Header />

        {showQuoteBackup && quoteBackup && (() => {
          const b = quoteBackup.snapshot || {}
          const bInv = b.invoice || {}
          const bParts = b.parts || []
          const bServices = b.services || []
          const bExpenses = b.expenses || []
          const bNotes = b.notes || []
          const bPayments = b.payments || []
          const partsSub = bParts.reduce((s: number, p: any) => s + (Number(p.unit_price) || 0) * (Number(p.quantity) || 0), 0)
          const flTax = partsSub * ((Number(bInv.florida_taxes) || 0) / 100)
          const partsTot = partsSub + flTax
          const svcTot = bServices.reduce((s: number, sv: any) => s + (Number(sv.price) || 0), 0)
          const pAndS = partsTot + svcTot
          const disc = pAndS * ((Number(bInv.global_discount) || 0) / 100)
          const grand = pAndS - disc
          const paid = bPayments.filter((p: any) => !!p.paid_at).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
          return (
            <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
              <div className="bg-gray-900 border border-amber-600 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-2xl font-bold text-amber-400">ORIGINAL QUOTE — {bInv.invoice_code || invoice.invoice_code}</h2>
                  <button onClick={() => setShowQuoteBackup(false)} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-2xl font-bold shrink-0">CLOSE</button>
                </div>
                <p className="text-sm text-gray-400">Archived {new Date(quoteBackup.archived_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{bInv.service ? ` · ${bInv.service}` : ''}</p>

                {bParts.length > 0 && (
                  <div>
                    <p className="font-bold text-gray-300 mb-1">PARTS</p>
                    {bParts.map((p: any, i: number) => (
                      <div key={i} className="flex justify-between gap-4 text-sm border-b border-gray-800 py-1">
                        <span className="min-w-0 truncate">{p.description}</span>
                        <span className="text-gray-400 shrink-0">{Number(p.unit_price) === 0 ? 'COURTESY' : `${formatUSD(Number(p.unit_price) || 0)} × ${Number(p.quantity) || 0} = ${formatUSD((Number(p.unit_price) || 0) * (Number(p.quantity) || 0))}`}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-bold pt-1"><span>PARTS TOTAL{(Number(bInv.florida_taxes) || 0) > 0 ? ` (incl. ${bInv.florida_taxes}% FL tax)` : ''}</span><span>{formatUSD(partsTot)}</span></div>
                  </div>
                )}

                {bServices.length > 0 && (
                  <div>
                    <p className="font-bold text-gray-300 mb-1">SERVICES</p>
                    {bServices.map((sv: any, i: number) => (
                      <div key={i} className="flex justify-between gap-4 text-sm border-b border-gray-800 py-1">
                        <span className="min-w-0 truncate">{sv.description}</span>
                        <span className="text-gray-400 shrink-0">{Number(sv.price) === 0 ? 'COURTESY' : formatUSD(Number(sv.price) || 0)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-bold pt-1"><span>SERVICES TOTAL</span><span>{formatUSD(svcTot)}</span></div>
                  </div>
                )}

                <div className="flex justify-between text-lg font-bold border-t border-gray-700 pt-2">
                  <span>GRAND TOTAL{(Number(bInv.global_discount) || 0) > 0 ? ` (after ${bInv.global_discount}% discount)` : ''}</span>
                  <span>{formatUSD(grand)}</span>
                </div>
                {bInv.target_grand_total != null && (
                  <div className="flex justify-between text-sm text-gray-400"><span>TARGET GRAND TOTAL</span><span>{formatUSD(Number(bInv.target_grand_total) || 0)}</span></div>
                )}

                {bExpenses.length > 0 && (
                  <div>
                    <p className="font-bold text-gray-300 mb-1">EXPENSES</p>
                    {bExpenses.map((e: any, i: number) => (
                      <div key={i} className="flex justify-between gap-4 text-sm border-b border-gray-800 py-1">
                        <span className="min-w-0 truncate">{e.item}{e.supplier ? ` — ${e.supplier}` : ''}</span>
                        <span className="text-gray-400 shrink-0">{formatUSD((Number(e.price) || 0) * (Number(e.quantity) || 1) + (Number(e.tax) || 0) + (Number(e.extra) || 0))}</span>
                      </div>
                    ))}
                  </div>
                )}

                {bPayments.length > 0 && (
                  <div>
                    <p className="font-bold text-gray-300 mb-1">INCOME</p>
                    {bPayments.map((p: any, i: number) => (
                      <div key={i} className="flex justify-between gap-4 text-sm border-b border-gray-800 py-1">
                        <span className={p.paid_at ? '' : 'text-yellow-400'}>{formatUSD(Number(p.amount) || 0)}{p.paid_at ? '' : ' — PENDING'}{p.source ? ` · ${p.source}` : ''}</span>
                        <span className="text-gray-400 shrink-0">{p.payment_date ? formatDate(p.payment_date) : '—'}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-bold pt-1"><span>TOTAL PAID</span><span>{formatUSD(paid)}</span></div>
                  </div>
                )}

                {bNotes.length > 0 && (
                  <div>
                    <p className="font-bold text-gray-300 mb-1">NOTES</p>
                    {bNotes.map((n: any, i: number) => <p key={i} className="text-sm text-gray-300 whitespace-pre-wrap">{n.note}</p>)}
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-4xl font-bold">{invoice.invoice_code}</h1>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${statusBadge.cls}`}>{statusBadge.label}</span>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${feedBadge.cls}`}>{feedBadge.label}</span>
            </div>
            <p className="text-gray-400 text-xl">{isClient ? `${client?.client_number ?? ''}${client?.name ? ` — ${client.name}` : ''}` : `${projectCode}${projectName ? ` — ${projectName}` : ''}`}</p>
          </div>
          <div className="flex gap-3">
            {quoteBackup && (
              <button onClick={() => setShowQuoteBackup(true)} className="bg-amber-600 hover:bg-amber-500 text-black px-6 py-4 rounded-2xl text-xl font-bold">📋 ORIGINAL QUOTE</button>
            )}
            {client && (
              <button onClick={handleSend} disabled={sending} className={`px-6 py-4 rounded-2xl text-xl font-bold ${sending ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sending ? 'SENDING…' : `📤 SEND · ${sendMethod}`}
              </button>
            )}
            <button onClick={handlePrint} className="bg-white text-black hover:bg-gray-200 px-6 py-4 rounded-2xl text-xl font-bold">🖨 PRINT</button>
            <Link href={basePath} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
            <Link href={`${basePath}/edit/${invoiceId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 max-w-2xl">

          <div className={sectionClass}>
            {isValidDate(invoice.hiring_date) && <div className={rowClass}><span className={labelClass}>{isClient ? 'REQUEST DATE' : 'HIRING DATE'}</span><span className="font-bold">{formatDate(invoice.hiring_date)}</span></div>}
            {!isClient && isValidDate(invoice.entry_date) && <div className={rowClass}><span className={labelClass}>ENTRY DATE</span><span className="font-bold">{formatDate(invoice.entry_date)}</span></div>}
            {invoice.mileage && <div className={rowClass}><span className={labelClass}>MILEAGE</span><span className="font-bold">{Number(invoice.mileage).toLocaleString('en-US')} mi</span></div>}
            {invoice.service && <div className={rowClass}><span className={labelClass}>SERVICE</span><span className="font-bold">{invoice.service}</span></div>}
          </div>

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

          {parts.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">PARTS</label>
              <div className={sectionClass}>
                {parts.map((part, index) => (
                  <div key={part.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < parts.length - 1 ? 'border-b border-gray-700' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold truncate">{part.description}</p>
                      <p className="text-sm text-gray-400">
                        {part.unit_price === 0 ? 'COURTESY' : `${formatUSD(part.unit_price)} × ${part.quantity} = ${formatUSD(part.unit_price * part.quantity)}`}
                      </p>
                    </div>
                  </div>
                ))}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className="text-gray-400 font-bold">PARTS SUB-TOTAL</span><span className="font-bold">{formatUSD(partsSubTotal)}</span></div>
                {(invoice.florida_taxes || 0) > 0 && <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="text-gray-400 font-bold">FLORIDA PARTS TAXES ({invoice.florida_taxes}%)</span><span className="font-bold">{formatUSD(floridaTaxesAmount)}</span></div>}
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">PARTS TOTAL</span><span className="text-xl font-bold">{formatUSD(partsTotal)}</span></div>
              </div>
            </div>
          )}

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

          <div className={sectionClass}>
            <div className={rowClass}><span className={labelClass}>PARTS + SERVICES TOTAL</span><span className="font-bold">{formatUSD(partsAndServicesTotal)}</span></div>
            {hasDiscount && <div className={rowClass}><span className={labelClass}>GLOBAL DISCOUNT ({invoice.global_discount}%)</span><span className="font-bold text-red-400">- {formatUSD(globalDiscountAmount)}</span></div>}
            <div className="px-4 py-3 flex justify-between"><span className="font-bold text-xl">GRAND TOTAL</span><span className="text-3xl font-bold">{formatUSD(grandTotal)}</span></div>
          </div>

          {payments.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">INCOME</label>
              <div className={sectionClass}>
                {payments.map((payment, index) => {
                  const isPaid = !!payment.paid_at
                  return (
                    <div key={payment.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${index < payments.length - 1 ? 'border-b border-gray-700' : ''}`}>
                      <div>
                        <p className={`text-base font-bold ${isPaid ? '' : 'text-yellow-400'}`}>{formatUSD(payment.amount)}{!isPaid ? ' — PENDING' : ''}</p>
                        <p className="text-sm text-gray-400">{payment.source || ''}{payment.payment_date ? ` — ${formatDate(payment.payment_date)}` : ''}</p>
                        {payment.description && <p className="text-sm text-gray-500">{payment.description}</p>}
                      </div>
                    </div>
                  )
                })}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>TOTAL PAID</span><span className="font-bold">{formatUSD(totalPaid)}</span></div>
                <div className="px-4 py-3 flex justify-between"><span className="font-bold text-lg">BALANCE</span><span className={`text-2xl font-bold ${balance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(balance)}</span></div>
              </div>
            </div>
          )}

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

          {(isValidDate(invoice.conclusion_date) || isValidDate(invoice.delivery_date)) && (
            <div className={sectionClass}>
              {isValidDate(invoice.conclusion_date) && <div className={rowClass}><span className={labelClass}>CONCLUSION DATE</span><span className="font-bold">{formatDate(invoice.conclusion_date)}</span></div>}
              {isValidDate(invoice.delivery_date) && <div className={rowClass}><span className={labelClass}>DELIVERY DATE</span><span className="font-bold">{formatDate(invoice.delivery_date)}</span></div>}
            </div>
          )}

          {expenses.length > 0 && (
            <div>
              <label className="block mb-3 text-lg font-bold">EXPENSES</label>
              <div className={sectionClass}>
                {expenses.map((exp, index) => {
                  const isPaid = isValidDate(exp.payment_date)
                  const rowColor = isPaid ? 'text-blue-400' : 'text-red-400'
                  const receiptUrls = parseReceiptUrls(exp.receipt_url)
                  return (
                    <div key={exp.id} className={`px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className={`text-base font-bold truncate ${rowColor}`}>{exp.item}{exp.supplier ? ` — ${exp.supplier}` : ''}</p>
                          <p className={`text-sm ${rowColor}`}>Qty: {exp.quantity || 1} × {formatUSD(exp.price)} = {formatUSD(exp.price * (exp.quantity || 1))}{(exp.tax || 0) > 0 ? ` · Tax: ${formatUSD(exp.tax)}` : ''}{(exp.extra || 0) > 0 ? ` · Extra Costs: ${formatUSD(exp.extra)}` : ''}</p>
                          <p className="text-sm text-gray-500">{isPaid ? `Paid: ${formatDate(exp.payment_date)}` : 'Not paid yet'}</p>
                        </div>
                        {receiptUrls.length > 0 && (
                          <div className="relative shrink-0">
                            <button onClick={() => setOpenReceiptsIndex(openReceiptsIndex === index ? null : index)} className="bg-purple-700 hover:bg-purple-600 px-3 py-1 rounded-xl font-bold text-sm">
                              RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}
                            </button>
                            {openReceiptsIndex === index && (
                              <div className="absolute right-0 top-8 bg-gray-800 border border-gray-600 rounded-xl p-2 z-10 min-w-40 space-y-1">
                                {receiptUrls.map((url, ui) => (
                                  <a key={ui} href={url} target="_blank" rel="noopener noreferrer" className="block text-blue-400 hover:text-blue-300 text-sm truncate">File {ui + 1}</a>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                {flTaxExpenseAmount > 0 && (
                  <div className="px-4 py-3 border-b border-gray-700">
                    <p className={`text-base font-bold ${flTaxExpensePaid ? 'text-blue-400' : 'text-red-400'}`}>Florida State Taxes</p>
                    <p className={`text-sm ${flTaxExpensePaid ? 'text-blue-400' : 'text-red-400'}`}>{formatUSD(flTaxExpenseAmount)}</p>
                    <p className="text-sm text-gray-500">{flTaxExpensePaid ? `Paid: ${formatDate(invoice.fl_tax_expense_date)}` : 'Not paid yet'}</p>
                  </div>
                )}
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>TOTAL GLOBAL</span><span className="font-bold">{formatUSD(expensesTotalGlobal)}</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className={labelClass}>TOTAL PAID</span><span className="font-bold">{formatUSD(expensesTotalPaid)}</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">BALANCE</span><span className={`text-2xl font-bold ${expensesBalance < 0 ? 'text-red-500' : 'text-blue-400'}`}>{formatUSD(expensesBalance)}</span></div>
                <div className="border-t border-gray-700 px-4 py-3 flex justify-between"><span className={labelClass}>CURRENT CASH FLOW</span><span className={`font-bold ${profitColor(currentProfit)}`}>{formatUSD(currentProfit)} / {currentProfitPct.toFixed(1)}%</span></div>
                <div className="px-4 py-3 flex justify-between border-t border-gray-700"><span className="font-bold text-lg">FINAL PROFIT RESULT</span><span className={`text-xl font-bold ${profitColor(finalProfit)}`}>{formatUSD(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
              </div>
            </div>
          )}

        </div>
      </main>
    </>
  )
}
