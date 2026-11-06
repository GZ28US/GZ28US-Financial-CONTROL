// QUOTE PORTAL M6 — pure harness for lib/tenant.ts reference currency (no DB, no network). npx jiti scripts/test-tenant-fx.ts
import { TENANTS, freezeFx, alongside, fxNote, depositText } from '../lib/tenant'
let ok = 0, bad = 0
const t = (name: string, cond: boolean, got?: unknown) => { if (cond) ok++; else { bad++; console.log('✖', name, got) } }
const BR = TENANTS.BR, US = TENANTS.US
const rows = [
  { day: '2026-11-05', bid: 5.30 },
  { day: '2026-11-06', bid: 5.35 },
  { day: '2026-11-07', bid: null },        // Saturday, empty bid
  { day: '2026-11-08', bid: 0 },           // Sunday, zero
  { day: '2026-11-09', bid: 5.40 },        // future relative to onDay below
]
const sat = freezeFx(BR, rows, '2026-11-07')
t('Saturday falls back to Friday', sat?.day === '2026-11-06', sat)
t('rate = spot + 0,20', sat?.rate === 5.55, sat)
t('never a future bid', freezeFx(BR, rows, '2026-11-08')?.day === '2026-11-06')
t('no good row → null', freezeFx(BR, [{ day: '2026-11-07', bid: null }], '2026-11-07') === null)
t('broken feed (0,20 rate) → null', freezeFx(BR, [{ day: '2026-11-06', bid: 0.0001 }], '2026-11-06') === null)
t('US has no reference', freezeFx(US, rows, '2026-11-06') === null)
const s = alongside(BR, 1110, sat).replace(/ /g, ' ')
t('alongside R$ then US$', s === 'R$ 1.110,00 · US$ 200,00', s)
t('alongside without fx = R$ only', alongside(BR, 1110, null).replace(/ /g, ' ') === 'R$ 1.110,00')
t('US alongside = US$ only', !alongside(US, 10, sat).includes('·'))
t('note pt', fxNote(sat, 'pt') === 'US$ apenas referência, câmbio de 06/11', fxNote(sat, 'pt'))
t('note en', fxNote(sat, 'en') === 'US$ for reference, rate of 06/11')
t('no fx → no note', fxNote(null, 'pt') === '')
t('deposit BR has PIX', depositText(BR).endsWith('PIX 58377183000149'))
t('deposit US empty', depositText(US) === '')
t('company = deposit holder', TENANTS.BR.company.name === TENANTS.BR.deposit!.holder && TENANTS.BR.deposit!.taxId === 'CNPJ ' + TENANTS.BR.company.taxId)
t('BR address from the paper', TENANTS.BR.company.address.startsWith('Av Arq Carlos Bratke 954'))
console.log(`${ok}/${ok + bad}`); process.exit(bad ? 1 : 0)
