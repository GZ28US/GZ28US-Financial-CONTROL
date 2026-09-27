import { readFileSync } from 'node:fs'
for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/); const hi = lines.findIndex(l => l.startsWith('Offset,')); const names = lines[hi].split(','); const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
  const R = []; for (let i = hi + 2; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < names.length - 2) continue; R.push(c) }
  const g = (c, n) => parseFloat(c[idx[n]]); const raw = (c, n) => c[idx[n]]; const has = n => n in idx
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; const sd = a => Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2)))
  for (const [lab, p] of [['P/N', c => !/^[1-8]$/.test(raw(c, 'Trans Current Gear'))], ['D', c => /^[1-8]$/.test(raw(c, 'Trans Current Gear'))]]) {
    const s = R.filter(c => g(c, 'Vehicle Speed') < 1 && g(c, 'Engine RPM') > 450 && g(c, 'Engine Coolant Temp (SAE)') > 180 && g(c, 'Accelerator Pedal Effective Position') < 1 && p(c)); if (s.length < 50) continue
    const col = n => s.map(c => g(c, n)).filter(Number.isFinite)
    let mis = '-'; if (has('Total Misfires Since Key-on')) { let inc = 0; for (let i = 1; i < R.length; i++) { const a = R[i - 1], b = R[i]; if (s.includes(b)) { const d = g(b, 'Total Misfires Since Key-on') - g(a, 'Total Misfires Since Key-on'); if (d > 0 && d < 50) inc += d } } mis = (inc / (s.length * (g(R.at(-1), 'Offset') - g(R[0], 'Offset')) / R.length) * 60).toFixed(0) + '/min' }
    console.log(`${f.padEnd(12)} ${lab.padEnd(3)} n=${String(s.length).padStart(5)} rpm ${mean(col('Engine RPM')).toFixed(0)}±${sd(col('Engine RPM')).toFixed(0)} (des ${mean(col('Idle Desired RPM')).toFixed(0)}) spark ${mean(col('Actual Spark')).toFixed(1)}±${sd(col('Actual Spark')).toFixed(1)} [min ${Math.min(...col('Actual Spark')).toFixed(1)}] MAP ${mean(col('Sensed MAP')).toFixed(1)} am ${mean(col('Cylinder Airmass')).toFixed(3)} TPS ${mean(col('Throttle Position (SAE)')).toFixed(1)} cam ${mean(col('Exhaust Cam Center Pos')).toFixed(1)} λ ${mean(col('WB EQ Ratio 1 (SAE) (2)')).toFixed(3)}/${mean(col('WB EQ Ratio 5 (SAE) (2)')).toFixed(3)} ECT ${mean(col('Engine Coolant Temp (SAE)')).toFixed(0)} tqLoss ${has('Engine Torque Losses') ? mean(col('Engine Torque Losses')).toFixed(0) : '-'} actTq ${has('Actual Torque') ? mean(col('Actual Torque')).toFixed(0) : '-'} misf ${mis}`)
  }
}
