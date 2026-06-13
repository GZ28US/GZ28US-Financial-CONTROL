'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import HuntPart from '@/components/HuntPart'
import { supabase } from '@/lib/supabase'
import { formatUSD, BASE_PATH } from '@/lib/utils'
import { enrollParts } from '@/lib/partsDb'

type Part = {
  id: string
  item: string
  part_number: string | null
  alias: string | null
  supplier: string | null
  unit_price: number | null
  base_cost: number | null
  tax: number | null
  extra: number | null
  quantity: number | null
  item_discount: number | null
  purchase_date: string | null
  is_extra: boolean
  category: string | null
  source_type: string | null
  donor: string | null
  notes: string | null
  map_price: number | null
  our_cost: number | null
  shipping: number | null
  handling: number | null
  map_delivered: number | null
  cost_delivered: number | null
  part_discount: number | null
  delivered_discount: number | null
  dealer_supplier: string | null
}

const numOf = (s: string) => { const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0 }

export default function PartsPage() {
  const [parts, setParts] = useState<Part[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [hunting, setHunting] = useState(false)
  const [search, setSearch] = useState('')
  const [costFilter, setCostFilter] = useState(false)
  // The part whose OUR cost is being filled, plus its editor fields.
  const [editPart, setEditPart] = useState<Part | null>(null)
  const [ecOur, setEcOur] = useState('')
  const [ecShip, setEcShip] = useState('')
  const [ecHand, setEcHand] = useState('')
  // Manual ADD PART modal (source_type = MANUAL).
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [naItem, setNaItem] = useState('')
  const [naPn, setNaPn] = useState('')
  const [naSupplier, setNaSupplier] = useState('')
  const [naPrice, setNaPrice] = useState('')
  const [naQty, setNaQty] = useState('1')
  const [naDate, setNaDate] = useState('')
  const [naAlias, setNaAlias] = useState('')
  const [naNotes, setNaNotes] = useState('')
  // When arriving from a supplier's PARTS button (?supplierId=…) we restrict the
  // list to that supplier's parts, matching its name + aliases (normalized).
  const [supplierFilter, setSupplierFilter] = useState<{ name: string; variants: Set<string> } | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sid = new URLSearchParams(window.location.search).get('supplierId')
      if (sid) loadSupplierFilter(sid)
    }
    load()
  }, [])

  async function loadSupplierFilter(id: string) {
    const { data } = await supabase.from('suppliers').select('name, aliases').eq('id', id).maybeSingle()
    if (!data) return
    const norm = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const variants = new Set<string>()
    if (norm(data.name)) variants.add(norm(data.name))
    ;(data.aliases || '').split(/[\n,]/).forEach((a: string) => { const n = norm(a); if (n) variants.add(n) })
    setSupplierFilter({ name: data.name || '', variants })
  }

  async function load() {
    const { data } = await supabase.from('parts_database').select('*').order('created_at', { ascending: false, nullsFirst: false })
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

  // HUNT parts carry MAP/cost pricing; "pending" = hunted but OUR cost not yet filled.
  const isHunt = (p: Part) => p.source_type === 'HUNT'
  const isPending = (p: Part) => isHunt(p) && p.our_cost == null

  // Provenance badge — how the part got into the database. Legacy rows (null)
  // predate source tagging and were all built by scanning, so they read SCANNED.
  function sourceBadge(p: Part): { label: string; cls: string } {
    if (p.source_type === 'HUNT') return { label: '🎯 HUNTED', cls: 'bg-yellow-600 text-black' }
    if (p.source_type === 'MANUAL') return { label: '✍️ MANUALLY ENTERED', cls: 'bg-sky-700 text-white' }
    return { label: '🧾 SCANNED', cls: 'bg-purple-700 text-white' }
  }

  function openCostEditor(p: Part) {
    setEditPart(p)
    setEcOur(p.our_cost != null ? String(p.our_cost) : '')
    setEcShip(p.shipping != null ? String(p.shipping) : '')
    setEcHand(p.handling != null ? String(p.handling) : '')
  }

  // Write OUR cost back to a hunted part and recompute delivered + discounts
  // against the stored MAP. This is the surface the assistant drives to clear
  // the PENDING COST queue from the logged-in dealer carts.
  async function saveCost() {
    if (!editPart) return
    const map = Number(editPart.map_price) || 0
    const our = numOf(ecOur), ship = numOf(ecShip), hand = numOf(ecHand)
    // Ordinary buyer pays the SAME freight as us, plus 6.5% FL tax — recompute
    // MAP delivered with the freight so the comparison stays apples-to-apples.
    const mapDel = (map + ship + hand) * 1.065
    const costDel = our + ship + hand
    const partDisc = (map > 0 && our > 0) ? (1 - our / map) * 100 : 0
    const delDisc = (mapDel > 0 && costDel > 0) ? (1 - costDel / mapDel) * 100 : 0
    const { error } = await supabase.from('parts_database').update({
      our_cost: our || null,
      shipping: ship || null,
      handling: hand || null,
      map_delivered: Math.round(mapDel * 100) / 100 || null,
      cost_delivered: Math.round(costDel * 100) / 100 || null,
      part_discount: Math.round(partDisc * 10) / 10,
      delivered_discount: Math.round(delDisc * 10) / 10,
      updated_at: new Date().toISOString(),
    }).eq('id', editPart.id)
    if (error) { alert(error.message); return }
    setEditPart(null)
    load()
  }

  function openAdd() {
    setNaItem(''); setNaPn(''); setNaSupplier(''); setNaPrice(''); setNaQty('1'); setNaDate(''); setNaAlias(''); setNaNotes('')
    setShowAdd(true)
  }

  // Hand-enter a part. Tagged MANUALLY ENTERED so its provenance is clear, and it
  // sorts to the top (created_at default). Landed base cost = the price typed.
  async function saveNewPart() {
    const item = naItem.trim()
    if (!item) { alert('Please enter the part name.'); return }
    setSaving(true)
    const price = numOf(naPrice)
    const { error } = await supabase.from('parts_database').insert([{
      item,
      part_number: naPn.trim() || null,
      alias: naAlias.trim() || null,
      supplier: naSupplier.trim() || null,
      unit_price: price,
      base_cost: price,
      quantity: Number(naQty) || 1,
      purchase_date: /^\d{4}-\d{2}-\d{2}$/.test(naDate) ? naDate : null,
      is_extra: false,
      notes: naNotes.trim() || null,
      source_type: 'MANUAL',
      updated_at: new Date().toISOString(),
    }])
    setSaving(false)
    if (error) { alert(error.message); return }
    setShowAdd(false)
    load()
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
      const res = await fetch(`${BASE_PATH}/api/scan-receipt`, {
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

  const normSup = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const term = search.trim().toLowerCase()
  const filtered = parts.filter(p => {
    if (supplierFilter && !supplierFilter.variants.has(normSup(p.supplier))) return false
    if (costFilter && !isPending(p)) return false
    if (term && !((p.item || '').toLowerCase().includes(term) || (p.alias || '').toLowerCase().includes(term) || (p.part_number || '').toLowerCase().includes(term))) return false
    return true
  })
  const pendingCount = parts.filter(isPending).length

  function formatDate(d: string | null) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const inputClass = 'bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg'
  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {editPart && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-1">OUR COST</h2>
            <p className="text-gray-400">{editPart.item}{editPart.part_number ? ` · ${editPart.part_number}` : ''}</p>
            <p className="text-gray-500 text-sm mb-6">MAP {formatUSD(Number(editPart.map_price) || 0)}{editPart.dealer_supplier ? ` · ${editPart.dealer_supplier}` : ''}</p>
            <div className="grid grid-cols-3 gap-3 mb-6">
              <div><label className="block mb-1 text-sm font-bold text-gray-400">DEALER NET</label><input value={ecOur} onChange={(e) => setEcOur(e.target.value)} className={`${inputClass} w-full`} placeholder="0" autoFocus /></div>
              <div><label className="block mb-1 text-sm font-bold text-gray-400">SHIPPING</label><input value={ecShip} onChange={(e) => setEcShip(e.target.value)} className={`${inputClass} w-full`} placeholder="0" /></div>
              <div><label className="block mb-1 text-sm font-bold text-gray-400">HANDLING</label><input value={ecHand} onChange={(e) => setEcHand(e.target.value)} className={`${inputClass} w-full`} placeholder="0" /></div>
            </div>
            <div className="flex gap-4">
              <button onClick={() => setEditPart(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={saveCost} className="flex-1 bg-green-700 hover:bg-green-600 px-5 py-4 rounded-2xl font-bold text-lg">SAVE COST</button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-lg w-full">
            <h2 className="text-2xl font-bold mb-1">ADD PART</h2>
            <p className="text-gray-500 text-sm mb-6">Hand-entered — saved as <span className="text-sky-400 font-bold">MANUALLY ENTERED</span>.</p>
            <div className="grid grid-cols-1 gap-4 mb-6">
              <div><label className="block mb-1 text-sm font-bold text-gray-400">ITEM *</label><input value={naItem} onChange={(e) => setNaItem(e.target.value)} className={`${inputClass} w-full`} placeholder="Part name" autoFocus /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block mb-1 text-sm font-bold text-gray-400">PART NUMBER</label><input value={naPn} onChange={(e) => setNaPn(e.target.value)} className={`${inputClass} w-full`} placeholder="optional" /></div>
                <div><label className="block mb-1 text-sm font-bold text-gray-400">SUPPLIER</label><input value={naSupplier} onChange={(e) => setNaSupplier(e.target.value)} className={`${inputClass} w-full`} placeholder="optional" /></div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div><label className="block mb-1 text-sm font-bold text-gray-400">UNIT PRICE</label><input value={naPrice} onChange={(e) => setNaPrice(e.target.value)} className={`${inputClass} w-full`} placeholder="0" /></div>
                <div><label className="block mb-1 text-sm font-bold text-gray-400">QTY</label><input value={naQty} onChange={(e) => setNaQty(e.target.value)} className={`${inputClass} w-full`} placeholder="1" /></div>
                <div><label className="block mb-1 text-sm font-bold text-gray-400">DATE</label><input type="date" value={naDate} onChange={(e) => setNaDate(e.target.value)} className={`${inputClass} w-full`} /></div>
              </div>
              <div><label className="block mb-1 text-sm font-bold text-gray-400">ALIAS</label><input value={naAlias} onChange={(e) => setNaAlias(e.target.value)} className={`${inputClass} w-full`} placeholder="Display name (optional)" /></div>
              <div><label className="block mb-1 text-sm font-bold text-gray-400">NOTES</label><input value={naNotes} onChange={(e) => setNaNotes(e.target.value)} className={`${inputClass} w-full`} placeholder="optional" /></div>
            </div>
            <div className="flex gap-4">
              <button onClick={() => setShowAdd(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={saveNewPart} disabled={saving} className={`flex-1 px-5 py-4 rounded-2xl font-bold text-lg ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>{saving ? 'SAVING…' : 'SAVE PART'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">PARTS DATABASE ({filtered.length})</h1>
        <div className="flex gap-3 flex-wrap">
          <button onClick={() => setHunting(true)} className="px-6 py-4 rounded-2xl text-xl font-bold bg-yellow-600 hover:bg-yellow-500 text-black">🎯 HUNT PART</button>
          <label className={`px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer ${scanning ? 'bg-gray-600 cursor-not-allowed' : 'bg-purple-700 hover:bg-purple-600'}`}>
            {scanning ? 'SCANNING…' : '🧾 SCAN ITEMS'}
            <input type="file" accept="image/*,.pdf" className="hidden" disabled={scanning} onChange={(e) => { if (e.target.files?.[0]) handleScanItems(e.target.files[0]); e.currentTarget.value = '' }} />
          </label>
          <button onClick={openAdd} className="px-6 py-4 rounded-2xl text-xl font-bold bg-sky-700 hover:bg-sky-600">➕ ADD PART</button>
        </div>
      </div>

      {hunting && <HuntPart onClose={() => setHunting(false)} onSaved={() => { setHunting(false); load() }} />}

      {supplierFilter && (
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <span className="px-4 py-2 rounded-2xl bg-gray-800 text-base font-bold">Supplier: {supplierFilter.name}</span>
          <a href={`${BASE_PATH}/parts`} className="text-blue-400 hover:text-blue-300 font-bold">show all parts</a>
        </div>
      )}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search item or alias..."
        className={`${inputClass} w-full max-w-2xl mb-4`}
      />

      <div className="flex gap-3 mb-6 flex-wrap">
        <button onClick={() => setCostFilter(false)} className={chip(!costFilter)}>ALL</button>
        <button onClick={() => setCostFilter(true)} className={chip(costFilter)}>💲 OUR COST PENDING ({pendingCount})</button>
      </div>

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
                  {(() => { const b = sourceBadge(p); return <span className={`px-3 py-1 rounded-full text-xs font-bold ${b.cls}`}>{b.label}</span> })()}
                  {p.part_number && <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-200">PN: {p.part_number}</span>}
                  {p.is_extra && <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-600 text-black">EXTRA</span>}
                  {p.supplier && <span className="text-sm text-gray-400">{p.supplier}</span>}
                </div>
                {isHunt(p) ? (
                  <p className="text-sm text-gray-400">
                    MAP del: <span className="text-gray-200 font-bold">{formatUSD(Number(p.map_delivered) || 0)}</span>
                    {p.our_cost != null
                      ? <> · OUR del: <span className="text-green-400 font-bold">{formatUSD(Number(p.cost_delivered) || 0)}</span> ({Number(p.delivered_discount) || 0}% off)</>
                      : <span className="text-amber-400 font-bold"> · OUR COST PENDING</span>}
                    {p.dealer_supplier ? ` · ${p.dealer_supplier}` : ''}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-gray-400">
                      {formatUSD(Number(p.unit_price) || 0)}
                      {(Number(p.tax) || 0) > 0 ? ` · Tax ${formatUSD(Number(p.tax))}` : ''}
                      {(Number(p.extra) || 0) > 0 ? ` · Extra ${formatUSD(Number(p.extra))}` : ''}
                      {(Number(p.item_discount) || 0) > 0 ? ` · Disc ${p.item_discount}%` : ''}
                      {(Number(p.base_cost) || 0) > 0 ? ` · Base ${formatUSD(Number(p.base_cost))}` : ''}
                      {` · ${p.is_extra ? 'cheapest' : 'last'}: ${formatDate(p.purchase_date)}`}
                    </p>
                    {(p.category || p.donor || p.notes) && (
                      <p className="text-xs text-gray-500">
                        {[p.category && `Cat: ${p.category}`, p.donor && `Donor: ${p.donor}`, p.notes].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </>
                )}
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
                {isHunt(p) && <button onClick={() => openCostEditor(p)} className={`px-4 py-2 rounded-2xl font-bold text-sm ${isPending(p) ? 'bg-yellow-600 hover:bg-yellow-500 text-black' : 'bg-gray-600 hover:bg-gray-500'}`}>{isPending(p) ? 'FILL COST' : 'EDIT COST'}</button>}
                <button onClick={() => removePart(p)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
