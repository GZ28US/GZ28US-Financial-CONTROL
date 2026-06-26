'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const LANG: 'en' | 'pt' = 'en'

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
  const [sending, setSending] = useState(false)
  const [justSent, setJustSent] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
      setS((data || null) as FixedCostSupplier | null)
      setLoading(false)
    })()
  }, [id])

  // SEND TO — send the supplier a link to their OWN self-service form
  // (/costs/fixed/self/[id]) so they fill in their details and save. Delivered by
  // the supplier's PREFERRED contact (WhatsApp auto via UltraMsg; Email/Phone open
  // the local composer). A note is mirrored to the REPORTS group either way.
  async function handleSend() {
    if (!s) return
    const method = s.preferred_contact || 'WhatsApp'
    const link = `${window.location.origin}${BASE_PATH}/costs/fixed/self/${id}`
    const firstName = (s.contact_name || '').split(' ')[0]
    const waBody = LANG === 'pt'
      ? `Olá${firstName ? ` ${firstName}` : ''}! 👋\n\nPor favor, preencha os dados da sua empresa para a *_GZ28 V8 SpeedShop_* neste link e toque em *SALVAR*:\n\n${link}\n\nObrigado!`
      : `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nPlease fill in your company's details for *_GZ28 V8 SpeedShop_* at this link and tap *SAVE*:\n\n${link}\n\nThank you!`
    const plain = waBody.replace(/[*_]/g, '')
    const flashSent = () => { setJustSent(true); setTimeout(() => setJustSent(false), 3000) }
    const label = s.company || s.description || '—'
    const notifyGroup = () => { void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📤 *FIXED COST SUPPLIER FORM — LINK SENT*\n${label}\nThe system sent the registration link to the supplier (via ${method}). Awaiting them to fill in their details.` }),
    }).catch(() => {}) }

    if (method === 'Email') {
      if (!s.email) { alert('This supplier has no email on file.\nAdd an email first (EDIT).'); return }
      const subject = LANG === 'pt' ? 'Complete seu cadastro — GZ28 V8 SpeedShop' : 'Complete your details — GZ28 V8 SpeedShop'
      window.location.href = `mailto:${s.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      notifyGroup(); flashSent(); return
    }
    if (method === 'Phone') {
      if (!s.phone) { alert('This supplier has no phone on file.\nAdd a number first (EDIT).'); return }
      window.location.href = `sms:${s.phone}?&body=${encodeURIComponent(plain)}`
      notifyGroup(); flashSent(); return
    }

    // WhatsApp (default) — automatic via UltraMsg.
    const to = (s.phone || '').replace(/\D/g, '')
    if (!to) { alert('This supplier has no WhatsApp / phone number on file.\nAdd a number first (EDIT).'); return }
    setSending(true)
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body: waBody }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) { alert('Could not send the link:\n' + (data?.error || `HTTP ${res.status}`)); return }
      notifyGroup(); flashSent()
    } catch (e) {
      alert('Could not send the link:\n' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!s) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Not found.</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <Link href="/costs/fixed" className="text-gray-400 text-lg hover:text-white">← Fixed Cost Suppliers</Link>
        <div className="flex gap-3 flex-wrap">
          <button onClick={handleSend} disabled={sending || justSent} className={`disabled:opacity-60 px-6 py-3 rounded-2xl text-lg font-bold ${justSent ? 'bg-green-600' : 'bg-emerald-700 hover:bg-emerald-600'}`}>
            {sending ? 'SENDING…' : justSent ? '✓ SENT' : '📲 SEND TO SUPPLIER'}
          </button>
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
