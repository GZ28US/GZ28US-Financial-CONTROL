// Harness local do /doc/new (QUOTE PORTAL M3, 06/11/2026) — roda lib/docNew.server.ts createQuote() direto com um LEAD «GZ28 TEST»
// (nossa fixture; passa no portão sem qi_v2.actions), sem rota, sem envio. A origem do DUPLICATE só é LIDA. No fim apaga tudo o que
// criou (invoices de teste + o lead) e confere que nada sobrou.
//   npx jiti scripts/test-doc-new.ts <invoiceId-origem-com-despesa-paga-e-prevista>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')

async function main() {
  const { serviceDb } = await import('../lib/quoteDoc.server')
  const { createQuote, nextSuffix } = await import('../lib/docNew.server')
  const srcId = process.argv[2]
  const db = serviceDb()
  let fail = 0
  const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++ }
  const made: string[] = []
  let leadId: string | null = null
  try {
    ok(nextSuffix(['US.050.1', 'US.050.3', null]) === 2 && nextSuffix([]) === 1, 'nextSuffix fills the first hole')
    ok((await createQuote(db, {}, 'h')).status === 400, 'no client → 400')
    const real = await createQuote(db, { lead: { name: 'Real Person' }, start: 'blank' }, 'h')
    ok(real.status === 409 && real.body.key === 'qi_v2.actions', 'real lead refused while qi_v2.actions is OFF')
    // BLANK for a new TEST lead, no car
    const a = await createQuote(db, { lead: { name: 'GZ28 TEST harness lead', phone: '+1 555 0100', email: 'HARNESS@example.test', country: 'usa' }, ride_id: null, start: 'blank', service: 'Harness blank' }, 'harness@test')
    ok(a.status === 200, 'BLANK quote created for a test lead: ' + JSON.stringify(a.body).slice(0, 120))
    const aid = String(a.body.id); made.push(aid); leadId = String(a.body.client_id)
    const { data: cl } = await db.from('clients').select('is_quote, origin, email, country, client_number').eq('id', leadId).single()
    ok(cl?.is_quote === true && cl.origin === 'PROJECT' && cl.email === 'harness@example.test' && cl.country === 'USA', 'lead born a QUOTE client, e-mail lowercased, country upper')
    const { data: ai } = await db.from('invoices').select('invoice_code, is_quote, live_status, ride_id, service').eq('id', aid).single()
    const { data: mxReal } = await db.from('clients').select('client_number').eq('origin', 'PROJECT').eq('is_quote', true).not('name', 'ilike', 'GZ28 TEST%').order('client_number', { ascending: false }).limit(1).single()
    ok(Number(cl!.client_number) > Number(mxReal!.client_number), 'test lead numbered after the real ones')
    ok(ai?.is_quote === true && ai.live_status === 'INCOMPLETE' && !ai.ride_id && ai.invoice_code === `${String(cl!.client_number).padStart(3, '0')}.1`, `client-level code ${ai?.invoice_code}, INCOMPLETE quote`)
    const { data: as } = await db.from('invoice_services').select('description, price').eq('invoice_id', aid)
    ok(as?.length === 1 && as[0].description === 'Full Project Labor', 'blank starts with Full Project Labor')
    const { data: at } = await db.from('invoice_terms').select('invoice_id').eq('invoice_id', aid)
    const { data: ap } = await db.from('invoice_installments').select('seq').eq('invoice_id', aid)
    ok(!!at?.length && (ap?.length || 0) >= 1, `terms + plan seeded (${ap?.length} rows)`)
    // DUPLICATE from the real source onto the same test lead
    const b = await createQuote(db, { client_id: leadId, ride_id: null, start: 'duplicate', from_id: srcId }, 'harness@test')
    ok(b.status === 200, 'DUPLICATE created')
    const bid = String(b.body.id); made.push(bid)
    ok(String(b.body.invoice_code).endsWith('.2'), 'second client-level quote is .2')
    const [si, sx, se, bi, bx, be] = await Promise.all([
      db.from('invoice_items').select('id, cancel_status').eq('invoice_id', srcId), db.from('invoice_incomes').select('id').eq('invoice_id', srcId),
      db.from('invoice_expenses').select('id, payment_date, cancel_status, purchase_group').eq('invoice_id', srcId),
      db.from('invoice_items').select('id').eq('invoice_id', bid), db.from('invoice_incomes').select('id').eq('invoice_id', bid),
      db.from('invoice_expenses').select('id, payment_date, expense_date, order_number, receipt_url, purchase_group').eq('invoice_id', bid),
    ])
    ok((bi.data || []).length === (si.data || []).filter((x: any) => !x.cancel_status).length, `items copied (${bi.data?.length}), refunded ones left out`)
    ok((bx.data || []).length === 0 && (sx.data || []).length >= 0, `no incomes copied (source has ${sx.data?.length})`)
    const fore = (se.data || []).filter((e: any) => !e.payment_date && !e.cancel_status)
    ok((be.data || []).length === fore.length, `only forecast expenses copied (${be.data?.length} of ${se.data?.length})`)
    ok((be.data || []).every((e: any) => !e.payment_date && !e.expense_date && !e.order_number && !e.receipt_url), 'copied expenses: dates, order number, receipt nulled')
    const srcGroups = new Set(fore.map((e: any) => e.purchase_group).filter(Boolean)), newGroups = new Set((be.data || []).map((e: any) => e.purchase_group).filter(Boolean))
    ok([...newGroups].every(g => !srcGroups.has(g)) && newGroups.size === srcGroups.size, `fresh purchase_group per source group (${newGroups.size})`)
    // a car that is not the client's
    const { data: other } = await db.from('rides').select('id').neq('client_id', leadId).limit(1).single()
    ok((await createQuote(db, { client_id: leadId, ride_id: other!.id, start: 'blank' }, 'h')).status === 409, "someone else's car refused")
    ok((await createQuote(db, { lead: { name: 'GZ28 TEST x' }, ride_id: other!.id, start: 'blank' }, 'h')).status === 409, 'new lead + car refused (409), nothing written')
    const { data: orphan } = await db.from('clients').select('id').eq('name', 'GZ28 TEST x')
    ok(!orphan?.length, 'refused lead left no client behind')
  } finally {
    // seed_terms writes events (append-only): the cleanup goes through fixture_delete (GZ28 TEST client, no link), trail in data_fixes
    for (const id of made) { const r = await db.rpc('fixture_delete', { p_invoice: id, p_label: 'doc-new-harness' }); if (r.error) console.log('cleanup', id, r.error.message) }
    if (leadId) await db.from('clients').delete().eq('id', leadId)
    const { data: left } = await db.from('clients').select('id').ilike('name', 'GZ28 TEST harness%')
    const { data: leftInv } = made.length ? await db.from('invoices').select('id').in('id', made) : { data: [] as any[] }
    ok(!left?.length && !leftInv?.length, 'cleanup: nothing left')
  }
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
