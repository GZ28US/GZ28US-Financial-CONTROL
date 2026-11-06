#!/usr/bin/env node
// A-02 (quote portal, 06/11/2026): the SQL allocator alloc_ride_code(p) must give EXACTLY what lib/rideCodes.ts nextFreeCode gives
// over the same live codes, for every prefix. Read-only: one SELECT in a read-only transaction (Management API, token from memory).
//   node scripts/test-alloc-ride-code.mjs
import fs from 'node:fs'
import { nextFreeCode } from '../lib/rideCodes.ts'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
const tok = fs.readFileSync(MEM + 'supabase-mgmt-token.txt', 'utf8').trim()
const PREFIXES = ['US', 'SC', 'WV', 'PO', 'US.QT', 'SHP']
const query = `set transaction read only; select (select coalesce(json_agg(project_code), '[]') from rides where project_code is not null) codes, `
  + PREFIXES.map((p, i) => `alloc_ride_code('${p}') a${i}`).join(', ')
const r = await fetch('https://api.supabase.com/v1/projects/fvgpkbpqacnqxtrjsmpi/database/query', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ query }) })
if (r.status >= 300) { console.error(r.status, await r.text()); process.exit(1) }
const [row] = await r.json()
let bad = 0
PREFIXES.forEach((p, i) => {
  const js = nextFreeCode(row.codes, p), sql = row['a' + i]
  console.log(`${js === sql ? '✓' : '✖'} ${p.padEnd(6)} lib=${js}  sql=${sql}`)
  if (js !== sql) bad++
})
console.log(bad ? `✖ A-02 FAILED (${bad})` : '✓ A-02 parity')
process.exit(bad ? 1 : 0)
