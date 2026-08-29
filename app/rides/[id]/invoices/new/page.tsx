'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const FULL_PROJECT_LABOR = 'Full Project Labor'

type Pack = {
  id: string
  name: string
  kind?: string | null
  target_grand_total: number | null
  florida_taxes: number | null
  global_discount: number | null
  import_margin: number | null
  show_part_numbers: boolean | null
  duties: any[]
  parts: any[]
  services: any[]
  expenses: any[]
  notes: any[]
}

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// Client numbers display/store zero-padded to 3 digits (e.g. 9 -> "009").
function pad3(n: number | string) {
  const num = typeof n === 'number' ? n : parseInt(String(n), 10)
  return isNaN(num) ? String(n) : String(num).padStart(3, '0')
}

export default function NewInvoicePage() {
  const params = useParams()
  const router = useRouter()
  const pathname = usePathname()
  const ownerId = String(params.id)
  // Context: client personal invoice when URL is /clients/..., otherwise ride invoice.
  const isClient = (pathname || '').includes('/clients/')
  const basePath = isClient ? `/clients/${ownerId}/invoices` : `/rides/${ownerId}/invoices`

  const [ownerLabel, setOwnerLabel] = useState('')
  const [ownerSubtitle, setOwnerSubtitle] = useState('')
  const [invoiceCode, setInvoiceCode] = useState('')
  const [hiringDate, setHiringDate] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [mileage, setMileage] = useState('')
  const [service, setService] = useState('')
  const [saving, setSaving] = useState(false)
  // Quote mode arrives via ?mode=quote (the ADD A NEW QUOTE button on the list).
  // Read from window rather than useSearchParams to avoid the Suspense build
  // requirement on this client page.
  const [isQuote, setIsQuote] = useState(false)
  // Ride-only: saved packs for this car spec, and which one (if any) is chosen.
  // selectedPackId: '' = none, '__new__' = naming a brand-new pack, else a pack id.
  const [packs, setPacks] = useState<Pack[]>([])
  // ADD-ONs (CC 0.2.3, João): opcionais de venda por cima do pack — na quote
  // nova, escolhe o pack como sempre E marca zero ou mais add-ons; cada um
  // aplicado por cima via o MESMO applyPack (as duties do add-on entram com a
  // própria numeração "NN." — mais uma frente de trabalho, padrão já existente).
  const [addons, setAddons] = useState<Pack[]>([])
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedPackId, setSelectedPackId] = useState('')
  // DUPLICATE QUOTE: arrives via ?duplicateFrom=<sourceInvoiceId>. We copy that
  // quote's config + items/services/expenses/notes onto a brand-new quote for the
  // picked ride and jump straight to EDIT — no NEW form is shown.
  const [duplicating, setDuplicating] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      setIsQuote(sp.get('mode') === 'quote')
      const dup = sp.get('duplicateFrom')
      if (dup) { setDuplicating(true); void duplicateQuote(dup); return }
    }
    loadOwner()
  }, [])

  // LITERAL duplicate of an existing invoice/quote onto this ride, then open EDIT.
  // Keeps the source TYPE (quote stays quote, invoice stays invoice) and carries ALL
  // info — dates, paid statuses, receipts, and the incomes/payments — not just a quote shell.
  async function duplicateQuote(sourceId: string) {
    let createdId: string | null = null
    try {
      const { data: ride } = await supabase.from('rides').select('project_code').eq('id', ownerId).single()
      const code = ride?.project_code || ''
      const { data: existing } = await supabase.from('invoices').select('invoice_code').eq('ride_id', ownerId)
      const used = (existing || []).map((i: any) => { const m = i.invoice_code?.match(/\.(\d+)$/); return m ? Number(m[1]) : null })
      let n = 1; while (used.includes(n)) n++
      const newCode = `${code}.${n}`

      const { data: src } = await supabase.from('invoices').select('*').eq('id', sourceId).single()
      if (!src) { alert('Source quote not found.'); router.back(); return }

      const row: any = {
        invoice_code: newCode,
        ride_id: ownerId,
        origin: src.origin || 'PROJECT',
        is_quote: src.is_quote,
        target_grand_total: src.target_grand_total ?? null,
        florida_taxes: src.florida_taxes ?? null,
        global_discount: src.global_discount ?? null,
        import_margin: src.import_margin ?? 0,
        service: src.service ?? null,
        // Literal clone: carry the source's dates, mileage, and status.
        hiring_date: src.hiring_date ?? null, entry_date: src.entry_date ?? null,
        conclusion_date: src.conclusion_date ?? null, delivery_date: src.delivery_date ?? null,
        mileage: src.mileage ?? null, fl_tax_expense_date: src.fl_tax_expense_date ?? null,
        live_status: src.live_status ?? 'INCOMPLETE', feed_status: src.feed_status ?? 'INCOMPLETE',
      }
      const { data: inv, error } = await supabase.from('invoices').insert([row]).select().single()
      if (error || !inv) { alert(error?.message || 'Error duplicating quote'); router.back(); return }
      createdId = inv.id

      // Copy children with EXPLICIT, insertable columns only. invoice_parts.total is
      // a generated column and updated_at is server-managed — copying them verbatim
      // makes PostgREST reject the whole insert (which is why items went missing).
      const { data: parts } = await supabase.from('invoice_parts').select('*').eq('invoice_id', sourceId).order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
      const partRows = (parts || []).map((p: any) => ({
        invoice_id: inv.id, description: p.description, unit_price: p.unit_price, quantity: p.quantity,
        base_cost: p.base_cost, position: p.position, kit_group: p.kit_group, kit_name: p.kit_name,
        source_item: p.source_item, payment_date: p.payment_date,
      }))
      if (partRows.length) { const { error: pe } = await supabase.from('invoice_parts').insert(partRows); if (pe) throw new Error('items: ' + pe.message) }

      const { data: svcs } = await supabase.from('invoice_services').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      let svcRows = (svcs || []).map((s: any) => ({ invoice_id: inv.id, description: s.description, price: s.price }))
      if (!svcRows.length) svcRows = [{ invoice_id: inv.id, description: FULL_PROJECT_LABOR, price: 0 }]
      { const { error: se } = await supabase.from('invoice_services').insert(svcRows); if (se) throw new Error('services: ' + se.message) }

      const { data: exps } = await supabase.from('invoice_expenses').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      const expRows = (exps || []).map((e: any) => ({
        invoice_id: inv.id, expense_date: e.payment_date ?? null, supplier: e.supplier, item: e.item, price: e.price,
        tax: e.tax, extra: e.extra, quantity: e.quantity, item_discount: e.item_discount, part_number: e.part_number,
        export_status: e.export_status || 'FRESH', purchase_group: e.purchase_group, kit_group: e.kit_group,
        kit_name: e.kit_name, stock_source_type: e.stock_source_type, stock_donor: e.stock_donor,
        payment_date: e.payment_date, receipt_url: e.receipt_url,
        // Universal payment fields + legacy who-paid marker travel with the clone.
        source: e.source, payment_method: e.payment_method, paid_from: e.paid_from, paid_to: e.paid_to,
        // ORDER NUMBER é SAGRADO (29/ago/2026): o clone é cópia fiel — o pedido
        // viaja junto, senão a duplicata perderia o elo com o STREAM.
        order_number: e.order_number ?? null,
      }))
      if (expRows.length) { const { error: ee } = await supabase.from('invoice_expenses').insert(expRows); if (ee) throw new Error('expenses: ' + ee.message) }

      const { data: notes } = await supabase.from('invoice_notes').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      const noteRows = (notes || []).map((nt: any) => ({ invoice_id: inv.id, note: nt.note }))
      if (noteRows.length) { const { error: ne } = await supabase.from('invoice_notes').insert(noteRows); if (ne) throw new Error('notes: ' + ne.message) }

      // INCOMES (payments) — carried so the duplicate is a true clone, not a quote shell.
      const { data: pays } = await supabase.from('invoice_payments').select('*').eq('invoice_id', sourceId).order('created_at', { ascending: true })
      const payRows = (pays || []).map((p: any) => ({
        invoice_id: inv.id, amount: p.amount, amount_brl: p.amount_brl, payment_date: p.payment_date,
        source: p.source, paid_from: p.paid_from, paid_to: p.paid_to, receipt_url: p.receipt_url,
        description: p.description, paid_at: p.paid_at,
      }))
      if (payRows.length) { const { error: pae } = await supabase.from('invoice_payments').insert(payRows); if (pae) throw new Error('incomes: ' + pae.message) }

      router.replace(`${basePath}/edit/${inv.id}`)
    } catch (err) {
      // Roll back the half-created copy so a failed duplicate leaves nothing behind.
      if (createdId) { await supabase.from('invoices').delete().eq('id', createdId) }
      alert('Could not duplicate the quote:\n' + String(err))
      router.back()
    }
  }

  async function loadOwner() {
    if (isClient) {
      const { data: client } = await supabase.from('clients').select('name, client_number').eq('id', ownerId).single()
      if (client) {
        const numStr = client.client_number != null ? pad3(client.client_number) : ''
        setOwnerLabel(numStr)
        setOwnerSubtitle(client.name || '')
        await loadNextClientInvoiceCode(numStr)
      }
    } else {
      const { data: ride } = await supabase.from('rides').select('project_code, project_name, manufacturer, brand, model, version, year').eq('id', ownerId).single()
      if (ride) {
        setOwnerLabel(ride.project_code || '')
        setOwnerSubtitle(ride.project_name || '')
        await loadNextRideInvoiceCode(ride.project_code)
        await loadPacks({ manufacturer: ride.manufacturer || '', brand: ride.brand || '', model: ride.model || '', version: ride.version || '', year: ride.year != null ? String(ride.year) : '' })
      }
    }
  }

  // CLOSED packs that fit this ride's car, surfaced in the SERVICE dropdown so a
  // performance package can pre-fill the new quote/invoice.
  async function loadPacks(ride: { manufacturer: string; brand: string; model: string; version: string; year: string }) {
    const { data } = await supabase.from('packs').select('*').order('name')
    const norm = (s: any) => String(s ?? '').trim().toLowerCase()
    const eq = (a: any, b: any) => norm(a) === norm(b)
    // A car entry matches the ride. New shape carries brand/version + a years[]
    // list; only fields the entry actually specifies are required to match.
    const carMatches = (c: any) => {
      if (Array.isArray(c?.years)) {
        if (c.manufacturer && !eq(c.manufacturer, ride.manufacturer)) return false
        if (c.brand && !eq(c.brand, ride.brand)) return false
        if (c.model && !eq(c.model, ride.model)) return false
        if (c.version && !eq(c.version, ride.version)) return false
        return c.years.map(Number).includes(Number(ride.year))
      }
      // Legacy shape {manufacturer, model, year}.
      return eq(c?.manufacturer, ride.manufacturer) && eq(c?.model, ride.model) && eq(c?.year, ride.year)
    }
    const matched = (data || []).filter((p: any) => {
      // LAW (2026-07-23): the US quote picker only offers zone='US' packs.
      if ((p.zone ?? 'US') !== 'US') return false
      if ((p.status || 'DRAFT') !== 'CLOSED') return false
      const carList = Array.isArray(p.cars) && p.cars.length ? p.cars : [{ manufacturer: p.manufacturer, model: p.model, year: p.year }]
      return carList.some(carMatches)
    })
    // Espécies (kind): PACK e SERVICE (manutenção) entram no dropdown principal;
    // ADDON vira checkbox opcional por cima. Legado sem kind = PACK.
    const kindOf = (p: any) => { const k = String(p.kind || 'PACK').toUpperCase(); return k === 'BLOCK' ? 'SERVICE' : k }
    setPacks(matched.filter((p: any) => kindOf(p) !== 'ADDON') as Pack[])
    setAddons(matched.filter((p: any) => kindOf(p) === 'ADDON') as Pack[])
  }

  function onPackSelect(value: string) {
    setSelectedPackId(value)
    if (value === '__new__' || value === '') setService('')
    else setService(packs.find(p => p.id === value)?.name || '')
  }

  async function loadNextRideInvoiceCode(code: string) {
    const { data } = await supabase.from('invoices').select('invoice_code').eq('ride_id', ownerId)
    const usedNumbers = data?.map((item) => {
      const match = item.invoice_code?.match(/\.(\d+)$/)
      return match ? Number(match[1]) : null
    }) || []
    let nextNumber = 1
    while (usedNumbers.includes(nextNumber)) nextNumber++
    setInvoiceCode(`${code}.${nextNumber}`)
  }

  async function loadNextClientInvoiceCode(numStr: string) {
    const { data } = await supabase.from('invoices').select('invoice_code').eq('client_id', ownerId)
    const usedNumbers = data?.map((item) => {
      const match = item.invoice_code?.match(/\.(\d+)$/)
      return match ? Number(match[1]) : null
    }) || []
    let nextNumber = 1
    while (usedNumbers.includes(nextNumber)) nextNumber++
    setInvoiceCode(`${numStr}.${nextNumber}`)
  }

  function formatMileage(value: string) {
    const clean = value.replace(/[^0-9.]/g, '')
    const partsArr = clean.split('.')
    const intPart = partsArr[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return partsArr.length > 1 ? `${intPart}.${partsArr[1]}` : intPart
  }

  async function createInvoice() {
    if (saving) return
    setSaving(true)
    // A real pack is selected when selectedPackId is a pack id (not '' / '__new__').
    const pack = packs.find(p => p.id === selectedPackId) || null
    const row: any = {
      invoice_code: invoiceCode,
      hiring_date: isValidDate(hiringDate) ? hiringDate : null,
      entry_date: isValidDate(entryDate) ? entryDate : null,
      mileage: mileage ? parseFloat(mileage.replace(/,/g, '')) : null,
      service: service || null,
      // Quote until a HIRING DATE is set; filling it at creation makes it an invoice immediately.
      is_quote: isQuote && !isValidDate(hiringDate),
    }
    // Applying a pack copies its totals config onto the new invoice. Florida taxes
    // is NOT carried — a quote/invoice starts with no FL tax; the user adds it if wanted.
    if (pack) {
      row.target_grand_total = pack.target_grand_total ?? null
      row.florida_taxes = null
      row.global_discount = pack.global_discount ?? null
      row.import_margin = pack.import_margin ?? 0
    }
    // Invoices inherit their owner's origin (PROJECT vs SHOP) so shop invoices
    // stay in the SHOP area and never mix into PROJECTS.
    if (isClient) {
      row.client_id = ownerId
      const { data: c } = await supabase.from('clients').select('origin').eq('id', ownerId).single()
      row.origin = c?.origin || 'PROJECT'
    } else {
      row.ride_id = ownerId
      // Freeze the owner: stamp the ride's CURRENT client on the invoice, so a
      // future ownership transfer never re-attributes this invoice's history.
      const { data: r } = await supabase.from('rides').select('client_id, origin').eq('id', ownerId).single()
      row.client_id = r?.client_id ?? null
      row.origin = r?.origin || 'PROJECT'
    }

    const { data: invoice, error } = await supabase.from('invoices').insert([row]).select().single()
    if (error || !invoice) { alert(error?.message || `Error creating ${isQuote ? 'quote' : 'invoice'}`); setSaving(false); return }

    const chosenAddons = addons.filter(a => selectedAddonIds.has(a.id))
    if (pack) {
      await applyPack(invoice.id, pack)
    } else if (!chosenAddons.length) {
      // Seed the default Full Project Labor service so EDIT opens ready to fill.
      await supabase.from('invoice_services').insert([{ invoice_id: invoice.id, description: FULL_PROJECT_LABOR, price: 0 }])
    }
    // Add-ons escolhidos aplicam POR CIMA, na ordem marcada — mesmo applyPack.
    for (const a of chosenAddons) await applyPack(invoice.id, a)

    router.push(`${basePath}/edit/${invoice.id}`)
  }

  // Copy a pack's PARTS / SERVICES / EXPENSES / NOTES onto the new invoice. All
  // dates are cleared and nothing is marked paid (no payments, no payment_date,
  // no fl_tax_expense_date) — the applied pack is a fresh, unpaid starting point.
  async function applyPack(invoiceId: string, pack: Pack) {
    // BR-authored packs store BRL in unit_price/amount/price with the USD original
    // in *_usd — this app is USD-only, so always prefer the _usd side (BRL-only
    // companions scale by the line's own rate). And "Importação — ..." lines are
    // the BR freight (PowerTrade): RULE (2026-07-23) — the US version of a pack
    // NEVER carries the importações.
    const IMPORT_RE = /^\s*importa[cç][aã]o\s*[—–-]/i
    const partRows = (pack.parts || []).filter((p: any) => !IMPORT_RE.test(p.description || '')).map((p: any) => {
      const ratio = (p.unit_price_usd != null && Number(p.unit_price) > 0) ? Number(p.unit_price_usd) / Number(p.unit_price) : 1
      return {
        invoice_id: invoiceId,
        description: p.description,
        unit_price: (p.unit_price_usd != null ? Number(p.unit_price_usd) : Number(p.unit_price)) || 0,
        quantity: Number(p.quantity) || 0,
        base_cost: (p.base_cost != null && p.base_cost !== '') ? Number(p.base_cost) * ratio : null,
        kit_group: p.kit_group || null,
        kit_name: p.kit_name || null,
        source_item: p.source_item || null,
      }
    })
    if (partRows.length > 0) await supabase.from('invoice_parts').insert(partRows)

    let serviceRows = (pack.services || []).map((s: any) => ({ invoice_id: invoiceId, description: s.description, price: (s.price_usd != null ? Number(s.price_usd) : Number(s.price)) || 0 }))
    // Always keep a Full Project Labor row so EDIT's auto-CALCULATE has its anchor.
    if (serviceRows.length === 0) serviceRows = [{ invoice_id: invoiceId, description: FULL_PROJECT_LABOR, price: 0 }]
    await supabase.from('invoice_services').insert(serviceRows)

    // Pack expenses group by kit_group (text); invoice expenses group by
    // purchase_group (uuid). Map each pack kit to a fresh uuid so kits land as
    // grouped expenses (matching how parts carry kit_group through).
    const expGroupMap = new Map<string, string>()
    const expenseRows = (pack.expenses || []).filter((e: any) => !IMPORT_RE.test(e.item || '')).map((e: any) => {
      let purchaseGroup: string | null = null
      if (e.kit_group) {
        if (!expGroupMap.has(e.kit_group)) expGroupMap.set(e.kit_group, crypto.randomUUID())
        purchaseGroup = expGroupMap.get(e.kit_group)!
      }
      const ratio = (e.amount_usd != null && Number(e.amount) > 0) ? Number(e.amount_usd) / Number(e.amount) : 1
      return {
        invoice_id: invoiceId,
        expense_date: null,
        supplier: e.supplier || null,
        item: e.item,
        price: (e.amount_usd != null ? Number(e.amount_usd) : Number(e.amount)) || 0,
        tax: (Number(e.tax) || 0) * ratio,
        extra: (Number(e.extra) || 0) * ratio,
        quantity: Number(e.quantity) || 1,
        item_discount: Number(e.item_discount) || 0,
        payment_date: null,
        receipt_url: null,
        // Carry the template's export status so already-exported expenses don't
        // re-import into ITEMS (which would duplicate items already copied in).
        export_status: e.export_status || 'FRESH',
        purchase_group: purchaseGroup,
        kit_group: e.kit_group || null,
        kit_name: e.kit_name || null,
      }
    })
    if (expenseRows.length > 0) await supabase.from('invoice_expenses').insert(expenseRows)

    const noteRows = (pack.notes || []).map((n: any) => ({ invoice_id: invoiceId, note: n.note }))
    if (noteRows.length > 0) await supabase.from('invoice_notes').insert(noteRows)

    // A quote nasce já com o PART NUMBER ligado/desligado como o pack manda
    // (Márcio, 26/ago/2026). Só escreve quando o pack pede ON — invoices já
    // nasce com false, e um pack OFF não tem por que sobrescrever nada.
    if (pack.show_part_numbers) await supabase.from('invoices').update({ show_part_numbers: true }).eq('id', invoiceId)

    // STAFF DUTIES do pack (Márcio, 26/ago/2026). O template carrega só a
    // TAREFA — quem executa se escolhe aqui, na quote, porque o Packs DB é
    // compartilhado com o BR e o staff de lá é outro. As duties nascem em
    // aberto e sem dono: aparecem na quote e no quadro /duties sob
    // "Unassigned" até alguém ser apontado.
    const dutyRows = (pack.duties || [])
      .filter((d: any) => String(d?.description || '').trim())
      .map((d: any) => ({
        invoice_id: invoiceId,
        staff_id: null,
        description: String(d.description).trim(),
        done: false,
        priority: String(d.priority || '1'),
        // PREVISTO do pack (Márcio, 26/ago/2026: "jamais texto, crie uma coluna
        // nova pro tempo previsto"). Par com time_seconds, que é o REALIZADO.
        estimated_seconds: Number(d.estimated_seconds) > 0 ? Math.round(Number(d.estimated_seconds)) : null,
      }))
    if (dutyRows.length > 0) await supabase.from('invoice_duties').insert(dutyRows)
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const noun = isQuote ? 'QUOTE' : 'INVOICE'

  if (duplicating) return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <p className="text-2xl text-gray-400">Duplicating quote…</p>
    </main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h1 className="text-4xl font-bold mb-2">ADD A NEW {noun}</h1>
      <p className="text-gray-400 text-xl mb-8">{ownerLabel}{ownerSubtitle ? ` — ${ownerSubtitle}` : ''}</p>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">{noun} CODE</label>
          <input value={invoiceCode} readOnly className={`${inputClass} opacity-50 cursor-not-allowed`} />
        </div>

        {/* Quotes carry no dates or mileage (a quote isn't hired/entered yet).
            Shopping invoices use REQUEST DATE; ride invoices keep HIRING DATE. */}
        {!isQuote && (
          <DatePicker label={isClient ? 'REQUEST DATE' : 'HIRING DATE'} value={hiringDate} onChange={setHiringDate} />
        )}

        {/* ENTRY DATE is ride-only (a car physically entering the shop). */}
        {!isClient && !isQuote && (
          <DatePicker label="ENTRY DATE" value={entryDate} onChange={setEntryDate} />
        )}

        {!isClient && !isQuote && (
          <div>
            <label className="block mb-2 text-lg font-bold">MILEAGE</label>
            <input type="text" value={mileage} onChange={(e) => setMileage(formatMileage(e.target.value))} className={inputClass} placeholder="0" />
          </div>
        )}

        <div>
          <label className="block mb-2 text-lg font-bold">{isClient ? 'PURCHASE' : 'SERVICE'}</label>
          {isClient ? (
            <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={inputClass} placeholder="Purchase description" />
          ) : (
            <>
              {/* Ride SERVICE: pick a saved pack for this car, or "new one" to name a new pack. */}
              <select value={selectedPackId} onChange={(e) => onPackSelect(e.target.value)} className={inputClass}>
                <option value="">— Select a pack / new one —</option>
                {packs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="__new__">new one</option>
              </select>
              {selectedPackId === '__new__' && (
                <input type="text" value={service} onChange={(e) => setService(e.target.value)} className={`${inputClass} mt-3`} placeholder="New service / pack name" autoFocus />
              )}
              {/* OPTIONAL ADD-ONS — zero ou mais, aplicados por cima do escolhido */}
              {addons.length > 0 && (
                <div className="mt-3 bg-gray-900 border border-gray-700 rounded-2xl p-4">
                  <p className="text-sm font-bold text-purple-300 mb-2">OPTIONAL ADD-ONS</p>
                  {addons.map(a => (
                    <label key={a.id} className="flex items-center gap-3 py-1 cursor-pointer">
                      <input type="checkbox" checked={selectedAddonIds.has(a.id)} onChange={() => { const s = new Set(selectedAddonIds); if (s.has(a.id)) s.delete(a.id); else s.add(a.id); setSelectedAddonIds(s) }} className="w-5 h-5 accent-purple-600" />
                      <span className="text-lg">{a.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <button onClick={createInvoice} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
          {saving ? 'CREATING...' : `CREATE ${noun}`}
        </button>
        <button type="button" onClick={() => window.history.back()} className="text-gray-400 text-xl">Cancel</button>
      </div>
    </main>
  )
}
