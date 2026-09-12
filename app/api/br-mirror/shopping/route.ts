import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'

// ── DOIS BANCOS NO MESMO ARQUIVO — E SÓ UM FOI RENOMEADO (onda 2, 11/set/2026) ─
// `us` é o banco do US; `br` é o banco do GZ28BR, que é OUTRO projeto Supabase e NÃO
// entra nesta onda. Os cinco renames (invoice_payments→invoice_incomes,
// invoice_parts→invoice_items, goods→assets, good_expenses→assets_expenses,
// expenses→staff_expenses) valeram SÓ no US. Portanto todo `br.from('invoice_payments')`
// e `br.from('invoice_parts')` daqui pra baixo continua com o nome VELHO de propósito:
// é o nome que existe no BR. Trocar por engano faria o espelho estourar em silêncio —
// e esta rota é a que cria a SHOPPING INVOICE do BR quando o GZ28BR pagou conta nossa.
// (`invoice_expenses`, `invoice_services` e `invoices` não mudam de nome em lugar nenhum.)
// O `us.from(...)` deste arquivo toca só em invoices, rides e invoice_expenses: nada a trocar.
//
// ── GZ28BR-paid US expenses  ->  a BR SHOPPING INVOICE (client BR.085) ─────────
// Lei do usuário (25/ago/2026): quando uma despesa de invoice de RIDE do GZ28US é
// marcada PAID FROM = GZ28BR, o GZ28BR pagou uma conta nossa — e isso tem que
// existir como SAÍDA no app brasileiro, senão o Flow dos dois apps nunca bate.
// Então, no save, o app US espelha essas linhas numa SHOPPING INVOICE do cliente
// BR.085 — "GZ28 V8 SpeedShop USA LLC" — no projeto BR:
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
//
// ── POR QUE ISTO MORA NO SERVIDOR (11/set/2026) ────────────────────────────
// Até aqui o espelho rodava no navegador, pelo cliente `supabaseBR` — que era anon
// puro: a rota da ponte (/api/br-bridge) respondia 503 porque BR_BRIDGE_EMAIL /
// BR_BRIDGE_PASSWORD nunca entraram na Vercel, e o RLS do BR devolvia [] mudo.
// Medido na auditoria de 11/set: o espelho não gravava nada; a busca do cliente
// BR.085 voltava vazia e o erro dizia "cliente não encontrado" (não era isso); e a
// guarda do dinheiro pago lia [] e respondia deleted:true sem apagar coisa nenhuma —
// depois do que a tela zerava o br_invoice_id e o elo se perdia.
// Decisão do dono: escrita entre projetos é no SERVIDOR, com a chave de serviço do
// BR. Sessão do BR nunca vai para o navegador.
//
// O NAVEGADOR SÓ DIZ QUAL INVOICE. A invoice, o carro, o elo br_invoice_id e as
// despesas PAID FROM GZ28BR são lidos AQUI, do banco do US com a chave de serviço:
// uma rota que segura a chave do BR não pode apagar a invoice que o navegador
// apontar. E as despesas chegam com o id de origem — o elo us_expense_id (04/set)
// recebe o que precisa para ATUALIZAR a linha do BR em vez de apagar e recriar
// (a tela nunca mandava srcId).
//
// TODA escrita confere o erro e devolve a causa. Nenhum sucesso calado.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */

const BR_CLIENT_NUMBER = 85          // GZ28 V8 SpeedShop USA LLC, no app BR
const SPREAD = 0.20                  // R$ sobre a comercial — o `usd_rate` do app BR
const MARGIN = 0                     // reembolso puro: o BR não vende, só adianta

