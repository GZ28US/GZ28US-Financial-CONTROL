// THE HOUSE SIGNATURE of every WhatsApp the app sends (moved here from app/api/whatsapp/route.ts on 08/11/2026, byte for byte, so
// the route and the quote-portal switchboard (lib/notify.server.ts) apply ONE rule instead of two copies).
// Memory claudinha-signature: external = ALWAYS «Sent by GZ28US Control App®» — the ® is mandatory.
// Pure: no I/O, safe to import anywhere (the local harness imports it).

// Every message — internal report or message to a client — ends with this
// registered signature line. Centralized here so it's guaranteed on EVERY message
// that goes through this route, no matter which page built it.
export const SIGNATURE = 'Sent by GZ28US Control App®'

// Append the signature as the last line, after stripping the legacy footer some
// report builders still add, and without double-adding it.
export function withSignature(raw: string): string {
  const text = (raw || '').replace(/\n*Sent by GZ28(US)? Control App®?\s*$/i, '').trimEnd()
  if (text.endsWith(SIGNATURE)) return text
  return text ? `${text}\n\n${SIGNATURE}` : SIGNATURE
}

// UltraMsg requires the `to` in chat format: <digits>@c.us for a person or
// <id>@g.us for a group. A bare phone number (just digits) is rejected with
// "Wrong 'to' format". So: pass through anything that already has an @ (groups,
// or an already-formatted contact), and turn a bare number into <digits>@c.us.
export function normalizeTo(raw: string | null | undefined): string {
  const v = String(raw || '').trim()
  if (!v) return ''
  if (v.includes('@')) return v
  const digits = v.replace(/\D/g, '')
  return digits ? `${digits}@c.us` : ''
}
