/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the quote/invoice PDF of the portal (06/11/2026; blueprint M2 §8.2). Vector PDF (jsPDF) built ONLY from the frozen
// revision snapshot (`invoice_revisions.document`) — never from live rows — so the paper is exactly what the client saw and
// signed. Letter size. The certificate block is MASKED on the client copy (contact, IP → city) and FULL on the staff copy
// (Fla. §668.50(8) retainable record). A deposit receipt PDF per paid attempt. Nothing here sends anything.
//
// LOOK (09/11/2026, Márcio: «do it with the current printable invoice look»): the same layout as the PRINTABLE INVOICE of the app
// (app/rides/[id]/invoices/[invoiceId]/page.tsx, the `.pi-*` CSS) — logo + company centered + red number on the right, CLIENT and
// VEHICLE boxes, black section bars, grey table heads, the navy/gold GRAND TOTAL, the faint logo watermark. The printable is HTML
// rasterized at 816 px wide onto 576 pt; here every `.pi` px measure is drawn × K = 576/816, so the proportions are the same — but
// in vector (sharp text, selectable, small file). Change the printable CSS → change the numbers here.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { createHash } from 'node:crypto'
import { t, money, moneyCents, TERMS_TEXT, FL_ESTIMATE_TEXT, type Lang } from './quoteStrings'
import { fmtDay, fmtStamp } from './orlando'
import { formatPhone } from './utils'
import { LOGO_GZ28_JPEG } from './pdfLogo'
import { buyLink } from './buyLink'

// Helvetica (WinAnsi) has no glyph for some marks — map them, never print a broken glyph.
const pdfText = (s: unknown) => String(s ?? '')
  .replace(/[—–]/g, '-').replace(/[•·]/g, '·').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/§/g, 'Sec. ')
  .replace(/[✓✔]/g, 'OK').replace(/[✍📦🏁⏳⚠✖]/gu, '').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF·]/g, '')

export type CertMode = 'public' | 'full' | 'none'

// ── the printable's measures ───────────────────────────────────────────────────────────────────────────────────────────────
const M = 18                                  // ~0.25in, the printable's PDF margin
const K = 576 / 816                           // printable px → pt
const px = (n: number) => n * K
type RGB = [number, number, number]
const C = {
  ink: [17, 17, 17] as RGB, black: [17, 17, 17] as RGB, red: [204, 0, 0] as RGB, grey5: [85, 85, 85] as RGB, grey6: [102, 102, 102] as RGB,
  grey8: [136, 136, 136] as RGB, line: [204, 204, 204] as RGB, line2: [238, 238, 238] as RGB, head: [224, 224, 224] as RGB, headLine: [187, 187, 187] as RGB,
  cellLine: [232, 232, 232] as RGB, zebra: [250, 250, 250] as RGB, sub: [239, 239, 239] as RGB, ps: [240, 240, 240] as RGB, kit: [238, 242, 242] as RGB,
  navy: [26, 26, 46] as RGB, gold: [240, 192, 64] as RGB, green: [74, 222, 128] as RGB, white: [255, 255, 255] as RGB,
}

