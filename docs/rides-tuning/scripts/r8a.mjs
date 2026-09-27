// R8 LOG: O2 goal voltage vs WB, rear O2, by region
import { readFileSync } from 'node:fs'
const f = process.argv[2]
const lines = readFileSync(f, 'utf8').split(/\r?\n/); const hi = lines.findIndex(l => l.startsWith('Offset,')); const names = lines[hi].split(','); const units = lines[hi + 1].split(',')
const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
const rows = []; for (let i = hi + 2; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < names.length - 2) continue; rows.push(c) }
const g = (c, n) => parseFloat(c[idx[n]]); const raw = (c, n) => c[idx[n]]
const mean = a => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN }
console.log('rows', rows.length, 'dur', (g(rows.at(-1), 'Offset') - g(rows[0], 'Offset')).toFixed(0), 's')
for (const n of ['O2 Voltage B1S1', 'O2 Voltage B1S2', 'Rear O2 Correction', 'O2 B1S1 Default Goal Voltage', 'WB Current 1 (SAE)', 'Desired FA Ratio Cyl 1']) console.log('unit', n, '=', units[idx[n]])
const lsu = ma => { const pts = [[-2.0, 0.70], [-1.602, 0.75], [-1.243, 0.80], [-0.927, 0.85], [-0.8, 0.87], [-0.652, 0.88], [-0.405, 0.90], [-0.183, 0.95], [-0.106, 0.97], [-0.04, 0.99], [0, 1.003], [0.097, 1.05], [0.193, 1.10], [0.282, 1.15], [0.365, 1.20]]
  if (ma <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (ma <= pts[i][0]) { const [a, la] = pts[i - 1], [b, lb] = pts[i]; return la + (lb - la) * (ma - a) / (b - a) } return pts.at(-1)[1] }
const hist = []; const st = []
for (const c of rows) { const t = g(c, 'Offset'), m = g(c, 'Sensed MAP'), r = g(c, 'Engine RPM'); hist.push([t, m, r]); while (hist.length && hist[0][0] < t - 1) hist.shift(); st.push(hist.every(h => Math.abs(h[1] - m) < 3 && Math.abs(h[2] - r) < 100)) }
const R = {
  'idle P/N': c => g(c, 'Vehicle Speed') < 1 && g(c, 'Engine RPM') > 500 && g(c, 'Engine RPM') < 1100 && !/^[1-8]$/.test(raw(c, 'Trans Current Gear')),
  'idle in gear': c => g(c, 'Vehicle Speed') < 1 && g(c, 'Engine RPM') > 500 && g(c, 'Engine RPM') < 1100 && /^[1-8]$/.test(raw(c, 'Trans Current Gear')),
  'cruise 1100-1500': c => g(c, 'Vehicle Speed') > 10 && g(c, 'Engine RPM') >= 1100 && g(c, 'Engine RPM') < 1500 && g(c, 'Sensed MAP') < 70 && g(c, 'Accelerator Pedal Effective Position') > 0.5,
  'cruise 1500-2100': c => g(c, 'Vehicle Speed') > 10 && g(c, 'Engine RPM') >= 1500 && g(c, 'Engine RPM') < 2100 && g(c, 'Sensed MAP') < 70 && g(c, 'Accelerator Pedal Effective Position') > 0.5,
  'cruise 2100-2800': c => g(c, 'Vehicle Speed') > 10 && g(c, 'Engine RPM') >= 2100 && g(c, 'Engine RPM') < 2800 && g(c, 'Sensed MAP') < 70 && g(c, 'Accelerator Pedal Effective Position') > 0.5,
  'overrun (ped 0, >10mph)': c => g(c, 'Vehicle Speed') > 10 && g(c, 'Accelerator Pedal Effective Position') < 0.5,
}
const cols = [['WB1λ', 'WB EQ Ratio 1 (SAE) (2)'], ['WB5λ', 'WB EQ Ratio 5 (SAE) (2)'], ['I1', 'WB Current 1 (SAE)'], ['I5', 'WB Current 5 (SAE)'], ['V1S1', 'O2 Voltage B1S1'], ['V2S1', 'O2 Voltage B2S1'], ['goalD1', 'O2 B1S1 Default Goal Voltage'], ['goalD2', 'O2 B2S1 Default Goal Voltage'], ['rearC', 'Rear O2 Correction'], ['V1S2', 'O2 Voltage B1S2'], ['V2S2', 'O2 Voltage B2S2'], ['ST1', 'Short Term Fuel Trim Bank 1'], ['ST2', 'Short Term Fuel Trim Bank 2'], ['LT1', 'Long Term Fuel Trim Bank 1 (SAE)'], ['LT2', 'Long Term Fuel Trim Bank 2 (SAE)'], ['rpm', 'Engine RPM'], ['MAP', 'Sensed MAP'], ['am', 'Cylinder Airmass'], ['PW', 'Injector Pulse Width Cyl 1']]
console.log('\nregion'.padEnd(26) + 'n'.padStart(6) + cols.map(c => c[0].padStart(8)).join('') + '  desλ  lsuλ1 lsuλ2  FSS')
for (const [name, p] of Object.entries(R)) { const s = rows.filter(p); if (!s.length) continue; const fss = {}; s.forEach(c => { const v = raw(c, 'Fuel System #1 Status (SAE)'); fss[v] = (fss[v] || 0) + 1 })
  console.log(name.padEnd(25) + String(s.length).padStart(6) + cols.map(([, n]) => { const v = mean(s.map(c => g(c, n))); return (Number.isFinite(v) ? v.toFixed(Math.abs(v) < 10 ? 3 : 0) : '-').padStart(8) }).join('') + (0.0722 / mean(s.map(c => g(c, 'Desired FA Ratio Cyl 1')))).toFixed(3).padStart(7) + lsu(mean(s.map(c => g(c, 'WB Current 1 (SAE)')))).toFixed(3).padStart(7) + lsu(mean(s.map(c => g(c, 'WB Current 5 (SAE)')))).toFixed(3).padStart(7) + '  ' + Object.entries(fss).map(([k, v]) => k + ':' + v).join(' ')) }
// relation O2 Voltage S1 vs lambda (all running samples) — bins of WB λ
console.log('\nO2 Voltage B1S1 vs WB1 λ (running):')
for (const [a, b] of [[0.7, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 0.95], [0.95, 0.98], [0.98, 1.0], [1.0, 1.02], [1.02, 1.05], [1.05, 1.1], [1.1, 1.3], [1.3, 2]]) { const s = rows.filter(c => g(c, 'Engine RPM') > 500 && g(c, 'WB EQ Ratio 1 (SAE) (2)') >= a && g(c, 'WB EQ Ratio 1 (SAE) (2)') < b); if (s.length < 20) continue
  console.log(`  λ ${a}-${b} n=${s.length} V1S1=${mean(s.map(c => g(c, 'O2 Voltage B1S1'))).toFixed(3)} I1=${mean(s.map(c => g(c, 'WB Current 1 (SAE)'))).toFixed(3)} goalD1=${mean(s.map(c => g(c, 'O2 B1S1 Default Goal Voltage'))).toFixed(3)}`) }
// Distinct values of default goal voltage and rear correction
const dist = n => { const m = {}; for (const c of rows) { const v = raw(c, n); m[v] = (m[v] || 0) + 1 } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${(+k).toFixed ? (+k).toFixed(3) : k}:${v}`).join('  ') }
for (const n of ['O2 B1S1 Default Goal Voltage', 'O2 B2S1 Default Goal Voltage', 'Rear O2 Correction', 'Fuel System #1 Status (SAE)', 'TCC Pattern', 'Transfer Case Status']) console.log(n, '→', dist(n))
