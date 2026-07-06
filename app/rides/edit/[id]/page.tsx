'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { supabaseBR } from '@/lib/supabaseBR'
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

// Add the saved value into the dropdown list if it isn't already there.
// Keeps legacy ride data editable even when it doesn't fit the year-aware catalog.
function ensureIncluded(list: string[], value: string): string[] {
  if (!value || list.includes(value)) return list
  return [value, ...list]
}

export default function EditRidePage() {
  const router = useRouter()
  const params = useParams()
  const rideId = String(params.id)

  // Identification fields.
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<Client[]>([])

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

  // BoneStock TUNE file — lives in the car's Dropbox HB Tuning folder (both archives for common cars).
  const [tuneExisting, setTuneExisting] = useState<string[]>([])
  const [tuneUploading, setTuneUploading] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadInitialData() }, [])

  async function loadInitialData() {
    // Load clients in parallel with the ride record.
    const [clientsRes, rideRes] = await Promise.all([
      supabase.from('clients').select('id, name, client_number, is_quote').order('client_number', { ascending: true, nullsFirst: false }),
      supabase.from('rides').select('*').eq('id', rideId).single(),
    ])

    if (rideRes.error || !rideRes.data) {
      alert(rideRes.error?.message || 'Ride not found')
      router.push('/rides')
      return
    }
    const r = rideRes.data
    // Only list clients of the same kind (quote vs project) as this ride, so the
    // two separately-numbered sequences (each from 1) don't collide in the dropdown.
    if (clientsRes.data) setClients((clientsRes.data as any[]).filter(c => !!c.is_quote === !!r.is_quote) as Client[])
    setProjectCode(r.project_code || '')
    setProjectName(r.project_name || '')
    void loadTuneStatus(r.project_code || '')
    setClientId(r.client_id || '')
    setYear(r.year ? String(r.year) : '')
    setManufacturer(r.manufacturer || '')
    setBrand(r.brand || '')
    setModel(r.model || '')
    setVersion(r.version || '')
    setSpecialEdition(r.special_edition || '')
    setColor(r.color || '')
    setVin(r.vin || '')
    setPlate(r.plate || '')
    setPhotoUrl(r.photo_url || '')
    setLoading(false)
  }

  // Derived dropdown options based on the year-aware carData maps. Any saved
  // value not in the catalog is still surfaced so legacy data stays editable.
  const yearNum = year ? parseInt(year, 10) : 0
  const availableManufacturers = ensureIncluded(
    yearNum ? (manufacturersByYear[yearNum] || []) : [],
    manufacturer,
  )
  const availableBrands = ensureIncluded(
    (yearNum && manufacturer) ? (brandsByManufacturerAndYear[manufacturer]?.[yearNum] || []) : [],
    brand,
  )
  const availableModels = ensureIncluded(
    (yearNum && brand) ? (modelsByBrandAndYear[brand]?.[yearNum] || []) : [],
    model,
  )
  const availableVersions = ensureIncluded(
    (yearNum && model) ? (versionsByModelAndYear[model]?.[yearNum] || []) : [],
    version,
  )

  // SPECIAL EDITION renders only when the catalog has one defined for this
  // year+model+version, OR when the ride already has one saved (legacy data).
  const specialEditionKey = `${yearNum}-${model}-${version}`
  const catalogSpecialEditions = specialEditions[specialEditionKey] || null
  const availableSpecialEditions = catalogSpecialEditions
    ? ensureIncluded(catalogSpecialEditions, specialEdition)
    : (specialEdition ? [specialEdition] : null)

  const baseColors = (yearNum && brand && model && version)
    ? getAvailableColors(yearNum, brand, model, version, specialEdition || 'None')
    : []
  const availableColors = ensureIncluded(baseColors, color)

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

  // Which BoneStock tune files already exist in the car's HB Tuning folder(s)?
  async function loadTuneStatus(code: string) {
    if (!code) return
    const found = new Set<string>()
    await Promise.all(['US', 'BR'].map(async (zone) => {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'find', zone, code, match: 'bonestock tune' }) })
        const d = await res.json().catch(() => ({}))
        for (const f of d.files || []) found.add(String(f))
      } catch { /* status display only */ }
    }))
    setTuneExisting([...found].sort())
  }

  // Upload the BoneStock tune straight into the car's Dropbox HB Tuning folder(s), overwrite mode.
  async function uploadTune(file: File) {
    if (!projectCode) { alert('The ride needs a code before uploading the tune.'); return }
    if (file.size > 3 * 1024 * 1024) { alert('Tune file too big (max 3 MB).'); return }
    setTuneUploading(true)
    try {
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] || '')
        r.onerror = reject
        r.readAsDataURL(file)
      })
      const ext = file.name.split('.').pop() || 'hpt'
      const filename = `${projectCode}${projectName ? ' - ' + projectName : ''} BoneStock Tune.${ext}`
      let landed = 0
      for (const zone of ['US', 'BR']) {
        try {
          const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', zone, code: projectCode, name: projectName, filename, contentBase64: b64 }) })
          const d = await res.json().catch(() => ({}))
          if (d.ok && d.result === 'uploaded') landed++
        } catch { /* counted below */ }
      }
      if (!landed) alert('The BoneStock tune could not be saved to the Dropbox HB Tuning folder.')
      else await loadTuneStatus(projectCode)
    } finally {
      setTuneUploading(false)
    }
  }

  async function saveChanges() {
    if (!projectCode.trim()) { alert('Please enter a project code'); return }
    setSaving(true)

    // Store "None" special edition as null so reports don't print "None".
    const seValue = specialEdition && specialEdition !== 'None' ? specialEdition : null

    // Capture the previous code so invoice codes can follow a code change.
    const newCode = projectCode.trim()
    const { data: cur } = await supabase.from('rides').select('project_code').eq('id', rideId).single()
    const oldCode = cur?.project_code || ''

    const { error } = await supabase.from('rides').update({
      project_code: newCode,
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
    }).eq('id', rideId)

    if (error) { setSaving(false); alert(error.message); return }

    // The invoice code always carries the car's code: when the ride code changes,
    // re-code every invoice on this ride (e.g. US.522.1 -> US.517.1).
    if (oldCode && oldCode !== newCode) {
      const { data: invs } = await supabase.from('invoices').select('id, invoice_code').eq('ride_id', rideId)
      for (const inv of (invs || [])) {
        if (inv.invoice_code?.startsWith(oldCode + '.')) {
          await supabase.from('invoices').update({ invoice_code: newCode + inv.invoice_code.slice(oldCode.length) }).eq('id', inv.id)
        }
      }
    }

    // Shared Performance DataBank (dyno pulls + build sheets, keyed by ride
    // code in the US project): the rows follow a renumbered code.
    if (oldCode && oldCode !== newCode) {
      await supabase.from('dyno_pulls').update({ ride_code: newCode }).eq('ride_code', oldCode)
      await supabase.from('ride_build_sheets').update({ ride_code: newCode }).eq('ride_code', oldCode)
      await supabase.from('ride_builds').update({ ride_code: newCode }).eq('ride_code', oldCode)
    }

    // COMMON cars live in BOTH apps under the SAME code (e.g. US.038). A rename
    // here renames the BR system too: code, name and the BR invoices that carry
    // the code. Self-gating — if BR has no ride with this code, nothing happens.
    let isCommonCar = false
    try {
      const { data: brRide } = await supabaseBR.from('rides').select('id').eq('project_code', oldCode).maybeSingle()
      if (brRide) {
        isCommonCar = true
        await supabaseBR.from('rides').update({ project_code: newCode, project_name: projectName || null }).eq('id', brRide.id)
        if (oldCode !== newCode) {
          const { data: binvs } = await supabaseBR.from('invoices').select('id, invoice_code').eq('ride_id', brRide.id)
          for (const inv of (binvs || [])) {
            if (inv.invoice_code?.startsWith(oldCode + '.')) {
              await supabaseBR.from('invoices').update({ invoice_code: newCode + inv.invoice_code.slice(oldCode.length) }).eq('id', inv.id)
            }
          }
        }
      }
    } catch (e) {
      alert('Warning: this car also exists in the BR app but the rename could not be synced there — rename it in the BR app manually.\n' + String(e))
    }

    // Dropbox folder sync: the physical ride folder follows every rename /
    // renumber ("OLDCODE - x" -> "NEWCODE - NewName"). Common cars also update
    // their folder in the BR archive. Non-blocking.
    const folderFails: string[] = []
    for (const zone of isCommonCar ? ['US', 'BR'] : ['US']) {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', zone, oldCode, newCode, name: projectName || '' }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.error) folderFails.push(`${zone}: ${data.error || `HTTP ${res.status}`}`)
      } catch (e) { folderFails.push(`${zone}: ${String(e)}`) }
    }
    if (folderFails.length) alert('Ride saved, but the Dropbox folder sync failed —\n' + folderFails.join('\n'))

    setSaving(false)
    router.push(`/rides/${rideId}`)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const disabledClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl opacity-50 cursor-not-allowed'

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white p-8">
        <Header />
        <p className="text-2xl text-gray-400">Loading...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT RIDE</h1>

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

        {/* SPECIAL EDITION renders only when the catalog has one for this version, or when one is already saved. */}
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

        <div>
          <label className="block mb-2 text-lg font-bold">BONESTOCK TUNE</label>
          {tuneExisting.length > 0 && (
            <p className="mb-2 text-green-400 font-bold">✅ {tuneExisting.join(' · ')}</p>
          )}
          <label className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg cursor-pointer">
            {tuneUploading ? 'Uploading...' : tuneExisting.length ? '🔄 REPLACE BONESTOCK TUNE' : '⚙️ UPLOAD BONESTOCK TUNE'}
            <input type="file" className="hidden" onChange={(e) => { if (e.target.files?.[0]) uploadTune(e.target.files[0]); e.target.value = '' }} />
          </label>
          <p className="mt-1 text-sm text-gray-500">Saved to the car&apos;s Dropbox HB Tuning folder.</p>
        </div>

        <button onClick={saveChanges} disabled={saving} className={`px-6 py-4 rounded-2xl text-xl font-bold ${saving ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
          {saving ? 'SAVING...' : 'SAVE CHANGES'}
        </button>
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
      </div>
    </main>
  )
}
