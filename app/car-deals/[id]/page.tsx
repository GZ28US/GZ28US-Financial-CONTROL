'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { carDescription, carInternal, dealLabel, vinTail, DEAL_SELECT, flatDeal, obligationDue, POSITION_EXPENSE_COLS, POSITION_INCOME_COLS, DOC_KINDS, DOC_LABEL, MILESTONES, MILESTONE_LABEL, MOVEMENT_KINDS, PARTIES, PARTY_LABEL, dealDate, dealPositions, movementUnallocated } from '@/lib/carDeals'

// CAR DEAL (21/11/2026) — uma compra de carro. Abas: SUMMARY (posições, custos, obrigações) · MOVEMENTS (o livro:
// proposta → alocar → confirmar) · MILESTONES (marcar o marco torna DUE a obrigação condicionada a ele).
// O robô e a planilha no layout do Tripa entram nas etapas seguintes; aqui NADA é postado em lugar nenhum.

const inp = 'bg-black border border-gray-700 rounded-xl px-3 py-2 text-base'
const btn = 'px-4 py-2 rounded-xl font-bold'
const num = (v: any) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function CarDealPage() {
  const dealId = String(useParams().id)
  const [tab, setTab] = useState<'SUMMARY' | 'MOVEMENTS' | 'DOCUMENTS' | 'TRIPA SHEET' | 'MILESTONES'>('SUMMARY')
  const [docs, setDocs] = useState<any[]>([])
  const [newDoc, setNewDoc] = useState<any>({ kind: 'TITLE', label: '', doc_date: '' })
  const [uploading, setUploading] = useState('')
  const [incomes, setIncomes] = useState<any[]>([])
  const [expenses, setExpenses] = useState<any[]>([])
  const [incomeReceipts, setIncomeReceipts] = useState<Record<string, string>>({})
  const [sheet, setSheet] = useState<any>(null)
  const [sheetBusy, setSheetBusy] = useState('')
  const [newTarget, setNewTarget] = useState<any>({ chat_id: '', label: '', view: 'TRIPA' })
  const [postLog, setPostLog] = useState<any>(null)
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
  const [newMov, setNewMov] = useState<any>({ occurred_on: today(), kind: 'WIRE', from_party: 'SIDNEY', to_party: 'GZ28US', amount_usd: '', amount_brl: '', counterparty_label: '', payer_label: '', fiscal_ref: '', note: '' })
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
    const { data: d0 } = await supabase.from('car_deals').select(DEAL_SELECT).eq('id', dealId).single()
    const d = flatDeal(d0)
    const [ad, ch, ob, al, ms] = await Promise.all([
      supabase.from('car_deals').select(DEAL_SELECT).order('deal_no'),
      supabase.from('deal_charges').select('*').eq('deal_id', dealId).order('position'),
      supabase.from('deal_obligations').select('*').eq('deal_id', dealId).order('created_at'),
      supabase.from('deal_allocations').select('*'),
      supabase.from('deal_milestones').select('*').eq('deal_id', dealId),
    ])
    // movimentos: os alocados a este deal + todo PROPOSED (a caixa de entrada é uma só para todos os deals)
    const { data: mv } = await supabase.from('deal_movements').select('*').order('occurred_on', { ascending: false })
    // documentos: os do carro (deal_id) e as provas de movimento (movement_id) — o comprovante mora num lugar só
    const { data: dc } = await supabase.from('deal_documents').select('*').or(`deal_id.eq.${dealId},movement_id.not.is.null`).order('created_at', { ascending: false })
    setDocs(dc || [])
    // PROVA DERIVADA (uma info, um campo): movimento alocado a uma renda já tem o recibo na própria renda
    // (invoice_incomes.receipt_url) — não se copia para deal_documents; lê-se de lá.
    const incIds = [...new Set((al.data || []).map((a: any) => a.invoice_income_id).filter(Boolean))] as string[]
    const rec: Record<string, string> = {}
    for (let i = 0; i < incIds.length; i += 150) {
      const { data: rs } = await supabase.from('invoice_incomes').select('id, receipt_url').in('id', incIds.slice(i, i + 150)).not('receipt_url', 'is', null)
      for (const r of rs || []) if (r.receipt_url) rec[r.id] = r.receipt_url
    }
    setIncomeReceipts(rec)
    if (d?.purchase_invoice_id) {
      const [inc, exp] = await Promise.all([
        supabase.from('invoice_incomes').select(POSITION_INCOME_COLS).eq('invoice_id', d.purchase_invoice_id),
        supabase.from('invoice_expenses').select(POSITION_EXPENSE_COLS).eq('invoice_id', d.purchase_invoice_id),
      ])
      setIncomes(inc.data || []); setExpenses(exp.data || [])
    }
    if (d?.client_id) { const { data: c } = await supabase.from('clients').select('name').eq('id', d.client_id).single(); setClientName(c?.name || '') }
    setDeal(d); setAllDeals((ad.data || []).map(flatDeal)); setCharges(ch.data || []); setObligations(ob.data || [])
    setAllocations(al.data || []); setMilestones(ms.data || []); setMovements(mv || [])
    setForm({ deal_no: d?.deal_no || '', exporter: d?.exporter || '', status: d?.status || 'OPEN', declared_value_usd: d?.declared_value_usd ?? '', wa_chat_id: d?.wa_chat_id || '', notes: d?.notes || '' })
    setLoading(false)
  }
  const targetList: any[] = Array.isArray(deal?.post_targets) ? deal.post_targets : []
  const fail = (e: any) => { if (e) { alert(e.message || String(e)); return true } return false }
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

  async function saveDeal() {
    const { error } = await supabase.from('car_deals').update({
      deal_no: form.deal_no.trim() || null, exporter: form.exporter || null, status: form.status,
      declared_value_usd: num(form.declared_value_usd), wa_chat_id: form.wa_chat_id.trim() || null,
      notes: form.notes.trim() || null, updated_at: new Date().toISOString(),
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
  async function setObCancelled(id: string, cancelled: boolean) {
    const { error } = await supabase.from('deal_obligations').update({ cancelled }).eq('id', id)
    if (!fail(error)) load()
  }
  async function addMovement() {
    const usd = num(newMov.amount_usd)
    if (!newMov.occurred_on || usd === null) { alert('A movement needs a date and a US$ amount.'); return }
    if (newMov.from_party === newMov.to_party) { alert('From and To must be different parties.'); return }
    const { error } = await supabase.from('deal_movements').insert({
      occurred_on: newMov.occurred_on, kind: newMov.kind, from_party: newMov.from_party, to_party: newMov.to_party,
      amount_usd: usd, amount_brl: num(newMov.amount_brl),
      counterparty_label: newMov.counterparty_label.trim() || null, payer_label: newMov.payer_label.trim() || null,
      fiscal_ref: newMov.fiscal_ref.trim() || null, note: newMov.note.trim() || null, status: 'PROPOSED',
    })
    if (!fail(error)) { setNewMov({ ...newMov, amount_usd: '', amount_brl: '', counterparty_label: '', payer_label: '', fiscal_ref: '', note: '' }); load() }
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
    const { error } = await supabase.from('deal_movements').update({ status, updated_at: new Date().toISOString() }).eq('id', m.id)
    if (fail(error)) return
    await load()
    if (status === 'CONFIRMED') autoPost(m.id)
  }
  // Depois de um CONFIRM: pede a postagem automática para cada deal tocado pelo movimento. O servidor só manda com as
  // DUAS chaves ligadas (a geral e a do deal) e nunca repete planilha igual; desligado, não acontece nada.
  async function autoPost(movementId: string) {
    const ids = [...new Set(allocations.filter(a => a.movement_id === movementId).map(a => a.deal_id))]
    for (const id of ids) {
      const r = await fetch(`${BASE_PATH}/api/car-deals/post`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ deal: id, auto: true }) }).then(x => x.json()).catch(() => null)
      if (r?.posted) flash(`Sheet posted automatically (${r.sent.filter((s: any) => s.ok).length} files)`)
    }
  }
  // ARQUIVOS: o mesmo balde dos comprovantes do app (expense-receipts), numa pasta por deal.
  async function uploadFile(file: File, folder: string): Promise<string | null> {
    const safe = file.name.normalize('NFD').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
    const path = `car-deals/${dealId}/${folder}/${Date.now()}-${safe}`
    const { error } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
    if (error) { alert(`Upload failed: ${error.message}`); return null }
    return supabase.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
  }
  async function addDocument(file: File | undefined) {
    if (!file) return
    setUploading('doc')
    try {
      const url = await uploadFile(file, 'docs')
      if (!url) return
      const { error } = await supabase.from('deal_documents').insert({
        deal_id: dealId, kind: newDoc.kind, label: newDoc.label.trim() || null, doc_date: newDoc.doc_date || null, file_url: url,
      })
      if (!fail(error)) { setNewDoc({ ...newDoc, label: '', doc_date: '' }); load() }
    } finally { setUploading('') }
  }
  // comprovante do movimento: um deal_documents com movement_id — vale para todos os deals em que ele foi alocado
  async function attachProof(m: any, file: File | undefined) {
    if (!file) return
    setUploading(m.id)
    try {
      const url = await uploadFile(file, 'proofs')
      if (!url) return
      const { error } = await supabase.from('deal_documents').insert({ movement_id: m.id, kind: 'PAYMENT_PROOF', file_url: url })
      if (!fail(error)) load()
    } finally { setUploading('') }
  }
  async function setMovParty(m: any, field: 'from_party' | 'to_party', value: string) {
    const other = field === 'from_party' ? m.to_party : m.from_party
    if (value === other) { alert('From and To must be different parties.'); return }
    const { error } = await supabase.from('deal_movements').update({ [field]: value, updated_at: new Date().toISOString() }).eq('id', m.id)
    if (!fail(error)) load()
  }
  async function saveTargets(next: any[], autoFlag?: boolean) {
    const patch: any = { post_targets: next, updated_at: new Date().toISOString() }
    if (autoFlag !== undefined) patch.auto_post = autoFlag
    const { error } = await supabase.from('car_deals').update(patch).eq('id', dealId)
    if (!fail(error)) load()
  }
  function addTarget() {
    const chat = newTarget.chat_id.trim()
    if (!chat.endsWith('@g.us') && !chat.endsWith('@c.us')) { alert('The chat id must end in @g.us (group) or @c.us (person).'); return }
    saveTargets([...targetList, { chat_id: chat, app: 'us', label: newTarget.label.trim() || null, view: newTarget.view }])
    setNewTarget({ chat_id: '', label: '', view: 'TRIPA' })
  }
  async function postNow() {
    if (!targetList.length) { alert('Add at least one target first.'); return }
    const list = targetList.map((t: any) => `• ${t.label || t.chat_id} — ${t.view || 'GZ28'} view`).join('\n')
    if (!confirm(`Send the Excel and the PDF of this sheet by WhatsApp, now, to:\n\n${list}\n\nThis reaches people outside the app. Send?`)) return
    setSheetBusy('post'); setPostLog(null)
    try {
      const r = await fetch(`${BASE_PATH}/api/car-deals/post`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ deal: dealId, auto: false, force: true }) })
      setPostLog(await r.json().catch(() => ({ error: `HTTP ${r.status}` })))
      load()
    } finally { setSheetBusy('') }
  }
  async function setMilestone(kind: string, done_at: string) {
    const { error } = await supabase.from('deal_milestones').upsert({ deal_id: dealId, kind, done_at: done_at || null }, { onConflict: 'deal_id,kind' })
    if (!fail(error)) load()
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  if (!deal) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Deal not found.</p></main>

  const positions = dealPositions(deal, { charges, obligations, movements, allocations, milestones, incomes, expenses })
  // a prova de um movimento: os documentos dele + o recibo das rendas que as alocações dele pagam (só leitura)
  const proofsOf = (m: any) => [
    ...docs.filter(x => x.movement_id === m.id),
    ...[...new Set(allocations.filter(a => a.movement_id === m.id && a.invoice_income_id && incomeReceipts[a.invoice_income_id]).map(a => incomeReceipts[a.invoice_income_id]))]
      .map((u, i) => ({ id: `inc:${m.id}:${i}`, file_url: u, label: 'receipt on the invoice' })),
  ]
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount_usd) || 0), 0)
  const dealName = (id: string) => { const d = allDeals.find(x => x.id === id); return d ? `VIN ${vinTail(d.rides?.vin) || '----'} · ${dealLabel(d.deal_no)} · ${carDescription(d.rides)}` : '?' }
  const myMovIds = new Set(allocations.filter(a => a.deal_id === dealId).map(a => a.movement_id))
  const shownMovs = movements.filter(m => myMovIds.has(m.id) || m.status === 'PROPOSED')
  const vin = String(deal.rides?.vin || '')

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-4xl font-bold font-mono">{vin ? <><span className="text-gray-400 text-2xl">VIN </span>{vin.slice(0, -4)}<span className="text-amber-300">{vin.slice(-4)}</span></> : 'no VIN'}</h1>
          <p className="text-2xl font-bold mt-1">{deal.deal_no ? dealLabel(deal.deal_no) : 'Car deal'} · {[deal.rides?.year, carDescription(deal.rides)].filter(Boolean).join(' ')}</p>
          <p className="text-xl text-gray-400 mt-1">
            {[carInternal(deal.rides), clientName].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          {deal.invoices?.id && deal.rides?.id && <Link href={`/rides/${deal.rides.id}/invoices/${deal.invoices.id}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">PURCHASE INVOICE {deal.invoices.invoice_code}</Link>}
          {deal.rides?.id && <Link href={`/rides/${deal.rides.id}`} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">RIDE</Link>}
          <Link href="/car-deals" className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl text-lg font-bold">BACK</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        {(['SUMMARY', 'MOVEMENTS', 'DOCUMENTS', 'TRIPA SHEET', 'MILESTONES'] as const).map(t => (
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
                  <span className={`w-56 ${o.cancelled ? 'text-gray-600 line-through' : obligationDue(o, milestones).due ? 'text-red-400 font-bold' : 'text-gray-300'}`}>{obligationDue(o, milestones).label}</span>
                  <button onClick={() => setObCancelled(o.id, !o.cancelled)} className="text-gray-400 hover:text-white font-bold">{o.cancelled ? 'RESTORE' : 'CANCEL'}</button>
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
                    {proposed ? (
                      <span className="flex items-center gap-2">
                        <select className={inp} value={m.from_party} onChange={e => setMovParty(m, 'from_party', e.target.value)}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select>
                        →
                        <select className={inp} value={m.to_party} onChange={e => setMovParty(m, 'to_party', e.target.value)}>{PARTIES.map(p => <option key={p} value={p}>{PARTY_LABEL[p]}</option>)}</select>
                      </span>
                    ) : <span className="font-bold">{PARTY_LABEL[m.from_party]} → {PARTY_LABEL[m.to_party]}</span>}
                    <span className="text-gray-300">{dealDate(m.occurred_on)} · {m.kind}</span>
                    {proofsOf(m).map((x: any, i: number, all: any[]) => <a key={x.id} href={x.file_url} target="_blank" rel="noreferrer" className="underline text-blue-300">{x.label || `proof${all.length > 1 ? ` ${i + 1}` : ''}`}</a>)}
                    {m.source_message_id && <span className="px-2 py-1 rounded-lg bg-gray-800 text-sm text-gray-300">read from the group</span>}
                    {!proofsOf(m).length && m.kind !== 'OFFSET' && <span className="px-2 py-1 rounded-lg bg-red-950 text-sm font-bold text-red-300">NO PROOF</span>}
                    <label className="cursor-pointer underline text-gray-300 text-sm">{uploading === m.id ? 'uploading…' : 'attach proof'}<input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => { attachProof(m, e.target.files?.[0]); e.target.value = '' }} /></label>
                    {m.amount_brl != null && <span className="text-gray-400">R$ {Number(m.amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}{Number(m.amount_usd) ? ` @ ${(Number(m.amount_brl) / Number(m.amount_usd)).toFixed(2)}` : ''}</span>}
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

      {tab === 'DOCUMENTS' && (() => {
        const titleDocs = docs.filter(d => d.kind === 'TITLE' && d.deal_id === dealId)
        const titleStep = milestones.find(m => m.kind === 'TITLE_RECEIVED')
        const proofs = movements.filter(m => myMovIds.has(m.id))
        const noProof = proofs.filter(m => m.status === 'CONFIRMED' && m.kind !== 'OFFSET' && !proofsOf(m).length)
        const carDocs = docs.filter(x => x.deal_id === dealId)
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className={`bg-gray-900 border rounded-3xl p-5 ${titleDocs.length ? 'border-green-800' : 'border-red-900'}`}>
                <p className="text-sm font-bold text-gray-400">TITLE</p>
                <p className={`text-2xl font-bold mt-1 ${titleDocs.length ? 'text-green-400' : 'text-red-400'}`}>{titleDocs.length ? 'ON FILE' : 'NOT ON FILE'}</p>
                <p className="text-sm text-gray-400 mt-1">{titleStep?.done_at ? `Title received ${dealDate(titleStep.done_at)}` : 'Title not marked as received (tab MILESTONES)'}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5">
                <p className="text-sm font-bold text-gray-400">DOCUMENTS ON FILE</p>
                <p className="text-2xl font-bold mt-1">{carDocs.length}</p>
                <p className="text-sm text-gray-400 mt-1">{DOC_KINDS.filter(k => carDocs.some(d => d.kind === k.kind)).map(k => k.label).join(' · ') || 'none yet'}</p>
              </div>
              <div className={`bg-gray-900 border rounded-3xl p-5 ${noProof.length ? 'border-red-900' : 'border-gray-800'}`}>
                <p className="text-sm font-bold text-gray-400">CONFIRMED MOVEMENTS WITHOUT PROOF</p>
                <p className={`text-2xl font-bold mt-1 ${noProof.length ? 'text-red-400' : 'text-green-400'}`}>{noProof.length} of {proofs.filter(m => m.status === 'CONFIRMED').length}</p>
                <p className="text-sm text-gray-400 mt-1">Attach each proof on the movement (tab MOVEMENTS).</p>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
              <h2 className="text-2xl font-bold mb-4">ADD A DOCUMENT</h2>
              <div className="flex gap-3 flex-wrap items-end">
                <label className="flex flex-col text-xs text-gray-400">KIND<select className={inp} value={newDoc.kind} onChange={e => setNewDoc({ ...newDoc, kind: e.target.value })}>{DOC_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
                <label className="flex flex-col text-xs text-gray-400 flex-1 min-w-40">LABEL (optional)<input className={inp} value={newDoc.label} onChange={e => setNewDoc({ ...newDoc, label: e.target.value })} placeholder="Front and back, contract 12345…" /></label>
                <label className="flex flex-col text-xs text-gray-400">DOCUMENT DATE<input type="date" className={inp} value={newDoc.doc_date} onChange={e => setNewDoc({ ...newDoc, doc_date: e.target.value })} /></label>
                <label className={`${btn} bg-green-700 hover:bg-green-600 cursor-pointer`}>{uploading === 'doc' ? 'UPLOADING…' : 'CHOOSE FILE AND SAVE'}<input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => { addDocument(e.target.files?.[0]); e.target.value = '' }} /></label>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
              <h2 className="text-2xl font-bold mb-4">ON FILE</h2>
              {carDocs.length === 0 && <p className="text-gray-500">No documents yet.</p>}
              <div className="space-y-2">
                {DOC_KINDS.flatMap(k => carDocs.filter(d => d.kind === k.kind)).map(d => (
                  <div key={d.id} className="flex items-center gap-4 border-b border-gray-800 pb-2 flex-wrap">
                    <span className="w-44 font-bold">{DOC_LABEL[d.kind] || d.kind}</span>
                    <a href={d.file_url} target="_blank" rel="noreferrer" className="underline text-blue-300 flex-1 min-w-40">{d.label || decodeURIComponent(String(d.file_url).split('/').pop() || '').replace(/^\d{10,}-/, '') || 'open'}</a>
                    <span className="text-gray-400 w-28">{dealDate(d.doc_date) || ''}</span>
                    <span className="text-gray-500 text-sm w-56">added {dealDate(String(d.created_at).slice(0, 10))}</span>
                    <button onClick={() => delRow('deal_documents', d.id, 'document')} className="text-gray-500 hover:text-red-400 font-bold">REMOVE</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
              <h2 className="text-2xl font-bold mb-4">PAYMENT PROOFS (from the movements of this car)</h2>
              {proofs.length === 0 && <p className="text-gray-500">No movements allocated to this car yet.</p>}
              <div className="space-y-2">
                {proofs.map(m => (
                  <div key={m.id} className="flex items-center gap-4 border-b border-gray-800 pb-2 flex-wrap">
                    <span className="w-28 text-gray-300">{dealDate(m.occurred_on)}</span>
                    <span className="w-36 text-right font-bold">{formatUSD(Number(m.amount_usd) || 0)}</span>
                    <span className="w-64">{PARTY_LABEL[m.from_party]} → {PARTY_LABEL[m.to_party]}</span>
                    <span className="text-gray-400 flex-1 min-w-40">{m.counterparty_label || m.kind}</span>
                    {proofsOf(m).length
                      ? proofsOf(m).map((x: any, i: number, all: any[]) => <a key={x.id} href={x.file_url} target="_blank" rel="noreferrer" className="underline text-blue-300">{x.label || `proof${all.length > 1 ? ` ${i + 1}` : ''}`}</a>)
                      : <span className="text-red-400 font-bold">{m.kind === 'OFFSET' ? '' : 'no proof'}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {tab === 'TRIPA SHEET' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => downloadSheet('xlsx')} disabled={!sheet?.grid || !!sheetBusy} className={`${btn} bg-green-700 hover:bg-green-600 disabled:opacity-40 text-lg`}>{sheetBusy === 'xlsx' ? 'GENERATING…' : 'DOWNLOAD EXCEL'}</button>
            <button onClick={() => downloadSheet('pdf')} disabled={!sheet?.grid || !!sheetBusy} className={`${btn} bg-green-700 hover:bg-green-600 disabled:opacity-40 text-lg`}>{sheetBusy === 'pdf' ? 'GENERATING…' : 'DOWNLOAD PDF'}</button>
            {sheet?.grid && <span className="text-gray-400">Car total {formatUSD(sheet.total)} · paid {formatUSD(sheet.paid)} · balance {formatUSD(sheet.balance)} · {sheet.payments} payment line{sheet.payments === 1 ? '' : 's'}</span>}
          </div>
          <p className="text-gray-400">Same layout as the exporter&apos;s screen. It shows confirmed movements only, and nothing here is posted anywhere: the files are downloaded to this computer.</p>
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-2xl font-bold mb-1">WHERE THIS SHEET GOES</h2>
            <p className="text-gray-400 mb-4">Each target gets the Excel and the PDF. A SIDNEY-view target gets the sheet WITHOUT the notes on the right (the Tripa Trading ↔ GZ28US leg). Never add a group the client is in with a TRIPA or GZ28 view.</p>
            <div className="space-y-2">
              {targetList.length === 0 && <p className="text-gray-500">No targets yet — nothing can be posted for this deal.</p>}
              {targetList.map((t: any, i: number) => (
                <div key={i} className="flex items-center gap-4 border-b border-gray-800 pb-2 flex-wrap">
                  <span className="font-bold w-64">{t.label || '(no label)'}</span>
                  <span className="text-gray-400 flex-1 min-w-40">{t.chat_id}</span>
                  <span className={`px-3 py-1 rounded-full text-sm font-bold ${t.view === 'SIDNEY' ? 'bg-blue-900 text-blue-200' : 'bg-gray-700 text-gray-200'}`}>{t.view || 'GZ28'} view</span>
                  <button onClick={() => saveTargets(targetList.filter((_: any, k: number) => k !== i))} className="text-gray-500 hover:text-red-400 font-bold">REMOVE</button>
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-4 flex-wrap items-end">
              <input className={`${inp} w-64`} placeholder="Label (Tripa private, group…)" value={newTarget.label} onChange={e => setNewTarget({ ...newTarget, label: e.target.value })} />
              <input className={`${inp} flex-1 min-w-40`} placeholder="WhatsApp chat id (…@g.us or …@c.us)" value={newTarget.chat_id} onChange={e => setNewTarget({ ...newTarget, chat_id: e.target.value })} />
              <select className={inp} value={newTarget.view} onChange={e => setNewTarget({ ...newTarget, view: e.target.value })}><option value="TRIPA">TRIPA view (full sheet)</option><option value="SIDNEY">SIDNEY view (no right-side notes)</option><option value="GZ28">GZ28 view (full sheet)</option></select>
              <button onClick={addTarget} className={`${btn} bg-green-700 hover:bg-green-600`}>ADD TARGET</button>
            </div>
            <div className="flex gap-4 mt-5 items-center flex-wrap border-t border-gray-800 pt-4">
              <button onClick={postNow} disabled={!sheet?.grid || !!sheetBusy} className={`${btn} bg-blue-800 hover:bg-blue-700 disabled:opacity-40 text-lg`}>{sheetBusy === 'post' ? 'SENDING…' : 'POST NOW (WhatsApp)'}</button>
              <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={!!deal.auto_post} onChange={e => saveTargets(targetList, e.target.checked)} /> Post by itself when a movement of this deal is confirmed</label>
              <span className="text-sm text-gray-500">Automatic posting also needs the general switch (car_deals.auto_post), which is OFF until Márcio turns it on.</span>
            </div>
            {postLog && (
              <div className="mt-4 text-sm">
                {postLog.error && <p className="text-red-400 font-bold">{postLog.error}</p>}
                {postLog.reason && <p className="text-amber-300 font-bold">{postLog.reason}</p>}
                {(postLog.sent || []).map((s: any, i: number) => <p key={i} className={s.ok ? 'text-green-400' : 'text-red-400'}>{s.ok ? 'sent' : 'FAILED'} — {s.label || s.to} — {s.file}{s.error ? ` — ${s.error}` : ''}</p>)}
              </div>
            )}
          </div>
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
                  {waiting.length > 0 && <span className="text-gray-400">{waiting.length} obligation{waiting.length > 1 ? 's' : ''} tied to it: {waiting.map(o => `${PARTY_LABEL[o.from_party]} → ${PARTY_LABEL[o.to_party]} ${formatUSD(Number(o.amount_usd) || 0)} (${o.cancelled ? 'cancelled' : obligationDue(o, milestones).label})`).join(' · ')}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </main>
  )
}
