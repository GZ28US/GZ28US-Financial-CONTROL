'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { enrollOne } from '@/lib/partsDb'
import { BASE_PATH } from '@/lib/utils'

// HUNT PART — enter a part number, the app searches the web for the part + its MAP
// and the best place to buy (preferring a dealership supplier). The user confirms
// OUR dealer cost (login-gated, can't be auto-scraped) + freight; the app computes
// the MAP-vs-cost delivered comparison and enrolls the part into the Parts DB.

const FL_TAX = 0.065 // Orange County / Orlando

type HuntResult = {
  found: boolean
  part_number: string
  name: string
  manufacturer: string
  map: number
  sellers: { name: string; price: number; url: string }[]
  best_place: string
  recommended_dealership: string
  notes: string
}

const money = (n: number) => `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const numOf = (s: string) => { const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0 }
const inputClass = 'w-full bg-black border border-gray-700 rounded-2xl px-4 py-3 text-lg'

export default function HuntPart({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<'input' | 'loading' | 'result'>('input')
  const [partNumber, setPartNumber] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<HuntResult | null>(null)
  const [dealers, setDealers] = useState<string[]>([])

  // Editable cost inputs shown with the result.
  const [mapStr, setMapStr] = useState('')
  const [dealer, setDealer] = useState('')
  const [ourCostStr, setOurCostStr] = useState('')
  const [shipStr, setShipStr] = useState('')
  const [handStr, setHandStr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('suppliers').select('name').eq('is_dealership', true).order('name')
      .then(({ data }) => setDealers((data || []).map((d: any) => d.name).filter(Boolean)))
  }, [])

  async function hunt() {
    const pn = partNumber.trim()
    if (!pn) return
    setStep('loading'); setError('')
    try {
      const res = await fetch(`${BASE_PATH}/api/hunt-part`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumber: pn, dealerships: dealers }),
      })
      const data = await res.json()
      if (data.error) { setError(`${data.error}${data.detail ? ' — ' + data.detail : ''}`); setStep('input'); return }
      setResult(data)
      setMapStr(data.map ? String(data.map) : '')
      setDealer(data.recommended_dealership || dealers[0] || '')
      setOurCostStr('')
      setShipStr(''); setHandStr('')
      setStep('result')
    } catch (e) {
      setError('Hunt failed. Please try again.'); setStep('input')
    }
  }

  const map = numOf(mapStr)
  const ourCost = numOf(ourCostStr)
  const ship = numOf(shipStr)
  const hand = numOf(handStr)
  // MAP delivered = ordinary buyer: part + freight + 6.5% FL tax (on the taxable total).
  const mapDelivered = (map + ship + hand) * (1 + FL_TAX)
  // OUR delivered = dealer net + freight, no tax (reseller-exempt), no insurance.
  const ourDelivered = ourCost + ship + hand
  // Discounts only mean something once OUR cost is entered (else it reads 100%).
  const partDisc = (map > 0 && ourCost > 0) ? (1 - ourCost / map) * 100 : 0
  const finalDisc = (mapDelivered > 0 && ourDelivered > 0) ? (1 - ourDelivered / mapDelivered) * 100 : 0

  async function save() {
    if (!result) return
    if (saving) return
    setSaving(true)
    const row: any = {
      item: result.name || result.part_number,
      part_number: result.part_number || null,
      supplier: dealer || null,
      dealer_supplier: dealer || null,
      map_price: map || null,
      our_cost: ourCost || null,
      shipping: ship || null,
      handling: hand || null,
      map_delivered: Math.round(mapDelivered * 100) / 100 || null,
      cost_delivered: Math.round(ourDelivered * 100) / 100 || null,
      part_discount: Math.round(partDisc * 10) / 10,
      delivered_discount: Math.round(finalDisc * 10) / 10,
      source_type: 'HUNT',
      is_extra: false,
      updated_at: new Date().toISOString(),
    }
    // One row per part number, keeping the lowest OUR COST (MAP held constant).
    const { status, error } = await enrollOne(row)
    if (error) { alert(error.message); setSaving(false); return }
    if (status === 'kept') alert('An entry with a lower OUR COST already exists for this part number — kept that one.')
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-3xl font-bold">🎯 HUNT PART</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">✕</button>
        </div>

        {/* INPUT */}
        <div className="flex gap-3 items-end mb-2">
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">PART NUMBER</label>
            <input value={partNumber} onChange={(e) => setPartNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && step !== 'loading') hunt() }}
              className={inputClass} placeholder="e.g. LMI-DURANGO-HC" autoFocus />
          </div>
          <button onClick={hunt} disabled={step === 'loading' || !partNumber.trim()}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-6 py-3 rounded-2xl text-lg font-bold">
            {step === 'loading' ? 'HUNTING…' : 'HUNT'}
          </button>
        </div>
        {error && <p className="text-red-400 text-base mb-2">{error}</p>}
        {step === 'loading' && <p className="text-gray-400 text-lg mt-4">Searching the web for the best price…</p>}

        {/* RESULT */}
        {step === 'result' && result && (
          <div className="mt-6 space-y-5">
            {!result.found && <p className="text-amber-400 text-base">Couldn’t confirm a MAP automatically — enter it below.</p>}

            <div>
              <h3 className="text-2xl font-bold">{result.name || result.part_number}</h3>
              <p className="text-gray-400 text-lg">{[result.manufacturer, result.part_number].filter(Boolean).join(' · ')}</p>
              {result.best_place && <p className="text-lg mt-1">Best place: <span className="font-bold text-green-400">{result.best_place}</span></p>}
              {result.notes && <p className="text-gray-400 text-sm mt-1">{result.notes}</p>}
            </div>

            {result.sellers.length > 0 && (
              <div className="bg-black/40 rounded-2xl p-4">
                <p className="text-sm font-bold text-gray-400 mb-2">SELLERS FOUND</p>
                <div className="space-y-1 text-base">
                  {result.sellers.map((s, i) => (
                    <div key={i} className="flex justify-between gap-3">
                      <span className="truncate">{s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">{s.name}</a> : s.name}</span>
                      <span className="text-gray-300 shrink-0">{s.price ? money(s.price) : '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* COST INPUTS */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block mb-1 text-sm font-bold text-gray-400">MAP (per unit)</label>
                <input value={mapStr} onChange={(e) => setMapStr(e.target.value)} className={inputClass} placeholder="0" />
              </div>
              <div>
                <label className="block mb-1 text-sm font-bold text-gray-400">DEALERSHIP</label>
                <select value={dealer} onChange={(e) => setDealer(e.target.value)} className={inputClass}>
                  <option value="">— none —</option>
                  {dealers.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="block mb-1 text-sm font-bold text-gray-400">OUR COST (dealer net, per unit)</label>
                <input value={ourCostStr} onChange={(e) => setOurCostStr(e.target.value)} className={inputClass} placeholder="from your dealer cart" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-sm font-bold text-gray-400">SHIPPING</label>
                  <input value={shipStr} onChange={(e) => setShipStr(e.target.value)} className={inputClass} placeholder="0" />
                </div>
                <div>
                  <label className="block mb-1 text-sm font-bold text-gray-400">HANDLING</label>
                  <input value={handStr} onChange={(e) => setHandStr(e.target.value)} className={inputClass} placeholder="0" />
                </div>
              </div>
            </div>

            {/* COMPARISON TABLE */}
            <div className="bg-black/40 rounded-2xl p-4">
              <table className="w-full text-base">
                <thead><tr className="text-gray-400 text-sm"><th className="text-left font-bold pb-2"></th><th className="text-right font-bold pb-2">MAP (retail)</th><th className="text-right font-bold pb-2">OUR COST</th></tr></thead>
                <tbody className="text-gray-200">
                  <tr><td className="py-1">Part</td><td className="text-right">{money(map)}</td><td className="text-right">{money(ourCost)}</td></tr>
                  <tr><td className="py-1">Shipping + Handling</td><td className="text-right">{money(ship + hand)}</td><td className="text-right">{money(ship + hand)}</td></tr>
                  <tr><td className="py-1">FL tax 6.5%</td><td className="text-right">{money(mapDelivered - (map + ship + hand))}</td><td className="text-right">$0.00</td></tr>
                  <tr className="border-t border-gray-700 font-bold text-white"><td className="py-2">Delivered</td><td className="text-right">{money(mapDelivered)}</td><td className="text-right">{money(ourDelivered)}</td></tr>
                </tbody>
              </table>
              <div className="flex justify-between mt-3 text-base">
                <span className="text-gray-400">Discount — part: <span className="text-green-400 font-bold">{partDisc.toFixed(2)}%</span></span>
                <span className="text-gray-400">delivered: <span className="text-green-400 font-bold">{finalDisc.toFixed(2)}%</span></span>
              </div>
            </div>

            <div className="flex gap-4">
              <button onClick={() => setStep('input')} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl font-bold text-lg">← New hunt</button>
              <button onClick={save} disabled={saving || map <= 0} className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl font-bold text-xl">
                {saving ? 'SAVING…' : 'SAVE TO PARTS DB'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
