import { NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, organizeInbox, sweepSpam, sweepMarketing } from '@/lib/streamMail.server'
import { runAppsSweep } from '@/lib/appsMail.server'
import { runStaffTravelSweep } from '@/lib/staffTravel.server'
import { runExpenseReportNet, enforceReceiptPaid } from '@/lib/expenseReportNet.server'
import { runInboxZero, alertVipMail } from '@/lib/inboxZero.server'
import { runZelleWatch } from '@/lib/zelleWatch.server'
import { runDutyWatch } from '@/lib/dutyWatch.server'
import { runMailWatch } from '@/lib/mailWatch.server'
// runStreamAnswers foi SUBSTITUÍDO pela fila de destino (cron purchase-queue,
// 19/ago) — dois leitores no mesmo grupo aplicariam a mesma resposta duas vezes.
import { runStaffPayroll } from '@/lib/staffPayroll.server'
import type { StreamRow } from '@/lib/stream'

// STREAM mail watcher — scans gz28us@hotmail.com for supplier shipping emails
// and auto-fills tracking numbers on open STREAM rows. Matched rows get the
// tracking registered with 17TRACK and flip to SHIPPED (WhatsApp report fires
// inside applyTrackInfo). Called fire-and-forget by the /stream page and daily
// by the Vercel cron; a 10-minute server-side throttle keeps it cheap.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const THROTTLE_MIN = 10
const FIRST_RUN_DAYS = 3

