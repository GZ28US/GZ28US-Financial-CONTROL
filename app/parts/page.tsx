'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'
import { enrollParts } from '@/lib/partsDb'

type Part = {
  id: string
  item: string
  part_number: string | null
  alias: string | null
  supplier: string | null
  unit_price: number | null
  tax: number | null
  extra: number | null
  quantity: number | null
  item_discount: number | null
  purchase_date: string | null
  is_extra: boolean
}

export default function PartsPage() {
  const [parts, setParts] = useState<Part[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase.from('parts_database').select('*').order('item', { ascending: true })
    setParts((data || []) as Part[])
    setLoading(false)
  }

  function setAlias(id: string, value: string) {
    setParts(prev => prev.map(p => p.id === id ? { ...p, alias: value } : p))
  }

  async function saveAlias(p: Part) {
    const { error } = await supabase.from('parts_database').update({ alias: (p.alias || '').trim() || null, updated_at: new Date().toISOString() }).eq('id', p.id)
    if (error) { alert(error.message); return }
  }

  async function removePart(p: Part) {
    if (!window.confirm(`Remove "${p.item}" from the parts database?`)) return
    const { error } = await supabase.from('parts_database').delete().eq('id', p.id)
    if (error) { alert(error.message); return }
    setParts(prev => prev.filter(x => x.id !== p.id))
  }

  // SCAN ITEMS — scan any receipt/invoice and enroll its items into the data bank
  // (same dedupe rules as invoice expense scans). No invoice is created.
  async function handleScanItems(file: File) {
    setScanning(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/scan-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: file.type, separateExtras: true }),
      })
      const data = await res.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanning(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const items = (parsed.items || []).map((i: any) => ({
        item: String(i.description || ''),
        part_number: String(i.part_number || ''),
        supplier,
        unit_price: String(i.amount || '0'),
        quantity: String(i.quantity || '1'),
        tax: String(i.tax || '0'),
        extra: String(i.extra || '0'),
        item_discount: String(i.item_discount || '0'),
        purchase_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      }))
      if (items.length === 0) { alert('No items found on that document.'); setScanning(false); return }
      const n = await enrollParts(items)
      await load()
      alert(`Scanned ${items.length} item(s) — ${n} added/updated in the parts database.`)
    } catch (err) {
      console.error(err)
      alert('Failed to scan. Please try again.')
    }
    setScanning(false)
  }

  const term = search.trim().toLowerCase()
  const filtered = term
    ? parts.filter(p => (p.item || '').toLowerCase().includes(term) || (p.alias || '').toLowerCase().includes(term) || (p.part_number || '').toLowerCase().includes(term))
    : parts

  function formatDate(d: string | null) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const inputClass = 'bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">PARTS DATABASE ({filtered.length})</h1>
        <label className={`px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer ${scanning ? 'bg-gray-600 cursor-not-allowed' : 'bg-purple-700 hover:bg-purple-600'}`}>
          {scanning ? 'SCANNING…' : '🧾 SCAN ITEMS'}
          <input type="file" accept="image/*,.pdf" className="hidden" disabled={scanning} onChange={(e) => { if (e.target.files?.[0]) handleScanItems(e.target.files[0]); e.currentTarget.value = '' }} />
        </label>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search item or alias..."
        className={`${inputClass} w-full max-w-2xl mb-6`}
      />

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{parts.length === 0 ? 'No parts yet. Scan a document or scan expenses on an invoice to build the database.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-4">
          {filtered.map((p) => (
            <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-center justify-between gap-6 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <h2 className="text-xl font-bold">{p.item}</h2>
                  {p.part_number && <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-200">PN: {p.part_number}</span>}
                  {p.is_extra && <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-600 text-black">EXTRA</span>}
                  {p.supplier && <span className="text-sm text-gray-400">{p.supplier}</span>}
                </div>
                <p className="text-sm text-gray-400">
                  {formatUSD(Number(p.unit_price) || 0)}
                  {(Number(p.tax) || 0) > 0 ? ` · Tax ${formatUSD(Number(p.tax))}` : ''}
                  {(Number(p.extra) || 0) > 0 ? ` · Extra ${formatUSD(Number(p.extra))}` : ''}
                  {(Number(p.item_discount) || 0) > 0 ? ` · Disc ${p.item_discount}%` : ''}
                  {` · ${p.is_extra ? 'cheapest' : 'last'}: ${formatDate(p.purchase_date)}`}
                </p>
              </div>
              <div className="flex items-end gap-3 shrink-0 flex-wrap">
                <div>
                  <label className="block mb-1 text-xs text-gray-400 font-bold">ALIAS</label>
                  <input
                    value={p.alias || ''}
                    onChange={(e) => setAlias(p.id, e.target.value)}
                    placeholder="Display name"
                    className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-2 text-base w-56"
                  />
                </div>
                <button onClick={() => saveAlias(p)} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">SAVE</button>
                <button onClick={() => removePart(p)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
