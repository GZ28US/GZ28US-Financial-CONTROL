'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

type FixedCostSupplier = {
  id: string
  description: string | null
  company: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
}

export default function FixedCostSupplierViewPage() {
  const params = useParams()
  const id = String(params.id)
  const [s, setS] = useState<FixedCostSupplier | null>(null)
  const [loading, setLoading] = useState(true)
  const [sendOpen, setSendOpen] = useState(false)
  const [sendStatus, setSendStatus] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
      setS((data || null) as FixedCostSupplier | null)
      setLoading(false)
    })()
  }, [id])

  function messageBody() {
    if (!s) return ''
    return [
      '*Fixed Cost Supplier*',
      s.description ? s.description : null,
      s.company ? `Company: ${s.company}` : null,
      s.contact_name ? `Contact: ${s.contact_name}` : null,
      s.phone ? `Phone: ${s.phone}` : null,
      s.email ? `Email: ${s.email}` : null,
    ].filter(Boolean).join('\n')
  }

  // target: undefined -> reports group (default); a phone -> the supplier directly.
  async function sendTo(target: 'REPORT GROUP' | 'SUPPLIER') {
    setSendStatus('Sending…')
    const to = target === 'SUPPLIER' ? (s?.phone || '').replace(/\D/g, '') : undefined
    if (target === 'SUPPLIER' && !to) { setSendStatus('No phone on file for this supplier.'); return }
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(to ? { to, body: messageBody() } : { body: messageBody() }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setSendStatus(`Sent to ${target}. ✓`)
      setTimeout(() => { setSendOpen(false); setSendStatus('') }, 1800)
    } catch (e) {
      setSendStatus('Failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!s) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Not found.</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {sendOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-1">SEND TO</h2>
            <p className="text-gray-400 mb-6">Choose where to send this fixed cost supplier.</p>
            <div className="flex flex-col gap-3">
              <button onClick={() => sendTo('REPORT GROUP')} className="bg-blue-700 hover:bg-blue-600 px-5 py-4 rounded-2xl font-bold text-xl text-left">📣 REPORT GROUP</button>
              <button onClick={() => sendTo('SUPPLIER')} disabled={!s.phone} className={`px-5 py-4 rounded-2xl font-bold text-xl text-left ${s.phone ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-700 text-gray-500 cursor-not-allowed'}`}>👤 SUPPLIER {s.phone ? '' : '(no phone)'}</button>
            </div>
            {sendStatus && <p className="mt-4 text-center text-lg font-bold">{sendStatus}</p>}
            <button onClick={() => { setSendOpen(false); setSendStatus('') }} className="mt-6 w-full bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">CLOSE</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <Link href="/costs/fixed" className="text-gray-400 text-lg hover:text-white">← Fixed Cost Suppliers</Link>
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => setSendOpen(true)} className="bg-emerald-700 hover:bg-emerald-600 px-6 py-3 rounded-2xl text-lg font-bold">SEND TO</button>
          <Link href={`/costs/fixed/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-3 rounded-2xl text-lg font-bold">EDIT</Link>
        </div>
      </div>

      <h1 className="text-4xl font-bold mb-2">{s.description || s.company || '—'}</h1>
      <span className="inline-block px-3 py-1 rounded-full text-sm font-bold bg-gray-700 mb-8">Preferred: {s.preferred_contact || 'WhatsApp'}</span>

      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 max-w-2xl space-y-3">
        <Row label="Company" value={s.company} />
        <Row label="Main Contact" value={s.contact_name} />
        <Row label="Phone" value={s.phone} />
        <Row label="Email" value={s.email} />
      </div>

      {/* EXPENSES listing — content to be defined */}
      <div className="mt-8 max-w-3xl">
        <h2 className="text-2xl font-bold mb-3">EXPENSES</h2>
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-3xl p-8 text-gray-500 text-lg">
          Expenses for this fixed cost supplier will appear here.
        </div>
      </div>
    </main>
  )
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-gray-800 pb-2 last:border-0">
      <span className="text-gray-400">{label}</span>
      <span className="font-bold text-right">{value || '—'}</span>
    </div>
  )
}