// O TIPO DA FALHA viaja na resposta, para a tela dizer a causa real (sessão, chave,
// não encontrado, câmbio, banco) em vez de um "não encontrado" para tudo.
type Kind = 'auth' | 'service-key' | 'bad-request' | 'not-found' | 'conflict' | 'rate' | 'db'
const STATUS: Record<Kind, number> = { auth: 401, 'service-key': 503, 'bad-request': 400, 'not-found': 404, conflict: 409, rate: 422, db: 502 }
class Falha extends Error {
  kind: Kind
  constructor(kind: Kind, message: string) { super(message); this.kind = kind }
}
const responder = (kind: Kind, error: string) => NextResponse.json({ ok: false, kind, error }, { status: STATUS[kind] })

type Linha = {
  srcId: string
  item: string
  supplier: string | null
  usdPrice: number             // custo UNITÁRIO em US$
  usdTax: number               // tax TOTAL da linha em US$ (como o app soma)
  usdExtra: number             // frete/extra TOTAL da linha em US$
  quantity: number
  paymentDate: string | null   // YYYY-MM-DD — o dia em que o BR pagou
  orderNumber: string | null   // ORDER NUMBER é SAGRADO (29/ago/2026)
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
const r2 = (n: number) => Math.round(n * 100) / 100
const todayUTC = () => new Date().toISOString().slice(0, 10)
const num = (x: unknown) => parseFloat(String(x ?? '')) || 0

// Dólar comercial do dia + R$ 0,20. Busca a cotação HISTÓRICA daquele dia; se a
// data não vier (fim de semana, feriado, API fora), cai na cotação atual — e se
// nem isso, devolve 0 e o espelho aborta em vez de gravar um número inventado.
//
// O CACHE SÓ GUARDA DIA FECHADO (11/set/2026). No navegador o cache morria com a
// tela; no servidor ele vive enquanto a função estiver quente — horas. Guardar a
// cotação de HOJE congelaria o dólar da manhã para todo save do dia, e guardar o
// fallback da cotação atual para um dia PASSADO (histórico fora do ar por um
// instante) prenderia o dólar errado àquela data. Só entra no cache o fechamento
// histórico de um dia que já acabou.
const rateCache = new Map<string, number>()
async function rateFor(ymd: string | null): Promise<number> {
  const day = ymd && YMD.test(ymd) ? ymd : todayUTC()
  const hit = rateCache.get(day)
  if (hit != null) return hit
  let spot = 0
  let historico = false
  // Sábado, domingo e feriado não têm pregão: pede uma janela de 6 dias e usa a última
  // cotação ATÉ o dia do pagamento (nunca uma posterior).
  const back = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
  try {
    const from = back(day, 6).replace(/-/g, ''), to = day.replace(/-/g, '')
    const r = await fetch(`https://economia.awesomeapi.com.br/json/daily/USD-BRL/?start_date=${from}&end_date=${to}`, { cache: 'no-store' })
    const j = await r.json()
    const rows = (Array.isArray(j) ? j : [])
      .map((x: any) => ({ d: new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10), bid: parseFloat(x.bid) || 0 }))
      .filter((x: any) => x.d <= day && x.bid > 0)
      .sort((a: any, b: any) => b.d.localeCompare(a.d))
    spot = rows[0]?.bid || 0
    historico = spot > 0
  } catch { /* sem histórico */ }
  if (!spot) {
    try {
      const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { cache: 'no-store' })
      const j = await r.json()
      spot = parseFloat(j?.USDBRL?.bid) || 0
    } catch { /* sem cotação */ }
  }
  const rate = spot > 0 ? r2(spot + SPREAD) : 0
  if (rate > 0 && historico && day < todayUTC()) rateCache.set(day, rate)
  return rate
}

