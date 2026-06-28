'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH } from '@/lib/utils'

type FixedExpense = { id: string; type: string; description: string | null; amount: number; source: string | null; expense_date: string | null }
type Scanned = { type: string; description: string; amount: string; source: string; date: string }

const TYPES = ['ALL', 'MONTHLY', 'WEEKLY', 'DAILY', 'SINGLE'] as const
const EXPENSE_TYPES = ['MONTHLY', 'WEEKLY', 'DAILY', 'SINGLE']
function isValidDate(d: string | null | undefined) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function fmtDate(d: string | null | undefined) { return isValidDate(d) ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '' }

export default function SeasonExpensesPage() {
  const params = useParams()
  const id = String(params.id)
  const seasonId = String(params.seasonId)
  const [rows, setRows] = useState<FixedExpense[]>([])
  const [seasonCode, setSeasonCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<typeof TYPES[number]>('ALL')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState<Scanned | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [seasonId])

  async function load() {
    const { data: season } = await supabase.from('fixed_cost_seasons').select('season_code').eq('id', seasonId).maybeSingle()
    setSeasonCode((season?.season_code || '') as string)
    const { data } = await supabase.from('fixed_cost_expenses').select('*').eq('season_id', seasonId).order('created_at', { ascending: false })
    setRows((data || []) as FixedExpense[])
    setLoading(false)
  }

  async function remove(eid: string) {
    const { error } = await supabase.from('fixed_cost_expenses').delete().eq('id', eid)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  // SCAN EXPENSE: read the receipt, extract supplier/date/items via the scan API, and
  // open a review modal pre-filled as a one-off (SINGLE) expense.
  async function handleScan(file: File) {
    setScanning(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: file.type }),
      })
      const data = await res.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      // Per-unit amount × quantity folds into the line total; note the qty in the name.
      const items = (parsed.items || []).map((i: any) => {
        const qty = parseFloat(i.quantity) || 1
        const lineTotal = (parseFloat(i.amount) || 0) * qty
        return { description: qty > 1 ? `${String(i.description || '')} (×${qty})` : String(i.description || ''), amount: lineTotal }
      })
      const total = items.reduce((s: number, it: any) => s + it.amount, 0)
      const desc = items.length > 0 ? items.map((i: any) => i.description).filter(Boolean).join(', ') : String(parsed.supplier || '')
      setScanned({
        type: 'SINGLE',
        description: desc,
        amount: total ? total.toFixed(2) : '',
        source: DEFAULT_SOURCE,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) ? String(parsed.date) : '',
      })
    } catch (err) {
      console.error(err); alert('Failed to scan receipt. Please try again.')
    } finally {
      setScanning(false)
    }
  }

  async function confirmScanned() {
    if (!scanned) return
    if (!scanned.amount) { alert('Please enter an amount'); return }
    setSaving(true)
    const { error } = await supabase.from('fixed_cost_expenses').insert([{
      supplier_id: id,
      season_id: seasonId,
      type: scanned.type,
      description: scanned.description || null,
      amount: parseFloat(scanned.amount) || 0,
      source: scanned.source || DEFAULT_SOURCE,
      expense_date: (scanned.type === 'SINGLE' && isValidDate(scanned.date)) ? scanned.date : null,
    }])
    setSaving(false)
    if (error) { alert(error.message); return }
    setScanned(null); load()
  }

  const q = search.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    const typeOk = filter === 'ALL' || r.type === filter
    const searchOk = !q || [r.description, r.source, r.type].some((v) => (v || '').toLowerCase().includes(q))
    return typeOk && searchOk
  })
  const total = filtered.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  const modalInput = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Expense</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {scanned && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW SCANNED EXPENSE</h2>
              <button onClick={() => setScanned(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="w-32">
                <label className="block mb-1 text-xs text-gray-400">TYPE</label>
                <select value={scanned.type} onChange={(e) => setScanned({ ...scanned, type: e.target.value })} className={modalInput}>
                  {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[12rem]">
                <label className="block mb-1 text-xs text-gray-400">DESCRIPTION</label>
                <input type="text" value={scanned.description} onChange={(e) => setScanned({ ...scanned, description: e.target.value })} className={modalInput} />
              </div>
            </div>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="w-40">
                <label className="block mb-1 text-xs text-gray-400">AMOUNT</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="text" inputMode="decimal" value={scanned.amount} onChange={(e) => { if (/^-?\d*\.?\d*$/.test(e.target.value)) setScanned({ ...scanned, amount: e.target.value }) }} className={`${modalInput} pl-9`} placeholder="0.00" />
                </div>
              </div>
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-xs text-gray-400">PAID FROM</label>
                <SourceSelect value={scanned.source} onChange={(v) => setScanned({ ...scanned, source: v })} className={modalInput} />
              </div>
            </div>
            {scanned.type === 'SINGLE' && <DatePicker label="DATE" value={scanned.date} onChange={(v) => setScanned({ ...scanned, date: v })} compact />}
            <button onClick={confirmScanned} disabled={saving} className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-60 px-6 py-3 rounded-2xl font-bold text-lg">{saving ? 'Saving…' : 'SAVE EXPENSE'}</button>
          </div>
        </div>
      )}

      <Link href={`/costs/fixed/${id}/seasons`} className="text-gray-400 text-lg hover:text-white">← Seasons</Link>

      <div className="flex items-center justify-between mt-3 mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">Season {seasonCode} — EXPENSES ({rows.length})</h1>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description, payer, type…"
            className="w-56 sm:w-72 max-w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg"
          />
          <label className={`bg-purple-700 hover:bg-purple-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap cursor-pointer ${scanning ? 'opacity-60 pointer-events-none' : ''}`}>
            {scanning ? 'Scanning…' : '📸 SCAN EXPENSE'}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScan(e.target.files[0]) }} />
          </label>
          <Link href={`/costs/fixed/${id}/seasons/${seasonId}/expenses/new`} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold whitespace-nowrap">+ ADD EXPENSE</Link>
        </div>
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {TYPES.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-4 py-2 rounded-full font-bold ${filter === c ? 'bg-blue-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No expenses yet.' : 'No matches.'}</p>
      ) : (
        <>
          <div className="space-y-5">
            {filtered.map((r) => (
              <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700">{r.type}</span>
                    <h2 className="text-2xl font-bold truncate">{r.description || '—'}</h2>
                  </div>
                  <p className="text-lg text-gray-400">{formatUSD(Number(r.amount) || 0)}{r.source ? ` · ${r.source}` : ''}{r.expense_date ? ` · ${fmtDate(r.expense_date)}` : ''}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  <button onClick={() => setConfirmId(r.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xl font-bold text-gray-300">Total ({filter}): {formatUSD(total)}</p>
        </>
      )}
    </main>
  )
}
