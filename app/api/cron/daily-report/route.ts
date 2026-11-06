import { NextRequest, NextResponse } from 'next/server'
import { streamDb, sendStreamWhatsApp } from '@/lib/stream.server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { semMarcacao } from '@/lib/waMentions'

// TEXTO DE FORA NESTE RELATÓRIO (11/set/2026). Este cron manda pro GRUPO REPORTS
// pelo sendStreamWhatsApp → enviaUltra, que monta o campo `mentions` a partir do
// corpo. Dois campos aqui não são escritos na tela do app: `invoice_expenses.item`
// (o AutoBook o escreve a partir do e-mail da loja) e `invoice_duties.description`
// (quem digita é o funcionário, na página pública do duty). Os dois passam por
// `semMarcacao` — SEMPRE depois do corte, porque o corte pode criar um "@numero"
// que o texto inteiro não tinha. O resto (invoice_code, project_code, nome de
// staff, nome de fornecedor fixo) é rótulo que ele mesmo digitou na tela.

// DAILY MEGA-REPORT — every day at 4am Orlando (Vercel cron, runs with the PC
// off) the REPORTS WhatsApp group gets the company's whole day: development
// highlights (daily_log), money in/out with the day's net, Staff Duties,
// registrations, STREAM and APPS. Ordered by the user 2026-07-25.

export const maxDuration = 60

