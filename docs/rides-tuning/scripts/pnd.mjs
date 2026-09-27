// P/N idle: which term drives the spark dance? spark vs rpm error (P) and rpm rate (D), at lags
import { readFileSync } from 'node:fs'
const f = process.argv[2]
const L = readFileSync(f, 'utf8').split(/\r?\n/); const hi = L.findIndex(l => l.startsWith('Offset,')); const names = L[hi].split(',')
const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
const need = ['Offset', 'Engine RPM', 'Idle Desired RPM', 'Actual Spark', 'Vehicle Speed', 'Trans Current Gear', 'Accelerator Pedal Effective Position', 'Engine Coolant Temp (SAE)', 'Total Misfires Since Key-on']
const last = {}; const R = []
for (let i = hi + 1; i < L.length; i++) { const c = L[i].split(','); if (c.length < names.length - 2) continue; const o = {}; for (const n of need) { const v = c[idx[n]]; if (v !== undefined && v !== '') last[n] = v; o[n] = last[n] } if (o.Offset === undefined || isNaN(parseFloat(o.Offset))) continue; R.push(o) }
const g = (o, n) => parseFloat(o[n])
const pn = o => g(o, 'Vehicle Speed') < 1 && !/^[1-8]$/.test(String(o['Trans Current Gear']).trim()) && g(o, 'Accelerator Pedal Effective Position') < 1 && g(o, 'Engine Coolant Temp (SAE)') > 180 && g(o, 'Engine RPM') > 450
const t = R.map(o => g(o, 'Offset')), rpm = R.map(o => g(o, 'Engine RPM')), des = R.map(o => g(o, 'Idle Desired RPM')), sp = R.map(o => g(o, 'Actual Spark'))
const dt = (t.at(-1) - t[0]) / (t.length - 1)
console.log('rows', R.length, 'dt', dt.toFixed(4))
const idxAt = (i, s) => Math.max(0, Math.min(R.length - 1, i + Math.round(s / dt)))
const corr = (a, b) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2 } return sab / Math.sqrt(saa * sbb) }
const sel = []; for (let i = 20; i < R.length - 20; i++) if (pn(R[i]) && pn(R[idxAt(i, -1)]) && pn(R[idxAt(i, 1)])) sel.push(i)
console.log('P/N samples', sel.length)
for (const win of [0.05, 0.1, 0.2]) for (const lag of [0, 0.05, 0.1, 0.15, 0.2, 0.3]) {
  const S = [], E = [], D = []
  for (const i of sel) { const j = idxAt(i, -lag); S.push(sp[i]); E.push(des[j] - rpm[j]); D.push(-(rpm[j] - rpm[idxAt(j, -win)]) / win) }
  console.log(`win ${win}s lag ${lag}s  corr(spark, err)=${corr(S, E).toFixed(2)}  corr(spark, -drpm/dt)=${corr(S, D).toFixed(2)}  |drpm/dt| p50=${D.map(Math.abs).sort((a, b) => a - b)[D.length >> 1].toFixed(0)} p90=${D.map(Math.abs).sort((a, b) => a - b)[Math.floor(D.length * .9)].toFixed(0)} rpm/s`)
}
