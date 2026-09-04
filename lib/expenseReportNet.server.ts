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
// O mesmo remetente em toda marca desta rede — é por ele que a rede acha o que já reportou.
const NET_FROM = 'expense-report-net'

// LEITURA PAGINADA (AUTO-BOOK fase B, 4/set/2026). O supabase-js corta em 1.000
// linhas EM SILÊNCIO. Com o balde A ATRIBUIR criando centenas de despesas
// pagas, tanto as marcas (stream_mail_moves) quanto invoice_expenses desde a
// EPOCH passam do corte — e linha que não chega aqui é linha que a rede não
// marca e vai REPORTAR de novo quando a marca correspondente ficar de fora.
// Loop de .range() até vir página curta. `build` devolve um builder NOVO a
// cada chamada (com a ordem dentro — ordem estável é o que faz página valer).
// Erro no meio corta a leitura no que já veio (o mesmo que `data ?? []` de antes).
// Generics do builder são profundos demais (TS2589): `any` deliberado e local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageAll(build: () => any): Promise<any[]> {
  const PAGE = 1000
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error || !data) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

// A marca de "já reportada" — uma forma só, gravada por quem quer que reporte
// (a rede e a atribuição do Bank Link), pra dedup nunca depender de quem escreveu.
async function markReported(db: SupabaseClient, key: string, label: string): Promise<void> {
  await db.from('stream_mail_moves').insert({ message_id: key, subject: label.slice(0, 120), from_addr: NET_FROM, folder_name: 'reported', state: 'REPORTED' })
}

