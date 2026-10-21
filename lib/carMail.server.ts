// lib/carMail.server.ts — E-MAIL DE COMPRA DE CARRO MORA NA PASTA DO CARRO (17/10/2026).
//
// Márcio, 17/10/2026 (via AutoBook GZ28US): «onde vc armazena os emails? tem que ser sempre na pasta do carro, vc sabe né? Se
// não está fazendo isso, corrija o seu comportamento e o do robô». A lei é a [[pasta-de-email-do-carro-sagrada]]: pasta
// `Rides/<código> - <nome>`, só nas caixas da EMPRESA do código (US → slots 1 e 4; BR → 2 e 3).
//
// O robô do AutoBook arquivava na cascata carro → fornecedor → «Purchases», mas quase nunca sabia o carro: a compra de carro
// caía na pasta do fornecedor, em Purchases ou ficava na inbox. Aqui o CARRO sai da LINHA DO APP:
//   pedido citado na carta (order_number de invoice_expenses, com fronteira — "382872" não casa dentro de "1382872")
//   ou a linha que o robô acabou de lançar/achar → invoice (de verdade: sem quote, sem o balde A ATRIBUIR) → ride.
// Vale para TODA carta do pedido (confirmação, PayPal, envio, entrega, conversa) — quem chama é o robô do AutoBook (hora em
// hora) e a ponte e-mail → item do rastreio (mail-poll, 5 em 5 min).
// 21/10/2026 — LEI NOVA (Márcio, 20/10): a pasta é «GZ28US Rides/<código> - <nome>» ou «GZ28BR Rides/…» em QUALQUER caixa, na caixa
// onde a carta está, e nasce quando falta (lib/carMailFolder.server.ts). Acabou o «só nas caixas da empresa».
// Compra de 2 carros: CÓPIA na pasta dos extras e MOVE na última (como o /api/stream/mail-file). Carta que já está numa pasta
// que NÃO é de carro mas é de compra (Purchases, a do fornecedor) também vai; qualquer outra pasta foi escolha de gente e fica.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { pastaDoCarro, esqueceCachePastasDeCarro } from '@/lib/carMailFolder.server'
import type { MailMsg } from '@/lib/streamMail.server'

export type CarroDaCarta = { code: string; name: string }
const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MIN_PEDIDO = 5
// order_number que não é pedido de verdade (marcadores internos do app)
const NAO_E_PEDIDO = /^(bank:|tbd$|n\/a$|-+$)/i

/* ─────────────── o índice pedido → carro ─────────────── */

export type IndiceCarros = { porPedido: Map<string, CarroDaCarta[]>; porLinha: Map<string, CarroDaCarta> }

async function fetchAll(db: SupabaseClient, table: string, sel: string, f?: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q: any = db.from(table).select(sel)
    if (f) q = f(q)
    const { data, error } = await q.range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

async function indiceDoBanco(db: SupabaseClient, idx: IndiceCarros): Promise<void> {
  const rows = await fetchAll(db, 'invoice_expenses', 'id, order_number, invoice_id', q => q.not('invoice_id', 'is', null))
  const invIds = [...new Set(rows.map(r => r.invoice_id).filter(Boolean))].map(String)
  const invs: any[] = []
  // `origin` (o balde A ATRIBUIR) só existe no banco do US — no BR a coluna não existe e a leitura vai sem ela.
  let sel = 'id, ride_id, is_quote, origin'
  for (let i = 0; i < invIds.length; i += 300) {
    try { invs.push(...await fetchAll(db, 'invoices', sel, q => q.in('id', invIds.slice(i, i + 300)))) }
    catch (e) { if (sel.includes('origin') && /origin/.test(String((e as Error).message))) { sel = 'id, ride_id, is_quote'; i -= 300; continue } throw e }
  }
  const rideIds = [...new Set(invs.filter(i => i.ride_id && !i.is_quote && i.origin !== 'BUCKET').map(i => String(i.ride_id)))]
  const rides: any[] = []
  for (let i = 0; i < rideIds.length; i += 300) rides.push(...await fetchAll(db, 'rides', 'id, project_code, project_name', q => q.in('id', rideIds.slice(i, i + 300))))
  const rideOf = new Map<string, any>(rides.map(r => [String(r.id), r]))
  const carOfInv = new Map<string, CarroDaCarta>()
  for (const i of invs) {
    const r = i.ride_id && !i.is_quote && i.origin !== 'BUCKET' ? rideOf.get(String(i.ride_id)) : null
    if (r?.project_code && !/\.QT\./i.test(r.project_code)) carOfInv.set(String(i.id), { code: String(r.project_code), name: String(r.project_name || '') })
  }
  for (const r of rows) {
    const car = carOfInv.get(String(r.invoice_id))
    if (!car) continue
    idx.porLinha.set(String(r.id), car)
    const p = String(r.order_number || '').trim()
    if (p.length < MIN_PEDIDO || NAO_E_PEDIDO.test(p) || !/\d{3}/.test(p)) continue
    const arr = idx.porPedido.get(p) || []
    if (!arr.some(c => c.code === car.code)) arr.push(car)
    idx.porPedido.set(p, arr)
  }
}

// Os dois bancos: carro do BR mora no banco do BR. Banco que falha não derruba o outro.
export async function carregaIndiceCarros(dbUS: SupabaseClient, erros?: string[]): Promise<IndiceCarros> {
  const idx: IndiceCarros = { porPedido: new Map(), porLinha: new Map() }
  try { await indiceDoBanco(dbUS, idx) } catch (e) { erros?.push('índice de carros US: ' + String((e as Error).message || e).slice(0, 120)) }
  const br = supabaseBRService()
  if (br) { try { await indiceDoBanco(br, idx) } catch (e) { erros?.push('índice de carros BR: ' + String((e as Error).message || e).slice(0, 120)) } }
  return idx
}

// Os carros cujo pedido aparece INTEIRO na carta (assunto + corpo).
export function carrosDaCarta(idx: IndiceCarros, msg: Pick<MailMsg, 'subject' | 'text'>, linhaId?: string | null): CarroDaCarta[] {
  const out = new Map<string, CarroDaCarta>()
  if (linhaId) { const c = idx.porLinha.get(String(linhaId)); if (c) out.set(c.code, c) }
  const texto = `${msg.subject} ${msg.text}`
  for (const [pedido, cars] of idx.porPedido) {
    let i = texto.indexOf(pedido)
    while (i >= 0) {
      const antes = texto[i - 1] || ' ', depois = texto[i + pedido.length] || ' '
      if (!/[0-9A-Za-z]/.test(antes) && !/[0-9A-Za-z]/.test(depois)) { for (const c of cars) out.set(c.code, c); break }
      i = texto.indexOf(pedido, i + 1)
    }
  }
  return [...out.values()]
}

/* ─────────────── arquivar ─────────────── */

export type CaixaCarro = { slot: number; token: string; gmail: boolean; inboxId: string | null; origensOk: Set<string> }
export type ResultadoCarro = { feito: boolean; onde: string; motivo?: string }

const gh = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })
// Lambda quente reaproveita o módulo: cada rodada começa com o mapa limpo.
export const esqueceCachePastas = () => esqueceCachePastasDeCarro()

