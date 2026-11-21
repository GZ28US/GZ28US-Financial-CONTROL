// SERVER-ONLY — CONTA-CORRENTE: carga dos dados e as saídas em arquivo (21/11/2026). A regra das três versões mora em
// lib/statement.ts; aqui só se busca o banco e se escreve o Excel (no modelo do Antônio) e o PDF.
import type { SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { buildStatement, CLIENT_PARTY, type Statement, type StatementData, type StatementView } from '@/lib/statement'
import { loadInvoiceMoney } from '@/lib/invoiceMoney.server'
import { obligationDue } from '@/lib/carDeals'

const dayNY = (iso: unknown) => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(String(iso))) : ''

// Tudo o que a conta-corrente lê — nenhuma tabela própria. As invoices do cliente (pela regra R-22: client_id da invoice,
// senão o do carro), cada uma com o total faturado pela MESMA régua da tela da invoice (loadInvoiceMoney), as rendas
// delas, e do livro só os movimentos que tocam essas invoices.
export async function loadStatementData(db: SupabaseClient, clientId: string): Promise<StatementData & { client: any }> {
  const { data: client } = await db.from('clients').select('id, name').eq('id', clientId).maybeSingle()
  const { data: myRides } = await db.from('rides').select('id').eq('client_id', clientId)
  const rideIds = (myRides || []).map((r: any) => r.id)
  const cols = 'id, client_id, ride_id, is_quote, origin'
  const [byClient, byRide] = await Promise.all([
    db.from('invoices').select(cols).eq('client_id', clientId).eq('is_quote', false),
    rideIds.length ? db.from('invoices').select(cols).in('ride_id', rideIds).is('client_id', null).eq('is_quote', false) : Promise.resolve({ data: [] as any[] }),
  ])
  const ids = [...new Set([...(byClient.data || []), ...(byRide.data || [])].filter((i: any) => i.origin !== 'BUCKET').map((i: any) => i.id))] as string[]
  const { data: dealsRaw } = ids.length ? await db.from('car_deals').select('id, deal_no, purchase_invoice_id').in('purchase_invoice_id', ids) : { data: [] as any[] }
  const deals = dealsRaw || []
  const dealNoOf = new Map<string, string>(deals.map((d: any) => [d.purchase_invoice_id, d.deal_no]))
  const invoices: any[] = [], incomes: any[] = []
  for (let i = 0; i < ids.length; i += 8) {
    const bundles = await Promise.all(ids.slice(i, i + 8).map(id => loadInvoiceMoney(db, id)))
    for (const b of bundles) {
      if (!b) continue
      const inv = b.invoice
      invoices.push({ id: inv.id, invoice_code: inv.invoice_code, service: inv.service, kind: inv.kind, origin: inv.origin,
        date: inv.hiring_date || inv.client_hiring_date || inv.entry_date || dayNY(inv.created_at), grand: b.money.grand,
        ride: b.ride ? { id: b.ride.id, model: b.ride.model, color: b.ride.color, project_code: b.ride.project_code } : null, dealNo: dealNoOf.get(inv.id) || null })
      for (const r of b.incomes) incomes.push({ id: r.id, invoice_id: r.invoice_id, amount: r.amount, description: r.description, amount_brl: r.amount_brl,
        paid: !!r.paid_at, date: r.payment_date || dayNY(r.paid_at), due: r.payment_date || null })
    }
  }
  // do livro: alocações que apontam para uma renda ou para um deal deste cliente → os movimentos delas → TODAS as alocações deles
  const incIds = incomes.map(i => i.id), dealIds = deals.map((d: any) => d.id)
  const movIds = new Set<string>()
  for (let i = 0; i < incIds.length; i += 150) { const { data } = await db.from('deal_allocations').select('movement_id').in('invoice_income_id', incIds.slice(i, i + 150)); for (const x of data || []) movIds.add(x.movement_id) }
  if (dealIds.length) { const { data } = await db.from('deal_allocations').select('movement_id').in('deal_id', dealIds); for (const x of data || []) movIds.add(x.movement_id) }
  const mids = [...movIds], movements: any[] = [], allocations: any[] = []
  for (let i = 0; i < mids.length; i += 150) {
    const [m, al] = await Promise.all([db.from('deal_movements').select('*').in('id', mids.slice(i, i + 150)), db.from('deal_allocations').select('*').in('movement_id', mids.slice(i, i + 150))])
    movements.push(...(m.data || [])); allocations.push(...(al.data || []))
  }
  return { client, invoices, incomes, movements, allocations, deals }
}

// O que ainda vai entrar: rendas não recebidas das invoices do cliente (com data = programado; sem data = em aberto na
// conta-corrente) e obrigações de deal que saem dele (vencimento calculado: data ou marco).
export function scheduleOf(d: StatementData, obligations: any[], milestones: any[]): { date: string | null; what: string; amount: number; source: string }[] {
  const invById = new Map<string, any>(d.invoices.map(i => [i.id, i]))
  const out: { date: string | null; what: string; amount: number; source: string }[] = []
  for (const r of d.incomes) if (!r.paid) out.push({ date: r.due, what: [invById.get(r.invoice_id)?.invoice_code || '', r.description || invById.get(r.invoice_id)?.service || 'payment'].join(' — '), amount: Number(r.amount) || 0, source: 'invoice' })
  for (const o of obligations) {
    if (o.cancelled || o.from_party !== CLIENT_PARTY) continue
    const deal = d.deals.find((x: any) => x.id === o.deal_id)
    if (!deal) continue
    out.push({ date: obligationDue(o, milestones).date, what: [deal.deal_no || 'deal', o.label].join(' — '), amount: Number(o.amount_usd) || 0, source: 'deal' })
  }
  return out.sort((x, y) => (x.date ? 0 : 1) - (y.date ? 0 : 1) || String(x.date || '').localeCompare(String(y.date || '')))
}
export async function loadSchedule(db: SupabaseClient, d: StatementData) {
  const dealIds = d.deals.map((x: any) => x.id)
  if (!dealIds.length) return scheduleOf(d, [], [])
  const [o, m] = await Promise.all([db.from('deal_obligations').select('*').in('deal_id', dealIds), db.from('deal_milestones').select('*').in('deal_id', dealIds)])
  return scheduleOf(d, o.data || [], m.data || [])
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
      { formula: n === 2 ? 'E2+F2' : `G${n - 1}+E${n}+F${n}`, result: r.balance }, null, r.brl, r.obs || null]
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
  foot.value = `Fonte: GZ28US Control App — conta-corrente de ${o.clientName}${o.view === 'ACCOUNTANT' ? ', sem as linhas pessoais' : ''} — atualizada em ${brDate(o.asOf)}. Saldo por fórmula; centavos podem diferir em US$ 0,01 do arredondamento.`
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
    body: st.rows.map(r => [r.car, r.code, brDate(r.date), r.item, usd(r.debit), usd(r.credit), usd(r.balance), '', brl(r.brl), r.obs]),
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
