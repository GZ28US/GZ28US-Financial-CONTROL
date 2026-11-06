/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb, loadDocState, buildRevision, publicUrl, type DocState } from '@/lib/quoteDoc.server'
import { actionsAllow, publicDto, railsEnabled, payModeOk } from '@/lib/quotePublic.server'
import { stripeClient, stripeMode } from '@/lib/stripe.server'
import { readSetting } from '@/lib/appSettings.server'
import { orlandoToday } from '@/lib/orlando'
import { moneyCents, type Lang } from '@/lib/quoteStrings'
import { staffRevisionPdf, attemptReceiptPdf, pdfResponseHeaders } from '@/lib/docFiles.server'

// STAFF ACTIONS ON ONE DOCUMENT (06/11/2026; blueprint §2.3). /ca/api/doc/<invoiceId>/<action>
//   GET  state · link · preview
//   POST seed · send · revision · rotate · gate-unlock · plan · approve-manual · deposit-manual · extend · void · note-hide
// Every call: requireStaff (a HUMAN JWT — machine accounts refused; the actor recorded is ALWAYS the JWT e-mail, never a body
// field). Every mutation except `seed`: actionsAllow = app_settings qi_v2.actions OR the document is a test document → else 409.
// NOTHING here sends a message: SEND freezes the revision and returns the link + a ready text for the staff to paste.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f-]{36}$/
const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status })
const rpcErr = (m: string) => bad(m.replace(/^.*?ERROR:\s*/, ''), /\(409\)|already approved|payment is open|clearing/.test(m) ? 409 : 400)
const CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS', 'FACEBOOK', 'INSTAGRAM', 'COPY', 'RECORDED']
const SHOP_METHODS = ['SHOP_PHONE', 'SHOP_IN_PERSON', 'SHOP_TEXT', 'SHOP_EMAIL']
const MANUAL_SOURCES: Record<string, string> = { ZELLE: 'ZELLE', WIRE: 'WIRE', CASH: 'CASH', CHECK: 'CHECK', PIX: 'PIX_BR', PIX_BR: 'PIX_BR', OTHER: 'OTHER', ACH: 'OTHER' }

function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

async function linkToken(db: ReturnType<typeof serviceDb>, invoiceId: string): Promise<string | null> {
  const { data } = await db.from('quote_links').select('token').eq('invoice_id', invoiceId).is('revoked_at', null).maybeSingle()
  return data?.token || null
}

function sendText(s: DocState, url: string, lang: Lang, pay: boolean): string {
  const doc = s.live?.document
  const name = doc?.header?.client_first || ''
  const grand = moneyCents(Math.round(Number(s.live?.grand_total || 0) * 100), lang)
  const dep = (doc?.installments || [])[0]
  if (lang === 'pt') {
    return pay
      ? `Olá${name ? ', ' + name : ''}! Obrigado pela aprovação. O sinal de ${dep ? moneyCents(dep.amount_cents, 'pt') : ''} pode ser pago aqui, com cartão (sem taxa para você): ${url}`
      : `Olá${name ? ', ' + name : ''}! Aqui está o seu orçamento ${doc?.header?.display_code || ''} — ${doc?.header?.service || ''} (${grand}). Você pode ler, aprovar e pagar o sinal no mesmo link: ${url}`
  }
  return pay
    ? `Hi${name ? ' ' + name : ''}! Thanks for approving. Your ${dep ? moneyCents(dep.amount_cents, 'en') : ''} deposit can be paid here by card (no fee to you): ${url}`
    : `Hi${name ? ' ' + name : ''}! Here is your quote ${doc?.header?.display_code || ''} — ${doc?.header?.service || ''} (${grand}). You can read it, approve it and pay the deposit on the same link: ${url}`
}

