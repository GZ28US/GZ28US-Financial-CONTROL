// SERVER-ONLY — CAR DEALS, etapa 2 (21/11/2026): a planilha no layout da TELA do Tripa, em .xlsx e .pdf.
// Márcio: «a planilha que geramos e atualizamos seja absolutamente idêntica à do Tripa». O que ele manda é print da tela
// do sistema dele (docs/car-deals-prototipo/prints-tripa-2026-11-21); o protótipo da sessão CC Sidney (gera.cjs) reproduz
// as 3 telas com as somas batendo no centavo — esta é a mesma grade, alimentada pelo banco em vez do arquivo de teste.
//
// Uma fonte (a grade lógica) e três saídas: JSON (prévia na tela), XLSX (exceljs) e PDF (jsPDF).
//
// De onde vem cada pedaço:
//   linha 1/2 ........ car_deals.sheet {title, headers, color_name, band_color, band_text_color, notes} (+ VIN do ride)
//   coluna A/B ....... deal_charges (valor em US$ ou o texto «Não vai ter», «Confirmar»)
//   pagamentos ....... deal_allocations deste deal cujo movimento sai do SIDNEY e está CONFIRMED
//                      (cor do lote = sheet_style.color; miudezas = sheet_style; ordem = sheet_position, depois a data)
//   notas à direita .. car_deals.sheet.notes quando preenchido; senão a nota «EDISON PAGOU $ X PARA DEMA», derivada dos
//                      movimentos Tripa Trading → GZ28US alocados ao deal
//   rodapé ........... Total do veiculo (soma dos custos) · Total pago (soma dos pagamentos) · Saldo a pagar
import type { SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'
import { dealNumber } from '@/lib/carDeals'

const AZUL = '#0433FF', VERDE_T = '#2BE32B', VERDE_F = '#00F900', CINZA = '#D9D9D9', GRADE = '#A6A6A6', R = '#E8231A', AMARELO = '#FFF24A', K = '#000000'
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
const HEADERS_PADRAO = ['CUSTO VEICULO', 'DÓLAR', 'PAGAMENTOS', 'DESTINATÁRIO', 'PAGAMENTOS', 'ORIGEM', '']

export type Cel = { v?: string | null; n?: number | null; fmt?: 'usd' | 'brl'; c?: string; b?: boolean; i?: boolean; fill?: string; al?: 'left' | 'right' | 'center'; wrap?: boolean; rich?: [string, string, boolean][] }
export type DealSheet = { fileName: string; title: string; grid: Cel[][]; total: number; paid: number; balance: number; payments: number; hash: string }

const cents = (n: number) => Math.round(n * 100) / 100
const cel = (v: string | null, o: Partial<Cel> = {}): Cel => ({ v, ...o })
const num = (n: number, fmt: 'usd' | 'brl', o: Partial<Cel> = {}): Cel => ({ v: null, n, fmt, al: 'right', ...o })
const money = (n: number, prefix: string) => `${prefix} ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const usdNote = (n: number) => `$ ${Math.round(n).toLocaleString('pt-BR')}`

// VISÃO: 'SIDNEY' tira TODA nota da direita (a perna Tripa Trading ↔ GZ28US não vai a grupo com o cliente — no RedHot
// o Sidney nem sabe que o carro é do Tripa/Edison). 'GZ28' e 'TRIPA' levam a planilha inteira.
export type SheetView = 'GZ28' | 'TRIPA' | 'SIDNEY'
export async function buildDealSheet(db: SupabaseClient, dealId: string, view: SheetView = 'GZ28'): Promise<DealSheet | null> {
  // carro e cliente vêm da invoice de compra; a aparência da planilha mora em car_deals.sheet (um jsonb)
  const { data: deal } = await db.from('car_deals').select('*, invoices:purchase_invoice_id(client_id, rides(project_code, project_name, vin, color)), rides(client_id, project_code, project_name, vin, color)').eq('id', dealId).maybeSingle()
  if (!deal) return null
  const inv = (deal as any).invoices || {}
  const look = (deal as any).sheet || {}
  const ride = inv.rides || (deal as any).rides || {}   // sem invoice de compra, o carro vem do ride do deal
  const clientId = inv.client_id || ride.client_id || null
  const [{ data: charges }, { data: allocs }, { data: client }] = await Promise.all([
    db.from('deal_charges').select('*').eq('deal_id', dealId).order('position'),
    db.from('deal_allocations').select('*, deal_movements(*)').eq('deal_id', dealId),
    clientId ? db.from('clients').select('name').eq('id', clientId).maybeSingle() : Promise.resolve({ data: null as any }),
  ])
  const confirmed = (allocs || []).filter((a: any) => a.deal_movements?.status === 'CONFIRMED')

  // pagamentos do cliente: movimentos que saem do SIDNEY (sheet_style.hide tira a linha da planilha sem tirar do livro)
  const pays = confirmed
    .filter((a: any) => a.deal_movements.from_party === 'SIDNEY' && !(a.sheet_style || {}).hide)
    .sort((a: any, b: any) => (a.sheet_position ?? 1e9) - (b.sheet_position ?? 1e9)
      || String(a.deal_movements.occurred_on).localeCompare(String(b.deal_movements.occurred_on))
      || String(a.created_at).localeCompare(String(b.created_at)))
  // o que a Tripa Trading já repassou ao GZ28US por conta deste carro
  const tripaToGz = cents(confirmed.filter((a: any) => a.deal_movements.from_party === 'TRIPA_TRADING' && a.deal_movements.to_party === 'GZ28US')
    .reduce((s: number, a: any) => s + (Number(a.amount_usd) || 0), 0))

  const hd = look.headers
  const headers: string[] = Array.isArray(hd) ? hd : Array.isArray(hd?.headers) ? hd.headers : HEADERS_PADRAO
  const italic = Array.isArray(hd) ? true : hd?.italic !== false
  const firstName = String(client?.name || '').trim().split(/\s+/)[0] || ''
  const title = look.title || `${firstName.toUpperCase()}  ${dealNumber(deal.deal_no)}`.trim()
  const band = look.band_color || K, bandTxt = look.band_text_color || '#C9F23A'
  const vin = ride.vin ? `VIN ${String(ride.vin).slice(-4)}` : ''
  const colorName = look.color_name || ride.color || ''

  const L: Cel[][] = []
  const blank = () => Array.from({ length: 10 }, () => cel(''))
  L.push([cel(title, { c: VERDE_T, b: true, fill: AZUL }), ...Array.from({ length: 7 }, (_, k) => cel(headers[k] || '', { c: VERDE_T, b: true, i: italic, fill: AZUL })), cel('', { fill: VERDE_F }), cel('', { fill: VERDE_F })])
  L.push([cel(colorName, { c: bandTxt, b: true, fill: band }), ...Array.from({ length: 7 }, () => cel(vin, { c: bandTxt, b: true, fill: band })), cel(''), cel('')])
  L.push(Array.from({ length: 10 }, (_, k) => cel('', k === 0 ? { fill: CINZA } : {})))

  const custos = charges || []
  const n = Math.max(custos.length, pays.length)
  const body: Cel[][] = []
  let paid = 0
  for (let k = 0; k < n; k++) {
    const row = blank(), cu = custos[k], a = pays[k]
    row[0] = cel(cu ? cu.label : '', { b: true, fill: CINZA })
    if (cu && cu.amount_usd != null) row[1] = num(Number(cu.amount_usd), 'usd')
    else if (cu && cu.text_value) row[1] = cel(cu.text_value, { c: R })
    if (a) {
      const m = a.deal_movements, raw = a.sheet_style || {}
      // as chaves valem nas duas grafias (a carga da CC Sidney gravou usd_color / origin_centered / dest_bold…)
      const st = { ...raw, usdColor: raw.usdColor ?? raw.usd_color, usdBold: raw.usdBold ?? raw.usd_bold, destBold: raw.destBold ?? raw.dest_bold, center: raw.center ?? raw.origin_centered, remarkColor: raw.remarkColor ?? raw.remark_color, remarkBold: raw.remarkBold ?? raw.remark_bold }
      const cor = st.color || K, corUsd = st.usdColor || cor
      const rate = m.amount_brl != null && Number(m.amount_usd) ? Math.round(Number(m.amount_brl) / Number(m.amount_usd) * 100) / 100 : null   // a taxa é conta: R$ ÷ US$
      const usd = Number(a.amount_usd) || 0
      const whole = Math.abs(usd - (Number(m.amount_usd) || 0)) < 0.005
      const brl = m.amount_brl != null ? (whole ? Number(m.amount_brl) : cents(Number(m.amount_brl) * usd / (Number(m.amount_usd) || 1))) : null
      const thin = !!st.thin, hasRate = rate != null
      paid += usd
      if (hasRate) row[2] = num(rate!, 'usd', { c: corUsd })
      row[3] = num(usd, 'usd', { c: corUsd, b: !!st.usdBold })
      row[4] = cel(m.counterparty_label || '', { c: cor, b: !!st.destBold || (!thin && hasRate) })
      if (brl != null) row[5] = num(brl, 'brl', { c: cor, b: !thin })
      if (m.payer_label) row[6] = cel(m.payer_label, { c: cor, b: !thin, al: st.center ? 'center' : 'left' })
      if (st.badge) row[5] = cel(String(st.badge), { c: AMARELO, fill: R })
      if (st.remark) row[5] = cel(String(st.remark), { c: st.remarkColor || R, b: st.remarkBold !== false, wrap: true })
    }
    body.push(row)
  }
  // linhas vazias até a altura mínima da tela dele
  const pad = Math.max(1, 11 - n)
  for (let k = 0; k < pad; k++) body.push(Array.from({ length: 10 }, (_, j) => cel('', j === 0 && k < pad - 1 ? { fill: CINZA } : {})))

  // notas à direita
  const notes: any[] = Array.isArray(look.notes) ? look.notes : []
  if (view === 'SIDNEY') { /* sem notas */ } else if (notes.length) {
    for (const nt of notes) {
      const r = Number(nt.row) || 0, c = COLS.indexOf(String(nt.col || '').toUpperCase())
      if (c < 0 || !body[r]) continue
      body[r][c] = Array.isArray(nt.rich) ? cel(nt.rich.map((x: any) => x[0]).join(''), { rich: nt.rich }) : cel(String(nt.text || ''), { c: nt.color || K, b: !!nt.bold, wrap: !!nt.wrap })
    }
  } else if (tripaToGz > 0 && body[0]) {
    body[0][7] = cel('EDISON PAGOU', { c: R, b: true })
    body[0][8] = cel(`${usdNote(tripaToGz)} PARA`, { c: R, b: true })
    body[0][9] = cel('DEMA', { c: R, b: true })
  }
  L.push(...body)

  const total = cents(custos.reduce((s: number, c: any) => s + (Number(c.amount_usd) || 0), 0))
  paid = cents(paid)
  const balance = cents(total - paid)
  const tot = blank(); tot[0] = cel('Total do veiculo', { c: R, b: true }); tot[1] = num(total, 'usd'); L.push(tot)
  const pg = blank(); pg[0] = cel('Total pago', { c: R, b: true }); pg[3] = num(paid, 'usd'); L.push(pg)
  const sd = blank(); sd[0] = cel('Saldo a pagar', { c: R, b: true }); sd[4] = num(balance, 'usd', { c: balance > 0 ? R : K, b: true })
  if (balance > 0) sd[5] = cel('DEVEMOS', { c: AMARELO, fill: R })
  L.push(sd)

  const fileName = `COMPRA ${dealNumber(deal.deal_no) || '—'} - ${ride.project_name || ride.project_code || 'car'}${vin ? ` ${vin}` : ''}`.replace(/[\\/:*?"<>|]/g, ' ')
  // hash do conteúdo: planilha igual não é repostada (idempotência do robô)
  const { createHash } = await import('crypto')
  const hash = createHash('sha256').update(JSON.stringify(L)).digest('hex').slice(0, 32)
  return { fileName, title, grid: L, total, paid, balance, payments: pays.length, hash }
}

const argb = (h: string) => 'FF' + h.replace('#', '').toUpperCase()
const shown = (c: Cel) => c.n != null ? money(c.n, c.fmt === 'brl' ? 'R$' : 'US$') : c.rich ? c.rich.map(x => x[0]).join('') : (c.v || '')

export async function dealSheetXlsx(s: DealSheet): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(s.title.replace(/\s+/g, ' ').replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Compra', { views: [{ showGridLines: false }] })
  ws.columns = COLS.map(() => ({ width: 22 }))
  const borda = { style: 'thin' as const, color: { argb: argb(GRADE) } }
  s.grid.forEach((row, r) => {
    const xr = ws.getRow(r + 1)
    xr.height = row.some(c => c.wrap) ? 34 : 20
    row.forEach((c, k) => {
      const x = xr.getCell(k + 1)
      if (c.n != null) { x.value = c.n; x.numFmt = c.fmt === 'brl' ? '"R$" #,##0.00' : '"US$" #,##0.00' }
      else if (c.rich) x.value = { richText: c.rich.map(([t, cor, b]) => ({ text: t, font: { name: 'Arial', size: 11, bold: !!b, color: { argb: argb(cor) } } })) }
      else x.value = c.v || null
      x.font = { name: 'Arial', size: 11, bold: !!c.b, italic: !!c.i, color: { argb: argb(c.c || K) } }
      if (c.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(c.fill) } }
      x.alignment = { vertical: 'middle', horizontal: c.al || 'left', wrapText: !!c.wrap }
      x.border = { top: borda, left: borda, bottom: borda, right: borda }
    })
  })
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 9, margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0, footer: 0 } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const rgb = (h: string): [number, number, number] => { const x = h.replace('#', ''); return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)] }

// PDF: a mesma grade, desenhada célula a célula numa página do tamanho da planilha (uma página só, como a tela).
export function dealSheetPdf(s: DealSheet): Buffer {
  const M = 8, CW = 38.4, RH = 6.9
  const heights = s.grid.map(row => row.some(c => c.wrap) ? RH * 1.7 : RH)
  const W = M * 2 + CW * 10, H = M * 2 + heights.reduce((a, b) => a + b, 0)
  const doc = new jsPDF({ orientation: W >= H ? 'landscape' : 'portrait', unit: 'mm', format: [W, H] })
  doc.setLineWidth(0.15)
  let y = M
  s.grid.forEach((row, r) => {
    const h = heights[r]
    row.forEach((c, k) => {
      const x = M + k * CW
      doc.setDrawColor(...rgb(GRADE))
      if (c.fill) { doc.setFillColor(...rgb(c.fill)); doc.rect(x, y, CW, h, 'FD') } else doc.rect(x, y, CW, h, 'S')
      const text = shown(c)
      if (!text) return
      doc.setFontSize(10.5)
      const baseY = y + (c.wrap ? 4.4 : h / 2 + 1.3)
      if (c.rich) {
        let cx = x + 1.4
        for (const [t, cor, b] of c.rich) {
          doc.setFont('helvetica', b ? 'bold' : 'normal'); doc.setTextColor(...rgb(cor)); doc.text(t, cx, baseY); cx += doc.getTextWidth(t)
        }
        return
      }
      doc.setFont('helvetica', c.b && c.i ? 'bolditalic' : c.b ? 'bold' : c.i ? 'italic' : 'normal')
      doc.setTextColor(...rgb(c.c || K))
      if (c.wrap) { doc.text(doc.splitTextToSize(text, CW - 2.8), x + 1.4, baseY); return }
      // texto que não cabe encolhe até caber (a tela dele corta; no papel é melhor ler)
      let size = 10.5
      while (size > 6 && doc.getTextWidth(text) > CW - 2.8) { size -= 0.5; doc.setFontSize(size) }
      if (c.al === 'right') doc.text(text, x + CW - 1.4, baseY, { align: 'right' })
      else if (c.al === 'center') doc.text(text, x + CW / 2, baseY, { align: 'center' })
      else doc.text(text, x + 1.4, baseY)
    })
    y += h
  })
  return Buffer.from(doc.output('arraybuffer'))
}
