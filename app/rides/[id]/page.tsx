'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatPhone, toWaNumber, carDestiny, insuresCar } from '@/lib/utils'
import { plateStatus, fmtPlateExpiry, PLATE_RENEWAL_URL } from '@/lib/plateExpiry'

type Ride = {
  id: string
  project_code: string
  project_name: string | null
  manufacturer: string | null
  brand: string | null
  model: string | null
  version: string | null
  special_edition: string | null
  transmission: string | null
  color: string | null
  vin: string | null
  plate: string | null
  plate_expiry: string | null
  year: number | null
  photo_url: string | null
  client_id: string | null
  title_scope: string | null
  title_transferred: boolean | null
  insurance_company: string | null
  insurance_policy: string | null
  insurance_expiry: string | null
  title_notes: string | null
}

type Client = {
  id: string
  name: string
  email: string | null
  phone: string | null
  instagram: string | null
  facebook: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  preferred_message_method: string | null
}

type Invoice = {
  id: string
  invoice_code: string
  entry_date: string | null
  delivery_date: string | null
  service: string | null
  mileage: number | null
  florida_taxes: number | null
  global_discount: number | null
  fl_tax_expense_date: string | null
}

type Stats = {
  currentProfit: number
  currentProfitPct: number
  finalProfit: number
  finalProfitPct: number
  paymentsBalance: number
  expensesBalance: number
  expensesTotalPaid: number
  expensesTotalGlobal: number
}

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function isValidDate(d: string | null) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

