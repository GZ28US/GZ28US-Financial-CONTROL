'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { clientCode } from '@/lib/utils'

// Modal used by the global INVOICES / QUOTES lists: pick a CLIENT, then one of that
// client's RIDES, then jump to that ride's invoice/quote creation page.
//   type='invoice' -> project clients & project rides, creates an invoice
//   type='quote'   -> any client & any of their rides, creates a quote (?mode=quote)
export default function DocPicker({ type, onClose }: { type: 'invoice' | 'quote'; onClose: () => void }) {
  const router = useRouter()
  const [clients, setClients] = useState<any[]>([])
  const [rides, setRides] = useState<any[]>([])
  const [clientId, setClientId] = useState('')
  const [rideId, setRideId] = useState('')

  useEffect(() => {
    void (async () => {
      let q: any = supabase.from('clients').select('id, name, client_number, is_quote')
      if (type === 'invoice') q = q.eq('is_quote', false)
      // Project clients (is_quote=false) first, then quote clients — each by number.
      const { data } = await q.order('is_quote', { ascending: true }).order('client_number', { ascending: true })
      setClients(data || [])
    })()
  }, [type])

  useEffect(() => {
    setRideId('')
    if (!clientId) { setRides([]); return }
    void (async () => {
      let q: any = supabase.from('rides').select('id, project_code, project_name, is_quote').eq('client_id', clientId)
      if (type === 'invoice') q = q.eq('is_quote', false)
      // Project rides first, then quote rides — each by code.
      const { data } = await q.order('is_quote', { ascending: true }).order('project_code', { ascending: true })
      setRides(data || [])
    })()
  }, [clientId, type])

  function create() {
    if (!rideId) return
    router.push(`/rides/${rideId}/invoices/new${type === 'quote' ? '?mode=quote' : ''}`)
  }

  const isQ = type === 'quote'
  const sel = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
        <h2 className="text-2xl font-bold">NEW {isQ ? 'QUOTE' : 'INVOICE'}</h2>
        <div>
          <label className="block mb-1 text-sm text-gray-400 font-bold">CLIENT</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={sel}>
            <option value="">Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{clientCode(c)} — {c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-sm text-gray-400 font-bold">RIDE</label>
          <select value={rideId} onChange={(e) => setRideId(e.target.value)} disabled={!clientId} className={`${sel} disabled:opacity-50`}>
            <option value="">{!clientId ? 'Pick a client first' : rides.length ? 'Select a ride…' : 'This client has no rides'}</option>
            {rides.map((r) => <option key={r.id} value={r.id}>{r.project_code}{r.project_name ? ` — ${r.project_name}` : ''}</option>)}
          </select>
        </div>
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="bg-gray-600 hover:bg-gray-500 px-6 py-3 rounded-2xl font-bold">CANCEL</button>
          <button onClick={create} disabled={!rideId} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">CREATE</button>
        </div>
      </div>
    </div>
  )
}
