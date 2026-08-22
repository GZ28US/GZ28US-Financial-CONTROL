'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'

type Item = { id: string; description: string | null; quantity: number; unit_price: number; supplier: string | null; source_type?: string | null }
type SaleEntry = { id: string; kind: string; amount: number; entry_date: string | null; description: string | null; receipt_url: string | null }

function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—' }
function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function SellInventoryPage() {
  const params = useParams()
  const id = String(params.id)
  const [item, setItem] = useState<Item | null>(null)
  const [entries, setEntries] = useState<SaleEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<null | 'INCOME' | 'EXPENSE'>(null)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [desc, setDesc] = useState('')
  const [receipt, setReceipt] = useState('')
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState<null | 'INCOME' | 'EXPENSE'>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => { load() }, [id])

  async function load() {
    const { data: it } = await supabase.from('inventory').select('id, description, quantity, unit_price, supplier, source_type').eq('id', id).maybeSingle()
    setItem((it || null) as Item | null)
    const { data } = await supabase.from('inventory_sales').select('*').eq('inventory_id', id).order('entry_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    setEntries((data || []) as SaleEntry[])
    setLoading(false)
  }

  function openAdd(kind: 'INCOME' | 'EXPENSE') { setAdding(kind); setAmount(''); setDate(todayYmd()); setDesc(''); setReceipt('') }

  async function handleScan(kind: 'INCOME' | 'EXPENSE', file: File) {
    setScanning(kind)
    try {
      const ext = file.name.split('.').pop()
      const path = `inventory-sales/${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      let receiptUrl = ''
      const { error: upErr } = await supabase.storage.from('expense-receipts').upload(path, file, { upsert: true })
      if (!upErr) receiptUrl = supabase.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
      const { base64, mediaType } = await fileForScan(file)
      const res = await fetch(`${BASE_PATH}/api/scan-receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64, mediaType }) })
      const data = await res.json()
      let amt = ''; let dt = todayYmd(); let dsc = ''
      if (!data.error) {
        const text = data.content?.map((c: any) => c.text || '').join('') || ''
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        // BRL-as-USD guard: skip the amount prefill when the document is foreign-currency.
        const fx = await scanCurrencyFx(parsed.currency)
        const t = fx == null ? 0 : (parsed.items || []).reduce((s: number, i: any) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0) * fx
        if (t > 0) amt = t.toFixed(2)
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || ''))) dt = String(parsed.date)
        dsc = (parsed.items || []).map((i: any) => i.description).filter(Boolean).join(', ') || String(parsed.supplier || '')
      }
      setAdding(kind); setAmount(amt); setDate(dt); setDesc(dsc); setReceipt(receiptUrl)
    } catch (err) { console.error(err); alert('Failed to scan receipt. Please try again.') }
    finally { setScanning(null) }
  }

  async function save() {
    if (!adding) return
    if (!amount) { alert('Please enter an amount'); return }
    setSaving(true)
    const { error } = await supabase.from('inventory_sales').insert([{
      inventory_id: id, kind: adding, amount: parseFloat(amount) || 0,
      entry_date: isValidDate(date) ? date : null, description: desc || null, receipt_url: receipt || null,
    }])
    setSaving(false)
    if (error) { alert(error.message); return }
    setAdding(null); load()
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('inventory_sales').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  const incomes = entries.filter(e => e.kind === 'INCOME')
  const expenses = entries.filter(e => e.kind === 'EXPENSE')
  const incomeTotal = incomes.reduce((s, e) => s + (Number(e.amount) || 0), 0)
  const expenseTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0)
  const net = incomeTotal - expenseTotal
  const sold = incomes.length > 0
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  function Box({ kind, list, color, totalVal }: { kind: 'INCOME' | 'EXPENSE'; list: SaleEntry[]; color: string; totalVal: number }) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex-1 min-w-[18rem]">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className={`text-2xl font-bold ${color}`}>{kind === 'INCOME' ? 'INCOME' : 'EXPENSES'} <span className="text-gray-400 text-lg font-normal">{formatUSD(totalVal)}</span></h2>
          <div className="flex gap-2">
            <label className={`bg-purple-700 hover:bg-purple-600 px-4 py-2 rounded-2xl font-bold text-sm cursor-pointer ${scanning === kind ? 'opacity-60 pointer-events-none' : ''}`}>
              {scanning === kind ? 'Scanning…' : '📸 SCAN'}
              <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScan(kind, e.target.files[0]) }} />
            </label>
            <button onClick={() => openAdd(kind)} className="bg-green-700 hover:bg-green-600 px-4 py-2 rounded-2xl font-bold text-sm">+ ADD</button>
          </div>
        </div>
        {list.length === 0 ? (
          <p className="text-gray-500">None yet.</p>
        ) : (
          <div className="space-y-3">
            {list.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 border-b border-gray-800 pb-2 last:border-0">
                <div className="min-w-0">
                  <p className={`font-bold ${color}`}>{formatUSD(Number(e.amount) || 0)}</p>
                  <p className="text-sm text-gray-400 truncate">{fmtDate(e.entry_date)}{e.description ? ` · ${e.description}` : ''}{e.receipt_url ? ' · 📎' : ''}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {e.receipt_url && <a href={e.receipt_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm font-bold">📎</a>}
                  <button onClick={() => setConfirmId(e.id)} className="text-red-400 hover:text-red-300 text-sm font-bold px-2">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove entry</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">ADD {adding}</h2>
              <button onClick={() => setAdding(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-xs text-gray-400">DESCRIPTION</label>
              <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} className={modalInput} placeholder={adding === 'INCOME' ? 'Buyer / sale note' : 'Shipping, fees…'} />
            </div>
            <div className="w-44">
              <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="text" inputMode="decimal" value={amount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value) }} className={`${modalInput} pl-9`} placeholder="0.00" />
              </div>
            </div>
            <DatePicker label="DATE" value={date} onChange={setDate} compact />
            {receipt && <a href={receipt} target="_blank" rel="noopener noreferrer" className="inline-block text-blue-400 hover:text-blue-300 text-sm">📎 Receipt attached</a>}
            <button onClick={save} disabled={saving} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{saving ? 'Saving…' : `SAVE ${adding}`}</button>
          </div>
        </div>
      )}

      <Link href="/inventory" className="text-gray-400 text-lg hover:text-white">← Inventory</Link>
      <div className="flex items-center gap-3 flex-wrap mt-3">
        <h1 className="text-4xl font-bold">SELL — {item?.description || '—'}</h1>
        {sold && <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-700 text-black">SOLD</span>}
      </div>
      <p className="text-gray-400 mt-1 mb-2">{item ? `${item.source_type === 'DONATED' ? 'MSRP' : 'Cost'}: ${formatUSD((Number(item.unit_price) || 0))} · Qty ${item.quantity}${item.supplier ? ` · ${item.supplier}` : ''}` : ''}</p>
      <p className="text-xl font-bold mb-8">Net: <span className={net >= 0 ? 'text-green-400' : 'text-red-400'}>{formatUSD(net)}</span> <span className="text-gray-500 text-base font-normal">(income {formatUSD(incomeTotal)} − expenses {formatUSD(expenseTotal)})</span></p>

      <div className="flex gap-5 flex-wrap">
        <Box kind="INCOME" list={incomes} color="text-green-400" totalVal={incomeTotal} />
        <Box kind="EXPENSE" list={expenses} color="text-orange-400" totalVal={expenseTotal} />
      </div>
    </main>
  )
}
