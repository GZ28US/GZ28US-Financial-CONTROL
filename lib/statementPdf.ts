'use client'

// PDF das demonstrações financeiras — relatório de verdade, não screenshot.
// jsPDF + autotable (já eram dependência da invoice) desenham tabela vetorial:
// arquivo pequeno, texto selecionável, imprime nítido. O logo vem de
// public/logo_gz28.jpg e NUNCA é distorcido — a largura sai da proporção real
// do arquivo (regra da marca).
import { BASE_PATH } from '@/lib/utils'

export type StatementTable = {
  title?: string
  head: string[]
  rows: { cells: string[]; bold?: boolean; section?: boolean }[]
}

const INK = [17, 17, 17] as [number, number, number]
const MUTED = [110, 110, 110] as [number, number, number]
const RED = [176, 47, 43] as [number, number, number]

async function logoData(): Promise<{ data: string; ratio: number } | null> {
  try {
    const res = await fetch(`${BASE_PATH}/logo_gz28.jpg`)
    if (!res.ok) return null
    const blob = await res.blob()
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result)); r.onerror = reject
      r.readAsDataURL(blob)
    })
    const ratio = await new Promise<number>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth / img.naturalHeight)
      img.onerror = () => resolve(1)
      img.src = data
    })
    return { data, ratio }
  } catch { return null }
}

export async function downloadStatementPdf(o: {
  filename: string
  title: string
  subtitle: string
  kpis: [string, string][]
  tables: StatementTable[]
  notes?: string[]
  landscape?: boolean
}) {
  const { jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const doc: any = new jsPDF({ unit: 'pt', format: 'letter', orientation: o.landscape ? 'landscape' : 'portrait' })
  const pageW = doc.internal.pageSize.getWidth()
  const M = 40

  // Cabeçalho: logo (proporção intocada) + empresa à direita.
  const logo = await logoData()
  if (logo) doc.addImage(logo.data, 'JPEG', M, M, 34 * logo.ratio, 34)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...MUTED)
  doc.text('GZ28 V8 SPEEDSHOP USA LLC', pageW - M, M + 8, { align: 'right' })
  doc.setFontSize(8); doc.setFont('helvetica', 'normal')
  doc.text('www.gz28us.com', pageW - M, M + 20, { align: 'right' })

  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(20)
  doc.text(o.title, M, M + 62)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED)
  doc.text(o.subtitle, M, M + 78)

  // Linha de KPIs.
  let y = M + 104
  const kpiW = (pageW - M * 2) / o.kpis.length
  o.kpis.forEach(([label, value], i) => {
    const x = M + i * kpiW
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...MUTED)
    doc.text(label.toUpperCase(), x, y)
    doc.setFontSize(13); doc.setTextColor(...(value.startsWith('-') ? RED : INK))
    doc.text(value, x, y + 16)
  })
  y += 34

  // Tabelas (vetoriais). Negativo fica vermelho; linha bold vira subtotal cinza.
  for (const t of o.tables) {
    if (t.title) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK)
      doc.text(t.title, M, y + 14); y += 20
    }
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [t.head],
      body: t.rows.map(r => r.cells),
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: o.landscape ? 7 : 8.5, textColor: INK as any, cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 }, lineColor: [225, 225, 225] as any, lineWidth: { bottom: 0.5 } as any },
      headStyles: { fontStyle: 'bold', textColor: MUTED as any, fontSize: o.landscape ? 6.5 : 7.5, lineColor: [17, 17, 17] as any, lineWidth: { bottom: 1 } as any },
      columnStyles: Object.fromEntries(t.head.map((_, i) => [i, { halign: i === 0 ? 'left' : 'right' } as any])),
      didParseCell: (data: any) => {
        if (data.section !== 'body') return
        const row = t.rows[data.row.index]
        if (row?.bold) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [243, 241, 237] }
        if (row?.section) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.textColor = MUTED }
        const raw = String(data.cell.raw || '')
        if (raw.startsWith('-$') || raw.startsWith('(')) data.cell.styles.textColor = RED
      },
    })
    y = doc.lastAutoTable.finalY + 18
  }

  // Notas de rodapé + numeração.
  if (o.notes?.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED)
    for (const note of o.notes) {
      const lines = doc.splitTextToSize('· ' + note, pageW - M * 2)
      doc.text(lines, M, y); y += lines.length * 9 + 3
    }
  }
  const pages = doc.getNumberOfPages()
  const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(7); doc.setTextColor(...MUTED)
    doc.text(`Emitido ${stamp} — GZ28US Control App`, M, doc.internal.pageSize.getHeight() - 20)
    doc.text(`${i} / ${pages}`, pageW - M, doc.internal.pageSize.getHeight() - 20, { align: 'right' })
  }
  doc.save(o.filename)
}
