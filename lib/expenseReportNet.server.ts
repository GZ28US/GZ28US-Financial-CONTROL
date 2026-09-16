// SERVER-ONLY — EXPENSE REPORT SAFETY NET (ordem do Márcio, 26/jul/2026):
// "NUNCA pode passar nenhuma expense sem report no grupo." Toda linha nova de
// invoice_expenses / invoice_incomes / staff_expenses — venha da UI, de
// scripts ou de qualquer automação — é reportada no grupo REPORTS. Para não duplicar o
// report que a própria UI já mandou, consulta o log de ENVIADAS do UltraMsg:
// se uma mensagem recente já carrega o mesmo valor formatado, só marca como
// reportada. Roda no mail-poll (cron 5min) — PC desligado incluso.
//
// O «JÁ REPORTEI» MORA NA LINHA (16/set/2026, lib/reportedAt.ts): a coluna reported_at. Antes era uma marca
// em stream_mail_moves ('ern:<tipo>:<id>'), que continua lá como histórico e foi copiada para a coluna na
// MIGRATION_reported_at.sql. A rede lê só linha sem data e RESERVA antes de mandar (claimReport): a rede e o
// cron de staff rodam juntos às 15:00 UTC e nenhum dos dois manda o que o outro pegou.
// E dinheiro que o BANCO já anunciou no grupo (💸 ZELLE ENVIADO / 💰 ZELLE RECEBIDO) não vira balão de novo
// quando a linha é lançada depois — caso Raydn 003598: US$ 329,56 no ZELLE ENVIADO de 15/09 e outra vez dentro
// do EXPENSE PAID de US$ 408,81 de 16/09.

import type { SupabaseClient } from '@supabase/supabase-js'
import { enviaUltra } from '@/lib/waSend.server'
import { semMarcacao } from '@/lib/waMentions'
import { fillHiddenPayers } from '@/lib/payerRule'
import { claimReport } from '@/lib/reportedAt'

// Só linhas criadas após a entrada da rede — histórico não é re-reportado.
const EPOCH = '2026-07-26T16:00:00Z'
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'

// LEITURA PAGINADA (AUTO-BOOK fase B, 4/set/2026). O supabase-js corta em 1.000
// linhas EM SILÊNCIO. Com o balde A ATRIBUIR criando centenas de despesas
// pagas, invoice_expenses desde a EPOCH passa do corte — e linha que não chega
// aqui é linha que a rede não trata.
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

