'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { carData, yearsForSpec, carLabel } from '@/lib/carData'
import { loadCarGroups, type CarGroup, type GroupCar } from '@/lib/carGroups'

// CAR GROUPS — grupos de compatibilidade de build (Márcio, 04/10/2026): carros que recebem o MESMO build.
// Aqui ele cria, nomeia, edita e remove os grupos (tabela car_groups, banco do US). No cadastro do pack, escolhido o
// fabricante, os grupos dele aparecem antes do BRAND e um clique adiciona todos os carros do grupo. Mudar um grupo
// aqui NÃO mexe nos packs já salvos: o pack guarda os carros, não o grupo.

const MANUFACTURERS = Object.keys(carData)
const brandsFor = (m: string) => (m && carData[m] ? Object.keys(carData[m]) : [])
const modelsFor = (m: string, b: string) => (m && b && carData[m]?.[b] ? Object.keys(carData[m][b]) : [])
const versionsFor = (m: string, b: string, mo: string) => (m && b && mo ? (carData[m]?.[b]?.[mo] || []) : [])
const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

type Draft = { id: string | null; name: string; manufacturer: string; cars: GroupCar[] }

export default function CarGroupsPage() {
  const [groups, setGroups] = useState<CarGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // O carro que está sendo montado na cascata (brand → model → version → years).
  const [bBrand, setBBrand] = useState('')
  const [bModel, setBModel] = useState('')
  const [bVersion, setBVersion] = useState('')
  const [bYears, setBYears] = useState<number[]>([])

  async function load() { setGroups(await loadCarGroups(supabase)); setLoading(false) }
  useEffect(() => { load() }, [])

  const resetCar = () => { setBBrand(''); setBModel(''); setBVersion(''); setBYears([]) }
  function open(g: CarGroup | null) {
    setDraft(g ? { id: g.id, name: g.name, manufacturer: g.manufacturer, cars: g.cars.map(c => ({ ...c, years: [...c.years] })) } : { id: null, name: '', manufacturer: '', cars: [] })
    resetCar()
  }
  const bMan = draft?.manufacturer || ''
  const builderYears = bMan && bBrand && bModel && bVersion ? yearsForSpec(bMan, bBrand, bModel, bVersion) : []
  const pendingComplete = !!(bMan && bBrand && bModel && bVersion && bYears.length)
  const pending = (): GroupCar => ({ manufacturer: bMan, brand: bBrand, model: bModel, version: bVersion, years: [...bYears].sort((a, b) => a - b) })

  // Carro repetido não vira segunda linha: os anos se juntam.
  function withCar(cars: GroupCar[], c: GroupCar): GroupCar[] {
    const i = cars.findIndex(x => x.brand === c.brand && x.model === c.model && x.version === c.version)
    if (i < 0) return [...cars, c]
    return cars.map((x, j) => (j === i ? { ...x, years: [...new Set([...x.years, ...c.years])].sort((a, b) => a - b) } : x))
  }
  function addCar() {
    if (!draft || !pendingComplete) return
    setDraft({ ...draft, cars: withCar(draft.cars, pending()) })
    resetCar()
  }

  async function save() {
    if (!draft || saving) return
    const name = draft.name.trim()
    // Um carro completo e ainda não adicionado entra junto, para não se perder no SAVE.
    const cars = pendingComplete ? withCar(draft.cars, pending()) : draft.cars
    if (!name) { alert('Give the group a name.'); return }
    if (!draft.manufacturer) { alert('Pick the manufacturer.'); return }
    if (!cars.length) { alert('Add at least one car to the group.'); return }
    setSaving(true)
    const row = { name, manufacturer: draft.manufacturer, cars, updated_at: new Date().toISOString() }
    const res = draft.id
      ? await supabase.from('car_groups').update(row).eq('id', draft.id)
      : await supabase.from('car_groups').insert([{ ...row, position: groups.reduce((m, g) => Math.max(m, g.position), 0) + 1 }])
    setSaving(false)
    if (res.error) { alert(res.error.message); return }
    setDraft(null); resetCar(); load()
  }

  async function remove(id: string) {
    const { error } = await supabase.from('car_groups').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null); load()
  }

  const q = search.trim().toLowerCase()
  const filtered = groups.filter(g => !q || g.name.toLowerCase().includes(q) || g.manufacturer.toLowerCase().includes(q) || g.cars.some(c => carLabel(c).toLowerCase().includes(q)))

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Group</h2>
            <p className="text-gray-400 text-lg mb-8">Remove «{groups.find(g => g.id === confirmId)?.name}»? Packs already saved keep their cars — only the group button goes away.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => remove(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">CAR GROUPS ({filtered.length})</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search groups…" className="bg-gray-800 border border-gray-700 rounded-2xl px-5 py-4 text-lg w-72" />
          <button onClick={() => open(null)} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW GROUP</button>
        </div>
      </div>
      <p className="text-gray-400 mb-8 max-w-3xl">Build compatibility: cars that take the same build. On the pack page, after you pick the manufacturer, its groups show before the brand — one click adds every car of the group to the pack.</p>

      {draft && (
        <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 mb-8 max-w-4xl space-y-5">
          <h2 className="text-2xl font-bold">{draft.id ? 'EDIT GROUP' : 'NEW GROUP'}</h2>
          <div>
            <label className="block mb-2 text-lg font-bold">GROUP NAME</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} placeholder="e.g. Challenger & Charger 707/717 HP" />
          </div>
          <div>
            <p className="mb-2 text-sm text-gray-400 font-bold">MANUFACTURER</p>
            <div className="flex gap-2 flex-wrap">
              {MANUFACTURERS.map(m => (
                <button key={m} disabled={draft.cars.length > 0 && draft.manufacturer !== m} onClick={() => { setDraft({ ...draft, manufacturer: m }); resetCar() }} className={`${chip(draft.manufacturer === m)} disabled:opacity-30`}>{m}</button>
              ))}
            </div>
            {draft.cars.length > 0 && <p className="text-xs text-gray-500 mt-2">A group belongs to one manufacturer — remove its cars to change it.</p>}
          </div>

          <div>
            <label className="block mb-3 text-lg font-bold">CARS IN THIS GROUP ({draft.cars.length})</label>
            {draft.cars.length > 0 && (
              <div className="space-y-2 mb-4">
                {draft.cars.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-black/40 border border-gray-800 rounded-2xl px-4 py-3">
                    <span className="text-lg">{carLabel(c)}</span>
                    <button onClick={() => setDraft({ ...draft, cars: draft.cars.filter((_, j) => j !== i) })} className="bg-red-700 hover:bg-red-600 px-3 py-2 rounded-2xl font-bold">✕</button>
                  </div>
                ))}
              </div>
            )}
            {bMan && (
              <div className="bg-black/30 border border-gray-800 rounded-3xl p-5 space-y-4">
                <div><p className="mb-2 text-sm text-gray-400 font-bold">BRAND</p><div className="flex gap-2 flex-wrap">{brandsFor(bMan).map(b => <button key={b} onClick={() => { setBBrand(b); setBModel(''); setBVersion(''); setBYears([]) }} className={chip(bBrand === b)}>{b}</button>)}</div></div>
                {bBrand && <div><p className="mb-2 text-sm text-gray-400 font-bold">MODEL</p><div className="flex gap-2 flex-wrap">{modelsFor(bMan, bBrand).map(mo => <button key={mo} onClick={() => { setBModel(mo); setBVersion(''); setBYears([]) }} className={chip(bModel === mo)}>{mo}</button>)}</div></div>}
                {bModel && <div><p className="mb-2 text-sm text-gray-400 font-bold">VERSION</p><div className="flex gap-2 flex-wrap">{versionsFor(bMan, bBrand, bModel).map(v => <button key={v} onClick={() => { setBVersion(v); setBYears([]) }} className={chip(bVersion === v)}>{v}</button>)}</div></div>}
                {bVersion && (
                  <div>
                    <p className="mb-2 text-sm text-gray-400 font-bold">YEARS (pick as many as you want)</p>
                    <div className="flex gap-2 flex-wrap items-center">
                      {builderYears.map(y => <button key={y} onClick={() => setBYears(prev => prev.includes(y) ? prev.filter(x => x !== y) : [...prev, y])} className={chip(bYears.includes(y))}>{y}</button>)}
                      {builderYears.length > 1 && <button onClick={() => setBYears(bYears.length === builderYears.length ? [] : [...builderYears])} className="px-3 py-2 rounded-2xl font-bold text-xs bg-gray-800 hover:bg-gray-700 text-gray-300">{bYears.length === builderYears.length ? 'NONE' : 'ALL YEARS'}</button>}
                    </div>
                  </div>
                )}
                {pendingComplete && <button onClick={addCar} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl text-lg font-bold">+ ADD CAR TO GROUP</button>}
              </div>
            )}
          </div>

          <div className="flex gap-4 flex-wrap items-center pt-2">
            <button onClick={save} disabled={saving} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">{saving ? 'SAVING...' : 'SAVE GROUP'}</button>
            <button type="button" onClick={() => { setDraft(null); resetCar() }} className="text-gray-400 text-xl">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{groups.length === 0 ? 'No groups yet.' : 'No matches.'}</p>
      ) : (
        <div className="space-y-5">
          {filtered.map(g => (
            <div key={g.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <h2 className="text-2xl font-bold">{g.name}</h2>
                  <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700 text-gray-300">{g.manufacturer}</span>
                  <span className="px-3 py-1 rounded-full text-sm font-bold bg-amber-600 text-black">{g.cars.length} car{g.cars.length === 1 ? '' : 's'}</span>
                </div>
                {g.cars.map((c, i) => <p key={i} className="text-lg text-gray-400">{carLabel(c)}</p>)}
              </div>
              <div className="flex gap-3 flex-wrap shrink-0">
                <button onClick={() => { open(g); window.scrollTo({ top: 0, behavior: 'smooth' }) }} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>
                <button onClick={() => setConfirmId(g.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