// Valor da linha e dono da invoice — os mesmos da rede e do balão de atribuição.
const lineTotal = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
const ownerOf = (inv: any) => inv?.rides?.project_name || inv?.rides?.project_code || inv?.clients?.name || ''

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
    // receipt_proves_payment TEM de vir no select (conferido em 30/ago/2026):
    // sem ele a guarda logo abaixo comparava undefined === false e NUNCA
    // disparava — a blindagem existia no banco e estava morta no código.
    .select('id, item, expense_date, created_at, receipt_url, receipt_proves_payment, invoices!inner(is_quote)')
    .not('receipt_url', 'is', null).is('payment_date', null).eq('invoices.is_quote', false)
  for (const e of (ie || []) as any[]) {
    if (!e.receipt_url || e.receipt_url === '[]') continue
    // EXCEÇÃO (19/ago, caso HHP #382526): compra CANCELADA/ESTORNADA fica
    // não-paga MESMO com recibo anexado — o recibo é de um pagamento que
    // voltou. O marcador [ESTORNADO]/[CANCELADO] no item blinda a linha.
    //
    // EXCEÇÃO 2 (26/ago, caso TAG #178871-D): documento anexado que é PEDIDO,
    // não recibo. A lei "comprovante = paga" nasceu de recibo esquecido sem
    // data; ela não vale para a nota que o vendedor manda ANTES do pagamento —
    // o PDF da TAG diz na própria margem "THIS IS A WORK ORDER, NOT AN INVOICE!
    // DO NOT MAKE ANY PAYMENTS FROM THIS PAPERWORK!". Sem esta trava a compra
    // nascia paga sozinha e sumia das contas a pagar. O marcador [A PAGAR] sai
    // do item na hora em que o pagamento for lançado.
    // A EXCECAO VIROU CAMPO (30/ago/2026). Antes ela morava no NOME do item
    // ("[A PAGAR] ..."), e status como texto e proibido pela lei do dono — e,
    // pior, e fragil: eu mesmo limpei os marcadores achando que eram enfeite, e
    // este robo carimbou 6 compras da TAG como pagas na rodada seguinte —
    // US$ 5.050,00 de compra NAO paga aparecendo como paga.
    // Agora quem blinda e o campo receipt_proves_payment=false, que ninguem
    // apaga limpando texto. O marcador no nome nao protege mais nada.
    if (e.receipt_proves_payment === false) continue
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
  // Marcas paginadas (ver pageAll): marca fora da página = balão repetido.
  const seen = await pageAll(() => db.from('stream_mail_moves').select('message_id').eq('from_addr', NET_FROM).order('message_id'))
  const seenSet = new Set(seen.map((r: any) => r.message_id))
  const mark = (key: string, label: string) => markReported(db, key, label)

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
  // BALDE DO BANK LINK (AUTO-BOOK fase B, 4/set/2026): a pseudo-invoice
  // A ATRIBUIR (invoices.origin = 'BUCKET') carrega compra paga sem dono. Ela
  // NUNCA reporta daqui e NUNCA é marcada: sem dono não há "a que invoice e
  // carro se refere" — e a lei é sagrada. Quando a compra ganha CARRO, a linha
  // volta a entrar por updated_at já na invoice certa: se a rota do Bank Link
  // já mandou o balão (reportAttributedExpense, compra recente) a marca está
  // aqui e a rede cala; se não mandou (backlog), a rede trata como qualquer
  // linha — reporta se o dinheiro é recente, senão marca em silêncio.
  // Leitura paginada (ver pageAll); a ordem por id desempata o created_at.
  const ie = await pageAll(() => db.from('invoice_expenses')
    .select('id, invoice_id, item, price, quantity, tax, extra, supplier, order_number, payment_date, created_at, invoices(invoice_code, is_quote, origin, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).not('payment_date', 'is', null).order('created_at').order('id'))
  const groups = new Map<string, any[]>()
  for (const e of ie as any[]) {
    if (seenSet.has(`ern:ie:${e.id}`)) continue
    if (e.invoices?.is_quote) continue
    if (e.invoices?.origin === 'BUCKET') continue   // antes do mark(): linha do balde nunca é marcada
    const gk = `${e.invoice_id}|${e.order_number || `${e.supplier || ''}~${e.payment_date || ''}`}`
    const arr = groups.get(gk) || []; arr.push(e); groups.set(gk, arr)
  }
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
  const ip = await pageAll(() => db.from('invoice_payments')
    .select('id, amount, payment_date, paid_at, description, created_at, invoices(invoice_code, is_quote, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).not('paid_at', 'is', null).order('created_at').order('id'))
  for (const p of ip as any[]) {
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
  const se = await pageAll(() => db.from('expenses')
    .select('id, amount, payment_date, description, created_at, seasons(season_code, staff(name))')
    .gte('updated_at', EPOCH).not('payment_date', 'is', null).order('created_at').order('id'))
  for (const s of se as any[]) {
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

// ── BALÃO DA ATRIBUIÇÃO (AUTO-BOOK fase B, 4/set/2026) ──────────────────────
// Chamado pela rota do Bank Link (app/api/bank/reconcile, ação `assign` com
// dest CARRO) quando uma compra do balde A ATRIBUIR ganha dono e a compra é
// RECENTE — quem decide "recente" é a rota (ATTRIB_REPORT_DAYS pela data do
// banco); aqui não se olha calendário. Monta o MESMO balão do EXPENSE PAID da
// rede acima (cabeçalho com invoice e dono, data, valor, fornecedor/pedido,
// item), manda pelo mesmo sendReport e grava a marca ern:ie:<row_id> — assim,
// quando a rede vir a linha entrar por updated_at já na invoice do carro, a
// marca está lá e ela cala. Backlog (compra velha) NÃO passa por aqui: a rota
// só grava a marca em silêncio (markAttributedExpenseSilently) e o grupo não
// enche de balão de coisa antiga.
// Idempotente: linha já marcada não manda de novo (retry/duplo clique é seguro).
// A marca é gravada mesmo se o UltraMsg falhar — igual à rede: o report é
// best-effort, a marca é o fato de que a atribuição foi tratada.
//
// Campos esperados (objetos simples — a rota passa o que já tem na mão):
//   invoice: a invoice DESTINO (do carro). `invoice_code` obrigatório pro
//            cabeçalho; o dono sai de `rides.project_name` → `rides.project_code`
//            → `clients.name` (os mesmos embeds da rede) OU de `owner` já pronto.
//   row:     a linha de invoice_expenses JÁ atribuída (item com o marcador,
//            supplier canônico): id, item, supplier, order_number, price,
//            quantity, tax, extra, payment_date. O valor é price×quantity+tax+extra.
//   line:    a linha do banco; só `date` é lida, e só como reserva quando a
//            linha não tem payment_date (no balde as duas são a data do banco).
// Devolve { reported }: true = balão saiu; false = já estava marcada, UltraMsg
// não configurado, ou o envio falhou (nos três casos a marca fica gravada).
export type AttributedExpenseInput = {
  invoice: {
    invoice_code?: string | null
    owner?: string | null
    rides?: { project_name?: string | null; project_code?: string | null } | null
    clients?: { name?: string | null } | null
  }
  row: {
    id: string
    item?: string | null
    supplier?: string | null
    order_number?: string | null
    price?: number | string | null
    quantity?: number | string | null
    tax?: number | string | null
    extra?: number | string | null
    payment_date?: string | null
  }
  line?: { date?: string | null } | null
}

export async function reportAttributedExpense(db: SupabaseClient, { invoice, row, line }: AttributedExpenseInput): Promise<{ reported: boolean }> {
  const key = `ern:ie:${row.id}`
  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', NET_FROM).eq('message_id', key).limit(1)
  if (seen?.length) return { reported: false }
  const total = lineTotal(row)
  const code = invoice?.invoice_code || '—'
  const owner = invoice?.owner || ownerOf(invoice)
  const head = `*EXPENSE PAID* ${code}${owner ? ` — ${owner}` : ''}`
  const date = String(row.payment_date || line?.date || '').slice(0, 10)
  const srcLine = [row.supplier, row.order_number ? `pedido ${row.order_number}` : ''].filter(Boolean).join(' — ')
  const itemLine = String(row.item || '').slice(0, 60)
  const reported = await sendReport([head, `${date} — *${usd(total)}*`, srcLine, itemLine].filter(Boolean).join('\n'))
  await markReported(db, key, `EXPENSE ${code} ${usd(total)} (atribuída · Bank Link)`)
  return { reported }
}

// Marca em silêncio — o caminho do BACKLOG na atribuição (compra velha ganha
// dono: não entrou nem saiu dinheiro hoje, é só controle → sem balão). Grava a
// mesma marca ern:ie:<row_id> pra rede não reportar a linha quando ela entrar
// por updated_at. Idempotente pelo mesmo motivo acima.
export async function markAttributedExpenseSilently(db: SupabaseClient, rowId: string, label = 'EXPENSE (atribuída · Bank Link · backlog)'): Promise<void> {
  const key = `ern:ie:${rowId}`
  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', NET_FROM).eq('message_id', key).limit(1)
  if (seen?.length) return
  await markReported(db, key, label)
}
