// R10 remap: values stored per index; the rpm axis labels were changed from OLD to NEW. Recompute values so each NEW breakpoint
// gets the value the table had at that rpm under the OLD axis (linear interp; beyond the old end = last value × hold).
// usage: node remap.mjs <copy_with_axis.txt> <cols|rows> <old csv> <new csv> [hold=1.0]   → stdout values-only TSV
import { readFileSync } from 'node:fs'
const [file, orient, oldS, newS, holdS] = process.argv.slice(2)
const OLD = oldS.split(',').map(Number), NEW = newS.split(',').map(Number), HOLD = holdS ? Number(holdS) : 1
const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim())
const hdr = lines[0].split('\t').slice(1).map(Number).filter(Number.isFinite)
const body = lines.slice(1).map(l => l.split('\t')).filter(r => r.length > 1 && Number.isFinite(Number(r[0])))
const vals = body.map(r => r.slice(1, 1 + hdr.length).map(Number))
const n = OLD.length
const interp = (arr, r) => { if (r > OLD.at(-1)) return arr.at(-1) * HOLD; if (r <= OLD[0]) return arr[0]; let i = 0; while (OLD[i + 1] < r) i++; const f = (r - OLD[i]) / (OLD[i + 1] - OLD[i]); return arr[i] + (arr[i + 1] - arr[i]) * f }
let out
if (orient === 'cols') { if (hdr.length !== n) throw new Error(`cols ${hdr.length} != axis ${n}`); out = vals.map(row => NEW.map(r => interp(row, r))) }
else { if (vals.length !== n) throw new Error(`rows ${vals.length} != axis ${n}`); const C = vals[0].length; const cols = [...Array(C).keys()].map(c => vals.map(r => r[c])); const nc = cols.map(col => NEW.map(r => interp(col, r))); out = NEW.map((_, i) => nc.map(col => col[i])) }
const fmt = v => String(+v.toFixed(4))
console.log(out.map(r => r.map(fmt).join('\t')).join('\n'))
console.log(`#INFO ${file.split(/[\\/]/).pop()}: header ${hdr.slice(-6).join(',')} | ${vals.length}x${vals[0].length} | remapped ${orient}`)
