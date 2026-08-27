'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD, partMatches } from '@/lib/utils'
import { carLabel } from '@/lib/carData'

// A pack's GRAND TOTAL = the QUOTE price: parts + services, less the global
// discount. Florida tax is EXCLUDED — quotes are sold tax-exclusive (it's added
// only on the invoice), matching the "Prices Exclude Florida Taxes" report line.
// "Importação — ..." lines are the BR freight (PowerTrade) — a BR-only concept.
// RULE (2026-07-23): the US version of a pack NEVER carries the importações.
const IMPORT_RE = /^\s*importa[cç][aã]o\s*[—–-]/i

function packGrandTotal(p: any): number {
  const num = (v: any) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const parts = (Array.isArray(p.parts) ? p.parts : []).filter((x: any) => !IMPORT_RE.test(x.description || ''))
  const services = Array.isArray(p.services) ? p.services : []
  // BR-authored packs store BRL in unit_price/price and USD in *_usd — this app is USD-only.
  const partsSub = parts.reduce((s: number, x: any) => s + (x.unit_price_usd != null ? num(x.unit_price_usd) : num(x.unit_price)) * num(x.quantity), 0)
  const svc = services.reduce((s: number, x: any) => s + (x.price_usd != null ? num(x.price_usd) : num(x.price)), 0)
  const pas = partsSub + svc
  return pas - pas * (num(p.global_discount) / 100)
}

