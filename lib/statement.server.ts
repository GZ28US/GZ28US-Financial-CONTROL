// SERVER-ONLY — CONTA-CORRENTE: carga dos dados e as saídas em arquivo (21/11/2026). A regra das três versões mora em
// lib/statement.ts; aqui só se busca o banco e se escreve o Excel (no modelo do Antônio) e o PDF.
import type { SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { buildStatement, CLIENT_PARTY, type Statement, type StatementData, type StatementView } from '@/lib/statement'

async function all(db: SupabaseClient, table: string, build: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db.from(table).select('*')).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
}

export async function loadStatementData(db: SupabaseClient, clientId: string): Promise<StatementData & { client: any }> {
  const { data: client } = await db.from('clients').select('id, name').eq('id', clientId).maybeSingle()
  const [charges, movements, deals] = await Promise.all([
    all(db, 'statement_charges', q => q.eq('client_id', clientId).order('charged_on').order('id')),
    all(db, 'deal_movements', q => q.eq('client_id', clientId).order('occurred_on').order('id')),
    all(db, 'car_deals', q => q.order('id')),
  ])
  const ids = movements.map(m => m.id)
  const allocations: any[] = []
  for (let i = 0; i < ids.length; i += 150) allocations.push(...await all(db, 'deal_allocations', q => q.in('movement_id', ids.slice(i, i + 150)).order('id')))
  const rideIds = [...new Set([...charges.map(c => c.ride_id), ...allocations.map(a => a.ride_id), ...deals.map(d => d.ride_id)].filter(Boolean))] as string[]
  const rides: any[] = []
  for (let i = 0; i < rideIds.length; i += 150) {
    const { data } = await db.from('rides').select('id, project_code, project_name, model, version, color, vin, statement_name').in('id', rideIds.slice(i, i + 150))
    rides.push(...(data || []))
  }
  return { client, charges, movements, allocations, rides, deals }
}

// O que está programado ou em aberto, fora do saldo: rendas ainda não recebidas das invoices do cliente e obrigações
// de deal que saem dele. Com data = «programado»; sem data = «conta-corrente».
export async function loadSchedule(db: SupabaseClient, clientId: string): Promise<{ date: string | null; what: string; amount: number; source: string }[]> {
  const out: { date: string | null; what: string; amount: number; source: string }[] = []
  const { data: invs } = await db.from('invoices').select('id, invoice_code, service').eq('client_id', clientId).eq('is_quote', false)
  const byId = new Map<string, any>((invs || []).map((i: any) => [i.id, i]))
  const invIds = [...byId.keys()]
  for (let i = 0; i < invIds.length; i += 150) {
    const { data } = await db.from('invoice_incomes').select('id, invoice_id, amount, payment_date, description, paid_at').in('invoice_id', invIds.slice(i, i + 150)).is('paid_at', null)
    for (const r of data || []) out.push({ date: r.payment_date || null, what: `${byId.get(r.invoice_id)?.invoice_code || ''} — ${r.description || byId.get(r.invoice_id)?.service || 'payment'}`, amount: Number(r.amount) || 0, source: 'invoice' })
  }
  const { data: deals } = await db.from('car_deals').select('id, deal_no').eq('client_id', clientId)
  const dealIds = (deals || []).map((d: any) => d.id)
  if (dealIds.length) {
    const { data: obs } = await db.from('deal_obligations').select('*').in('deal_id', dealIds).eq('from_party', CLIENT_PARTY).in('status', ['OPEN', 'DUE'])
    for (const o of obs || []) out.push({ date: o.due_date || null, what: `${(deals || []).find((d: any) => d.id === o.deal_id)?.deal_no || 'deal'} — ${o.label}`, amount: Number(o.amount_usd) || 0, source: 'deal' })
  }
  return out.sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date || '').localeCompare(String(b.date || '')))
}

const USD = '[$US$-409] #,##0.00;[Red]-[$US$-409] #,##0.00'
const HEAD = ['CARRO', 'CÓDIGO', 'DATA', 'ITEM', 'DÉBITO (US$)', 'CRÉDITO (US$)', 'SALDO (US$)', '# NF', 'R$ DEPOSITADO', 'OBS']
const brDate = (iso: string) => { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }

