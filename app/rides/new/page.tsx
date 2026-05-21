'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { carData } from '@/lib/carData'

export default function NewRidePage() {
  const router = useRouter()

  const [projectCode, setProjectCode] = useState('')
  const [projectName, setProjectName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<any[]>([])
  const [manufacturer, setManufacturer] = useState('')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [version, setVersion] = useState('')
  const [specialEdition, setSpecialEdition] = useState('')
  const [color, setColor] = useState('')
  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [year, setYear] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [uploading, setUploading] = useState(false)

  useState(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      if (data) setClients(data)
    })
  })

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
    if (!projectCode) { alert('Please enter a project code'); return }
    const { error } = await supabase.from('rides').insert([{
      project_code: projectCode,
      project_name: projectName || null,
      client_id: clientId || null,
      manufacturer: manufacturer || null,
      brand: brand || null,
      model: model || null,
      version: version || null,
      special_edition: specialEdition || null,
      color: color || null,
      vin: vin || null,
      plate: plate || null,
      year: year ? parseInt(year) : null,
      photo_url: photoUrl || null,
    }])
    if (error) { alert(error.message); return }
    router.push('/rides')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  const manufacturers = Object.keys(carData)
  const brands = manufacturer ? Object.keys(carData[manufacturer] || {}) : []
  const models = manufacturer && brand ? Object.keys(carData[manufacturer]?.[brand] || {}) : []
  const versions = manufacturer && brand && model ? (carData[manufacturer]?.[brand]?.[model] || []) : []

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">ADD A NEW RIDE</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT CODE</label>
          <input type="text" value={projectCode} onChange={(e) => setProjectCode(e.target.value)} className={inputClass} placeholder="e.g. GZ28.001" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">PROJECT NAME</label>
          <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} className={inputClass} placeholder="e.g. Black Beast" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CLIENT</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={selectClass}>
            <option value="">— No client —</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MANUFACTURER</label>
          <select value={manufacturer} onChange={(e) => { setManufacturer(e.target.value); setBrand(''); setModel(''); setVersion('') }} className={selectClass}>
            <option value="">— Select —</option>
            {manufacturers.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">BRAND</label>
          <select value={brand} onChange={(e) => { setBrand(e.target.value); setModel(''); setVersion('') }} className={selectClass} disabled={!manufacturer}>
            <option value="">— Select —</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">MODEL</label>
          <select value={model} onChange={(e) => { setModel(e.target.value); setVersion('') }} className={selectClass} disabled={!brand}>
            <option value="">— Select —</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">VERSION</label>
          <select value={version} onChange={(e) => setVersion(e.target.value)} className={selectClass} disabled={!model}>
            <option value="">— Select —</option>
            {versions.map((v: string) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">SPECIAL EDITION / PACKAGE</label>
          <input type="text" value={specialEdition} onChange={(e) => setSpecialEdition(e.target.value)} className={inputClass} placeholder="e.g. Nismo, AMG Black Series" />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">COLOR</label>
          <input type="text" value={color} onChange={(e) => setColor(e.target.value)} className={inputClass} placeholder="e.g. Midnight Black" />
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
          <label className="block mb-2 text-lg font-bold">YEAR</label>
          <input type="text" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} className={inputClass} placeholder="e.g. 2023" />
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

        <button onClick={saveRide} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE RIDE</button>
        <a href="/rides" className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}