// The printable's words (its `T`, EN / PT), plus the portal's own.
const L = {
  en: { quoteNo: 'Quote #', receiptNo: 'Receipt #', clientT: 'Client', name: 'Name', address: 'Address', cityst: 'City/ST', phone: 'Phone', email: 'E-Mail',
    vehicle: 'Vehicle', make: 'Make / Brand', model: 'Model', yearvin: 'Year / VIN', colorplate: 'Color / Plate / Mi', pack: 'Service',
    items: 'Items', desc: 'Description', unit: 'Unit Price', qt: 'Qt', total: 'Total', subtotal: 'Sub-Total', itemsTotal: 'Items Total',
    services: 'Services', servicesTotal: 'Services Total', itemsServices: 'Items + Services', grand: 'Grand Total', notesT: 'Notes',
    plan: 'Payment Plan', due: 'Due', amount: 'Amount', planTotal: 'Total', net: (n: number) => `Net ${n} days`, payment: 'Payment',
    installment: 'Installment', method: 'Method', date: 'Date', reference: 'Reference', received: 'Amount Received', page: 'Page' },
  pt: { quoteNo: 'Orçamento #', receiptNo: 'Recibo #', clientT: 'Cliente', name: 'Nome', address: 'Endereço', cityst: 'Cidade/UF', phone: 'Telefone', email: 'E-Mail',
    vehicle: 'Veículo', make: 'Marca / Fabricante', model: 'Modelo', yearvin: 'Ano / VIN', colorplate: 'Cor / Placa / Mi', pack: 'Serviço',
    items: 'Itens', desc: 'Descrição', unit: 'Preço Unit.', qt: 'Qt', total: 'Total', subtotal: 'Sub-Total', itemsTotal: 'Total dos Itens',
    services: 'Serviços', servicesTotal: 'Total dos Serviços', itemsServices: 'Itens + Serviços', grand: 'Total Geral', notesT: 'Observações',
    plan: 'Plano de Pagamento', due: 'Vencimento', amount: 'Valor', planTotal: 'Total', net: (n: number) => `${n} dias`, payment: 'Pagamento',
    installment: 'Parcela', method: 'Meio', date: 'Data', reference: 'Referência', received: 'Valor Recebido', page: 'Página' },
}

// ── drawing kit, one per PDF ───────────────────────────────────────────────────────────────────────────────────────────────
function kit(pdf: jsPDF) {
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), CW = W - 2 * M
  const fill = (c: RGB) => pdf.setFillColor(c[0], c[1], c[2])
  const stroke = (c: RGB) => pdf.setDrawColor(c[0], c[1], c[2])
  const text = (s: unknown, x: number, y: number, o: { size: number; bold?: boolean; color?: RGB; align?: 'left' | 'center' | 'right'; space?: number; upper?: boolean }) => {
    pdf.setFont('helvetica', o.bold ? 'bold' : 'normal'); pdf.setFontSize(o.size)
    const c = o.color || C.ink; pdf.setTextColor(c[0], c[1], c[2])
    pdf.setCharSpace(o.space || 0)
    let v = pdfText(s); if (o.upper) v = v.toUpperCase()
    pdf.text(v, x, y, { align: o.align || 'left', baseline: 'top' })
    pdf.setCharSpace(0)
  }
  const width = (s: unknown, size: number, bold = false) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size); return pdf.getTextWidth(pdfText(s)) }
  // the faint logo behind the content (`.pi-watermark`: 500 px wide, opacity 0.055), on every page
  const watermark = () => {
    const w = px(500), h = w * LOGO_GZ28_JPEG.h / LOGO_GZ28_JPEG.w
    const G = (pdf as any).GState
    pdf.saveGraphicsState()
    if (G) pdf.setGState(new G({ opacity: 0.055 }))
    pdf.addImage(LOGO_GZ28_JPEG.data, 'JPEG', (W - w) / 2, (H - h) / 2, w, h, 'logo', 'FAST')
    pdf.restoreGraphicsState()
  }
  watermark()
  ;(pdf.internal as any).events.subscribe('addPage', () => watermark())
  return { W, H, CW, fill, stroke, text, width }
}

