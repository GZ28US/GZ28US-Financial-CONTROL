'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import SourceSelect, { DEFAULT_SOURCE } from '@/components/SourceSelect'
import PaymentFields, { type PaymentInfo, defaultPayment, paymentFromRow, paymentToRow } from '@/components/PaymentFields'
import { supabase } from '@/lib/supabase'
import { mirrorEnsureSupplier } from '@/lib/suppliersMirror'
import { BASE_PATH } from '@/lib/utils'
import { DeliverChip, DeliverFields, normCancelStatus, type CancelStatus } from '@/components/DeliverChip'
import { supplierNameForRegistry } from '@/lib/supplierGuard'
import { primeCarRegistry } from '@/lib/carRegistry'

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }
function formatUSD(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
function parseReceiptUrls(raw: string | null): string[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw] } catch { return raw ? [raw] : [] }
}

const NEW_SUPPLIER = '+ NEW SUPPLIER'
const categories = ['CONSUMPTION', 'STOCK', 'APARTMENT', 'CATS']

function SupplierField({ suppliers, value, onChange }: { suppliers: string[], value: string, onChange: (v: string) => void }) {
  const [showNew, setShowNew] = useState(false)
  const [newValue, setNewValue] = useState('')

  useEffect(() => {
    if (suppliers.length === 0) setShowNew(true)
    else if (value && !suppliers.includes(value)) { setShowNew(true); setNewValue(value) }
  }, [suppliers])

  function handleSelect(v: string) {
    if (v === NEW_SUPPLIER) { setShowNew(true); setNewValue(''); onChange('') }
    else { setShowNew(false); onChange(v) }
  }

  function handleNewChange(v: string) { setNewValue(v); onChange(v) }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (showNew) return (
    <div className="space-y-2">
      <input type="text" placeholder="Type supplier name" value={newValue} onChange={(e) => handleNewChange(e.target.value)} className={inputClass} />
      {suppliers.length > 0 && <button onClick={() => { setShowNew(false); onChange('') }} className="text-gray-400 text-sm hover:text-white">← Back to list</button>}
    </div>
  )

  return (
    <select value={value} onChange={(e) => handleSelect(e.target.value)} className={selectClass}>
      <option value="">— Select supplier —</option>
      {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
      <option value={NEW_SUPPLIER}>{NEW_SUPPLIER}</option>
    </select>
  )
}

export default function EditInputPage() {
  const params = useParams()
  const router = useRouter()
  const inputId = String(params.id)

  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('STOCK')
  const [quantity, setQuantity] = useState('1')
  const [totalPrice, setTotalPrice] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [supplier, setSupplier] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  // PICKED UP + TRACKING + CARRIER: colunas DESTA linha. Em 30/ago/2026 o
  // seletor de 4 status morreu — "sem campo pra isso, e uma INTERPRETACAO, nao
  // um campo". Sobrou picked_up (boolean), o único fato da cascata que nenhuma
  // conta produz: só o balcão o cria. O resto (BOUGHT/SHIPPED/DELIVERED) se lê
  // de pagou / tracking_number / delivered_at.
  const [pickedUp, setPickedUp] = useState(false)
  // CANCELAMENTO (30/ago/2026): null = compra viva, CANCELLED = aguardando
  // estorno, REFUNDED = estornado. Marcar aqui grava SÓ cancel_status.
  const [cancelStatus, setCancelStatus] = useState<CancelStatus | null>(null)
  const [tracking, setTracking] = useState('')
  const [carrier, setCarrier] = useState('')
  // FATOS DO ROBÔ, NÃO DO FORMULÁRIO (30/ago/2026). Estes três não têm campo na
  // tela — quem os escreve é o rastreador do STREAM, nunca o usuário — mas o
  // badge de prévia PRECISA deles: sem delivered_at a cascata cai um degrau e
  // uma peça JÁ ENTREGUE aparecia como SHIPPED. Viajam intactos do banco até o
  // chip, e não voltam pro banco em save nenhum.
  const [deliveredAt, setDeliveredAt] = useState<string | null>(null)
  const [eta, setEta] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [source, setSource] = useState('')
  // Universal payment block (inputs keep their own `source` field — no write-through).
  const [payment, setPayment] = useState<PaymentInfo>(defaultPayment())
  const [receiptUrls, setReceiptUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [openReceipts, setOpenReceipts] = useState(false)
  // STOCK rows live in `inventory` (reached via ?src=inventory); consumption in `inputs`.
  const [table, setTable] = useState<'inputs' | 'inventory'>('inputs')
  // Peça DOADA (sobra de um carro) não tem custo: o valor é MSRP, e o custo é zero.
  const [donated, setDonated] = useState(false)

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('src') === 'inventory' ? 'inventory' : 'inputs'
    setTable(t)
    loadSuppliers()
    loadInput(t)
  }, [])

  async function loadSuppliers() {
    const { data } = await supabase.from('suppliers').select('name').order('name')
    if (data) setSuppliers(data.map(s => s.name))
  }

  async function loadInput(t: 'inputs' | 'inventory') {
    const { data, error } = await supabase.from(t).select('*').eq('id', inputId).single()
    if (error || !data) { alert('Input not found'); router.push(t === 'inventory' ? '/inventory' : '/supplies'); return }
    setDescription(data.description || '')
    setCategory(data.category || 'STOCK')
    setDonated((data.source_type || '') === 'DONATED')
    setQuantity(String(data.quantity || 1))
    const computedTotal = (parseFloat(data.unit_price) || 0) * (parseFloat(data.quantity) || 1)
    setTotalPrice(computedTotal > 0 ? computedTotal.toFixed(2) : '')
    setPurchaseDate(data.purchase_date || '')
    setSupplier(data.supplier || '')
    setOrderNumber(data.order_number || '')
    setPickedUp(!!data.picked_up)
    setCancelStatus(normCancelStatus(data.cancel_status))
    setTracking(data.tracking_number || '')
    setCarrier(data.carrier || '')
    setDeliveredAt(data.delivered_at || null)
    setEta(data.eta || null)
    setLastEvent(data.last_event || null)
    setNotes(data.notes || '')
    setSource(data.source || DEFAULT_SOURCE)
    // Initialize the payment block from the row so an untouched save round-trips.
    setPayment(paymentFromRow(data))
    setReceiptUrls(parseReceiptUrls(data.receipt_url))
    setLoading(false)
  }

  async function ensureSupplier(name: string) {
    // GUARDA DO FORNECEDOR (Márcio, 30/ago/2026): "os carros, mesmo aparecendo
    // como SUPPLIER nas expenses quando doaram algo, JAMAIS podem ser cadastrados
    // como supplier no banco. Nao permita que isso aconteca, sem poluir o banco."
    // O nome do carro CONTINUA no campo supplier da linha da expense — lá é o
    // lugar dele, é o doador. Só o CADASTRO é que não o recebe. Sai calado: não
    // é erro do usuário, é higiene do banco.
    // A guarda conhece o carro pelo CÓDIGO sozinha; para reconhecê-lo pelo NOME
    // COMERCIAL ("Dodge Charger Presidiário", que vazou pro banco BR em
    // 21/jun/2026) ela precisa da lista de rides. Uma leitura por sessão, em
    // cache — e se falhar, a guarda do código continua de pé.
    await primeCarRegistry(supabase)
    if (!supplierNameForRegistry(name)) return
    if (!name.trim() || suppliers.includes(name.trim())) return
    await supabase.from('suppliers').upsert([{ name: name.trim() }], { onConflict: 'name' })
    void mirrorEnsureSupplier(name.trim())
    setSuppliers(prev => [...prev, name.trim()].sort())
  }

  const qty = parseFloat(quantity) || 0
  const total = parseFloat(totalPrice) || 0
  const unitPrice = qty > 0 ? total / qty : 0

  async function uploadReceipts(files: FileList) {
    setUploading(true)
    const urls = [...receiptUrls]
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()
      const path = `inputs/${inputId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('good-receipts').upload(path, file, { upsert: true })
      if (error) { alert(error.message); continue }
      const { data: urlData } = supabase.storage.from('good-receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    setReceiptUrls(urls)
    await supabase.from('inputs').update({ receipt_url: urls.length > 0 ? JSON.stringify(urls) : null }).eq('id', inputId)
    setUploading(false)
  }

  async function removeReceiptUrl(index: number) {
    const updated = receiptUrls.filter((_, i) => i !== index)
    setReceiptUrls(updated)
    await supabase.from('inputs').update({ receipt_url: updated.length > 0 ? JSON.stringify(updated) : null }).eq('id', inputId)
  }

  async function saveInput() {
    if (!description) { alert('Please enter a description'); return }
    await ensureSupplier(supplier)

    const { error } = await supabase.from(table).update({
      description, category,
      quantity: qty || 1,
      unit_price: unitPrice,
      purchase_date: isValidDate(purchaseDate) ? purchaseDate : null,
      supplier: supplier.trim() || null,
      order_number: orderNumber.trim() || null,
      // O ÚNICO campo da cascata que se grava. DOADA e NÃO PAGA continuam sem
      // badge, mas não é aqui que isso se resolve: quem corta é o degrau 1 da
      // derivação (lib/deliverStatus.ts), lendo source_type e payment_date. Aqui
      // se registra só o fato: peguei no balcão, sim ou não.
      picked_up: pickedUp,
      // CANCELAMENTO: só o fato, e nunca em linha DOADA (doado não é compra —
      // não pode ter sido cancelado). Não mexe em payment_date nem em nada.
      cancel_status: donated ? null : cancelStatus,
      tracking_number: donated ? null : (tracking.trim() || null),
      carrier: donated ? null : (carrier.trim() || null),
      notes: notes.trim() || null,
      source,
      receipt_url: receiptUrls.length > 0 ? JSON.stringify(receiptUrls) : null,
      // Registered = paid (Comprovante = PAGA); payment_date is a mirror of the
      // single DATE — never a second date. No date yet → both stay empty.
      ...(() => { const pr = paymentToRow({ ...payment, paid: true }, purchaseDate); if (!isValidDate(purchaseDate)) pr.payment_date = null; return pr })(),
      updated_at: new Date().toISOString(),
    }).eq('id', inputId)
    if (error) { alert(error.message); return }
    router.push(category === 'STOCK' ? '/inventory' : '/supplies')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

  if (loading) return (
    <main className="min-h-screen bg-black text-white p-8"><Header /><p className="text-2xl text-gray-400">Loading...</p></main>
  )

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT SUPPLY</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block mb-2 text-lg font-bold">CATEGORY</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectClass}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          {/* Peça DOADA: quem entregou é o CARRO, não um fornecedor — e nada foi pago,
              então ORDER NUMBER (que guarda a invoice de origem), PAID FROM, RECEIPT e o
              bloco de pagamento não aparecem (lei 22/ago/2026). */}
          <label className="block mb-2 text-lg font-bold">{donated ? 'DONOR' : 'SUPPLIER'}</label>
          {donated
            ? <div className={`${inputClass} text-gray-300`}>{supplier || '—'}</div>
            : <SupplierField suppliers={suppliers} value={supplier} onChange={setSupplier} />}
        </div>

        {!donated && (
        <div>
          <label className="block mb-2 text-lg font-bold">ORDER NUMBER</label>
          <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="e.g. 2000149-80525197" className={inputClass} />
        </div>
        )}

        {/* PICKED UP / TRACKING / CARRIER — o rastreio vive na página do item.
            Marcar "peguei na loja" é a ÚNICA coisa de status que se digita;
            digitar rastreio sobe o badge para SHIPPED sozinho, sem gravar nada.
            DONATED não entra: peça doada não foi comprada. */}
        {!donated && (
        <div>
          <DeliverFields pickedUp={pickedUp} cancelStatus={cancelStatus} tracking={tracking} carrier={carrier}
            onPickedUp={setPickedUp} onCancelStatus={setCancelStatus} onTracking={setTracking} onCarrier={setCarrier} />
          {/* Prévia do badge com a MESMA função que a lista usa — passando o que
              a linha teria depois de salva (a data prova o "pagou"). */}
          <div className="mt-2"><DeliverChip row={{ picked_up: pickedUp, cancel_status: cancelStatus, tracking_number: tracking, carrier, payment_date: isValidDate(purchaseDate) ? purchaseDate : null, supplier, delivered_at: deliveredAt, eta, last_event: lastEvent }} /></div>
        </div>
        )}

        {!donated && (
        <div>
          <label className="block mb-2 text-lg font-bold">PAID FROM</label>
          <SourceSelect value={source} onChange={setSource} className={selectClass} />
        </div>
        )}

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">QUANTITY</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => { if (isNumeric(e.target.value)) setQuantity(e.target.value) }} className={inputClass} />
          </div>
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">{donated ? 'TOTAL MSRP' : 'TOTAL PRICE'}</label>
            <div className="relative">
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input type="text" inputMode="decimal" value={totalPrice} onChange={(e) => { if (isNumeric(e.target.value)) setTotalPrice(e.target.value) }} className={`${inputClass} pl-10`} />
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">{donated ? 'UNIT MSRP' : 'UNIT PRICE'}</span>
            <span className="text-lg font-bold text-gray-300">{formatUSD(unitPrice)}</span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-700 pt-2">
            <span className="text-gray-400 font-bold">{donated ? 'TOTAL MSRP' : 'TOTAL COST'}</span>
            <span className="text-xl font-bold">{formatUSD(total)}</span>
          </div>
          {donated && (
            <div className="flex justify-between items-center border-t border-gray-700 pt-2">
              <span className="text-gray-400 font-bold">OUR COST</span>
              <span className="text-xl font-bold text-orange-300">DONATED</span>
            </div>
          )}
        </div>

        {/* ONE date only (lei 18/ago, estendida aos INPUTS 19/ago): the day it was
            bought IS the day it was paid — payment_date mirrors this field. */}
        <DatePicker label="DATE" value={purchaseDate} onChange={setPurchaseDate} />

        {!donated && (
        <div>
          <label className="block mb-2 text-lg font-bold">RECEIPT</label>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-xl font-bold text-sm cursor-pointer">
              {uploading ? '...' : '📎 ADD FILES'}
              <input type="file" accept="image/*,.pdf" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadReceipts(e.target.files) }} />
            </label>
            {receiptUrls.length > 0 && (
              <div className="relative">
                <button onClick={() => setOpenReceipts(!openReceipts)} className="bg-purple-700 hover:bg-purple-600 px-3 py-2 rounded-xl font-bold text-sm">
                  RECEIPTS{receiptUrls.length > 1 ? ` (${receiptUrls.length})` : ''}
                </button>
                {openReceipts && (
                  <div className="absolute left-0 top-10 bg-gray-800 border border-gray-600 rounded-xl p-2 z-10 min-w-48 space-y-1">
                    {receiptUrls.map((url, ui) => (
                      <div key={ui} className="flex items-center gap-2">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm flex-1 truncate" title={`File ${ui + 1}`}>File {ui + 1}</a>
                        <button onClick={() => removeReceiptUrl(ui)} className="text-red-400 hover:text-red-300 text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}

        {/* UNIVERSAL PAYMENT BLOCK — payment date = purchase date when PAID */}
        {!donated && <PaymentFields value={payment} onChange={setPayment} hidePaidToggle />}

        <div>
          <label className="block mb-2 text-lg font-bold">NOTES</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Human notes only — tracking, payment and order data have their own fields." className={`${inputClass} resize-y`} />
        </div>

        <button onClick={saveInput} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE CHANGES</button>
        <a href={`${BASE_PATH}${category === 'STOCK' ? '/inventory' : '/supplies'}`} className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}