// O Excel no MODELO DO ANTÔNIO: cabeçalho azul, crédito em verde-claro, SALDO por FÓRMULA (não valor colado), linha
// TOTAIS e rodapé com a data. Quem abrir e mexer numa linha vê o saldo recalcular.
export async function statementXlsx(st: Statement, o: { asOf: string; view: StatementView; clientName: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Conta Corrente', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [24, 12, 12, 52, 17.9, 19.2, 17.2, 9, 16, 40].map(width => ({ width }))
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }
  const hr = ws.getRow(1); hr.height = 23.25
  HEAD.forEach((h, k) => {
    const c = hr.getCell(k + 1); c.value = h
    c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = border
  })
  st.rows.forEach((r, i) => {
    const n = i + 2, row = ws.getRow(n)
    const m = r.date.match(/^(\d{4})-(\d{2})-(\d{2})/)
    const vals: any[] = [r.car, r.code, m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null, r.item, r.debit, r.credit,
      { formula: n === 2 ? 'E2+F2' : `G${n - 1}+E${n}+F${n}`, result: r.balance }, r.nf || null, r.brl, r.obs || null]
    vals.forEach((v, k) => {
      const c = row.getCell(k + 1); c.value = v ?? null
      c.font = { name: 'Arial', size: 10 }; c.border = border
      if (r.kind === 'CREDIT') c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }
      if (k === 2) { c.numFmt = 'mm-dd-yy'   /* o formato do modelo dele: data curta, que o Excel mostra no idioma de quem abre */; c.alignment = { horizontal: 'center' } }
      if (k >= 4 && k <= 6) c.numFmt = USD
      if (k === 8) c.numFmt = '"R$" #,##0.00'
      if (k === 3 || k === 9) c.alignment = { wrapText: true, vertical: 'top' }
    })
  })
  const last = st.rows.length + 1, t = last + 2
  if (st.rows.length) {
    const tr = ws.getRow(t)
    const put = (col: number, value: any, fmt?: string) => { const c = tr.getCell(col); c.value = value; c.font = { name: 'Arial', size: 10, bold: true }; c.border = border; if (fmt) c.numFmt = fmt }
    put(4, 'TOTAIS')
    put(5, { formula: `SUM(E2:E${last})`, result: st.debit }, USD)
    put(6, { formula: `SUM(F2:F${last})`, result: st.credit }, USD)
    put(7, { formula: `G${last}`, result: st.balance }, USD)
    put(9, { formula: `SUM(I2:I${last})`, result: st.brl }, '"R$" #,##0.00')
  }
  const foot = ws.getRow(t + 1).getCell(4)
  foot.value = `Fonte: GZ28US Control App — conta-corrente de ${o.clientName}${o.view === 'ACCOUNTANT' ? ', sem as linhas pessoais (controle à parte)' : ''} — atualizada em ${brDate(o.asOf)}. Saldo por fórmula; centavos podem diferir em US$ 0,01 do arredondamento.`
  foot.font = { name: 'Arial', size: 9, italic: true }
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.75, right: 0.75, top: 1, bottom: 1, header: 0.5, footer: 0.5 } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const usd = (n: number | null) => n == null ? '' : `${n < 0 ? '-' : ''}US$ ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const brl = (n: number | null) => n == null ? '' : `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function statementPdf(st: Statement, o: { asOf: string; view: StatementView; clientName: string }): Buffer {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' })
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(`CONTA CORRENTE — ${o.clientName}`, 10, 12)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`Atualizada em ${brDate(o.asOf)} · saldo ${usd(st.balance)}`, 10, 17)
  autoTable(doc, {
    startY: 21, margin: { left: 10, right: 10 }, styles: { fontSize: 7, cellPadding: 1.2, overflow: 'linebreak', lineColor: [120, 120, 120], lineWidth: 0.1 },
    headStyles: { fillColor: [31, 78, 120], textColor: 255, halign: 'center' },
    head: [HEAD],
    body: st.rows.map(r => [r.car, r.code, brDate(r.date), r.item, usd(r.debit), usd(r.credit), usd(r.balance), r.nf, brl(r.brl), r.obs]),
    foot: [['', '', '', 'TOTAIS', usd(st.debit), usd(st.credit), usd(st.balance), '', brl(st.brl), '']],
    footStyles: { fillColor: [235, 235, 235], textColor: 0, fontStyle: 'bold' }, showFoot: 'lastPage',
    columnStyles: { 0: { cellWidth: 30 }, 1: { cellWidth: 17 }, 2: { cellWidth: 16, halign: 'center' }, 3: { cellWidth: 62 }, 4: { cellWidth: 24, halign: 'right' }, 5: { cellWidth: 24, halign: 'right' }, 6: { cellWidth: 25, halign: 'right' }, 7: { cellWidth: 11 }, 8: { cellWidth: 22, halign: 'right' } },
    didParseCell: (h) => {
      if (h.section !== 'body') return
      const r = st.rows[h.row.index]
      if (r?.kind === 'CREDIT') h.cell.styles.fillColor = [226, 239, 218]
      if ((h.column.index === 4 || h.column.index === 6) && String(h.cell.raw).startsWith('-')) h.cell.styles.textColor = [200, 0, 0]
    },
  })
  return Buffer.from(doc.output('arraybuffer'))
}

export async function statementFor(db: SupabaseClient, clientId: string, view: StatementView, rideId?: string) {
  const data = await loadStatementData(db, clientId)
  return { data, statement: buildStatement(data, view, { rideId }) }
}
