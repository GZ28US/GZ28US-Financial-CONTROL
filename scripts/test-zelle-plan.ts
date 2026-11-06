// @ts-nocheck — test harness (jiti). Harness do Zelle × PARCELA DO PLANO (QUOTE PORTAL §9 #3, 06/11/2026). Só targetInvoice() e o
// income_settle — sem Graph, sem Regions, sem WhatsApp (o robô nunca roda aqui). Num documento de TESTE recém-criado:
// approve (SHOP_PHONE) → depósito ZELLE (book_payment = HIRED) → a parcela 2 fica em aberto → targetInvoice(valor exato) devolve
// {settle} → income_settle dá a baixa na própria linha; valor que não bate → {recusado} (nunca palpite). No fim: fixture_delete.
//   JITI_ALIAS='{"@":"<absolute path of this repo>"}' npx jiti scripts/test-zelle-plan.ts <invoiceId-de-teste-recém-criado>
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')

async function main() {
  const { serviceDb, loadDocState } = await import('../lib/quoteDoc.server')
  const { targetInvoice } = await import('../lib/zelleWatch.server')
  const id = process.argv[2], db = serviceDb()
  let fail = 0
  const ok = (c, m, x) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 220) : '')); if (!c) fail++ }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  let clientId = null
  try {
    let s = await loadDocState(db, id)
    if (!s?.isTest) throw new Error('not a TEST document — refusing')
    clientId = s.bundle.invoice.client_id
    const ap = await db.rpc('quote_approve', { p_invoice: id, p_link: null, p_revision: s.live.id, p_sha256: s.live.sha256, p_terms_sha256: s.live.terms_sha256,
      p_signer_name: 'GZ28 TEST signer', p_signer_contact: null, p_consents: { recorded: true }, p_attribution: {}, p_method: 'SHOP_PHONE', p_recorded_by: 'harness@test',
      p_ip: null, p_user_agent: null, p_note: 'harness', p_evidence_url: null, p_signature_path: null })
    ok(!ap.error, 'approved', ap.error?.message)
    s = await loadDocState(db, id)
    const dep = s.live.document.installments[0]
    const att = await db.rpc('attempt_open', { p_invoice: id, p_link: null, p_seq: 1, p_rail: 'ZELLE', p_provider: 'ZELLE', p_livemode: false, p_actor: 'harness@test', p_amount_cents: dep.amount_cents })
    const bp = await db.rpc('book_payment', { p_attempt: att.data.id, p_money: { amount_cents: dep.amount_cents, currency: 'usd', source: 'ZELLE', paid_on: today, paid_to: 'GZ28US', livemode: false }, p_actor: 'harness@test' })
    ok(!bp.error && bp.data?.hired, 'hired', bp.error?.message || bp.data)
    const { data: open } = await db.from('invoice_incomes').select('id, amount, paid_at, installment_id').eq('invoice_id', id).is('paid_at', null)
    ok(open?.length === 1 && open[0].installment_id, 'one plan row open (seq 2)', open)
    const party = s.bundle.client.name
    // 1. a Zelle of a different amount → never a guess
    const miss = await targetInvoice(db, party, Number(open[0].amount) - 100)
    ok(miss && 'recusado' in miss && /parcela do plano/.test(miss.recusado), 'amount off → recusado (no PALPITE)', miss)
    // 2. the exact amount → settle on the plan row
    const hit = await targetInvoice(db, party, Number(open[0].amount))
    ok(hit && hit.settle?.id === open[0].id && hit.via === 'VALOR EXATO' && !hit.quita, 'exact → {settle: the plan row}', hit)
    const st = await db.rpc('income_settle', { p_income: hit.settle.id, p_attempt: null, p_muted: true, p_money: { paid_on: today, amount_cents: Math.round(Number(open[0].amount) * 100), source: 'ZELLE', paid_to: 'GZ28US', payment_reference: 'zelle:HARNESS123' } })
    ok(!st.error, 'income_settle on the plan row', st.error?.message)
    const { data: row } = await db.from('invoice_incomes').select('paid_at, source, payment_reference, reported_at, installment_id').eq('id', open[0].id).single()
    ok(row.paid_at && row.source === 'ZELLE' && row.payment_reference === 'zelle:HARNESS123' && row.reported_at && row.installment_id, 'the SAME row is paid, ZELLE, reported, still plan-linked', row)
    const { count } = await db.from('invoice_incomes').select('id', { count: 'exact', head: true }).eq('invoice_id', id)
    ok(count === 2, 'no extra income row (2 = the two plan rows)', count)
    s = await loadDocState(db, id)
    ok(s.stage.paidBySeq[1] && s.stage.paidBySeq[2], 'both installments PAID by Σ', s.stage.paidBySeq)
    const again = await targetInvoice(db, party, Number(open[0].amount))
    ok(!again || !again.settle, 'paid row is not offered again', again)
  } finally {
    const r = await db.rpc('fixture_delete', { p_invoice: id, p_label: 'zelle-plan-harness' })
    console.log(r.error ? 'cleanup ✖ ' + r.error.message : 'cleanup ✓ ' + JSON.stringify(r.data))
    if (clientId) await db.from('clients').update({ is_quote: true }).eq('id', clientId).like('name', 'GZ28 TEST%')
  }
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
