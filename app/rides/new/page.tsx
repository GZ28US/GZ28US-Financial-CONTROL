'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, clientCode } from '@/lib/utils'
import DatePicker from '@/components/DatePicker'
import {
  years,
  manufacturersByYear,
  brandsByManufacturerAndYear,
  modelsByBrandAndYear,
  versionsByModelAndYear,
  specialEditions,
  getAvailableColors,
} from '@/lib/carData'
import { transmissionOptionsFor } from '@/lib/transmissions'

type Client = { id: string; name: string; client_number: number | null; is_quote?: boolean | null; origin?: string | null }
type TransferRide = { id: string; project_code: string; project_name: string | null; client_id: string | null; created_at: string }

function pad3(n: number) { return String(n).padStart(3, '0') }
function todayISO() { return new Date().toISOString().slice(0, 10) }

// Add the current value into the dropdown list if it isn't already there.
// Keeps prefilled ride data visible even when it doesn't fit the year-aware
// catalog (e.g. a Panther Collector Edition car delivered in plain Black).
function ensureIncluded(list: string[], value: string): string[] {
  if (!value || list.includes(value)) return list
  return [value, ...list]
}

export default function NewRidePage() {
  const router = useRouter()

  // Identification fields.
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  // ?client=<id> (from a client's filtered rides list) arrives pre-chosen.
  const [clientId, setClientId] = useState(() => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('client')) || '')
  const [clients, setClients] = useState<Client[]>([])
  // Area determines the code series: US.### (project), US.QT.### (quote),
  // SHP.### (shop). Each is its own independent sequence.
  const [mode] = useState<'project' | 'quote' | 'shop'>(() => {
    if (typeof window === 'undefined') return 'project'
    const m = new URLSearchParams(window.location.search).get('mode')
    return m === 'quote' ? 'quote' : m === 'shop' ? 'shop' : 'project'
  })
  const isQuote = mode === 'quote'
  const isShop = mode === 'shop'

  // EXISTING RIDE — ownership transfer. Picking an existing car for a client
  // sells it to them from the chosen date on: the car keeps its number and its
  // full history; past invoices stay with the previous owner (their client_id
  // stamp), new ones belong to the new owner. Powered by ride_owners periods.
  const [rideMode, setRideMode] = useState<'new' | 'existing'>('new')
  const [allRides, setAllRides] = useState<TransferRide[]>([])
  const [rideSearch, setRideSearch] = useState('')
  const [transferRideId, setTransferRideId] = useState('')
  const [transferDate, setTransferDate] = useState(todayISO())
  const [transferring, setTransferring] = useState(false)

  // Year-driven cascading vehicle fields.
  const [year, setYear] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [version, setVersion] = useState('')
  const [specialEdition, setSpecialEdition] = useState('')
  const [color, setColor] = useState('')
  const [transmission, setTransmission] = useState('')

  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [plateExpiry, setPlateExpiry] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => { loadInitialData() }, [])

  async function loadInitialData() {
    const wantPrefix = isShop ? 'SHP' : isQuote ? 'US.QT' : 'US'

    // Code generation runs first and on its own, so a slow/failed client fetch can
    // never leave the PROJECT CODE blank. Auto-suggest the next code within this
    // kind's own sequence: US.### for project rides, US.QT.### for quote rides —
    // max trailing number among same-kind rides + 1, padded to 3 digits.
    try {
      // Scope the sequence to this area's own origin so SHP.### and US.###
      // never collide (the regex below only reads the trailing number).
      let codeQuery = supabase.from('rides').select('project_code').not('project_code', 'is', null)
      codeQuery = isShop ? codeQuery.eq('origin', 'SHOP') : codeQuery.eq('origin', 'PROJECT').eq('is_quote', isQuote)
      const { data: rideData } = await codeQuery
      // Suggest the LOWEST UNUSED number in this kind's sequence (not global max+1),
      // so a deliberately high / pinned code (e.g. a themed US.170) doesn't drag every
      // new ride up behind it — new rides keep filling the sequence (…035, 036).
      const used = new Set<number>()
      for (const r of (rideData || [])) {
        const m = r.project_code?.match(/^(.+)\.(\d+)$/)
        if (m) used.add(parseInt(m[2], 10))
      }
      let nextNum = 1
      while (used.has(nextNum)) nextNum++
      setProjectCode(`${wantPrefix}.${pad3(nextNum)}`)
    } catch (e) {
      console.error('Code generation failed', e)
      setProjectCode(`${wantPrefix}.${pad3(1)}`)
    }

    // Clients load independently (ordered for a predictable list); a failure here
    // logs but never touches the code above.
    //
    // A PROJECT ride lists only project clients. A QUOTE ride lists BOTH quote and
    // project clients: quoting a NEW CAR for an EXISTING (project) client is the
    // common case, and hiding him here forced the car to be created as a project
    // ride first — burning a real US.### number on a job that may never close.
    // Quote and project clients each number from 1, so the label uses clientCode()
    // (US.001 vs US.QT.001) to keep the two #001s apart. Project clients sort first.
    try {
      let clientQuery = supabase.from('clients').select('id, name, client_number, is_quote, origin')
      if (isShop) {
        clientQuery = clientQuery.eq('origin', 'SHOP')
      } else {
        clientQuery = clientQuery.eq('origin', 'PROJECT')
        if (!isQuote) clientQuery = clientQuery.eq('is_quote', false)
      }
      const { data: clientData } = await clientQuery
        .order('is_quote', { ascending: true })
        .order('client_number', { ascending: true, nullsFirst: false })
      if (clientData) setClients(clientData as Client[])
    } catch (e) {
      console.error('Client load failed', e)
    }

    // Rides available for an ownership transfer (project rides only — quote
    // rides are never sold between clients).
    if (!isQuote) {
      try {
        let xQuery = supabase.from('rides').select('id, project_code, project_name, client_id, created_at')
        xQuery = isShop ? xQuery.eq('origin', 'SHOP') : xQuery.eq('origin', 'PROJECT').eq('is_quote', false)
        const { data: rideRows } = await xQuery.order('project_code', { ascending: true })
        if (rideRows) setAllRides(rideRows as TransferRide[])
      } catch (e) {
        console.error('Rides load failed', e)
      }
    }
  }

  // Sell an existing ride to the chosen client. Records the ownership periods
  // (ride_owners) and flips the ride's current owner. History stays put: old
  // invoices keep the previous owner's client_id stamp.
  async function transferRide() {
    if (!clientId) { alert('Choose the NEW OWNER (client) first.'); return }
    if (!transferRideId) { alert('Choose the ride being transferred.'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transferDate)) { alert('Set the transfer date.'); return }
    const ride = allRides.find(r => r.id === transferRideId)
    if (!ride) return
    if (ride.client_id === clientId) { alert('This ride already belongs to that client.'); return }
    setTransferring(true)
    try {
      // 1) Close any open ownership period at the transfer date.
      const { data: openPeriods, error: histErr } = await supabase
        .from('ride_owners')
        .select('id, client_id')
        .eq('ride_id', ride.id)
        .is('to_date', null)
      if (histErr) {
        alert('Ownership history table missing (ride_owners) — run the migration SQL first.\n\n' + histErr.message)
        setTransferring(false); return
      }
      if (openPeriods && openPeriods.length > 0) {
        const { error } = await supabase.from('ride_owners').update({ to_date: transferDate }).eq('ride_id', ride.id).is('to_date', null)
        if (error) { alert(error.message); setTransferring(false); return }
      } else if (ride.client_id) {
        // First-ever transfer: record the previous owner's era (since the ride
        // was created) as a closed period.
        const { error } = await supabase.from('ride_owners').insert([{
          ride_id: ride.id, client_id: ride.client_id,
          from_date: (ride.created_at || '').slice(0, 10) || transferDate, to_date: transferDate,
        }])
        if (error) { alert(error.message); setTransferring(false); return }
      }
      // 2) Open the new owner's period.
      const { error: insErr } = await supabase.from('ride_owners').insert([{ ride_id: ride.id, client_id: clientId, from_date: transferDate, to_date: null }])
      if (insErr) { alert(insErr.message); setTransferring(false); return }
      // 3) The car is the new client's from now on.
      const { error: updErr } = await supabase.from('rides').update({ client_id: clientId }).eq('id', ride.id)
      if (updErr) { alert(updErr.message); setTransferring(false); return }
      router.push(`/clients/${clientId}`)
    } catch (e) {
      alert('Transfer failed: ' + String(e))
      setTransferring(false)
    }
  }

  // Derived dropdown options based on the year-aware carData maps. Every level is
  // wrapped in ensureIncluded so a prefilled real-life value outside the catalog
  // still shows and saves instead of rendering an empty select.
  const yearNum = year ? parseInt(year, 10) : 0
  const availableManufacturers = ensureIncluded(yearNum ? (manufacturersByYear[yearNum] || []) : [], manufacturer)
  const availableBrands = ensureIncluded((yearNum && manufacturer)
    ? (brandsByManufacturerAndYear[manufacturer]?.[yearNum] || []) : [], brand)
  const availableModels = ensureIncluded((yearNum && brand)
    ? (modelsByBrandAndYear[brand]?.[yearNum] || []) : [], model)
  const availableVersions = ensureIncluded((yearNum && model)
    ? (versionsByModelAndYear[model]?.[yearNum] || []) : [], version)

  // SPECIAL EDITION is shown when the catalog has one defined for this
  // year+model+version combination, OR when the form already carries one.
  const specialEditionKey = `${yearNum}-${model}-${version}`
  const catalogSpecialEditions = specialEditions[specialEditionKey] || null
  const availableSpecialEditions = catalogSpecialEditions
    ? ensureIncluded(catalogSpecialEditions, specialEdition)
    : (specialEdition ? [specialEdition] : null)

  const availableColors = ensureIncluded((yearNum && brand && model && version)
    ? getAvailableColors(yearNum, brand, model, version, specialEdition || 'None')
    : [], color)

  // Cascading resets: changing any level wipes everything below it so the
  // user can't end up with an impossible combination.
  function changeYear(v: string) {
    setYear(v); setManufacturer(''); setBrand(''); setModel(''); setVersion(''); setSpecialEdition(''); setColor('')
  }
  function changeManufacturer(v: string) {
    setManufacturer(v); setBrand(''); setModel(''); setVersion(''); setSpecialEdition(''); setColor('')
  }
  function changeBrand(v: string) {
    setBrand(v); setModel(''); setVersion(''); setSpecialEdition(''); setColor('')
  }
  function changeModel(v: string) {
    setModel(v); setVersion(''); setSpecialEdition(''); setColor('')
  }
  function changeVersion(v: string) {
    setVersion(v); setSpecialEdition(''); setColor('')
  }
  function changeSpecialEdition(v: string) {
    setSpecialEdition(v); setColor('')
  }

  async function uploadPhoto(file: File) {
    setUploading(true)
    const ext = file.name.split('.').pop()
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage.from('ride-photos').upload(path, file, { upsert: true })
    if (error) { alert(error.message); setUploading(false); return }
    const { data: urlData } = supabase.storage.from('ride-photos').getPublicUrl(path)
    setPhotoUrl(urlData.publicUrl)
    setUploading(false)
  }

  // Factory transmission options for the currently selected car (empty = unknown → no picker).
  const transmissionOptions = transmissionOptionsFor(year, brand, model, version)

  async function saveRide() {
    if (!projectCode.trim()) { alert('Please enter a project code'); return }

    // Store "None" special edition as null so reports don't print "None".
    const seValue = specialEdition && specialEdition !== 'None' ? specialEdition : null

    const { error } = await supabase.from('rides').insert([{
      project_code: projectCode.trim(),
      project_name: projectName || null,
      client_id: clientId || null,
      year: yearNum || null,
      manufacturer: manufacturer || null,
      brand: brand || null,
      model: model || null,
      version: version || null,
      special_edition: seValue,
      // Single factory option → stamped automatically; multi-option cars use the picker.
      transmission: transmissionOptions.length === 1 ? transmissionOptions[0] : (transmission || null),
      color: color || null,
      vin: vin || null,
      plate: plate || null,
      plate_expiry: plateExpiry || null,
      photo_url: photoUrl || null,
      is_quote: isQuote,
      origin: isShop ? 'SHOP' : 'PROJECT',
    }])
    if (error) { alert(error.message); return }

    // Dropbox folder sync: every new PROJECT ride gets its physical folder
    // ("CODE - Name") in GZ28US Rides. Quotes and shop rides don't. Non-blocking.
    if (mode === 'project') {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', zone: 'US', code: projectCode.trim(), name: projectName || '' }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.error) alert('Ride saved, but the Dropbox folder could not be created:\n' + (data.error || `HTTP ${res.status}`))
      } catch (e) {
        alert('Ride saved, but the Dropbox folder could not be created:\n' + String(e))
      }
    }
    router.push(`/rides?mode=${mode}`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const disabledClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl opacity-50 cursor-not-allowed'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">ADD A NEW RIDE</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        {/* Brand-new car vs transferring an existing one to this client. */}
        {!isQuote && (
          <div className="flex gap-3">
            <button type="button" onClick={() => setRideMode('new')} className={`flex-1 px-5 py-4 rounded-2xl text-lg font-bold border ${rideMode === 'new' ? 'bg-green-800 border-green-500' : 'bg-gray-900 border-gray-700 hover:border-gray-500'}`}>🚗 BRAND-NEW RIDE</button>
            <button type="button" onClick={() => setRideMode('existing')} className={`flex-1 px-5 py-4 rounded-2xl text-lg font-bold border ${rideMode === 'existing' ? 'bg-purple-800 border-purple-500' : 'bg-gray-900 border-gray-700 hover:border-gray-500'}`}>🔁 EXISTING RIDE — NEW OWNER</button>
          </div>
        )}

        {rideMode === 'existing' && !isQuote ? (
          <>
            <p className="text-gray-400 text-lg">
              The car was sold to a new owner: it keeps its number and its whole history.
              Everything up to the transfer date stays with the previous owner; from that
              moment on, the ride and its new invoices belong to the new client.
            </p>

            <div>
              <label className="block mb-2 text-lg font-bold">NEW OWNER</label>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={selectClass}>
                <option value="">— Select the client —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>
                    {clientCode(c)} — {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block mb-2 text-lg font-bold">RIDE BEING TRANSFERRED</label>
              <input
                type="text"
                value={rideSearch}
                onChange={(e) => setRideSearch(e.target.value)}
                className={inputClass}
                placeholder="Search by code or name…"
              />
              <select value={transferRideId} onChange={(e) => setTransferRideId(e.target.value)} className={`${selectClass} mt-3`}>
                <option value="">— Select the ride —</option>
                {allRides
                  .filter(r => r.client_id !== clientId || !clientId)
                  .filter(r => {
                    const q = rideSearch.trim().toLowerCase()
                    if (!q) return true
                    return (r.project_code || '').toLowerCase().includes(q) || (r.project_name || '').toLowerCase().includes(q)
                  })
                  .map(r => (
                    <option key={r.id} value={r.id}>{r.project_code}{r.project_name ? ` — ${r.project_name}` : ''}</option>
                  ))}
              </select>
            </div>

            <div>
              <label className="block mb-2 text-lg font-bold">TRANSFER DATE</label>
              <input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className={inputClass} />
            </div>

            <button onClick={transferRide} disabled={transferring} className="bg-purple-700 hover:bg-purple-600 disabled:opacity-60 px-6 py-4 rounded-2xl text-xl font-bold">
              {transferring ? 'TRANSFERRING…' : '🔁 TRANSFER OWNERSHIP'}
            </button>
            <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
          </>
        ) : (
        <>

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT CODE</label>
          <input type="text" value={projectCode} onChange={(e) => setProjectCode(e.target.value)} className={inputClass} placeholder="e.g. US.001" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT NAME</label>
          <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} className={inputClass} placeholder="e.g. Black Beast" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CLIENT</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={selectClass}>
            <option value="">— No client —</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>
                {clientCode(c)} — {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">YEAR</label>
          <select value={year} onChange={(e) => changeYear(e.target.value)} className={selectClass}>
            <option value="">— Select year —</option>
            {[...years].sort((a, b) => b - a).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MANUFACTURER</label>
          <select value={manufacturer} onChange={(e) => changeManufacturer(e.target.value)} className={!year ? disabledClass : selectClass} disabled={!year}>
            <option value="">— Select —</option>
            {availableManufacturers.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">BRAND</label>
          <select value={brand} onChange={(e) => changeBrand(e.target.value)} className={!manufacturer ? disabledClass : selectClass} disabled={!manufacturer}>
            <option value="">— Select —</option>
            {availableBrands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MODEL</label>
          <select value={model} onChange={(e) => changeModel(e.target.value)} className={!brand ? disabledClass : selectClass} disabled={!brand}>
            <option value="">— Select —</option>
            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">VERSION</label>
          <select value={version} onChange={(e) => changeVersion(e.target.value)} className={!model ? disabledClass : selectClass} disabled={!model}>
            <option value="">— Select —</option>
            {availableVersions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        {/* SPECIAL EDITION renders only when the catalog has one for this version. */}
        {availableSpecialEditions && (
          <div>
            <label className="block mb-2 text-lg font-bold">SPECIAL EDITION</label>
            <select value={specialEdition} onChange={(e) => changeSpecialEdition(e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {availableSpecialEditions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {transmissionOptions.length > 1 && (
          <div>
            <label className="block mb-2 text-lg font-bold">TRANSMISSION</label>
            <select value={transmission} onChange={(e) => setTransmission(e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {ensureIncluded(transmissionOptions, transmission).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">COLOR</label>
          <select value={color} onChange={(e) => setColor(e.target.value)} className={!version ? disabledClass : selectClass} disabled={!version}>
            <option value="">— Select —</option>
            {availableColors.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">VIN</label>
          <input type="text" value={vin} onChange={(e) => setVin(e.target.value)} className={inputClass} placeholder="Vehicle Identification Number" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PLATE</label>
          <input type="text" value={plate} onChange={(e) => setPlate(e.target.value)} className={inputClass} placeholder="License plate" />
        </div>

        {/* Registration (tag) expiry — HOME warns before it lapses. */}
        <div>
          <DatePicker label="PLATE EXPIRY (registration)" value={plateExpiry} onChange={setPlateExpiry} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PHOTO</label>
          {photoUrl && (
            <div className="mb-3 rounded-2xl overflow-hidden border border-gray-700">
              <img src={photoUrl} alt="Car photo" className="w-full max-h-64 object-cover" />
            </div>
          )}
          <label className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
            {uploading ? 'Uploading...' : photoUrl ? '🔄 CHANGE PHOTO' : '📷 UPLOAD PHOTO'}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) uploadPhoto(e.target.files[0]) }} />
          </label>
          {photoUrl && (
            <button onClick={() => setPhotoUrl('')} className="ml-3 text-red-400 hover:text-red-300 font-bold text-lg">REMOVE</button>
          )}
        </div>

        <button onClick={saveRide} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE RIDE</button>
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>

        </>
        )}
      </div>
    </main>
  )
}
