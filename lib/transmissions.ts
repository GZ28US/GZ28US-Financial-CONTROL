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
  if (b === 'DODGE' && m === 'VIPER') {
    // Gen 5 (2013-17): TR6060 6-speed manual, the only transmission ever offered.
    if (y >= 2013 && y <= 2017) return ['TR6060 (Manual6)']
    if (y <= 2002) return ['T56 (Manual6)']
    return []
  }
  if (b === 'RAM' || (b === 'DODGE' && m === 'RAM')) {
    // TRX (2021-2024 e o TRX SRT 2027, 6.2 SC) runs the heavy-duty ZF 8HP95 — auto only.
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
  if (b === 'CHRYSLER' && m === '300C') {
    // V8 sempre automático: NAG1 (W5A580) até 2014; TorqueFlite ZF 8HP70 de 2015+.
    if (has('SRT8 6.1') || has('SRT8 6.4')) return ['NAG1 W5A580 (Auto5)']
    if (has('392')) return ['ZF8HP70 (Auto8)']
    if (y >= 2005 && y <= 2014) return ['NAG1 W5A580 (Auto5)']
    if (y >= 2015 && y <= 2023) return ['ZF8HP70 (Auto8)']
    return []
  }
  if (b === 'PONTIAC' && m === 'FIREBIRD') {
    // 4th-gen F-body V8: 4L60 in '93, 4L60E from '94; T56 manual across the run.
    if (y >= 1993 && y <= 2002) return [y >= 1994 ? 'GM4L60E (Auto4)' : 'GM4L60 (Auto4)', 'T56 (Manual6)']
    // 3rd gen: 700R4 + T5 (as the Camaro); GTA auto-only; the '89 Turbo 3.8 used
    // the Grand National's TH200-4R, auto only.
    if (y >= 1982 && y <= 1992) {
      if (has('Turbo 3.8')) return ['TH200-4R (Auto4)']
      if (has('GTA')) return ['700R4 (Auto4)']
      return ['700R4 (Auto4)', 'T5 (Manual5)']
    }
    // 301 era (1980-81): Turbo 4.9 auto-only; in '81 the Chevy 305 was the only 4-speed.
    if (y >= 1980 && y <= 1981) {
      if (y === 1981 && has('5.0')) return ['Super T-10 (Manual4)', 'TH350 (Auto3)']
      return ['TH350 (Auto3)']
    }
    // 1975-79: Super T-10 4-speed + TH350/TH400; the leftover '79 W72s were 4-speed only.
    if (y >= 1975 && y <= 1979) {
      if (y === 1979 && has('W72')) return ['Super T-10 (Manual4)']
      return ['Super T-10 (Manual4)', 'TH350 (Auto3)', 'TH400 (Auto3)']
    }
    // 1969-74: Muncie 4-speed + TH400.
    if (y >= 1969 && y <= 1974) return ['Muncie M20 (Manual4)', 'TH400 (Auto3)']
    return []
  }
  if (b === 'CHEVROLET' && m === 'CAMARO') {
    if (has('Z/28')) return ['TR6060 (Manual6)']
    if (has('ZL1')) return y >= 2017 ? ['GM10L90 (Auto10)', 'TR6060 (Manual6)'] : ['GM6L90 (Auto6)', 'TR6060 (Manual6)']
    if (y >= 2016) return [y >= 2019 ? 'GM10L80 (Auto10)' : 'GM8L90 (Auto8)', 'TR6060 (Manual6)']
    if (y >= 2010 && y <= 2015) return ['GM6L80 (Auto6)', 'TR6060 (Manual6)']
    if (y >= 1993 && y <= 2002) return [y >= 1994 ? 'GM4L60E (Auto4)' : 'GM4L60 (Auto4)', 'T56 (Manual6)']
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
  // Bronco Raptor: 10R60 — a caixa do Bronco, NÃO a 10R80 da F150 (mesma família de
  // 10 marchas, torque e relações diferentes).
  if (b === 'FORD' && m === 'BRONCO') return ['10R60 (Auto10)']
  if (b === 'FORD' && m === 'F150') {
    if (has('LIGHTNING') && y <= 2004) return ['4R100 (Auto4)']
    if (y >= 2017) return ['10R80 (Auto10)']
    return []
  }
  if (b === 'FORD' && m === 'MUSTANG') {
    if (has('GT500') && y >= 2007 && y <= 2014) return ['TR6060 (Manual6)']
    if (has('GT500') && y >= 2020) return ['TR9070 (DCT7)']
    if (has('MACH 1')) return ['10R80 (Auto10)', 'TR3160 (Manual6)']
    // S197: the Boss 302 was manual-only; the Shelby GT and the GT took either box.
    // 2005–2010 ran the TR-3650 five-speed / 5R55S; 2011–2014 the MT82 / 6R80.
    if (has('BOSS 302')) return ['MT82 (Manual6)']
    if (y >= 2011 && y <= 2014) return ['MT82 (Manual6)', '6R80 (Auto6)']
    if (y >= 2005 && y <= 2010) return ['TR-3650 (Manual5)', '5R55S (Auto5)']
    if (y >= 2018) return ['10R80 (Auto10)', 'MT82 (Manual6)']
    return []
  }

  // ---- Others ----
  if (b === 'BMW' && m === 'M5' && y >= 2005 && y <= 2010) return ['SMG III (SMG7)', 'Getrag (Manual6)']
  if (b === 'BMW' && m === 'M5' && y >= 2011 && y <= 2016) return ['M-DCT Drivelogic (DCT7)', 'Getrag (Manual6)']
  if (b === 'BMW' && m === 'M3' && y >= 2021) return has('COMPETITION') ? ['ZF8HP76 (Auto8)'] : ['ZF8HP76 (Auto8)', 'Manual6']
  // X6 G06/F96: automatic only across the range. The M cars run the reinforced
  // M Steptronic (8HP75); the M50i/M60i the standard 8HP76.
  if (b === 'BMW' && m === 'X6' && y >= 2020) return has(' M ') || v.startsWith('M ') || has('M COMPETITION') ? ['ZF8HP75 (Auto8)'] : ['ZF8HP76 (Auto8)']
  if (b === 'PORSCHE' && m === '911' && has('TURBO') && y >= 2006 && y <= 2009) return ['G97 (Manual6)', 'Tiptronic S (Auto5)']
  if (b === 'LAND ROVER' && m === 'DEFENDER') return y >= 2012 ? ['MT82 (Manual6)'] : ['R380 (Manual5)']
  if (b === 'MITSUBISHI' && m === 'ECLIPSE') return ['F5M33 (Manual5)', 'INVECS-II (Auto4)']
  if (b === 'MERCEDES-BENZ' && m === '300 SEL') return ['W3A 040 K4A 050 (Auto4)']
  // S63 W222/C217/A217: uma caixa por fase, sem manual e sem alternativa em nenhum ano —
  // a MCT (Multi-Clutch Technology) da AMG é derivada da 7G-TRONIC mas usa embreagem
  // úmida de partida no lugar do conversor; no catálogo roda como automática. O corte é
  // por ANO e não pelo texto da versão de propósito: o ano-modelo 2018 é o facelift em
  // TODAS as três carrocerias, então y >= 2018 separa 7G de 9G sem depender de como o
  // rótulo da versão estiver escrito.
  if (b === 'MERCEDES-BENZ' && m === 'S63 AMG') return y >= 2018 ? ['AMG SPEEDSHIFT MCT 9G (Auto9)'] : ['AMG SPEEDSHIFT MCT 7G (Auto7)']

  return []
}
