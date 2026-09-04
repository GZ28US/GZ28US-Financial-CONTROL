'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { fileForScan, scanCurrencyFx } from '@/lib/scanFile'
import SourceSelect, { DEFAULT_SOURCE, matchSource } from '@/components/SourceSelect'
import { OrderChip, DeliverChip, DeliverFields, hasDeliverChip, normCancelStatus, DELIVER_COLUMNS, type DeliverChipRow, type CancelStatus } from '@/components/DeliverChip'
import { pickedUpFromScan } from '@/lib/deliverStatus'
import { normNature } from '@/lib/itemNature'

function todayStr() { return new Date().toISOString().slice(0, 10) }

// A tela era GOODS e virou ASSETS (Márcio, 27/ago/2026): patrimônio da oficina,
// não só ferramenta. Os quatro grupos são fixos, definidos por ele — nada de
// chip nascendo do dado, como acontece em INPUTS, porque aqui a lista é uma
// decisão de negócio e não um reflexo do que já foi digitado.
//   FLEET       — veículos
//   MACHINERY   — máquina de oficina (dyno, elevador, carport)
//   ELECTRONICS — computador, monitor, painel, interface de tuning, câmera
//   GOODS       — ferramenta e o resto
// A coluna goods.category nasce VAZIA e a classificação dos itens é passo
// separado, que ele ainda não autorizou.
const ASSET_CATEGORIES = ['FLEET', 'MACHINERY', 'ELECTRONICS', 'GOODS'] as const

// FLEET não é linha de `goods`: são os RIDES da casa, lidos do mesmo banco de
// sempre (Márcio, 27/ago/2026: "use o DB dos rides... não crie nenhum campo").
// O critério é o title_scope que o financeiro já usa: OWN = nosso, TOOL =
// ferramenta de trabalho. As despesas de cada carro são as invoice_expenses
// que já existem — mostradas uma por linha, no visual do GOOD EXPENSES, sem
// copiar nada: o mesmo dinheiro nunca vive em dois lugares.
// order_number: ORDER NUMBER é SAGRADO (29/ago/2026) — a despesa da frota
// também carrega o pedido. E o RASTREIO agora mora na PRÓPRIA LINHA (virada de
// chave, 29/ago: "o tracking, carrier e o que quer que seja necessario pra
// rastrear agora vive como coluna nova da tabela dos itens comprados, na
// origem") — nada de join com part_streams para saber se a peça chegou.
type FleetExpense = DeliverChipRow & { id: string; item: string | null; supplier: string | null; price: number; quantity: number; tax: number; extra: number; item_discount: number; payment_date: string | null; order_number: string | null }
// pickedUp/tracking/carrier: a despesa da frota é item comprado como qualquer
// outro. Desde 30/ago/2026 não há SELETOR de status — "sem campo pra isso, e
// uma INTERPRETACAO". Guarda-se só o fato que nenhuma conta produz: balcão.
const emptyFleetForm = { id: '', carId: '', invoiceId: '', item: '', supplier: '', amount: '', date: '', paid: true, orderNumber: '', pickedUp: false, cancelStatus: null as CancelStatus | null, tracking: '', carrier: '' }
// Duas coisas diferentes se chamam "nota" num carro:
//   titleNotes  — rides.title_notes, o DOSSIÊ do documento. Bloco único, escrito
//                 em TITLE & DOCS na tela do ride. Aqui só se lê.
//   notes       — invoice_notes, a LISTA de anotações do carro. É nela que o
//                 NEW / EDIT / REMOVE trabalha (Márcio, 27/ago/2026) — só uma
//                 lista aceita "novo".
type FleetNote = { id: string; note: string | null }
const emptyNoteForm = { id: '', carId: '', invoiceId: '', text: '' }
type FleetCar = {
  id: string; code: string; name: string; spec: string
  invoiceId: string | null
  notes: FleetNote[]
  vin: string | null; plate: string | null
  scope: string; titleTransferred: boolean; titleNotes: string | null
  expenses: FleetExpense[]; total: number
}
const fleetLine = (e: FleetExpense) =>
  (Number(e.price) || 0) * (Number(e.quantity) || 1) + (Number(e.tax) || 0) + (Number(e.extra) || 0) - (Number(e.item_discount) || 0)

type Good = DeliverChipRow & {
  id: string
  description: string
  quantity: number
  unit_price: number
  purchase_date: string | null
  supplier: string | null
  purchase_group?: string | null
  category?: string | null
  // Stored as a JSON-stringified array of URLs (scanned purchases set one URL).
  receipt_url?: string | null
  // ORDER NUMBER é SAGRADO: o pedido da loja mora aqui. O RASTREIO também —
  // picked_up/tracking_number/carrier/eta/delivered_at são colunas desta mesma
  // tabela, trazidas pelo select('*'). Status não é coluna: é derivado.
  order_number?: string | null
  // Coluna que a tabela `goods` já tem e o select('*') já traz: é ela que diz se
  // a linha está PAGA — o degrau em que a cascata do status começa (29/ago/2026).
  payment_date?: string | null
}

type GoodWithStats = Good & {
  expensesTotal: number
}

// After confirming a scanned good purchase we queue an ExpenseReport for the
// optional WhatsApp share. One scan = one report (which can list multiple items).
type ExpenseReportItem = { item: string; amount: string; quantity: string }
type ExpenseReport = {
  supplier: string
  date: string
  receipt_url: string
  items: ExpenseReportItem[]
  report: boolean
}
type DuplicateInfo = { title: string; details: string; proceed: () => void }

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

// receipt_url is stored as a JSON-stringified array of URLs. Tolerant of older
// rows that may have a plain string instead of a JSON array.
function parseReceiptUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

