// BUY LINK on every quote line (Márcio 10/11/2026, via Parts Chasing: «as quotes devem estar perfeitas, com o link pra compra de
// item por item»). The link lives in invoice_items.source_item (US) / invoice_parts.source_item (BR) when it is an http(s) URL — the
// same column also holds plain expense names, which are NOT links and show nothing.
export function buyLink(src: unknown): { url: string; host: string } | null {
  const s = String(src ?? '').trim()
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { url: u.href, host: u.hostname.replace(/^www\./i, '') }
  } catch { return null }
}