// A carta vai para a pasta de cada carro, NESTA caixa (a pasta nasce quando falta). Extras = cópia; último = move.
export async function arquivaNoCarro(cx: CaixaCarro, msg: MailMsg, carros: CarroDaCarta[]): Promise<ResultadoCarro> {
  if (!msg.id) return { feito: false, onde: '', motivo: 'carta sem id' }
  const meus = carros
  if (!meus.length) return { feito: false, onde: '', motivo: 'sem carro' }
  let pastas: { c: CarroDaCarta; id: string; caminho: string }[]
  try { pastas = await Promise.all(meus.map(async c => { const p = await pastaDoCarro({ token: cx.token, gmail: cx.gmail }, c, { criar: true }); return { c, id: p!.id, caminho: p!.caminho } })) }
  catch (e) { return { feito: false, onde: '', motivo: 'pasta do carro falhou: ' + String((e as Error)?.message || e).slice(0, 160) } }
  const onde = pastas.map(p => p.caminho).join(' + ')
  if (cx.gmail) {
    const labels = (msg.folderId || '').split(',').filter(Boolean)
    const ids = pastas.map(p => p.id)
    if (ids.every(id => labels.includes(id)) && !labels.includes('INBOX')) return { feito: false, onde: '', motivo: 'já está na pasta do carro' }
    if (!labels.includes('INBOX') && !labels.some(l => cx.origensOk.has(l))) return { feito: false, onde: '', motivo: 'fora da inbox, numa pasta que alguém escolheu' }
    const r = await fetch(`${GM}/messages/${encodeURIComponent(msg.id)}/modify`, { method: 'POST', headers: gh(cx.token), body: JSON.stringify({ addLabelIds: ids, removeLabelIds: ['INBOX', ...labels.filter(l => cx.origensOk.has(l))] }) })
    return r.ok ? { feito: true, onde } : { feito: false, onde: '', motivo: 'Gmail recusou (HTTP ' + r.status + ')' }
  }
  const alvos = pastas
  const aqui = msg.folderId || ''
  if (alvos.some(a => a.id === aqui)) return { feito: false, onde: '', motivo: 'já está na pasta do carro' }
  if (aqui !== cx.inboxId && !cx.origensOk.has(aqui)) return { feito: false, onde: '', motivo: 'fora da inbox, numa pasta que alguém escolheu' }
  for (const a of alvos.slice(0, -1)) {
    const cp = await fetch(`${G}/me/messages/${encodeURIComponent(msg.id)}/copy`, { method: 'POST', headers: gh(cx.token), body: JSON.stringify({ destinationId: a.id }) })
    if (!cp.ok) return { feito: false, onde: '', motivo: `cópia para ${a.c.code} falhou (HTTP ${cp.status})` }
  }
  const last = alvos[alvos.length - 1]
  const mv = await fetch(`${G}/me/messages/${encodeURIComponent(msg.id)}/move`, { method: 'POST', headers: gh(cx.token), body: JSON.stringify({ destinationId: last.id }) })
  return mv.ok ? { feito: true, onde } : { feito: false, onde: '', motivo: `move para ${last.c.code} falhou (HTTP ${mv.status})` }
}