// A invoice do US como o BANCO a conhece — nunca como o navegador disse que é.
async function lerInvoiceUS(us: SupabaseClient, usInvoiceId: string) {
  const { data: inv, error } = await us.from('invoices').select('id, invoice_code, service, is_quote, ride_id, br_invoice_id').eq('id', usInvoiceId).maybeSingle()
  if (error) throw new Falha('db', 'Falha ao ler a invoice no banco do US: ' + error.message)
  if (!inv) throw new Falha('not-found', `Invoice ${usInvoiceId} não existe no banco do US.`)
  // Quote ainda não é dinheiro de ninguém — a tela nem chama para quote; se o banco
  // disser quote, a tela e o banco discordam e nada é escrito.
  if (inv.is_quote) throw new Falha('conflict', 'No banco do US esta invoice ainda é QUOTE — quote não tem espelho no BR.')

  let rideName = ''
  if (inv.ride_id) {
    const { data: ride, error: eRide } = await us.from('rides').select('project_code, project_name').eq('id', inv.ride_id).maybeSingle()
    if (eRide) throw new Falha('db', 'Falha ao ler o carro da invoice no banco do US: ' + eRide.message)
    if (ride) rideName = (ride.project_code || '') + (ride.project_name ? ` — ${ride.project_name}` : '')
  }

  const { data: exps, error: eExp } = await us.from('invoice_expenses')
    .select('id, item, supplier, price, tax, extra, quantity, payment_date, order_number, paid_from, source, position, created_at')
    .eq('invoice_id', usInvoiceId)
  if (eExp) throw new Falha('db', 'Falha ao ler as despesas da invoice no banco do US: ' + eExp.message)
  // A MESMA ORDEM DA TELA: `position` manda, e o created_at desempata.
  const ordered = (exps || []).slice().sort((a: any, b: any) => {
    const pa = a.position == null ? Infinity : Number(a.position)
    const pb = b.position == null ? Infinity : Number(b.position)
    if (pa !== pb) return pa - pb
    return String(a.created_at).localeCompare(String(b.created_at))
  })
  // A MESMA REGRA DA TELA: quem pagou é PAID FROM, e a linha legada cai no `source`.
  const items: Linha[] = ordered
    .filter((e: any) => (e.paid_from || e.source || '') === 'GZ28BR')
    .map((e: any) => ({
      srcId: String(e.id),
      item: e.item,
      supplier: e.supplier || null,
      usdPrice: num(e.price),
      usdTax: num(e.tax),
      usdExtra: num(e.extra),
      quantity: parseFloat(String(e.quantity || 1)) || 1,
      paymentDate: YMD.test(String(e.payment_date || '')) ? String(e.payment_date) : null,
      orderNumber: String(e.order_number || '').trim() || null,
    }))

  return {
    usInvoiceCode: String(inv.invoice_code || ''),
    usService: String(inv.service || ''),
    rideName,
    existingBrInvoiceId: inv.br_invoice_id ? String(inv.br_invoice_id) : null,
    items,
  }
}

async function cliente085(br: SupabaseClient): Promise<string> {
  const { data, error } = await br.from('clients').select('id').eq('client_number', BR_CLIENT_NUMBER).eq('is_quote', false).limit(1)
  if (error) throw new Falha('db', 'Falha ao ler o cliente BR.085 no banco do BR: ' + error.message)
  const id = data?.[0]?.id
  if (!id) throw new Falha('not-found', 'Cliente BR.085 (GZ28 V8 SpeedShop USA LLC) não existe no banco do BR — lido com a chave de serviço, então não é RLS escondendo.')
  return String(id)
}

// Nunca destruir uma conta já acertada: se o GZ28US já pagou algo desta shopping
// invoice, ela fica (o dinheiro se moveu — só o app BR pode desfazer isso).
// Leitura que FALHA não é "nada pago": o erro sobe e nada é apagado.
async function temDinheiroPago(br: SupabaseClient, id: string): Promise<boolean> {
  // BANCO DO BR: lá a tabela ainda se chama invoice_payments (o rename foi só no US).
  const { data, error } = await br.from('invoice_payments').select('id').eq('invoice_id', id).not('paid_at', 'is', null).limit(1)
  if (error) throw new Falha('db', 'Falha ao conferir se o GZ28US já pagou a shopping invoice do BR: ' + error.message)
  return !!data?.length
}

