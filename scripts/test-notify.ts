// Harness local do switchboard (QUOTE PORTAL M4, 06/11/2026): com as chaves OFF, notify() só grava NOTIFY_SKIPPED — nada sai.
// Roda só num documento de TESTE.   npx jiti scripts/test-notify.ts <invoiceId-de-teste>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')
async function main() {
  const { serviceDb, loadDocState } = await import('../lib/quoteDoc.server')
  const { notify, NOTIFY_KEYS } = await import('../lib/notify.server')
  const { settingOn } = await import('../lib/appSettings.server')
  const id = process.argv[2], db = serviceDb()
  let fail = 0
  const ok = (c: unknown, m: string, x?: unknown) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (x !== undefined ? ' — ' + JSON.stringify(x) : '')); if (!c) fail++ }
  const s = await loadDocState(db, id)
  if (!s?.isTest) throw new Error('not a TEST document — refusing')
  const on = []; for (const k of NOTIFY_KEYS) if (await settingOn(k.key)) on.push(k.key)
  ok(on.length === 0, 'every registry key is OFF', on)
  if (on.length) throw new Error('a key is ON — refusing to call notify()')
  const { data: wm } = await db.from('invoice_events').select('id').order('id', { ascending: false }).limit(1).single()
  const r1 = await notify(db, 'notify.client.signed_copy', { invoiceId: id })
  ok(!r1.sent && r1.reason === 'off', 'client key OFF → not sent', r1)
  const r2 = await notify(db, 'notify.reports.quote_signed', { invoiceId: id })
  ok(!r2.sent && r2.reason === 'off', 'reports key OFF → not sent', r2)
  const r3 = await notify(db, 'notify.bogus', { invoiceId: id })
  ok(!r3.sent && r3.reason === 'unknown key', 'unknown key → not sent', r3)
  const { data: ev } = await db.from('invoice_events').select('kind, payload').eq('invoice_id', id).gt('id', wm!.id)
  ok((ev || []).filter(e => e.kind === 'NOTIFY_SKIPPED').length === 3 && !(ev || []).some(e => e.kind === 'NOTIFIED'), '3 NOTIFY_SKIPPED events, 0 NOTIFIED', ev?.map(e => e.payload?.reason))
  ok((ev || []).length > 0 && (ev || []).every(e => e.payload?.test === true), 'events carry test:true')
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
