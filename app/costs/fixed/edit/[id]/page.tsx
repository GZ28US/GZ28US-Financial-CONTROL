'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import LateFeeFields, { emptyLateFee, lateFeeFromRow, lateFeeToRow, type LateFeeForm } from '@/components/LateFeeFields'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const CONTACTS = ['WhatsApp', 'SMS', 'Email', 'Phone']
const PERIODICITY = ['SINGLE', 'DAILY', 'WEEKLY', 'MONTHLY', 'SEMIANNUAL', 'ANNUAL']
const COST_TYPES = ['FIXED', 'VARIABLE', 'APP', 'BANK', 'STAFF', 'FLEET', 'MARKETING', 'MERCHANDISE', 'ASSET']
// Nomes de exibição (26/ago): ASSET mostra EVENTS e MARKETING mostra
// ADVERTISEMENTS — o valor interno no banco não muda.
const COST_TYPE_LABEL: Record<string, string> = { ASSET: 'EVENTS', MARKETING: 'ADVERTISEMENTS' }
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function isNumeric(v: string) { return v === '' || /^-?\d*\.?\d*$/.test(v) }

export default function EditFixedCostSupplierPage() {
  const router = useRouter()
  const params = useParams()
  const id = String(params.id)
  const [description, setDescription] = useState('')
  const [company, setCompany] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [preferred, setPreferred] = useState('WhatsApp')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [periodicity, setPeriodicity] = useState('MONTHLY')
  const [costType, setCostType] = useState('FIXED')
  // ATIVAÇÃO (26/ago): traje sem contato/periodicidade/dias — ver fixed/new.
  const isActivation = ['ASSET', 'MARKETING', 'MERCHANDISE'].includes(costType)
  const [day1, setDay1] = useState('')
  const [amount1, setAmount1] = useState('')
  const [show2nd, setShow2nd] = useState(false)
  const [day2, setDay2] = useState('')
  const [amount2, setAmount2] = useState('')
  const [lateFee, setLateFee] = useState<LateFeeForm>(emptyLateFee)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('fixed_cost_suppliers').select('*').eq('id', id).maybeSingle()
      if (data) {
        setDescription(data.description || '')
        setCompany(data.company || '')
        setContactName(data.contact_name || '')
        setPhone(data.phone || '')
        setEmail(data.email || '')
        setPreferred(data.preferred_contact || 'WhatsApp')
        setStartDate(data.date_entry || '')
        setEndDate(data.date_conclusion || '')
        setPeriodicity(data.periodicity || 'MONTHLY')
        setCostType(data.cost_type || 'FIXED')
        setDay1(data.payment_day_1 != null ? String(data.payment_day_1) : '')
        setAmount1(data.amount_1 != null ? String(data.amount_1) : '')
        setDay2(data.payment_day_2 != null ? String(data.payment_day_2) : '')
        setAmount2(data.amount_2 != null ? String(data.amount_2) : '')
        if (data.payment_day_2 != null || data.amount_2 != null) setShow2nd(true)
        setLateFee(lateFeeFromRow(data))
      }
      setLoading(false)
    })()
  }, [id])

  async function save() {
    if (!description.trim() && !company.trim()) { alert('Enter at least a description or company'); return }
    setSaving(true)
    const { error } = await supabase.from('fixed_cost_suppliers').update({
      description: description.trim() || null,
      company: company.trim() || null,
      contact_name: contactName.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      preferred_contact: preferred,
      date_entry: isValidDate(startDate) ? startDate : null,
      date_conclusion: isValidDate(endDate) ? endDate : null,
      periodicity: isActivation ? 'SINGLE' : periodicity,
      cost_type: costType,
      payment_day_1: (!isActivation && day1 !== '') ? (parseInt(day1, 10) || null) : null,
      amount_1: (!isActivation && amount1 !== '') ? (parseFloat(amount1) || 0) : null,
      payment_day_2: (!isActivation && show2nd && day2 !== '') ? (parseInt(day2, 10) || null) : null,
      amount_2: (!isActivation && show2nd && amount2 !== '') ? (parseFloat(amount2) || 0) : null,
      // MULTA POR ATRASO — cláusula do contrato, não do boleto (ver lib/lateFee.ts).
      // Ativação não tem vencimento, logo não tem multa: zera os cinco.
      ...(isActivation ? { late_grace_days: null, late_fee_fixed: null, late_fee_percent: null, late_fee_daily: null, late_fee_daily_cap_days: null } : lateFeeToRow(lateFee)),
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) { alert(error.message); setSaving(false); return }
    router.push(isActivation ? `/costs/assets/${id}` : costType === 'APP' ? `/costs/apps/${id}` : `/costs/fixed/${id}`)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-32">
      <Header />
      <h1 className="text-4xl font-bold mb-8">{isActivation ? 'EDIT ACTIVATION' : 'EDIT FIXED COST SUPPLIER'}</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <Field label="DESCRIPTION" value={description} onChange={setDescription} />
        <Field label="COMPANY" value={company} onChange={setCompany} />
        {!isActivation && (<>
        <Field label="MAIN CONTACT NAME" value={contactName} onChange={setContactName} />
        <Field label="PHONE" value={phone} onChange={setPhone} placeholder="+1 555 000 0000" />
        <Field label="EMAIL" value={email} onChange={setEmail} type="email" />
        <div>
          <label className="block mb-2 text-lg font-bold">PREFERRED CONTACT</label>
          <select value={preferred} onChange={(e) => setPreferred(e.target.value)} className={inputClass}>
            {CONTACTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        </>)}

        <div className="border-t border-gray-800 pt-5 mt-2">
          <h2 className="text-2xl font-bold mb-4">{isActivation ? 'ACTIVATION WINDOW' : 'PAYMENT SCHEDULE'}</h2>
          <div className="grid grid-cols-1 gap-5">
            <DatePicker label={isActivation ? 'ACTIVATION START' : 'START DATE'} value={startDate} onChange={setStartDate} />
            {!isActivation && (
            <div>
              <label className="block mb-2 text-sm text-gray-400 font-bold">PAYMENT PERIODICITY</label>
              <select value={periodicity} onChange={(e) => setPeriodicity(e.target.value)} className={inputClass}>
                {PERIODICITY.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            )}
            <div>
              <label className="block mb-2 text-sm text-gray-400 font-bold">DRE BUCKET <span className="font-normal">— em que linha do DRE/DFC este fornecedor entra (não muda a recorrência)</span></label>
              <select value={costType} onChange={(e) => setCostType(e.target.value)} className={inputClass}>
                {COST_TYPES.map((t) => <option key={t} value={t}>{COST_TYPE_LABEL[t] || t}</option>)}
              </select>
            </div>
            {!isActivation && (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-4">
              <div className="flex gap-3 items-end flex-wrap">
                <div className="w-28">
                  <label className="block mb-2 text-sm text-gray-400 font-bold">DAY</label>
                  <select value={day1} onChange={(e) => setDay1(e.target.value)} className={inputClass}>
                    <option value="">—</option>
                    {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-[10rem]">
                  <label className="block mb-2 text-sm text-gray-400 font-bold">AMOUNT</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
                    <input type="text" inputMode="decimal" value={amount1} onChange={(e) => { if (isNumeric(e.target.value)) setAmount1(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
                  </div>
                </div>
                {!show2nd && <button onClick={() => setShow2nd(true)} className="bg-blue-700 hover:bg-blue-600 px-5 py-4 rounded-2xl font-bold whitespace-nowrap">+ ADD 2ND</button>}
              </div>
              {show2nd && (
                <div className="flex gap-3 items-end flex-wrap">
                  <div className="w-28">
                    <label className="block mb-2 text-sm text-gray-400 font-bold">DAY</label>
                    <select value={day2} onChange={(e) => setDay2(e.target.value)} className={inputClass}>
                      <option value="">—</option>
                      {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[10rem]">
                    <label className="block mb-2 text-sm text-gray-400 font-bold">AMOUNT</label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl">$</span>
                      <input type="text" inputMode="decimal" value={amount2} onChange={(e) => { if (isNumeric(e.target.value)) setAmount2(e.target.value) }} className={`${inputClass} pl-12`} placeholder="0.00" />
                    </div>
                  </div>
                  <button onClick={() => { setShow2nd(false); setDay2(''); setAmount2('') }} className="bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold whitespace-nowrap">Remove</button>
                </div>
              )}
            </div>
            )}
            {!isActivation && <LateFeeFields value={lateFee} onChange={setLateFee} sampleAmount={parseFloat(amount1) || 0} dueDay={parseInt(day1, 10) || 1} />}
            <DatePicker label={isActivation ? 'ACTIVATION END' : 'END DATE'} value={endDate} onChange={setEndDate} />
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur border-t border-gray-800 p-4 z-40">
        <div className="max-w-2xl mx-auto px-8 flex items-center gap-6">
          <a href={`${BASE_PATH}/costs/fixed/${id}`} className="text-gray-400 text-xl">Cancel</a>
          <button onClick={save} disabled={saving} className={`flex-1 px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
            {saving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </main>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className="block mb-2 text-lg font-bold">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl" />
    </div>
  )
}