// `apagada` só é true quando a invoice do BR NÃO ESTÁ MAIS LÁ — conferido depois do
// DELETE. Invoice que já não existia também conta como apagada (o elo é que era velho).
async function apagarShoppingBR(br: SupabaseClient, id: string, clientId: string): Promise<{ apagada: boolean; code: string | null }> {
  const { data: ex, error } = await br.from('invoices').select('id, invoice_code, client_id').eq('id', id).maybeSingle()
  if (error) throw new Falha('db', 'Falha ao ler a shopping invoice do BR: ' + error.message)
  if (!ex) return { apagada: true, code: null }
  const nome = ex.invoice_code || id
  if (String(ex.client_id) !== clientId) {
    throw new Falha('conflict', `O elo br_invoice_id aponta para a invoice ${nome} do BR, que NÃO é do cliente BR.085 — nada foi apagado.`)
  }
  if (await temDinheiroPago(br, id)) return { apagada: false, code: ex.invoice_code || null }
  // BANCO DO BR: nomes do esquema BRASILEIRO — invoice_payments e invoice_parts seguem
  // vivos lá. O rename de 11/set foi só no US.
  for (const t of ['invoice_payments', 'invoice_parts', 'invoice_services', 'invoice_expenses']) {
    const { error: e } = await br.from(t).delete().eq('invoice_id', id)
    if (e) throw new Falha('db', `Falha ao apagar ${t} da shopping invoice ${nome} do BR: ${e.message}`)
  }
  const { error: eDel } = await br.from('invoices').delete().eq('id', id)
  if (eDel) throw new Falha('db', `Falha ao apagar a shopping invoice ${nome} do BR: ${eDel.message}`)
  const { data: ainda, error: eChk } = await br.from('invoices').select('id').eq('id', id).maybeSingle()
  if (eChk) throw new Falha('db', `Falha ao conferir se a shopping invoice ${nome} saiu do BR: ${eChk.message}`)
  if (ainda) throw new Falha('db', `A shopping invoice ${nome} continua no BR depois do DELETE — não foi dada como apagada.`)
  return { apagada: true, code: ex.invoice_code || null }
}

async function gravarElo(us: SupabaseClient, usInvoiceId: string, brInvoiceId: string | null, contexto: string) {
  const { error } = await us.from('invoices').update({ br_invoice_id: brInvoiceId }).eq('id', usInvoiceId)
  if (error) throw new Falha('db', `${contexto}, mas o elo br_invoice_id da invoice do US não foi gravado: ${error.message}`)
}

