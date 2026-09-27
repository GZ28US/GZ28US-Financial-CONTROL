// R9 VE correction: bring the BASE fueling (trims removed) to the loop goal λ.
// factor per sample = λ_SAE × (1+ST/100) × (1+LT/100) / λ_goal  → VE_new = VE_old × factor (bilinear-weighted, geometric mean per cell)
// usage: node vecorr_r9.mjs <bank 1|2> <ve_with_axis.txt> <log.csv>...   → stdout: values-only TSV (17x17); stderr: report
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
const [bankS, veFile, ...logs] = process.argv.slice(2); const bank = Number(bankS)
const GOAL = 0.993, PR_MAX = 0.90, WMIN = 20, CLAMP_LO = 0.80, CLAMP_HI = 1.06
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN }
const L = readFileSync(veFile, 'utf8').split(/\r?\n/).filter(l => l.trim())
const rpmAx = L[0].split('\t').slice(1).map(num).filter(Number.isFinite)
const rows = L.slice(1).map(l => l.split('\t').map(num)).filter(r => r.length > rpmAx.length)
const prAx = rows.map(r => r[0]); const ve = rows.map(r => r.slice(1, 1 + rpmAx.length))
const locate = (ax, v) => { if (v <= ax[0]) return [0, 0, 0]; if (v >= ax.at(-1)) return [ax.length - 1, ax.length - 1, 0]; let i = 0; while (ax[i + 1] < v) i++; return [i, i + 1, (v - ax[i]) / (ax[i + 1] - ax[i])] }
const interp = (pr, rpm) => { const [r0, r1, fr] = locate(prAx, pr), [c0, c1, fc] = locate(rpmAx, rpm); return ve[r0][c0] * (1 - fr) * (1 - fc) + ve[r0][c1] * (1 - fr) * fc + ve[r1][c0] * fr * (1 - fc) + ve[r1][c1] * fr * fc }
const W = prAx.map(() => rpmAx.map(() => 0)), S = prAx.map(() => rpmAx.map(() => 0))
const WB = bank === 1 ? 'WB EQ Ratio 1 (SAE) (2)' : 'WB EQ Ratio 5 (SAE) (2)', ST = `Short Term Fuel Trim Bank ${bank}`, LT = `Long Term Fuel Trim Bank ${bank} (SAE)`, BVE = `Base Volumetric Efficiency Bank ${bank}`
let chk = [], used = 0, usedOver = 0
for (const f of logs) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/); const hi = lines.findIndex(l => l.startsWith('Offset,')); const names = lines[hi].split(','); const idx = {}; names.forEach((n, i) => { if (!(n in idx)) idx[n] = i })
  const R = []; for (let i = hi + 2; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < names.length - 2) continue; R.push(c) }
  const g = (c, n) => num(c[idx[n]]); const hasFSS = 'Fuel System #1 Status (SAE)' in idx
  const t = R.map(c => g(c, 'Offset')), rpm = R.map(c => g(c, 'Engine RPM')), map = R.map(c => g(c, 'Sensed MAP'))
  let j0 = 0, j1 = 0, nUse = 0
  for (let i = 0; i < R.length; i++) {
    const c = R[i]; while (t[j0] < t[i] - 1.0) j0++; while (j1 + 1 < R.length && t[j1 + 1] <= t[i] + 0.5) j1++
    let mxr = -1e9, mnr = 1e9, mxm = -1e9, mnm = 1e9; for (let k = j0; k <= j1; k++) { mxr = Math.max(mxr, rpm[k]); mnr = Math.min(mnr, rpm[k]); mxm = Math.max(mxm, map[k]); mnm = Math.min(mnm, map[k]) }
    const lam = g(c, WB), st = g(c, ST), lt = g(c, LT), pr = g(c, 'Pressure Ratio'), ect = g(c, 'Engine Coolant Temp (SAE)'), ped = g(c, 'Accelerator Pedal Effective Position'), spd = g(c, 'Vehicle Speed')
    if (!(rpm[i] > 550) || !(ect >= 185) || !(lam > 0.6 && lam < 1.3) || !Number.isFinite(pr) || pr > PR_MAX || !Number.isFinite(st)) continue
    if (hasFSS && c[idx['Fuel System #1 Status (SAE)']] !== 'CL - Normal') continue
    const overrun = ped < 0.5 && spd > 5
    const steady = overrun ? (mxm - mnm < 8 && mxr - mnr < 450) : (mxm - mnm < 4 && mxr - mnr < 120)
    if (!steady) continue
    // 1 s after a DFCO exit is transient wall-wetting: skip (DFCO = λ pinned ≥1.5 within the last 1.5 s)
    let dfco = false; for (let k = Math.max(0, i - 30); k < i; k++) if (g(R[k], WB) >= 1.5) { dfco = true; break } if (dfco) continue
    const fac = lam * (1 + st / 100) * (1 + (Number.isFinite(lt) ? lt : 0) / 100) / GOAL
    const [r0, r1, fr] = locate(prAx, pr), [c0, c1, fc] = locate(rpmAx, rpm[i])
    for (const [r, cc, w] of [[r0, c0, (1 - fr) * (1 - fc)], [r0, c1, (1 - fr) * fc], [r1, c0, fr * (1 - fc)], [r1, c1, fr * fc]]) { if (w <= 0) continue; W[r][cc] += w; S[r][cc] += w * Math.log(fac) }
    used++; nUse++; if (overrun) usedOver++
    const b = g(c, BVE); if (Number.isFinite(b) && basename(f) === basename(logs.at(-1))) chk.push(Math.abs(interp(pr, rpm[i]) - b))
  }
  console.error(`${basename(f)}: used ${nUse}`)
}
chk.sort((a, b) => a - b)
console.error(`bank ${bank}: samples used ${used} (overrun ${usedOver}); VE lookup check vs logged Base VE (last log): median |diff| ${chk[Math.floor(chk.length / 2)]?.toFixed(2)} p95 ${chk[Math.floor(chk.length * 0.95)]?.toFixed(2)} (VE %)`)
console.error('correction % [weight]  rows=PR cols=RPM (blank = unchanged)')
console.error('       ' + rpmAx.map(x => String(x).padStart(11)).join(''))
const out = ve.map((row, r) => row.map((v, c) => { if (W[r][c] < WMIN) return v; const f = Math.min(CLAMP_HI, Math.max(CLAMP_LO, Math.exp(S[r][c] / W[r][c]))); return +(v * f).toFixed(3) }))
prAx.forEach((p, r) => console.error(p.toFixed(2).padStart(6) + ' ' + rpmAx.map((_, c) => W[r][c] >= WMIN ? `${(100 * (Math.min(CLAMP_HI, Math.max(CLAMP_LO, Math.exp(S[r][c] / W[r][c]))) - 1)).toFixed(1)}[${Math.round(W[r][c])}]`.padStart(11) : ''.padStart(11)).join('')))
console.log(out.map(r => r.join('\t')).join('\n'))
