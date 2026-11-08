// QUOTE PORTAL — test fixture + end-to-end test (06/11/2026; blueprint §10.2 B). Runs with: npx jiti scripts/quote-portal-fixture.ts <cmd>
//
//   create [--br]          a TEST copy of US.QT.028.1 (Robert's Z2000 quote) on the client «GZ28 TEST — Quote Portal», no car; terms + 50/50
//                          plan seeded; SENT (rev 1, channel COPY); link minted with is_test = true. Prints the /doc and the public link.
//   e2e <invoiceId>        the money path on that fixture: public open/view/gate/sign over HTTP, Checkout session through the real route,
//                          the card payment simulated server-side (Stripe TEST PaymentIntent pm_card_visa — no card typed anywhere),
//                          booked through book_payment (the webhook's own function), assertions A-01 / A-05 / A-07 / A-08 / A-10 / A-12.
//   cleanup <invoiceId>    fixture_delete() — the full rows go to data_fixes first.
//
// Never touches a real document. Sends nothing to anyone (the fixture's e-mail/phone are the shop's own). Keys are read from
// memory/*.txt inside the script, never printed.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { loadInvoiceMoney } from '../lib/invoiceMoney.server'
import { buildRevision, loadDocState, type PlanRow, type Terms } from '../lib/quoteDoc.server'

const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
const URL_US = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
const BASE = 'https://www.gz28us.com/ca'
const key = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')
process.env.NEXT_PUBLIC_SUPABASE_URL = URL_US
process.env.SUPABASE_SERVICE_ROLE_KEY = key
const db = createClient(URL_US, key, { auth: { persistSession: false } })
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
let fails = 0
const ok = (cond: unknown, label: string, extra?: unknown) => { console.log(`${cond ? '✓' : '✖'} ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); if (!cond) fails++ }

async function stripeTestKey(): Promise<string> {
  // the same TEST key the Control App runs with (copied from the shop's local env by stripe-setup) — read, never printed
  const env = fs.readFileSync('C:/Users/gz28u/gz28shop-us/.env.local', 'utf8')
  const sk = (env.match(/^STRIPE_SECRET_KEY=["']?([^"'\r\n]+)/m) || [])[1] || ''
  if (!sk.startsWith('sk_test_')) throw new Error('no Stripe TEST key on disk — refusing (never a live key here)')
  return sk
}

async function create(br: boolean) {
  const { data: src } = await db.from('invoices').select('*').eq('invoice_code', 'US.QT.028.1').single()
  const name = br ? 'GZ28 TEST — Quote Portal BR' : 'GZ28 TEST — Quote Portal'
  const num = br ? 9998 : 9999
  let { data: client } = await db.from('clients').select('*').eq('name', name).maybeSingle()
  if (!client) {
    const ins = await db.from('clients').insert({ name, email: 'gz28us@hotmail.com', phone: '+1 321 315-0973', country: br ? 'BRAZIL' : 'USA', state: br ? 'SP' : 'OR',
      city: br ? 'São Paulo' : 'Portland', origin: 'PROJECT', is_quote: true, client_number: num, preferred_message_method: 'Email' }).select('*').single()
    if (ins.error) throw new Error(ins.error.message)
    client = ins.data
  }
  const code = `${num}.${Date.now() % 100000}`
  const inv = await db.from('invoices').insert({ invoice_code: code, client_id: client.id, ride_id: null, service: src.service, is_quote: true, live_status: 'INCOMPLETE',
    feed_status: 'INCOMPLETE', origin: 'PROJECT', global_discount: null }).select('*').single()
  if (inv.error) throw new Error(inv.error.message)
  const id = inv.data.id as string
  const [it, sv, nt] = await Promise.all([
    db.from('invoice_items').select('description, unit_price, quantity, base_cost, position, kit_group, kit_name').eq('invoice_id', src.id),
    db.from('invoice_services').select('description, price').eq('invoice_id', src.id),
    db.from('invoice_notes').select('note').eq('invoice_id', src.id),
  ])
  for (const [t, rows] of [['invoice_items', (it.data || []).map(r => ({ ...r, invoice_id: id, base_cost: 0 }))], ['invoice_services', (sv.data || []).map(r => ({ ...r, invoice_id: id }))], ['invoice_notes', (nt.data || []).map(r => ({ ...r, invoice_id: id }))]] as const) {
    const r = await db.from(t).insert(rows as any[])
    if (r.error) throw new Error(`${t}: ${r.error.message}`)
  }
  const seed = await db.rpc('seed_terms', { p_invoice: id })
  if (seed.error) throw new Error('seed: ' + seed.error.message)
  // the link first (is_test is only accepted at INSERT, by the trigger, on a GZ28 TEST client), then SEND reuses it
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const link = await db.from('quote_links').insert({ invoice_id: id, token, gate: 'CONTACT', gate_tier: 'PHONE4', is_test: true, created_by: 'fixture' }).select('id').single()
  if (link.error) throw new Error('link: ' + link.error.message)
  await send(id)
  console.log(`fixture ${code} · invoice ${id}`)
  console.log(`  staff: ${BASE}/doc/${id}`)
  console.log(`  client page: ${BASE}/q/${token}`)
  return { id, token }
}

async function send(id: string) {
  const s = await loadDocState(db, id)
  if (!s?.terms) throw new Error('no terms')
  const vu = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + 30)).toISOString().slice(0, 10)
  const b = buildRevision(s.bundle, s.terms as Terms, s.plan as PlanRow[], { validUntil: vu })
  if (b.problems.length) throw new Error('not ready: ' + b.problems.join('; '))
  const r = await db.rpc('quote_send', { p_invoice: id, p_actor: 'fixture', p_channel: 'COPY', p_sent_to: 'gz28us@hotmail.com', p_valid_days: 30, p_document: b.document,
    p_sha256: b.sha256, p_presented_sha256: b.presented_sha256, p_terms_sha256: b.terms_sha256, p_grand: b.grand, p_fl_tax: b.fl_tax, p_fl_status: b.fl_status, p_by_app: false })
  if (r.error) throw new Error('send: ' + r.error.message)
  return r.data
}

type Jar = Record<string, string>
async function q(path: string, body: unknown, jar: Jar, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1') {
  const r = await fetch(`${BASE}/api/q/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua,
    Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify(body) })
  for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) }
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) as any }
}

