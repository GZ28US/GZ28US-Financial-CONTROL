// Harness local do motor das abas do /doc (QUOTE PORTAL M3, 06/11/2026) — roda lib/docTabs.server.ts direto, SÓ contra um documento
// de TESTE (quote_links.is_test), sem rota, sem envio. Cada linha criada é apagada no fim; a conta final tem de bater com a inicial.
//   npx jiti scripts/test-doc-tabs.ts <invoiceId-de-teste>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')

async function main() {
  const { serviceDb, loadDocState } = await import('../lib/quoteDoc.server')
  const { tabAction, tabsExtras, closeChecklist } = await import('../lib/docTabs.server')
  const id = process.argv[2]
  const db = serviceDb()
  let fail = 0
  const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++ }
  const st = async () => (await loadDocState(db, id))!
  let s = await st()
  if (!s?.isTest) throw new Error('not a TEST document — refusing')
  const before = await tabsExtras(db, s)
  const run = async (a: string, b: any) => { s = await st(); return (await tabAction(db, s, a, b, 'harness@test'))! }

  // ITEMS
  let r = await run('item-add', { description: 'HARNESS test line', quantity: 2, unit_price: 10 })
  ok(r.status === 200, 'item-add')
  s = await st(); let x = await tabsExtras(db, s)
  const mine = x.items.find((i: any) => i.description === 'HARNESS test line')!
  ok(!!mine && !mine.locked && mine.total === 20, 'new line is unlocked, total 20')
  r = await run('item-save', { item_id: mine.id, unit_price: 12.5 }); ok(r.status === 200, 'item-save unlocked line')
  const lockedItem = x.items.find((i: any) => i.locked)
  if (lockedItem) { r = await run('item-save', { item_id: lockedItem.id, unit_price: Number(lockedItem.unit_price) + 1 }); ok(r.status === 409 && /locked by sent revision/.test(String(r.body.error)), 'locked line refused by the DB (409)') }
  else console.log('—    no locked line on this document (not sent?)')
  r = await run('item-save', { item_id: '00000000-0000-0000-0000-000000000000', unit_price: 1 }); ok(r.status === 404, 'foreign line id → 404')
  r = await run('item-add', { description: '' }); ok(r.status === 400, 'empty description refused')
  r = await run('item-del', { item_id: mine.id }); ok(r.status === 200, 'item-del')
  // SERVICES
  r = await run('service-add', { description: 'HARNESS svc', price: 99 }); ok(r.status === 200, 'service-add')
  s = await st(); x = await tabsExtras(db, s)
  const sv = x.services.find((v: any) => v.description === 'HARNESS svc')!
  r = await run('service-save', { service_id: sv.id, price: 100 }); ok(r.status === 200, 'service-save')
  r = await run('service-del', { service_id: sv.id }); ok(r.status === 200, 'service-del')
  // NOTES
  r = await run('note-add', { note: 'HARNESS note', client_visible: false }); ok(r.status === 200, 'note-add (internal)')
  s = await st(); x = await tabsExtras(db, s)
  const nt = x.notes.find((n: any) => n.note === 'HARNESS note')!
  ok(nt && nt.client_visible === false, 'note stored as internal')
  r = await run('note-save', { note_id: nt.id, client_visible: true }); ok(r.status === 200, 'note-save visibility')
  r = await run('note-del', { note_id: nt.id }); ok(r.status === 200, 'note-del')
  // DUTIES
  r = await run('duty-add', { description: 'HARNESS duty', priority: '2', estimated_minutes: 30 }); ok(r.status === 200, 'duty-add')
  s = await st(); x = await tabsExtras(db, s)
  const du = x.duties.find((d: any) => d.description === 'HARNESS duty')!
  ok(du && du.priority === '2' && du.estimated_seconds === 1800, 'duty P2, 30 min')
  r = await run('duty-toggle', { duty_id: du.id }); ok(r.status === 200, 'duty-toggle')
  const { data: dd } = await db.from('invoice_duties').select('done').eq('id', du.id).single(); ok(dd?.done === true, 'duty done')
  r = await run('duty-del', { duty_id: du.id }); ok(r.status === 200, 'duty-del')
  // STATUS on a quote
  r = await run('status', { to: 'CLOSED' }); ok(r.status === 409, 'status refused on a quote')
  // CLOSE checklist shape
  const c = closeChecklist(s); ok(Array.isArray(c.items) && c.items.length === 3, 'checklist has 3 items')
  // unknown action falls through
  ok((await tabAction(db, s, 'nope', {}, 'harness')) === null, 'unknown action → null (route 404)')
  // nothing left behind
  s = await st(); const after = await tabsExtras(db, s)
  ok(after.items.length === before.items.length && after.services.length === before.services.length && after.notes.length === before.notes.length && after.duties.length === before.duties.length, 'counts back to the start')
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
