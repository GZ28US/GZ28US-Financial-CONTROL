'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { MILESTONES, MILESTONE_LABEL, MOVEMENT_KINDS, PARTIES, PARTY_LABEL, dealDate, dealPositions, movementUnallocated } from '@/lib/carDeals'

// CAR DEAL (21/11/2026) — uma compra de carro. Abas: SUMMARY (posições, custos, obrigações) · MOVEMENTS (o livro:
// proposta → alocar → confirmar) · MILESTONES (marcar o marco torna DUE a obrigação condicionada a ele).
// O robô e a planilha no layout do Tripa entram nas etapas seguintes; aqui NADA é postado em lugar nenhum.

const inp = 'bg-black border border-gray-700 rounded-xl px-3 py-2 text-base'
const btn = 'px-4 py-2 rounded-xl font-bold'
const num = (v: any) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function CarDealPage() {
  const dealId = String(useParams().id)
  const [tab, setTab] = useState<'SUMMARY' | 'MOVEMENTS' | 'TRIPA SHEET' | 'MILESTONES'>('SUMMARY')
  const [sheet, setSheet] = useState<any>(null)
  const [sheetBusy, setSheetBusy] = useState('')
  const [deal, setDeal] = useState<any>(null)
  const [form, setForm] = useState<any>({})
  const [allDeals, setAllDeals] = useState<any[]>([])
  const [charges, setCharges] = useState<any[]>([])
  const [obligations, setObligations] = useState<any[]>([])
  const [movements, setMovements] = useState<any[]>([])
  const [allocations, setAllocations] = useState<any[]>([])
  const [milestones, setMilestones] = useState<any[]>([])
  const [clientName, setClientName] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [newCharge, setNewCharge] = useState({ label: '', value: '' })
  const [newOb, setNewOb] = useState<any>({ from_party: 'SIDNEY', to_party: 'TRIPA_TRADING', label: '', amount: '', due_date: '', trigger_milestone: '', offset: '' })
  const [newMov, setNewMov] = useState<any>({ occurred_on: today(), kind: 'WIRE', from_party: 'SIDNEY', to_party: 'GZ28US', amount_usd: '', amount_brl: '', fx_rate: '', counterparty_label: '', payer_label: '', fiscal_ref: '', note: '' })
  const [newAlloc, setNewAlloc] = useState<Record<string, { deal_id: string; amount: string }>>({})

  useEffect(() => { load() }, [])
  useEffect(() => { if (tab === 'TRIPA SHEET') loadSheet() }, [tab])

  // PLANILHA TRIPA: a grade vem pronta da rota (a mesma que gera o Excel e o PDF) — a prévia é o que vai no arquivo.
  async function loadSheet() {
    setSheet(null)
    const r = await fetch(`${BASE_PATH}/api/car-deals/sheet?deal=${dealId}&format=json`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    setSheet(r.ok ? j : { error: j.error || `HTTP ${r.status}` })
  }
  async function downloadSheet(format: 'xlsx' | 'pdf') {
    setSheetBusy(format)
    try {
      const r = await fetch(`${BASE_PATH}/api/car-deals/sheet?deal=${dealId}&format=${format}`, { headers: await sessionHeaders() })
      if (!r.ok) { alert(`Could not generate the ${format.toUpperCase()}: HTTP ${r.status}`); return }
      const a = document.createElement('a')
      a.href = URL.createObjectURL(await r.blob()); a.download = `${sheet?.fileName || 'car-deal'}.${format}`; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } finally { setSheetBusy('') }
  }

  async function load() {
    const { data: d } = await supabase.from('car_deals')
      .select('*, rides(id, project_code, project_name, vin, color, year, model, version), invoices:purchase_invoice_id(id, invoice_code, service)')
      .eq('id', dealId).single()
    const [ad, ch, ob, al, ms] = await Promise.all([
      supabase.from('car_deals').select('id, deal_no, rides(project_name)').order('deal_no'),
      supabase.from('deal_charges').select('*').eq('deal_id', dealId).order('position'),
      supabase.from('deal_obligations').select('*').eq('deal_id', dealId).order('created_at'),
      supabase.from('deal_allocations').select('*'),
      supabase.from('deal_milestones').select('*').eq('deal_id', dealId),
    ])
    // movimentos: os alocados a este deal + todo PROPOSED (a caixa de entrada é uma só para todos os deals)
    const { data: mv } = await supabase.from('deal_movements').select('*').order('occurred_on', { ascending: false })
    if (d?.client_id) { const { data: c } = await supabase.from('clients').select('name').eq('id', d.client_id).single(); setClientName(c?.name || '') }
    setDeal(d); setAllDeals(ad.data || []); setCharges(ch.data || []); setObligations(ob.data || [])
    setAllocations(al.data || []); setMilestones(ms.data || []); setMovements(mv || [])
    setForm({ deal_no: d?.deal_no || '', exporter: d?.exporter || '', status: d?.status || 'OPEN', declared_value_usd: d?.declared_value_usd ?? '', wa_chat_id: d?.wa_chat_id || '', wa_chat_app: d?.wa_chat_app || '', notes: d?.notes || '' })
    setLoading(false)
  }
  const fail = (e: any) => { if (e) { alert(e.message || String(e)); return true } return false }
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

  async function saveDeal() {
    const { error } = await supabase.from('car_deals').update({
      deal_no: form.deal_no.trim() || null, exporter: form.exporter || null, status: form.status,
      declared_value_usd: num(form.declared_value_usd), wa_chat_id: form.wa_chat_id.trim() || null,
      wa_chat_app: form.wa_chat_app || null, notes: form.notes.trim() || null, updated_at: new Date().toISOString(),
    }).eq('id', dealId)
    if (!fail(error)) { flash('Saved'); load() }
  }
  async function addCharge() {
    if (!newCharge.label.trim()) return
    const n = num(newCharge.value)
    const { error } = await supabase.from('deal_charges').insert({
      deal_id: dealId, position: charges.length, label: newCharge.label.trim(),
      amount_usd: n, text_value: n === null ? (newCharge.value.trim() || null) : null,
    })
    if (!fail(error)) { setNewCharge({ label: '', value: '' }); load() }
  }
  async function delRow(table: string, id: string, what: string) {
    if (!confirm(`Remove this ${what}?`)) return
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (!fail(error)) load()
  }
  async function addObligation() {
    const amount = num(newOb.amount)
    if (!newOb.label.trim() || amount === null) { alert('Give the obligation a label and an amount.'); return }
    if (newOb.from_party === newOb.to_party) { alert('From and To must be different parties.'); return }
    const { error } = await supabase.from('deal_obligations').insert({
      deal_id: dealId, from_party: newOb.from_party, to_party: newOb.to_party, label: newOb.label.trim(), amount_usd: amount,
      due_date: newOb.due_date || null, trigger_milestone: newOb.due_date ? null : (newOb.trigger_milestone || null),
      trigger_offset_days: parseInt(newOb.offset, 10) || 0,
    })
    if (!fail(error)) { setNewOb({ ...newOb, label: '', amount: '', due_date: '', trigger_milestone: '', offset: '' }); load() }
  }
  async function setObStatus(id: string, status: string) {
    const { error } = await supabase.from('deal_obligations').update({ status }).eq('id', id)
    if (!fail(error)) load()
  }
  async function addMovement() {
    const usd = num(newMov.amount_usd)
    if (!newMov.occurred_on || usd === null) { alert('A movement needs a date and a US$ amount.'); return }
    if (newMov.from_party === newMov.to_party) { alert('From and To must be different parties.'); return }
    const { error } = await supabase.from('deal_movements').insert({
      occurred_on: newMov.occurred_on, kind: newMov.kind, from_party: newMov.from_party, to_party: newMov.to_party,
      amount_usd: usd, amount_brl: num(newMov.amount_brl), fx_rate: num(newMov.fx_rate),
      counterparty_label: newMov.counterparty_label.trim() || null, payer_label: newMov.payer_label.trim() || null,
      fiscal_ref: newMov.fiscal_ref.trim() || null, note: newMov.note.trim() || null, status: 'PROPOSED',
    })
    if (!fail(error)) { setNewMov({ ...newMov, amount_usd: '', amount_brl: '', fx_rate: '', counterparty_label: '', payer_label: '', fiscal_ref: '', note: '' }); load() }
  }
  async function addAllocation(m: any) {
    const draft = newAlloc[m.id] || { deal_id: dealId, amount: '' }
    const amount = draft.amount === '' ? movementUnallocated(m, allocations) : num(draft.amount)
    if (amount === null || amount <= 0) { alert('Allocation amount must be above zero.'); return }
    if (amount > movementUnallocated(m, allocations) + 0.001) { alert(`Only ${formatUSD(movementUnallocated(m, allocations))} of this movement is still unallocated.`); return }
    const { error } = await supabase.from('deal_allocations').insert({ movement_id: m.id, deal_id: draft.deal_id || dealId, amount_usd: amount })
    if (!fail(error)) { setNewAlloc({ ...newAlloc, [m.id]: { deal_id: dealId, amount: '' } }); load() }
  }
  async function setMovStatus(m: any, status: 'PROPOSED' | 'CONFIRMED') {
    if (status === 'CONFIRMED' && movementUnallocated(m, allocations) !== 0) { alert('Allocate the whole movement before confirming.'); return }
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('deal_movements').update({
      status, confirmed_at: status === 'CONFIRMED' ? new Date().toISOString() : null,
      confirmed_by: status === 'CONFIRMED' ? (u?.user?.email || null) : null, updated_at: new Date().toISOString(),
    }).eq('id', m.id)
    if (!fail(error)) load()
  }
  async function setMilestone(kind: string, done_at: string) {
    const { error } = await supabase.from('deal_milestones').upsert({ deal_id: dealId, kind, done_at: done_at || null }, { onConflict: 'deal_id,kind' })
    if (!fail(error)) load()
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!deal) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Deal not found.</p></main>

  const positions = dealPositions(dealId, obligations, movements, allocations)
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount_usd) || 0), 0)
  const dealName = (id: string) => { const d = allDeals.find(x => x.id === id); return d ? `${d.deal_no ? `Compra ${d.deal_no}` : 'no number'}${d.rides?.project_name ? ` ${d.rides.project_name}` : ''}` : '?' }
  const myMovIds = new Set(allocations.filter(a => a.deal_id === dealId).map(a => a.movement_id))
  const shownMovs = movements.filter(m => myMovIds.has(m.id) || m.status === 'PROPOSED')
  const title = `${deal.deal_no ? `Compra ${deal.deal_no}` : 'Car deal'}${deal.rides ? ` — ${[deal.rides.project_code, deal.rides.project_name].filter(Boolean).join(' ')}` : ''}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-4xl font-bold">{title}</h1>
          <p className="text-xl text-gray-400 mt-1">
            {[deal.rides?.year, deal.rides?.model, deal.rides?.version].filter(Boolean).join(' ')}{deal.rides?.vin ? ` · VIN ${deal.rides.vin}` : ''}{deal.rides?.color ? ` · ${deal.rides.color}` : ''}{clientName ? ` · ${clientName}` : ''}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          {deal.invoices?.id && deal.rides?.id && <Link href={`/rides/${deal.rides.id}/invoices/${deal.invoices.id}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">PURCHASE INVOICE {deal.invoices.invoice_code}</Link>}
          {deal.rides?.id && <Link href={`/rides/${deal.rides.id}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">RIDE</Link>}
          <Link href="/car-deals" className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">BACK</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        {(['SUMMARY', 'MOVEMENTS', 'TRIPA SHEET', 'MILESTONES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-5 py-3 rounded-2xl text-lg font-bold border ${tab === t ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-700'}`}>{t}</button>
        ))}
        {msg && <span className="self-center text-green-400 font-bold ml-3">{msg}</span>}
      </div>

      {tab === 'SUMMARY' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {positions.map(p => (
              <div key={p.key} className="bg-gray-900 border border-gray-800 rounded-3xl p-5">
                <p className="text-sm font-bold text-gray-400">{p.label}</p>
                <p className={`text-3xl font-bold mt-1 ${p.open > 0 ? 'text-amber-300' : p.open < 0 ? 'text-green-400' : 'text-gray-500'}`}>{formatUSD(p.open)}</p>
                <p className="text-sm text-gray-400 mt-1">owed {formatUSD(p.owed)} · paid {formatUSD(p.paid)}</p>
                {p.open !== 0 && p.next && <p className="text-sm text-gray-300 mt-1">next: {p.next}</p>}
              </div>
            ))}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-2xl font-bold mb-4">DEAL</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <label className="flex flex-col gap-1 text-sm text-gray-400">DEAL No. (the exporter&apos;s &quot;Compra&quot; number)<input className={inp} value={form.deal_no} onChange={e => setForm({ ...form, deal_no: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400">EXPORTER
                <select className={inp} value={form.exporter} onChange={e => setForm({ ...form, exporter: e.target.value })}><option value="">none</option><option value="TRIPA_TRADING">Tripa Trading</option></select></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400">STATUS
                <select className={inp} value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option>OPEN</option><option>CLOSED</option><option>CANCELLED</option></select></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400">DECLARED VALUE (proforma, US$)<input className={inp} value={form.declared_value_usd} onChange={e => setForm({ ...form, declared_value_usd: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400 md:col-span-2">WHATSAPP GROUP OF THE DEAL (chat id)<input className={inp} value={form.wa_chat_id} onChange={e => setForm({ ...form, wa_chat_id: e.target.value })} placeholder="1203…@g.us" /></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400">GROUP LIVES IN
                <select className={inp} value={form.wa_chat_app} onChange={e => setForm({ ...form, wa_chat_app: e.target.value })}><option value="">—</option><option value="us">US number</option><option value="br">BR number</option></select></label>
              <label className="flex flex-col gap-1 text-sm text-gray-400 md:col-span-4">NOTES<textarea className={inp} rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
            </div>
            <button onClick={saveDeal} className={`${btn} bg-green-700 hover:bg-green-600 mt-4 text-lg`}>SAVE</button>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-2xl font-bold mb-1">CAR COST</h2>
            <p className="text-gray-400 mb-4">The cost lines exactly as the exporter lists them. Total {formatUSD(chargesTotal)}.</p>
            <div className="space-y-2">
              {charges.map(c => (
                <div key={c.id} className="flex items-center gap-4 border-b border-gray-800 pb-2">
                  <span className="flex-1 font-bold">{c.label}</span>
                  <span className="w-48 text-right">{c.amount_usd != null ? formatUSD(Number(c.amount_usd)) : <span className="text-red-400">{c.text_value || ''}</span>}</span>
                  <button onClick={() => delRow('deal_charges', c.id, 'cost line')} className="text-gray-500 hover:text-red-400 font-bold">REMOVE</button>
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-4 flex-wrap">
              <input className={`${inp} flex-1`} placeholder="Label (SRT HELLCAT, EMC N 17, Frete P/ Miami…)" value={newCharge.label} onChange={e => setNewCharge({ ...newCharge, label: e.target.value })} />
              <input className={`${inp} w-56`} placeholder="US$ amount, or a text" value={newCharge.value} onChange={e => setNewCharge({ ...newCharge, value: e.target.value })} />
              <button onClick={addCharge} className={`${btn} bg-green-700 hover:bg-green-600`}>ADD</button>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-2xl font-bold mb-1">WHO OWES WHOM</h2>
            <p className="text-gray-400 mb-4">Each obligation has a date OR a condition (a milestone). Marking the milestone makes it DUE.</p>
            <div className="space-y-2">
              {obligations.length === 0 && <p className="text-gray-500">None yet.</p>}
              {obligations.map(o => (
                <div key={o.id} className="flex items-center gap-4 border-b border-gray-800 pb-2 flex-wrap">
                  <span className="w-64 font-bold">{PARTY_LABEL[o.from_party]} → {PARTY_LABEL[o.to_party]}</span>
                  <span className="flex-1 min-w-40">{o.label}</span>
                  <span className="w-36 text-right font-bold">{formatUSD(Number(o.amount_usd) || 0)}</span>
                  <span className="w-56 text-gray-300">{o.due_date ? dealDate(o.due_date) : o.trigger_milestone ? `when ${MILESTONE_LABEL[o.trigger_milestone]}${o.trigger_offset_days ? ` + ${o.trigger_offset_days}d` : ''}` : 'no date'}</span>
                  <select className={inp} value={o.status} onChange={e => setObStatus(o.id, e.target.value)}><option>OPEN</option><option>DUE</option><option>PAID</option><option>CANCELLED</option></select>
                  <button onClick={() => delRow('deal_obligations', o.id, 'obligation')} className="text-gray-500 hover:text-red-400 font-bold">REMOVE</button>
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-4 flex-wrap items-end">
              <select className={inp} value={newOb.from_party} onChange={e => setNewOb({ ...newOb, from_party: e.target.value })}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select>
              <span className="pb-2">→</span>
              <select className={inp} value={newOb.to_party} onChange={e => setNewOb({ ...newOb, to_party: e.target.value })}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select>
              <input className={`${inp} flex-1 min-w-40`} placeholder="What for" value={newOb.label} onChange={e => setNewOb({ ...newOb, label: e.target.value })} />
              <input className={`${inp} w-36`} placeholder="US$" value={newOb.amount} onChange={e => setNewOb({ ...newOb, amount: e.target.value })} />
              <label className="flex flex-col text-xs text-gray-400">ON A DATE<input type="date" className={inp} value={newOb.due_date} onChange={e => setNewOb({ ...newOb, due_date: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">OR WHEN
                <select className={inp} disabled={!!newOb.due_date} value={newOb.trigger_milestone} onChange={e => setNewOb({ ...newOb, trigger_milestone: e.target.value })}><option value="">—</option>{MILESTONES.map(m => <option key={m.kind} value={m.kind}>{m.label}</option>)}</select></label>
              <label className="flex flex-col text-xs text-gray-400">+ DAYS<input className={`${inp} w-20`} disabled={!!newOb.due_date} value={newOb.offset} onChange={e => setNewOb({ ...newOb, offset: e.target.value })} /></label>
              <button onClick={addObligation} className={`${btn} bg-green-700 hover:bg-green-600`}>ADD</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'MOVEMENTS' && (
        <div className="space-y-6">
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-2xl font-bold mb-1">NEW MOVEMENT</h2>
            <p className="text-gray-400 mb-4">One movement = one real payment, entered once. It is born PROPOSED; a person allocates it to the deal(s) and confirms. The fiscal reference (proforma / exchange contract) does not decide the allocation.</p>
            <div className="flex gap-3 flex-wrap items-end">
              <label className="flex flex-col text-xs text-gray-400">DATE<input type="date" className={inp} value={newMov.occurred_on} onChange={e => setNewMov({ ...newMov, occurred_on: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">KIND<select className={inp} value={newMov.kind} onChange={e => setNewMov({ ...newMov, kind: e.target.value })}>{MOVEMENT_KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
              <label className="flex flex-col text-xs text-gray-400">FROM<select className={inp} value={newMov.from_party} onChange={e => setNewMov({ ...newMov, from_party: e.target.value })}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select></label>
              <label className="flex flex-col text-xs text-gray-400">TO<select className={inp} value={newMov.to_party} onChange={e => setNewMov({ ...newMov, to_party: e.target.value })}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select></label>
              <label className="flex flex-col text-xs text-gray-400">US$<input className={`${inp} w-32`} value={newMov.amount_usd} onChange={e => setNewMov({ ...newMov, amount_usd: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">R$<input className={`${inp} w-32`} value={newMov.amount_brl} onChange={e => setNewMov({ ...newMov, amount_brl: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">RATE<input className={`${inp} w-20`} value={newMov.fx_rate} onChange={e => setNewMov({ ...newMov, fx_rate: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">RECIPIENT (as on the sheet)<input className={`${inp} w-44`} placeholder="Planer 08/06" value={newMov.counterparty_label} onChange={e => setNewMov({ ...newMov, counterparty_label: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">PAYER<input className={`${inp} w-28`} placeholder="Sidney / JP / JV" value={newMov.payer_label} onChange={e => setNewMov({ ...newMov, payer_label: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400">FISCAL REF<input className={`${inp} w-36`} placeholder="proforma / contract" value={newMov.fiscal_ref} onChange={e => setNewMov({ ...newMov, fiscal_ref: e.target.value })} /></label>
              <label className="flex flex-col text-xs text-gray-400 flex-1 min-w-40">NOTE<input className={inp} value={newMov.note} onChange={e => setNewMov({ ...newMov, note: e.target.value })} /></label>
              <button onClick={addMovement} className={`${btn} bg-green-700 hover:bg-green-600`}>ADD AS PROPOSED</button>
            </div>
          </div>

          <div className="space-y-3">
            {shownMovs.length === 0 && <p className="text-xl text-gray-400">No movements for this deal yet.</p>}
            {shownMovs.map(m => {
              const mine = allocations.filter(a => a.movement_id === m.id)
              const left = movementUnallocated(m, allocations)
              const draft = newAlloc[m.id] || { deal_id: dealId, amount: '' }
              const proposed = m.status === 'PROPOSED'
              return (
                <div key={m.id} className={`bg-gray-900 border rounded-3xl p-5 ${proposed ? 'border-amber-700' : 'border-gray-800'}`}>
                  <div className="flex items-center gap-4 flex-wrap">
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${proposed ? 'bg-amber-600 text-black' : 'bg-green-800 text-green-300'}`}>{m.status}</span>
                    <span className="text-xl font-bold">{formatUSD(Number(m.amount_usd) || 0)}</span>
                    <span className="font-bold">{PARTY_LABEL[m.from_party]} → {PARTY_LABEL[m.to_party]}</span>
                    <span className="text-gray-300">{dealDate(m.occurred_on)} · {m.kind}</span>
                    {m.amount_brl != null && <span className="text-gray-400">R$ {Number(m.amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}{m.fx_rate != null ? ` @ ${m.fx_rate}` : ''}</span>}
                    {m.counterparty_label && <span className="text-gray-400">{m.counterparty_label}</span>}
                    {m.payer_label && <span className="text-gray-400">paid by {m.payer_label}</span>}
                    {m.fiscal_ref && <span className="px-2 py-1 rounded-lg bg-gray-800 text-sm text-gray-300">fiscal ref {m.fiscal_ref}</span>}
                    <span className="flex-1" />
                    {proposed
                      ? <>
                          <button onClick={() => setMovStatus(m, 'CONFIRMED')} disabled={left !== 0} className={`${btn} bg-green-700 hover:bg-green-600 disabled:opacity-40`}>CONFIRM</button>
                          <button onClick={() => delRow('deal_movements', m.id, 'movement')} className="text-gray-500 hover:text-red-400 font-bold">REMOVE</button>
                        </>
                      : <button onClick={() => setMovStatus(m, 'PROPOSED')} className={`${btn} bg-gray-700 hover:bg-gray-600`}>REOPEN TO RE-ALLOCATE</button>}
                  </div>
                  {m.note && <p className="text-gray-400 mt-2">{m.note}</p>}
                  <div className="mt-3 pl-2 space-y-1">
                    {mine.map(a => (
                      <div key={a.id} className="flex items-center gap-4">
                        <span className={`w-72 ${a.deal_id === dealId ? 'font-bold' : 'text-gray-400'}`}>{a.deal_id === dealId ? 'this deal' : dealName(a.deal_id)}</span>
                        <span className="w-36 text-right">{formatUSD(Number(a.amount_usd) || 0)}</span>
                        {proposed && <button onClick={() => delRow('deal_allocations', a.id, 'allocation')} className="text-gray-500 hover:text-red-400 font-bold text-sm">REMOVE</button>}
                      </div>
                    ))}
                    {left !== 0 && <p className="text-amber-300 font-bold">{formatUSD(left)} not allocated yet</p>}
                    {proposed && left > 0 && (
                      <div className="flex gap-3 items-center flex-wrap pt-1">
                        <select className={inp} value={draft.deal_id} onChange={e => setNewAlloc({ ...newAlloc, [m.id]: { ...draft, deal_id: e.target.value } })}>
                          {allDeals.map(d => <option key={d.id} value={d.id}>{d.id === dealId ? `this deal (${dealName(d.id)})` : dealName(d.id)}</option>)}
                        </select>
                        <input className={`${inp} w-36`} placeholder={String(left)} value={draft.amount} onChange={e => setNewAlloc({ ...newAlloc, [m.id]: { ...draft, amount: e.target.value } })} />
                        <button onClick={() => addAllocation(m)} className={`${btn} bg-blue-800 hover:bg-blue-700`}>ALLOCATE</button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'TRIPA SHEET' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => downloadSheet('xlsx')} disabled={!sheet?.grid || !!sheetBusy} className={`${btn} bg-green-700 hover:bg-green-600 disabled:opacity-40 text-lg`}>{sheetBusy === 'xlsx' ? 'GENERATING…' : 'DOWNLOAD EXCEL'}</button>
            <button onClick={() => downloadSheet('pdf')} disabled={!sheet?.grid || !!sheetBusy} className={`${btn} bg-green-700 hover:bg-green-600 disabled:opacity-40 text-lg`}>{sheetBusy === 'pdf' ? 'GENERATING…' : 'DOWNLOAD PDF'}</button>
            {sheet?.grid && <span className="text-gray-400">Car total {formatUSD(sheet.total)} · paid {formatUSD(sheet.paid)} · balance {formatUSD(sheet.balance)} · {sheet.payments} payment line{sheet.payments === 1 ? '' : 's'}</span>}
          </div>
          <p className="text-gray-400">Same layout as the exporter&apos;s screen. It shows confirmed movements only, and nothing here is posted anywhere: the files are downloaded to this computer.</p>
          {!sheet ? <p className="text-xl text-gray-400">Loading...</p> : sheet.error ? <p className="text-xl text-red-400">Could not build the sheet: {sheet.error}</p> : (
            <div className="overflow-x-auto bg-white rounded-xl p-2">
              <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', minWidth: 1300, fontFamily: 'Arial, Helvetica, sans-serif' }}>
                <tbody>
                  {sheet.grid.map((row: any[], r: number) => (
                    <tr key={r}>
                      {row.map((c: any, k: number) => (
                        <td key={k} style={{ border: '1px solid #A6A6A6', height: 26, padding: '0 4px', fontSize: 14, width: '10%', whiteSpace: c.wrap ? 'normal' : 'nowrap', overflow: 'hidden', color: c.c || '#000', fontWeight: c.b ? 700 : 400, fontStyle: c.i ? 'italic' : 'normal', background: c.fill || '#fff', textAlign: c.al || 'left' }}>
                          {c.n != null
                            ? `${c.fmt === 'brl' ? 'R$' : 'US$'} ${Number(c.n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : c.rich ? c.rich.map((x: any, i: number) => <span key={i} style={{ color: x[1], fontWeight: x[2] ? 700 : 400 }}>{x[0]}</span>) : (c.v || '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'MILESTONES' && (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
          <h2 className="text-2xl font-bold mb-1">MILESTONES</h2>
          <p className="text-gray-400 mb-4">Set the date a step happened. Obligations waiting on that step become DUE on that date (plus their days).</p>
          <div className="space-y-3">
            {MILESTONES.map(k => {
              const row = milestones.find(m => m.kind === k.kind)
              const waiting = obligations.filter(o => o.trigger_milestone === k.kind)
              return (
                <div key={k.kind} className="flex items-center gap-4 border-b border-gray-800 pb-3 flex-wrap">
                  <span className={`w-56 text-xl font-bold ${row?.done_at ? 'text-green-400' : ''}`}>{row?.done_at ? '✓ ' : ''}{k.label}</span>
                  <input type="date" className={inp} value={row?.done_at || ''} onChange={e => setMilestone(k.kind, e.target.value)} />
                  {row?.done_at && <button onClick={() => setMilestone(k.kind, '')} className="text-gray-500 hover:text-red-400 font-bold">CLEAR</button>}
                  {waiting.length > 0 && <span className="text-gray-400">{waiting.length} obligation{waiting.length > 1 ? 's' : ''} tied to it: {waiting.map(o => `${PARTY_LABEL[o.from_party]} → ${PARTY_LABEL[o.to_party]} ${formatUSD(Number(o.amount_usd) || 0)} (${o.status})`).join(' · ')}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </main>
  )
}
