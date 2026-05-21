'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import {
  years,
  manufacturersByYear,
  brandsByManufacturerAndYear,
  modelsByBrandAndYear,
  versionsByModelAndYear,
  specialEditions,
  getAvailableColors,
} from '@/lib/carData'

export default function EditRidePage() {
  const params = useParams()
  const router = useRouter()
  const rideId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<any[]>([])
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

  useEffect(() => { loadClients(); loadRide() }, [])

  async function loadClients() {
    const { data } = await supabase.from('clients').select('id, name').order('name')
    if (data) setClients(data)
  }

  async function loadRide() {
    const { data, error } = await supabase.from('rides').select('*').eq('id', rideId).single()
    if (error || !data) { alert('Ride not found'); router.push('/rides'); return }
    setProjectCode(data.project_code || '')
    setProjectName(data.project_name || '')
    setClientId(data.client_id || '')
    setYear(data.year ? String(data.year) : '')
    setManufacturer(data.manufacturer || '')
    setBrand(data.brand || '')
    setModel(data.model || '')
    setVersion(data.version || '')
    setSpecialEdition(data.special_edition || '')
    setColor(data.color || '')
    setVin(data.vin || '')
    setPlate(data.plate || '')
    setPhotoUrl(data.photo_url || '')
    setLoading(false)
  }

  async function uploadPhoto(file: File) {
    setUploading(true)
    const ext = file.name.split('.').pop()
    const path = `${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage.from('ride-photos').upload(path, file, { upsert: true })
    if (error) { alert(error.message); setUploading(false); return }
    const { data: urlData } = supabase.storage.from('ride-photos').getPublicUrl(path)
    setPhotoUrl(urlData.publicUrl)
    setUploading(false)
  }

  async function saveRide() {
    if (!projectCode) { alert('Please enter a project code'); return }
    const { error } = await supabase.from('rides').update({
      project_code: projectCode,
      project_name: projectName || null,
      client_id: clientId || null,
      year: year ? parseInt(year) : null,
      manufacturer: manufacturer || null,
      brand: brand || null,
      model: model || null,
      version: version || null,
      special_edition: specialEdition || null,
      color: color || null,
      vin: vin || null,
      plate: plate || null,
      photo_url: photoUrl || null,
      updated_at: new Date().toISOString(),
    }).eq('id', rideId)
    if (error) { alert(error.message); return }
    router.push('/rides')
  }

  const yearNum = parseInt(year) || 0
  const availableManufacturers = year ? (manufacturersByYear[yearNum] || []) : []
  const availableBrands = manufacturer && year ? (brandsByManufacturerAndYear[manufacturer]?.[yearNum] || []) : []
  const availableModels = brand && year ? (modelsByBrandAndYear[brand]?.[yearNum] || []) : []
  const availableVersions = model && year ? (versionsByModelAndYear[model]?.[yearNum] || []) : []
  const specialEditionKey = `${year}-${model}-${version}`
  const availableSpecialEditions = specialEditions[specialEditionKey] || []
  const availableColors = year && brand && model && version
    ? getAvailableColors(yearNum, brand, model, version, specialEdition)
    : []

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT RIDE</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT CODE</label>
          <input type="text" value={projectCode} onChange={(e) => setProjectCode(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT NAME</label>
          <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CLIENT</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={selectClass}>
            <option value="">— No client —</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">YEAR</label>
          <select value={year} onChange={(e) => { setYear(e.target.value); setManufacturer(''); setBrand(''); setModel(''); setVersion(''); setSpecialEdition(''); setColor('') }} className={selectClass}>
            <option value="">— Select —</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MANUFACTURER</label>
          <select value={manufacturer} onChange={(e) => { setManufacturer(e.target.value); setBrand(''); setModel(''); setVersion(''); setSpecialEdition(''); setColor('') }} className={selectClass} disabled={!year}>
            <option value="">— Select —</option>
            {availableManufacturers.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">BRAND</label>
          <select value={brand} onChange={(e) => { setBrand(e.target.value); setModel(''); setVersion(''); setSpecialEdition(''); setColor('') }} className={selectClass} disabled={!manufacturer}>
            <option value="">— Select —</option>
            {availableBrands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MODEL</label>
          <select value={model} onChange={(e) => { setModel(e.target.value); setVersion(''); setSpecialEdition(''); setColor('') }} className={selectClass} disabled={!brand}>
            <option value="">— Select —</option>
            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">VERSION</label>
          <select value={version} onChange={(e) => { setVersion(e.target.value); setSpecialEdition(''); setColor('') }} className={selectClass} disabled={!model}>
            <option value="">— Select —</option>
            {availableVersions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        {availableSpecialEditions.length > 0 && (
          <div>
            <label className="block mb-2 text-lg font-bold">SPECIAL EDITION / PACKAGE</label>
            <select value={specialEdition} onChange={(e) => { setSpecialEdition(e.target.value); setColor('') }} className={selectClass}>
              <option value="">— Select —</option>
              {availableSpecialEditions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {availableColors.length > 0 ? (
          <div>
            <label className="block mb-2 text-lg font-bold">COLOR</label>
            <select value={color} onChange={(e) => setColor(e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {availableColors.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label className="block mb-2 text-lg font-bold">COLOR</label>
            <input type="text" value={color} onChange={(e) => setColor(e.target.value)} className={inputClass} placeholder="e.g. Midnight Black" />
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">VIN</label>
          <input type="text" value={vin} onChange={(e) => setVin(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PLATE</label>
          <input type="text" value={plate} onChange={(e) => setPlate(e.target.value)} className={inputClass} />
        </div>

        {/* PHOTO */}
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

        <button onClick={saveRide} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        <a href="/rides" className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}