// O que o BANCO já anunciou no grupo nos últimos dias: cada 💸 ZELLE ENVIADO / 💰 ZELLE RECEBIDO do
// lib/zelleWatch.server.ts, com o valor e o dia de Orlando em que saiu. Lido do espelho do WhatsApp
// (whatsapp_messages, as duas instâncias gravam o mesmo balão — por isso o dedup por hora + texto).
// Cada anúncio cala UMA linha só (`usado`), de valor igual ao centavo e com o pagamento entre a véspera e
// três dias antes do anúncio — um Zelle de US$ 500 não silencia duas semanas de staff.
type Anuncio = { valor: number; dia: string; sentido: 'OUT' | 'IN'; usado: boolean }
const diaOrlando = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
async function anunciosDoBanco(db: SupabaseClient, dias = 10): Promise<Anuncio[]> {
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!groupId) return []
  const desde = new Date(Date.now() - dias * 86400e3).toISOString()
  const { data, error } = await db.from('whatsapp_messages').select('body, sent_at')
    .eq('chat_id', groupId).eq('from_me', true).gte('sent_at', desde).ilike('body', '%ZELLE%').order('sent_at', { ascending: false }).limit(500)
  if (error || !data) return []
  const vistos = new Set<string>()
  const out: Anuncio[] = []
  for (const m of data as { body: string | null; sent_at: string }[]) {
    const b = String(m.body || '')
    const k = `${m.sent_at}|${b.slice(0, 80)}`
    if (vistos.has(k)) continue
    vistos.add(k)
    const x = b.match(/\*ZELLE (ENVIADO|RECEBIDO)[^*]*\*\s*\$([0-9][0-9,]*\.[0-9]{2})/)
    if (!x) continue
    out.push({ valor: parseFloat(x[2].replace(/,/g, '')), dia: diaOrlando(m.sent_at), sentido: x[1] === 'ENVIADO' ? 'OUT' : 'IN', usado: false })
  }
  return out
}
const somaDias = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10)
function jaAnunciado(anuncios: Anuncio[], sentido: 'OUT' | 'IN', valor: number, dia: string | null | undefined): boolean {
  const d = String(dia || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const a = anuncios.find(x => !x.usado && x.sentido === sentido && Math.abs(x.valor - valor) < 0.005 && x.dia >= somaDias(d, -1) && x.dia <= somaDias(d, 3))
  if (!a) return false
  a.usado = true
  return true
}

// Valor da linha e dono da invoice — os mesmos da rede e do balão de atribuição.
const lineTotal = (e: any) => (parseFloat(e.price) || 0) * (parseFloat(e.quantity) || 1) + (parseFloat(e.tax) || 0) + (parseFloat(e.extra) || 0)
const ownerOf = (inv: any) => inv?.rides?.project_name || inv?.rides?.project_code || inv?.clients?.name || ''

// Report no grupo pelo caminho único (lib/waSend.server.ts, 11/set/2026):
// `@numero` no texto vira marcação de verdade. Ver lib/waMentions.
//
// O `true` daqui é o critério da rota — HTTP ok E a UltraMsg confirmando que
// mandou —, não só o HTTP. HTTP 200 com `sent: "false"` (instância fora do ar,
// número inválido) é recusa, e dizer "reportado" nesse caso seria mentira dita
// pro Bank Link. ATENÇÃO ao que isto NÃO muda: a data de REPORTED (reported_at) continua
// gravada mesmo quando o envio falha (ela é a reserva, gravada ANTES do envio) — é
// decisão antiga e deliberada, de 04/set: a data registra que a linha FOI TRATADA, e
// sem ela o balão voltaria a cada 5 minutos. Quem devolve "false" aqui só está dizendo a verdade sobre o balão.
//
// TEXTO DE FORA NÃO ESCOLHE QUEM O APP MARCA (11/set/2026, ver lib/waMentions):
// o destino aqui é SEMPRE grupo (ULTRAMSG_GROUP_ID), que é onde `mencoesDoTexto`
// está ligado, e os balões desta rede carregam campo que veio de fora — item e
// fornecedor do e-mail da loja, número de pedido, e a `description` do pagamento
// (é lá que o memo digitado por quem manda o Zelle é gravado). Todos passam por
// `semMarcacao` no ponto de montagem, logo abaixo. Ficam de fora, de propósito,
// os rótulos que o próprio app escreve: `invoice_code`, `season_code`, o dono
// (nome do carro / do cliente), o nome do staff, a data e o `usd()`.
async function sendReport(body: string): Promise<boolean> {
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!groupId) return false
  return (await enviaUltra(groupId, `${body}\n\n${SIGNATURE}`)).ok
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
  // PAGADOR ESCONDIDO (onda 10, 14/set/2026): toda linha abaixo estava sem payment_date e acabou
  // de ganhar um — o pagamento nasce aqui, e com ele o campo escondido da régua (lib/payerRule:
  // PAID TO nas despesas, os dois no custo fixo), só onde vazio. Falha vira log: não desfaz a baixa.
  const hidden = async (t: 'staff_expenses' | 'invoice_expenses' | 'fixed_cost_expenses', id: string) => {
    const hErr = await fillHiddenPayers(db, t, [id])
    if (hErr) console.error('[receipt-paid] pagador escondido não gravou:', hErr)
  }

  const { data: se } = await db.from('staff_expenses')
    .select('id, expense_date, created_at').not('receipt_url', 'is', null).is('payment_date', null)
  for (const e of (se || []) as any[]) {
    const d = dateOf(e); if (!d) continue
    const { error } = await db.from('staff_expenses').update(patch(e, d)).eq('id', e.id)
    // O pagamento nasceu agora: o PAID TO escondido nasce junto (GZ28US, só se vazio —
    // lib/payerRule). Quem pagou é escolha e não se deduz do comprovante aqui.
    if (!error) { fixed++; await hidden('staff_expenses', e.id) }
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
    if (!error) { fixed++; await hidden('invoice_expenses', e.id) }
  }

  const { data: fc } = await db.from('fixed_cost_expenses')
    .select('id, expense_date, created_at').not('receipt_url', 'is', null).is('payment_date', null)
  for (const e of (fc || []) as any[]) {
    const d = dateOf(e); if (!d) continue
    const { error } = await db.from('fixed_cost_expenses').update({ payment_date: d }).eq('id', e.id)
    // Custo fixo não escolhe pagador: PAID FROM e PAID TO nascem GZ28US com o pagamento, só se vazios.
    if (!error) { fixed++; await hidden('fixed_cost_expenses', e.id) }
  }

  return { fixed }
}

