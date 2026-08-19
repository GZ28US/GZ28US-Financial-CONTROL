// SERVER-ONLY — EXPENSE REPORT SAFETY NET (ordem do Márcio, 26/jul/2026):
// "NUNCA pode passar nenhuma expense sem report no grupo." Toda linha nova de
// invoice_expenses / invoice_payments / expenses (staff) — venha da UI, de
// scripts ou de qualquer automação — é reportada no grupo REPORTS. Dedup em
// stream_mail_moves (message_id = 'ern:<uuid>', sem FK). Para não duplicar o
// report que a própria UI já mandou, consulta o log de ENVIADAS do UltraMsg:
// se uma mensagem recente já carrega o mesmo valor formatado, só marca como
// reportada. Roda no mail-poll (cron 5min) — PC desligado incluso.

import type { SupabaseClient } from '@supabase/supabase-js'

// Só linhas criadas após a entrada da rede — histórico não é re-reportado.
const EPOCH = '2026-07-26T16:00:00Z'
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'

async function sendReport(body: string): Promise<boolean> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return false
  try {
    const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
    })
    return r.ok
  } catch { return false }
}

// Últimas mensagens ENVIADAS pela instância (dedup contra o report da própria UI).
async function recentSentBodies(): Promise<string[]> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return []
  try {
    const r = await fetch(`https://api.ultramsg.com/${instance}/messages?token=${token}&page=1&limit=60&status=sent`)
    const j = await r.json().catch(() => null)
    const list = Array.isArray(j) ? j : (j?.messages || [])
    return list.map((m: any) => String(m.body || ''))
  } catch { return [] }
}

