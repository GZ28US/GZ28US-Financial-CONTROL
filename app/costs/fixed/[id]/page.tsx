'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatPhone, formatUSD } from '@/lib/utils'

const LANG: 'en' | 'pt' = 'en'
const EXPENSE_TYPES = ['MONTHLY', 'WEEKLY', 'DAILY', 'SINGLE']
function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtExpDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }

type FixedExpense = { id: string; type: string; description: string | null; amount: number; source: string | null; expense_date: string | null }

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
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState('')

  // Fixed-cost expenses for this supplier (recurring, like staff costs).
  const [expenses, setExpenses] = useState<FixedExpense[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [savingExp, setSavingExp] = useState(false)
  const [neType, setNeType] = useState('MONTHLY')
  const [neDesc, setNeDesc] = useState('')
  const [neAmount, setNeAmount] = useState('')
  const [neSource, setNeSource] = useState(DEFAULT_SOURCE)
  const [neDate, setNeDate] = useState('')

  async function loadExpenses() {
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('supplier_id', id).order('created_at', { ascending: false })
    setExpenses((data || []) as FixedExpense[])
  }

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
      setS((data || null) as FixedCostSupplier | null)
      await loadExpenses()
      setLoading(false)
    })()
  }, [id])

  async function addExpense() {
    if (!neAmount) { alert('Please enter an amount'); return }
    setSavingExp(true)
    const { error } = await supabase.from('fixed_cost_expenses').insert([{
      supplier_id: id,
      type: neType,
      description: neDesc || null,
      amount: parseFloat(neAmount) || 0,
      source: neSource || DEFAULT_SOURCE,
      expense_date: (neType === 'SINGLE' && isValidDate(neDate)) ? neDate : null,
    }])
    setSavingExp(false)
    if (error) { alert(error.message); return }
    setNeType('MONTHLY'); setNeDesc(''); setNeAmount(''); setNeSource(DEFAULT_SOURCE); setNeDate(''); setAddOpen(false)
    loadExpenses()
  }

  async function removeExpense(eid: string) {
    await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    loadExpenses()
  }

  function openSend() { setSendStatus(''); setSendOpen(true) }

  // SUPPLIER — send them a link to their OWN self-service form (/costs/fixed/self/[id])
  // so they fill in their details and save. Delivered by the supplier's PREFERRED
  // contact (WhatsApp auto via UltraMsg; Email/Phone open the local composer).
  async function sendToSupplier() {
    if (!s) return
    setSendStatus('')
    const method = s.preferred_contact || 'WhatsApp'
    const link = `${window.location.origin}${BASE_PATH}/costs/fixed/self/${id}`
    const firstName = (s.contact_name || '').split(' ')[0]
    const waBody = LANG === 'pt'
      ? `Olá${firstName ? ` ${firstName}` : ''}! 👋\n\nPor favor, preencha seus dados neste link e toque em *SALVAR*:\n\n${link}\n\nObrigado!`
      : `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nPlease fill in your details at this link and tap *SAVE*:\n\n${link}\n\nThank you!`
    const plain = waBody.replace(/[*_]/g, '')
    const label = s.company || s.contact_name || s.description || '—'
    const notifyGroup = () => { void fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📤 *FIXED COST SUPPLIER FORM — LINK SENT*\n${label}\nThe system sent the registration link to the supplier (via ${method}). Awaiting them to fill in their details.` }),
    }).catch(() => {}) }

    if (method === 'Email') {
      if (!s.email) { setSendStatus('No email on file. Add one first (EDIT).'); return }
      const subject = LANG === 'pt' ? 'Complete seu cadastro — GZ28 V8 SpeedShop' : 'Complete your details — GZ28 V8 SpeedShop'
      window.location.href = `mailto:${s.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      notifyGroup(); setSendStatus('✓ Email composer opened.'); return
    }
    if (method === 'Phone') {
      if (!s.phone) { setSendStatus('No phone on file. Add one first (EDIT).'); return }
      window.location.href = `sms:${s.phone}?&body=${encodeURIComponent(plain)}`
      notifyGroup(); setSendStatus('✓ SMS composer opened.'); return
    }

    // WhatsApp (default) — automatic via UltraMsg.
    const to = (s.phone || '').replace(/\D/g, '')
    if (!to) { setSendStatus('No WhatsApp / phone on file. Add one first (EDIT).'); return }
    setSending(true); setSendStatus('Sending…')
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body: waBody }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok) { notifyGroup(); setSendStatus('✓ Link sent to the supplier on WhatsApp.') }
      else setSendStatus('Could not send: ' + (data?.error || `HTTP ${res.status}`))
    } catch (e) {
      setSendStatus('Could not send: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  // REPORT GROUP — send the team a summary of this supplier (internal, no `to`).
  async function sendToGroup() {
    if (!s) return
    setSendStatus('')
    const body = `📋 *FIXED COST SUPPLIER*\n${s.description || s.company || '—'}\n\nCompany: ${s.company || '—'}\nContact: ${s.contact_name || '—'}\nPhone: ${s.phone || '—'}\nEmail: ${s.email || '—'}\nPreferred: ${s.preferred_contact || 'WhatsApp'}`
    setSending(true); setSendStatus('Sending…')
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const data = await res.json().catch(() => ({}))
      setSendStatus(data.ok ? '✓ Sent to the report group.' : 'Could not send: ' + (data?.error || `HTTP ${res.status}`))
    } catch (e) {
      setSendStatus('Could not send: ' + (e instanceof Error ? e.message : String(e)))
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
          <button onClick={openSend} className="bg-emerald-700 hover:bg-emerald-600 px-6 py-3 rounded-2xl text-lg font-bold">📤 SEND TO</button>
          <Link href={`/costs/fixed/edit/${s.id}`} className="bg-blue-700 hover:bg-blue-600 px-6 py-3 rounded-2xl text-lg font-bold">EDIT</Link>
        </div>
      </div>

      <h1 className="text-4xl font-bold mb-2">{s.description || s.company || '—'}</h1>
      <span className="inline-block px-3 py-1 rounded-full text-sm font-bold bg-gray-700 mb-8">Preferred: {s.preferred_contact || 'WhatsApp'}</span>

      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 max-w-2xl space-y-3">
        <Row label="Company" value={s.company} />
        <Row label="Main Contact" value={s.contact_name} />
        <Row label="Phone" value={formatPhone(s.phone) || null} />
        <Row label="Email" value={s.email} />
      </div>

      {/* EXPENSES — recurring fixed costs for this supplier (TYPE drives recurrence). */}
      <div id="expenses" className="mt-8 max-w-3xl scroll-mt-8">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-2xl font-bold">EXPENSES</h2>
          <button onClick={() => setAddOpen(o => !o)} className="bg-green-700 hover:bg-green-600 px-5 py-2 rounded-2xl font-bold">{addOpen ? '✕ CANCEL' : '+ ADD EXPENSE'}</button>
        </div>

        {addOpen && (
          <div className="bg-gray-900 border border-blue-700 rounded-3xl p-5 mb-4 space-y-3">
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-[8rem]">
                <label className="block mb-1 text-xs text-gray-400">TYPE</label>
                <select value={neType} onChange={(e) => setNeType(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
                  {EXPENSE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex-[2] min-w-[12rem]">
                <label className="block mb-1 text-xs text-gray-400">DESCRIPTION</label>
                <input type="text" value={neDesc} onChange={(e) => setNeDesc(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2" placeholder="e.g. Rent, Internet…" />
              </div>
              <div className="w-32">
                <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
                <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="text" inputMode="decimal" value={neAmount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setNeAmount(e.target.value) }} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 pl-9" placeholder="0.00" />
                </div>
              </div>
            </div>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-xs text-gray-400">PAID FROM</label>
                <SourceSelect value={neSource} onChange={setNeSource} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2" />
              </div>
              {neType === 'SINGLE' && (
                <div className="flex-1 min-w-[14rem]">
                  <DatePicker label="DATE" value={neDate} onChange={setNeDate} compact />
                </div>
              )}
            </div>
            <button onClick={addExpense} disabled={savingExp} className="bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-2 rounded-2xl font-bold">{savingExp ? 'Saving…' : 'SAVE EXPENSE'}</button>
          </div>
        )}

        {expenses.length === 0 ? (
          <div className="bg-gray-900 border border-dashed border-gray-700 rounded-3xl p-8 text-gray-500 text-lg">No expenses yet. Use ADD EXPENSE to add one.</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl divide-y divide-gray-800">
            {expenses.map(e => (
              <div key={e.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-700 text-gray-200">{e.type}</span>
                    <span className="font-bold truncate">{e.description || '—'}</span>
                  </div>
                  <p className="text-sm text-gray-400">{formatUSD(e.amount)}{e.source ? ` · ${e.source}` : ''}{e.expense_date ? ` · ${fmtExpDate(e.expense_date)}` : ''}</p>
                </div>
                <button onClick={() => removeExpense(e.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-xl font-bold text-sm shrink-0">REMOVE</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SEND TO box — who do you want to send to? */}
      {sendOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50" onClick={() => setSendOpen(false)}>
          <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold mb-1">SEND TO</h2>
            <p className="text-gray-400 mb-5">Who do you want to send to?</p>
            <div className="grid grid-cols-1 gap-3">
              <button onClick={sendToSupplier} disabled={sending} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 px-6 py-4 rounded-2xl text-lg font-bold text-left">
                👤 SUPPLIER <span className="block text-sm font-normal text-emerald-100/80">Send a link to fill in their own details</span>
              </button>
              <button onClick={sendToGroup} disabled={sending} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-60 px-6 py-4 rounded-2xl text-lg font-bold text-left">
                📣 REPORT GROUP <span className="block text-sm font-normal text-blue-100/80">Send this supplier's details to the team</span>
              </button>
            </div>
            {sendStatus && <p className="mt-4 text-center text-gray-300">{sendStatus}</p>}
            <button onClick={() => setSendOpen(false)} className="mt-5 w-full text-gray-400 hover:text-white py-2">Close</button>
          </div>
        </div>
      )}
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