async function espelhar(us: SupabaseClient, br: SupabaseClient, usInvoiceId: string) {
  const { usInvoiceCode, rideName, usService, existingBrInvoiceId, items } = await lerInvoiceUS(us, usInvoiceId)

  if (!items.length && !existingBrInvoiceId) {
    return { brInvoiceId: null, code: null, totalBrl: 0, totalUsd: 0, deleted: false }
  }

  // Cliente BR.085 — GZ28 V8 SpeedShop USA LLC. Lido também no caminho de apagar:
  // a chave de serviço não perdoa, então só se apaga invoice que é mesmo da 085.
  const clientId = await cliente085(br)

  if (!items.length) {
    const r = await apagarShoppingBR(br, existingBrInvoiceId!, clientId)
    if (!r.apagada) {
      // Ficou por causa de dinheiro já pago: o elo continua de pé.
      return { brInvoiceId: existingBrInvoiceId, code: r.code, totalBrl: 0, totalUsd: 0, deleted: false, keptPaid: true }
    }
    await gravarElo(us, usInvoiceId, null, `A shopping invoice ${r.code || existingBrInvoiceId} saiu do BR`)
    return { brInvoiceId: null, code: null, totalBrl: 0, totalUsd: 0, deleted: true }
  }

  // Câmbio de cada dia ANTES de gravar: se faltar cotação, nada é escrito.
  const rates = new Map<string, number>()
  for (const it of items) {
    const day = it.paymentDate || todayUTC()
    if (!rates.has(day)) {
      const rate = await rateFor(day)
      if (!(rate > 0)) throw new Falha('rate', `Sem cotação do dólar para ${day} — a shopping invoice do BR não foi gravada.`)
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
  let brInvoiceId = ''
  let code = ''
  if (existingBrInvoiceId) {
    const { data: ex, error: eEx } = await br.from('invoices').select('id, invoice_code, client_id').eq('id', existingBrInvoiceId).maybeSingle()
    if (eEx) throw new Falha('db', 'Falha ao ler a shopping invoice do BR: ' + eEx.message)
    if (ex) {
      if (String(ex.client_id) !== clientId) {
        throw new Falha('conflict', `O elo br_invoice_id aponta para a invoice ${ex.invoice_code || existingBrInvoiceId} do BR, que NÃO é do cliente BR.085 — nada foi escrito.`)
      }
      brInvoiceId = String(ex.id); code = ex.invoice_code
      // Só o pendente é refeito — um pagamento que o GZ28US já fez é dinheiro real.
      // BANCO DO BR (nome velho de propósito: o BR não foi renomeado).
      const e1 = (await br.from('invoice_payments').delete().eq('invoice_id', brInvoiceId).is('paid_at', null)).error
      if (e1) throw new Falha('db', 'Falha ao limpar o saldo pendente no BR: ' + e1.message)
      // BANCO DO BR (nome velho de propósito: o BR não foi renomeado).
      const e2 = (await br.from('invoice_parts').delete().eq('invoice_id', brInvoiceId)).error
      if (e2) throw new Falha('db', 'Falha ao limpar os itens no BR: ' + e2.message)
      const e3 = (await br.from('invoice_services').delete().eq('invoice_id', brInvoiceId)).error
      if (e3) throw new Falha('db', 'Falha ao limpar os serviços no BR: ' + e3.message)
      // invoice_expenses NÃO é mais apagada aqui: ela é reconciliada lá embaixo,
      // linha a linha, pelo elo us_expense_id. parts e services continuam sendo
      // refeitos porque são a fatura do cliente — ninguém digita fato neles.
      const e4 = (await br.from('invoices').update(invMeta).eq('id', brInvoiceId)).error
      if (e4) throw new Falha('db', 'Falha ao atualizar a shopping invoice do BR: ' + e4.message)
    }
  }
  if (!brInvoiceId) {
    const { data: codes, error: eCodes } = await br.from('invoices').select('invoice_code').eq('client_id', clientId)
    if (eCodes) throw new Falha('db', 'Falha ao ler a numeração das invoices do cliente BR.085: ' + eCodes.message)
    let maxSeq = 0
    for (const r of codes || []) { const m = String(r.invoice_code || '').match(/\.(\d+)$/); if (m) maxSeq = Math.max(maxSeq, parseInt(m[1])) }
    code = `085.${maxSeq + 1}`
    const { data: ins, error } = await br.from('invoices').insert([{
      invoice_code: code, client_id: clientId, ride_id: null, is_quote: false,
      live_status: 'REALTIME', feed_status: 'REAL_TIME', global_discount: null, ...invMeta,
    }]).select('id').single()
    if (error || !ins) throw new Falha('db', 'Falha ao criar a shopping invoice do BR: ' + (error?.message || 'sem linha'))
    brInvoiceId = String(ins.id)
    // O ELO NASCE JUNTO: se algo abaixo falhar, o próximo save reaproveita esta
    // 085.N em vez de criar outra.
    await gravarElo(us, usInvoiceId, brInvoiceId, `A shopping invoice ${code} foi criada no BR`)
  }

  // Filhos: a saída (expenses), o que o US deve (items a custo puro) e o pendente.
  let totalBrl = 0, totalUsd = 0
  let latestPaid: string | null = null
  // AUTO-BOOK fase B: o marcador «(atribuída · Bank Link)» é trilha do app US —
  // nunca viaja pro Brasil (o item do BR é o nome limpo).
  const clean = (t: string | null | undefined) => String(t || '').replace(/\s*\((atribuída|a atribuir) · Bank Link\)/g, '').trim()
  const expRows: any[] = [], partRows: any[] = []
  items.forEach((it, i) => {
    const day = it.paymentDate || todayUTC()
    const rate = rates.get(day) || 0
    const qty = it.quantity || 1
    // A LINHA é a verdade: preço unitário × qtd + tax + extra (tax/extra são totais).
    const priceBrl = r2(it.usdPrice * rate)
    const taxBrl = r2(it.usdTax * rate)
    const extraBrl = r2(it.usdExtra * rate)
    const lineBrl = r2(priceBrl * qty + taxBrl + extraBrl)        // a saída de caixa desta linha
    const lineUsd = r2(it.usdPrice * qty + it.usdTax + it.usdExtra)
    totalBrl = r2(totalBrl + lineBrl)
    totalUsd = r2(totalUsd + lineUsd)
    if (it.paymentDate && (!latestPaid || it.paymentDate > latestPaid)) latestPaid = it.paymentDate
    expRows.push({
      invoice_id: brInvoiceId, item: clean(it.item), supplier: it.supplier || null,
      price: priceBrl, amount_usd: r2(it.usdPrice),
      quantity: qty, tax: taxBrl, extra: extraBrl,
      payment_date: it.paymentDate || null, expense_date: it.paymentDate || null,
      // Quem pagou foi o GZ28BR — é a saída de caixa dele.
      source: 'GZ28BR', paid_from: 'GZ28BR', item_discount: 0, position: i,
      // O pedido acompanha o espelho: sem ele a linha do BR ficaria órfã do STREAM.
      order_number: it.orderNumber,
      us_expense_id: it.srcId || null,
    })
    // O ITEM cobra exatamente o que a linha custou: preço unitário = total ÷ qtd, e o
    // último item absorve o centavo do arredondamento para o total fechar no ponto.
    partRows.push({
      invoice_id: brInvoiceId, description: clean(it.item),
      unit_price: r2(lineBrl / qty), base_cost: r2(lineBrl / qty), unit_price_usd: r2(lineUsd / qty),
      quantity: qty, payment_date: it.paymentDate || null, position: i,
    })
  })
  // Ajuste de centavo: o somatório dos itens tem que dar o mesmo que a saída de caixa.
  const partsSum = r2(partRows.reduce((s, p) => s + p.unit_price * p.quantity, 0))
  const drift = r2(totalBrl - partsSum)
  if (Math.abs(drift) >= 0.005 && partRows.length) {
    const last = partRows[partRows.length - 1]
    last.unit_price = r2(last.unit_price + drift / (last.quantity || 1))
    last.base_cost = last.unit_price
  }

  // ── RECONCILIAÇÃO: ATUALIZA A LINHA QUE JÁ EXISTE, NÃO APAGA E RECRIA ─────
  // A linha do espelho é a MESMA compra da linha de origem. Recriá-la zerava
  // tudo que o outro lado escreveu — e o id mudava junto, deixando data_fixes e
  // part_stream_items apontando para linha que não existe mais.
  // GUARDA: enquanto a coluna do elo não existir (a migration roda à mão), cai
  // no comportamento antigo — apaga e recria. Sem a guarda, o reconciliador não
  // acharia elo nenhum e DUPLICARIA cada linha.
  const eloSel = await br.from('invoice_expenses').select('id, us_expense_id').eq('invoice_id', brInvoiceId)
  const semElo = eloSel.error?.code === '42703'
  if (semElo) {
    console.warn('[espelho] us_expense_id ainda não existe — rode MIGRATION_mirror_line_link.sql. Enquanto isso o fato digitado do lado espelho continua sendo perdido a cada save.')
    const eLimpa = (await br.from('invoice_expenses').delete().eq('invoice_id', brInvoiceId)).error
    if (eLimpa) throw new Falha('db', 'Falha ao limpar as despesas do BR: ' + eLimpa.message)
    for (const r of expRows) delete r.us_expense_id
  } else if (eloSel.error) {
    throw new Falha('db', 'Falha ao ler as despesas do BR: ' + eloSel.error.message)
  }
  const antes = semElo ? [] : (eloSel.data || [])
  const porOrigem = new Map<string, string>()
  for (const p of antes) if ((p as any).us_expense_id) porOrigem.set(String((p as any).us_expense_id), String((p as any).id))
  const mantidas = new Set<string>()

  for (const row of expRows) {
    const vindaDe = row.us_expense_id ? porOrigem.get(String(row.us_expense_id)) : null
    if (vindaDe) {
      mantidas.add(vindaDe)
      // UPDATE: só os campos que o espelho POSSUI. Rastreio, recibo,
      // part_number, picked_up, cancel_status, nature e o escudo
      // receipt_proves_payment ficam onde estão.
      const eU = (await br.from('invoice_expenses').update(row).eq('id', vindaDe)).error
      if (eU) throw new Falha('db', 'Falha ao atualizar a despesa no BR: ' + eU.message)
    } else {
      const r1 = await br.from('invoice_expenses').insert([row]).select('id').single()
      if (r1.error || !r1.data) throw new Falha('db', 'Falha ao gravar a despesa no BR: ' + (r1.error?.message || 'sem linha'))
      mantidas.add(String(r1.data.id))
    }
  }
  // Some só o que a origem não manda mais — nunca o que alguém escreveu aqui.
  const sobrando = antes.map((p: any) => String(p.id)).filter((id: string) => !mantidas.has(id))
  if (sobrando.length) {
    const eD = (await br.from('invoice_expenses').delete().in('id', sobrando)).error
    if (eD) throw new Falha('db', 'Falha ao remover despesa antiga no BR: ' + eD.message)
  }
  // BANCO DO BR (nome velho de propósito: o BR não foi renomeado).
  const e5 = (await br.from('invoice_parts').insert(partRows)).error
  if (e5) throw new Falha('db', 'Falha ao gravar os itens no BR: ' + e5.message)

  // Só o que ainda não foi acertado vira pendência (o que o US já pagou sobreviveu).
  // BANCO DO BR (nome velho de propósito: o BR não foi renomeado).
  const { data: settled, error: eSettled } = await br.from('invoice_payments').select('amount').eq('invoice_id', brInvoiceId)
  if (eSettled) throw new Falha('db', 'Falha ao ler os pagamentos da shopping invoice do BR: ' + eSettled.message)
  const alreadyPaid = (settled || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
  const owed = r2(totalBrl - alreadyPaid)
  if (owed > 0.005) {
    // BANCO DO BR (nome velho de propósito: o BR não foi renomeado).
    const e6 = (await br.from('invoice_payments').insert([{
      invoice_id: brInvoiceId, amount: owed, paid_at: null, payment_date: latestPaid || todayUTC(),
      source: null, description: 'Pending balance', paid_from: 'GZ28US', paid_to: 'GZ28BR',
    }])).error
    if (e6) throw new Falha('db', 'Falha ao gravar o saldo pendente no BR: ' + e6.message)
  }

  return { brInvoiceId, code, totalBrl, totalUsd, deleted: false }
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return responder('auth', 'Sessão do app ausente ou vencida — entre de novo e salve outra vez.')
  const br = supabaseBRService()
  if (!br) return responder('service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o espelho no BR não pode ser gravado.')
  const usUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const usKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!usUrl || !usKey) return responder('service-key', 'SUPABASE_SERVICE_ROLE_KEY não está no ambiente do servidor do US — a invoice do US não pode ser lida.')
  const us = createClient(usUrl, usKey, { auth: { persistSession: false } })

  const b = await req.json().catch(() => ({}))
  const usInvoiceId = String(b?.usInvoiceId || '').trim()
  if (!usInvoiceId) return responder('bad-request', 'usInvoiceId obrigatório.')

  try {
    const r = await espelhar(us, br, usInvoiceId)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    if (e instanceof Falha) return responder(e.kind, e.message)
    return responder('db', e instanceof Error ? e.message : String(e))
  }
}
