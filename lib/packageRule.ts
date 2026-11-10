// PACKAGE = one price for the whole (09/11/2026, Márcio «wrong!!!!» on the printable of 9999.84241: a package component is NOT a
// courtesy, it is INCLUDED in the package price). ONE rule for both papers — the app's printable invoice and the portal PDF
// (lib/quoteDoc.server buildRevision) — US and BR (copy word for word). COURTESY stays only for a real loose freebie outside a package.
//   · the invoice has a catalogue pack (pack_id), or
//   · any line is grouped in a kit, or
//   · exactly ONE line carries a price, there is more than one line, and the service / that line says package / pack / pacote.
type Line = { unit_price?: unknown; price?: unknown; quantity?: unknown; description?: unknown; kit_group?: unknown }
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0

export function isPackageInvoice(inv: { pack_id?: unknown; service?: unknown } | null | undefined, items: Line[], services: Line[]): boolean {
  if (inv?.pack_id) return true
  if (items.some(i => !!i.kit_group)) return true
  const priced = [...items.filter(i => num(i.unit_price) * (num(i.quantity) || 1) !== 0), ...services.filter(s => num(s.price) !== 0)]
  return priced.length === 1 && items.length + services.length > 1 &&
    /package|pack|pacote/i.test(`${String(inv?.service ?? '')} ${String(priced[0].description ?? '')}`)
}
