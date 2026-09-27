import { readFileSync } from 'node:fs'
const f = process.argv[2]
const L = readFileSync(f, 'utf8').split(/\r?\n/); const hi = L.findIndex(l => l.startsWith('Offset,')); const names = L[hi].split(',')
const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
const need = ['Offset', 'Engine RPM', 'Idle Desired RPM', 'Actual Spark', 'Vehicle Speed', 'Trans Current Gear', 'Accelerator Pedal Effective Position', 'Engine Coolant Temp (SAE)', 'Turbine Torque', 'Trans Engine Torque', 'Actual Torque', 'Desired Steady State Flywheel Torque', 'Engine Torque Losses', 'Trans Fluid Temp', 'Trans Turbine RPM', 'Total Airflow', 'Desired Engine Airflow', 'MBT Advance', 'Cylinder Airmass']
const last = {}; const R = []
for (let i = hi + 1; i < L.length; i++) { const c = L[i].split(','); if (c.length < names.length - 2) continue; const o = {}; for (const n of need) { const v = idx[n] === undefined ? undefined : c[idx[n]]; if (v !== undefined && v !== '') last[n] = v; o[n] = last[n] } if (isNaN(parseFloat(o.Offset))) continue; R.push(o) }
const g = (o, n) => parseFloat(o[n])
const inD = o => /^[1-8]$/.test(String(o['Trans Current Gear']).trim())
const segs = { D: o => g(o, 'Vehicle Speed') < 1 && inD(o) && g(o, 'Accelerator Pedal Effective Position') < 1 && g(o, 'Engine Coolant Temp (SAE)') > 180, PN: o => g(o, 'Vehicle Speed') < 1 && !inD(o) && g(o, 'Accelerator Pedal Effective Position') < 1 && g(o, 'Engine Coolant Temp (SAE)') > 180 }
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
for (const [k, p] of Object.entries(segs)) {
  const s = R.filter(p); if (s.length < 30) continue
  const m = n => { const v = s.map(o => g(o, n)).filter(Number.isFinite); return v.length ? mean(v).toFixed(2) : '-' }
  console.log(`${f.split(/[\/]/).pop()} ${k} n=${s.length} rpm ${m('Engine RPM')} des ${m('Idle Desired RPM')} turbRPM ${m('Trans Turbine RPM')} TurbTq ${m('Turbine Torque')} TransEngTq ${m('Trans Engine Torque')} ActTq ${m('Actual Torque')} DSSFT ${m('Desired Steady State Flywheel Torque')} Loss ${m('Engine Torque Losses')} spark ${m('Actual Spark')} MBT ${m('MBT Advance')} air ${m('Total Airflow')}/${m('Desired Engine Airflow')} am ${m('Cylinder Airmass')} TFT ${m('Trans Fluid Temp')}`)
}
