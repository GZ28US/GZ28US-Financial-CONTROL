'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { carLabel } from '@/lib/carData'
import { loadCarGroups, packCarLabels, type CarGroup } from '@/lib/carGroups'
import { dutyPriorityBadge } from '@/lib/utils'
import { HOUSE_HOURLY_USD, sumEstimatedSeconds } from '@/lib/laborCost'
import { PackLogo, ScopeBadge, ShopThumb } from '@/components/PackBits'

const money = (n: any) => (n == null || n === '' ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

export default function ViewPackPage() {
  const params = useParams()
  const id = String(params.id || '')
  const [pack, setPack] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (id) load(id) }, [id])
  // Pack que carrega um CAR GROUP inteiro mostra o NOME do grupo, não a lista de carros (Márcio, 04/10/2026).
  const [carGroups, setCarGroups] = useState<CarGroup[]>([])
  useEffect(() => { loadCarGroups(supabase).then(setCarGroups).catch(() => setCarGroups([])) }, [])

  async function load(packId: string) {
    const { data } = await supabase.from('packs').select('*').eq('id', packId).maybeSingle()
    setPack(data || null)
    setLoading(false)
  }

  if (loading) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Loading...</p></main>
  if (!pack) return <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-xl text-gray-400">Pack not found.</p></main>

  const closed = (pack.status || 'DRAFT') === 'CLOSED'
  const cars = Array.isArray(pack.cars) ? pack.cars : []
  // "Importação — ..." lines are the BR freight (PowerTrade) — a BR-only concept.
  // RULE (2026-07-23): the US version of a pack NEVER shows or counts them.
  const IMPORT_RE = /^\s*importa[cç][aã]o\s*[—–-]/i
  const parts = (pack.parts || []).filter((p: any) => !IMPORT_RE.test(p.description || ''))
  const services = pack.services || []
  const expenses = (pack.expenses || []).filter((e: any) => !IMPORT_RE.test(e.item || ''))
  const notes = pack.notes || []
  // STAFF DUTIES — a lista de trabalho que o pack carrega. Sem responsável: o
  // template guarda a tarefa, a quote é que aponta quem faz.
  const duties = pack.duties || []

  // Profit dash — same math as the invoice: revenue (parts + FL tax + services −
  // global discount) minus cost (supplier expenses + the FL tax we owe).
  const num = (v: any) => Number(v) || 0
  // CURRENCY RULE: packs authored on the BR app store BRL in amount/unit_price/price
  // and the USD original in *_usd. This app shows USD ONLY — always prefer the _usd
  // field; BRL-only companions (tax/extra/base_cost) scale by the line's own rate.
  const partSell = (p: any) => (p.unit_price_usd != null ? num(p.unit_price_usd) : num(p.unit_price))
  const partRatio = (p: any) => (p.unit_price_usd != null && num(p.unit_price) > 0 ? num(p.unit_price_usd) / num(p.unit_price) : 1)
  const partCost = (p: any) => (p.base_cost != null ? num(p.base_cost) * partRatio(p) : null)
  const expRatio = (e: any) => (e.amount_usd != null && num(e.amount) > 0 ? num(e.amount_usd) / num(e.amount) : 1)
  const expAmount = (e: any) => (e.amount_usd != null ? num(e.amount_usd) : num(e.amount))
  const svcPrice = (sv: any) => (sv.price_usd != null ? num(sv.price_usd) : num(sv.price))
  const partsSubTotal = parts.reduce((s: number, p: any) => s + partSell(p) * num(p.quantity), 0)
  const floridaTaxesAmount = partsSubTotal * (num(pack.florida_taxes) / 100)
  const servicesTotal = services.reduce((s: number, sv: any) => s + svcPrice(sv), 0)
  const partsAndServicesTotal = partsSubTotal + floridaTaxesAmount + servicesTotal
  const grandTotal = partsAndServicesTotal - partsAndServicesTotal * (num(pack.global_discount) / 100)
  const expensesTotalGlobal = floridaTaxesAmount + expenses.reduce((s: number, e: any) => s + expAmount(e) * (num(e.quantity) || 1) + (num(e.tax) + num(e.extra)) * expRatio(e), 0)
  // STAFF COST (Márcio, 04/10/2026: «the staff costs should be considered in this math, as expense… always USD 15 per hour»):
  // horas previstas das duties × a hora da casa (lib/laborCost.ts). É CALCULADO a cada abertura — não existe linha de mão de
  // obra gravada no pack (a fonte é a duty), por isso aparece também em pack GZ28 SHOP LOCKED. Entra no custo e no markup,
  // como já entrava no editor; esta tela VIEW deixava de fora e mostrava markup maior que o real.
  const staffHours = sumEstimatedSeconds(duties) / 3600
  const staffCost = staffHours * HOUSE_HOURLY_USD
  const totalCost = expensesTotalGlobal + staffCost
  const finalProfit = grandTotal - totalCost
  const finalProfitPct = totalCost > 0 ? (finalProfit / totalCost) * 100 : 0
  const hrs = (secs: unknown) => { const h = (Number(secs) || 0) / 3600; return h > 0 ? `${Number.isInteger(h) ? h : h.toFixed(1)}h` : '' }
  const profitColor = finalProfit < 0 ? 'text-red-500' : 'text-blue-400'

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-28">
      <Header />

      <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <PackLogo url={pack.logo_url} height={64} />
          <h1 className="text-4xl font-bold">{pack.name || '—'}</h1>
          <span className={`px-3 py-1 rounded-full text-sm font-bold ${closed ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-300'}`}>{closed ? 'CLOSED' : 'DRAFT'}</span>
        </div>
        {/* GZ28 SHOP LOCKED (04/10/2026): pack da vitrine da loja não se edita pelo app. */}
        {pack.shop_locked ? <span className="px-4 py-3 rounded-2xl font-bold bg-red-900 text-red-200">🔒 GZ28 SHOP LOCKED</span> : <Link href={`/packs/edit/${pack.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>}
      </div>
      <p className={`text-lg text-gray-400 ${cars.some((c: any) => c.logo_url || c.pack_name) ? 'mb-4' : 'mb-8'}`}>{cars.length ? packCarLabels(cars, carGroups, carLabel).join('  ·  ') : 'No cars selected'}</p>
      {/* NOME e LOGO POR CARRO (Parts & Packs, 08/10/2026): no mesmo pack, o Demon 2018 vende como «Z1000 AlphaOGD Pack» e os RedEye
          como AlphaEye, cada um com o seu logo. A loja usa o do carro; sem ele, o do pack; sem os dois, o título em texto. */}
      {cars.some((c: any) => c.logo_url || c.pack_name) && (
        <div className="max-w-4xl mb-8 space-y-2">
          {cars.map((c: any, i: number) => (
            <div key={i} className="flex items-center gap-4 bg-gray-900 border border-gray-800 rounded-2xl px-4 py-2 flex-wrap">
              {c.logo_url ? <PackLogo url={c.logo_url} height={40} /> : <span className="text-xs text-gray-600 w-24">pack logo</span>}
              <div className="min-w-0">
                <p className="font-bold">{c.pack_name || pack.name}</p>
                <p className="text-sm text-gray-400">{carLabel(c)}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SCOPE: linha sem selo vale nos dois modos; o selo diz quando ela é só de um (lib/packScope.ts). */}
      {[...parts, ...services, ...expenses, ...notes].some((l: any) => l.scope && l.scope !== 'BOTH') && (
        <p className="max-w-4xl mb-4 text-sm text-gray-400 flex items-center gap-2 flex-wrap">
          Lines without a tag count in both modes ·
          <ScopeBadge scope="SHIPPED" /> only the shipped pack · <ScopeBadge scope="IN_HOUSE" /> only the in-house build · <ScopeBadge scope="APP_ONLY" /> only inside the app
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 max-w-4xl">
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
          <h2 className="text-lg font-bold mb-3">TOTALS CONFIG</h2>
          <div className="grid grid-cols-2 gap-3 text-lg text-gray-300">
            <p>Target grand total: <span className="text-white">{money(pack.target_grand_total)}</span></p>
            <p>Florida taxes: <span className="text-white">{pack.florida_taxes ?? '—'}%</span></p>
            <p>Global discount: <span className="text-white">{pack.global_discount ?? '—'}%</span></p>
            <p>Import margin: <span className="text-white">{pack.import_margin ?? 0}%</span></p>
          </div>
        </div>

        {parts.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">PARTS ({parts.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {(() => { const seen = new Set<string>(); return parts.map((p: any, i: number) => {
                if (p.kit_group) {
                  if (seen.has(p.kit_group)) return null
                  seen.add(p.kit_group)
                  const members = parts.filter((x: any) => x.kit_group === p.kit_group)
                  const total = members.reduce((s: number, x: any) => s + partSell(x) * num(x.quantity), 0)
                  return (
                    <div key={i} className="border border-teal-800 rounded-2xl overflow-hidden my-2">
                      <div className="bg-teal-900/40 px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-base font-bold">📦 {p.kit_name || 'Kit'}</span>
                        <span className="font-bold text-white">{money(total)}</span>
                      </div>
                      <div className="pl-5 border-l-2 border-teal-800 ml-3 py-1 space-y-1">
                        {members.map((m: any, j: number) => <div key={j} className="flex items-center gap-3"><ShopThumb url={m.image_url} size={40} /><p className="flex-1">{m.quantity}× {m.description} — {money(partSell(m))}{m.base_cost != null ? ` (cost ${money(partCost(m))})` : ''}</p><ScopeBadge scope={m.scope} /></div>)}
                      </div>
                    </div>
                  )
                }
                return <div key={i} className="flex items-center gap-3"><ShopThumb url={p.image_url} size={40} /><p className="flex-1">{p.quantity}× {p.description} — {money(partSell(p))}{p.base_cost != null ? ` (cost ${money(partCost(p))})` : ''}</p><ScopeBadge scope={p.scope} /></div>
              }) })()}
            </div>
          </div>
        )}

        {services.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">SERVICES ({services.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {services.map((s: any, i: number) => <div key={i} className="flex items-center gap-3"><p className="flex-1">{s.description} — {money(svcPrice(s))}</p><ScopeBadge scope={s.scope} /></div>)}
            </div>
          </div>
        )}

        {expenses.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">EXPENSES ({expenses.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {(() => { const seen = new Set<string>(); return expenses.map((e: any, i: number) => {
                if (e.kit_group) {
                  if (seen.has(e.kit_group)) return null
                  seen.add(e.kit_group)
                  const members = expenses.filter((x: any) => x.kit_group === e.kit_group)
                  const total = members.reduce((s: number, x: any) => s + expAmount(x) * (num(x.quantity) || 1) + (num(x.tax) + num(x.extra)) * expRatio(x), 0)
                  return (
                    <div key={i} className="border border-teal-800 rounded-2xl overflow-hidden my-2">
                      <div className="bg-teal-900/40 px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-base font-bold">📦 {e.kit_name || 'Kit'}</span>
                        <span className="font-bold text-white">{money(total)}</span>
                      </div>
                      <div className="pl-5 border-l-2 border-teal-800 ml-3 py-1 space-y-1">
                        {members.map((m: any, j: number) => <div key={j} className="flex items-center gap-3"><p className="flex-1">{m.quantity}× {m.item}{m.supplier ? ` @ ${m.supplier}` : ''} — {money(expAmount(m))}</p><ScopeBadge scope={m.scope} /></div>)}
                      </div>
                    </div>
                  )
                }
                return <div key={i} className="flex items-center gap-3"><p className="flex-1">{e.quantity}× {e.item}{e.supplier ? ` @ ${e.supplier}` : ''} — {money(expAmount(e))}</p><ScopeBadge scope={e.scope} /></div>
              }) })()}
            </div>
          </div>
        )}

        {duties.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">STAFF DUTIES ({duties.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {duties.map((d: any, i: number) => (
                <p key={i}>
                  <span className={`px-2 py-0.5 mr-2 rounded-full text-xs font-bold ${dutyPriorityBadge(String(d.priority || '1')).cls}`}>{dutyPriorityBadge(String(d.priority || '1')).label}</span>
                  {d.description}
                  {hrs(d.estimated_seconds) && <span className="ml-2 text-sm text-gray-500 tabular-nums">· {hrs(d.estimated_seconds)}</span>}
                </p>
              ))}
            </div>
            {staffHours > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-800 flex items-center justify-between gap-4 flex-wrap">
                <span className="text-sm font-bold text-gray-400">👤 STAFF COST · {hrs(staffHours * 3600)} × {money(HOUSE_HOURLY_USD)}/h</span>
                <span className="text-lg font-bold text-gray-100 tabular-nums">{money(staffCost)}</span>
              </div>
            )}
          </div>
        )}

        {notes.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
            <h2 className="text-lg font-bold mb-3">NOTES ({notes.length})</h2>
            <div className="space-y-1 text-lg text-gray-300">
              {notes.map((n: any, i: number) => <div key={i} className="flex items-center gap-3"><p className="flex-1">{n.note}</p><ScopeBadge scope={n.scope} /></div>)}
            </div>
          </div>
        )}
      </div>

      {/* PROFIT DASH — fixed footer, always visible */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900 border-t-2 border-gray-700 px-6 py-3 flex items-center justify-between gap-x-8 gap-y-2 flex-wrap">
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">GRAND TOTAL</span><span className="text-xl font-bold">{money(grandTotal)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">EXPENSES</span><span className="text-lg font-bold text-gray-300">{money(expensesTotalGlobal)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">STAFF COST{staffHours > 0 ? ` (${hrs(staffHours * 3600)})` : ''}</span><span className="text-lg font-bold text-gray-300">{money(staffCost)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-xs text-gray-400 font-bold">COST</span><span className="text-xl font-bold">{money(totalCost)}</span></div>
        <div className="flex items-baseline gap-2"><span className="text-sm font-bold text-gray-200">MARKUP</span><span className={`text-2xl font-bold ${profitColor}`}>{money(finalProfit)} / {finalProfitPct.toFixed(1)}%</span></div>
      </div>
    </main>
  )
}
