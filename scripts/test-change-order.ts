// @ts-nocheck — test harness (run with jiti); the union narrowing of buildChangeOrder is asserted at runtime
// Harness ponta a ponta do CHANGE ORDER (QUOTE PORTAL M4, 06/11/2026) num documento de TESTE (quote_links.is_test), sem rota, sem cron,
// sem Stripe, sem envio. Fluxo: approve (SHOP_PHONE) → depósito ZELLE (attempt_open + book_payment = HIRED) → CO 1 dentro da faixa do
// §559.909 (reprice +5, gravado pela loja) → change_order_apply → CO 2 acima da faixa (remove uma linha + linha nova) → recusa de staff,
// aprovação CLIENT_ESIGN via quote_approve com o link → apply. Confere linhas, plano, revisões, eventos, lib/money, trava e idempotência.
// No fim: fixture_delete (trilha em data_fixes).   npx jiti scripts/test-change-order.ts <invoiceId-de-teste-recém-criado>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')

async function main() {
  const { serviceDb, loadDocState } = await import('../lib/quoteDoc.server')
  const { buildChangeOrder, coBand } = await import('../lib/changeOrder.server')
  const { primeApproved, approvedFor } = await import('../lib/money')
  const id = process.argv[2]
  const db = serviceDb()
  let fail = 0
  const ok = (c: unknown, m: string, x?: unknown) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 200) : '')); if (!c) fail++ }
  const st = async () => (await loadDocState(db, id))!
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  try {
    let s = await st()
    if (!s.isTest) throw new Error('not a TEST document — refusing')
    // 1. approve (shop-recorded) + deposit by Zelle → HIRED
    const ap = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: s.live!.id, p_sha256: s.live!.sha256, p_terms_sha256: s.live!.terms_sha256,
      p_signer_name: 'GZ28 TEST signer', p_signer_contact: null, p_consents: { recorded: true }, p_attribution: {}, p_method: 'SHOP_PHONE', p_recorded_by: 'harness@test',
      p_ip: null, p_user_agent: null, p_note: 'harness', p_evidence_url: null, p_signature_path: null })
    ok(!ap.error, 'quote approved (SHOP_PHONE)', ap.error?.message)
    s = await st()
    const dep = (s.live!.document.installments || [])[0]
    const att = await db.rpc('attempt_open', { p_invoice: id, p_link: null, p_seq: 1, p_rail: 'ZELLE', p_provider: 'ZELLE', p_livemode: false, p_actor: 'harness@test', p_amount_cents: dep.amount_cents })
    ok(!att.error, 'attempt_open ZELLE', att.error?.message)
    const bp = await db.rpc('book_payment', { p_attempt: (att.data as any).id, p_money: { amount_cents: dep.amount_cents, currency: 'usd', source: 'ZELLE', paid_on: today, paid_to: 'GZ28US', livemode: false }, p_actor: 'harness@test' })
    ok(!bp.error && (bp.data as any)?.hired, 'book_payment → HIRED', bp.error?.message || bp.data)
    s = await st()
    ok(!s.bundle.invoice.is_quote && s.stage.paidBySeq[1], 'invoice hired, deposit paid')
    const { data: tc } = await db.from('clients').select('client_number').eq('id', s.bundle.invoice.client_id).single()
    const { data: realMax } = await db.from('clients').select('client_number').eq('is_quote', false).eq('origin', 'PROJECT').not('name', 'ilike', 'GZ28 TEST%').order('client_number', { ascending: false }).limit(1).single()
    ok(tc?.client_number === 9999 && realMax!.client_number < 9000, 'the test client keeps #9999 — no real project number taken', { test: tc?.client_number, realMax: realMax?.client_number })
    // a quote-time CO is refused; nothing changes → refused
    const none = buildChangeOrder(s, {})
    ok(!('document' in none) || none.problems.some(p => /nothing changes/.test(p)), 'empty change order refused')
    // 2. CO 1: reprice one item +5 (inside the band)
    const item = s.bundle.items.find(i => i.counts && Number(i.unit_price) > 0)!
    const before = Number(s.live!.grand_total)
    const co1 = buildChangeOrder(s, { items: [{ id: item.id, unit_price: Number(item.unit_price) + 5 }] }, { validUntil: today })
    ok('document' in co1 && !co1.problems.length, 'CO 1 builds', 'document' in co1 ? co1.problems : co1)
    if (!('document' in co1)) throw new Error('stop')
    ok(Math.abs(co1.delta.diff - 5 * Number(item.quantity || 1)) < 0.01 && co1.delta.changed.length === 1 && co1.band.staffMayRecord, 'delta +5 per unit, 1 changed, inside the band', co1.delta.diff)
    const cents = (co1.document.installments as any[]).map(i => i.amount_cents)
    ok(cents.reduce((a, b) => a + b, 0) === Math.round(co1.grand * 100) && cents[0] === dep.amount_cents, 'plan Σ = grand; the paid deposit keeps its cents; the last row absorbs', cents)
    const send1 = await db.rpc('change_order_send', { p_invoice: id, p_actor: 'harness@test', p_document: co1.document, p_sha256: co1.sha256, p_presented_sha256: co1.presented_sha256,
      p_terms_sha256: co1.terms_sha256, p_grand: co1.grand, p_fl_tax: co1.fl_tax, p_fl_status: co1.fl_status, p_delta: co1.delta, p_valid_days: 15 })
    ok(!send1.error, 'change_order_send', send1.error?.message)
    s = await st()
    ok(s.live?.kind === 'CHANGE_ORDER' && s.stage.sub === 'CHANGE_ORDER_PENDING', 'stage INVOICE · CHANGE_ORDER_PENDING', s.stage)
    await primeApproved(db as any, true)
    ok(approvedFor(id)?.grand === before, 'money readers still read the signed total while the CO waits', approvedFor(id))
    const lock = await db.from('invoice_items').update({ unit_price: Number(item.unit_price) + 99 }).eq('id', item.id)
    ok(!!lock.error && /locked by sent revision/.test(lock.error.message), 'the line stays locked by the DB while the CO waits')
    const pay = await db.rpc('change_order_apply', { p_revision: s.live!.id, p_actor: 'harness@test' })
    ok(!!pay.error && /not approved/.test(pay.error.message), 'apply before approval refused')
    // staff records it (inside the band) → apply
    const ap1 = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: s.live!.id, p_sha256: s.live!.sha256, p_terms_sha256: s.live!.terms_sha256,
      p_signer_name: 'GZ28 TEST signer', p_signer_contact: null, p_consents: { recorded: true }, p_attribution: {}, p_method: 'SHOP_PHONE', p_recorded_by: 'harness@test',
      p_ip: null, p_user_agent: null, p_note: 'phone ok +5', p_evidence_url: null, p_signature_path: null })
    ok(!ap1.error, 'CO 1 approved (SHOP_PHONE)', ap1.error?.message)
    const a1 = await db.rpc('change_order_apply', { p_revision: s.live!.id, p_actor: 'harness@test' })
    ok(!a1.error && (a1.data as any).applied && (a1.data as any).items === 1, 'CO 1 applied: 1 item rewritten', a1.error?.message || a1.data)
    const a1b = await db.rpc('change_order_apply', { p_revision: s.live!.id, p_actor: 'harness@test' })
    ok((a1b.data as any)?.applied === false, 'apply twice → already applied (idempotent)')
    s = await st()
    const row = s.bundle.items.find(i => i.id === item.id)!
    ok(Number(row.unit_price) === Number(item.unit_price) + 5, 'live row carries the new price')
    ok(Math.abs(s.bundle.money.grand - co1.grand) < 0.005 && s.planDrift === 0, 'live grand = CO grand, no plan drift', { grand: s.bundle.money.grand, drift: s.planDrift })
    ok(s.revisions.filter(r => r.kind !== 'LEGACY_BACKUP' && !r.superseded_at).length === 1 && s.live?.kind === 'CHANGE_ORDER' && s.approvalOnLive, 'only the CO is live, and approved')
    await primeApproved(db as any, true)
    ok(approvedFor(id)?.grand === co1.grand, 'money readers now read the CO total', approvedFor(id)?.grand)
    ok(s.events.some(e => e.kind === 'CHANGE_ORDER_APPLIED' && e.payload?.test), 'event CHANGE_ORDER_APPLIED (test:true)')
    const { data: plan } = await db.from('invoice_installments').select('seq, amount, pct').eq('invoice_id', id).order('seq')
    ok(plan!.every(p => p.pct == null) && Math.round(plan!.reduce((a, p) => a + Number(p.amount) * 100, 0)) === Math.round(co1.grand * 100), 'plan rows fixed amounts = CO grand', plan)
    // 3. CO 2 above the band: remove an item, add a new line (inserted after the signature)
    const ins = await db.from('invoice_items').insert({ invoice_id: id, description: 'HARNESS extra part', unit_price: 900, quantity: 1, position: 999 }).select('id').single()
    ok(!ins.error, 'a line inserted after the signature (C-38)', ins.error?.message)
    s = await st()
    const victim = s.bundle.items.find(i => i.counts && i.id !== item.id && i.id !== ins.data!.id && Number(i.unit_price) > 0) || s.bundle.items.find(i => i.counts && i.id !== ins.data!.id && i.id !== item.id)!
    const co2 = buildChangeOrder(s, { items: [{ id: victim.id, remove: true }] }, { validUntil: today })
    if (!('document' in co2)) throw new Error('co2 ' + co2.problems.join(';'))
    ok(co2.delta.added.some(l => l.id === ins.data!.id) && co2.delta.removed.some(l => l.id === victim.id), 'CO 2 delta: the inserted line added, the victim removed', { a: co2.delta.added.length, r: co2.delta.removed.length })
    const band2 = coBand(co2.delta.grand_before, co2.delta.grand_after)
    console.log('     band', band2)
    const send2 = await db.rpc('change_order_send', { p_invoice: id, p_actor: 'harness@test', p_document: co2.document, p_sha256: co2.sha256, p_presented_sha256: co2.presented_sha256,
      p_terms_sha256: co2.terms_sha256, p_grand: co2.grand, p_fl_tax: co2.fl_tax, p_fl_status: co2.fl_status, p_delta: co2.delta, p_valid_days: 7 })
    ok(!send2.error, 'CO 2 sent', send2.error?.message)
    s = await st()
    const { data: link } = await db.from('quote_links').select('id').eq('invoice_id', id).is('revoked_at', null).single()
    const ap2 = await db.rpc('quote_approve', { p_invoice: id, p_link: link!.id, p_revision: s.live!.id, p_sha256: s.live!.sha256, p_terms_sha256: s.live!.terms_sha256,
      p_signer_name: 'GZ28 TEST client', p_signer_contact: null, p_consents: { erecords: true, terms: true, estimate: 'REQUEST', parts_return: 'NONE' }, p_attribution: { harness: true },
      p_method: 'CLIENT_ESIGN', p_recorded_by: null, p_ip: null, p_user_agent: 'harness', p_note: null, p_evidence_url: null, p_signature_path: null })
    ok(!ap2.error, 'CO 2 e-signed by the client (CLIENT_ESIGN on the link)', ap2.error?.message)
    const a2 = await db.rpc('change_order_apply', { p_revision: s.live!.id, p_actor: 'client' })
    ok(!a2.error && (a2.data as any).removed_lines === 1, 'CO 2 applied: 1 line removed', a2.error?.message || a2.data)
    s = await st()
    ok(!s.bundle.items.some(i => i.id === victim.id) && s.bundle.items.some(i => i.id === ins.data!.id), 'victim gone from the live rows, inserted line kept')
    const { data: trail } = await db.from('data_fixes').select('id').eq('check_key', 'change-order').eq('row_id', victim.id)
    ok((trail || []).length === 1, 'the removed row is kept whole in data_fixes')
    ok(Math.abs(s.bundle.money.grand - co2.grand) < 0.005 && s.planDrift === 0 && s.stage.sub === 'DEPOSIT_RECEIVED', 'grand = CO 2, no drift, stage back to DEPOSIT_RECEIVED', s.stage)
  } finally {
    const { data: own } = await db.from('invoices').select('client_id').eq('id', id).maybeSingle()
    const r = await db.rpc('fixture_delete', { p_invoice: id, p_label: 'change-order-harness' })
    // the hire promotes the shared fixture client to is_quote=false; put it back (it keeps #9999 since patch2)
    if (own?.client_id) await db.from('clients').update({ is_quote: true }).eq('id', own.client_id).like('name', 'GZ28 TEST%')
    console.log(r.error ? 'cleanup ✖ ' + r.error.message : 'cleanup ✓ ' + JSON.stringify(r.data))
  }
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