// `.pi-header`: logo 156 px | company centered | number box on the right; 2 px black rule under it.
function header(pdf: jsPDF, k: ReturnType<typeof kit>, o: { company: any; label: string; number: string; lines: string[]; us: boolean }): number {
  const y0 = M, logoW = px(156), logoH = logoW * LOGO_GZ28_JPEG.h / LOGO_GZ28_JPEG.w
  const subs = [o.company?.address || '', `PHONE: ${o.company?.phone || ''} · EMAIL: ${o.company?.email || ''}`]
  if (o.us) subs.push('IG: @gz28us / @gz28br · FB: Dema De Maria')
  const nameH = px(13) * 1.25, subH = px(8) * 1.5
  const midH = nameH + px(2) + subs.length * subH
  let numSize = px(20); while (k.width(o.number, numSize, true) > px(156) + px(40) && numSize > px(12)) numSize -= 0.5
  const rightH = px(7) * 1.3 + numSize + o.lines.length * (px(8) * 1.3 + px(2))
  const hh = Math.max(logoH, midH, rightH)
  pdf.addImage(LOGO_GZ28_JPEG.data, 'JPEG', M, y0 + (hh - logoH) / 2, logoW, logoH, 'logo', 'FAST')
  let y = y0 + (hh - midH) / 2
  k.text(o.company?.name || 'GZ28 V8 SpeedShop USA LLC', k.W / 2, y, { size: px(13), bold: true, align: 'center', space: px(0.5) }); y += nameH + px(2)
  for (const s of subs) { k.text(s, k.W / 2, y, { size: px(8), color: C.grey5, align: 'center' }); y += subH }
  y = y0 + (hh - rightH) / 2
  k.text(o.label, k.W - M, y, { size: px(7), color: C.grey8, align: 'right', space: px(1), upper: true }); y += px(7) * 1.3
  k.text(o.number, k.W - M, y, { size: numSize, bold: true, color: C.red, align: 'right', space: px(1) }); y += numSize + px(2)
  for (const s of o.lines) { k.text(s, k.W - M, y, { size: px(8), color: C.grey5, align: 'right' }); y += px(8) * 1.3 + px(2) }
  const rule = y0 + hh + px(8)
  k.stroke(C.black); pdf.setLineWidth(px(2)); pdf.line(M, rule, k.W - M, rule)
  return rule + px(8) + px(2)
}

// `.pi-info-block`: grey hairline box, small grey title with a hairline under it, label (bold grey, 80 px) + value rows.
type InfoRow = [string, string]
function infoBlockHeight(pdf: jsPDF, w: number, rows: InfoRow[]): number {
  const valW = w - px(16) - px(80) - px(3), lh = px(8) * 1.3 + px(1)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(px(8))
  const lines = rows.reduce((n, r) => n + Math.max(1, pdf.splitTextToSize(pdfText(r[1]), valW).length), 0)
  return px(5) + px(7) * 1.3 + px(2) + px(3) + lines * lh + px(5)
}
function infoBlock(pdf: jsPDF, k: ReturnType<typeof kit>, x: number, y: number, w: number, h: number, title: string, rows: InfoRow[]) {
  k.stroke(C.line); pdf.setLineWidth(px(0.5)); pdf.roundedRect(x, y, w, h, px(3), px(3), 'S')
  let yy = y + px(5)
  k.text(title, x + px(8), yy, { size: px(7), bold: true, color: C.grey8, space: px(0.5), upper: true })
  yy += px(7) * 1.3 + px(2)
  k.stroke(C.line2); pdf.line(x + px(8), yy, x + w - px(8), yy); yy += px(3)
  const valW = w - px(16) - px(80) - px(3), lh = px(8) * 1.3 + px(1)
  for (const [lab, val] of rows) {
    k.text(lab + ':', x + px(8), yy, { size: px(8), bold: true, color: C.grey6 })
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(px(8))
    const ls = pdf.splitTextToSize(pdfText(val), valW) as string[]
    ls.forEach((l, i) => k.text(l, x + px(8) + px(80) + px(3), yy + i * lh, { size: px(8) }))
    yy += Math.max(1, ls.length) * lh
  }
}

// `.pi-sec-title`: the black bar over a table. Returns the y under it (starts a new page when the bar would be orphaned).
function secTitle(pdf: jsPDF, k: ReturnType<typeof kit>, y: number, title: string): number {
  const h = px(8) * 1.2 + 2 * px(3)
  if (y + h + 40 > k.H - M - 14) { pdf.addPage(); y = M }
  k.fill(C.black); pdf.rect(M, y, k.CW, h, 'F')
  k.text(title, M + px(8), y + px(3), { size: px(8), bold: true, color: C.white, space: px(1), upper: true })
  return y + h
}