export default function GoodsPage() {
  const [goods, setGoods] = useState<GoodWithStats[]>([])
  const [category, setCategory] = useState<string>('ALL')
  const [fleet, setFleet] = useState<FleetCar[]>([])
  const [openCar, setOpenCar] = useState<Set<string>>(new Set())
  const [fleetForm, setFleetForm] = useState<typeof emptyFleetForm | null>(null)
  const [savingFleetExp, setSavingFleetExp] = useState(false)
  const [confirmFleetExp, setConfirmFleetExp] = useState<string | null>(null)
  const [notesCar, setNotesCar] = useState<FleetCar | null>(null)
  const [noteForm, setNoteForm] = useState<typeof emptyNoteForm | null>(null)
  const [savingNote, setSavingNote] = useState(false)
  const [confirmNote, setConfirmNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Group-level removal confirmation
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Group-level EDIT modal state. Editing a purchase updates supplier + date on
  // every good that shares the same purchase_group (mirrors inputs page).
  const [editingPurchaseGroupId, setEditingPurchaseGroupId] = useState<string | null>(null)
  const [editingPurchaseSupplier, setEditingPurchaseSupplier] = useState('')
  const [editingPurchaseDate, setEditingPurchaseDate] = useState('')

  // SCAN PURCHASE state
  const [scanningPurchase, setScanningPurchase] = useState(false)
  const [scannedPurchase, setScannedPurchase] = useState<{
    supplier: string
    date: string
    source: string
    // ORDER NUMBER é SAGRADO (29/ago/2026): o scan lê e a compra grava.
    orderNumber: string
    // O QUE O DOCUMENTO DIZ SOBRE A ENTREGA — shipTo é leitura do papel, não
    // coluna: é com ele que o picked_up nasce certo (30/ago/2026).
    shipTo: string
    trackingNumber: string
    carrier: string
    tax: string
    shipping: string
    // nature = "O QUE É ESTA LINHA?" lida pelo scan (PART/SERVICE/DIGITAL/CHARGE/
    // MONEY, ou null quando o modelo não soube dizer). Viaja do scan até o INSERT
    // para a linha NASCER classificada — ver lib/itemNature.ts.
    items: { description: string; amount: string; quantity: string; nature: string | null }[]
    receiptUrl: string
  } | null>(null)

  // WhatsApp + duplicate-warning state
  const [expenseReports, setExpenseReports] = useState<ExpenseReport[] | null>(null)
  const [sendingReports, setSendingReports] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)

  useEffect(() => { loadGoods() }, [])

  // A despesa do carro da frota vive em invoice_expenses, na invoice do proprio
  // carro — a mesma coisa que a tela do ride faz. Aqui e so o outro lugar de
  // onde da pra mexer nela.
  async function saveNote() {
    if (!noteForm) return
    if (!noteForm.text.trim()) { alert('Escreva a nota.'); return }
    setSavingNote(true)
    try {
      if (noteForm.id) {
        const { error } = await supabase.from('invoice_notes').update({ note: noteForm.text.trim() }).eq('id', noteForm.id)
        if (error) { alert(error.message); return }
      } else {
        if (!noteForm.invoiceId) { alert('Este carro nao tem invoice para receber a nota.'); return }
        const { error } = await supabase.from('invoice_notes').insert([{ invoice_id: noteForm.invoiceId, note: noteForm.text.trim() }])
        if (error) { alert(error.message); return }
      }
      setNoteForm(null)
      await reloadNotesCar(noteForm.carId)
    } finally { setSavingNote(false) }
  }

  async function removeNote(id: string, carId: string) {
    const { error } = await supabase.from('invoice_notes').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmNote(null)
    await reloadNotesCar(carId)
  }

  // Recarrega a frota e mantem o pop-up aberto no mesmo carro.
  async function reloadNotesCar(carId: string) {
    const fresh = await loadFleet()
    const car = (fresh || []).find(c => c.id === carId) || null
    setNotesCar(car)
  }

  async function saveFleetExp() {
    if (!fleetForm) return
    if (!fleetForm.item.trim()) { alert('Descreva a despesa.'); return }
    const amount = parseFloat(fleetForm.amount)
    if (!(amount > 0)) { alert('Informe o valor.'); return }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(fleetForm.date) ? fleetForm.date : null
    const row = {
      item: fleetForm.item.trim(),
      supplier: fleetForm.supplier.trim() || null,
      price: amount, quantity: 1,
      expense_date: d,
      payment_date: fleetForm.paid ? d : null,
      // ORDER NUMBER sagrado: o form da frota também registra o pedido.
      order_number: fleetForm.orderNumber.trim() || null,
      // O ÚNICO campo da cascata que se grava. Despesa sem pagamento continua
      // sem badge — mas isso quem decide é a derivação lendo payment_date, não
      // um NULL escrito aqui. Rastreio digitado sobe para SHIPPED sozinho.
      picked_up: fleetForm.pickedUp,
      // CANCELAMENTO (30/ago/2026): grava SÓ este campo — payment_date é do
      // botão PAID/NOT PAID, decisão humana à parte.
      cancel_status: fleetForm.cancelStatus,
      tracking_number: fleetForm.tracking.trim() || null,
      carrier: fleetForm.carrier.trim() || null,
    }
    setSavingFleetExp(true)
    try {
      if (fleetForm.id) {
        const { error } = await supabase.from('invoice_expenses').update(row).eq('id', fleetForm.id)
        if (error) { alert(error.message); return }
      } else {
        if (!fleetForm.invoiceId) { alert('Este carro nao tem invoice para receber a despesa.'); return }
        const { error } = await supabase.from('invoice_expenses').insert([{ ...row, invoice_id: fleetForm.invoiceId }])
        if (error) { alert(error.message); return }
      }
      setFleetForm(null)
      await loadFleet()
    } finally { setSavingFleetExp(false) }
  }

  async function removeFleetExp(id: string) {
    const { error } = await supabase.from('invoice_expenses').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmFleetExp(null)
    await loadFleet()
  }

  async function loadFleet() {
    const { data: rides } = await supabase.from('rides').select('*')
      .or('title_scope.eq.OWN,title_scope.eq.TOOL')
    if (!rides?.length) { setFleet([]); return }
    const { data: invs } = await supabase.from('invoices').select('id, ride_id')
      .in('ride_id', rides.map((r: any) => r.id))
    const invIds = (invs || []).map((i: any) => i.id)
    // Mesma janela da migration à mão (ver /rides/[id]): sem o desvio, os 8 carros
    // da frota apareciam com $0 — e ainda eram ORDENADOS por esse zero.
    const GCOLS = 'id, invoice_id, item, supplier, price, quantity, tax, extra, item_discount, payment_date, stock_source_type, order_number, ' + DELIVER_COLUMNS
    let expsRes: any = invIds.length
      ? await supabase.from('invoice_expenses').select(GCOLS).in('invoice_id', invIds)
      : { data: [] as any[], error: null }
    if (expsRes.error?.code === '42703' && /\bnature\b/.test(String(expsRes.error.message || ''))) {
      expsRes = await supabase.from('invoice_expenses').select(GCOLS.replace(/,\s*nature\b/, '')).in('invoice_id', invIds)
    }
    if (expsRes.error) { console.error('[frota] despesas não carregaram:', expsRes.error); return }
    const exps = expsRes.data as any[]
    const { data: notesData } = invIds.length
      ? await supabase.from('invoice_notes').select('id, invoice_id, note').in('invoice_id', invIds).order('created_at', { ascending: true })
      : { data: [] as any[] }
    const rideOfInv = new Map((invs || []).map((i: any) => [i.id, i.ride_id]))
    const byRide = new Map<string, FleetExpense[]>()
    for (const e of (exps || [])) {
      const rid = rideOfInv.get(e.invoice_id)
      if (!rid) continue
      if (!byRide.has(rid)) byRide.set(rid, [])
      byRide.get(rid)!.push(e as FleetExpense)
    }
    const cars: FleetCar[] = rides.map((r: any) => {
      const ex = (byRide.get(r.id) || []).sort((a, b) => String(b.payment_date || '').localeCompare(String(a.payment_date || '')))
      const rideInvs = (invs || []).filter((i: any) => i.ride_id === r.id)
      const rideInvIds = new Set(rideInvs.map((i: any) => i.id))
      const rideNotes = (notesData || []).filter((n: any) => rideInvIds.has(n.invoice_id)).map((n: any) => ({ id: n.id, note: n.note }))
      return {
        id: r.id, code: r.project_code || '—', name: r.project_name || '',
        invoiceId: rideInvs.length ? rideInvs[0].id : null,
        notes: rideNotes,
        spec: [r.year, r.brand || r.manufacturer, r.model, r.version].filter(Boolean).join(' '),
        vin: r.vin || null, plate: r.plate || null,
        scope: r.title_scope, titleTransferred: !!r.title_transferred, titleNotes: r.title_notes || null,
        expenses: ex, total: ex.reduce((s, e) => s + fleetLine(e), 0),
      }
    }).sort((a: FleetCar, b: FleetCar) => b.total - a.total)
    setFleet(cars)
    return cars
  }

  async function loadGoods() {
    // Order by the actual purchase_date (newest first), with created_at as a
    // tiebreaker so rows entered later for the same day still float to the top.
    // nullsFirst:false pushes goods with no purchase_date to the bottom.
    const { data, error } = await supabase
      .from('goods')
      .select('*')
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) { console.error(error); setLoading(false); return }

    const goodsWithStats = await Promise.all((data || []).map(async (good) => {
      const { data: expenses } = await supabase.from('good_expenses').select('amount').eq('good_id', good.id)
      const expensesTotal = (expenses || []).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
      return { ...good, expensesTotal }
    }))

    setGoods(goodsWithStats)
    await loadFleet()
    setLoading(false)
    // Groups start collapsed — the user opens the ones they want to inspect.
  }

  async function removeGood(id: string) {
    const { error } = await supabase.from('goods').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setConfirmId(null)
    loadGoods()
  }

  // Group-level operations.
  function startEditPurchase(groupId: string, groupGoods: GoodWithStats[]) {
    const first = groupGoods[0]
    setEditingPurchaseGroupId(groupId)
    setEditingPurchaseSupplier(first.supplier || '')
    setEditingPurchaseDate(first.purchase_date || '')
  }

  async function confirmEditPurchase() {
    if (!editingPurchaseGroupId) return
    const { error } = await supabase.from('goods').update({
      supplier: editingPurchaseSupplier || null,
      purchase_date: isValidDate(editingPurchaseDate) ? editingPurchaseDate : null,
      // UMA data só (lei 18/ago, goods 19/ago): payment_date espelha sempre.
      payment_date: isValidDate(editingPurchaseDate) ? editingPurchaseDate : null,
    }).eq('purchase_group', editingPurchaseGroupId)
    if (error) { alert(error.message); return }
    setEditingPurchaseGroupId(null)
    loadGoods()
  }

  async function removePurchaseGroup(groupId: string) {
    const { error } = await supabase.from('goods').delete().eq('purchase_group', groupId)
    if (error) { alert(error.message); return }
    setConfirmGroupId(null)
    loadGoods()
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  async function handleScanGood(file: File) {
    setScanningPurchase(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `goods/purchases/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (uploadError) { alert(uploadError.message); setScanningPurchase(false); return }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      const receiptUrl = urlData.publicUrl

      const { base64, mediaType } = await fileForScan(file)

      const response = await fetch(`${BASE_PATH}/api/scan-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // separateExtras keeps the item price clean and returns sales tax + shipping
        // separately (per item) so they can land as the good's extra cost lines.
        body: JSON.stringify({ base64, mediaType, separateExtras: true, today: todayStr() }),
      })
      const data = await response.json()
      if (data.error) { alert(`Scan error: ${data.error}\n${data.detail || ''}`); setScanningPurchase(false); return }
      const text = data.content?.map((c: any) => c.text || '').join('') || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      // BRL-as-USD guard: foreign-currency documents never register raw numbers as dollars.
      const fx = await scanCurrencyFx(parsed.currency)
      if (fx == null) { setScanningPurchase(false); return }

      const supplier = String(parsed.supplier || '').trim()
      const date = String(parsed.date || '')
      const source = matchSource(String(parsed.source || '').trim())
      // Nº do pedido como impresso (zeros à esquerda, hífens, sem '#').
      const orderNumber = String(parsed.order_number || '').trim()
      const rawItems = (parsed.items || [])
      const items = rawItems.map((i: any) => ({
        description: String(i.description || ''),
        amount: (((parseFloat(i.amount) || 0) * fx)).toFixed(2),
        quantity: String(i.quantity || '1'),
        // A rota já normalizou (normNature): vem 'PART'|'SERVICE'|… ou null.
        nature: normNature(i.nature),
      }))
      // Sales tax + shipping/extra are summed across the items into the order-level
      // TAX and SHIPPING (each becomes one extra cost line on the good).
      const tax = rawItems.reduce((s: number, it: any) => s + (parseFloat(it.tax) || 0), 0) * fx
      const shipping = rawItems.reduce((s: number, it: any) => s + (parseFloat(it.extra) || 0), 0) * fx
      const total = items.reduce((s: number, it: any) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0) + tax + shipping

      const openReview = () => setScannedPurchase({ supplier, date, source, orderNumber, shipTo: String(parsed.ship_to || '').trim(), trackingNumber: String(parsed.tracking_number || '').trim(), carrier: String(parsed.carrier || '').trim(), tax: tax > 0 ? tax.toFixed(2) : '', shipping: shipping > 0 ? shipping.toFixed(2) : '', items, receiptUrl })

      // Duplicate check: any existing goods row with the same supplier+date+total
      // (summed per purchase_group) is treated as a possible re-scan.
      if (supplier && date && total > 0) {
        const { data: existing } = await supabase
          .from('goods')
          .select('id, supplier, purchase_date, unit_price, quantity, purchase_group')
          .ilike('supplier', supplier)
          .eq('purchase_date', date)

        if (existing && existing.length > 0) {
          const groupTotals = new Map<string, number>()
          existing.forEach(e => {
            const key = e.purchase_group || e.id
            const lineT = (parseFloat(e.unit_price) || 0) * (parseFloat(e.quantity) || 1)
            groupTotals.set(key, (groupTotals.get(key) || 0) + lineT)
          })
          const matches = Array.from(groupTotals.values()).some(t => Math.abs(t - total) < 0.01)
          if (matches) {
            setScanningPurchase(false)
            setDuplicateWarning({
              title: 'POSSIBLE DUPLICATE GOOD',
              details: `A good from "${supplier}" on ${formatDate(date)} for ${formatUSD(total)} already exists.\n\nIs this the same receipt being scanned again?`,
              proceed: openReview,
            })
            return
          }
        }
      }

      openReview()
    } catch (err) {
      console.error(err)
      alert('Failed to scan receipt. Please try again.')
    }
    setScanningPurchase(false)
  }

  async function confirmScannedPurchase() {
    if (!scannedPurchase) return
    const groupId = generateUUID()
    const source = scannedPurchase.source || DEFAULT_SOURCE
    const purchaseDate = isValidDate(scannedPurchase.date) ? scannedPurchase.date : null
    const { data: insertedGoods, error } = await supabase.from('goods').insert(
      scannedPurchase.items.map(item => ({
        description: item.description,
        quantity: parseFloat(item.quantity) || 1,
        unit_price: parseFloat(item.amount) || 0,
        purchase_date: purchaseDate,
        payment_date: purchaseDate, // espelho — comprada = paga
        supplier: scannedPurchase.supplier || null,
        source,
        // ORDER NUMBER sagrado: toda linha do grupo carrega o pedido lido.
        order_number: scannedPurchase.orderNumber || null,
        // PICKED UP pelo DOCUMENTO (Márcio, 30/ago/2026): "Se teve endereco de
        // entrega no escaneamento da compra, e Bought; se nao teve, e PickUp."
        // Amazon & cia nunca são picked_up — loja online não tem balcão. O
        // rastreio impresso vira badge SHIPPED sozinho, sem gravar status.
        picked_up: pickedUpFromScan({ supplier: scannedPurchase.supplier, shipTo: scannedPurchase.shipTo }),
        // O QUE É ESTA LINHA (04/set/2026): carimba o que o scan leu. NULL fica
        // NULL — "ninguém disse ainda" é resposta legítima e continua aparecendo
        // no STREAM marcada A CLASSIFICAR (lib/itemNature.ts).
        nature: item.nature ?? null,
        tracking_number: scannedPurchase.trackingNumber || null,
        carrier: scannedPurchase.carrier || null,
        receipt_url: JSON.stringify([scannedPurchase.receiptUrl]),
        purchase_group: groupId,
      }))
    ).select('id')
    if (error) { alert(error.message); return }

    // Sales tax + shipping land as extra cost lines (good_expenses) on the first good
    // of the purchase, carrying the same supplier/source/date.
    const firstGoodId = insertedGoods?.[0]?.id
    if (firstGoodId) {
      const extraLines = [
        { description: 'Sales Tax', amount: parseFloat(scannedPurchase.tax) || 0 },
        { description: 'Shipping', amount: parseFloat(scannedPurchase.shipping) || 0 },
      ].filter(x => x.amount > 0)
      if (extraLines.length > 0) {
        await supabase.from('good_expenses').insert(extraLines.map(x => ({
          good_id: firstGoodId,
          description: x.description,
          amount: x.amount,
          expense_date: purchaseDate,
          supplier: scannedPurchase.supplier || null,
          source,
          // ENCARGO na origem (04/set/2026): estas duas linhas são o imposto e o
          // frete do MESMO pedido, materializados aqui pelo próprio app — não são
          // uma segunda compra e nunca chegam de caminhão. É a única linha do
          // sistema cuja natureza é conhecida por CONSTRUÇÃO, e é exatamente por
          // isso que o backfill da migration só pôde carimbar estas descrições.
          nature: 'CHARGE',
          // good_expenses.order_number existe desde a migration de 29/ago:
          // tax/frete pertencem ao MESMO pedido da compra.
          order_number: scannedPurchase.orderNumber || null,
        })))
      }
    }

    // Queue the optional WhatsApp report for this good purchase.
    const report: ExpenseReport = {
      supplier: scannedPurchase.supplier,
      date: scannedPurchase.date,
      receipt_url: scannedPurchase.receiptUrl,
      items: scannedPurchase.items.map(it => ({ item: it.description, amount: it.amount, quantity: it.quantity })),
      report: true,
    }

    setScannedPurchase(null)
    setExpenseReports([report])
    loadGoods()
  }

  function buildExpenseCaption(exp: ExpenseReport) {
    const dateStr = isValidDate(exp.date) ? formatDate(exp.date) : '—'
    const total = exp.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0)
    const amountStr = formatUSD(total)
    const lines: string[] = [
      `*EXPENSE — GOOD*`,
      `${dateStr} — *${amountStr}*`,
    ]
    if (exp.supplier && exp.supplier.trim()) lines.push(exp.supplier.trim())

    // Item bullets — always shown, single or multiple.
    lines.push('')
    exp.items.forEach(it => {
      const qty = parseFloat(it.quantity) || 1
      const price = parseFloat(it.amount) || 0
      const itemTotal = price * qty
      lines.push(`• ${it.item} — ${qty} × ${formatUSD(price)} = ${formatUSD(itemTotal)}`)
    })

    return lines.join('\n') + '\n\nSent by GZ28 Control App'
  }

  async function sendExpenseReports() {
    const chosen = (expenseReports || []).filter(r => r.report)
    setSendingReports(true)
    let failures = 0
    for (const exp of chosen) {
      const caption = buildExpenseCaption(exp)
      const payload: any = { body: caption }
      if (exp.receipt_url) {
        payload.documentUrl = exp.receipt_url
        payload.filename = `good-${exp.supplier || 'purchase'}.${exp.receipt_url.split('.').pop()?.split('?')[0] || 'pdf'}`
      }
      try {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (!data.ok) failures++
      } catch {
        failures++
      }
    }
    setSendingReports(false)
    if (failures > 0) alert(`${failures} expense report(s) failed to send. The good was still saved.`)
    setExpenseReports(null)
  }

  // Build rows: group purchases together. Goods are already sorted by created_at
  // desc from the query; we walk them in order, and the FIRST time we see a
  // purchase_group we emit the whole group as a single row. Standalone goods
  // (no purchase_group) keep their own row. Net effect: most recent group/single
  // first, each group at the position of its newest item.
  // O filtro corta ANTES do agrupamento: um grupo de compra só aparece com os
  // itens que pertencem à categoria escolhida, e some se nenhum pertencer.
  const shown = category === 'ALL' ? goods : goods.filter(g => (g.category || '') === category)
  const rows: { type: 'single' | 'group'; good?: GoodWithStats; groupId?: string; groupGoods?: GoodWithStats[] }[] = []
  const seenGroups = new Set<string>()
  shown.forEach(good => {
    if (good.purchase_group) {
      if (!seenGroups.has(good.purchase_group)) {
        seenGroups.add(good.purchase_group)
        const groupGoods = shown.filter(g => g.purchase_group === good.purchase_group)
        rows.push({ type: 'group', groupId: good.purchase_group, groupGoods })
      }
    } else {
      rows.push({ type: 'single', good })
    }
  })

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Good</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this good? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removeGood(confirmId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {confirmGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Purchase</h2>
            <p className="text-gray-400 text-lg mb-8">This will remove ALL goods in this purchase. This action cannot be undone.</p>
            <div className="flex gap-4">
              <button onClick={() => setConfirmGroupId(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
              <button onClick={() => removePurchaseGroup(confirmGroupId)} className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl">REMOVE</button>
            </div>
          </div>
        </div>
      )}

      {editingPurchaseGroupId && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">EDIT PURCHASE</h2>
              <button onClick={() => setEditingPurchaseGroupId(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
              <input type="text" value={editingPurchaseSupplier} onChange={(e) => setEditingPurchaseSupplier(e.target.value)} className={inputClass} />
            </div>
            <DatePicker label="DATE" value={editingPurchaseDate} onChange={setEditingPurchaseDate} />
            <button onClick={confirmEditPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">SAVE</button>
          </div>
        </div>
      )}

      {/* DUPLICATE WARNING */}
      {duplicateWarning && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-700 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4">
            <h2 className="text-2xl font-bold text-yellow-400">⚠ {duplicateWarning.title}</h2>
            <p className="text-gray-300 whitespace-pre-wrap text-base">{duplicateWarning.details}</p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setDuplicateWarning(null)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
              <button onClick={() => { const p = duplicateWarning.proceed; setDuplicateWarning(null); p() }} className="flex-1 bg-yellow-700 hover:bg-yellow-600 px-5 py-3 rounded-2xl font-bold text-lg">REGISTER ANYWAY</button>
            </div>
          </div>
        </div>
      )}

      {/* REVIEW PURCHASE MODAL */}
      {scannedPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REVIEW PURCHASE</h2>
              <button onClick={() => setScannedPurchase(null)} className="text-gray-400 hover:text-white text-2xl font-bold">✕</button>
            </div>
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-sm text-gray-400">SUPPLIER</label>
                <input type="text" value={scannedPurchase.supplier} onChange={(e) => setScannedPurchase({ ...scannedPurchase, supplier: e.target.value })} className={inputClass} />
              </div>
              <div className="flex-1 min-w-[10rem]">
                <label className="block mb-1 text-sm text-gray-400">PAID FROM</label>
                <SourceSelect value={scannedPurchase.source} onChange={(v) => setScannedPurchase({ ...scannedPurchase, source: v })} className={inputClass} />
              </div>
              <div className="flex-1 min-w-[10rem]">
                <DatePicker label="DATE" value={scannedPurchase.date} onChange={(v) => setScannedPurchase({ ...scannedPurchase, date: v })} />
              </div>
            </div>
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[8rem]">
                <label className="block mb-1 text-sm text-gray-400">SALES TAX</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" value={scannedPurchase.tax} onChange={(e) => setScannedPurchase({ ...scannedPurchase, tax: e.target.value })} className={`${inputClass} pl-8`} placeholder="0.00" />
                </div>
              </div>
              <div className="flex-1 min-w-[8rem]">
                <label className="block mb-1 text-sm text-gray-400">SHIPPING</label>
                <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input type="text" inputMode="decimal" value={scannedPurchase.shipping} onChange={(e) => setScannedPurchase({ ...scannedPurchase, shipping: e.target.value })} className={`${inputClass} pl-8`} placeholder="0.00" />
                </div>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-2">
              {scannedPurchase.items.map((item, i) => (
                <div key={i} className="flex gap-3 items-center">
                  <input type="text" value={item.description} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], description: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} flex-1`} placeholder="Description" />
                  <div className="w-20">
                    <input type="text" inputMode="decimal" value={item.quantity} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], quantity: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${smallInputClass} w-full text-center`} placeholder="Qty" />
                  </div>
                  <div className="relative w-32">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input type="text" value={item.amount} onChange={(e) => { const items = [...scannedPurchase.items]; items[i] = { ...items[i], amount: e.target.value }; setScannedPurchase({ ...scannedPurchase, items }) }} className={`${inputClass} pl-8`} placeholder="0.00" />
                  </div>
                  <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: scannedPurchase.items.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-300 font-bold text-lg px-2">✕</button>
                </div>
              ))}
              <button onClick={() => setScannedPurchase({ ...scannedPurchase, items: [...scannedPurchase.items, { description: '', amount: '', quantity: '1', nature: null }] })} className="text-gray-400 hover:text-white text-sm font-bold">+ ADD ITEM</button>
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-right text-gray-400 font-bold self-center">
                TOTAL: {formatUSD(scannedPurchase.items.reduce((s, i) => s + (parseFloat(i.amount) || 0) * (parseFloat(i.quantity) || 1), 0) + (parseFloat(scannedPurchase.tax) || 0) + (parseFloat(scannedPurchase.shipping) || 0))}
              </div>
              <button onClick={confirmScannedPurchase} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {/* REPORT ON WHATSAPP? */}
      {expenseReports && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">REPORT ON WHATSAPP?</h2>
            </div>
            <p className="text-gray-400 text-base">Choose whether to report this purchase to the WhatsApp group.</p>
            <div className="overflow-y-auto flex-1 space-y-3">
              {expenseReports.map((exp, i) => {
                const total = exp.items.reduce((s, it) => s + (parseFloat(it.amount) || 0) * (parseFloat(it.quantity) || 1), 0)
                const titleText = `${exp.supplier || 'Purchase'} — ${exp.items.length} item${exp.items.length === 1 ? '' : 's'}`
                return (
                  <div key={i} className="border border-gray-700 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold">EXPENSE — GOOD — {formatUSD(total)}</p>
                      <p className="text-sm text-gray-400 truncate" title={titleText}>{titleText}</p>
                      <p className="text-sm text-gray-400">{isValidDate(exp.date) ? formatDate(exp.date) : 'No date'}</p>
                      <p className="text-sm text-gray-500">{exp.receipt_url ? '📎 Receipt attached' : 'No receipt (text only)'}</p>
                    </div>
                    <button
                      onClick={() => { const a = [...expenseReports]; a[i] = { ...a[i], report: !a[i].report }; setExpenseReports(a) }}
                      className={`px-5 py-3 rounded-2xl font-bold text-base whitespace-nowrap ${exp.report ? 'bg-green-700 hover:bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                    >
                      {exp.report ? 'REPORT: YES' : 'REPORT: NO'}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-700">
              <div className="flex-1 text-gray-400 font-bold self-center">
                {expenseReports.filter(r => r.report).length} of {expenseReports.length} will be reported
              </div>
              <button onClick={sendExpenseReports} disabled={sendingReports} className={`px-6 py-3 rounded-2xl font-bold text-lg ${sendingReports ? 'bg-gray-600 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600'}`}>
                {sendingReports ? 'SENDING...' : 'DONE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SCANNING OVERLAY */}
      {scanningPurchase && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
            <p className="text-2xl font-bold mb-2">Scanning Receipt...</p>
            <p className="text-gray-400">Claude is reading your receipt</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">ASSETS ({category === 'FLEET' ? fleet.length : category === 'ALL' ? goods.length + fleet.length : shown.length})</h1>
        <div className="flex gap-3">
          <label className="bg-indigo-700 hover:bg-indigo-600 px-6 py-4 rounded-2xl text-xl font-bold cursor-pointer">
            🧾 SCAN A NEW ASSET
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleScanGood(e.target.files[0]) }} />
          </label>
          <Link href="/goods/new" className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">ADD A NEW ASSET</Link>
        </div>
      </div>

      {/* CHIPS: os quatro grupos de patrimônio. O contador ao lado deixa claro
          quanto de cada um já foi classificado — hoje, nada. */}
      <div className="flex items-center gap-2 mb-8 flex-wrap">
        {['ALL', ...ASSET_CATEGORIES].map((c) => {
          const n = c === 'ALL' ? goods.length + fleet.length
            : c === 'FLEET' ? fleet.length
            : goods.filter(g => (g.category || '') === c).length
          return (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-4 py-2 rounded-full font-bold ${category === c ? 'bg-purple-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              {c === 'ALL' ? 'ALL ASSETS' : c} <span className="opacity-60">{n}</span>
            </button>
          )
        })}
        {goods.some(g => !g.category) && (
          <span className="ml-2 text-sm text-amber-500/80">
            {goods.filter(g => !g.category).length} sem categoria — aparecem só em ALL ASSETS
          </span>
        )}
      </div>

      {/* NOTES do carro, em pop-up. z-50 pra ficar acima de tudo; clicar no
          fundo escuro fecha, como nos outros diálogos do app. */}
      {notesCar && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6" onClick={() => setNotesCar(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-2xl font-bold">{notesCar.name || notesCar.code}</h2>
                <p className="text-sm text-gray-400">{notesCar.code} · NOTES</p>
              </div>
              <button onClick={() => setNotesCar(null)} className="text-gray-400 hover:text-white text-2xl font-bold shrink-0">✕</button>
            </div>
            <div className="overflow-y-auto space-y-6">
              {/* A LISTA — é aqui que NEW / EDIT / REMOVE trabalham. */}
              <div>
                <div className="flex items-center justify-between gap-4 mb-3">
                  <h3 className="text-lg font-bold">NOTES ({notesCar.notes.length})</h3>
                  {!noteForm && (
                    <button onClick={() => setNoteForm({ ...emptyNoteForm, carId: notesCar.id, invoiceId: notesCar.invoiceId || '' })} className="bg-green-700 hover:bg-green-600 px-5 py-2 rounded-2xl font-bold">+ NEW</button>
                  )}
                </div>

                {noteForm && noteForm.carId === notesCar.id && (
                  <div className="bg-gray-950 border border-blue-700 rounded-2xl p-4 mb-3 space-y-3">
                    <textarea
                      value={noteForm.text}
                      onChange={(e) => setNoteForm({ ...noteForm, text: e.target.value })}
                      rows={4}
                      placeholder="O que aconteceu com o carro…"
                      className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-base resize-none"
                    />
                    <div className="flex gap-3 flex-wrap">
                      <button onClick={saveNote} disabled={savingNote} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-2 rounded-2xl font-bold">{savingNote ? 'SAVING…' : 'SAVE'}</button>
                      <button onClick={() => setNoteForm(null)} className="bg-gray-600 hover:bg-gray-500 px-5 py-2 rounded-2xl font-bold">CANCEL</button>
                    </div>
                  </div>
                )}

                {notesCar.notes.length === 0 ? (
                  <p className="text-base text-gray-500">Nenhuma nota ainda.</p>
                ) : (
                  <div className="border border-gray-700 rounded-2xl overflow-hidden">
                    {notesCar.notes.map((n, i) => (
                      <div key={n.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i < notesCar.notes.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <p className="flex-1 text-base text-gray-300 whitespace-pre-wrap">{n.note}</p>
                        <div className="flex gap-2 shrink-0">
                          {confirmNote === n.id ? (
                            <>
                              <button onClick={() => removeNote(n.id, notesCar.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">CONFIRM</button>
                              <button onClick={() => setConfirmNote(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-xl font-bold text-sm">CANCEL</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => setNoteForm({ id: n.id, carId: notesCar.id, invoiceId: notesCar.invoiceId || '', text: n.note || '' })} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                              <button onClick={() => setConfirmNote(n.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* O DOSSIÊ DO DOCUMENTO — bloco único, mora no ride. Só leitura
                  aqui, para não existirem dois lugares editando o mesmo texto. */}
              {notesCar.titleNotes && (
                <div>
                  <h3 className="text-lg font-bold mb-2">TITLE &amp; DOCS</h3>
                  <p className="text-sm text-gray-400 mb-2">Dossiê do documento — edita-se no EDIT do carro.</p>
                  <p className="text-base text-gray-300 whitespace-pre-wrap bg-gray-950 border border-gray-800 rounded-2xl p-4">{notesCar.titleNotes}</p>
                </div>
              )}
            </div>

            <div className="pt-4 mt-4 border-t border-gray-800 flex justify-end">
              <button onClick={() => { setNoteForm(null); setConfirmNote(null); setNotesCar(null) }} className="bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-2xl font-bold">CLOSE</button>
            </div>
          </div>
        </div>
      )}

      {/* FLEET — os carros da casa. Vêm da tabela rides (title_scope OWN/TOOL),
          com os mesmos dados que tinham em RIDES, e cada despesa da invoice do
          carro vira uma linha aqui, no visual do GOOD EXPENSES. */}
      {!loading && (category === 'ALL' || category === 'FLEET') && fleet.length > 0 && (
        <div className="space-y-5 mb-8">
          {fleet.map((car) => {
            const open = openCar.has(car.id)
            return (
              <div key={car.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
                <div className="flex items-start justify-between gap-6 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="text-2xl font-bold">{car.name || car.code}</h2>
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-700 text-gray-200">{car.code}</span>
                      <span className={`px-3 py-1 rounded-full text-xs font-bold ${car.scope === 'OWN' ? 'bg-blue-900 text-blue-200' : 'bg-teal-900 text-teal-200'}`}>{car.scope === 'OWN' ? 'NOSSO' : 'FERRAMENTA'}</span>
                      {car.titleTransferred
                        ? <span className="px-3 py-1 rounded-full text-xs font-bold bg-green-900 text-green-200">TÍTULO OK</span>
                        : <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-900 text-amber-200">TÍTULO PENDENTE</span>}
                    </div>
                    <p className="text-lg text-gray-400 mt-1">{car.spec}</p>
                    <p className="text-sm text-gray-500 mt-1">
                      VIN {car.vin || '—'}{car.plate ? ` · placa ${car.plate}` : ''}
                    </p>
                    {/* A nota do título virou POP-UP (Márcio, 27/ago/2026): a do
                        Devil170 tem 20 linhas e empurrava o carro inteiro pra
                        baixo. Fica no botão NOTES, abaixo. */}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-gray-400">INVESTIDO</p>
                    <p className="text-3xl font-bold">{formatUSD(car.total)}</p>
                    <p className="text-sm text-gray-500">{car.expenses.length} despesa{car.expenses.length === 1 ? '' : 's'}</p>
                  </div>
                </div>

                <div className="flex gap-3 mt-4 flex-wrap">
                  <button onClick={() => setNotesCar(car)} className="bg-amber-700 hover:bg-amber-600 px-5 py-3 rounded-2xl font-bold">
                    NOTES{car.notes.length ? ` (${car.notes.length})` : ''}
                  </button>
                  <button
                    onClick={() => setOpenCar(prev => { const n = new Set(prev); n.has(car.id) ? n.delete(car.id) : n.add(car.id); return n })}
                    className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    {open ? 'HIDE EXPENSES' : `EXPENSES (${car.expenses.length})`}
                  </button>
                  <button
                    onClick={() => { setOpenCar(prev => new Set(prev).add(car.id)); setFleetForm({ ...emptyFleetForm, carId: car.id, invoiceId: car.invoiceId || '', date: new Date().toISOString().slice(0, 10) }) }}
                    className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold"
                  >+ ADD EXPENSE</button>
                  <Link href={`/rides/${car.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">OPEN RIDE</Link>
                </div>

                {open && fleetForm && fleetForm.carId === car.id && (
                  <div className="mt-4 bg-gray-950 border border-blue-700 rounded-2xl p-5 space-y-4">
                    <h3 className="text-xl font-bold">{fleetForm.id ? 'EDIT EXPENSE' : 'NEW EXPENSE'}</h3>
                    <input value={fleetForm.item} onChange={(ev) => setFleetForm({ ...fleetForm, item: ev.target.value })} placeholder="O que foi — ex.: pneus, seguro, pedágio" className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg" />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <input value={fleetForm.supplier} onChange={(ev) => setFleetForm({ ...fleetForm, supplier: ev.target.value })} placeholder="Fornecedor" className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg" />
                      {/* ORDER NUMBER é SAGRADO: a despesa da frota também nasce com o pedido. */}
                      <input value={fleetForm.orderNumber} onChange={(ev) => setFleetForm({ ...fleetForm, orderNumber: ev.target.value })} placeholder="Order number" className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg" />
                      <input inputMode="decimal" value={fleetForm.amount} onChange={(ev) => { if (ev.target.value === '' || /^\d*\.?\d*$/.test(ev.target.value)) setFleetForm({ ...fleetForm, amount: ev.target.value }) }} placeholder="$ 0.00" className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg" />
                      <input type="date" value={fleetForm.date} onChange={(ev) => setFleetForm({ ...fleetForm, date: ev.target.value })} className="bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg" />
                    </div>
                    {/* PICKED UP + TRACKING + CARRIER na despesa da frota. */}
                    <DeliverFields size="sm" pickedUp={fleetForm.pickedUp} cancelStatus={fleetForm.cancelStatus} tracking={fleetForm.tracking} carrier={fleetForm.carrier}
                      onPickedUp={(v) => setFleetForm({ ...fleetForm, pickedUp: v })}
                      onCancelStatus={(v) => setFleetForm({ ...fleetForm, cancelStatus: v })}
                      onTracking={(v) => setFleetForm({ ...fleetForm, tracking: v })}
                      onCarrier={(v) => setFleetForm({ ...fleetForm, carrier: v })} />
                    <div className="flex gap-3 flex-wrap">
                      <button onClick={() => setFleetForm({ ...fleetForm, paid: !fleetForm.paid })} className={`px-5 py-3 rounded-2xl font-bold ${fleetForm.paid ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>{fleetForm.paid ? 'PAID ✓' : 'NOT PAID'}</button>
                      <button onClick={saveFleetExp} disabled={savingFleetExp} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">{savingFleetExp ? 'SAVING…' : 'SAVE'}</button>
                      <button onClick={() => setFleetForm(null)} className="bg-gray-600 hover:bg-gray-500 px-6 py-3 rounded-2xl font-bold">CANCEL</button>
                    </div>
                  </div>
                )}

                {open && car.expenses.length > 0 && (
                  <div className="mt-4 border border-gray-700 rounded-2xl overflow-hidden">
                    {car.expenses.map((e, i) => (
                      <div key={e.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${i < car.expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="min-w-0">
                          <p className="text-base font-bold truncate" title={e.item || ''}>{e.item}</p>
                          <p className="text-sm text-gray-500">
                            {e.supplier || '—'} · {e.payment_date ? `pago ${e.payment_date}` : <span className="text-amber-400 font-bold">não paga</span>}
                          </p>
                          {/* ORDER NUMBER sagrado + BADGE DE ENTREGA — os dois lidos da
                              PRÓPRIA LINHA. Linha não paga e linha doada se calam sozinhas:
                              a derivação as corta no degrau 1 lendo payment_date e
                              source_type — a tela não precisa perguntar se pagou. */}
                          {((e.order_number || '').trim() || hasDeliverChip(e)) && (
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {(e.order_number || '').trim() ? <OrderChip order={(e.order_number || '').trim()} /> : null}
                              <DeliverChip row={e} />
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-bold">{formatUSD(fleetLine(e))}</span>
                          {confirmFleetExp === e.id ? (
                            <>
                              <button onClick={() => removeFleetExp(e.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">CONFIRM</button>
                              <button onClick={() => setConfirmFleetExp(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-xl font-bold text-sm">CANCEL</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => setFleetForm({ id: e.id, carId: car.id, invoiceId: car.invoiceId || '', item: e.item || '', supplier: e.supplier || '', amount: String(e.price ?? ''), date: e.payment_date || '', paid: !!e.payment_date, orderNumber: e.order_number || '', pickedUp: !!e.picked_up, cancelStatus: normCancelStatus(e.cancel_status), tracking: e.tracking_number || '', carrier: e.carrier || '' })} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                              <button onClick={() => setConfirmFleetExp(e.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : category === 'FLEET' ? null : shown.length === 0 ? (
        <p className="text-2xl text-gray-400">{goods.length === 0 ? 'No assets found.' : `Nada classificado como ${category} ainda.`}</p>
      ) : (
        <div className="space-y-5">
          {rows.map((row) => {
            if (row.type === 'group' && row.groupId && row.groupGoods) {
              const groupId = row.groupId
              const groupGoods = row.groupGoods
              const first = groupGoods[0]
              const groupItemsTotal = groupGoods.reduce((s, g) => s + g.quantity * g.unit_price, 0)
              const groupExpensesTotal = groupGoods.reduce((s, g) => s + g.expensesTotal, 0)
              const groupTotal = groupItemsTotal + groupExpensesTotal
              const isExpanded = expandedGroups.has(groupId)
              // LEI (Márcio, 29/ago/2026): "os badges de order number, tracking ou
              // BOUGHT/SHIPPED/DELIVERED devem ser nos ITENS, nao nos titulos das
              // compras, MESMO QUE SEJA REPETIDO EM TODOS." O molde commonOf morreu:
              // chip do pedido + semáforo do STREAM ficam na linha de CADA item.
              return (
                <div key={groupId} className="bg-gray-900 border border-gray-800 rounded-3xl overflow-hidden">
                  {/* Group header: text area toggles expand/collapse; buttons live in
                      their own flex section so clicks don't bubble to the toggle. */}
                  <div className="p-6 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleGroup(groupId)}>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                        <h2 className="text-2xl font-bold">{first.supplier || 'Unknown Supplier'}</h2>
                      </div>
                      <p className="text-lg text-gray-400 ml-7">{groupGoods.length} items — {formatUSD(groupTotal)} — {formatDate(first.purchase_date)}</p>
                    </div>
                    <div className="flex gap-3 flex-wrap shrink-0">
                      {(() => {
                        // VIEW at the purchase level opens the scanned receipt in
                        // a new tab. Only rendered when there's a URL to open.
                        const urls = parseReceiptUrls(first.receipt_url)
                        const url = urls[0]
                        return url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</a>
                        ) : null
                      })()}
                      <button onClick={() => startEditPurchase(groupId, groupGoods)} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</button>
                      <button onClick={() => setConfirmGroupId(groupId)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-800">
                      {groupGoods.map((good, gi) => (
                        <div key={good.id} className={`flex items-center justify-between gap-6 px-6 py-4 ${gi < groupGoods.length - 1 ? 'border-b border-gray-800' : ''}`}>
                          <div className="flex-1 min-w-0 pl-5">
                            <h3 className="text-xl font-bold">{good.description}</h3>
                            <p className="text-lg text-gray-400">Qty: {good.quantity} × {formatUSD(good.unit_price)} = {formatUSD(good.quantity * good.unit_price)}</p>
                            {good.expensesTotal > 0 && <p className="text-lg text-gray-400">Expenses: {formatUSD(good.expensesTotal)}</p>}
                            <p className="text-lg font-bold mt-1">Total Cost: {formatUSD(good.quantity * good.unit_price + good.expensesTotal)}</p>
                            {/* LEI 29/ago/2026: chip do pedido + DELIVER STATUS SEMPRE na linha
                                do item — mesmo repetidos em todos os itens da compra. Ambos
                                saem da linha já carregada; não há segunda consulta. */}
                            {((good.order_number || '').trim() || hasDeliverChip(good)) && (
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                {(good.order_number || '').trim() ? <OrderChip order={(good.order_number || '').trim()} /> : null}
                                <DeliverChip row={good} />
                              </div>
                            )}
                          </div>
                          <div className="flex gap-3 shrink-0">
                            <Link href={`/goods/${good.id}`} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-2xl font-bold text-sm">VIEW</Link>
                            <Link href={`/goods/edit/${good.id}`} className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded-2xl font-bold text-sm">EDIT</Link>
                            <button onClick={() => setConfirmId(good.id)} className="bg-red-700 hover:bg-red-600 px-4 py-2 rounded-2xl font-bold text-sm">REMOVE</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            } else if (row.type === 'single' && row.good) {
              const good = row.good
              return (
                <div key={good.id} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-2xl font-bold mb-1">{good.description}</h2>
                    {good.supplier && <p className="text-lg text-gray-400">Supplier: {good.supplier}</p>}
                    <p className="text-lg text-gray-400">Qty: {good.quantity} × {formatUSD(good.unit_price)} = {formatUSD(good.quantity * good.unit_price)}</p>
                    <p className="text-lg text-gray-400">Purchased: {formatDate(good.purchase_date)}</p>
                    {good.expensesTotal > 0 && <p className="text-lg text-gray-400">Expenses: {formatUSD(good.expensesTotal)}</p>}
                    <p className="text-lg font-bold mt-1">Total Cost: {formatUSD(good.quantity * good.unit_price + good.expensesTotal)}</p>
                    {/* ORDER NUMBER sagrado + DELIVER STATUS, ambos da própria linha. */}
                    {((good.order_number || '').trim() || hasDeliverChip(good)) && (
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {(good.order_number || '').trim() ? <OrderChip order={(good.order_number || '').trim()} /> : null}
                        <DeliverChip row={good} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 flex-wrap shrink-0">
                    <Link href={`/goods/${good.id}`} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold">VIEW</Link>
                    <Link href={`/goods/edit/${good.id}`} className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">EDIT</Link>
                    <button onClick={() => setConfirmId(good.id)} className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold">REMOVE</button>
                  </div>
                </div>
              )
            }
            return null
          })}
        </div>
      )}
    </main>
  )
}
