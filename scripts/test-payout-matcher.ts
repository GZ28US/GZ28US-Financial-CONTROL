// Harness local (sem banco, sem rede) do motor PAYOUT do Bank Link — quote portal M2 (06/11/2026).
// npx jiti scripts/test-payout-matcher.ts
import { buildPlan, MIXED_GROUP, type Pool } from '../lib/bankReconcile.server'

let fail = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++ }
const inc = (id: string, amount: number) => ({ table: 'invoice_incomes', id, label: 'INCOME · ' + id, date: '2026-11-02', amount, undated: false })
const fee = (id: string, amount: number) => ({ table: 'invoice_expenses', id, label: 'EXPENSE · Stripe fee ' + id, date: '2026-11-02', amount, undated: false })
const pool = (payouts: Pool['payouts']): Pool => ({ out: [fee('f1', 30.30), fee('f2', 15.10)], inn: [inc('i1', 1000), inc('i2', 500)], sched: [], shadow: [], payouts })
const line = (id: string, amount: number, date: string, name = 'STRIPE TRANSFER ST-ABC') => ({ id, amount, date, name, merchant: /STRIPE/.test(name) ? 'Stripe' : '', pending: false })
const P1 = { payout_id: 'po_1', net: 969.70, date: '2026-11-02', members: [{ table: 'invoice_incomes', id: 'i1' }, { table: 'invoice_expenses', id: 'f1' }], label: 'STRIPE PAYOUT po_1', n: 1 }
const P2 = { payout_id: 'po_2', net: 484.90, date: '2026-11-03', members: [{ table: 'invoice_incomes', id: 'i2' }, { table: 'invoice_expenses', id: 'f2' }], label: 'STRIPE PAYOUT po_2', n: 1 }

{ // 1. exato → MISTO com os 2 membros
  const p = buildPlan([line('b1', -969.70, '2026-11-04')], pool([P1, P2]), [], { today: '2026-11-06' })
  const it = p.items.find(i => i.line.id === 'b1')
  ok(!!it && it.engine === 'PAYOUT', 'payout exato casa pelo motor PAYOUT')
  ok(!!it && it.cand?.table === MIXED_GROUP && it.cand.id === 'b1' && it.cand.members?.length === 2, 'candidato é MISTO com id = linha e 2 membros')
}
{ // 2. um centavo fora → não casa por PAYOUT
  const p = buildPlan([line('b2', -969.71, '2026-11-04')], pool([P1]), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT'), '1 centavo fora não casa')
}
{ // 3. antes da cobrança / depois de 10 d → não casa
  const a = buildPlan([line('b3', -969.70, '2026-11-01')], pool([P1]), [], { today: '2026-11-20' })
  const b = buildPlan([line('b4', -969.70, '2026-11-13')], pool([P1]), [], { today: '2026-11-20' })
  ok(!a.items.some(i => i.engine === 'PAYOUT') && !b.items.some(i => i.engine === 'PAYOUT'), 'fora da janela [dia, +10 d] não casa')
}
{ // 4. sem STRIPE no nome → não é PAYOUT
  const p = buildPlan([line('b5', -969.70, '2026-11-04', 'ZELLE FROM JOHN')], pool([P1]), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT'), 'linha sem STRIPE não usa o motor')
}
{ // 5. saída (débito) → nunca
  const p = buildPlan([line('b6', 969.70, '2026-11-04')], pool([P1]), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT'), 'débito nunca é payout')
}
{ // 6. dois payouts com a mesma soma → dúvida, nada casa
  const P1b = { ...P2, payout_id: 'po_3', net: 969.70 }
  const p = buildPlan([line('b7', -969.70, '2026-11-04')], pool([P1, P1b]), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT') && /ambíguo/.test(String(p.doubts['b7']?.reason || '')), 'ambíguo vira dúvida')
}
{ // 7. duas linhas, o mesmo payout → só a primeira leva
  const p = buildPlan([line('b8', -969.70, '2026-11-04'), line('b9', -969.70, '2026-11-05')], pool([P1]), [], { today: '2026-11-06' })
  ok(p.items.filter(i => i.engine === 'PAYOUT').length === 1, 'payout consumido não casa duas vezes')
}
{ // 8. NÃO do humano (doubt_answered) vale
  const l = { ...line('b10', -969.70, '2026-11-04'), doubt_answered: { cands: [MIXED_GROUP + ':po_1'] } }
  const p = buildPlan([l], pool([P1]), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT'), 'payout recusado pelo humano não volta')
}
{ // 9. sem payouts no pool → motor de sempre, nada muda
  const p = buildPlan([line('b11', -969.70, '2026-11-04')], pool(undefined), [], { today: '2026-11-06' })
  ok(!p.items.some(i => i.engine === 'PAYOUT'), 'pool sem payouts = motor de sempre')
}
console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
