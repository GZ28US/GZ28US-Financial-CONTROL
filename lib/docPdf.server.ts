/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the quote/invoice PDF of the portal (06/11/2026; blueprint M2 §8.2). Vector PDF (jsPDF) built ONLY from the frozen
// revision snapshot (`invoice_revisions.document`) — never from live rows — so the paper is exactly what the client saw and
// signed. Light, letter size. The certificate block is MASKED on the client copy (contact, IP → city) and FULL on the staff copy
// (Fla. §668.50(8) retainable record). A deposit receipt PDF per paid attempt. Nothing here sends anything.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { createHash } from 'node:crypto'
import { t, money, moneyCents, TERMS_TEXT, FL_ESTIMATE_TEXT, type Lang } from './quoteStrings'
import { fmtDay, fmtStamp } from './orlando'

// Helvetica (WinAnsi) has no glyph for some marks — map them, never print a broken glyph.
const pdfText = (s: unknown) => String(s ?? '')
  .replace(/[—–]/g, '-').replace(/[•·]/g, '·').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/§/g, 'Sec. ')
  .replace(/[✓✔]/g, 'OK').replace(/[✍📦🏁⏳⚠✖]/gu, '').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF·]/g, '')

export type CertMode = 'public' | 'full' | 'none'

export function revisionPdf(o: { document: any; seq: number; sha256: string; approval?: any | null; cert: CertMode; incomesPaid?: Record<number, boolean> }): Buffer {
  const d = o.document, lang: Lang = (d.language || 'en') as Lang, h = d.header || {}, tot = d.totals || {}
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = pdf.internal.pageSize.getWidth(), M = 44
  let y = 48
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.text(pdfText(d.company?.name || 'GZ28 V8 SpeedShop USA LLC'), M, y)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5)
  pdf.text(pdfText(`${d.company?.address || ''} · ${d.company?.phone || ''} · ${d.company?.email || ''}`), M, y + 13)
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11)
  pdf.text(pdfText(`${t(lang, 'quote').toUpperCase()} ${h.display_code || h.code} · ${t(lang, 'rev')} ${o.seq}`), W - M, y, { align: 'right' })
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5)
  if (d.terms?.valid_until) pdf.text(pdfText(`${t(lang, 'valid_until')} ${fmtDay(d.terms.valid_until, lang)}`), W - M, y + 13, { align: 'right' })
  y += 40
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.text(pdfText(h.car || h.service || ''), M, y)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5)
  if (h.car) pdf.text(pdfText(h.service || ''), M, y + 14)
  pdf.text(pdfText(h.client_name || ''), W - M, y, { align: 'right' })
  y += 28
  const label = (l: any) => l.display === 'price' ? money(l.total, lang) : l.display === 'included' ? t(lang, 'included') : t(lang, 'courtesy')
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M }, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 4, textColor: 20 }, headStyles: { fillColor: [30, 30, 30], textColor: 255 },
    head: [[pdfText(t(lang, 'whats_included')), lang === 'pt' ? 'Qtd' : 'Qty', 'US$']],
    body: (d.lines || []).map((l: any) => [pdfText((l.kind === 'service' ? '· ' : '') + l.description), String(l.quantity || 1), pdfText(label(l))]),
    columnStyles: { 1: { halign: 'center', cellWidth: 40 }, 2: { halign: 'right', cellWidth: 110 } },
  })
  y = (pdf as any).lastAutoTable.finalY + 10
  const row = (k: string, v: string, bold = false) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.text(pdfText(k), W - M - 200, y); pdf.text(pdfText(v), W - M, y, { align: 'right' }); y += 13 }
  pdf.setFontSize(9)
  if (Number(tot.discount) > 0) { row(t(lang, 'subtotal'), money(tot.subtotal, lang)); row(`${t(lang, 'discount')} (${tot.discount_pct}%)`, `- ${money(tot.discount, lang)}`) }
  row(t(lang, 'fl_tax'), tot.taxable ? money(tot.fl_tax, lang) : `${t(lang, 'fl_exempt')}`)
  row(t(lang, 'grand_total'), money(Number(tot.grand || 0), lang), true)
  y += 6
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.text(pdfText(t(lang, 'payment_plan')), M, y + 4); y += 8
  autoTable(pdf, {
    startY: y, margin: { left: M, right: M }, theme: 'plain', styles: { fontSize: 8.5, cellPadding: 3 },
    body: (d.installments || []).map((i: any) => [String(i.seq), pdfText(i.label_text || i.label_key), pdfText(moneyCents(i.amount_cents, lang) + (o.incomesPaid?.[i.seq] ? ` · ${t(lang, 'paid')}` : ''))]),
    columnStyles: { 0: { cellWidth: 24 }, 2: { halign: 'right' } },
  })
  y = (pdf as any).lastAutoTable.finalY + 8
  if (d.notes?.length) {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5); pdf.text(pdfText(t(lang, 'notes')), M, y); y += 11
    pdf.setFont('helvetica', 'normal')
    for (const n of d.notes) { const ls = pdf.splitTextToSize(pdfText('· ' + n.text), W - 2 * M); if (y + ls.length * 10 > 740) { pdf.addPage(); y = 48 } pdf.text(ls, M, y); y += ls.length * 10 + 2 }
  }
  const block = (title: string, body: string) => {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); if (y > 700) { pdf.addPage(); y = 48 } pdf.text(pdfText(title), M, y); y += 10
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5)
    for (const ls of pdf.splitTextToSize(pdfText(body), W - 2 * M)) { if (y > 750) { pdf.addPage(); y = 48 } pdf.text(ls, M, y); y += 9 }
    y += 6
  }
  y += 4
  block(t(lang, 'fl_estimate_title'), FL_ESTIMATE_TEXT[lang])
  block(t(lang, 'terms_title'), TERMS_TEXT[lang])
  const a = o.approval
  if (a && o.cert !== 'none') {
    const mask = (c: string | null) => !c ? '' : String(c).includes('@') ? String(c).replace(/^(.).*?(.)?@(.).*?\.(.*)$/, '$1•••$2@$3•••.$4') : '••' + String(c).replace(/\D/g, '').slice(-4)
    const lines = [
      `${a.signer_name} · ${t(lang, 'method.' + a.method)} · ${fmtStamp(a.signed_at, lang)} (Orlando) · UTC ${new Date(a.signed_at).toISOString()}`,
      `${t(lang, 'quote')} ${h.display_code || h.code} · ${t(lang, 'rev')} ${o.seq} · ${a.consent_version}`,
      `${t(lang, 'hash_hint')}: ${a.document_sha256}`,
      `Terms SHA-256: ${a.consent_text_sha256}`,
      `Elections: estimate ${a.consents?.estimate || '-'}${a.consents?.limit_amount ? ' (US$ ' + a.consents.limit_amount + ')' : ''} · replaced parts ${a.consents?.parts_return || '-'}`,
      o.cert === 'full'
        ? `Contact: ${a.signer_contact || '-'} · IP ${a.ip || '-'} · ${a.attribution?.city || ''} ${a.attribution?.country || ''} · ${a.attribution?.ua_class || ''} · gate ${a.attribution?.gate_tier || 'none'}${a.recorded_by ? ' · recorded by ' + a.recorded_by + ' — ' + (a.note || '') : ''}`
        : `Contact: ${mask(a.signer_contact)} · ${a.attribution?.city || ''}`,
    ]
    block(t(lang, 'certificate'), lines.join('\n'))
  }
  pdf.setFontSize(7); pdf.setTextColor(120)
  pdf.text(pdfText(`${h.display_code || h.code} · rev ${o.seq} · SHA-256 ${o.sha256.slice(0, 16)}…`), M, 770)
  return Buffer.from(pdf.output('arraybuffer'))
}

