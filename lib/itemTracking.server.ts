// SERVER-ONLY — O RASTREADOR DOS ITENS.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 29/ago/2026) ───────────────────────
//   "a leitura do rastreio agora deve viver na pagina do item, ESQUECA A AREA
//    DE STREAM, e tudo na pagina de origem do item. Tem rastreio, o app deve
//    rastrear e atualizar o badge do item na pagina dele, na origem, pra
//    delivered, quando for entregue."
//   "esqueca o stream, refaremos ele do zero depois. NAO USE NADA DO STREAM,
//    nada."
//
// Por isso NÃO se importa nada de lib/stream.server.ts aqui — nem o cliente do
// 17TRACK, que lá vem grudado na maquinaria do quadro (part_streams, WhatsApp,
// where_label). O cliente abaixo é uma cópia mínima: register + gettrackinfo,
// com a MESMA chave que o app já usa (TRACK17_API_KEY). Quando o STREAM for
// refeito do zero, este arquivo continua de pé sozinho.
//
// O que ele faz, em uma frase: pega toda LINHA DE ITEM COMPRADO que tem
// tracking_number e ainda não chegou, pergunta à transportadora, e escreve a
// resposta NA PRÓPRIA LINHA — nas 6 tabelas de item comprado.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { EXPENSE_ITEM_GATE } from './deliverStatus'

// As 6 tabelas de item comprado. As 5 primeiras ganharam as colunas de rastreio
// na migration de 29/ago/2026. A 6ª, expenses, entrou por lei do dono
// (Márcio, 03/set/2026): "compra pessoal esta no lugar certo (expenses,
// origin='PERSONAL'), mas TEM que estar no STREAM tambem, e tem que ter
// rastreio" — a migration de 03/set deu a expenses as MESMAS colunas, com os
// mesmos nomes e tipos. Nenhuma outra tabela tem, e não se cria mais nenhuma.
//
// ATENÇÃO com expenses: a tabela é, na maior parte, FOLHA (WEEKLY/MONTHLY/DAILY,
// Zelle, mensal). Uma linha dela só é ITEM quando tem order_number OU
// tracking_number — é EXPENSE_ITEM_GATE, aplicado NA QUERY por todo consumidor
// de ITEM_TABLES (este robô, mailToItem, o STREAM), nunca só em JS depois. O
// predicado mora em lib/deliverStatus.ts (módulo puro) para o STREAM, que roda
// no browser, usar o mesmo sem importar este arquivo server-only.
export const ITEM_TABLES = ['invoice_expenses', 'inputs', 'inventory', 'goods', 'good_expenses', 'expenses'] as const
export type ItemTable = (typeof ITEM_TABLES)[number]
export { EXPENSE_ITEM_GATE }

export function itemsDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  )
}

// ── Cliente 17TRACK (mínimo, próprio) ───────────────────────────────────────
const T17 = 'https://api.17track.net/track/v2.2'
const t17Key = () => process.env.TRACK17_API_KEY || ''

// Última resposta crua — diagnóstico, para o erro nunca morrer em silêncio.
let t17Last: { path: string; httpStatus: number; body: unknown } | null = null

async function t17(path: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${T17}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '17token': t17Key() },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => null)
    t17Last = { path, httpStatus: r.status, body: j }
    if (j?.code !== 0) console.error('[items/track]', path, r.status, JSON.stringify(j).slice(0, 400))
    return j
  } catch (e) {
    t17Last = { path, httpStatus: 0, body: String(e) }
    console.error('[items/track]', path, e)
    return null
  }
}

// O auto-detect do 17TRACK falha na maioria dos nossos números, então o carrier
// vai SEMPRE explícito quando dá para saber qual é. A chave do mapa é regex: o
// nome gravado em carrier casa por substring, e o formato do próprio número
// resolve quando o campo está vazio.
const T17_CARRIER: Record<string, number> = {
  FedEx: 100003, UPS: 100002, USPS: 21051, DHL: 100001,
  GOFO: 100996, SwiftX: 101228, SpeedX: 190844, OnTrac: 100049,
  Estes: 100221, Roadrunner: 100253, LaserShip: 100052,
  UniUni: 100134, 'Jitsu|AxleHire': 100272, Pandion: 100743, Amazon: 100308,
}

