// R11 VE = R9 VE × factor; per cell take the factor from the run (steady / accel) with the larger weight. Reads the .rep weights by recomputation.
import { readFileSync, writeFileSync } from 'node:fs'
const b = process.argv[2]
const base = readFileSync(`ve${b}_R9final.tsv`, 'utf8').trim().split(/\r?\n/).map(l => l.split('\t').map(Number))
const S = readFileSync(`ve${b}_s11.tsv`, 'utf8').trim().split(/\r?\n/).map(l => l.split('\t').map(Number))
const A = readFileSync(`ve${b}_a11.tsv`, 'utf8').trim().split(/\r?\n/).map(l => l.split('\t').map(Number))
// weights from the reports: parse "x.x[w]" cells per row
const wmap = f => { const L = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => /^\s+\d\.\d\d /.test(l)); return L.map(l => { const cells = []; for (let c = 0; c < 17; c++) { const seg = l.slice(7 + c * 11, 7 + (c + 1) * 11); const m = seg.match(/\[(\d+)\]/); cells.push(m ? +m[1] : 0) } return cells }) }
const WS = wmap(`ve${b}_s11.rep`), WA = wmap(`ve${b}_a11.rep`)
let n = 0; const log = []
const out = base.map((row, r) => row.map((v, c) => { const fs = S[r][c] / v, fa = A[r][c] / v; const ws = WS[r]?.[c] || 0, wa = WA[r]?.[c] || 0
  let f = 1; if (ws >= 20 || wa >= 15) f = wa > ws ? Math.min(fa, 1.06) : fs
  if (Math.abs(f - 1) > 1e-4) { n++; log.push(`r${r} c${c} ${(100 * (f - 1)).toFixed(1)}% (${wa > ws ? 'accel' : 'steady'} w${Math.max(ws, wa)})`) }
  return +(v * f).toFixed(3) }))
writeFileSync(`ve${b}_R11.tsv`, out.map(r => r.join('\t')).join('\n'))
console.log(`bank ${b}: ${n} cells changed`); console.log(log.join(' | '))