export function receiptPdf(o: { document: any; attempt: any; lang: Lang }): Buffer {
  const d = o.document, a = o.attempt, lang = o.lang, h = d.header || {}
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const M = 44
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13); pdf.text(pdfText(d.company?.name || 'GZ28 V8 SpeedShop USA LLC'), M, 52)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.text(pdfText(`${d.company?.address || ''} · ${d.company?.phone || ''}`), M, 65)
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16); pdf.text(lang === 'pt' ? 'RECIBO' : 'RECEIPT', M, 110)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10)
  const inst = (d.installments || []).find((i: any) => Number(i.seq) === Number(a.seq))
  const rows = [
    [lang === 'pt' ? 'Documento' : 'Document', `${h.display_code || h.code} · ${h.service || ''}`],
    [lang === 'pt' ? 'Cliente' : 'Client', h.client_name || ''],
    [lang === 'pt' ? 'Parcela' : 'Installment', inst ? `${inst.seq} · ${inst.label_text}` : String(a.seq ?? '')],
    [lang === 'pt' ? 'Valor' : 'Amount', moneyCents(Number(a.amount_cents), lang)],
    [lang === 'pt' ? 'Meio' : 'Method', `${a.provider}${a.method_type ? ' · ' + a.method_type : ''}${a.method_last4 ? ' ••' + a.method_last4 : ''}`],
    [lang === 'pt' ? 'Data' : 'Date', fmtStamp(a.succeeded_at, lang) + ' (Orlando)'],
    [lang === 'pt' ? 'Referência' : 'Reference', a.charge_id || a.id],
  ]
  autoTable(pdf, { startY: 128, margin: { left: M, right: M }, theme: 'plain', styles: { fontSize: 10, cellPadding: 5 }, body: rows.map(r => r.map(pdfText)), columnStyles: { 0: { fontStyle: 'bold', cellWidth: 120 } } })
  return Buffer.from(pdf.output('arraybuffer'))
}

export const pdfSha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
