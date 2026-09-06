'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { supabaseBR } from '@/lib/supabaseBR'
import { BASE_PATH, CAR_DESTINY, insuresCar, isOurCar } from '@/lib/utils'
import DatePicker from '@/components/DatePicker'
import { plateStatus } from '@/lib/plateExpiry'
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
  const [transmission, setTransmission] = useState('')
  const [color, setColor] = useState('')

  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [plateExpiry, setPlateExpiry] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [uploading, setUploading] = useState(false)

  // TITLE & DOCS (US-only): where this car's paperwork lives. USA = GZ28US fleet
  // (title, plates and insurance tracked here); EXPORT = bought by GZ28US but
  // never FL-titled — the endorsed title goes straight to the exporter (unless
  // it DID get transferred with taxes paid, e.g. a dealership sale — Alcatraz);
  // CLIENT = an American client's own car, the owner handles the paperwork.
  const [titleScope, setTitleScope] = useState('')
  const [titleTransferred, setTitleTransferred] = useState(false)
  // Milhagem de ENTRADA na GZ28. DELIVERY MILES = < 100 mi = pode exportar
  // (GZ28 EXPORT ou 3RD PARTY EXPORT); >= 100 = usado = não exporta. Lei do 0km.
  const [admissionMileage, setAdmissionMileage] = useState('')
  // EXPORTED = embarcou, fim do ciclo. Num GZ28 EXPORT o carro sai do nome
  // da GZ28US e vira ride da GZ28BR; o custo do job sai do WIP do Balanço.
  const [exported, setExported] = useState(false)
  const [insCompany, setInsCompany] = useState('')
  const [insPolicy, setInsPolicy] = useState('')
  const [insExpiry, setInsExpiry] = useState('')
  const [titleNotes, setTitleNotes] = useState('')

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
    setTransmission(r.transmission || '')
    setVin(r.vin || '')
    setPlate(r.plate || '')
    setPlateExpiry(r.plate_expiry || '')
    setPhotoUrl(r.photo_url || '')
    setTitleScope(r.title_scope || '')
    setAdmissionMileage(r.admission_mileage != null ? String(r.admission_mileage) : '')
    setExported(!!r.exported)
    setTitleTransferred(!!r.title_transferred)
    setInsCompany(r.insurance_company || '')
    setInsPolicy(r.insurance_policy || '')
    setInsExpiry(r.insurance_expiry || '')
    setTitleNotes(r.title_notes || '')
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
    await Promise.all(['US'].map(async (zone) => {
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
      // "[manufacturer] [year] [brand] [model] [version] [transmission] [code] - [name] BoneStock Tune"
      const trans = transmissionOptions.length === 1 ? transmissionOptions[0] : transmission
      const prefix = [manufacturer, year, brand, model, version, trans].filter(Boolean).join(' ')
      const filename = `${prefix ? prefix + ' ' : ''}${projectCode}${projectName ? ' - ' + projectName : ''} BoneStock Tune.${ext}`
      let landed = 0
      for (const zone of ['US']) {
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

  // Factory transmission options for the currently selected car (empty = unknown → no picker).
  const transmissionOptions = transmissionOptionsFor(year, brand, model, version)

  async function saveChanges() {
    if (!projectCode.trim()) { alert('Please enter a project code'); return }
    setSaving(true)

    // Store "None" special edition as null so reports don't print "None".
    const seValue = specialEdition && specialEdition !== 'None' ? specialEdition : null

    // Capture the previous code AND NAME: o código faz as invoices seguirem o
    // rename, e o nome faz os ARQUIVOS seguirem (retag, 06/set/2026) — o nome do
    // carro está carimbado dentro do nome de todo arquivo que o app gera.
    const newCode = projectCode.trim()
    const { data: cur } = await supabase.from('rides').select('project_code, project_name').eq('id', rideId).single()
    const oldCode = cur?.project_code || ''
    const oldName = cur?.project_name || ''

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
      // Single factory option → stamped automatically; multi-option cars use the picker.
      transmission: transmissionOptions.length === 1 ? transmissionOptions[0] : (transmission || null),
      color: color || null,
      vin: vin || null,
      plate: plate || null,
      plate_expiry: plateExpiry || null,
      photo_url: photoUrl || null,
      title_scope: titleScope || null,
      title_transferred: titleScope ? titleTransferred : null,
      insurance_company: insuresCar(titleScope) ? (insCompany || null) : null,
      insurance_policy: insuresCar(titleScope) ? (insPolicy || null) : null,
      insurance_expiry: insuresCar(titleScope) ? (insExpiry || null) : null,
      title_notes: titleNotes || null,
      admission_mileage: admissionMileage !== '' ? (parseFloat(admissionMileage) || 0) : null,
      exported,
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
          body: JSON.stringify({ action: 'rename', zone, oldCode, oldName, newCode, name: projectName || '' }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.error) folderFails.push(`${zone}: ${data.error || `HTTP ${res.status}`}`)
      } catch (e) { folderFails.push(`${zone}: ${String(e)}`) }
    }
    if (folderFails.length) alert('Ride saved, but the Dropbox folder sync failed —\n' + folderFails.join('\n'))

    // O NOME DO CARRO DENTRO DOS ARQUIVOS SEGUE O RIDE (Márcio, 06/set/2026).
    // Roda DEPOIS do rename da pasta, de propósito: o retag procura a pasta pelo
    // código NOVO. Cobre a HB Tuning do carro (BoneStock Tune, BuildSheet PDF) e o
    // BoneStock TuneRepository das DUAS zonas — lá o nome é a única identidade.
    if (oldCode !== newCode || oldName !== (projectName || '')) {
      for (const zone of ['US', 'BR']) {
        try {
          await fetch(`${BASE_PATH}/api/ride-folder`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'retag', zone, code: newCode, oldCode, oldName, newCode, newName: projectName || '', rootFolder: 'BoneStock TuneRepository' }),
          })
        } catch { /* não-fatal: o arquivo re-sincroniza com o nome novo no próximo save do tune */ }
      }
    }

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
          {plateExpiry && (() => { const st = plateStatus(plateExpiry); return st.state === 'none' ? null : (
            <p className="mt-2"><span className={`px-3 py-1 rounded-full text-sm font-bold ${st.cls}`}>{st.label}</span></p>
          ) })()}
        </div>

        {/* TITLE & DOCS — who handles this car's paperwork. */}
        <div className="border-t border-gray-800 pt-5 mt-2">
          <h2 className="text-2xl font-bold mb-4">TITLE &amp; DOCS</h2>
          <label className="block mb-2 text-lg font-bold">CAR DESTINY</label>
          {/* A lista depende de ONDE o carro vive (Márcio, 27/ago/2026): carro do
              FLEET só escolhe entre os dois destinos de frota; carro de RIDES só
              entre os três de cliente. Misturar as duas listas era oferecer, num
              carro nosso, "carro do cliente americano". */}
          <select value={titleScope} onChange={(e) => setTitleScope(e.target.value)} className={selectClass}>
            <option value="">— Not set —</option>
            {CAR_DESTINY.filter(d => isOurCar(titleScope) ? isOurCar(d.value) : !isOurCar(d.value))
              .map(d => <option key={d.value} value={d.value}>{d.option}</option>)}
          </select>
          {/* A porta entre os dois mundos. Sem ela o filtro acima viraria uma
              armadilha: carro que caiu no FLEET nunca mais voltaria pra RIDES,
              porque os destinos de cliente nem apareceriam na lista. */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            {isOurCar(titleScope) ? (
              <>
                <button type="button" onClick={() => setTitleScope('')} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">MOVE TO RIDES</button>
                <span className="text-sm text-gray-400">Este carro está no FLEET. Movê-lo devolve a escolha aos destinos de cliente.</span>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setTitleScope('OWN')} className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">MOVE TO FLEET</button>
                <span className="text-sm text-gray-400">Passa a ser carro nosso e sai da lista de RIDES.</span>
              </>
            )}
          </div>

          <div className="mt-4">
            <label className="block mb-2 text-lg font-bold">ADMISSION MILEAGE (mi)</label>
            <input type="text" inputMode="decimal" value={admissionMileage}
              onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setAdmissionMileage(e.target.value) }}
              className={inputClass} placeholder="Milhagem na entrada da GZ28" />
            {(titleScope === 'EXPORT' || titleScope === 'CLIENT') && (
              parseFloat(admissionMileage) >= 100
                ? <p className="mt-2 text-red-400 font-bold">≥ 100 mi — carro usado NÃO pode ser exportado (nem por nós, nem por terceiro).</p>
                : admissionMileage === ''
                  ? <p className="mt-2 text-amber-300">Exportação exige DELIVERY MILES: entrada com menos de 100 mi.</p>
                  : <p className="mt-2 text-emerald-400 font-bold">DELIVERY MILES ✓ — abaixo do teto de 100 mi, pode exportar.</p>
            )}
          </div>

          {(titleScope === 'EXPORT' || titleScope === 'CLIENT') && (
            <div className="mt-4">
              <label className="flex items-center gap-3 text-lg font-bold cursor-pointer">
                <input type="checkbox" checked={exported} onChange={(e) => setExported(e.target.checked)} className="w-6 h-6" />
                EXPORTED — embarcou, ciclo finalizado
              </label>
              {exported && titleScope === 'EXPORT' && (
                <p className="mt-2 text-sky-300">O carro não está mais no nome da GZ28US — daqui pra frente é ride da GZ28BR. O custo do job sai do WIP do Balanço.</p>
              )}
              {exported && titleScope === 'CLIENT' && (
                <p className="mt-2 text-sky-300">Embarcado pela exportadora terceira — ciclo na GZ28US encerrado.</p>
              )}
            </div>
          )}

          {insuresCar(titleScope) && (
            <div className="mt-4 space-y-4">
              <label className="flex items-center gap-3 text-lg font-bold cursor-pointer">
                <input type="checkbox" checked={titleTransferred} onChange={(e) => setTitleTransferred(e.target.checked)} className="w-6 h-6" />
                TITLED TO GZ28US LLC (transfer done)
              </label>
              <div>
                <label className="block mb-2 text-lg font-bold">INSURANCE COMPANY</label>
                <input type="text" value={insCompany} onChange={(e) => setInsCompany(e.target.value)} className={inputClass} placeholder="e.g. Progressive" />
              </div>
              <div>
                <label className="block mb-2 text-lg font-bold">POLICY #</label>
                <input type="text" value={insPolicy} onChange={(e) => setInsPolicy(e.target.value)} className={inputClass} placeholder="Policy number" />
              </div>
              <div>
                <DatePicker label="INSURANCE EXPIRY" value={insExpiry} onChange={setInsExpiry} />
                {insExpiry && (() => { const st = plateStatus(insExpiry); return st.state === 'none' ? null : (
                  <p className="mt-2"><span className={`px-3 py-1 rounded-full text-sm font-bold ${st.cls}`}>{st.label}</span></p>
                ) })()}
              </div>
            </div>
          )}

          {titleScope === 'EXPORT' && (
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-3 text-lg font-bold cursor-pointer">
                <input type="checkbox" checked={titleTransferred} onChange={(e) => setTitleTransferred(e.target.checked)} className="w-6 h-6" />
                TITLE WAS TRANSFERRED ANYWAY (taxes paid — e.g. dealership charged them in the sale)
              </label>
              {!titleTransferred && (
                <p className="text-gray-400">No FL title: the endorsed title stays on file and goes straight to the exporter at shipping time. No use tax paid.</p>
              )}
            </div>
          )}

          {titleScope === 'USA' && (
            <p className="mt-3 text-gray-400">The client's own car — title, registration and insurance are theirs, nothing tracked here.</p>
          )}
          {titleScope === 'CLIENT' && (
            <p className="mt-3 text-gray-400">3rd party export — an outside exporter ships the car; title, docs and freight are theirs. Nothing tracked here besides the admission mileage.</p>
          )}

          <div className="mt-4">
            <label className="block mb-2 text-lg font-bold">DOCS NOTES</label>
            <textarea value={titleNotes} onChange={(e) => setTitleNotes(e.target.value)} rows={2} className={inputClass} placeholder="Anything about title, taxes, exporter, insurance…" />
          </div>
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
