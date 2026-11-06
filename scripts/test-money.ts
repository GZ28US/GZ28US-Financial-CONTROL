// Harness local (sem banco) de lib/money.ts docMoneyFor — QUOTE PORTAL M3 (06/11/2026).  npx jiti scripts/test-money.ts
import { docMoneyFor } from '../lib/money'
import { invoiceMoneyFor } from '../lib/flTax'
let fail = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++ }
const inv = { id: 'x', global_discount: 10, fl_tax_override: null }
const client = { country: 'USA', state: 'FL' } as never
const live = invoiceMoneyFor(inv, 'FL', client, [1000, 500], [2000])
const d0 = docMoneyFor(inv, 'FL', client, [1000, 500], [2000], null)
ok(d0.source === 'live' && JSON.stringify({ ...d0, source: undefined }) === JSON.stringify({ ...live, source: undefined }), 'no approval → identical to invoiceMoneyFor')
const ap = { invoice_id: 'x', revision_id: 'r', seq: 2, grand: 3500, fl_tax: 0, fl_tax_status: 'EXPORT', signed_at: '2026-11-06T12:00:00Z' }
const d1 = docMoneyFor(inv, 'FL', client, [1000, 500, 999], [2000], ap)
ok(d1.source === 'approved' && d1.grand === 3500 && d1.tax === 0 && d1.status === 'EXPORT' && d1.taxable === false, 'approval → grand/tax/status from the signed revision')
ok(!!d1.live && d1.live.grand !== d1.grand && d1.approvedSeq === 2, 'live numbers kept alongside (drift visible)')
const d2 = docMoneyFor({ id: 'nope' }, null, null, [100], [], undefined)
ok(d2.source === 'live', 'unprimed cache → live law')
console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