export async function runExpenseReportNet(db: SupabaseClient): Promise<{ reported: string[] }> {
  const out: string[] = []
  // Só entra linha SEM reported_at (lib/reportedAt.ts). Toda linha que a rede olha sai daqui com data:
  // reportada, ou tratada em silêncio (retroativo, dinheiro já anunciado).
  const sent = await recentSentBodies()
  const alreadySent = (amount: number) => sent.some((b) => b.includes(usd(amount)))
  const anuncios = await anunciosDoBanco(db)
  const claim = async (table: 'invoice_expenses' | 'invoice_incomes' | 'staff_expenses', ids: string[]) => {
    const r = await claimReport(db, table, ids)
    if (r.error) console.error('[report-net] reserva falhou:', r.error)
    return r.claimed
  }

  // UNIVERSAL (Márcio, 01/ago/2026): "ENTROU ou SAIU $? REPORT. Alterações,
  // atualizações ou criação de RETROATIVO? Nada de report — não entrou nem
  // saiu $, é só controle." O termômetro é a DATA DO DINHEIRO: pagamento dos
  // últimos dias = movimento real → reporta; data antiga = registro de
  // histórico → data em silêncio e cala.
  const RECENT_DAYS = 3
  const isRecentMoney = (d: string | null | undefined) => {
    if (!d) return false
    const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime()
    return Number.isFinite(t) && Date.now() - t < RECENT_DAYS * 86400e3
  }

  // 1) invoice_expenses — regra do Márcio (30/jul): reporta SÓ QUANDO PAGA
  // (payment_date preenchido), nunca no cadastro nem na exclusão. Linhas não
  // pagas ficam SEM data — quando forem pagas, o report sai naquele momento.
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
  // NUNCA reporta daqui e NUNCA ganha data: sem dono não há "a que invoice e
  // carro se refere" — e a lei é sagrada. Quando a compra ganha CARRO, a linha
  // volta a entrar por updated_at já na invoice certa: se a rota do Bank Link
  // já mandou o balão (reportAttributedExpense, compra recente) a linha já tem
  // reported_at e a rede cala; se não mandou (backlog), a rede trata como
  // qualquer linha — reporta se o dinheiro é recente, senão cala e data.
  // Leitura paginada (ver pageAll); a ordem por id desempata o created_at.
  const ie = await pageAll(() => db.from('invoice_expenses')
    .select('id, invoice_id, item, price, quantity, tax, extra, supplier, order_number, payment_date, created_at, invoices(invoice_code, is_quote, origin, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).is('reported_at', null).not('payment_date', 'is', null).order('created_at').order('id'))
  const groups = new Map<string, any[]>()
  for (const e of ie as any[]) {
    if (e.invoices?.is_quote) continue
    if (e.invoices?.origin === 'BUCKET') continue   // antes da reserva: linha do balde nunca ganha data aqui
    const gk = `${e.invoice_id}|${e.order_number || `${e.supplier || ''}~${e.payment_date || ''}`}`
    const arr = groups.get(gk) || []; arr.push(e); groups.set(gk, arr)
  }
  for (const todas of groups.values()) {
    // Reserva primeiro: o balão fala só das linhas que ESTA rodada pegou.
    const minhas = await claim('invoice_expenses', todas.map((e) => e.id))
    const rows = todas.filter((e) => minhas.has(e.id))
    if (!rows.length) continue
    const e0 = rows[0]
    const total = rows.reduce((s, e) => s + lineTotal(e), 0)
    const owner = ownerOf(e0.invoices)
    const head = `*EXPENSE PAID* ${e0.invoices?.invoice_code || '—'}${owner ? ` — ${owner}` : ''}`
    const label = `EXPENSE ${e0.invoices?.invoice_code || '—'} ${usd(total)} (${rows.length} itens)`
    // Dinheiro que o banco já anunciou (ZELLE ENVIADO) não sai de novo: cala se TODA linha do balão já saiu por lá.
    const anunciadas = rows.filter((e) => jaAnunciado(anuncios, 'OUT', lineTotal(e), e.payment_date)).length
    if (!alreadySent(total) && anunciadas < rows.length && rows.some((e) => isRecentMoney(e.payment_date))) {
      // item, fornecedor e pedido vieram do e-mail da loja: peneirados DEPOIS do
      // corte, que é o texto que de fato vai pro grupo (ver semMarcacao).
      const names = rows.map((e) => semMarcacao(String(e.item || '').slice(0, 60)))
      const itemsLine = rows.length === 1 ? names[0]
        : `${rows.length} itens: ${names.slice(0, 3).join(' · ')}${rows.length > 3 ? ` +${rows.length - 3}` : ''}`
      const srcLine = [semMarcacao(e0.supplier), e0.order_number ? `pedido ${semMarcacao(e0.order_number)}` : ''].filter(Boolean).join(' — ')
      await sendReport([head, `${e0.payment_date || ''} — *${usd(total)}*`, srcLine, itemsLine].filter(Boolean).join('\n'))
      out.push(label)
    }
  }

  // 2) invoice_incomes — mesma regra: só quando o dinheiro ENTROU.
  // ATENÇÃO ao modelo (incidente QuickSilver 31/jul): em incomes, payment_date é
  // a data PREVISTA — quem marca "recebido" é paid_at. Previsões nunca reportam.
  const ip = await pageAll(() => db.from('invoice_incomes')
    .select('id, amount, payment_date, paid_at, description, created_at, invoices(invoice_code, is_quote, rides(project_name, project_code), clients(name))')
    .gte('updated_at', EPOCH).is('reported_at', null).not('paid_at', 'is', null).order('created_at').order('id'))
  for (const p of ip as any[]) {
    if (p.invoices?.is_quote) continue
    if (!(await claim('invoice_incomes', [p.id])).has(p.id)) continue
    const owner = ownerOf(p.invoices)
    const label = `INCOME ${p.invoices?.invoice_code || '—'} ${usd(p.amount)}`
    // Dia de Orlando da baixa (lei O RELÓGIO): paid_at é timestamptz.
    const paidOn = (p.paid_at ? diaOrlando(p.paid_at) : '') || p.payment_date || ''
    if (!alreadySent(Number(p.amount)) && !jaAnunciado(anuncios, 'IN', Number(p.amount), paidOn) && isRecentMoney(paidOn)) {
      // `description` de invoice_incomes é onde o MEMO de quem mandou o dinheiro
      // (Zelle) é gravado: texto de terceiro, peneirado antes de ir pro grupo.
      await sendReport([`*INCOME PAID* ${p.invoices?.invoice_code || '—'}${owner ? ` — ${owner}` : ''}`, `${paidOn} — *${usd(p.amount)}*`, semMarcacao(String(p.description || '').slice(0, 160))].join('\n'))
      out.push(label)
    }
  }

  // 3) staff_expenses (seasons) — mesma regra: reporta só quando PAGA.
  const se = await pageAll(() => db.from('staff_expenses')
    .select('id, amount, payment_date, description, created_at, seasons(season_code, staff(name))')
    .gte('updated_at', EPOCH).is('reported_at', null).not('payment_date', 'is', null).order('created_at').order('id'))
  for (const s of se as any[]) {
    if (!(await claim('staff_expenses', [s.id])).has(s.id)) continue
    const who = s.seasons?.staff?.name || '—'
    const label = `EXPENSE STAFF ${s.seasons?.season_code || ''} ${usd(s.amount)}`
    if (!alreadySent(Number(s.amount)) && !jaAnunciado(anuncios, 'OUT', Number(s.amount), s.payment_date) && isRecentMoney(s.payment_date)) {
      // A `description` da season é digitada por gente; peneirada como as outras.
      await sendReport([`*EXPENSE PAID — STAFF* ${s.seasons?.season_code || '—'} — ${who}`, `${s.payment_date || ''} — *${usd(s.amount)}*`, semMarcacao(String(s.description || '').slice(0, 160))].join('\n'))
      out.push(label)
    }
  }

  return { reported: out }
}

// ── BALÃO DA ATRIBUIÇÃO (AUTO-BOOK fase B, 4/set/2026) ──────────────────────
// Chamado pela rota do Bank Link (app/api/bank/reconcile, ação `assign` com
// dest CARRO) quando uma compra do balde A ATRIBUIR ganha dono e a compra é
// RECENTE — quem decide "recente" é a rota (ATTRIB_REPORT_DAYS pela data do
// banco); aqui não se olha calendário. Monta o MESMO balão do EXPENSE PAID da
// rede acima (cabeçalho com invoice e dono, data, valor, fornecedor/pedido,
// item), manda pelo mesmo sendReport e RESERVA a linha (reported_at) — assim,
// quando a rede vir a linha entrar por updated_at já na invoice do carro, a
// data está lá e ela cala. Backlog (compra velha) NÃO passa por aqui: a rota
// só grava a data em silêncio (markAttributedExpenseSilently) e o grupo não
// enche de balão de coisa antiga.
// Idempotente: linha já com reported_at não manda de novo (retry/duplo clique é seguro).
// A data é gravada ANTES do envio e fica mesmo se o UltraMsg falhar — igual à rede: o report é
// best-effort, a data é o fato de que a atribuição foi tratada.
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
// Devolve { reported }: true = balão saiu; false = já tinha data, UltraMsg
// não configurado, ou o envio falhou (nos três casos a data fica gravada).
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
  // A data de REPORTED é a reserva (lib/reportedAt.ts): linha que já tem data não sai de novo.
  const { claimed } = await claimReport(db, 'invoice_expenses', [row.id])
  if (!claimed.has(row.id)) return { reported: false }
  const total = lineTotal(row)
  const code = invoice?.invoice_code || '—'
  const owner = invoice?.owner || ownerOf(invoice)
  const head = `*EXPENSE PAID* ${code}${owner ? ` — ${owner}` : ''}`
  const date = String(row.payment_date || line?.date || '').slice(0, 10)
  // Mesmo balão da rede acima, mesma peneira: fornecedor, pedido e item vieram do
  // e-mail da loja e o destino é grupo (ver semMarcacao em lib/waMentions).
  const srcLine = [semMarcacao(row.supplier), row.order_number ? `pedido ${semMarcacao(row.order_number)}` : ''].filter(Boolean).join(' — ')
  const itemLine = semMarcacao(String(row.item || '').slice(0, 60))
  const reported = await sendReport([head, `${date} — *${usd(total)}*`, srcLine, itemLine].filter(Boolean).join('\n'))
  return { reported }
}

// Marca em silêncio — o caminho do BACKLOG na atribuição (compra velha ganha
// dono: não entrou nem saiu dinheiro hoje, é só controle → sem balão). Grava a
// mesma data (reported_at) pra rede não reportar a linha quando ela entrar
// por updated_at. Idempotente pelo mesmo motivo acima.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function markAttributedExpenseSilently(db: SupabaseClient, rowId: string, _label = 'EXPENSE (atribuída · Bank Link · backlog)'): Promise<void> {
  const r = await claimReport(db, 'invoice_expenses', [rowId])
  if (r.error) console.error('[report-net] silêncio da atribuição não gravou:', r.error)
}