// `.pi-table` base styles for jspdf-autotable
const tableBase = () => ({
  margin: { left: M, right: M, top: M, bottom: M + 14 }, theme: 'plain' as const, rowPageBreak: 'avoid' as const,   // never a row cut in half
  styles: { font: 'helvetica', fontSize: px(8), textColor: C.ink, cellPadding: { top: px(4), bottom: px(4), left: px(6), right: px(6) }, lineColor: C.cellLine, lineWidth: px(0.5), valign: 'top' as const, overflow: 'linebreak' as const },
  headStyles: { fillColor: C.head, fontStyle: 'bold' as const, fontSize: px(7), lineColor: C.headLine, lineWidth: px(0.5), textColor: C.ink },
  alternateRowStyles: { fillColor: C.zebra },
})
const cell = (content: string, styles: Record<string, any> = {}, colSpan?: number) => ({ content: pdfText(content), styles, ...(colSpan ? { colSpan } : {}) })
const R = { halign: 'right' as const }
const SUB = { fillColor: C.sub, fontStyle: 'bold' as const }
const BLACKROW = { fillColor: C.black, textColor: C.white, fontStyle: 'bold' as const, fontSize: px(9) }

function footer(pdf: jsPDF, k: ReturnType<typeof kit>, left: string, lang: Lang) {
  const n = pdf.getNumberOfPages()
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i)
    k.text(left, M, k.H - M - 8, { size: 6.5, color: [120, 120, 120] })
    k.text(`${L[lang].page} ${i}/${n}`, k.W - M, k.H - M - 8, { size: 6.5, color: [120, 120, 120], align: 'right' })
  }
}

