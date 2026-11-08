// QUOTE PORTAL M4 — LOCAL harness of the wired senders + the signing code (08/11/2026). NO database, NO network, NO real transport:
// a FAKE transport is injected and the harness proves the real one is never reached (global fetch is a trap that counts calls; the
// UltraMsg / Supabase / Graph env vars are removed before anything loads). Nothing here can message anyone.
//   npx jiti scripts/test-notify-senders.ts            (JITI_ALIAS='{"@":"<repo abs path>"}' when a module imports "@/")
/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

for (const k of ['ULTRAMSG_INSTANCE', 'ULTRAMSG_TOKEN', 'ULTRAMSG_GROUP_ID', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BR_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY']) delete process.env[k]
process.env.QUOTE_GATE_SECRET = 'harness-only-secret-not-a-real-key-0123456789'
let fetchCalls = 0
;(globalThis as any).fetch = async () => { fetchCalls++; throw new Error('NETWORK FORBIDDEN IN THE HARNESS') }

let ok = 0, bad = 0
const t = (name: string, cond: unknown, got?: unknown) => { if (cond) ok++; else { bad++; console.log('✖', name, got === undefined ? '' : JSON.stringify(got)) } }

async function main() {
  const N = await import('../lib/notify.server')
  const O = await import('../lib/quoteOtp.server')
  const TR = await import('../lib/notifyTransport.server')
  const { WA_REPORTS_US } = await import('../lib/waSelfGuard.server')
  const { SIGNATURE } = await import('../lib/waSignature')

  // ── fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const calls: { ch: 'wa' | 'email'; to: string; body: string; logHead?: string }[] = []
  const fake: import('../lib/notifyTransport.server').Transport = {
    name: 'fake',
    async whatsapp(to, body, o) { calls.push({ ch: 'wa', to, body, logHead: o?.logHead }); return { ok: true, error: null, status: 200, id: 'fake-' + calls.length } },
    async email(m) { calls.push({ ch: 'email', to: m.to, body: m.subject + '\n' + m.html }); return null },
  }
  TR.setTransportForTests(fake)
  let settings: Record<string, unknown> = {}
  const events: { kind: string; payload: any }[] = []
  const db: any = {
    rpc: async (fn: string, a: any) => { if (fn === 'doc_event') events.push({ kind: a.p_kind, payload: a.p_payload }); return { data: null, error: null } },
    from: (tb: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tb === 'quote_links' ? { token: 'TOKEN_abcdefghijklmnopqrstuvwxyz0123' } : null, error: null }) }) }) }),
  }
  const doc = (isTest: boolean, phone = '(407) 555-0142', email = 'client@example.com', sent = 'WHATSAPP'): any => ({
    bundle: { invoice: { id: 'inv-1', invoice_code: 'US.QT.900.1' }, client: { name: 'John @14075550000 Doe', phone, email, country: 'USA' }, money: { grand: 1000 }, ride: null, incomes: [] },
    terms: { language: 'en', valid_until: '2026-12-01' }, live: { id: 'rev-1', seq: 1, sent_channel: sent, grand_total: 1000, document: { header: { display_code: 'US.QT.900.1', car: 'Test Car' }, installments: [{ seq: 1, amount_cents: 50000 }] } },
    liveLink: { id: 'link-1', is_test: isTest }, isTest, attempts: [{ id: 'att-1', status: 'SUCCEEDED', amount_cents: 50000, rail: 'card' }], approvalOnLive: { signer_name: 'John' },
  })
  let state: any = doc(false)
  const reset = () => { calls.length = 0; events.length = 0 }
  N.setNotifyDepsForTests({
    settingOn: async k => settings[k] === true,
    readSetting: async <T,>(k: string) => settings[k] as T | undefined,
    loadDocState: async () => state,
    buildPortalMail: (async (_db: any, kind: any) => ({ to: 'client@example.com', subject: 'S ' + kind, html: '<p>x</p>', attachments: [], invoiceId: 'inv-1', revisionId: 'rev-1', isTest: false })) as any,
    transport: TR.transport,
  })
  const ctx = { invoiceId: 'inv-1', revisionId: 'rev-1' }
  t('the harness transport is the fake', TR.transport().name === 'fake')

  // ── 1. every key OFF → skipped, no transport call ─────────────────────────────────────────────────────────────────────
  reset()
  const msgKeys = N.NOTIFY_KEYS.filter(k => k.channel !== 'otp')
  for (const k of msgKeys) {
    const r = await N.notify(db, k.key, ctx)
    t(`OFF ${k.key} → skipped 'off'`, !r.sent && r.reason === 'off', r)
  }
  t('OFF: zero transport calls', calls.length === 0, calls)
  t('OFF: one NOTIFY_SKIPPED per key, zero NOTIFIED', events.length === msgKeys.length && events.every(e => e.kind === 'NOTIFY_SKIPPED'), events.length)
  reset()
  t('otp key through notify() → skipped, not a message', (await N.notify(db, N.OTP_KEY, ctx)).reason === 'behaviour key, not a message' && calls.length === 0)

  // ── 2. ON → exactly one call with the right target ────────────────────────────────────────────────────────────────────
  reset(); settings = { 'notify.reports.quote_signed': true }
  let r = await N.notify(db, 'notify.reports.quote_signed', ctx)
  t('REPORTS ON → sent', r.sent, r)
  t('REPORTS ON → exactly one call, to the REPORTS group', calls.length === 1 && calls[0].ch === 'wa' && calls[0].to === WA_REPORTS_US, calls)
  t('REPORTS text = QUOTE SIGNED line', /✍ \*QUOTE SIGNED\* US\.QT\.900\.1 — Test Car/.test(calls[0]?.body || ''), calls[0]?.body)
  t('house signature is the last line', (calls[0]?.body || '').endsWith('\n\n' + SIGNATURE))
  t('outside name cannot @-mention (semMarcacao)', !(calls[0]?.body || '').includes('@14075550000'), calls[0]?.body)
  t('NOTIFIED event, masked target', events.length === 1 && events[0].kind === 'NOTIFIED' && events[0].payload.to === 'REPORTS group', events)

  reset(); settings = { 'notify.owner.dispute': true }
  r = await N.notify(db, 'notify.owner.dispute', ctx)
  t('OWNER ON → one call to REPORTS (owner number is the instance = self)', r.sent && calls.length === 1 && calls[0].to === WA_REPORTS_US && /OWNER ALERT/.test(calls[0].body), calls)

  reset(); settings = { 'notify.client.quote_sent.whatsapp': true }
  r = await N.notify(db, 'notify.client.quote_sent.whatsapp', ctx)
  t('client WA ON but quote_portal.enabled OFF (real doc) → skipped, no call', !r.sent && r.reason === 'quote_portal.enabled is OFF' && calls.length === 0, r)
  reset(); settings = { 'notify.client.quote_sent.whatsapp': true, 'quote_portal.enabled': true }
  r = await N.notify(db, 'notify.client.quote_sent.whatsapp', ctx)
  t('client WA ON → one call to the client phone (+1 by country)', r.sent && calls.length === 1 && calls[0].to === '14075550142@c.us', calls)
  t('client WA carries the portal link', (calls[0]?.body || '').includes('/q/TOKEN_abcdefghijklmnopqrstuvwxyz0123'))
  reset(); state = doc(false, '')
  r = await N.notify(db, 'notify.client.quote_sent.whatsapp', ctx)
  t('client WA without a phone → skipped, no call', !r.sent && calls.length === 0, r)

  reset(); state = doc(false); settings = { 'notify.client.signed_copy': true }
  r = await N.notify(db, 'notify.client.signed_copy', ctx)
  t('client e-mail ON → exactly one e-mail to the client on file', r.sent && calls.length === 1 && calls[0].ch === 'email' && calls[0].to === 'client@example.com', calls)
  reset(); settings = { 'notify.client.deposit_clearing': true }
  r = await N.notify(db, 'notify.client.deposit_clearing', ctx)
  t('ON but template pending → sender not wired, no call', !r.sent && r.reason === 'sender not wired' && calls.length === 0, r)

  // test document: only notify.test_targets
  reset(); state = doc(true); settings = { 'notify.client.quote_sent.whatsapp': true, 'notify.reports.quote_sent': true, 'notify.test_targets': ['me@example.com'] }
  r = await N.notify(db, 'notify.client.quote_sent.whatsapp', ctx)
  t('TEST doc, client phone not a test target → skipped, no call', !r.sent && calls.length === 0, r)
  r = await N.notify(db, 'notify.reports.quote_sent', ctx)
  t('TEST doc, no WhatsApp test target → REPORTS never pinged', !r.sent && calls.length === 0, r)
  settings['notify.test_targets'] = ['me@example.com', '+1 (407) 555-0142', '14075559999']
  r = await N.notify(db, 'notify.reports.quote_sent', ctx)
  t('TEST doc REPORTS → the first WhatsApp test target, never the group', r.sent && calls.length === 1 && calls[0].to === '14075550142@c.us' && calls[0].body.startsWith('🧪 TEST'), calls)
  reset()
  r = await N.notify(db, 'notify.client.quote_sent.whatsapp', ctx)
  t('TEST doc, client phone IS a test target → one call to it', r.sent && calls.length === 1 && calls[0].to === '14075550142@c.us', calls)

  // SEND TEST TO ME
  reset(); settings = { 'notify.test_targets': ['me@example.com', '14075559999'] }
  const st = await N.sendTest('notify.reports.quote_signed', 'harness@example.com')
  t('SEND TEST (WhatsApp key) → only the WhatsApp test target', st.ok && calls.length === 1 && calls[0].to === '14075559999@c.us', calls)
  reset()
  const st2 = await N.sendTest('notify.client.signed_copy', 'harness@example.com')
  t('SEND TEST (e-mail key) → only the e-mail test target', st2.ok && calls.length === 1 && calls[0].to === 'me@example.com', calls)
  reset(); settings = { 'notify.test_targets': [] }
  const st3 = await N.sendTest('notify.owner.refund', 'x')
  t('SEND TEST with no targets → refused, no call', !st3.ok && calls.length === 0, st3)

  // ── 3. the OTP message ────────────────────────────────────────────────────────────────────────────────────────────────
  reset(); settings = {}
  const om = { invoiceId: 'inv-1', revisionId: 'rev-1', isTest: false, channel: 'WHATSAPP' as const, to: '14075550142@c.us', code: '123456', lang: 'en' as const, docCode: 'US.QT.900.1' }
  let so = await N.sendOtpMessage(db, om)
  t('OTP message with the switch OFF → not sent, no call', !so.sent && calls.length === 0, so)
  settings = { [N.OTP_KEY]: true }
  so = await N.sendOtpMessage(db, om)
  t('OTP ON → exactly one WhatsApp to the client', so.sent && calls.length === 1 && calls[0].to === '14075550142@c.us' && calls[0].body.includes('123456'), calls)
  t('OTP code never in the wa_send_log head', !(calls[0]?.logHead || '').includes('123456') && !!calls[0]?.logHead, calls[0]?.logHead)
  t('OTP code never in an event', !JSON.stringify(events).includes('123456'), events)
  reset()
  so = await N.sendOtpMessage(db, { ...om, channel: 'EMAIL', to: 'client@example.com' })
  t('OTP by e-mail → one e-mail', so.sent && calls.length === 1 && calls[0].ch === 'email' && calls[0].to === 'client@example.com', calls)
  reset()
  so = await N.sendOtpMessage(db, { ...om, isTest: true })
  t('OTP on a TEST doc to a non-target → not sent', !so.sent && calls.length === 0, so)

  // ── 4. the code: hashed, 10 min, 5 tries → 15 min lock, resend 60 s, constant-time ───────────────────────────────────────
  const mem = new Map<string, any>()
  let storeCalls = 0
  const store: import('../lib/quoteOtp.server').OtpStore = {
    async get(id) { storeCalls++; return mem.has(id) ? { ...mem.get(id) } : null },
    async put(row, expect) { storeCalls++; const cur = mem.get(row.link_id); if (expect === null ? !!cur : !cur || cur.tries !== expect) return false; mem.set(row.link_id, { ...row }); return true },
  }
  const L = 'link-1', R = 'rev-1'
  let now = Date.UTC(2026, 10, 8, 12, 0, 0)
  const iss = await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'WHATSAPP', now, code: '424242' })
  t('issue → ok', iss.ok, iss)
  t('stored as HMAC, never the code', mem.get(L).code_hash !== '424242' && /^[0-9a-f]{64}$/.test(mem.get(L).code_hash) && !JSON.stringify(mem.get(L)).includes('424242'))
  t('expires in 10 minutes', new Date(mem.get(L).expires_at).getTime() - now === 10 * 60 * 1000)
  const again = await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'WHATSAPP', now: now + 30_000 })
  t('resend inside 60 s → err_otp_wait', !again.ok && (again as any).error === 'err_otp_wait' && (again as any).seconds === 30, again)
  for (let i = 1; i <= 4; i++) {
    const v = await O.otpVerify(store, { linkId: L, revisionId: R, code: '000000', now: now + i * 1000 })
    t(`wrong code #${i} → err_otp, ${5 - i} left`, !v.ok && (v as any).error === 'err_otp' && (v as any).left === 5 - i, v)
  }
  const v5 = await O.otpVerify(store, { linkId: L, revisionId: R, code: '000000', now: now + 5000 })
  t('wrong code #5 → LOCKED 15 min', !v5.ok && (v5 as any).error === 'err_otp_locked' && (v5 as any).minutes === 15, v5)
  const vRightLocked = await O.otpVerify(store, { linkId: L, revisionId: R, code: '424242', now: now + 6000 })
  t('right code while locked → still locked', !vRightLocked.ok && (vRightLocked as any).error === 'err_otp_locked', vRightLocked)
  const issLocked = await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'WHATSAPP', now: now + 120_000 })
  t('new code while locked → refused', !issLocked.ok && (issLocked as any).error === 'err_otp_locked', issLocked)
  now += 16 * 60 * 1000
  const iss2 = await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'WHATSAPP', now, code: '135790' })
  t('after the lock → a new code', iss2.ok, iss2)
  const vOld = await O.otpVerify(store, { linkId: L, revisionId: R, code: '424242', now: now + 1000 })
  t('the old code is dead', !vOld.ok && (vOld as any).error === 'err_otp', vOld)
  const vOther = await O.otpVerify(store, { linkId: L, revisionId: 'rev-2', code: '135790', now: now + 1500 })
  t('code of another revision → refused', !vOther.ok, vOther)
  const vOk = await O.otpVerify(store, { linkId: L, revisionId: R, code: '135790', now: now + 2000 })
  t('right code → verified', vOk.ok && (vOk as any).channel === 'WHATSAPP', vOk)
  const vReuse = await O.otpVerify(store, { linkId: L, revisionId: R, code: '135790', now: now + 3000 })
  t('a verified code cannot be verified twice', !vReuse.ok, vReuse)
  const g = await O.otpSignGate({ on: true, store, linkId: L, revisionId: R, channelAvailable: true, now: now + 4000 })
  t('sign gate ON + verified → ok with otp_channel + otp_verified_at', !!g && g.ok && (g as any).attribution.otp_channel === 'WHATSAPP' && (g as any).attribution.otp_verified_at === (vOk as any).verified_at, g)
  await O.otpConsume(store, L, now + 5000)
  const g2 = await O.otpSignGate({ on: true, store, linkId: L, revisionId: R, channelAvailable: true, now: now + 6000 })
  t('the pass is used once', !!g2 && !g2.ok && (g2 as any).error === 'err_otp_required', g2)
  const gNoCh = await O.otpSignGate({ on: true, store, linkId: 'no-row', revisionId: R, channelAvailable: false })
  t('ON but no phone/e-mail → signature proceeds, attribution says so', !!gNoCh && gNoCh.ok && (gNoCh as any).attribution.otp_channel === null, gNoCh)
  // expiry
  mem.clear(); now += 60 * 60 * 1000
  await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'EMAIL', now, code: '111111' })
  const vExp = await O.otpVerify(store, { linkId: L, revisionId: R, code: '111111', now: now + 10 * 60 * 1000 + 1 })
  t('after 10 minutes → err_otp_expired', !vExp.ok && (vExp as any).error === 'err_otp_expired', vExp)
  mem.clear()
  await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'EMAIL', now, code: '222222' })
  await O.otpVerify(store, { linkId: L, revisionId: R, code: '222222', now: now + 1000 })
  const gLate = await O.otpSignGate({ on: true, store, linkId: L, revisionId: R, channelAvailable: true, now: now + 1000 + 15 * 60 * 1000 + 1 })
  t('a verified pass dies after 15 minutes', !!gLate && !gLate.ok, gLate)
  // a parallel guess with a stale `tries` cannot be written (optimistic write)
  mem.clear()
  await O.otpIssue(store, { linkId: L, revisionId: R, channel: 'EMAIL', now, code: '333333' })
  t('stale write refused', !(await store.put({ ...mem.get(L), tries: 1 }, 7)))
  t('constant-time compare: equal / different / wrong length', O.otpEqual(O.otpHash(L, '1'), O.otpHash(L, '1')) && !O.otpEqual(O.otpHash(L, '1'), O.otpHash(L, '2')) && !O.otpEqual('ab', O.otpHash(L, '1')))
  t('6-digit codes', /^\d{6}$/.test(O.newCode()))
  // channel choice
  t('channel: sent by e-mail → e-mail', O.otpChannelFor('EMAIL', '14075550142@c.us', 'a@b.co')?.channel === 'EMAIL')
  t('channel: sent by WhatsApp → WhatsApp', O.otpChannelFor('WHATSAPP', '14075550142@c.us', 'a@b.co')?.channel === 'WHATSAPP')
  t('channel: sent by copy/Facebook → WhatsApp when a phone exists', O.otpChannelFor('FACEBOOK', '14075550142@c.us', 'a@b.co')?.channel === 'WHATSAPP')
  t('channel: no phone → e-mail', O.otpChannelFor('WHATSAPP', null, 'a@b.co')?.channel === 'EMAIL')
  t('channel: nothing → null', O.otpChannelFor('WHATSAPP', null, '') === null)

  // ── 5. OTP OFF → the sign path is unchanged ──────────────────────────────────────────────────────────────────────────────
  storeCalls = 0
  const off = await O.otpSignGate({ on: false, store, linkId: L, revisionId: R, channelAvailable: true })
  t('OFF → otpSignGate returns null and never touches the store', off === null && storeCalls === 0, { off, storeCalls })
  const extraOff = { gate_tier: null, gate_ok: true, ...((off as any)?.ok ? (off as any).attribution : {}) }
  t('OFF → the attribution extras are exactly the pre-OTP ones', JSON.stringify(extraOff) === JSON.stringify({ gate_tier: null, gate_ok: true }))
  // the route source: the sign case minus the guarded OTP lines must equal the committed (pre-OTP) sign case
  const repo = path.resolve(__dirname, '..')
  const rel = 'app/api/q/[action]/route.ts'
  const signBlock = (src: string) => src.slice(src.indexOf("    case 'sign': {"), src.indexOf("    case 'checkout': {"))
  let head = ''
  try { head = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repo, encoding: 'utf8' }) } catch { /* not a git checkout */ }
  const nowSrc = (await import('node:fs')).readFileSync(path.join(repo, rel), 'utf8')
  if (head && !head.includes('otpSignGate')) {
    const stripped = signBlock(nowSrc).split('\n').filter(l => !/otpOn|otpSignGate|otp && !otp\.ok|otpConsume/.test(l)).join('\n').replace(', ...(otp?.ok ? otp.attribution : {})', '')
    t('route: sign case with the OTP lines removed == the committed sign case', stripped === signBlock(head))
  } else console.log('· route source check skipped (HEAD already has the OTP code, or no git)')
  t('route: OTP actions answer 404 unknown when OFF', /if \(!\(await settingOn\(OTP_SETTING\)\)\) return err\('unknown', 404\)/.test(nowSrc))
  t('route: DTO unchanged when OFF', /if \(!\(await settingOn\(OTP_SETTING\)\)\) return base/.test(nowSrc))

  // ── the real transport was never reached ─────────────────────────────────────────────────────────────────────────────
  t('ZERO network calls (fetch trap)', fetchCalls === 0, fetchCalls)
  t('every send went through the fake', calls.every(c => c.ch === 'wa' || c.ch === 'email'))
  TR.setTransportForTests(null); N.setNotifyDepsForTests(null)
  t('production default is the real transport (not called here)', TR.transport().name === 'real')
  console.log(`${ok}/${ok + bad}`)
  process.exit(bad ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