// Adivinha a transportadora pelo FORMATO do número quando ninguém a digitou.
export function guessCarrierFromNumber(tracking: string): string {
  const t = String(tracking || '').trim().toUpperCase()
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS'
  if (/^\d{12}$|^\d{15}$|^\d{20}$/.test(t)) return 'FedEx'
  if (/^(94|92|93|95|82)\d{18,20}$/.test(t)) return 'USPS'
  if (/^\d{10}$/.test(t)) return 'DHL'
  return ''
}

function carrierCode(tracking: string, carrier?: string | null): number | undefined {
  const name = String(carrier || '') || guessCarrierFromNumber(tracking)
  for (const [k, v] of Object.entries(T17_CARRIER)) if (new RegExp(k, 'i').test(name)) return v
  return undefined
}

// ── O RASTREADOR NÃO ESCREVE STATUS. ESCREVE FATOS. ─────────────────────────
// Lei do dono, 30/ago/2026: "Assim a chance do app mostrar o status errado e
// zero." Antes esta função gravava DOIS campos por entrega — deliver_status E
// delivered_at — e podia MENTIR se falhasse no segundo. Agora grava UM
// (delivered_at) e o badge acompanha sozinho, porque o badge é derivado.
//
// A REGRA DE NUNCA DESFAZER UMA ENTREGA continua, e ficou mais forte: a consulta
// nem traz linha com delivered_at preenchido, então não há caminho de código que
// apague uma entrega já registrada.
//
// PICKUP fica FORA de propósito: picked_up quer dizer "peguei na loja, não
// viaja". A consulta filtra picked_up = false — o rastreador nunca lê essa linha.

// Tradução do status do 17TRACK para o que ele significa AQUI.
// ATENÇÃO ao falso amigo: "AvailableForPickup" do 17TRACK é "a transportadora
// deixou na agência para você buscar" — NÃO é o nosso picked_up (que significa
// "comprei no balcão da loja"). É caixa em movimento, ainda não entregue.
// Confundir os dois marcaria como balcão uma remessa viva.
function eventFrom17Track(s: string | undefined | null): 'MOVING' | 'ARRIVED' | null {
  const k = String(s || '').trim()
  if (!k) return null
  if (/^Delivered$/i.test(k)) return 'ARRIVED'
  if (/InfoReceived|InTransit|OutForDelivery|AvailableForPickup|Exception|Undelivered|Expired/i.test(k)) return 'MOVING'
  return null
}

// ── Log obrigatório de toda escrita automática (lei da casa) ────────────────
// O log NUNCA derruba o rastreio (se ele falhar, a entrega ainda tem de ser
// registrada na linha) — mas o silêncio também não vale: quando um insert em
// data_fixes falha, o ciclo devolve dataFixesLogged:false, e quem lê a resposta
// da rota sabe que houve escrita sem rastro. É o caso do banco BR até a
// MIGRATION_data_fixes.sql rodar lá: a tabela ainda não existe.
let logOk = true
async function logFix(db: SupabaseClient, table: string, rowId: string, field: string, oldValue: unknown, newValue: unknown) {
  await db.from('data_fixes').insert({
    check_key: 'items-track',
    table_name: table,
    row_id: rowId,
    field,
    old_value: oldValue == null ? null : String(oldValue),
    new_value: newValue == null ? null : String(newValue),
    label: 'ITEM TRACKING — 17TRACK atualizou a própria linha do item (só fatos: nunca status, que é derivado desde 30/ago/2026)',
  }).then((r: { error?: unknown } | void) => { if (r && (r as any).error) logOk = false }, () => { logOk = false })
}

type ItemRow = {
  id: string
  // picked_up e payment_date entram só para o FILTRO (balcão não viaja; a
  // cascata começa no "pagou"). Nenhum status é lido: não existe mais.
  picked_up: boolean | null
  payment_date: string | null
  tracking_number: string | null
  carrier: string | null
  eta: string | null
  shipped_at: string | null
  delivered_at: string | null
  last_event: string | null
  last_event_at: string | null
}

const COLS = 'id, picked_up, payment_date, tracking_number, carrier, eta, shipped_at, delivered_at, last_event, last_event_at'