// LEI do Márcio (01/ago/2026, após 47 linhas órfãs): "Se tem comprovante, está
// PAGA." Qualquer expense com receipt anexado e sem payment_date é marcada paga
// (payment_date = expense_date; sem expense_date, a data do lançamento entra nos
// dois campos). Roda ANTES da rede de reports para o report de PAGA sair junto.
// Quotes ficam fora (anexos de quote são referência de preço, não comprovante).
export async function enforceReceiptPaid(db: SupabaseClient): Promise<{ fixed: number }> {
  let fixed = 0
  const dateOf = (e: { expense_date?: string | null; created_at?: string | null }) =>
    e.expense_date || String(e.created_at || '').slice(0, 10)
  const patch = (e: { expense_date?: string | null }, d: string) =>
    e.expense_date ? { payment_date: d } : { payment_date: d, expense_date: d }

  const { data: se } = await db.from('expenses')
    .select('id, expense_date, created_at').not('receipt_url', 'is', null).is('payment_date', null)
  for (const e of (se || []) as any[]) {
    const d = dateOf(e); if (!d) continue
    const { error } = await db.from('expenses').update(patch(e, d)).eq('id', e.id)
    if (!error) fixed++
  }

  const { data: ie } = await db.from('invoice_expenses')
    .select('id, item, expense_date, created_at, receipt_url, invoices!inner(is_quote)')
    .not('receipt_url', 'is', null).is('payment_date', null).eq('invoices.is_quote', false)
  for (const e of (ie || []) as any[]) {
    if (!e.receipt_url || e.receipt_url === '[]') continue
    // EXCEÇÃO (19/ago, caso HHP #382526): compra CANCELADA/ESTORNADA fica
    // não-paga MESMO com recibo anexado — o recibo é de um pagamento que
    // voltou. O marcador [ESTORNADO]/[CANCELADO] no item blinda a linha.
    if (/^\[(ESTORNAD|CANCELAD)/i.test(String(e.item || ''))) continue
    const d = dateOf(e); if (!d) continue
    const { error } = await db.from('invoice_expenses').update(patch(e, d)).eq('id', e.id)
    if (!error) fixed++
  }

  const { data: fc } = await db.from('fixed_cost_expenses')
    .select('id, expense_date, created_at').not('receipt_url', 'is', null).is('payment_date', null)
  for (const e of (fc || []) as any[]) {
    const d = dateOf(e); if (!d) continue
    const { error } = await db.from('fixed_cost_expenses').update({ payment_date: d }).eq('id', e.id)
    if (!error) fixed++
  }

  return { fixed }
}

export async function runExpenseReportNet(db: SupabaseClient): Promise<{ reported: string[] }> {
  const out: string[] = []
  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'expense-report-net')
  const seenSet = new Set((seen || []).map((r: any) => r.message_id))
  const mark = async (key: string, label: string) =>
    db.from('stream_mail_moves').insert({ message_id: key, subject: label.slice(0, 120), from_addr: 'expense-report-net', folder_name: 'reported', state: 'REPORTED' })

  const sent = await recentSentBodies()
  const alreadySent = (amount: number) => sent.some((b) => b.includes(usd(amount)))

  // UNIVERSAL (Márcio, 01/ago/2026): "ENTROU ou SAIU $? REPORT. Alterações,
  // atualizações ou criação de RETROATIVO? Nada de report — não entrou nem
  // saiu $, é só controle." O termômetro é a DATA DO DINHEIRO: pagamento dos
  // últimos dias = movimento real → reporta; data antiga = registro de
  // histórico → marca em silêncio e cala.
  const RECENT_DAYS = 3
  const isRecentMoney = (d: string | null | undefined) => {
    if (!d) return false
    const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime()
    return Number.isFinite(t) && Date.now() - t < RECENT_DAYS * 86400e3
  }

  // 1) invoice_expenses — regra do Márcio (30/jul): reporta SÓ QUANDO PAGA
  // (payment_date preenchido), nunca no cadastro nem na exclusão. Linhas não
  // pagas ficam SEM marca — quando forem pagas, o report sai naquele momento.
  // Quotes nunca reportam (lei das quotes + enchente US.044.2).
  // Filtro por updated_at, não created_at (buraco achado 01/ago): linha ANTIGA
  // que vira paga hoje é dinheiro saindo hoje — "TODO E QUALQUER DINHEIRO QUE
  // DE FATO ENTRA OU SAI TEM QUE TER REPORT NO GRUPO."
  // LEI SAGRADA (Márcio, 10/ago, após a enchente de balões dos pedidos HHP):
  // "é SAGRADO reportar a que invoice e carro a expense/income se refere, e é
  // UM balão por COMPRA, mesmo que tenha vários itens. Compra com itens de
  // mais de um carro = um balão por compra POR CARRO." Agrupamento por
  // invoice + (order_number || supplier+data), com o carro/cliente no título.
  const { data: ie } = await db.from('invoice_expenses')
    .select('id, invoice_id, item, price, quantity, tax, extra, supplier, order_number, payment_date, created_at, invoices(invoice_code, is_quote, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).not('payment_date', 'is', null).order('created_at')
  const groups = new Map<string, any[]>()
  for (const e of (ie || []) as any[]) {
    if (seenSet.has(`ern:ie:${e.id}`)) continue
    if (e.invoices?.is_quote) continue
    const gk = `${e.invoice_id}|${e.order_number || `${e.supplier || ''}~${e.payment_date || ''}`}`
    const arr = groups.get(gk) || []; arr.push(e); groups.set(gk, arr)
  }
  const lineTotal = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
  const ownerOf = (inv: any) => inv?.rides?.project_name || inv?.rides?.project_code || inv?.clients?.name || ''
  for (const rows of groups.values()) {
    const e0 = rows[0]
    const total = rows.reduce((s, e) => s + lineTotal(e), 0)
    const owner = ownerOf(e0.invoices)
    const head = `*EXPENSE PAID* ${e0.invoices?.invoice_code || '—'}${owner ? ` — ${owner}` : ''}`
    const label = `EXPENSE ${e0.invoices?.invoice_code || '—'} ${usd(total)} (${rows.length} itens)`
    if (!alreadySent(total) && rows.some((e) => isRecentMoney(e.payment_date))) {
      const names = rows.map((e) => String(e.item || '').slice(0, 60))
      const itemsLine = rows.length === 1 ? names[0]
        : `${rows.length} itens: ${names.slice(0, 3).join(' · ')}${rows.length > 3 ? ` +${rows.length - 3}` : ''}`
      const srcLine = [e0.supplier, e0.order_number ? `pedido ${e0.order_number}` : ''].filter(Boolean).join(' — ')
      await sendReport([head, `${e0.payment_date || ''} — *${usd(total)}*`, srcLine, itemsLine].filter(Boolean).join('\n'))
      out.push(label)
    }
    for (const e of rows) await mark(`ern:ie:${e.id}`, label)
  }

  // 2) invoice_payments (incomes) — mesma regra: só quando o dinheiro ENTROU.
  // ATENÇÃO ao modelo (incidente QuickSilver 31/jul): em incomes, payment_date é
  // a data PREVISTA — quem marca "recebido" é paid_at. Previsões nunca reportam.
  const { data: ip } = await db.from('invoice_payments')
    .select('id, amount, payment_date, paid_at, description, created_at, invoices(invoice_code, is_quote, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).not('paid_at', 'is', null).order('created_at')
  for (const p of (ip || []) as any[]) {
    const key = `ern:ip:${p.id}`
    if (seenSet.has(key)) continue
    if (p.invoices?.is_quote) continue
    const owner = ownerOf(p.invoices)
    const label = `INCOME ${p.invoices?.invoice_code || '—'} ${usd(p.amount)}`
    const paidOn = String(p.paid_at || '').slice(0, 10) || p.payment_date || ''
    if (!alreadySent(Number(p.amount)) && isRecentMoney(paidOn)) {
      await sendReport([`*INCOME PAID* ${p.invoices?.invoice_code || '—'}${owner ? ` — ${owner}` : ''}`, `${paidOn} — *${usd(p.amount)}*`, String(p.description || '').slice(0, 160)].join('\n'))
      out.push(label)
    }
    await mark(key, label)
  }

  // 3) expenses (staff seasons) — mesma regra: reporta só quando PAGA.
  const { data: se } = await db.from('expenses')
    .select('id, amount, payment_date, description, created_at, seasons(season_code, staff(name))')
    .gte('updated_at', EPOCH).not('payment_date', 'is', null).order('created_at')
  for (const s of (se || []) as any[]) {
    const key = `ern:se:${s.id}`
    if (seenSet.has(key)) continue
    const who = s.seasons?.staff?.name || '—'
    const label = `EXPENSE STAFF ${s.seasons?.season_code || ''} ${usd(s.amount)}`
    if (!alreadySent(Number(s.amount)) && isRecentMoney(s.payment_date)) {
      await sendReport([`*EXPENSE PAID — STAFF* ${s.seasons?.season_code || '—'} — ${who}`, `${s.payment_date || ''} — *${usd(s.amount)}*`, String(s.description || '').slice(0, 160)].join('\n'))
      out.push(label)
    }
    await mark(key, label)
  }

  return { reported: out }
}