export function revisionPdf(o: { document: any; seq: number; sha256: string; approval?: any | null; cert: CertMode; incomesPaid?: Record<number, boolean> }): Buffer {
  const d = o.document, lang: Lang = (d.language === 'pt' ? 'pt' : 'en'), T = L[lang], h = d.header || {}, tot = d.totals || {}
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const k = kit(pdf)
  const code = h.display_code || h.code || ''
  const us = !/Ltda/i.test(String(d.company?.name || ''))
  const hdrLines = [`${t(lang, 'rev')} ${o.seq}`]
  if (d.terms?.valid_until) hdrLines.push(`${t(lang, 'valid_until')} ${fmtDay(d.terms.valid_until, lang)}`)
  let y = header(pdf, k, { company: d.company, label: T.quoteNo, number: code, lines: hdrLines, us })

  // CLIENT | VEHICLE (`.pi-two-col`). Older snapshots (before 09/11) carry only the name and the car label.
  const cl = d.client || null, vh = d.vehicle || null
  const clientRows: InfoRow[] = [[T.name, cl?.name || h.client_name || '-']]
  if (cl?.address) clientRows.push([T.address, cl.address])
  if (cl?.city || cl?.state) clientRows.push([lang === 'pt' && cl?.country === 'ANGOLA' ? 'Cidade/Província' : T.cityst, [cl.city, cl.state].filter(Boolean).join(' / ') + (cl.zip ? ` ${cl.zip}` : '')])
  if (cl?.phone) clientRows.push([T.phone, formatPhone(cl.phone, cl.country)])
  if (cl?.email) clientRows.push([T.email, cl.email])
  const vehRows: InfoRow[] = []
  if (vh) {
    if (vh.make) vehRows.push([T.make, vh.make])
    if (vh.model) vehRows.push([T.model, vh.model])
    if (vh.year || vh.vin) vehRows.push([T.yearvin, [vh.year, vh.vin].filter(Boolean).join(' - ')])
    if (vh.color || vh.plate || vh.mileage) vehRows.push([T.colorplate, [vh.color, vh.plate, vh.mileage ? Number(vh.mileage).toLocaleString('en-US') : null].filter(Boolean).join(' - ')])
  } else if (h.car) vehRows.push([T.model, h.car])
  if (h.service) vehRows.push([T.pack, h.service])
  const colW = (k.CW - px(8)) / 2
  const bh = Math.max(infoBlockHeight(pdf, colW, clientRows), vehRows.length ? infoBlockHeight(pdf, colW, vehRows) : 0)
  infoBlock(pdf, k, M, y, colW, bh, T.clientT, clientRows)
  if (vehRows.length) infoBlock(pdf, k, M + colW + px(8), y, colW, bh, T.vehicle, vehRows)
  y += bh + px(8)

  // ITEMS / SERVICES (`.pi-sec` + `.pi-table`), kits grouped under their name, members indented — like the printable.
  const shown = (l: any) => l.display === 'price' ? money(l.total, lang) : (l.display === 'included' ? t(lang, 'included') : t(lang, 'courtesy')).toUpperCase()
  const unitShown = (l: any) => l.display === 'price' ? money(l.unit_price, lang) : shown(l)
  const items = (d.lines || []).filter((l: any) => l.kind !== 'service'), services = (d.lines || []).filter((l: any) => l.kind === 'service')
  const sumOf = (ls: any[]) => ls.reduce((s, l) => s + (Number(l.total) || 0), 0)
  // A section that adds up to ZERO says what its lines say, never «US$ 0.00» (09/11/2026, Márcio via Parts Chasing: the closed
  // package carries its price on the item, every service is INCLUDED → «Services Total INCLUDED»). Any line included → INCLUDED.
  const zeroTotal = (ls: any[], total: number) => Math.abs(total) > 0.005 ? money(total, lang)
    : (ls.some((l: any) => l.display === 'included') ? t(lang, 'included') : t(lang, 'courtesy')).toUpperCase()
  if (items.length) {
    y = secTitle(pdf, k, y, T.items)
    const body: any[] = [], seen = new Set<string>()
    for (const l of items) {
      if (l.kit_group && !seen.has(l.kit_group)) {
        seen.add(l.kit_group)
        const kt = sumOf(items.filter((x: any) => x.kit_group === l.kit_group))
        body.push([cell(l.kit_name || 'Kit', { fillColor: C.kit, fontStyle: 'bold' }, 3), cell(kt ? money(kt, lang) : t(lang, d.header?.has_package ? 'included' : 'courtesy').toUpperCase(),{ ...R, fillColor: C.kit, fontStyle: 'bold' })])
      }
      const bl = buyLink(l.buy_url)
      // the buy link sits on its own line under the description: the cell keeps a blank line for it, didDrawCell writes it blue + clickable
      const dc: any = cell(bl ? l.description + '\n ' : l.description, l.kit_group ? { cellPadding: { top: px(4), bottom: px(4), left: px(16), right: px(6) } } : {})
      if (bl) dc.buy = { url: bl.url, label: `${t(lang, 'buy')} > ${bl.host}` }
      body.push([dc, cell(unitShown(l), R), cell(String(l.quantity || 1), R), cell(shown(l), R)])
    }
    const itemsTotal = Number(tot.parts ?? sumOf(items))
    body.push([cell(T.subtotal, { ...R, ...SUB }, 3), cell(zeroTotal(items, itemsTotal), { ...R, ...SUB })])
    body.push([cell(T.itemsTotal, { ...R, ...BLACKROW }, 3), cell(zeroTotal(items, itemsTotal), { ...R, ...BLACKROW })])
    autoTable(pdf, { ...tableBase(), startY: y,
      head: [[T.desc, cell(T.unit, R), cell(T.qt, R), cell(T.total, R)].map(c => typeof c === 'string' ? pdfText(c.toUpperCase()) : { ...c, content: c.content.toUpperCase() })],
      body, columnStyles: { 0: { cellWidth: k.CW * 0.56 }, 1: { cellWidth: k.CW * 0.16 }, 2: { cellWidth: k.CW * 0.08 }, 3: { cellWidth: k.CW * 0.20 } },
      didDrawCell: (c: any) => {
        const bu = c.section === 'body' && c.column.index === 0 ? c.cell.raw?.buy : null
        if (!bu) return
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(px(7)); pdf.setTextColor(29, 78, 216)
        const x = c.cell.x + c.cell.padding('left'), yb = c.cell.y + c.cell.height - c.cell.padding('bottom') - px(1.5)
        pdf.textWithLink(bu.label, x, yb, { url: bu.url })
        pdf.setTextColor(C.ink[0], C.ink[1], C.ink[2])
      } })
    y = (pdf as any).lastAutoTable.finalY + px(7)
  }
  if (services.length) {
    y = secTitle(pdf, k, y, T.services)
    const body: any[] = services.map((l: any) => [cell(l.description), cell(shown(l), R)])
    body.push([cell(T.servicesTotal, { ...R, ...BLACKROW }), cell(zeroTotal(services, Number(tot.services ?? sumOf(services))), { ...R, ...BLACKROW })])
    autoTable(pdf, { ...tableBase(), startY: y,
      head: [[pdfText(T.desc.toUpperCase()), cell(T.total.toUpperCase(), R)]],
      body, columnStyles: { 0: { cellWidth: k.CW * 0.80 }, 1: { cellWidth: k.CW * 0.20 } } })
    y = (pdf as any).lastAutoTable.finalY + px(7)
  }

  // TOTALS (`.pi-totals-tbl`, 250 px, right): Items + Services · Discount (red) · FL tax / exempt · GRAND (navy, gold)
  const PS = { fillColor: C.ps, fontStyle: 'bold' as const }
  const tb: any[] = [[cell(T.itemsServices, PS), cell(money(Number(tot.subtotal ?? (Number(tot.parts || 0) + Number(tot.services || 0))), lang), { ...R, ...PS })]]
  if (Number(tot.discount) > 0) tb.push([cell(`${t(lang, 'discount')} (${tot.discount_pct}%)`, { ...PS, textColor: C.red }), cell(`- ${money(tot.discount, lang)}`, { ...R, ...PS, textColor: C.red })])
  if (tot.taxable) tb.push([cell(t(lang, 'fl_tax'), PS), cell(money(tot.fl_tax, lang), { ...R, ...PS })])
  else if (['EXPORT', 'OUT_OF_STATE', 'OVERRIDE_EXEMPT'].includes(String(tot.fl_status || ''))) tb.push([cell(lang === 'pt' ? 'Isento de imposto sobre vendas da Flórida' : 'Florida sales tax exempt', PS), cell('-', { ...R, ...PS })])
  const G = { fillColor: C.navy, textColor: C.gold, fontStyle: 'bold' as const, fontSize: px(11), cellPadding: { top: px(5), bottom: px(5), left: px(6), right: px(6) } }
  tb.push([cell(t(lang, 'grand_total'), G), cell(money(Number(tot.grand || 0), lang), { ...R, ...G })])
  const totW = px(250) * 1.25
  autoTable(pdf, { ...tableBase(), startY: y, margin: { left: k.W - M - totW, right: M, top: M, bottom: M + 14 }, tableWidth: totW,
    styles: { ...tableBase().styles, lineWidth: 0 }, alternateRowStyles: {}, body: tb, columnStyles: { 0: { cellWidth: totW * 0.6 }, 1: { cellWidth: totW * 0.4 } },
    didDrawCell: (c: any) => { if (c.section === 'body' && c.row.index === tb.length - 1 && c.column.index === 0) { k.stroke(C.gold); pdf.setLineWidth(px(2)); pdf.line(c.table.settings.margin.left, c.cell.y, c.table.settings.margin.left + totW, c.cell.y) } } })
  y = (pdf as any).lastAutoTable.finalY + px(7)

  // PAYMENT PLAN — same section look as the printable's PAYMENTS table
  const inst = d.installments || []
  if (inst.length) {
    y = secTitle(pdf, k, y, T.plan)
    const dueOf = (i: any) => i.due_date ? fmtDay(i.due_date, lang) : i.due_rule === 'NET_DAYS' && i.net_days != null ? T.net(Number(i.net_days)) : '-'
    const body: any[] = inst.map((i: any) => [cell(String(i.seq)), cell(i.label_text || i.label_key), cell(dueOf(i)),
      cell(moneyCents(i.amount_cents, lang) + (o.incomesPaid?.[i.seq] ? ` · ${t(lang, 'paid')}` : ''), R)])
    const sum = inst.reduce((s: number, i: any) => s + (Number(i.amount_cents) || 0), 0)
    body.push([cell(T.planTotal, { ...R, ...SUB }, 3), cell(moneyCents(sum, lang), { ...R, ...SUB })])
    autoTable(pdf, { ...tableBase(), startY: y,
      head: [['#', T.desc, T.due, cell(T.amount, R)].map(c => typeof c === 'string' ? pdfText(c.toUpperCase()) : { ...c, content: c.content.toUpperCase() })],
      body, columnStyles: { 0: { cellWidth: k.CW * 0.06 }, 1: { cellWidth: k.CW * 0.54 }, 2: { cellWidth: k.CW * 0.20 }, 3: { cellWidth: k.CW * 0.20 } } })
    y = (pdf as any).lastAutoTable.finalY + px(7)
  }

  // NOTES (`.pi-notes`: hairline box, centered)
  const room = (need: number) => { if (y + need > k.H - M - 18) { pdf.addPage(); y = M } }
  if (d.notes?.length) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(px(8))
    const ls: string[] = d.notes.flatMap((n: any) => pdf.splitTextToSize(pdfText(n.text), k.CW - px(24)) as string[])
    const lh = px(8) * 1.35, bh2 = px(6) + px(7) * 1.3 + px(4) + ls.length * lh + px(6)
    room(Math.min(bh2, 200))
    k.stroke(C.line); pdf.setLineWidth(px(0.5)); pdf.roundedRect(M, y, k.CW, bh2, px(3), px(3), 'S')
    let yy = y + px(6)
    k.text(T.notesT, k.W / 2, yy, { size: px(7), bold: true, color: C.grey8, align: 'center', space: px(0.5), upper: true }); yy += px(7) * 1.3 + px(4)
    for (const l of ls) { if (yy > k.H - M - 18) { pdf.addPage(); yy = M } k.text(l, k.W / 2, yy, { size: px(8), align: 'center' }); yy += lh }
    y = yy + px(6) + px(8)
  }

  // FL estimate, terms, certificate — small print in `.pi-info-block` boxes
  const block = (title: string, body: string) => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(px(8))
    const ls = pdf.splitTextToSize(pdfText(body), k.CW - px(16)) as string[]
    const lh = px(8) * 1.3
    room(px(5) + px(7) * 1.3 + px(5) + Math.min(ls.length, 4) * lh)
    const top = y
    k.text(title, M + px(8), y + px(5), { size: px(7), bold: true, color: C.grey8, space: px(0.5), upper: true })
    y += px(5) + px(7) * 1.3 + px(2); k.stroke(C.line2); pdf.setLineWidth(px(0.5)); pdf.line(M + px(8), y, k.W - M - px(8), y); y += px(3)
    let segTop = top
    for (const l of ls) {
      if (y + lh > k.H - M - 18) { k.stroke(C.line); pdf.roundedRect(M, segTop, k.CW, y + px(4) - segTop, px(3), px(3), 'S'); pdf.addPage(); y = M + px(4); segTop = M }
      k.text(l, M + px(8), y, { size: px(8), color: C.grey5 }); y += lh
    }
    y += px(5); k.stroke(C.line); pdf.setLineWidth(px(0.5)); pdf.roundedRect(M, segTop, k.CW, y - segTop, px(3), px(3), 'S')
    y += px(8)
  }
  block(t(lang, 'fl_estimate_title'), FL_ESTIMATE_TEXT[lang])
  block(t(lang, 'terms_title'), TERMS_TEXT[lang])
  const a = o.approval
  if (a && o.cert !== 'none') {
    const mask = (c: string | null) => !c ? '' : String(c).includes('@') ? String(c).replace(/^(.).*?(.)?@(.).*?\.(.*)$/, '$1•••$2@$3•••.$4') : '••' + String(c).replace(/\D/g, '').slice(-4)
    const lines = [
      `${a.signer_name} · ${t(lang, 'method.' + a.method)} · ${fmtStamp(a.signed_at, lang)} (Orlando) · UTC ${new Date(a.signed_at).toISOString()}`,
      `${t(lang, 'quote')} ${code} · ${t(lang, 'rev')} ${o.seq} · ${a.consent_version}`,
      `${t(lang, 'hash_hint')}: ${a.document_sha256}`,
      `Terms SHA-256: ${a.consent_text_sha256}`,
      `Elections: estimate ${a.consents?.estimate || '-'}${a.consents?.limit_amount ? ' (US$ ' + a.consents.limit_amount + ')' : ''} · replaced parts ${a.consents?.parts_return || '-'}`,
      o.cert === 'full'
        ? `Contact: ${a.signer_contact || '-'} · IP ${a.ip || '-'} · ${a.attribution?.city || ''} ${a.attribution?.country || ''} · ${a.attribution?.ua_class || ''} · gate ${a.attribution?.gate_tier || 'none'}${a.recorded_by ? ' · recorded by ' + a.recorded_by + ' — ' + (a.note || '') : ''}`
        : `Contact: ${mask(a.signer_contact)} · ${a.attribution?.city || ''}`,
    ]
    block(t(lang, 'certificate'), lines.join('\n'))
  }
  footer(pdf, k, `${code} · rev ${o.seq} · SHA-256 ${o.sha256.slice(0, 16)}…`, lang)
  return Buffer.from(pdf.output('arraybuffer'))
}