const mmdd = (d: unknown) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : '—' }
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export async function GET(req: NextRequest) {
  // PORTÃO (11/set/2026): cada chamada manda o report de novo no grupo REPORTS, sem dedupe — e a rota
  // atendia qualquer anônimo. Só entra o cron da Vercel (Bearer CRON_SECRET) ou a chave de leitura.
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = streamDb()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const sinceDay = since.slice(0, 10)
  const day = new Date(Date.now() - 4 * 3600 * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const lines: string[] = []

  // ── DEV — session highlights logged by the assistant (best-effort table).
  try {
    const { data: dev } = await db.from('daily_log').select('line').gte('created_at', since).order('created_at')
    if (dev?.length) {
      lines.push('🖥 *DEVELOPMENT / WORK DONE*')
      for (const d of dev as any[]) lines.push(`  • ${String(d.line).slice(0, 90)}`)
      lines.push('')
    }
  } catch { /* table may not exist yet */ }

  // ── SÓ DINHEIRO DE VERDADE (Márcio, 06/11/2026): «teach this robot to report only money that comes in or goes out, not
  // predictions! These are not real incomes or expenses». Em 06/11 o report disse IN US$ 112.850 (2 payments) e NET verde:
  // eram o sinal e o saldo do BilletSilver, lançados A RECEBER na véspera, sem um dólar na conta — a soma era por created_at.
  //   • IN  = invoice_incomes com paid_at (a BAIXA) dentro da janela; sem espelho (mirror_expense_id) e sem invoice de
  //     orçamento. Igual à régua do lib/financials.ts («agendado ainda não é caixa») e ao report BR.
  //   • OUT = linha com payment_date na janela, sem orçamento.
  //   • O que foi REGISTRADO no dia continua aparecendo, cada linha com o status (paid dd/mm · NOT PAID YET · scheduled),
  //     pra ninguém ler lançamento como dinheiro.
  //   • ORÇAMENTO (is_quote) não entra em nada: nem rides novas, nem invoices novas (lei de 06/11: quote = no income, no reports).
  const isQuote = (e: any) => e.invoices?.is_quote === true
  // PORTAL DE QUOTE (06/11/2026): documento de TESTE (quote_links.is_test) não entra em NADA deste report — estrutural, não chave.
  const { data: testLinks } = await db.from('quote_links').select('invoice_id').eq('is_test', true)
  const testInv = new Set(((testLinks || []) as any[]).map(l => l.invoice_id))
  const isTest = (e: any) => testInv.has(e.invoice_id)
  const { data: payRaw } = await db.from('invoice_incomes')
    .select('amount, paid_at, mirror_expense_id, invoice_id, invoices(invoice_code, is_quote)')
    .gte('paid_at', since)
  const pay = ((payRaw || []) as any[]).filter((p) => p.paid_at && !p.mirror_expense_id && !isQuote(p) && !isTest(p))
  const inTotal = pay.reduce((s, p: any) => s + (Number(p.amount) || 0), 0)

  // ── MONEY OUT — everything PAID in the window (by payment date).
  // Balde do Bank Link (AUTO-BOOK fase B, 4/set/2026): a pseudo-invoice A ATRIBUIR
  // (invoices.origin = 'BUCKET') carrega compra REAL paga no dia do banco, ainda
  // sem dono. É caixa que saiu — entra no OUT, mas em número próprio, pra
  // ninguém ler o balde como custo de carro.
  const isBucket = (e: any) => e.invoices?.origin === 'BUCKET'
  const { data: paidExpRaw } = await db.from('invoice_expenses')
    .select('item, price, invoices(invoice_code, origin, is_quote)')
    .gte('payment_date', sinceDay)
  const paidExp = ((paidExpRaw || []) as any[]).filter((e) => !isQuote(e))
  const { data: paidFix } = await db.from('fixed_cost_expenses')
    .select('amount, fixed_cost_suppliers(description, cost_type)')
    .gte('payment_date', sinceDay)
  const { data: paidStaff } = await db.from('staff_expenses')
    .select('amount, description')
    .gte('payment_date', sinceDay)
  const outExp = (paidExp || []).filter((e: any) => !isBucket(e)).reduce((s, e: any) => s + (Number(e.price) || 0), 0)
  const outBucket = (paidExp || []).filter(isBucket).reduce((s, e: any) => s + (Number(e.price) || 0), 0)
  const outFix = (paidFix || []).reduce((s, e: any) => s + (Number(e.amount) || 0), 0)
  const outStaff = (paidStaff || []).reduce((s, e: any) => s + (Number(e.amount) || 0), 0)
  const outTotal = outExp + outBucket + outFix + outStaff

  lines.push('💰 *MONEY FLOW* (real cash only — received or paid in the last 24h)')
  lines.push(`  IN: ${usd(inTotal)}${pay.length ? ` (${pay.length} ${pay.length === 1 ? 'receipt' : 'receipts'})` : ''}`)
  for (const p of pay) lines.push(`    • ${p.invoices?.invoice_code || '—'} — ${usd(p.amount)}`)
  lines.push(`  OUT: ${usd(outTotal)} (invoices ${usd(outExp)} · a atribuir ${usd(outBucket)} · fixed/apps ${usd(outFix)} · staff ${usd(outStaff)})`)
  lines.push(`  NET: ${inTotal - outTotal >= 0 ? '🟢' : '🔴'} ${usd(inTotal - outTotal)}`)
  lines.push('')

  // ── STAFF DUTIES — completed and opened in the window.
  const { data: dutyDone } = await db.from('invoice_duties')
    .select('description, staff(name), invoices(invoice_code)')
    .eq('done', true).gte('updated_at', since)
  const { data: dutyNew } = await db.from('invoice_duties')
    .select('description, staff(name), invoices(invoice_code)')
    .gte('created_at', since)
  if (dutyDone?.length || dutyNew?.length) {
    lines.push('👷 *STAFF DUTIES*')
    for (const d of (dutyDone || []).slice(0, 6) as any[]) lines.push(`  ✅ ${(d.staff?.name || '—')} — ${semMarcacao(String(d.description || '').slice(0, 55))} (${d.invoices?.invoice_code || '—'})`)
    if ((dutyDone || []).length > 6) lines.push(`  ✅ …and ${(dutyDone || []).length - 6} more done`)
    if (dutyNew?.length) lines.push(`  🆕 ${dutyNew.length} new duties opened`)
    lines.push('')
  }

  // ── REGISTRATIONS — expenses recorded on invoices (regardless of paid).
  // O balde fica fora do top-5 (o motor cria dezenas por rodada e engoliria a
  // lista) e vira UMA linha própria: quantas compras esperam dono, e quanto.
  const { data: exp } = await db.from('invoice_expenses')
    .select('item, price, payment_date, invoices(invoice_code, origin, is_quote)')
    .gte('created_at', since).order('price', { ascending: false })
  const expHuman = ((exp || []) as any[]).filter((e) => !isBucket(e) && !isQuote(e))
  const expBucket = ((exp || []) as any[]).filter(isBucket)
  if (expHuman.length || expBucket.length) {
    const total = expHuman.reduce((s, e: any) => s + (Number(e.price) || 0), 0)
    lines.push(`🧾 *${expHuman.length} ${expHuman.length === 1 ? 'expense' : 'expenses'} registered* (${usd(total)}) — bookkeeping, not cash`)
    for (const e of expHuman.slice(0, 5)) lines.push(`  • ${(e.invoices?.invoice_code || '—')} — ${semMarcacao(String(e.item || '').slice(0, 45))} — ${usd(e.price)} · ${e.payment_date ? `paid ${mmdd(e.payment_date)}` : 'NOT PAID YET'}`)
    if (expHuman.length > 5) lines.push(`  • …and ${expHuman.length - 5} more`)
    if (expBucket.length) lines.push(`  • compras a atribuir: ${expBucket.length} (${usd(expBucket.reduce((s, e: any) => s + (Number(e.price) || 0), 0))})`)
    lines.push('')
  }

  // ── INCOMES REGISTERED — lançados no dia, cada um com o status (received dd/mm · scheduled dd/mm · not received).
  // Aqui mora o «A RECEBER»: aparece como previsão, nunca como IN.
  const { data: incNew } = await db.from('invoice_incomes')
    .select('amount, paid_at, payment_date, mirror_expense_id, invoice_id, installment_id, invoices(invoice_code, is_quote)')
    .gte('created_at', since).order('amount', { ascending: false })
  // uma linha do PLANO ainda não paga (installment_id, sem paid_at) é previsão — vai dobrada na linha 🏁 HIRED, nunca aqui
  const incHuman = ((incNew || []) as any[]).filter((p) => !p.mirror_expense_id && !isQuote(p) && !isTest(p) && !(p.installment_id && !p.paid_at))
  if (incHuman.length) {
    const total = incHuman.reduce((s, p: any) => s + (Number(p.amount) || 0), 0)
    lines.push(`💵 *${incHuman.length} ${incHuman.length === 1 ? 'income' : 'incomes'} registered* (${usd(total)}) — bookkeeping, not cash`)
    for (const p of incHuman.slice(0, 5)) lines.push(`  • ${(p.invoices?.invoice_code || '—')} — ${usd(p.amount)} · ${p.paid_at ? `received ${mmdd(p.paid_at)}` : p.payment_date ? `scheduled ${mmdd(p.payment_date)}, NOT RECEIVED` : 'NOT RECEIVED'}`)
    if (incHuman.length > 5) lines.push(`  • …and ${incHuman.length - 5} more`)
    lines.push('')
  }

  // ── APPS charges captured.
  const apps = ((paidFix || []) as any[]).filter((f) => f.fixed_cost_suppliers?.cost_type === 'APP')
  if (apps.length) {
    lines.push(`📱 *APPS*: ${apps.length} charges (${usd(apps.reduce((s, f) => s + Number(f.amount || 0), 0))}) — ${[...new Set(apps.map((f) => f.fixed_cost_suppliers?.description))].join(', ')}`)
    lines.push('')
  }

  // ── STREAM movement: MORTO (STREAM LEGADO MORTO, NÃO APAGADO (Márcio, 30/ago/2026): "quero ele) — o
  // quadro velho não recebe mais movimento; o status dos itens vive na origem.

  // ── 🏁 HIRED (portal) e ⚠ DISPUTA / FALHA DEPOIS DA COMPENSAÇÃO — dinheiro que se mexeu, estrutural (sem chave).
  const { data: hev } = await db.from('invoice_events').select('invoice_id, kind, payload, at').in('kind', ['HIRED', 'DISPUTE_OPENED', 'DEPOSIT_FAILED']).gte('at', since)
  for (const e of ((hev || []) as any[]).filter(x => !testInv.has(x.invoice_id))) {
    const p = e.payload || {}
    if (e.kind === 'HIRED') { const am = (p.plan?.amounts || []) as number[]; lines.push(`🏁 *HIRED* ${p.invoice_code_before || p.old_code || ''} → ${p.new_code || '(same car)'} · plan: ${am.length} × ${am.map(a => usd(a)).join(' / ')} (1 received)`) }
    else lines.push(`⚠ *${e.kind === 'DISPUTE_OPENED' ? 'DISPUTE' : 'FAILED AFTER SETTLEMENT'}* — ${p.amount_cents ? usd(Number(p.amount_cents) / 100) : ''} · open /doc`)
  }

  // ── New invoices / rides.
  const { data: invRaw } = await db.from('invoices').select('id, invoice_code').gte('created_at', since).neq('is_quote', true)
  const inv = ((invRaw || []) as any[]).filter((i) => !testInv.has(i.id))
  if (inv.length) lines.push(`🧾 *New invoices*: ${inv.map((i) => i.invoice_code).join(', ')}`)
  const { data: rid } = await db.from('rides').select('project_code, project_name').gte('created_at', since).neq('is_quote', true)
  if (rid?.length) lines.push(`🚗 *New rides*: ${(rid as any[]).map((r) => `${r.project_code} ${r.project_name}`).join(', ')}`)

  // First-ever edition (Jul 26, 2026) opens with a presentation; self-expires.
  const isFirstRun = new Date().toISOString().slice(0, 10) === '2026-07-26'
  const intro = isFirstRun
    ? `👋 *Bom dia! Este é o novo DAILY MEGA-REPORT da GZ28US.*\nA partir de hoje, todos os dias às 4am, este grupo recebe o resumo completo do dia da empresa: desenvolvimento no sistema, entradas e saídas de dinheiro com o saldo do dia, Staff Duties, registros, pedidos em trânsito (STREAM) e cobranças de APPS. Tudo automático, direto do Control App.\n\n`
    : ''
  const body = `${intro}📋 *DAILY MEGA-REPORT — ${day}*\n\n${lines.join('\n').trim() || 'Quiet day — no activity recorded.'}`
  // ?dry=1 (06/11/2026, quote portal §9 #4): builds the body and returns it — sends NOTHING. Proves what the 03:00 run would say.
  if (req.nextUrl.searchParams.get('dry') === '1') return NextResponse.json({ ok: true, dry: true, lines: lines.length, body })
  await sendStreamWhatsApp(body)
  return NextResponse.json({ ok: true, lines: lines.length })
}
