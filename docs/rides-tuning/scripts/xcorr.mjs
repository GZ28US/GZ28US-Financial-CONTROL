// Does ST react to the WB? Lagged correlation of first differences, closed-loop running samples. usage: node xcorr.mjs <csv>
import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/); const hi = lines.findIndex(l => l.startsWith('Offset,')); const names = lines[hi].split(','); const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
const rows = []; for (let i = hi + 2; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < names.length - 2) continue; rows.push(c) }
const g = (c, n) => parseFloat(c[idx[n]])
const dt = (g(rows[rows.length - 1], 'Offset') - g(rows[0], 'Offset')) / rows.length
for (const [lab, pred] of [['idle', c => g(c, 'Vehicle Speed') < 1 && g(c, 'Engine RPM') > 500 && g(c, 'Engine RPM') < 1300], ['cruise', c => g(c, 'Vehicle Speed') > 10 && g(c, 'Sensed MAP') < 70 && g(c, 'Accelerator Pedal Effective Position') > 0.5]]) {
  const ok = rows.map(pred); const st = rows.map(c => g(c, 'Short Term Fuel Trim Bank 1')), wb = rows.map(c => g(c, 'WB EQ Ratio 1 (SAE) (2)'))
  const out = []
  for (const lag of [-40, -20, -10, -5, 0, 5, 10, 20, 40]) { // lag>0: WB leads ST  (WB at t, ST at t+lag)
    const xs = [], ys = []; for (let i = 1; i < rows.length; i++) { const j = i + lag; if (j < 1 || j >= rows.length || !ok[i] || !ok[j] || !ok[i - 1] || !ok[j - 1]) continue; xs.push(wb[i] - wb[i - 1]); ys.push(st[j] - st[j - 1]) }
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2 }
    out.push(`${(lag * dt).toFixed(2)}s:${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`) }
  // level relation: ST vs (WB - desired lambda)
  const s = rows.filter(pred); const err = s.map(c => g(c, 'WB EQ Ratio 1 (SAE) (2)') - 0.0722 / g(c, 'Desired FA Ratio Cyl 1'))
  console.log(lab, 'dt', dt.toFixed(3), 's  corr(dWB_t, dST_t+lag):', out.join(' '), ' mean(WB-desλ)', (err.reduce((a, b) => a + b, 0) / err.length).toFixed(3)) }