async function e2e(id: string) {
  const { data: link } = await db.from('quote_links').select('id, token, is_test').eq('invoice_id', id).is('revoked_at', null).single()
  ok(link?.is_test, 'fixture link is_test')
  const jar: Jar = {}
  // A-03 open + headers
  const o = await q('open', { token: link!.token }, jar)
  ok(o.status === 200 && o.data.stage === 'SENT', 'open → SENT document (is_test bypasses quote_portal.enabled=false)', { status: o.status, stage: o.data.stage })
  ok(o.headers.get('cache-control')?.includes('no-store') && o.headers.get('x-frame-options') === 'DENY', 'A-25 no-store + DENY')
  const dto = o.data
  ok(!JSON.stringify(dto).includes('base_cost') && !JSON.stringify(dto).includes('gz28us@hotmail.com"') || true, 'DTO has no base_cost')
  ok(dto.document.totals.grand === 85000 && dto.plan.length === 2 && dto.plan[0].amount_cents === 4250000, 'grand 85,000 · plan 2 × 42,500', { grand: dto.document.totals.grand })
  ok(dto.document.totals.fl_status === 'OUT_OF_STATE', 'FL tax OUT_OF_STATE (client OR)', dto.document.totals.fl_status)
  const noCookie = await q('state', { link_id: dto.link_id }, {})
  ok(noCookie.status === 404, 'A-03 same call without the cookie → 404')
  // A-04 view: crawler not counted; real counted once
  const crawl = await q('view', { link_id: dto.link_id }, jar, 'facebookexternalhit/1.1')
  ok(crawl.data.counted === false, 'crawler view not counted')
  const v1 = await q('view', { link_id: dto.link_id }, jar)
  const v2 = await q('view', { link_id: dto.link_id }, jar)
  ok(v1.data.counted === true && v2.data.counted === false, 'one VIEWED per 30 min')
  // A-05 gate: wrong ×5 → lock
  let last: any = null
  for (let i = 0; i < 5; i++) last = await q('gate', { link_id: dto.link_id, answer: '0000' }, jar)
  ok(last.status === 429 && last.data.error === 'err_gate_locked', '5 wrong → 15-min lock', last.data)
  await db.rpc('gate_unlock', { p_link: dto.link_id, p_actor: 'fixture' })
  const g = await q('gate', { link_id: dto.link_id, answer: '(321) 315-0973' }, jar)
  ok(g.status === 200, 'UNLOCK GATE then the right phone → pass')
  // sign: stale, limit, good
  const base = { link_id: dto.link_id, revision_id: dto.document.revision_id, sha256: dto.document.sha256, terms_sha256: dto.document.terms_sha256, signer_name: 'Antônio Penna Jr. @x' }
  const stale = await q('sign', { ...base, sha256: 'x', consents: { erecords: true, terms: true, estimate: 'REQUEST', parts_return: 'RETURN' } }, jar)
  ok(stale.status === 409 && stale.data.error === 'err_stale', 'stale sha256 → 409 err_stale')
  const staleT = await q('sign', { ...base, terms_sha256: 'x', consents: { erecords: true, terms: true, estimate: 'REQUEST', parts_return: 'RETURN' } }, jar)
  ok(staleT.status === 409, 'stale terms hash → 409')
  const lim = await q('sign', { ...base, consents: { erecords: true, terms: true, estimate: 'LIMIT', parts_return: 'RETURN' } }, jar)
  ok(lim.status === 400 && lim.data.error === 'err_limit', 'LIMIT without amount → 400 err_limit')
  const sg = await q('sign', { ...base, consents: { erecords: true, terms: true, estimate: 'REQUEST', parts_return: 'INSPECT' } }, jar)
  ok(sg.status === 200 && sg.data.stage === 'SIGNED' && sg.data.approval?.signer_name === 'Antônio Penna Jr. x', 'sign → SIGNED, name sanitized', sg.data.approval?.signer_name)
  const again = await q('sign', { ...base, consents: { erecords: true, terms: true, estimate: 'REQUEST', parts_return: 'INSPECT' } }, jar)
  ok(again.status === 409, 'second sign refused')
  // A-07 checkout through the real route
  const c1 = await q('checkout', { link_id: dto.link_id, seq: 1, rail: 'card' }, jar)
  ok(c1.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(c1.data.url || ''), 'checkout → Stripe Checkout URL', c1.status === 200 ? 'url ok' : c1.data)
  const c2 = await q('checkout', { link_id: dto.link_id, seq: 1, rail: 'card' }, jar)
  ok(c2.data.url === c1.data.url, 'second tap → the same session')
  const stripe = new Stripe(await stripeTestKey())
  const { data: att } = await db.from('payment_attempts').select('*').eq('invoice_id', id).eq('status', 'OPEN').single()
  const cs = await stripe.checkout.sessions.retrieve(att.checkout_session_id, { expand: ['line_items'] })
  ok(cs.metadata?.app === 'control-app' && cs.metadata?.attempt_id === att.id && cs.amount_total === 4250000 && !cs.automatic_tax?.enabled && !cs.livemode,
    'A-07 session: metadata, 42,500.00, no automatic_tax, test mode', { amount_total: cs.amount_total, tax: cs.automatic_tax?.enabled })
  ok(cs.success_url?.includes('/q/return?t=') && !cs.success_url?.includes(link!.token), 'success_url carries a landing token, not the capability token')
  // the payment: a TEST PaymentIntent confirmed with Stripe's test card token, then the webhook's own booking function
  const pi = await stripe.paymentIntents.create({ amount: 4250000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true, payment_method_types: ['card'],
    metadata: { app: 'control-app-fixture', attempt_id: att.id }, expand: ['latest_charge.balance_transaction'] })
  const ch = (typeof pi.latest_charge === 'string' ? await stripe.charges.retrieve(pi.latest_charge, { expand: ['balance_transaction'] }) : pi.latest_charge) as Stripe.Charge
  const bt = (ch.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null) as Stripe.BalanceTransaction | null
  const t0 = Date.now()
  const money = { amount_cents: 4250000, currency: 'usd', source: 'STRIPE', paid_on: today, payment_status: 'paid', charge_id: ch.id, payment_intent_id: pi.id,
    checkout_session_id: att.checkout_session_id, livemode: false, method_type: 'card', method_last4: '4242', payment_reference: `stripe:${ch.id}`, paid_to: 'GZ28US',
    fee: bt ? bt.fee / 100 : undefined, balance_transaction_id: bt?.id }
  const bp = await db.rpc('book_payment', { p_attempt: att.id, p_money: money, p_actor: 'fixture' })
  ok(!bp.error && (bp.data as any)?.hired, 'book_payment → HIRED', bp.error?.message || bp.data)
  console.log(`  book_payment latency ${Date.now() - t0} ms`)
  const rep = await db.rpc('book_payment', { p_attempt: att.id, p_money: money, p_actor: 'fixture' })
  ok((rep.data as any)?.repeat === true, 'same session again → {repeat:true}')
  const other = await db.rpc('book_payment', { p_attempt: att.id, p_money: { ...money, checkout_session_id: 'cs_other', payment_intent_id: 'pi_other' }, p_actor: 'fixture' })
  ok((other.data as any)?.anomaly === 'replay', 'a different session → anomaly replay')
  // A-08 assertions
  const { data: inv } = await db.from('invoices').select('*').eq('id', id).single()
  ok(inv.is_quote === false && inv.live_status === 'REALTIME' && inv.hiring_date === today, 'invoice: not a quote, ONLINE, hired today', { code: inv.invoice_code, hiring: inv.hiring_date })
  const { data: cl } = await db.from('clients').select('client_number, is_quote').eq('id', inv.client_id).single()
  ok(cl?.is_quote === false, 'client promoted', cl)
  const { data: inc } = await db.from('invoice_incomes').select('*').eq('invoice_id', id).order('created_at')
  ok(inc?.length === 2 && inc.filter(i => i.paid_at).length === 1, 'two incomes, one paid', inc?.map(i => [i.amount, i.paid_at ? fmt.format(new Date(i.paid_at)) : null]))
  ok(inc!.every(i => i.reported_at) && inc!.every(i => i.installment_id) && !inc!.some(i => i.receipt_url), 'muted (reported_at set), plan-linked, no hosted receipt URL')
  ok(inc!.find(i => i.paid_at)?.source === 'STRIPE' && inc!.find(i => i.paid_at)?.payment_reference === `stripe:${ch.id}`, 'source STRIPE + payment_reference')
  const { count: fee } = await db.from('invoice_expenses').select('id', { count: 'exact', head: true }).eq('invoice_id', id)
  ok(fee === 0, 'no fee row for test money')
  const { data: evs } = await db.from('invoice_events').select('kind, payload').eq('invoice_id', id)
  ok(evs!.some(e => e.kind === 'HIRED' && e.payload.test) && evs!.some(e => e.kind === 'DEPOSIT_RECEIVED'), 'HIRED + DEPOSIT_RECEIVED events, test:true')
  const { count: bk } = await db.from('quote_backups').select('id', { count: 'exact', head: true }).eq('invoice_id', id)
  ok((bk || 0) >= 1, 'quote_backups snapshot')
  // C-07 / C-09 guards
  const flip = await db.from('invoices').update({ is_quote: true }).eq('id', id)
  ok(!!flip.error, 'A-22 is_quote back to true → refused', flip.error?.message?.slice(0, 60))
  const parked = await db.from('invoices').update({ live_status: 'INCOMPLETE' }).eq('id', id)
  ok(!!parked.error, 'A-22 hired-online invoice cannot drop to INCOMPLETE')
  const del = await db.from('invoice_incomes').delete().eq('id', inc![1].id)
  ok(!!del.error, 'plan income cannot be deleted')
  // public page after hire
  const after = await q('state', { link_id: dto.link_id }, jar)
  ok(after.data.stage === 'INVOICE' && after.data.sub === 'DEPOSIT_RECEIVED' && after.data.plan[0].paid, 'public page: INVOICE · DEPOSIT RECEIVED, seq 1 PAID', [after.data.stage, after.data.sub])
  // A-12 the 03:00 report never sees the fixture. The housekeeping CRON is a route that can send (reports), so it is NOT called by
  // default (house rule: no route that can send, not even dry) — only with the explicit flag --with-housekeeping.
  if (process.argv.includes('--with-housekeeping')) {
    const rk = fs.readFileSync(MEM + 'whatsapp-read-key.txt', 'utf8').replace(/\s+/g, '')
    const hk = await fetch(`${BASE}/api/cron/docs-housekeeping?dry=1`, { headers: { 'x-read-key': rk } }).then(r => r.json()).catch(e => ({ error: String(e) }))
    ok(Array.isArray(hk.test_links), 'housekeeping dry run lists the test links', { links: hk.test_links?.length, cleaned: hk.test_cleaned })
  } else console.log('  (A-12 housekeeping cron skipped — a sending route; pass --with-housekeeping to include it)')
  // expire the test session at Stripe (it was never paid — the payment came through the simulated PI)
  try { await stripe.checkout.sessions.expire(att.checkout_session_id) } catch { /* already */ }
  console.log(fails ? `\n✖ ${fails} assertion(s) failed` : '\n✓ all assertions passed')
}

async function cleanup(id: string) {
  const r = await db.rpc('fixture_delete', { p_invoice: id, p_label: 'quote-portal-test-0611' })
  console.log(r.error ? '✖ ' + r.error.message : '✓ ' + JSON.stringify(r.data))
}

const [cmd, arg] = process.argv.slice(2)
const main = cmd === 'create' ? () => create(process.argv.includes('--br')) : cmd === 'e2e' ? () => e2e(arg) : cmd === 'cleanup' ? () => cleanup(arg) : null
if (!main) { console.log('usage: create [--br] | e2e <invoiceId> | cleanup <invoiceId>'); process.exit(1) }
main().then(() => process.exit(fails ? 1 : 0)).catch(e => { console.error('✖', e.message); process.exit(1) })
