// Lean the closed-loop Control Goal FAR in cruise: rows 0.15–0.60 for rpm cols >=1472 (×0.93, 2400 col ×0.95);
// col 1312 only rows 0.35–0.55 (×0.93) so idle is untouched. Input: Copy-with-Axis text file. Output: values-only TSV.
import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(l => l.trim())
const cols = lines[0].split('\t').slice(1).map(Number).filter(Number.isFinite)
const rows = lines.slice(1).map(l => l.split('\t').map(Number)).filter(r => r.length > cols.length)
const out = rows.map(r => { const ratio = r[0]; return r.slice(1, 1 + cols.length).map((v, c) => { const rpm = cols[c]; let f = 1
  if (rpm >= 1472 && ratio <= 0.605) f = rpm >= 2400 ? 0.95 : 0.93
  if (rpm < 1472 && ratio >= 0.345 && ratio <= 0.555) f = 0.93
  return +(v * f).toFixed(6) }) })
console.log(out.map(r => r.join('\t')).join('\n'))