// Catalog of the performance packages we sell, as reusable templates. A CLOSED
// pack is a finished template offered for import on the new-quote screen; a DRAFT
// is still being built and is editable.
export default function PacksPage() {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | 'DRAFT' | 'CLOSED'>('ALL')
  // Visão POR PLATAFORMA (João, 26/ago — CC 0.1.5): dois packs de mesmo nome
  // (Demonized Durango vs TRX) só se distinguem pela plataforma. Os chips
  // nascem dos próprios packs; o balde SEM PLATFORM é a dívida do refresh
  // ficando visível — esvazia conforme o campo PLATFORM vai sendo preenchido.
  const [platFilter, setPlatFilter] = useState<string | null>(null)
  const [view, setView] = useState<'PACK' | 'LIST'>('PACK')
  const [search, setSearch] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    // LEI (2026-07-23): o app US lista SÓ packs zone='US' (o BR lista os dois).
    // Filtro no cliente para tolerar linhas antigas sem a coluna zone (= US).
    const { data } = await supabase.from('packs').select('*')
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRows((data || []).filter((p: any) => (p.zone ?? 'US') === 'US'))
    setLoading(false)
  }

  // Copy a pack's whole content into a brand-new DRAFT and open it in the editor,
  // so it can be the starting point for a new package. Cars/totals/parts/services/
  // expenses/notes all carry over; the copy is always DRAFT regardless of the source.
  async function duplicatePack(p: any) {
    if (duplicatingId) return
    setDuplicatingId(p.id)
    const { id, created_at, updated_at, ...rest } = p
    const row = { ...rest, name: `${p.name || 'Pack'} (copy)`, status: 'DRAFT' }
    const { data, error } = await supabase.from('packs').insert([row]).select('id').single()
    if (error || !data) { alert(error?.message || 'Could not duplicate the package.'); setDuplicatingId(null); return }
    router.push(`/packs/edit/${data.id}`)
  }

  async function removePack(id: string) {
    const { error } = await supabase.from('packs').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    load()
  }

  const platOf = (p: any) => String(p.platform || '').trim().toUpperCase()

  // VISÃO PADRÃO = POR PACK (João, 26/ago): um cartão por PRODUTO (família),
  // variantes (Z-code/plataforma/carros) dentro dele. A lista completa com os
  // nomes repetidos só aparece clicando FULL LIST de propósito. A família sai
  // do nome: cai o Z-code da frente, o parêntese e o " - variante" do fim
  // ("Z1250sc GoldenEye Pack - RAM TRX" → "GoldenEye Pack").
  const familyOf = (name: string) => (String(name || '')
    .replace(/^Z\d+\S*\s+/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/\s+-\s+[^-]+$/, '')
    .trim()) || String(name || '').trim() || '—'
  const platCounts = rows.reduce((m: Map<string, number>, p) => { const k = platOf(p) || 'SEM PLATFORM'; m.set(k, (m.get(k) || 0) + 1); return m }, new Map<string, number>())
  const platChips = [...platCounts.keys()].sort((a, b) => (a === 'SEM PLATFORM' ? 1 : b === 'SEM PLATFORM' ? -1 : a.localeCompare(b)))

  // Search matches the pack NAME and any of its CARS (same token engine as the Parts DB).
  const filtered = rows.filter((p) => (filter === 'ALL' || (p.status || 'DRAFT') === filter)
    && (platFilter == null || (platOf(p) || 'SEM PLATFORM') === platFilter)
    && partMatches(search, p.name, ...(Array.isArray(p.cars) ? p.cars.map(carLabel) : [])))
  const chip = (active: boolean) => `px-4 py-2 rounded-2xl font-bold text-sm ${active ? 'bg-white text-black' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Package</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this package? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePack(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {/* List-page layout law: title + ADD on top, SEARCH under it, chips below. */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h1 className="text-4xl font-bold">PERFORMANCE PACKAGES ({filtered.length})</h1>
        <Link href="/packs/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW PACK</Link>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search pack or car..."
        className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-3 text-lg w-full max-w-2xl mb-4"
      />

      <div className="flex gap-3 mb-3 flex-wrap items-center">
        <button onClick={() => setView('PACK')} className={chip(view === 'PACK')}>BY PACK</button>
        <button onClick={() => setView('LIST')} className={chip(view === 'LIST')}>FULL LIST</button>
        <span className="w-px h-6 bg-gray-700 mx-1" />
        {(['ALL', 'DRAFT', 'CLOSED'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={chip(filter === f)}>{f}</button>
        ))}
      </div>

      {/* PLATFORM view — chips live-derived from the packs themselves */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <button onClick={() => setPlatFilter(null)} className={chip(platFilter == null)}>ALL PLATFORMS</button>
        {platChips.map((k) => (
          <button key={k} onClick={() => setPlatFilter(platFilter === k ? null : k)} className={chip(platFilter === k)}>
            {k} ({platCounts.get(k)})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-2xl text-gray-400">{rows.length === 0 ? 'No packages yet.' : 'No matches.'}</p>
      ) : view === 'PACK' ? (
        <div className="space-y-4">
          {/* Chave de agrupamento = NOME + PLATAFORMA (João, 26/ago: "CatAholic IS
              for the HELLCAT platform" — a platform é métrica do PACK; as linhas
              de dentro variam por CARRO). Poltergeist LT4 e LT1 = dois cartões. */}
          {[...filtered.reduce((m: Map<string, any[]>, p) => { const k = familyOf(p.name) + '§' + (platOf(p) || 'SEM PLATFORM'); const a = m.get(k) || []; a.push(p); m.set(k, a); return m }, new Map<string, any[]>())]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([key, packs]) => {
              const [fam, plat] = key.split('§')
              return (
              <div key={key} className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
                <div className="flex items-center gap-3 mb-4 flex-wrap">
                  <h2 className="text-2xl font-bold">{fam}</h2>
                  {plat === 'SEM PLATFORM'
                    ? <span className="px-3 py-1 rounded-full text-sm font-bold bg-red-900 text-red-300">SEM PLATFORM</span>
                    : <span className="px-3 py-1 rounded-full text-sm font-bold bg-sky-900 text-sky-300">{plat}</span>}
                  {packs.length > 1 && <span className="px-3 py-1 rounded-full text-sm font-bold bg-gray-700 text-gray-300">{packs.length} VARIANTS</span>}
                </div>
                <div className="space-y-3">
                  {packs.map((p) => {
                    const closed = (p.status || 'DRAFT') === 'CLOSED'
                    const cars = Array.isArray(p.cars) ? p.cars : []
                    return (
                      <div key={p.id} className="border border-gray-800 rounded-2xl p-4 flex items-center justify-between gap-6 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-1 flex-wrap">
                            <span className={`px-3 py-1 rounded-full text-sm font-bold ${closed ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{closed ? 'CLOSED' : 'DRAFT'}</span>
                            <span className="px-3 py-1 rounded-full text-sm font-extrabold bg-amber-500 text-black">{formatUSD(packGrandTotal(p))}</span>
                            <span className="text-sm text-gray-500">{p.name}</span>
                          </div>
                          <p className="text-lg text-gray-400">{cars.length ? cars.map(carLabel).filter(Boolean).join('  ·  ') : 'No cars selected'}</p>
                        </div>
                        <div className="flex gap-3 flex-wrap shrink-0">
                          <Link href={`/packs/${p.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                          <Link href={`/packs/edit/${p.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                          <button onClick={() => setConfirmId(p.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                          {closed && <button onClick={() => duplicatePack(p)} disabled={duplicatingId === p.id} className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-black px-5 py-3 rounded-2xl font-bold">{duplicatingId === p.id ? 'DUPLICATING…' : '⧉ DUPLICATE'}</button>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )})}
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((p) => {
            const closed = (p.status || 'DRAFT') === 'CLOSED'
            const cars = Array.isArray(p.cars) ? p.cars : []
            return (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <h2 className="text-2xl font-bold">{p.name || '—'}</h2>
                    {platOf(p) && <span className="px-3 py-1 rounded-full text-sm font-bold bg-sky-900 text-sky-300">{platOf(p)}</span>}
                    <span className={`px-3 py-1 rounded-full text-sm font-bold ${closed ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{closed ? 'CLOSED' : 'DRAFT'}</span>
                    <span className="px-3 py-1 rounded-full text-sm font-extrabold bg-amber-500 text-black">GRAND TOTAL: {formatUSD(packGrandTotal(p))}</span>
                  </div>
                  <p className="text-lg text-gray-400">{cars.length ? cars.map(carLabel).filter(Boolean).join('  ·  ') : 'No cars selected'}</p>
                </div>
                <div className="flex gap-3 flex-wrap shrink-0">
                  {closed && <button onClick={() => duplicatePack(p)} disabled={duplicatingId === p.id} className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-black px-5 py-3 rounded-2xl font-bold">{duplicatingId === p.id ? 'DUPLICATING…' : '⧉ DUPLICATE'}</button>}
                  <Link href={`/packs/${p.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                  <Link href={`/packs/edit/${p.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                  <button onClick={() => setConfirmId(p.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
