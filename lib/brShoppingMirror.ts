import { supabaseBR, ensureBRBridgeSession } from '@/lib/supabaseBR'

// ── GZ28BR-paid US expenses  ->  a BR SHOPPING INVOICE (client BR.085) ─────────
// Lei do usuário (25/ago/2026): quando uma despesa de invoice de RIDE do GZ28US é
// marcada PAID FROM = GZ28BR, o GZ28BR pagou uma conta nossa — e isso tem que
// existir como SAÍDA no app brasileiro, senão o Flow dos dois apps nunca bate.
// Então, no save, o app US espelha essas linhas numa SHOPPING INVOICE do cliente
// BR.085 — "GZ28 V8 SpeedShop USA LLC" — no projeto BR (via supabaseBR):
//   • EXPENSES = as linhas que o BR pagou (a saída de caixa, em R$ + o US$ original)
//   • ITEMS    = as mesmas linhas a CUSTO PURO (0% de margem — é reembolso, não venda)
//   • INCOME   = um PENDING BALANCE do total: o que o GZ28US ainda deve ao BR
// É o espelho exato do caminho inverso (lib/usShoppingMirror.ts no app BR, que
// cria a US.006.N quando o GZ28US paga peça de carro brasileiro).
//
// Uma shopping invoice BR por invoice do US (amarradas por invoices.br_invoice_id);
// re-salvar re-sincroniza, e tirar todas as linhas GZ28BR apaga o espelho.
//
// MOEDA (decisão do usuário 25/ago/2026): cada linha converte pelo dólar COMERCIAL
// DO DIA EM QUE FOI PAGA + R$ 0,20 — a mesma taxa que o app BR usa nas compras em
// dólar. O valor em US$ vai junto em amount_usd, então nada se perde.

const BR_CLIENT_NUMBER = 85          // GZ28 V8 SpeedShop USA LLC, no app BR
const SPREAD = 0.20                  // R$ sobre a comercial — o `usd_rate` do app BR
const MARGIN = 0                     // reembolso puro: o BR não vende, só adianta

export type BrMirrorItem = {
  item: string
  supplier: string | null
  usdPrice: number             // custo unitário em US$
  usdTax: number               // tax por unidade
  usdExtra: number             // frete/extra por unidade
  quantity: number
  paymentDate: string | null   // YYYY-MM-DD — o dia em que o BR pagou
}

export type BrMirrorInput = {
  usInvoiceCode: string
  rideName: string             // "<project_code> — <project_name>"
  usService: string
  existingBrInvoiceId: string | null
  items: BrMirrorItem[]
}

export type BrMirrorResult = { brInvoiceId: string | null; code: string | null; totalBrl: number; totalUsd: number; deleted: boolean }

const r2 = (n: number) => Math.round(n * 100) / 100
const todayUTC = () => new Date().toISOString().slice(0, 10)

// Dólar comercial do dia + R$ 0,20. Busca a cotação HISTÓRICA daquele dia; se a
// data não vier (fim de semana, feriado, API fora), cai na cotação atual — e se
// nem isso, devolve 0 e o espelho aborta em vez de gravar um número inventado.
const rateCache = new Map<string, number>()
async function rateFor(ymd: string | null): Promise<number> {
  const day = ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : todayUTC()
  const hit = rateCache.get(day)
  if (hit != null) return hit
  let spot = 0
  const ymdCompact = day.replace(/-/g, '')
  try {
    const r = await fetch(`https://economia.awesomeapi.com.br/json/daily/USD-BRL/?start_date=${ymdCompact}&end_date=${ymdCompact}`)
    const j = await r.json()
    spot = parseFloat(Array.isArray(j) ? j[0]?.bid : j?.bid) || 0
  } catch { /* sem histórico */ }
  if (!spot) {
    try {
      const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL')
      const j = await r.json()
      spot = parseFloat(j?.USDBRL?.bid) || 0
    } catch { /* sem cotação */ }
  }
  const rate = spot > 0 ? r2(spot + SPREAD) : 0
  if (rate > 0) rateCache.set(day, rate)
  return rate
}

