import { readFileSync } from 'node:fs'
const f = process.argv[2], T1 = +(process.argv[3] || 80)
const L = readFileSync(f, 'utf8').split(/\r?\n/); const hi = L.findIndex(l => l.startsWith('Offset,')); const names = L[hi].split(',')
const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
const need = ['Offset', 'Engine RPM', 'Idle Desired RPM', 'Actual Spark', 'MBT Advance', 'Engine Coolant Temp (SAE)', 'Actual Torque', 'Desired Steady State Flywheel Torque', 'Engine Torque Losses', 'Desired Engine Airflow', 'Total Airflow', 'Sensed MAP', 'Throttle Position (SAE)', 'Trans Current Gear', 'Exhaust Cam Center Pos']
const last = {}; const R = []
for (let i = hi + 1; i < L.length; i++) { const c = L[i].split(','); if (c.length < names.length - 2) continue; const o = {}; for (const n of need) { const v = idx[n] === undefined ? undefined : c[idx[n]]; if (v !== undefined && v !== '') last[n] = v; o[n] = last[n] } if (isNaN(parseFloat(o.Offset))) continue; R.push(o) }
const g = (o, n) => parseFloat(o[n])
console.log('  t   rpm  des  spark MBT  ECT  ActTq DSSFT Loss  desAir totAir MAP  TPS gear')
for (let t = 0; t <= T1; t += 2) {
  const s = R.filter(o => g(o, 'Offset') >= t && g(o, 'Offset') < t + 2); if (!s.length) continue
  const m = n => { const v = s.map(o => g(o, n)).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN }
  console.log(`${String(t).padStart(3)} ${m('Engine RPM').toFixed(0).padStart(5)} ${m('Idle Desired RPM').toFixed(0).padStart(4)} ${m('Actual Spark').toFixed(1).padStart(5)} ${m('MBT Advance').toFixed(1).padStart(4)} ${m('Engine Coolant Temp (SAE)').toFixed(0).padStart(4)} ${m('Actual Torque').toFixed(1).padStart(6)} ${m('Desired Steady State Flywheel Torque').toFixed(1).padStart(5)} ${m('Engine Torque Losses').toFixed(1).padStart(5)} ${m('Desired Engine Airflow').toFixed(2).padStart(6)} ${m('Total Airflow').toFixed(2).padStart(6)} ${m('Sensed MAP').toFixed(1).padStart(5)} ${m('Throttle Position (SAE)').toFixed(1).padStart(4)} ${s[0]['Trans Current Gear']}`)
}