export type TrackResult = {
  checked: number
  updated: string[]
  reRegistered: number
  byTable: Record<string, number>
  // false = alguma escrita não conseguiu registrar em data_fixes (tabela ausente
  // ou RLS). A atualização do item foi feita assim mesmo; o que falta é o rastro.
  dataFixesLogged: boolean
  error?: string
}

// O ciclo inteiro: lê as linhas abertas com rastreio, pergunta ao 17TRACK em
// lote e escreve de volta NA LINHA. Um item que chegou vira DELIVERED sozinho —
// que é literalmente o que ele pediu.
export async function refreshItemTracking(db: SupabaseClient): Promise<TrackResult> {
  logOk = true
  const out: TrackResult = { checked: 0, updated: [], reRegistered: 0, byTable: {}, dataFixesLogged: true }
  if (!t17Key()) return { ...out, error: 'TRACK17_API_KEY missing' }

  // Uma consulta por tabela. O filtro É A CASCATA EM SQL, e agora ela pergunta
  // aos FATOS, não a um campo de status:
  //   tracking_number preenchido  → só se rastreia o que tem número
  //   delivered_at NULL           → o que já chegou não se pergunta de novo, e é
  //                                 assim que uma entrega nunca se desfaz
  //   picked_up = false           → balcão não viaja
  //   payment_date preenchido     → a cascata começa no "pagou" (é o mesmo
  //                                 universo de antes, quando o status NULL das
  //                                 não-pagas as mantinha fora)
  //   cancel_status NULL          → compra cancelada/estornada SAI da fila
  //                                 (30/ago/2026): não se consulta transportadora
  //                                 de compra que morreu.
  //   expenses: + EXPENSE_ITEM_GATE  → folha nunca sai do banco (lei de
  //                                 03/set/2026; aqui o tracking_number já
  //                                 garante, mas o gate é o mesmo dos 3 lugares)
  //   nature NULL ou PART         → SÓ PEÇA VIAJA (04/set/2026). É o mesmo
  //                                 predicado de `travels()` em lib/itemNature.ts,
  //                                 escrito em SQL: BRANCO VIAJA (ninguém disse
  //                                 ainda ⇒ pergunta-se), PEÇA viaja, e serviço /
  //                                 digital / encargo / dinheiro não. Deixa de
  //                                 gastar consulta de transportadora com wire,
  //                                 imposto e licença — e um número de rastreio
  //                                 colado numa linha de SERVIÇO (a HP Tuners
  //                                 manda tracking até de 'Universal Credits')
  //                                 não move mais badge nenhum.
  const rows: { table: ItemTable; row: ItemRow }[] = []
  for (const table of ITEM_TABLES) {
    let q = db.from(table).select(COLS)
      .not('tracking_number', 'is', null)
      .is('delivered_at', null)
      .eq('picked_up', false)
      .not('payment_date', 'is', null)
      .is('cancel_status', null)
      .or('nature.is.null,nature.eq.PART')
    if (table === 'expenses') q = q.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)
    const { data, error } = await q
    if (error) return { ...out, error: `${table}: ${error.message}` }
    for (const r of (data || []) as ItemRow[]) {
      if (String(r.tracking_number || '').trim()) rows.push({ table, row: r })
    }
  }
  out.checked = rows.length
  if (!rows.length) return out

  // Um mesmo rastreio pode estar em VÁRIAS linhas (a caixa traz N itens do
  // mesmo pedido — foi assim que a migração as carimbou). Pergunta-se UMA vez
  // por número e escreve-se em TODAS as linhas que o carregam.
  const byTracking = new Map<string, { table: ItemTable; row: ItemRow }[]>()
  for (const r of rows) {
    const k = String(r.row.tracking_number).trim()
    if (!byTracking.has(k)) byTracking.set(k, [])
    byTracking.get(k)!.push(r)
  }
  const numbers = Array.from(byTracking.keys())

  for (let i = 0; i < numbers.length; i += 40) {
    const chunk = numbers.slice(i, i + 40)
    const payload = chunk.map(n => {
      const first = byTracking.get(n)![0].row
      const code = carrierCode(n, first.carrier)
      return { number: n, ...(code ? { carrier: code } : {}) }
    })
    const res = await t17('gettrackinfo', payload)
    if (res?.code !== 0) {
      return { ...out, error: `17TRACK gettrackinfo failed — ${JSON.stringify(t17Last?.body ?? t17Last).slice(0, 300)}` }
    }

    // Número que o 17TRACK não conhece (registro nunca feito ou perdido) é
    // re-registrado na hora, sempre com carrier explícito; o próximo ciclo já
    // o atualiza. Sem isso o item ficaria eternamente SHIPPED, em silêncio.
    const rejected: any[] = res?.data?.rejected || []
    if (rejected.length) {
      const reg = await t17('register', rejected
        .map(x => String(x.number || ''))
        .filter(n => byTracking.has(n))
        .map(n => {
          const code = carrierCode(n, byTracking.get(n)![0].row.carrier)
          return { number: n, ...(code ? { carrier: code } : {}) }
        }))
      if (reg?.code === 0) out.reRegistered += (reg?.data?.accepted || []).length
    }

    for (const acc of res?.data?.accepted || []) {
      const targets = byTracking.get(String(acc.number || ''))
      if (!targets || !acc.track_info) continue
      for (const t of targets) {
        const changed = await applyToItem(db, t.table, t.row, acc.track_info)
        if (changed) {
          out.updated.push(`${t.table}/${t.row.id}: ${changed}`)
          out.byTable[t.table] = (out.byTable[t.table] || 0) + 1
        }
      }
    }
  }
  out.dataFixesLogged = logOk
  return out
}