// The deposit RECEIPT, same paper: header with the red receipt number, CLIENT box, one black-bar table, the amount in the
// navy/gold row.
export function receiptPdf(o: { document: any; attempt: any; lang: Lang }): Buffer {
  const d = o.document, a = o.attempt, lang: Lang = o.lang === 'pt' ? 'pt' : 'en', T = L[lang], h = d.header || {}
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const k = kit(pdf)
  const code = h.display_code || h.code || ''
  const us = !/Ltda/i.test(String(d.company?.name || ''))
  let y = header(pdf, k, { company: d.company, label: T.receiptNo, number: `${code}-${a.seq ?? ''}`.replace(/-$/, ''), lines: [fmtStamp(a.succeeded_at, lang) + ' (Orlando)'], us })
  const cl = d.client || null
  const clientRows: InfoRow[] = [[T.name, cl?.name || h.client_name || '-']]
  if (cl?.phone) clientRows.push([T.phone, formatPhone(cl.phone, cl.country)])
  if (cl?.email) clientRows.push([T.email, cl.email])
  const docRows: InfoRow[] = [[lang === 'pt' ? 'Orçamento' : 'Quote', code]]
  if (h.car) docRows.push([T.vehicle, h.car])
  if (h.service) docRows.push([T.pack, h.service])
  const colW = (k.CW - px(8)) / 2
  const bh = Math.max(infoBlockHeight(pdf, colW, clientRows), infoBlockHeight(pdf, colW, docRows))
  infoBlock(pdf, k, M, y, colW, bh, T.clientT, clientRows)
  infoBlock(pdf, k, M + colW + px(8), y, colW, bh, lang === 'pt' ? 'Documento' : 'Document', docRows)
  y += bh + px(8)
  const inst = (d.installments || []).find((i: any) => Number(i.seq) === Number(a.seq))
  y = secTitle(pdf, k, y, T.payment)
  const G = { fillColor: C.navy, textColor: C.gold, fontStyle: 'bold' as const, fontSize: px(11), cellPadding: { top: px(5), bottom: px(5), left: px(6), right: px(6) } }
  autoTable(pdf, { ...tableBase(), startY: y,
    body: [
      [cell(T.installment, { fontStyle: 'bold', textColor: C.grey6 }), cell(inst ? `${inst.seq} · ${inst.label_text}` : String(a.seq ?? ''))],
      [cell(T.method, { fontStyle: 'bold', textColor: C.grey6 }), cell(`${a.provider}${a.method_type ? ' · ' + a.method_type : ''}${a.method_last4 ? ' ••' + a.method_last4 : ''}`)],
      [cell(T.date, { fontStyle: 'bold', textColor: C.grey6 }), cell(fmtStamp(a.succeeded_at, lang) + ' (Orlando)')],
      [cell(T.reference, { fontStyle: 'bold', textColor: C.grey6 }), cell(String(a.charge_id || a.id))],
      [cell(T.received, G), cell(moneyCents(Number(a.amount_cents), lang), { ...R, ...G })],
    ],
    columnStyles: { 0: { cellWidth: k.CW * 0.3 }, 1: { cellWidth: k.CW * 0.7 } } })
  footer(pdf, k, `${code} · ${lang === 'pt' ? 'recibo' : 'receipt'} ${a.seq ?? ''}`, lang)
  return Buffer.from(pdf.output('arraybuffer'))
}

export const pdfSha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
