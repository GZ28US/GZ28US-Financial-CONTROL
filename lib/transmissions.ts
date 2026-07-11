// FACTORY transmission options per car family. The RIDE pages show a TRANSMISSION
// picker ONLY when the car had more than one factory option; single-option cars are
// stamped automatically on save (e.g. Demons/RedEyes are always ZF8HP90).
// Naming convention: "<unit> (<type><gears>)" — e.g. "ZF8HP90 (Auto8)", "TR6060 (Manual6)".
export function transmissionOptionsFor(
  yearS: string | number | null | undefined,
  brand: string | null | undefined,
  model: string | null | undefined,
  version: string | null | undefined,
): string[] {
  const y = Number(yearS) || 0
  const b = (brand || '').toUpperCase().trim()
  const m = (model || '').toUpperCase().trim()
  const v = (version || '').toUpperCase()
  const has = (s: string) => v.includes(s.toUpperCase())

  // ---- MOPAR ----
  if (b === 'DODGE' && m === 'CHALLENGER') {
    if (has('DEMON')) return ['ZF8HP90 (Auto8)']
    if (has('REDEYE') || has('SUPERSTOCK') || has('JAILBREAK')) return ['ZF8HP90 (Auto8)']
    if (has('HELLCAT')) return ['ZF8HP90 (Auto8)', 'TR6060 (Manual6)']
    if (has('SCATPACK') || has('SCAT PACK')) return ['ZF8HP70 (Auto8)', 'TR6060 (Manual6)']
    return []
  }
  if (b === 'DODGE' && m === 'CHARGER') {
    if (y >= 2015 && (has('HELLCAT') || has('REDEYE'))) return ['ZF8HP90 (Auto8)']
    if (y >= 2015 && (has('SCATPACK') || has('SCAT PACK'))) return ['ZF8HP70 (Auto8)']
    if (y >= 1966 && y <= 1971) return ['A727 (Auto3)', 'A833 (Manual4)']
    if (y >= 2006 && y <= 2014) return ['NAG1 W5A580 (Auto5)']
    return []
  }
  if (b === 'DODGE' && m === 'DURANGO' && has('HELLCAT')) return ['ZF8HP95 (Auto8)']
  if (b === 'DODGE' && m === 'MAGNUM') return ['NAG1 W5A580 (Auto5)']
  if (b === 'DODGE' && m === 'VIPER' && y <= 2002) return ['T56 (Manual6)']
  if (b === 'RAM' || (b === 'DODGE' && m === 'RAM')) {
    // TRX (2021-2024, 6.2 SC Hellcat) runs the heavy-duty ZF 8HP95 — auto only.
    if (has('TRX')) return ['ZF8HP95 (Auto8)']
    if (y >= 2013 && y <= 2018) return ['ZF8HP70 (Auto8)', '65RFE (Auto6)']
    if (y >= 2019) return ['ZF8HP75 (Auto8)']
    return []
  }
  if (b === 'JEEP' && m === 'GRAND CHEROKEE') {
    if (has('SRT') || has('TRACKHAWK')) return y >= 2014 ? ['ZF8HP70 (Auto8)'] : ['NAG1 W5A580 (Auto5)']
    if (y >= 1993 && y <= 1998) return ['46RE (Auto4)']
    if (y >= 2005 && y <= 2010) return ['545RFE (Auto5)']
    return []
  }

  // ---- GM ----
  if (b === 'CHEVROLET' && m === 'CAMARO') {
    if (has('Z/28')) return ['TR6060 (Manual6)']
    if (has('ZL1')) return y >= 2017 ? ['GM10L90 (Auto10)', 'TR6060 (Manual6)'] : ['GM6L90 (Auto6)', 'TR6060 (Manual6)']
    if (y >= 2016) return [y >= 2019 ? 'GM10L80 (Auto10)' : 'GM8L90 (Auto8)', 'TR6060 (Manual6)']
    if (y >= 2010 && y <= 2015) return ['GM6L80 (Auto6)', 'TR6060 (Manual6)']
    if (y >= 1982 && y <= 1992) return ['700R4 (Auto4)', 'T5 (Manual5)']
    if (y >= 1967 && y <= 1969) return ['Muncie M20 (Manual4)', 'Saginaw (Manual3)', 'Powerglide (Auto2)', 'TH350 (Auto3)']
    return []
  }
  if (b === 'CHEVROLET' && m === 'CORVETTE') {
    if (y >= 2020) return ['TR9080 (DCT8)']
    if (y >= 2015 && y <= 2019) return ['GM8L90 (Auto8)', 'TR6070 (Manual7)']
    if (y === 2014) return ['GM6L80 (Auto6)', 'TR6070 (Manual7)']
    if (y >= 2008 && y <= 2013) return has('ZR1') ? ['TR6060 (Manual6)'] : ['GM6L80 (Auto6)', 'TR6060 (Manual6)']
    if (y >= 2005 && y <= 2007) return ['GM6L80 (Auto6)', 'T56 (Manual6)']
    // C4 LT1 era: 4L60 (92-93) / 4L60E (94-96) auto or ZF 6-speed; ZR-1 manual only.
    if (y >= 1992 && y <= 1996) {
      if (has('ZR-1') || has('ZR1')) return ['ZF S6-40 (Manual6)']
      return [y >= 1994 ? 'GM4L60E (Auto4)' : 'GM4L60 (Auto4)', 'ZF S6-40 (Manual6)']
    }
    return []
  }
  if (b === 'CHEVROLET' && m === 'OPALA') return ['Manual4', 'Manual3', 'Auto3']
  if (b === 'CHEVROLET' && m === 'D20') return ['Manual5']
  if (b === 'CADILLAC' && m.includes('CTS-V')) return y >= 2009 && y <= 2015 ? ['GM6L90 (Auto6)', 'TR6060 (Manual6)'] : []

  // ---- FORD ----
  if (b === 'FORD' && m === 'F150') {
    if (has('LIGHTNING') && y <= 2004) return ['4R100 (Auto4)']
    if (y >= 2017) return ['10R80 (Auto10)']
    return []
  }
  if (b === 'FORD' && m === 'MUSTANG') {
    if (has('GT500') && y >= 2007 && y <= 2014) return ['TR6060 (Manual6)']
    if (has('GT500') && y >= 2020) return ['TR9070 (DCT7)']
    if (has('MACH 1')) return ['10R80 (Auto10)', 'TR3160 (Manual6)']
    if (y >= 2018) return ['10R80 (Auto10)', 'MT82 (Manual6)']
    return []
  }

  // ---- Others ----
  if (b === 'BMW' && m === 'M5' && y >= 2005 && y <= 2010) return ['SMG III (SMG7)', 'Getrag (Manual6)']
  if (b === 'BMW' && m === 'M3' && y >= 2021) return has('COMPETITION') ? ['ZF8HP76 (Auto8)'] : ['ZF8HP76 (Auto8)', 'Manual6']
  if (b === 'PORSCHE' && m === '911' && has('TURBO') && y >= 2006 && y <= 2009) return ['G97 (Manual6)', 'Tiptronic S (Auto5)']
  if (b === 'LAND ROVER' && m === 'DEFENDER') return y >= 2012 ? ['MT82 (Manual6)'] : ['R380 (Manual5)']
  if (b === 'MITSUBISHI' && m === 'ECLIPSE') return ['F5M33 (Manual5)', 'INVECS-II (Auto4)']

  return []
}
