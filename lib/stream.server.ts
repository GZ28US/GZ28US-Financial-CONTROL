// SERVER-ONLY — the STREAM automation core, shared by /api/stream/track and
// /api/stream/webhook. Talks to Supabase with the service-role key (RLS
// bypass), to 17TRACK with TRACK17_API_KEY, and to WhatsApp via UltraMsg.
// Never import from client code.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { guessCarrier, statusFrom17Track, type StreamRow, type StreamStatus } from './stream'

export function streamDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  )
}

const T17 = 'https://api.17track.net/track/v2.2'
const t17Key = () => process.env.TRACK17_API_KEY || ''

// Última resposta crua do 17TRACK — diagnóstico exposto pelo /api/stream/track
// (auditoria 30/jul: falhas eram engolidas e o STREAM morria em silêncio).
export let t17Last: { path: string; httpStatus: number; body: any } | null = null

async function t17(path: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${T17}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '17token': t17Key() },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => null)
    t17Last = { path, httpStatus: r.status, body: j }
    if (j?.code !== 0) console.error('[17track]', path, r.status, JSON.stringify(j).slice(0, 400))
    return j
  } catch (e) {
    t17Last = { path, httpStatus: 0, body: String(e) }
    console.error('[17track]', path, e)
    return null
  }
}

// ROOT CAUSE da auditoria 30/jul: o auto-detect do 17TRACK falhava em TODOS os
// nossos números (-18019903 "Carrier cannot be detected") e o register morria em
// silêncio — nenhuma linha nunca foi registrada, logo zero updates de entrega.
// A cura é mandar o carrier explícito (o app já sabe qual é via guessCarrier).
const T17_CARRIER: Record<string, number> = { FedEx: 100003, UPS: 100002, USPS: 21051, DHL: 100001 }
export function t17CarrierCode(tracking: string, carrier?: string | null): number | undefined {
  const name = carrier || guessCarrier(tracking) || ''
  for (const [k, v] of Object.entries(T17_CARRIER)) if (new RegExp(k, 'i').test(name)) return v
  return undefined
}

// Register a tracking number with 17TRACK (idempotent — "already registered"
// rejections are fine). Returns false only on a hard failure.
export async function t17Register(tracking: string, carrier?: string | null): Promise<boolean> {
  if (!t17Key()) return false
  const code = t17CarrierCode(tracking, carrier)
  const res = await t17('register', [{ number: tracking, ...(code ? { carrier: code } : {}) }])
  if (res?.code !== 0) return false
  const rejected = res?.data?.rejected?.[0]
  // -18019901 = already registered — that's success for our purposes.
  return !rejected || rejected?.error?.code === -18019901
}

export async function t17GetInfo(tracking: string, carrier?: string | null): Promise<any | null> {
  if (!t17Key()) return null
  const code = t17CarrierCode(tracking, carrier)
  const res = await t17('gettrackinfo', [{ number: tracking, ...(code ? { carrier: code } : {}) }])
  return res?.code === 0 ? (res?.data?.accepted?.[0]?.track_info ?? null) : null
}

