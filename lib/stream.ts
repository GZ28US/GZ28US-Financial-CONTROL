// ── STREAM — purchase follow-up ─────────────────────────────────────────────
// One row per scanned purchase (order). The lifecycle is three statuses:
//   BOUGHT    — paid, awaiting shipment
//   SHIPPED   — tracking number exists / carrier reports movement
//   DELIVERED — carrier confirmed delivery
// Tracking automation runs through 17TRACK (api.17track.net): the tracking
// number is registered once and 17TRACK pushes every status change to
// /api/stream/webhook. This module is client-safe — no keys here.

// US rows walk BOUGHT → SHIPPED → DELIVERED. BR rows (app='BR', shown only on
// the BR app's board) continue: DELIVERED means "at PowerTrade" (the freight
// forwarder's US warehouse), then REPORTED_PT (arrived at PowerTrade Paraguay)
// and DELIVERED_BR (received at GZ28BR).
export type StreamStatus = 'BOUGHT' | 'SHIPPED' | 'DELIVERED' | 'REPORTED_PT' | 'DELIVERED_BR'

export type StreamRow = {
  id: string
  app: 'US' | 'BR'
  invoice_id: string | null
  purchase_group: string | null
  supplier: string | null
  item: string
  order_number: string | null
  tracking_number: string | null
  carrier: string | null
  status: StreamStatus
  eta: string | null
  last_event: string | null
  last_event_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  where_label: string | null
  created_at: string
}

export const STREAM_STATUS_META: Record<StreamStatus, { label: string; icon: string; cls: string }> = {
  BOUGHT:       { label: 'BOUGHT — awaiting shipment', icon: '🛒', cls: 'bg-amber-900 text-amber-300' },
  SHIPPED:      { label: 'SHIPPED',                    icon: '🚚', cls: 'bg-blue-900 text-blue-300' },
  DELIVERED:    { label: 'DELIVERED',                  icon: '✅', cls: 'bg-green-900 text-green-300' },
  REPORTED_PT:  { label: 'REPORTED BY POWERTRADE',     icon: '🛃', cls: 'bg-purple-900 text-purple-300' },
  DELIVERED_BR: { label: 'DELIVERED at GZ28BR',        icon: '🏁', cls: 'bg-green-900 text-green-300' },
}

// Best-effort carrier guess from the tracking-number shape — display only.
// 17TRACK does the authoritative detection when the number is registered.
export function guessCarrier(tracking: string): string | null {
  const t = (tracking || '').replace(/\s/g, '').toUpperCase()
  if (!t) return null
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS'
  if (/^(9[2345])\d{20,24}$/.test(t)) return 'USPS'
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'FedEx'
  if (/^\d{20,22}$/.test(t)) return 'FedEx'
  if (/^[A-Z]{2}\d{9}US$/.test(t)) return 'USPS'
  return null
}

// Public tracking page for the row's carrier — the row's tracking link.
export function carrierTrackUrl(carrier: string | null, tracking: string): string {
  const t = encodeURIComponent((tracking || '').trim())
  const c = (carrier || '').toUpperCase()
  if (c.includes('UPS')) return `https://www.ups.com/track?tracknum=${t}`
  if (c.includes('USPS')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`
  if (c.includes('FEDEX')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`
  return `https://t.17track.net/en#nums=${t}`
}

// Map a 17TRACK v2.2 status string onto the three STREAM statuses.
export function statusFrom17Track(s: string | null | undefined): StreamStatus | null {
  const v = String(s || '').toLowerCase()
  if (!v) return null
  if (v === 'delivered') return 'DELIVERED'
  if (['intransit', 'outfordelivery', 'availableforpickup', 'deliveryfailure', 'exception'].includes(v)) return 'SHIPPED'
  if (['inforeceived', 'notfound', 'expired'].includes(v)) return 'BOUGHT'
  return null
}
