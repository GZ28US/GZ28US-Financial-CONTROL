// Solve a multiplier per rpm column for ONE VE row (PR 0.90) from base-λ samples, holding all other rows as they were at log time.
import { readFileSync } from 'node:fs'
const GOAL = 0.993
const rd = f => readFileSync(f, 'utf8').trim().split(/\r?\n/).map(l => l.split('\t').map(Number))
const hdr = readFileSync('ve1_R8.txt', 'utf8').split(/\r?\n/)[0].split('\t').slice(1, 18).map(Number)
const PR = readFileSync('ve1_R8.txt', 'utf8').split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => +l.split('\t')[0])
const T = { R8: { 1: rd('ve1_R8.txt').slice(1).map(r => r.slice(1, 18)), 2: rd('ve2_R8.txt').slice(1).map(r => r.slice(1, 18)) }, R9: { 1: rd('ve1_R9final.tsv'), 2: rd('ve2_R9final.tsv') } }
const ROW = PR.findIndex(p => Math.abs(p - 0.9) < 0.01)
const loc = (ax, v) => { if (v <= ax[0]) return [0, 0, 0]; if (v >= ax.at(-1)) return [ax.length - 1, ax.length - 1, 0]; let i = 0; while (ax[i + 1] < v) i++; return [i, i + 1, (v - ax[i]) / (ax[i + 1] - ax[i])] }
const acc = { 1: hdr.map(() => ({ w: 0, s: 0 })), 2: hdr.map(() => ({ w: 0, s: 0 })) }
for (const [f, tk] of [['R5_LOG.csv', 'R8'], ['R7_LOG.csv', 'R8'], ['R7_LOG2.csv', 'R8'], ['R8_LOG.csv', 'R8'], ['R9_LOG.csv', 'R9']]) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/); const hi = lines.findIndex(l => l.startsWith('Offset,')); const names = lines[hi].split(','); const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
  const hasF = 'Fuel System #1 Status (SAE)' in idx
  for (let i = hi + 2; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < names.length - 2) continue; const g = n => parseFloat(c[idx[n]])
    const pr = g('Pressure Ratio'), rpm = g('Engine RPM'); if (!(pr >= 0.8 && pr <= 1.0 && rpm > 900 && rpm < 3300 && g('Engine Coolant Temp (SAE)') > 185)) continue
    if (hasF && c[idx['Fuel System #1 Status (SAE)']] !== 'CL - Normal') continue
    for (const b of [1, 2]) { const lam = g(b === 1 ? 'WB EQ Ratio 1 (SAE) (2)' : 'WB EQ Ratio 5 (SAE) (2)'); if (!(lam > 0.6 && lam < 1.4)) continue
      const base = lam * (1 + g(`Short Term Fuel Trim Bank ${b}`) / 100) * (1 + (g(`Long Term Fuel Trim Bank ${b} (SAE)`) || 0) / 100)
      const V = T[tk][b]; const [r0, r1, fr] = loc(PR, pr), [c0, c1, fc] = loc(hdr, rpm)
      const cell = (r, cc) => V[r][cc]; const interp = cell(r0, c0) * (1 - fr) * (1 - fc) + cell(r0, c1) * (1 - fr) * fc + cell(r1, c0) * fr * (1 - fc) + cell(r1, c1) * fr * fc
      const need = interp * base / GOAL
      // weight of ROW in this sample
      const wr = (r0 === ROW ? 1 - fr : 0) + (r1 === ROW ? fr : 0); if (wr < 0.5) continue
      const others = interp - wr * ((cell(ROW, c0)) * (1 - fc) + cell(ROW, c1) * fc)
      const rowNeeded = (need - others) / wr // needed interpolated value along the row at this rpm
      const rowNow = cell(ROW, c0) * (1 - fc) + cell(ROW, c1) * fc; const k = rowNeeded / rowNow
      for (const [cc, w] of [[c0, 1 - fc], [c1, fc]]) { if (w <= 0) continue; acc[b][cc].w += w * wr; acc[b][cc].s += w * wr * Math.log(k) } } } }
for (const b of [1, 2]) { console.log(`bank ${b} row PR ${PR[ROW]} (current R9/R11 values → factor [weight])`)
  console.log(hdr.map((h, cc) => { const a = acc[b][cc]; return a.w >= 3 ? `${h}:${T.R9[b][ROW][cc].toFixed(1)}→×${Math.exp(a.s / a.w).toFixed(3)}[${a.w.toFixed(0)}]` : `${h}:${T.R9[b][ROW][cc].toFixed(1)}` }).join('  ')) }
