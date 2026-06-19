'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, toWaNumber } from '@/lib/utils'

type Client = {
  id: string
  name: string
  email: string | null
  instagram: string | null
  phone: string | null
  cpf: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  preferred_message_method: string | null
}

type Ride = {
  id: string
  project_code: string
  project_name: string | null
  manufacturer: string | null
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  plate: string | null
}

type PersonalInvoice = {
  id: string
  invoice_code: string
  service: string | null
  entry_date: string | null
}

export default function ViewClientPage() {
  const params = useParams()
  const clientId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [client, setClient] = useState<Client | null>(null)
  const [rides, setRides] = useState<Ride[]>([])
  const [personalInvoices, setPersonalInvoices] = useState<PersonalInvoice[]>([])
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)

  useEffect(() => { loadAll() }, [])

  // SEND CLIENT — send the client a link to their OWN self-service form
  // (/clients/self/[id]) so they fill in their fields and save. Delivered by the
  // client's PREFERRED method (always honor it — never force WhatsApp):
  //   WhatsApp -> automatic via /api/whatsapp (per-client `to`, country-aware)
  //   SMS / E-Mail -> opens the local composer pre-filled with the link
  //   Instagram -> copies the link + opens the client's DM
  // The message is in the client's language and carries only this one link. Either
  // way a note is mirrored to the REPORTS group (team language: English).
  async function handleSendClient() {
    if (!client) return
    const method = client.preferred_message_method || 'WhatsApp'
    const link = `${window.location.origin}${BASE_PATH}/clients/self/${clientId}`
    const firstName = (client.name || '').split(' ')[0]
    const isBR = client.country === 'BRAZIL'
    // WhatsApp uses *bold*/_italic_ markdown; SMS / E-Mail / Instagram use plain text.
    const waBody = isBR
      ? `Oi${firstName ? ` ${firstName}` : ''}! 👋\n\nPara agilizar seu atendimento na *_GZ28 V8 SpeedShop_*, por favor preencha seus dados neste link e toque em *SALVAR*:\n\n${link}\n\nObrigado!`
      : `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nTo speed up your service at *_GZ28 V8 SpeedShop_*, please fill in your details at this link and tap *SAVE*:\n\n${link}\n\nThank you!`
    const plain = waBody.replace(/[*_]/g, '')
    const flashSent = () => { setJustSent(true); setTimeout(() => setJustSent(false), 3000) }
    const notifyGroup = () => { void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📤 *CLIENT FORM — LINK SENT*\n${client.name || '—'}\nThe system sent the registration link to the client (via ${method}). Awaiting them to fill in their details.` }),
    }).catch(() => {}) }

    if (method === 'SMS') {
      if (!client.phone) { alert('This client has no phone on file.\nAdd a number first (EDIT).'); return }
      window.location.href = `sms:${client.phone}?&body=${encodeURIComponent(plain)}`
      notifyGroup(); flashSent(); return
    }
    if (method === 'E-Mail') {
      if (!client.email) { alert('This client has no email on file.\nAdd an email first (EDIT).'); return }
      const subject = isBR ? 'Complete seu cadastro — GZ28 V8 SpeedShop' : 'Complete your details — GZ28 V8 SpeedShop'
      window.location.href = `mailto:${client.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      notifyGroup(); flashSent(); return
    }
    if (method === 'Instagram') {
      try { await navigator.clipboard.writeText(plain) } catch {}
      const handle = (client.instagram || '').replace(/^@/, '').trim()
      window.open(handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/direct/inbox/', '_blank')
      alert('Link copied. Open the client’s Instagram DM and paste to send.')
      notifyGroup(); flashSent(); return
    }

    // WhatsApp (default) — automatic via UltraMsg.
    const to = toWaNumber(client.phone, client.country)
    if (!to) { alert('This client has no phone / WhatsApp number on file.\nAdd a number first (EDIT).'); return }
    setSending(true)
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
      setSending(false)
    }
  }

  async function loadAll() {
    const { data: clientData } = await supabase.from('clients').select('*').eq('id', clientId).single()
    if (clientData) setClient(clientData)

    const { data: ridesData } = await supabase.from('rides').select('*').eq('client_id', clientId).order('project_code', { ascending: true })
    if (ridesData) setRides(ridesData)

    const { data: invoicesData } = await supabase.from('invoices').select('id, invoice_code, service, entry_date').eq('client_id', clientId).order('invoice_code', { ascending: true })
    if (invoicesData) setPersonalInvoices(invoicesData)

    setLoading(false)
  }

  // Format by country: US -> +1 (XXX) XXX-XXXX, Brazil -> +55 (XX) XXXXX.XXXX.
  function formatPhone(phone: string | null, country?: string | null) {
    if (!phone) return '-'
    const digits = phone.replace(/\D/g, '')
    const isBR = country === 'BRAZIL' || (!country && digits.startsWith('55') && digits.length > 11)
    if (isBR) {
      const local = digits.startsWith('55') ? digits.slice(2) : digits
      if (local.length === 11) return `+55 (${local.slice(0,2)})${local.slice(2,7)}.${local.slice(7)}`
      if (local.length === 10) return `+55 (${local.slice(0,2)})${local.slice(2,6)}.${local.slice(6)}`
      return phone
    }
    // US (default)
    const local = (digits.startsWith('1') && digits.length === 11) ? digits.slice(1) : digits
    if (local.length === 10) return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`
    return phone
  }

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  if (!client) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Client not found.</p></main>
  )

  const rowClass = 'flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-700 last:border-0'
  const labelClass = 'text-gray-400 font-bold'
  const sectionClass = 'bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">{client.name}</h1>
        <div className="flex gap-3">
          <button onClick={handleSendClient} disabled={sending || justSent} className={`disabled:opacity-60 px-6 py-4 rounded-2xl text-xl font-bold ${justSent ? 'bg-green-600' : 'bg-green-700 hover:bg-green-600'}`}>{sending ? 'SENDING…' : justSent ? '✓ SENT' : '📲 SEND CLIENT'}</button>
          <Link href="/clients" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/clients/edit/${clientId}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold">EDIT</Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* Contact */}
        <div>
          <label className="block mb-3 text-lg font-bold">CONTACT</label>
          <div className={sectionClass}>
            {client.phone && <div className={rowClass}><span className={labelClass}>PHONE</span><span className="font-bold">{formatPhone(client.phone, client.country)}</span></div>}
            {client.cpf && <div className={rowClass}><span className={labelClass}>CPF</span><span className="font-bold">{client.cpf}</span></div>}
            {client.email && <div className={rowClass}><span className={labelClass}>EMAIL</span><span className="font-bold">{client.email}</span></div>}
            {client.instagram && <div className={rowClass}><span className={labelClass}>INSTAGRAM</span><a href={`https://instagram.com/${client.instagram.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-400 hover:text-blue-300">{client.instagram.startsWith('@') ? client.instagram : `@${client.instagram}`}</a></div>}
            {client.preferred_message_method && <div className={rowClass}><span className={labelClass}>PREFERRED MESSAGE METHOD</span><span className="font-bold">{client.preferred_message_method}</span></div>}
          </div>
        </div>

        {/* Address */}
        {(client.address || client.city || client.state || client.zip || client.country) && (
          <div>
            <label className="block mb-3 text-lg font-bold">ADDRESS</label>
            <div className={sectionClass}>
              {client.address && <div className={rowClass}><span className={labelClass}>STREET</span><span className="font-bold">{client.address}</span></div>}
              {(client.city || client.state) && <div className={rowClass}><span className={labelClass}>CITY / ST</span><span className="font-bold">{[client.city, client.state].filter(Boolean).join(' / ')}{client.zip ? ` ${client.zip}` : ''}</span></div>}
              {client.country && <div className={rowClass}><span className={labelClass}>COUNTRY</span><span className="font-bold">{client.country}</span></div>}
            </div>
          </div>
        )}

        {/* Rides */}
        <div>
          <label className="block mb-3 text-lg font-bold">RIDES ({rides.length})</label>
          {rides.length === 0 ? (
            <p className="text-gray-400 text-xl">No rides linked to this client yet.</p>
          ) : (
            <div className={sectionClass}>
              {rides.map((ride, index) => (
                <Link
                  key={ride.id}
                  href={`/rides/${ride.id}/invoices`}
                  className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-800 transition-colors ${index < rides.length - 1 ? 'border-b border-gray-700' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold">{ride.project_code}{ride.project_name ? ` — ${ride.project_name}` : ''}</p>
                    <p className="text-sm text-gray-400">
                      {[ride.manufacturer, ride.brand, ride.model, ride.year].filter(Boolean).join(' ')}
                      {ride.color ? ` — ${ride.color}` : ''}
                      {ride.plate ? ` — ${ride.plate}` : ''}
                    </p>
                  </div>
                  <span className="text-gray-400 font-bold text-sm shrink-0">INVOICES →</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Shopping Invoices */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-lg font-bold">{(client as any).is_quote ? 'SHOPPING QUOTES' : 'SHOPPING INVOICES'} ({personalInvoices.length})</label>
            <Link href={`/clients/${clientId}/invoices`} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-2xl font-bold text-sm">OPEN</Link>
          </div>
          {personalInvoices.length === 0 ? (
            <p className="text-gray-400 text-xl">No shopping invoices yet.</p>
          ) : (
            <div className={sectionClass}>
              {personalInvoices.map((inv, index) => (
                <Link
                  key={inv.id}
                  href={`/clients/${clientId}/invoices/${inv.id}`}
                  className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-800 transition-colors ${index < personalInvoices.length - 1 ? 'border-b border-gray-700' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold">{inv.invoice_code}</p>
                    {inv.service && <p className="text-sm text-gray-400">{inv.service}</p>}
                  </div>
                  <span className="text-gray-400 font-bold text-sm shrink-0">VIEW →</span>
                </Link>
              ))}
            </div>
          )}
        </div>

      </div>
    </main>
  )
}