async function freezeRecorded(db: ReturnType<typeof serviceDb>, s: DocState, actor: string): Promise<string | null> {
  if (s.live) return null
  if (!s.terms) return 'no terms'
  const validUntil = addDays(orlandoToday(), s.terms.valid_days || 30)
  const b = buildRevision(s.bundle, s.terms, s.plan, { validUntil })
  if (b.problems.length) return 'cannot freeze: ' + b.problems.join('; ')
  const { error } = await db.rpc('quote_send', { p_invoice: s.bundle.invoice.id, p_actor: actor, p_channel: 'RECORDED', p_sent_to: null,
    p_valid_days: s.terms.valid_days || 30, p_document: b.document, p_sha256: b.sha256, p_presented_sha256: b.presented_sha256,
    p_terms_sha256: b.terms_sha256, p_grand: b.grand, p_fl_tax: b.fl_tax, p_fl_status: b.fl_status, p_by_app: false })
  return error ? error.message : null
}

async function expireOpenSessions(db: ReturnType<typeof serviceDb>, invoiceId: string, sessions?: string[]) {
  let ids = sessions
  if (!ids) {
    const { data } = await db.from('payment_attempts').select('id, checkout_session_id').eq('invoice_id', invoiceId).eq('status', 'OPEN').eq('provider', 'STRIPE')
    ids = (data || []).map(a => a.checkout_session_id).filter(Boolean) as string[]
    if (data?.length) await db.from('payment_attempts').update({ status: 'EXPIRED' }).in('id', data.map(a => a.id))
  }
  const out: string[] = []
  for (const id of ids) { try { await stripeClient().checkout.sessions.expire(id); out.push(id) } catch (e) { out.push(`${id}: ${(e as Error).message}`) } }
  return out
}

function staffState(s: DocState) {
  const inv = s.bundle.invoice
  return {
    invoice: { id: inv.id, invoice_code: inv.invoice_code, service: inv.service, is_quote: inv.is_quote, live_status: inv.live_status, hiring_date: inv.hiring_date,
      ride_id: inv.ride_id, client_id: inv.client_id, expected_conclusion_date: inv.expected_conclusion_date, global_discount: inv.global_discount, fl_tax_override: inv.fl_tax_override },
    ride: s.bundle.ride ? { id: s.bundle.ride.id, project_code: s.bundle.ride.project_code, project_name: s.bundle.ride.project_name, brand: s.bundle.ride.brand,
      model: s.bundle.ride.model, version: s.bundle.ride.version, year: s.bundle.ride.year, title_scope: s.bundle.ride.title_scope, is_quote: s.bundle.ride.is_quote } : null,
    client: s.bundle.client ? { id: s.bundle.client.id, name: s.bundle.client.name, client_number: s.bundle.client.client_number, country: s.bundle.client.country,
      state: s.bundle.client.state, phone: s.bundle.client.phone, email: s.bundle.client.email, preferred_message_method: s.bundle.client.preferred_message_method,
      facebook: s.bundle.client.facebook, instagram: s.bundle.client.instagram, is_quote: s.bundle.client.is_quote } : null,
    money: s.bundle.money, received: s.bundle.received, openBalance: s.bundle.openBalance,
    counts: { items: s.bundle.items.filter(i => i.counts).length, services: s.bundle.services.length, notes: s.bundle.notes.length,
      itemsTotal: s.bundle.money.parts, servicesTotal: s.bundle.money.services },
    incomes: s.bundle.incomes.map(i => ({ id: i.id, amount: i.amount, description: i.description, payment_date: i.payment_date, paid_at: i.paid_at, source: i.source,
      paid_to: i.paid_to, installment_id: i.installment_id, refund_id: i.refund_id })),
    terms: s.terms, plan: s.plan,
    revisions: s.revisions.map(r => ({ id: r.id, seq: r.seq, kind: r.kind, sha256: r.sha256, grand_total: r.grand_total, fl_tax: r.fl_tax, fl_tax_status: r.fl_tax_status,
      sent_at: r.sent_at, sent_channel: r.sent_channel, sent_to: r.sent_to, superseded_at: r.superseded_at, created_by: r.created_by, created_at: r.created_at,
      installments: r.document?.installments || [] })),
    live: s.live ? { id: s.live.id, seq: s.live.seq } : null,
    approvals: s.approvals, approvalOnLive: s.approvalOnLive, links: s.links, liveLink: s.liveLink, attempts: s.attempts, events: s.events,
    clientNotes: s.clientNotes, stage: s.stage, presentedDrift: s.presentedDrift, planDrift: s.planDrift, signedDrift: s.signedDrift, isTest: s.isTest,
    readiness: s.terms ? buildRevision(s.bundle, s.terms, s.plan).problems : ['no terms yet'],
    stripeMode: stripeMode(),
  }
}