// Nunca destruir uma conta já acertada: se o GZ28US já pagou algo desta shopping
// invoice, ela fica (o dinheiro se moveu — só o app BR pode desfazer isso).
async function brInvoiceHasPaidMoney(id: string): Promise<boolean> {
  const { data } = await supabaseBR.from('invoice_payments').select('id').eq('invoice_id', id).not('paid_at', 'is', null).limit(1)
  return !!data?.length
}

async function deleteBrInvoice(id: string) {
  if (await brInvoiceHasPaidMoney(id)) return
  await supabaseBR.from('invoice_payments').delete().eq('invoice_id', id)
  await supabaseBR.from('invoice_parts').delete().eq('invoice_id', id)
  await supabaseBR.from('invoice_services').delete().eq('invoice_id', id)
  await supabaseBR.from('invoice_expenses').delete().eq('invoice_id', id)
  await supabaseBR.from('invoices').delete().eq('id', id)
}

export async function mirrorBrShoppingInvoice(input: BrMirrorInput): Promise<BrMirrorResult> {
  const { usInvoiceCode, rideName, usService, existingBrInvoiceId, items } = input
  await ensureBRBridgeSession()

  if (!items.length) {
    if (existingBrInvoiceId) await deleteBrInvoice(existingBrInvoiceId)
    return { brInvoiceId: null, code: null, totalBrl: 0, totalUsd: 0, deleted: !!existingBrInvoiceId }
  }

  // Cliente BR.085 — GZ28 V8 SpeedShop USA LLC.
  const { data: clientRows } = await supabaseBR.from('clients').select('id').eq('client_number', BR_CLIENT_NUMBER).eq('is_quote', false).limit(1)
  const clientId = clientRows?.[0]?.id
  if (!clientId) throw new Error('Cliente BR.085 (GZ28 V8 SpeedShop USA LLC) não encontrado no app BR')

  // Câmbio de cada dia ANTES de gravar: se faltar cotação, nada é escrito.
  const rates = new Map<string, number>()
  for (const it of items) {
    const day = it.paymentDate || todayUTC()
    if (!rates.has(day)) {
      const rate = await rateFor(day)
      if (!(rate > 0)) throw new Error(`Sem cotação do dólar para ${day} — a shopping invoice do BR não foi gravada.`)
      rates.set(day, rate)
    }
  }

  const service = `GZ28US Invoice ${usInvoiceCode}.${rideName ? ` ${rideName}` : ''}${usService ? ` - ${usService}` : ''}`
  const lastRate = rates.get(items[items.length - 1].paymentDate || todayUTC()) || 0
  const invMeta = {
    service,
    florida_taxes: 0,
    import_margin: MARGIN * 100,
    usd_rate: lastRate || null,
    updated_at: new Date().toISOString(),
  }

  // Reaproveita a shopping invoice existente (limpando os filhos) ou cria a próxima 085.N.
  let brInvoiceId: string | null = null
  let code = ''
  if (existingBrInvoiceId) {
    const { data: ex } = await supabaseBR.from('invoices').select('id, invoice_code').eq('id', existingBrInvoiceId).maybeSingle()
    if (ex) {
      brInvoiceId = ex.id; code = ex.invoice_code
      // Só o pendente é refeito — um pagamento que o GZ28US já fez é dinheiro real.
      await supabaseBR.from('invoice_payments').delete().eq('invoice_id', brInvoiceId).is('paid_at', null)
      await supabaseBR.from('invoice_parts').delete().eq('invoice_id', brInvoiceId)
      await supabaseBR.from('invoice_services').delete().eq('invoice_id', brInvoiceId)
      await supabaseBR.from('invoice_expenses').delete().eq('invoice_id', brInvoiceId)
      await supabaseBR.from('invoices').update(invMeta).eq('id', brInvoiceId)
    }
  }
  if (!brInvoiceId) {
    const { data: codes } = await supabaseBR.from('invoices').select('invoice_code').eq('client_id', clientId)
    let maxSeq = 0
    for (const r of codes || []) { const m = String(r.invoice_code || '').match(/\.(\d+)$/); if (m) maxSeq = Math.max(maxSeq, parseInt(m[1])) }
    code = `085.${maxSeq + 1}`
    const { data: ins, error } = await supabaseBR.from('invoices').insert([{
      invoice_code: code, client_id: clientId, ride_id: null, is_quote: false,
      live_status: 'REALTIME', feed_status: 'REAL_TIME', global_discount: null, ...invMeta,
    }]).select('id').single()
    if (error || !ins) throw new Error('Falha ao criar a shopping invoice do BR: ' + (error?.message || 'sem linha'))
    brInvoiceId = ins.id
  }

  // Filhos: a saída (expenses), o que o US deve (items a custo puro) e o pendente.
  let totalBrl = 0, totalUsd = 0
  let latestPaid: string | null = null
  const expRows: any[] = [], partRows: any[] = []
  items.forEach((it, i) => {
    const day = it.paymentDate || todayUTC()
    const rate = rates.get(day) || 0
    const landedUsd = r2(it.usdPrice + it.usdTax + it.usdExtra)   // custo unitário US$
    const landedBrl = r2(landedUsd * rate)                        // custo unitário R$ do dia
    totalBrl += landedBrl * it.quantity
    totalUsd += landedUsd * it.quantity
    if (it.paymentDate && (!latestPaid || it.paymentDate > latestPaid)) latestPaid = it.paymentDate
    expRows.push({
      invoice_id: brInvoiceId, item: it.item, supplier: it.supplier || null,
      price: r2(it.usdPrice * rate), amount_usd: r2(it.usdPrice),
      quantity: it.quantity, tax: r2(it.usdTax * rate), extra: r2(it.usdExtra * rate),
      payment_date: it.paymentDate || null, expense_date: it.paymentDate || null,
      // Quem pagou foi o GZ28BR — é a saída de caixa dele.
      source: 'GZ28BR', paid_from: 'GZ28BR', item_discount: 0, position: i,
    })
    partRows.push({
      invoice_id: brInvoiceId, description: it.item,
      unit_price: landedBrl, base_cost: landedBrl, unit_price_usd: landedUsd,
      quantity: it.quantity, payment_date: it.paymentDate || null, position: i,
    })
  })
  totalBrl = r2(totalBrl)
  totalUsd = r2(totalUsd)

  if (expRows.length) {
    const e1 = (await supabaseBR.from('invoice_expenses').insert(expRows)).error
    if (e1) throw new Error('Falha ao gravar as despesas no BR: ' + e1.message)
    const e2 = (await supabaseBR.from('invoice_parts').insert(partRows)).error
    if (e2) throw new Error('Falha ao gravar os itens no BR: ' + e2.message)
  }

  // Só o que ainda não foi acertado vira pendência (o que o US já pagou sobreviveu).
  const { data: settled } = await supabaseBR.from('invoice_payments').select('amount').eq('invoice_id', brInvoiceId)
  const alreadyPaid = (settled || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
  const owed = r2(totalBrl - alreadyPaid)
  if (owed > 0.005) {
    const e3 = (await supabaseBR.from('invoice_payments').insert([{
      invoice_id: brInvoiceId, amount: owed, paid_at: null, payment_date: latestPaid || todayUTC(),
      source: null, description: 'Pending balance', paid_from: 'GZ28US', paid_to: 'GZ28BR',
    }])).error
    if (e3) throw new Error('Falha ao gravar o saldo pendente no BR: ' + e3.message)
  }

  return { brInvoiceId, code, totalBrl, totalUsd, deleted: false }
}