async function run(force: boolean): Promise<NextResponse> {
  const db = streamDb()
  const auth = await getMailAuth(db)
  if (!auth?.refresh_token) return NextResponse.json({ ok: false, reason: 'mailbox not connected (run /api/stream/mail-auth)' })

  const now = Date.now()
  if (!force && auth.last_poll && now - new Date(auth.last_poll).getTime() < THROTTLE_MIN * 60_000) {
    return NextResponse.json({ ok: true, skipped: 'throttled', updated: 0 })
  }

  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ ok: false, reason: 'token refresh failed — reconnect at /api/stream/mail-auth' })

  // ═══ STREAM LEGADO MORTO, NÃO APAGADO (Márcio, 30/ago/2026): "quero ele
  // totalmente morto, sem mais nenhuma ação... como se tivesse sido apagado." ═══
  // Morreram AQUI, nesta batida (o cron continua — os 13 trabalhos de e-mail e
  // financeiro abaixo seguem vivos): a varredura das 4 caixas para captura de
  // rastreio, o casador tracking↔pedido↔item, a rede de entrega por e-mail, o
  // REFUND WATCH, o refresh do 17TRACK sobre part_streams e a captura de compras
  // por e-mail (a fila do sino/PESCA) — "matar junto, migro depois", decisão dele.
  // O rastreio dos ITENS vive no modelo novo: colunas na própria linha +
  // /api/items/track. O código legado segue em lib/stream*.server.ts e
  // lib/purchase*.server.ts, inerte — nada mais o chama.
  const msgs: { subject: string }[] = []
  const boxes: string[] = []
  const updated = 0
  const trackAsked = 0
  const details: string[] = []
  const refunded: string[] = []
  const trackRefresh: { checked: number; updated: string[]; reRegistered: number; error?: string } = { checked: 0, updated: [], reRegistered: 0 }
  const purchases: { captured: string[] } = { captured: [] }

  // ── inbox organizer — purchase emails file into the car's Outlook folder
  // 10+ min after the user reads them; doubts stay put and get logged.
  let organizer: { moved: string[]; doubts: string[] } = { moved: [], doubts: [] }
  try { organizer = await organizeInbox(db, token) } catch (e) { console.error('[mail-organize]', e) }

  // ── spam auto-clean — toda passada varre as 3 caixas e apaga o marketing
  // conhecido na hora (regra 2026-07-24: "apague logo que chegar").
  let spam: { deleted: string[] } = { deleted: [] }
  try { spam = await sweepSpam(db) } catch (e) { console.error('[spam-sweep]', e) }
  let marketing: { deleted: string[] } = { deleted: [] }
  try { marketing = await sweepMarketing(db) } catch (e) { console.error('[marketing-sweep]', e) }

  // ── APPS watcher — recibos de assinatura no Gmail viram pagamentos no módulo
  // APPS, arquivados em Apps/<App> e reportados no grupo (2026-07-25).
  let appsPayments = 0
  try { const r = await runAppsSweep(db); appsPayments = r.payments.length } catch (e) { console.error('[apps-sweep]', e) }
  let staffTravel: { opened: string[]; closed: string[] } = { opened: [], closed: [] }
  try { staffTravel = await runStaffTravelSweep(db) } catch (e) { console.error('[staff-travel]', e) }
  // LEI 01/ago: comprovante anexado ⇒ expense PAGA — roda antes da rede de
  // reports para o report de PAGA sair no mesmo ciclo.
  let receiptPaid = 0
  try { receiptPaid = (await enforceReceiptPaid(db)).fixed } catch (e) { console.error('[receipt-paid]', e) }
  let reportNet: { reported: string[] } = { reported: [] }
  try { reportNet = await runExpenseReportNet(db) } catch (e) { console.error('[report-net]', e) }

  // ── inbox zero net — depois de todos os sweeps, o que sobrou (>15 min) ganha
  // destino por regra; sem regra → TRIAGEM (Claudinha) + pergunta no grupo.
  let inboxZero: { actions: string[] } = { actions: [] }
  try { inboxZero = await runInboxZero(db) } catch (e) { console.error('[inbox-zero]', e) }
  // ── ZELLE WATCH (LEI 13/ago) — dinheiro que entra/sai por Zelle não pode
  // depender de e-mail parado na inbox: varre a caixa INTEIRA, lança a entrada
  // com histórico e alerta o resto. Roda ANTES do inbox-zero, que arquiva.
  let zelle: { booked: string[]; pending: string[] } = { booked: [], pending: [] }
  try { zelle = await runZelleWatch(db) } catch (e) { console.error('[zelle-watch]', e) }
  // ── MAIL WATCH (27/ago) — resposta que ele está ESPERANDO não pode ficar
  // dormindo na caixa até a ronda humana. As regras moram em `mail_watches`
  // (remetente/assunto), então vigiar um novo interlocutor é um INSERT, não um
  // deploy. Antes do inbox-zero, como os outros watchers.
  let mailWatch: { alerts: string[] } = { alerts: [] }
  try { mailWatch = await runMailWatch(db) } catch (e) { console.error('[mail-watch]', e) }
  // ── DUTY WATCH (LEI 20/ago, caso BONOSS #207546) — com o de minimis morto,
  // toda importação gera uma 2ª cobrança (imposto + desembaraço) que chega
  // sozinha semanas DEPOIS da caixa. A fatura do carrier bate pelo waybill com
  // a linha do STREAM e o imposto cai na invoice certa, rateado se a remessa
  // serviu mais de um carro. Também antes do inbox-zero, que arquiva.
  let duty: { booked: string[]; pending: string[] } = { booked: [], pending: [] }
  try { duty = await runDutyWatch(db) } catch (e) { console.error('[duty-watch]', e) }
  // ── VIP mail alert — contraparte ativa escreveu ⇒ WhatsApp do Márcio na hora
  // (LEI 04/ago, caso Celina: news de negociação não pode dormir na TRIAGEM).
  let vipMail: { alerted: string[] } = { alerted: [] }
  try { vipMail = await alertVipMail(db) } catch (e) { console.error('[vip-mail]', e) }
  // A resposta do grupo à pergunta "a que carro/invoice pertence?" vira destino
  // no STREAM automaticamente (ordem 27/jul) — inclui acertar app US/BR.
  const streamAnswers: { applied: string[] } = { applied: [] } // legado — ver cron purchase-queue

  // ── Folha recorrente de staff: no dia do pagamento, a linha da semana nasce
  // EM ABERTO e fica visível como pendente até alguém dar baixa.
  let payroll: { created: string[] } = { created: [] }
  try { payroll = await runStaffPayroll(db) } catch (e) { console.error('[staff-payroll]', e) }

  // ── FINANCEIRO 24/7 — o grupo mais importante do BR (ordem 27/jul). O webhook
  // deste app enfileira cada post; quem sabe lançar é o app BR, então esta
  // batida de 5 min acorda o robô de lá. Fila e cadência ficam no mesmo relógio.
  let financeiro: unknown = null
  try {
    financeiro = await fetch(`${process.env.GZ28BR_BASE_URL || 'https://www.gz28br.com/ca'}/api/cron/financeiro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: process.env.FINANCEIRO_KEY }),
    }).then(r => r.json())
  } catch (e) { console.error('[financeiro-ping]', e) }

  return NextResponse.json({ ok: true, scanned: msgs.length, boxes, updated, trackAsked, details, refunded, trackRefresh, moved: organizer.moved, doubts: organizer.doubts, spamDeleted: spam.deleted, marketingDeleted: marketing.deleted, appsPayments, staffTravel, receiptPaid, reportNet, purchases, inboxZero, vipMail, zelle, duty, mailWatch, streamAnswers, financeiro, payroll })
}

export async function POST() { return run(false) }
// Vercel cron calls GET daily as the backstop; force past the throttle.
export async function GET() { return run(true) }
