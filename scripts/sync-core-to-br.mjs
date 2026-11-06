// QUOTE PORTAL M6 (06/11/2026; blueprint §16 M6 «sync-core-to-br.mjs drift check»). The PURE core of the quote portal must be byte-identical
// in the US and the BR Control Apps. Default: CHECK only — prints, per file, SAME / DRIFT / MISSING IN BR and exits 1 on any drift.
// `--copy` (explicit) copies the US version over the BR one for the files listed (never anything else; never server code, never SQL).
//   node scripts/sync-core-to-br.mjs            # check
//   node scripts/sync-core-to-br.mjs --copy     # copy US → BR, then check again
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const US = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BR = 'C:/Users/gz28u/Dropbox/000 - GZ28BR/GZ28BR Tad/Control App'
// the core: pure modules (no DB, no network, no React), shared word for word
const CORE = ['lib/quoteStage.ts', 'lib/tenant.ts']
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f).toString('utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)

const copy = process.argv.includes('--copy')
let drift = 0
for (const rel of CORE) {
  const a = path.join(US, rel), b = path.join(BR, rel)
  if (!fs.existsSync(a)) { console.log(`?    ${rel} — missing in US (the source)`); drift++; continue }
  if (copy && (!fs.existsSync(b) || sha(a) !== sha(b))) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); console.log(`→    ${rel} copied US → BR`) }
  if (!fs.existsSync(b)) { console.log(`MISS ${rel} — not in BR`); drift++; continue }
  const sa = sha(a), sb = sha(b)
  if (sa === sb) console.log(`SAME ${rel} ${sa}`)
  else { console.log(`DRIFT ${rel} US ${sa} ≠ BR ${sb}`); drift++ }
}
console.log(drift ? `\n${drift} file(s) drift — the BR core is not the US core` : '\nthe core is the same in both apps')
process.exit(drift ? 1 : 0)
