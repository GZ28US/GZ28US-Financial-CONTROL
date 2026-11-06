// @ts-nocheck — Harness local do /adm/payments + sync de payouts (QUOTE PORTAL M5, 06/11/2026). Chave Stripe de TESTE (lida do disco, nunca
// impressa, recusa se não for sk_test_). Só LÊ a Stripe; grava só o espelho stripe_payouts (livemode=false nunca casa no Bank Link).
// Não chama REFUND nem REPLAY.   JITI_ALIAS='{"@":"<repo>"}' npx jiti scripts/test-payments-admin.ts
import fs from 'node:fs'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fvgpkbpqacnqxtrjsmpi.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').replace(/\s+/g, '')
const env = fs.readFileSync('C:/Users/gz28u/gz28shop-us/.env.local', 'utf8')
const sk = (env.match(/^STRIPE_SECRET_KEY=["']?([^"'\r\n]+)/m) || [])[1] || ''
if (!sk.startsWith('sk_test_')) throw new Error('no TEST key — refusing')
process.env.STRIPE_SECRET_KEY = sk
async function main() {
  const { serviceDb } = await import('../lib/quoteDoc.server')
  const { paymentsOverview } = await import('../lib/adminPayments.server')
  const { syncRecentPayouts } = await import('../lib/stripePayouts.server')
  const db = serviceDb()
  let fail = 0
  const ok = (c, m, x) => { console.log((c ? 'OK   ' : 'FAIL ') + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 240) : '')); if (!c) fail++ }
  const o = await paymentsOverview(db)
  ok(o.mode === 'test' && Array.isArray(o.attempts) && Array.isArray(o.payouts), 'overview reads (test key)', { attempts: o.attempts.length, payouts: o.payouts.length, events: o.events.length, unlinked: o.unlinked.length, stale: o.stale.length })
  const r = await syncRecentPayouts(db, 5)
  ok(Array.isArray(r) && r.every(x => !x.error), 'sync of the last 5 TEST payouts', r)
  const { data: rows } = await db.from('stripe_payouts').select('id, livemode, members, unresolved_amount').in('id', r.map(x => x.id))
  ok((rows || []).every(p => p.livemode === false), 'mirrored as livemode=false (never auto-matched)', rows?.map(p => [p.id, p.members.length, p.unresolved_amount]))
  console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