async function handle(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }, method: 'GET' | 'POST') {
  const { id, action } = await ctx.params
  const staff = await requireStaff(req)
  if (!staff) return bad('staff only (a human login; machine accounts refused)', 403)
  if (!UUID.test(id)) return bad('bad id')
  let db
  try { db = serviceDb() } catch (e) { return bad((e as Error).message, 503) }
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {}
  const actor = staff.email

  if (method === 'POST' && action === 'seed') {
    const { data, error } = await db.rpc('seed_terms', { p_invoice: id })
    return error ? rpcErr(error.message) : NextResponse.json({ ok: true, seeded: data })
  }

  let s = await loadDocState(db, id)
  if (!s) return bad('document not found', 404)

  if (method === 'GET') {
    if (action === 'state') {
      if (!s.terms) { await db.rpc('seed_terms', { p_invoice: id }); s = (await loadDocState(db, id))! }     // lazy seed (exempt from the key)
      return NextResponse.json({ ...staffState(s), actionsAllowed: await actionsAllow(s.isTest) })
    }
    if (action === 'link') {
      const tok = await linkToken(db, id)
      if (!tok) return bad('no live link — SEND first', 404)
      await db.rpc('doc_event', { p_invoice: id, p_revision: s.live?.id || null, p_kind: 'LINK_COPIED', p_actor: 'STAFF', p_actor_id: actor, p_payload: { actor } })
      const lang = (s.terms?.language || 'en') as Lang
      const url = publicUrl(tok)
      return NextResponse.json({ url, text: sendText(s, url, lang, !!s.approvalOnLive) })
    }
    if (action === 'preview') {
      if (!s.liveLink) return bad('no live link — SEND first', 404)
      const pay = await payModeOk(s.isTest)
      return NextResponse.json(publicDto(s, s.liveLink as any, { rails: await railsEnabled(), payOk: pay.ok, inApp: false, gateOk: true }))
    }
    if (action === 'pdf') {
      // the STAFF copy: the frozen revision + the FULL certificate (contact, IP, recorder). Generated, never stored.
      const rev = Number(req.nextUrl.searchParams.get('rev') || 0) || undefined
      const p = staffRevisionPdf(s, rev, 'full')
      if (!p) return bad('no revision — SEND first', 404)
      return new NextResponse(new Uint8Array(p.buf), { headers: pdfResponseHeaders(p.name) })
    }
    if (action === 'receipt') {
      const p = await attemptReceiptPdf(db, s, String(req.nextUrl.searchParams.get('attempt') || ''))
      if (!p) return bad('no paid attempt', 404)
      return new NextResponse(new Uint8Array(p.buf), { headers: pdfResponseHeaders(p.name) })
    }
    return bad('unknown action', 404)
  }

  if (!(await actionsAllow(s.isTest))) return bad('V2 actions are off (qi_v2.actions)', 409, { key: 'qi_v2.actions' })
  const inv = s.bundle.invoice

  switch (action) {
    case 'plan': {
      if (s.live) return bad('locked — sent rev ' + s.live.seq + ' (NEW REVISION to change)', 409)
      const rows = Array.isArray(body.installments) ? body.installments : null
      if (rows) {
        const clean = rows.map((r: any, i: number) => ({
          invoice_id: id, seq: i + 1, kind: i === 0 ? 'DEPOSIT' : i === rows.length - 1 ? 'BALANCE' : 'INSTALLMENT',
          label_key: ['DEPOSIT', 'ARRIVAL', 'CONCLUSION', 'CUSTOM'].includes(r.label_key) ? r.label_key : 'CUSTOM', label: r.label ? String(r.label).slice(0, 80) : null,
          pct: r.amount != null && r.amount !== '' ? null : Number(r.pct), amount: r.amount != null && r.amount !== '' ? Number(r.amount) : null,
          due_rule: r.due_rule, due_date: r.due_rule === 'DATE' ? r.due_date || null : null, net_days: r.due_rule === 'NET_DAYS' ? Number(r.net_days) : null,
          paid_to: r.paid_to === 'GZ28BR' ? 'GZ28BR' : 'GZ28US',
        }))
        for (const r of clean) {
          if (r.due_rule === 'DATE' && !r.due_date) return bad(`installment ${r.seq}: due_date missing`)
          if (r.due_rule === 'NET_DAYS' && !(r.net_days >= 0)) return bad(`installment ${r.seq}: net_days missing`)
        }
        const del = await db.from('invoice_installments').delete().eq('invoice_id', id)
        if (del.error) return rpcErr(del.error.message)
        const ins = await db.from('invoice_installments').insert(clean)
        if (ins.error) return rpcErr(ins.error.message)
      }
      if (body.terms && typeof body.terms === 'object') {
        const up: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (Array.isArray(body.terms.rails)) up.rails = body.terms.rails.filter((r: string) => ['card', 'us_bank_account', 'ZELLE', 'WIRE', 'PIX_BR'].includes(r))
        if (body.terms.fee_policy === 'ABSORB' || body.terms.fee_policy === 'GROSS_UP') up.fee_policy = body.terms.fee_policy
        if (Number(body.terms.valid_days) >= 1 && Number(body.terms.valid_days) <= 365) up.valid_days = Number(body.terms.valid_days)
        const r = await db.from('invoice_terms').update(up).eq('invoice_id', id)
        if (r.error) return rpcErr(r.error.message)
      }
      return NextResponse.json({ ok: true })
    }
    case 'send': {
      const channel = String(body.channel || 'COPY').toUpperCase()
      if (!CHANNELS.includes(channel) || channel === 'RECORDED') return bad('channel')
      if (body.send_by_app) return bad('SEND BY APP is not enabled tonight — copy the text and send it yourself (nothing is sent by the app)', 409)
      const validDays = Number(body.valid_days || s.terms?.valid_days || 30)
      if (!s.terms) { await db.rpc('seed_terms', { p_invoice: id }); s = (await loadDocState(db, id))! }
      const b = buildRevision(s.bundle, s.terms!, s.plan, { validUntil: addDays(orlandoToday(), validDays) })
      if (b.problems.length) return bad('not ready to send', 400, { problems: b.problems })
      const aa = body.already_approved
      if (aa && (!SHOP_METHODS.includes(aa.method) || !String(aa.note || '').trim() || String(aa.signer_name || '').trim().length < 2)) return bad('already approved: method, signer name and note are required')
      const { data: sent, error } = await db.rpc('quote_send', { p_invoice: id, p_actor: actor, p_channel: channel, p_sent_to: body.sent_to ? String(body.sent_to).slice(0, 200) : null,
        p_valid_days: validDays, p_document: b.document, p_sha256: b.sha256, p_presented_sha256: b.presented_sha256, p_terms_sha256: b.terms_sha256,
        p_grand: b.grand, p_fl_tax: b.fl_tax, p_fl_status: b.fl_status, p_by_app: false })
      if (error) return rpcErr(error.message)
      if (aa) {
        const { error: e2 } = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: (sent as any).revision_id, p_sha256: b.sha256, p_terms_sha256: b.terms_sha256,
          p_signer_name: String(aa.signer_name).trim().slice(0, 80), p_signer_contact: body.sent_to || null, p_consents: { recorded: true }, p_attribution: {},
          p_method: aa.method, p_recorded_by: actor, p_ip: null, p_user_agent: null, p_note: String(aa.note).slice(0, 500), p_evidence_url: aa.evidence_url || null, p_signature_path: null })
        if (e2) return rpcErr('sent, but recording the approval failed: ' + e2.message)
      }
      s = (await loadDocState(db, id))!
      const tok = await linkToken(db, id)
      const url = tok ? publicUrl(tok) : ''
      return NextResponse.json({ ok: true, sent, url, text: sendText(s, url, (s.terms?.language || 'en') as Lang, !!aa) })
    }
    case 'revision': {
      const { data, error } = await db.rpc('quote_revision_supersede', { p_invoice: id, p_actor: actor })
      if (error) return rpcErr(error.message)
      return NextResponse.json({ ok: true, result: data, editor_url: inv.ride_id ? `/rides/${inv.ride_id}/invoices/edit/${id}?from=doc` : `/clients/${inv.client_id}/invoices/edit/${id}?from=doc` })
    }
    case 'rotate': {
      const { data, error } = await db.rpc('quote_rotate_link', { p_invoice: id, p_actor: actor })
      if (error) return rpcErr(error.message)
      const tok = await linkToken(db, id)
      return NextResponse.json({ ok: true, link_id: data, url: tok ? publicUrl(tok) : null })
    }
    case 'gate-unlock': {
      if (!s.liveLink) return bad('no live link', 404)
      const { error } = await db.rpc('gate_unlock', { p_link: s.liveLink.id, p_actor: actor })
      return error ? rpcErr(error.message) : NextResponse.json({ ok: true })
    }
    case 'extend': {
      const { data, error } = await db.rpc('quote_extend', { p_invoice: id, p_days: Number(body.days), p_actor: actor })
      return error ? rpcErr(error.message) : NextResponse.json({ ok: true, valid_until: data })
    }
    case 'void': {
      const typed = String(body.confirm || '').trim()
      const num = String(inv.invoice_code || '').match(/(\d{3})(?:\.\d+)?$/)?.[1] || ''
      if (!typed || (typed !== num && typed !== inv.invoice_code)) return bad(`type the number (${num}) to confirm VOID`)
      const { data, error } = await db.rpc('quote_void', { p_invoice: id, p_actor: actor })
      if (error) return rpcErr(error.message)
      const expired = await expireOpenSessions(db, id, ((data as any)?.sessions || []) as string[])
      return NextResponse.json({ ok: true, expired })
    }
    case 'note-hide': {
      const nid = String(body.note_id || '')
      if (!UUID.test(nid)) return bad('note_id')
      const { error } = await db.from('invoice_client_notes').update({ hidden_at: new Date().toISOString(), hidden_by: actor }).eq('id', nid).eq('invoice_id', id)
      return error ? rpcErr(error.message) : NextResponse.json({ ok: true })
    }
    case 'approve-manual': {
      const method = String(body.method || '')
      if (!SHOP_METHODS.includes(method)) return bad('method')
      const name = String(body.signer_name || '').trim(), note = String(body.note || '').trim()
      if (name.length < 2 || !note) return bad('signer name and note are required')
      if (s.approvalOnLive) return bad('already approved', 409)
      const fr = await freezeRecorded(db, s, actor)
      if (fr) return bad(fr)
      s = (await loadDocState(db, id))!
      const { data, error } = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: s.live!.id, p_sha256: s.live!.sha256, p_terms_sha256: s.live!.terms_sha256,
        p_signer_name: name.slice(0, 80), p_signer_contact: null, p_consents: { recorded: true }, p_attribution: {}, p_method: method, p_recorded_by: actor,
        p_ip: null, p_user_agent: null, p_note: note.slice(0, 500), p_evidence_url: body.evidence_url || null, p_signature_path: null })
      return error ? rpcErr(error.message) : NextResponse.json({ ok: true, approval_id: data })
    }
    case 'deposit-manual': {
      // WHITELIST only — livemode / reported_at / mute are decided server-side.
      const src = MANUAL_SOURCES[String(body.source || '').toUpperCase()]
      if (!src) return bad('source (ZELLE · WIRE · CASH · CHECK · PIX · OTHER)')
      const amount = Number(body.amount)
      if (!(amount > 0)) return bad('amount')
      const paidOn = String(body.paid_on || orlandoToday()).slice(0, 10)
      const today = orlandoToday()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today || paidOn < addDays(today, -90)) return bad('paid_on must be within the last 90 days')
      const capUsd = Number(await readSetting<number>('deposit.manual_cap')) || 10000
      if ((src === 'CASH' || src === 'OTHER') && amount > capUsd && !body.receipt_url) return bad(`CASH / OTHER above US$ ${capUsd} needs a receipt`)
      const paidTo = body.paid_to === 'GZ28BR' ? 'GZ28BR' : 'GZ28US'
      if (paidTo === 'GZ28BR' && !(Number(body.amount_brl) > 0)) return bad('GZ28BR needs the R$ amount')
      let seq: number | null = body.seq != null ? Number(body.seq) : null
      if (inv.is_quote) {
        if (!s.approvalOnLive) {
          const ap = body.approval
          if (!ap || !SHOP_METHODS.includes(ap.method) || !String(ap.note || '').trim()) return bad('How did the client approve? (approval: method + note)', 400, { needs_approval: true })
          const fr = await freezeRecorded(db, s, actor)
          if (fr) return bad(fr)
          s = (await loadDocState(db, id))!
          const { error } = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: s.live!.id, p_sha256: s.live!.sha256, p_terms_sha256: s.live!.terms_sha256,
            p_signer_name: String(ap.signer_name || s.bundle.client?.name || 'client').slice(0, 80), p_signer_contact: null, p_consents: { recorded: true }, p_attribution: {},
            p_method: ap.method, p_recorded_by: actor, p_ip: null, p_user_agent: null, p_note: String(ap.note).slice(0, 500), p_evidence_url: null, p_signature_path: null })
          if (error) return rpcErr(error.message)
          s = (await loadDocState(db, id))!
        }
        seq = seq || 1
      } else if (!s.live) {
        seq = null                                            // a legacy / hand-made invoice: settle a picked income or add one paid row
      }
      await expireOpenSessions(db, id)
      const { data: att, error: e1 } = await db.rpc('attempt_open', { p_invoice: id, p_link: null, p_seq: seq, p_rail: src === 'ZELLE' ? 'ZELLE' : src === 'WIRE' ? 'WIRE' : src === 'PIX_BR' ? 'PIX_BR' : null,
        p_provider: src, p_livemode: false, p_actor: actor, p_amount_cents: Math.round(amount * 100) })
      if (e1) return rpcErr(e1.message)
      const money = { amount_cents: Math.round(amount * 100), currency: 'usd', source: src === 'PIX_BR' ? 'PIX' : src, paid_on: paidOn, paid_to: paidTo,
        amount_brl: paidTo === 'GZ28BR' ? Number(body.amount_brl) : undefined, receipt_url: body.receipt_url ? JSON.stringify([String(body.receipt_url)]) : undefined,
        payment_reference: body.reference ? `${src.toLowerCase()}:${String(body.reference).slice(0, 60)}` : undefined, income_id: body.income_id || undefined,
        description: body.description ? String(body.description).slice(0, 120) : undefined, livemode: false }
      const { data, error } = await db.rpc('book_payment', { p_attempt: (att as any).id, p_money: money, p_actor: actor })
      if (error) return rpcErr(error.message)
      if ((data as any)?.hired) {
        const { afterHire } = await import('@/lib/hire.server')
        const { after } = await import('next/server')
        after(() => afterHire(id, data as Record<string, any>).catch(e => console.error('[hire ladder]', id, e?.message || e)))
      }
      return NextResponse.json({ ok: true, result: data })
    }
    default:
      return bad('unknown action', 404)
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) { return handle(req, ctx, 'GET') }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) { return handle(req, ctx, 'POST') }