// Escreve a resposta da transportadora NA LINHA DO ITEM — SÓ OS FATOS:
// carrier, eta, last_event, last_event_at, shipped_at, delivered_at. NENHUM
// status é escrito aqui, nem existe campo para escrever. O badge é derivado e
// acompanha sozinho (lib/deliverStatus.ts).
// Devolve 'DELIVERED' quando a entrega foi registrada agora, ou null quando só
// metadados mudaram (ou nada).
async function applyToItem(db: SupabaseClient, table: ItemTable, row: ItemRow, info: any): Promise<string | null> {
  const ev17 = eventFrom17Track(info?.latest_status?.status)

  const ev = info?.latest_event
  const evDesc = [ev?.description, ev?.location].filter(Boolean).join(' — ') || null
  const provider = info?.tracking?.providers?.[0]?.provider?.name || null
  const etaRaw = info?.time_metrics?.estimated_delivery_date?.from || info?.time_metrics?.estimated_delivery_date?.to || null
  const eta = etaRaw ? String(etaRaw).slice(0, 10) : row.eta

  const patch: Record<string, unknown> = {}
  // CARRIER só se preenche VAZIO: o que a pessoa digitou na tela do item manda
  // sobre o palpite do 17TRACK (mesma regra da migração — não sobrescrever).
  if (!String(row.carrier || '').trim() && provider) patch.carrier = provider
  if (eta && eta !== row.eta) patch.eta = eta
  if (evDesc && evDesc !== row.last_event) patch.last_event = evDesc
  if (ev?.time_iso && ev.time_iso !== row.last_event_at) patch.last_event_at = ev.time_iso
  // OS DOIS FATOS QUE MOVEM O BADGE — e não são status, são datas.
  // shipped_at: a caixa começou a andar. O badge já era SHIPPED pelo rastreio.
  if (ev17 && !row.shipped_at) patch.shipped_at = new Date().toISOString()
  // delivered_at: chegou. É ESTE campo, sozinho, que acende o DELIVERED. Só se
  // escreve VAZIO — uma entrega registrada jamais se apaga (e a consulta já
  // nem traz linha entregue).
  const arrived = ev17 === 'ARRIVED' && !row.delivered_at
  if (arrived) patch.delivered_at = ev?.time_iso || new Date().toISOString()

  if (!Object.keys(patch).length) return null
  const { error } = await db.from(table).update(patch).eq('id', row.id)
  if (error) { console.error('[items/track] update', table, row.id, error.message); return null }
  for (const [field, value] of Object.entries(patch)) {
    await logFix(db, table, row.id, field, (row as any)[field], value)
  }
  return arrived ? 'DELIVERED' : null
}