// Same registered signature every report carries (see app/api/whatsapp/route.ts).
const SIGNATURE = 'Sent by GZ28US Control App®'
export async function sendStreamWhatsApp(body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

// CANCELLED/REFUNDED sit above every carrier-mapped status so a 17TRACK push
// can never resurrect a cancelled order (applyTrackInfo also bails early).
const RANK: Record<StreamStatus, number> = { BOUGHT: 0, SHIPPED: 1, DELIVERED: 2, REPORTED_PT: 3, DELIVERED_BR: 4, CANCELLED: 90, REFUNDED: 99 }

function fmtDate(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00')
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Where the purchase lives — "US.042.2 · SublimeHell" — for the report line.
// BR rows carry a pre-computed where_label (their invoice lives in the BR DB).
export async function whereLabel(db: SupabaseClient, row: StreamRow): Promise<string> {
  if (row.app === 'BR') return row.where_label || ''
  if (!row.invoice_id) return ''
  const { data: inv } = await db.from('invoices').select('invoice_code, ride_id').eq('id', row.invoice_id).maybeSingle()
  if (!inv) return ''
  const { data: ride } = inv.ride_id
    ? await db.from('rides').select('project_name').eq('id', inv.ride_id).maybeSingle()
    : { data: null }
  return [inv.invoice_code, ride?.project_name].filter(Boolean).join(' · ')
}

// BR rows report to the BR app's own WhatsApp instance (BR number + BR group);
// US rows keep the UltraMsg env of this app.
export async function notify(row: StreamRow, body: string): Promise<void> {
  if (row.app === 'BR') {
    try {
      await fetch('https://www.gz28br.com/ca/api/whatsapp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
    } catch { /* best-effort */ }
    return
  }
  await sendStreamWhatsApp(body)
}

// Periodic batch refresh (auditoria 30/jul): o webhook do 17TRACK era o ÚNICO
// caminho de atualização de entrega — se ele falha, o board congela (tires do
// Walmart entregues e paradas em SHIPPED). Agora todo mail-poll consulta o
// 17TRACK em lote (até 40 números por chamada) para TODA linha aberta com
// tracking, re-registrando as rejeitadas. Erros voltam no retorno, nunca mudos.
export async function refreshAllTracking(db: SupabaseClient): Promise<{ checked: number; updated: string[]; reRegistered: number; error?: string }> {
  if (!t17Key()) return { checked: 0, updated: [], reRegistered: 0, error: 'TRACK17_API_KEY missing' }
  const { data } = await db.from('part_streams').select('*')
    .in('status', ['BOUGHT', 'SHIPPED'])
    .not('tracking_number', 'is', null)
  const rows = ((data as StreamRow[]) || []).filter(r => r.tracking_number)
  if (!rows.length) return { checked: 0, updated: [], reRegistered: 0 }

  const updated: string[] = []
  let reRegistered = 0
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40)
    const withCarrier = (r: StreamRow) => {
      const code = t17CarrierCode(String(r.tracking_number), r.carrier)
      return { number: r.tracking_number, ...(code ? { carrier: code } : {}) }
    }
    const res = await t17('gettrackinfo', chunk.map(withCarrier))
    if (res?.code !== 0) {
      return { checked: i, updated, reRegistered, error: `17TRACK gettrackinfo failed — ${JSON.stringify(t17Last?.body ?? t17Last).slice(0, 300)}` }
    }
    // Números que o 17TRACK não conhece (registro perdido/nunca feito) são
    // re-registrados na hora — SEMPRE com carrier explícito; o próximo ciclo de
    // 5min já os atualiza.
    const rejected: any[] = res?.data?.rejected || []
    if (rejected.length) {
      const rejRows = rejected.map(x => chunk.find(r => r.tracking_number === x.number)).filter(Boolean) as StreamRow[]
      const reg = await t17('register', rejRows.map(withCarrier))
      if (reg?.code === 0) reRegistered += (reg?.data?.accepted || []).length
    }
    for (const acc of res?.data?.accepted || []) {
      const row = chunk.find(r => r.tracking_number === acc.number)
      if (!row || !acc.track_info) continue
      const before = row.status
      const after = await applyTrackInfo(db, row, acc.track_info)
      if (after.status !== before) updated.push(`${row.item}: ${before}→${after.status}`)
    }
  }
  return { checked: rows.length, updated, reRegistered }
}

// Apply a 17TRACK track_info payload onto a stream row: status (never
// downgrading), carrier name, ETA, last checkpoint — then report SHIPPED /
// DELIVERED transitions to the REPORTS WhatsApp group.
export async function applyTrackInfo(db: SupabaseClient, row: StreamRow, info: any): Promise<StreamRow> {
  // A cancelled order is out of the delivery ladder — the only transition left
  // is CANCELLED → REFUNDED (mail watcher / manual), never a carrier event.
  if (row.status === 'CANCELLED' || row.status === 'REFUNDED') return row
  const latest = info?.latest_status?.status
  const mapped = statusFrom17Track(latest)
  const next: StreamStatus = mapped && RANK[mapped] > RANK[row.status] ? mapped : row.status

  const ev = info?.latest_event
  const evDesc = [ev?.description, ev?.location].filter(Boolean).join(' — ') || null
  const providerName = info?.tracking?.providers?.[0]?.provider?.name || null
  const etaRaw = info?.time_metrics?.estimated_delivery_date?.from || info?.time_metrics?.estimated_delivery_date?.to || null
  const eta = etaRaw ? String(etaRaw).slice(0, 10) : row.eta

  const patch: Record<string, unknown> = {
    status: next,
    carrier: providerName || row.carrier || (row.tracking_number ? guessCarrier(row.tracking_number) : null),
    eta,
    last_event: evDesc ?? row.last_event,
    last_event_at: ev?.time_iso || row.last_event_at,
  }
  if (next === 'SHIPPED' && !row.shipped_at) patch.shipped_at = new Date().toISOString()
  if (next === 'DELIVERED' && !row.delivered_at) patch.delivered_at = new Date().toISOString()

  await db.from('part_streams').update(patch).eq('id', row.id)
  const updated = { ...row, ...patch } as StreamRow

  if (next !== row.status) {
    const where = await whereLabel(db, row)
    // On a BR row, carrier-DELIVERED means "arrived at PowerTrade" (the US
    // forwarder) — the Paraguay + GZ28BR legs come after, updated separately.
    const deliveredLabel = row.app === 'BR' ? 'DELIVERED at PowerTrade' : 'DELIVERED'
    if (next === 'DELIVERED') {
      await notify(row,
        `✅ *STREAM — ${deliveredLabel}*\n${row.item}\n${[row.supplier, where].filter(Boolean).join(' · ')}` +
        `${updated.carrier || row.tracking_number ? `\n${[updated.carrier, row.tracking_number].filter(Boolean).join(' ')}` : ''}`,
      )
    } else if (next === 'SHIPPED') {
      await notify(row,
        `🚚 *STREAM — SHIPPED*\n${row.item}\n${[row.supplier, where].filter(Boolean).join(' · ')}` +
        `\n${[updated.carrier, row.tracking_number].filter(Boolean).join(' ')}` +
        `${eta ? `\nETA ${fmtDate(eta)}` : ''}`,
      )
    }
  }
  return updated
}
