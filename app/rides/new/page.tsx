'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import {
  years,
  manufacturersByYear,
  brandsByManufacturerAndYear,
  modelsByBrandAndYear,
  versionsByModelAndYear,
  specialEditions,
  getAvailableColors,
} from '@/lib/carData'

type Client = { id: string; name: string; client_number: number | null }

function pad3(n: number) { return String(n).padStart(3, '0') }

export default function NewRidePage() {
  const router = useRouter()

  // Identification fields.
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  // Quote-area rides are quote rides (US.QT.###); project-area are US.###.
  const [isQuote] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'quote')

  // Year-driven cascading vehicle fields.
  const [year, setYear] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [version, setVersion] = useState('')
  const [specialEdition, setSpecialEdition] = useState('')
  const [color, setColor] = useState('')

  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(() => { loadInitialData() }, [])

  async function loadInitialData() {
    const wantPrefix = isQuote ? 'US.QT' : 'US'

    // Code generation runs first and on its own, so a slow/failed client fetch can
    // never leave the PROJECT CODE blank. Auto-suggest the next code within this
    // kind's own sequence: US.### for project rides, US.QT.### for quote rides —
    // max trailing number among same-kind rides + 1, padded to 3 digits.
    try {
      const { data: rideData } = await supabase
        .from('rides')
        .select('project_code')
        .eq('is_quote', isQuote)
        .not('project_code', 'is', null)
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

    // Clients load independently (ordered by client_number for a predictable list);
    // a failure here logs but never touches the code above. Quote clients and
    // project clients are separate sequences (each numbered from 1), so a quote
    // ride only lists quote clients and a project ride only project clients —
    // otherwise the two #001s, #002s… collide in the dropdown.
    try {
      const { data: clientData } = await supabase
        .from('clients')
        .select('id, name, client_number')
        .eq('is_quote', isQuote)
        .order('client_number', { ascending: true, nullsFirst: false })
      if (clientData) setClients(clientData as Client[])
    } catch (e) {
      console.error('Client load failed', e)
    }
  }

  // Derived dropdown options based on the year-aware carData maps.
  const yearNum = year ? parseInt(year, 10) : 0
  const availableManufacturers = yearNum ? (manufacturersByYear[yearNum] || []) : []
  const availableBrands = (yearNum && manufacturer)
    ? (brandsByManufacturerAndYear[manufacturer]?.[yearNum] || []) : []
  const availableModels = (yearNum && brand)
    ? (modelsByBrandAndYear[brand]?.[yearNum] || []) : []
  const availableVersions = (yearNum && model)
    ? (versionsByModelAndYear[model]?.[yearNum] || []) : []

  // SPECIAL EDITION is only shown when the catalog has one defined for this
  // year+model+version combination.
  const specialEditionKey = `${yearNum}-${model}-${version}`
  const availableSpecialEditions = specialEditions[specialEditionKey] || null

  const availableColors = (yearNum && brand && model && version)
    ? getAvailableColors(yearNum, brand, model, version, specialEdition || 'None')
    : []

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
      color: color || null,
      vin: vin || null,
      plate: plate || null,
      photo_url: photoUrl || null,
      is_quote: isQuote,
    }])
    if (error) { alert(error.message); return }

    // Dropbox folder sync: every new PROJECT ride gets its physical folder
    // ("CODE - Name") in GZ28US Rides. Quotes never get folders. Non-blocking.
    if (!isQuote) {
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
    router.push(`/rides?mode=${isQuote ? 'quote' : 'project'}`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const disabledClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl opacity-50 cursor-not-allowed'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">ADD A NEW RIDE</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

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
                {c.client_number != null ? `${pad3(c.client_number)} — ` : ''}{c.name}
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
      </div>
    </main>
  )
}
