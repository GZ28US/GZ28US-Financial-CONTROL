'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */
// /ca/doc/new — NEW QUOTE v2 (QUOTE PORTAL M3, 06/11/2026; blueprint §2.2, §6.1). CLIENT → CAR → START FROM → CREATE → /doc/<id>.
// CLIENT: search the PROJECT clients, or + NEW LEAD (name, phone/e-mail, country, preferred channel → a new QUOTE client).
// CAR: one of the client's cars, a client-level quote (no car), or + NEW CAR in the legacy ride form (the car catalog lives there).
// START FROM: BLANK · DUPLICATE (items/services/notes + forecast expenses; never money) — both created by POST /api/doc/new;
// PACK hands off to the legacy NEW page (the pack engine: MAP×margin, add-ons, BRL→USD) with ?from=doc, which comes back to /doc/<id>.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, clientCode } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

const box = 'bg-gray-950 border border-gray-800 rounded-xl p-3'
const inp = 'w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm'
const pill = (on: boolean) => `px-3 py-2 rounded text-sm font-semibold ${on ? 'bg-white text-black' : 'bg-gray-900 text-gray-300'}`

export default function DocNew() {
  const router = useRouter()
  const [clients, setClients] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [client, setClient] = useState<any | null>(null)
  const [lead, setLead] = useState<any | null>(null)
  const [rides, setRides] = useState<any[]>([])
  const [ride, setRide] = useState<string | null | undefined>(undefined)   // undefined = not chosen · null = no car
  const [start, setStart] = useState<'blank' | 'pack' | 'duplicate'>('blank')
  const [docs, setDocs] = useState<any[]>([])
  const [dq, setDq] = useState('')
  const [fromId, setFromId] = useState('')
  const [service, setService] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('clients').select('id, name, client_number, is_quote, origin, phone, email, country').neq('origin', 'SHOP').order('is_quote').order('client_number', { ascending: false })
    setClients(data || [])
  })() }, [])
  useEffect(() => { void (async () => {
    setRides([])
    if (!client?.id) return
    const { data } = await supabase.from('rides').select('id, project_code, project_name, brand, model, year, is_quote').eq('client_id', client.id).neq('origin', 'SHOP').order('project_code')
    setRides(data || [])
  })() }, [client])
  useEffect(() => { void (async () => {
    if (start !== 'duplicate' || docs.length) return
    const { data } = await supabase.from('invoices').select('id, invoice_code, service, is_quote, updated_at').eq('origin', 'PROJECT').order('updated_at', { ascending: false, nullsFirst: false }).limit(400)
    setDocs(data || [])
  })() }, [start, docs.length])

  const shown = useMemo(() => clients.filter(c => !q || `${clientCode(c)} ${c.name} ${c.phone || ''} ${c.email || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30), [clients, q])
  const docShown = docs.filter(d => !dq || `${d.invoice_code} ${d.service || ''}`.toLowerCase().includes(dq.toLowerCase())).slice(0, 25)
  const who = client || lead
  const ready = !!who && (lead ? !!lead.name?.trim() : true) && ride !== undefined && (start !== 'duplicate' || !!fromId) && (start !== 'pack' || !!ride)

  async function create() {
    if (!ready || busy) return
    if (start === 'pack') { router.push(`/rides/${ride}/invoices/new?mode=quote&from=doc`); return }
    setBusy(true); setMsg('')
    const r = await fetch(`${BASE_PATH}/api/doc/new`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({
      client_id: client?.id, lead: client ? undefined : lead, ride_id: ride || null, start, from_id: start === 'duplicate' ? fromId : undefined, service: service || undefined }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setMsg('✖ ' + (j.error || `HTTP ${r.status}`)); return }
    router.push(`/doc/${j.id}`)
  }

  return <div className="min-h-screen bg-black text-white pb-32"><Header />
    <div className="max-w-xl mx-auto px-4 py-4 space-y-4">
      <div className="flex items-center gap-3 text-sm text-gray-400"><Link href="/doc" className="underline">← QUOTES v2</Link></div>
      <h1 className="text-xl font-bold">NEW QUOTE</h1>

      <section className={box}>
        <div className="text-xs font-bold text-gray-400 mb-2">1 · CLIENT</div>
        {who ? <div className="flex justify-between items-center text-sm">
          <span>{client ? `${clientCode(client)} — ${client.name}` : `NEW LEAD — ${lead.name || '…'}`}</span>
          <button className="text-xs underline text-gray-400" onClick={() => { setClient(null); setLead(null); setRide(undefined) }}>change</button></div>
        : <>
          <input className={inp} placeholder="🔍 name, code, phone, e-mail" value={q} onChange={e => setQ(e.target.value)} />
          <div className="mt-2 max-h-64 overflow-y-auto">{shown.map(c => <button key={c.id} onClick={() => setClient(c)} className="block w-full text-left text-sm py-2 border-b border-gray-900 hover:bg-gray-900">
            {clientCode(c)} — {c.name}<span className="text-gray-500">{c.country ? ' · ' + c.country : ''}</span></button>)}</div>
          <button className="mt-2 text-sm underline text-emerald-400" onClick={() => { setLead({ name: q, country: 'USA', preferred_message_method: 'WHATSAPP' }); setRide(null) }}>+ NEW LEAD{q ? ` «${q}»` : ''}</button>
        </>}
        {lead && <div className="mt-3 grid grid-cols-2 gap-2">
          <input className={inp + ' col-span-2'} placeholder="name" value={lead.name || ''} onChange={e => setLead({ ...lead, name: e.target.value })} />
          <input className={inp} placeholder="phone" value={lead.phone || ''} onChange={e => setLead({ ...lead, phone: e.target.value })} />
          <input className={inp} placeholder="e-mail" value={lead.email || ''} onChange={e => setLead({ ...lead, email: e.target.value })} />
          <select className={inp} value={lead.country || ''} onChange={e => setLead({ ...lead, country: e.target.value })}>{['USA', 'BRAZIL', 'ANGOLA', 'ENGLAND', 'CANADA', 'MEXICO', 'OTHER'].map(x => <option key={x}>{x}</option>)}</select>
          <select className={inp} value={lead.preferred_message_method || ''} onChange={e => setLead({ ...lead, preferred_message_method: e.target.value })}>{['WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'EMAIL', 'SMS'].map(x => <option key={x}>{x}</option>)}</select>
          <p className="col-span-2 text-[11px] text-gray-500">A lead is born a QUOTE client (US.QT.###). Nothing is sent to them.</p>
        </div>}
      </section>

      {who && <section className={box}>
        <div className="text-xs font-bold text-gray-400 mb-2">2 · CAR</div>
        <div className="flex flex-col gap-1">
          {rides.map(r => <button key={r.id} onClick={() => setRide(r.id)} className={pill(ride === r.id) + ' text-left'}>{r.project_code}{r.project_name ? ` — ${r.project_name}` : ''} <span className="text-gray-500">{[r.year, r.brand, r.model].filter(Boolean).join(' ')}</span></button>)}
          <button onClick={() => { setRide(null); if (start === 'pack') setStart('blank') }} className={pill(ride === null) + ' text-left'}>no car (client-level quote)</button>
          {client && <Link href={`/rides/new?mode=quote`} className="text-sm underline text-emerald-400 mt-1">+ NEW CAR (ride form, then come back) →</Link>}
          {lead && <p className="text-[11px] text-gray-500">A new lead has no cars yet: create the quote now, add the car later.</p>}
        </div>
      </section>}

      {who && ride !== undefined && <section className={box}>
        <div className="text-xs font-bold text-gray-400 mb-2">3 · START FROM</div>
        <div className="flex gap-2 flex-wrap">
          <button className={pill(start === 'blank')} onClick={() => setStart('blank')}>BLANK</button>
          <button className={pill(start === 'pack') + (ride ? '' : ' opacity-40')} disabled={!ride} onClick={() => setStart('pack')}>PACK</button>
          <button className={pill(start === 'duplicate')} onClick={() => setStart('duplicate')}>DUPLICATE</button>
        </div>
        {start === 'blank' && <input className={inp + ' mt-3'} placeholder="service (e.g. Z2000 Typhon Package)" value={service} onChange={e => setService(e.target.value)} />}
        {start === 'pack' && <p className="mt-3 text-xs text-gray-400">Opens the pack picker for this car (packs zone US, CLOSED, matching the car; add-ons on top). After CREATE it comes back here, to the document page.</p>}
        {start === 'duplicate' && <div className="mt-3">
          <input className={inp} placeholder="🔍 code or service to copy" value={dq} onChange={e => setDq(e.target.value)} />
          <div className="mt-2 max-h-56 overflow-y-auto">{docShown.map(d => <button key={d.id} onClick={() => setFromId(d.id)} className={`block w-full text-left text-sm py-2 border-b border-gray-900 ${fromId === d.id ? 'bg-gray-800' : 'hover:bg-gray-900'}`}>
            {d.invoice_code} <span className="text-gray-500">{d.is_quote ? 'quote' : 'invoice'} · {d.service || ''}</span></button>)}</div>
          <p className="text-[11px] text-gray-500 mt-1">Copies items, services, notes and the forecast (unpaid) expenses — never incomes, paid expenses, approvals or links.</p>
        </div>}
      </section>}

      {msg && <div className="text-sm bg-gray-900 border border-gray-700 rounded p-2">{msg}</div>}
    </div>
    <div className="fixed bottom-0 inset-x-0 bg-black/90 border-t border-gray-800 p-3 flex justify-center">
      <button disabled={!ready || busy} onClick={create} className="w-full max-w-xs min-h-[48px] rounded-lg bg-emerald-500 text-black font-bold disabled:opacity-40">{busy ? 'CREATING…' : start === 'pack' ? 'CHOOSE THE PACK →' : 'CREATE QUOTE'}</button>
    </div>
  </div>
}