export default function ViewRidePage() {
  const params = useParams()
  const rideId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [ride, setRide] = useState<Ride | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [invoiceStats, setInvoiceStats] = useState<Record<string, Stats>>({})
  const [sendingPic, setSendingPic] = useState(false)
  const [picSent, setPicSent] = useState(false)

  useEffect(() => { loadAll() }, [])

  // PIC FROM CLIENT — send the client a link to a login-free page (/rides/self/[id])
  // where they upload their favorite photo of THIS car; it becomes the ride photo.
  // Delivered by the client's PREFERRED method (honor it — never force WhatsApp):
  //   WhatsApp -> automatic via /api/whatsapp (per-client `to`, country-aware)
  //   SMS / E-Mail -> opens the local composer pre-filled with the link
  //   Instagram -> copies the link + opens the client's DM
  // The message is in the client's language and carries only this one link.
  async function handleSendPic() {
    if (!client) return
    const method = client.preferred_message_method || 'WhatsApp'
    const link = `${window.location.origin}${BASE_PATH}/rides/self/${rideId}`
    const firstName = (client.name || '').split(' ')[0]
    const isBR = client.country === 'BRAZIL'
    // WhatsApp uses *bold*/_italic_ markdown; SMS / E-Mail / Instagram use plain text.
    const waBody = isBR
      ? `Oi${firstName ? ` ${firstName}` : ''}! 👋\n\nQueremos a sua foto favorita do seu carro para o registro na *_GZ28 V8 SpeedShop_*. É só abrir o link, escolher a foto e tocar em *ENVIAR FOTO*:\n\n${link}\n\nObrigado! 📸`
      : `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nWe'd love your favorite picture of your car for your record at *_GZ28 V8 SpeedShop_*. Just open the link, choose the photo and tap *SEND PHOTO*:\n\n${link}\n\nThank you! 📸`
    const plain = waBody.replace(/[*_]/g, '')
    const flashSent = () => { setPicSent(true); setTimeout(() => setPicSent(false), 3000) }
    const notifyGroup = () => { void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📸 *CAR PHOTO — LINK SENT TO CLIENT*\n${client.name || '—'}\nThe system asked the client for their favorite car photo (via ${method}). Awaiting the upload.` }),
    }).catch(() => {}) }

    if (method === 'SMS') {
      if (!client.phone) { alert('This client has no phone on file.\nAdd a number first (client EDIT).'); return }
      window.location.href = `sms:${client.phone}?&body=${encodeURIComponent(plain)}`
      notifyGroup(); flashSent(); return
    }
    if (method === 'E-Mail') {
      // Sent BY THE APP (Graph, HTML with a clickable button) — mailto: made
      // plain-text emails with dead links (31/jul, Johnny/NiteKing case).
      if (!client.email) { alert('This client has no email on file.\nAdd an email first (client EDIT).'); return }
      setSendingPic(true)
      try {
        const r = await fetch(`${BASE_PATH}/api/mail/client`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'car-photo', id: rideId }),
        })
        const d = await r.json().catch(() => ({}))
        if (!d.ok) { alert('E-mail send failed:\n' + (d.error || `HTTP ${r.status}`)); return }
        notifyGroup(); flashSent()
      } finally { setSendingPic(false) }
      return
    }
    if (method === 'Instagram') {
      try { await navigator.clipboard.writeText(plain) } catch {}
      const handle = (client.instagram || '').replace(/^@/, '').trim()
      window.open(handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/direct/inbox/', '_blank')
      alert('Link copied. Open the client’s Instagram DM and paste to send.')
      notifyGroup(); flashSent(); return
    }
    if (method === 'Facebook') {
      try { await navigator.clipboard.writeText(plain) } catch {}
      const fb = (client.facebook || '').trim()
      let url = 'https://www.facebook.com/messages/'
      if (fb) {
        if (/^https?:\/\//i.test(fb)) url = fb
        else if (fb.includes('facebook.com')) url = `https://${fb.replace(/^\/+/, '')}`
        else url = `https://www.facebook.com/${fb.replace(/^@/, '').trim()}`
      }
      window.open(url, '_blank')
      alert('Link copied. Open the client’s Facebook / Messenger and paste to send.')
      notifyGroup(); flashSent(); return
    }

    // WhatsApp (default) — automatic via UltraMsg.
    const to = toWaNumber(client.phone, client.country)
    if (!to) { alert('This client has no phone / WhatsApp number on file.\nAdd a number first (client EDIT).'); return }
    setSendingPic(true)
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body: waBody }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) {
        const detail = typeof data?.detail?.error === 'object' ? JSON.stringify(data.detail.error) : String(data?.detail?.error || data?.error || `HTTP ${res.status}`)
        alert('Could not send the link:\n' + detail); return
      }
      flashSent(); notifyGroup()
    } catch (e) {
      alert('Failed to send: ' + String(e))
    } finally {
      setSendingPic(false)
    }
  }

  async function loadAll() {
    const { data: rideData } = await supabase.from('rides').select('*').eq('id', rideId).single()
    if (!rideData) { setLoading(false); return }
    setRide(rideData)

    if (rideData.client_id) {
      const { data: clientData } = await supabase.from('clients').select('*').eq('id', rideData.client_id).single()
      if (clientData) setClient(clientData)
    }

    const { data: invoicesData } = await supabase
      .from('invoices').select('*').eq('ride_id', rideId).order('invoice_code', { ascending: true })
    if (invoicesData) {
      setInvoices(invoicesData)

      // Stock-sale income per donor invoice (a donated part another car pulled from stock).
      const stockByCode = new Map<string, { all: number; paid: number }>()
      {
        const [{ data: donInv }, { data: pulls }] = await Promise.all([
          supabase.from('inventory').select('description, donor, notes').eq('category', 'STOCK').eq('source_type', 'DONATED'),
          supabase.from('invoice_expenses').select('item, stock_donor, payment_date, price, quantity').not('stock_donor', 'is', null),
        ])
        const donorCodeByKey = new Map<string, string>()
        ;(donInv || []).forEach((r: any) => { const mm = (r.notes || '').match(/^From\s+(\S+)\s+—/); if (mm) donorCodeByKey.set(`${(r.donor || '').trim().toLowerCase()}|${(r.description || '').trim().toLowerCase()}`, mm[1]) })
        ;(pulls || []).forEach((e: any) => {
          const code = donorCodeByKey.get(`${(e.stock_donor || '').trim().toLowerCase()}|${(e.item || '').trim().toLowerCase()}`)
          if (!code) return
          const amt = (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1)
          const cur = stockByCode.get(code) || { all: 0, paid: 0 }
          cur.all += amt; if (isValidDate(e.payment_date)) cur.paid += amt
          stockByCode.set(code, cur)
        })
      }

      const stats: Record<string, Stats> = {}
      await Promise.all(invoicesData.map(async (inv) => {
        const [paymentsRes, expensesRes, partsRes, servicesRes] = await Promise.all([
          supabase.from('invoice_payments').select('amount, payment_date, paid_at').eq('invoice_id', inv.id),
          supabase.from('invoice_expenses').select('price, quantity, payment_date, tax, extra').eq('invoice_id', inv.id),
          supabase.from('invoice_parts').select('unit_price, quantity').eq('invoice_id', inv.id),
          supabase.from('invoice_services').select('price').eq('invoice_id', inv.id),
        ])

        const partsSubTotal = (partsRes.data || []).reduce((s, p) => s + (parseFloat(p.unit_price) || 0) * (parseFloat(p.quantity) || 0), 0)
        const floridaTaxesAmount = partsSubTotal * ((inv.florida_taxes || 0) / 100)
        const partsTotal = partsSubTotal + floridaTaxesAmount
        const servicesTotal = (servicesRes.data || []).reduce((s, sv) => s + (parseFloat(sv.price) || 0), 0)
        const partsAndServicesTotal = partsTotal + servicesTotal
        const discountAmount = partsAndServicesTotal * ((inv.global_discount || 0) / 100)
        const grandTotal = partsAndServicesTotal - discountAmount

        // Edit-page math: income counts only payments marked PAID (paid_at);
        // expenses include each item's qty, Tax and Extra Costs, plus the
        // Florida parts tax GZ28 owes.
        const ss = stockByCode.get((inv as any).invoice_code) || { all: 0, paid: 0 }
        const totalPaid = (paymentsRes.data || []).filter(p => !!p.paid_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) + ss.paid
        const totalIncomeAll = (paymentsRes.data || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) + ss.all
        const expenseLine = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
        const flTaxAmount = floridaTaxesAmount
        const flTaxPaid = isValidDate(inv.fl_tax_expense_date)
        const expensesTotalGlobal = flTaxAmount + (expensesRes.data || []).reduce((s, e) => s + expenseLine(e), 0)
        const expensesTotalPaid = (flTaxPaid ? flTaxAmount : 0) + (expensesRes.data || []).filter(e => isValidDate(e.payment_date)).reduce((s, e) => s + expenseLine(e), 0)

        const currentProfit = totalPaid - expensesTotalPaid
        const finalProfit = totalIncomeAll - expensesTotalGlobal
        stats[inv.id] = {
          currentProfit,
          currentProfitPct: expensesTotalPaid > 0 ? (currentProfit / expensesTotalPaid) * 100 : 0,
          finalProfit,
          finalProfitPct: expensesTotalGlobal > 0 ? (finalProfit / expensesTotalGlobal) * 100 : 0,
          paymentsBalance: totalIncomeAll - totalPaid,
          expensesBalance: expensesTotalPaid - expensesTotalGlobal,
          expensesTotalPaid,
          expensesTotalGlobal,
        }
      }))
      setInvoiceStats(stats)
    }

    setLoading(false)
  }

  function getStatus(deliveryDate: string | null) {
    if (!deliveryDate) return 'OPEN'
    const today = new Date(); today.setHours(0, 0, 0, 0)
    return new Date(deliveryDate + 'T00:00:00') <= today ? 'CLOSED' : 'OPEN'
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )
  if (!ride) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Ride not found.</p></main>
  )

  // Consolidated across the ride's REPORT-READY invoices only (non-quote AND live ONLINE/CLOSED).
  const reportReadyStats = invoices
    .filter((inv: any) => !inv.is_quote && (inv.live_status === 'REALTIME' || inv.live_status === 'CLOSED'))
    .map((inv: any) => invoiceStats[inv.id])
    .filter(Boolean)
  const agg = reportReadyStats.reduce((a, v) => ({
    currentProfit: a.currentProfit + v.currentProfit,
    finalProfit: a.finalProfit + v.finalProfit,
    paymentsBalance: a.paymentsBalance + v.paymentsBalance,
    expensesBalance: a.expensesBalance + v.expensesBalance,
    sumExpensesPaid: a.sumExpensesPaid + v.expensesTotalPaid,
    sumExpensesGlobal: a.sumExpensesGlobal + v.expensesTotalGlobal,
  }), { currentProfit: 0, finalProfit: 0, paymentsBalance: 0, expensesBalance: 0, sumExpensesPaid: 0, sumExpensesGlobal: 0 })
  const aggCurrentPct = agg.sumExpensesPaid > 0 ? (agg.currentProfit / agg.sumExpensesPaid) * 100 : 0
  const aggFinalPct = agg.sumExpensesGlobal > 0 ? (agg.finalProfit / agg.sumExpensesGlobal) * 100 : 0

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* Standard: title + action buttons on the top line, filters/badges below. */}
      <div className="mb-8">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
          <h1 className="text-4xl font-bold">{ride.project_code}{ride.project_name ? ` — ${ride.project_name}` : ''}</h1>
          <div className="flex gap-3 flex-wrap justify-end">
            {client && (
              <button onClick={handleSendPic} disabled={sendingPic || picSent} className={`disabled:opacity-60 px-6 py-4 rounded-2xl text-xl font-bold ${picSent ? 'bg-green-600' : 'bg-fuchsia-700 hover:bg-fuchsia-600'}`}>{sendingPic ? 'SENDING…' : picSent ? '✓ SENT' : '📸 PIC FROM CLIENT'}</button>
            )}
            <Link href="/rides" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
            <Link href={`/rides/edit/${rideId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
            <Link href={`/rides/${rideId}/invoices`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">INVOICES</Link>
            <Link href={`/rides/${rideId}/performance`} className="bg-red-700 hover:bg-red-600 px-6 py-4 rounded-2xl text-xl font-bold">PERFORMANCE</Link>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
            CURRENT CASH FLOW: {formatUSD(agg.currentProfit)} / {aggCurrentPct.toFixed(1)}%
          </span>
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
            DUE by CLIENTS: {formatUSD(agg.paymentsBalance)}
          </span>
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
            FINAL MARKUP: {formatUSD(agg.finalProfit)} / {aggFinalPct.toFixed(1)}%
          </span>
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${agg.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
            DUE by GZ28US: {formatUSD(agg.expensesBalance)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* PHOTO */}
        {ride.photo_url && (
          <div className="rounded-2xl overflow-hidden border border-gray-700">
            <img src={ride.photo_url} alt={ride.project_name || ride.project_code} className="w-full max-h-80 object-cover" />
          </div>
        )}

        {/* VEHICLE */}
        <div>
          <label className="block mb-3 text-lg font-bold">VEHICLE</label>
          <div className={sectionClass}>
            {(ride.manufacturer || ride.brand) && <div className={rowClass}><span className={labelClass}>MAKE / BRAND</span><span className="font-bold">{[ride.manufacturer, ride.brand].filter(Boolean).join(' / ')}</span></div>}
            {ride.model && <div className={rowClass}><span className={labelClass}>MODEL</span><span className="font-bold">{ride.model}{ride.version ? ` — ${ride.version}` : ''}</span></div>}
            {ride.year && <div className={rowClass}><span className={labelClass}>YEAR</span><span className="font-bold">{ride.year}</span></div>}
            {ride.transmission && <div className={rowClass}><span className={labelClass}>TRANSMISSION</span><span className="font-bold">{ride.transmission}</span></div>}
            {ride.color && <div className={rowClass}><span className={labelClass}>COLOR</span><span className="font-bold">{ride.color}</span></div>}
            {ride.vin && <div className={rowClass}><span className={labelClass}>VIN</span><span className="font-bold">{ride.vin}</span></div>}
            {ride.plate && <div className={rowClass}><span className={labelClass}>PLATE</span><span className="font-bold">{ride.plate}</span></div>}
            {/* Registration expiry + status; the renewal link shows once it's due or late. */}
            {ride.plate_expiry && (() => { const st = plateStatus(ride.plate_expiry); return (
              <div className={rowClass}>
                <span className={labelClass}>PLATE EXPIRY</span>
                <span className="font-bold flex items-center gap-2 flex-wrap justify-end">
                  {fmtPlateExpiry(ride.plate_expiry)}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${st.cls}`}>{st.label}</span>
                  {(st.state === 'due' || st.state === 'expired') && (
                    <a href={PLATE_RENEWAL_URL} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline text-sm font-bold">RENEW</a>
                  )}
                </span>
              </div>
            ) })()}
            {ride.special_edition && <div className={rowClass}><span className={labelClass}>PACK</span><span className="font-bold">{ride.special_edition}</span></div>}
          </div>
        </div>

        {/* TITLE & DOCS — who OWNS this car and who handles its paperwork (US-only).
            The five destinies live in lib/utils CAR_DESTINY. USA / CLIENT are an
            American client's own car — never in our name, nothing tracked. EXPORT is
            the ONLY in-our-name-but-not-ours case (until it ships; Alcatraz exception:
            a dealership may have charged the taxes and transferred anyway). OWN and
            TOOL are ours and carry onto the balance sheet. */}
        {ride.title_scope && (
          <div>
            <label className="block mb-3 text-lg font-bold">TITLE &amp; DOCS</label>
            <div className={sectionClass}>
              <div className={rowClass}>
                <span className={labelClass}>CAR DESTINY</span>
                <span className={`px-3 py-1 rounded-full text-sm font-bold ${carDestiny(ride.title_scope)?.cls || 'bg-gray-700 text-gray-300'}`}>
                  {carDestiny(ride.title_scope)?.badge || 'OWNER HANDLES'}
                </span>
              </div>
              {ride.title_scope !== 'CLIENT' && ride.title_scope !== 'USA' && (
                <div className={rowClass}>
                  <span className={labelClass}>TITLE</span>
                  <span className="font-bold">
                    {ride.title_transferred
                      ? 'Titled to GZ28US LLC (taxes paid)'
                      : ride.title_scope === 'EXPORT' ? 'Not transferred — endorsed title goes to the exporter' : 'Transfer pending'}
                  </span>
                </div>
              )}
              {insuresCar(ride.title_scope) && (ride.insurance_company || ride.insurance_policy) && (
                <div className={rowClass}>
                  <span className={labelClass}>INSURANCE</span>
                  <span className="font-bold">{[ride.insurance_company, ride.insurance_policy ? `#${ride.insurance_policy}` : null].filter(Boolean).join(' ')}</span>
                </div>
              )}
              {insuresCar(ride.title_scope) && ride.insurance_expiry && (() => { const st = plateStatus(ride.insurance_expiry); return (
                <div className={rowClass}>
                  <span className={labelClass}>INSURANCE EXPIRY</span>
                  <span className="font-bold flex items-center gap-2 flex-wrap justify-end">
                    {fmtPlateExpiry(ride.insurance_expiry)}
                    {st.state !== 'none' && <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${st.cls}`}>{st.label}</span>}
                  </span>
                </div>
              ) })()}
              {ride.title_notes && <div className={rowClass}><span className={labelClass}>NOTES</span><span className="font-bold text-right">{ride.title_notes}</span></div>}
            </div>
          </div>
        )}

        {/* CLIENT */}
        {client && (
          <div>
            <label className="block mb-3 text-lg font-bold">CLIENT</label>
            <div className={sectionClass}>
              <div className={rowClass}><span className={labelClass}>NAME</span><span className="font-bold">{client.name}</span></div>
              {client.phone && <div className={rowClass}><span className={labelClass}>PHONE</span><span className="font-bold">{formatPhone(client.phone, client.country)}</span></div>}
              {client.email && <div className={rowClass}><span className={labelClass}>EMAIL</span><span className="font-bold">{client.email}</span></div>}
              {client.address && <div className={rowClass}><span className={labelClass}>ADDRESS</span><span className="font-bold">{client.address}</span></div>}
              {(client.city || client.state) && <div className={rowClass}><span className={labelClass}>CITY/ST</span><span className="font-bold">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
            </div>
          </div>
        )}

        {/* INVOICES */}
        {invoices.length > 0 && (
          <div>
            <label className="block mb-3 text-lg font-bold">INVOICES ({invoices.length})</label>
            <div className="space-y-3">
              {invoices.map((invoice) => {
                const s = invoiceStats[invoice.id]
                const status = getStatus(invoice.delivery_date)
                return (
                  <div key={invoice.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h3 className="text-xl font-bold">{invoice.invoice_code}</h3>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${status === 'CLOSED' ? 'bg-gray-700 text-gray-300' : 'bg-green-800 text-green-300'}`}>{status}</span>
                      </div>
                      <p className="text-gray-400">Entry: {formatDate(invoice.entry_date)}{invoice.delivery_date ? ` — Delivery: ${formatDate(invoice.delivery_date)}` : ''}</p>
                      {invoice.service && <p className="text-gray-400">{invoice.service}</p>}
                      {s && (
                        <div className="flex gap-2 mt-2 flex-wrap">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.currentProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                            CURRENT CASH FLOW: {formatUSD(s.currentProfit)} / {s.currentProfitPct.toFixed(1)}%
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.paymentsBalance > 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                            DUE by CLIENTS: {formatUSD(s.paymentsBalance)}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.finalProfit < 0 ? 'bg-red-900 text-red-300' : 'bg-blue-900 text-blue-300'}`}>
                            FINAL MARKUP: {formatUSD(s.finalProfit)} / {s.finalProfitPct.toFixed(1)}%
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.expensesBalance < 0 ? 'bg-red-900 text-red-300' : 'bg-gray-700 text-gray-300'}`}>
                            DUE by GZ28US: {formatUSD(s.expensesBalance)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Link href={`/rides/${rideId}/invoices/${invoice.id}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-xl font-bold text-sm">VIEW</Link>
                      <Link href={`/rides/${rideId}/invoices/edit/${invoice.id}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-xl font-bold text-sm">EDIT</Link>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {invoices.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 text-center text-gray-400 text-lg">
            No invoices yet.
          </div>
        )}

      </div>
    </main>
  )
}
