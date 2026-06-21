export const years = [
  1968, 1969, 1970,
  1992, 1993, 1994, 1995,
  2005, 2006, 2007, 2008,
  2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017,
  2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
]

export const manufacturersByYear: Record<number, string[]> = {
  1968: ['MOPAR'], 1969: ['MOPAR'], 1970: ['MOPAR'],
  1992: ['MOPAR'], 1993: ['MOPAR'], 1994: ['MOPAR'], 1995: ['MOPAR'],
  2005: ['GM'], 2006: ['MOPAR', 'GM'], 2007: ['MOPAR', 'GM'], 2008: ['MOPAR', 'GM'],
  2009: ['MOPAR', 'GM'],
  2010: ['MOPAR', 'GM'], 2011: ['MOPAR', 'GM'], 2012: ['MOPAR', 'GM'], 2013: ['MOPAR', 'GM'],
  2014: ['MOPAR', 'GM'],
  2015: ['MOPAR', 'GM', 'FORD'],
  2016: ['MOPAR', 'GM', 'FORD'],
  2017: ['MOPAR', 'GM', 'FORD'],
  2018: ['MOPAR', 'GM', 'FORD'],
  2019: ['MOPAR', 'GM', 'FORD'],
  2020: ['MOPAR', 'GM', 'FORD'],
  2021: ['MOPAR', 'GM', 'FORD'],
  2022: ['MOPAR', 'GM', 'FORD'],
  2023: ['MOPAR', 'GM', 'FORD'],
  2024: ['MOPAR', 'GM', 'FORD'],
  2025: ['MOPAR', 'GM', 'FORD'],
  2026: ['MOPAR', 'GM', 'FORD'],
}

export const brandsByManufacturerAndYear: Record<string, Record<number, string[]>> = {
  MOPAR: {
    1968: ['DODGE'], 1969: ['DODGE'], 1970: ['DODGE'],
    1992: ['DODGE'], 1993: ['DODGE'], 1994: ['DODGE'], 1995: ['DODGE'],
    2006: ['DODGE'], 2007: ['DODGE'], 2008: ['DODGE'],
    2009: ['DODGE', 'RAM'],
    2010: ['DODGE'], 2011: ['DODGE'], 2012: ['DODGE'], 2013: ['DODGE'], 2014: ['DODGE'],
    2015: ['DODGE', 'RAM'], 2016: ['DODGE', 'RAM'], 2017: ['DODGE', 'RAM'], 2018: ['DODGE', 'RAM'],
    2019: ['DODGE'], 2020: ['DODGE'], 2021: ['DODGE'], 2022: ['DODGE'], 2023: ['DODGE'],
    2024: ['DODGE'], 2025: ['DODGE'], 2026: ['DODGE'],
  },
  GM: {
    2005: ['CHEVROLET'], 2006: ['CHEVROLET'], 2007: ['CHEVROLET'], 2008: ['CHEVROLET'], 2009: ['CHEVROLET'],
    2010: ['CHEVROLET'], 2011: ['CHEVROLET'], 2012: ['CHEVROLET'], 2013: ['CHEVROLET'],
    2014: ['CHEVROLET'], 2015: ['CHEVROLET'], 2016: ['CHEVROLET'], 2017: ['CHEVROLET'],
    2018: ['CHEVROLET'], 2019: ['CHEVROLET'], 2020: ['CHEVROLET'], 2021: ['CHEVROLET'],
    2022: ['CHEVROLET'], 2023: ['CHEVROLET'], 2024: ['CHEVROLET'], 2025: ['CHEVROLET'], 2026: ['CHEVROLET'],
  },
  FORD: {
    2015: ['FORD'], 2016: ['FORD'],
    2017: ['FORD'], 2018: ['FORD'], 2019: ['FORD'], 2020: ['FORD'],
    2021: ['FORD'], 2022: ['FORD'], 2023: ['FORD'], 2024: ['FORD'],
    2025: ['FORD'], 2026: ['FORD'],
  },
}

export const modelsByBrandAndYear: Record<string, Record<number, string[]>> = {
  DODGE: {
    1968: ['CHARGER'], 1969: ['CHARGER'], 1970: ['CHARGER'],
    1992: ['VIPER'], 1993: ['VIPER'], 1994: ['VIPER'], 1995: ['VIPER'],
    2006: ['CHARGER'], 2007: ['CHARGER'],
    2008: ['CHALLENGER', 'CHARGER'], 2009: ['CHALLENGER', 'CHARGER'], 2010: ['CHALLENGER', 'CHARGER'],
    2011: ['CHALLENGER', 'CHARGER'], 2012: ['CHALLENGER', 'CHARGER'], 2013: ['CHALLENGER', 'CHARGER'],
    2014: ['CHALLENGER', 'CHARGER'], 2015: ['CHALLENGER', 'CHARGER'], 2016: ['CHALLENGER', 'CHARGER'],
    2017: ['CHALLENGER', 'CHARGER'],
    2018: ['CHALLENGER', 'CHARGER'],
    2019: ['CHALLENGER', 'CHARGER'],
    2020: ['CHALLENGER', 'CHARGER'],
    2021: ['CHALLENGER', 'CHARGER', 'DURANGO'],
    2022: ['CHALLENGER', 'CHARGER'],
    2023: ['CHALLENGER', 'CHARGER', 'DURANGO'],
    2024: ['DURANGO'],
    2025: ['DURANGO'],
    2026: ['DURANGO'],
  },
  RAM: {
    2009: ['1500'], 2015: ['1500'], 2016: ['1500'], 2017: ['1500'], 2018: ['1500'],
  },
  CHEVROLET: {
    2005: ['CORVETTE'], 2006: ['CORVETTE'], 2007: ['CORVETTE'], 2008: ['CORVETTE'], 2009: ['CORVETTE'],
    2010: ['CAMARO', 'CORVETTE'], 2011: ['CAMARO', 'CORVETTE'], 2012: ['CAMARO', 'CORVETTE'], 2013: ['CAMARO', 'CORVETTE'],
    2014: ['CAMARO', 'CORVETTE'], 2015: ['CAMARO', 'CORVETTE'],
    2016: ['CAMARO', 'CORVETTE'], 2017: ['CAMARO', 'CORVETTE'],
    2018: ['CAMARO', 'CORVETTE'], 2019: ['CAMARO', 'CORVETTE'], 2020: ['CAMARO', 'CORVETTE'],
    2021: ['CAMARO', 'CORVETTE'], 2022: ['CAMARO', 'CORVETTE'], 2023: ['CAMARO', 'CORVETTE'],
    2024: ['CAMARO', 'CORVETTE'], 2025: ['CORVETTE'], 2026: ['CORVETTE'],
  },
  FORD: {
    2015: ['MUSTANG'], 2016: ['MUSTANG'],
    2017: ['F150', 'MUSTANG'], 2018: ['F150', 'MUSTANG'], 2019: ['F150', 'MUSTANG'], 2020: ['F150', 'MUSTANG'],
    2021: ['F150', 'MUSTANG'], 2022: ['F150', 'MUSTANG'], 2023: ['F150', 'MUSTANG'], 2024: ['F150', 'MUSTANG'],
    2025: ['F150', 'MUSTANG'], 2026: ['F150', 'MUSTANG'],
  },
}

export const versionsByModelAndYear: Record<string, Record<number, string[]>> = {
  CHARGER: {
    1968: ['Base 5.2 V8', 'R/T 6.3 V8', 'R/T 7.0 V8 HEMI'],
    1969: ['Base 5.2 V8', '500 6.3 V8', 'R/T 6.3 V8', 'R/T 7.0 V8 HEMI', 'Daytona 6.6 V8', 'Daytona 7.0 V8 HEMI'],
    1970: ['Base 5.2 V8', '500 6.3 V8', 'R/T 6.3 V8', 'R/T 7.2 V8', 'R/T 7.0 V8 HEMI'],
    // LX generation (2006-2010): 5.7 HEMI = R/T, 6.1 HEMI = SRT8.
    // Daytona R/T and Super Bee are SPECIAL EDITIONS (see specialEditions), not trims.
    2006: ['R/T 5.7', 'SRT8 6.1'],
    2007: ['R/T 5.7', 'SRT8 6.1'],
    2008: ['R/T 5.7', 'SRT8 6.1'],
    2009: ['R/T 5.7', 'SRT8 6.1'],
    2010: ['R/T 5.7', 'SRT8 6.1'],
    // LD generation (2011-2014 pre-refresh): 5.7 HEMI = R/T, 6.4 HEMI = SRT8.
    2011: ['R/T 5.7', 'SRT8 6.4'],
    2012: ['R/T 5.7', 'SRT8 6.4'],
    2013: ['R/T 5.7', 'SRT8 6.4'],
    2014: ['R/T 5.7', 'SRT8 6.4'],
    // LD refresh (2015-2017): Scat Pack 6.4, SRT 392 6.4, SRT Hellcat 6.2 SC.
    2015: ['R/T 5.7', 'ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2016: ['R/T 5.7', 'ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2017: ['R/T 5.7', 'ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2018: ['R/T 5.7', 'ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2019: ['R/T 5.7', 'ScatPack 6.4', 'ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
    2020: ['R/T 5.7', 'ScatPack 6.4', 'ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
    2021: ['R/T 5.7', 'ScatPack 6.4', 'ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
    2022: ['R/T 5.7', 'ScatPack 6.4', 'ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
    2023: ['R/T 5.7', 'ScatPack 6.4', 'ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
  },
  VIPER: {
    1992: ['RT/10 8.0 V10'], 1993: ['RT/10 8.0 V10'], 1994: ['RT/10 8.0 V10'], 1995: ['RT/10 8.0 V10'],
  },
  CHALLENGER: {
    // LC generation (2008-2014): 6.1 HEMI SRT8 (2008-2010), 6.4 HEMI SRT8/392 (2011-2014).
    2008: ['SRT8 6.1'],
    2009: ['R/T 5.7', 'SRT8 6.1'],
    2010: ['R/T 5.7', 'SRT8 6.1'],
    2011: ['R/T 5.7', 'SRT8 6.4'],
    2012: ['R/T 5.7', 'SRT8 6.4'],
    2013: ['R/T 5.7', 'SRT8 6.4'],
    2014: ['R/T 5.7', 'SRT8 6.4'],
    // LA refresh (2015-2017): Scat Pack 6.4, SRT 392 6.4, SRT Hellcat 6.2 SC.
    2015: ['R/T 5.7', 'R/T ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2016: ['R/T 5.7', 'R/T ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2017: ['R/T 5.7', 'R/T ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2'],
    2018: ['R/T 5.7', 'R/T ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT Demon 6.2'],
    2019: ['R/T 5.7', 'R/T ScatPack 6.4', 'R/T ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2'],
    2020: ['R/T 5.7', 'R/T ScatPack 6.4', 'R/T ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat RedEye SuperStock 6.2'],
    2021: ['R/T 5.7', 'R/T ScatPack 6.4', 'R/T ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat RedEye SuperStock 6.2'],
    2022: ['R/T 5.7', 'R/T ScatPack 6.4', 'R/T ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat RedEye SuperStock 6.2'],
    2023: ['R/T 5.7', 'R/T ScatPack 6.4', 'R/T ScatPack WideBody 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat RedEye SuperStock 6.2', 'SRT Demon 170 6.2'],
  },
  DURANGO: {
    2021: ['SRT HellCat 6.2'], 2023: ['SRT HellCat 6.2'], 2024: ['SRT HellCat 6.2'],
    2025: ['SRT HellCat 6.2'], 2026: ['SRT HellCat 6.2'],
  },
  CAMARO: {
    2010: ['SS 6.2', 'SS 1LE 6.2'],
    2011: ['SS 6.2', 'SS 1LE 6.2'],
    2012: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2 SC'],
    2013: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2 SC'],
    2014: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2 SC', 'Z/28 7.0'],
    2015: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2 SC', 'Z/28 7.0'],
    2016: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2'],
    2017: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2018: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2019: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2020: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2021: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2022: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2023: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
    2024: ['LT1 6.2', 'SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2', 'ZL1 1LE 6.2'],
  },
  CORVETTE: {
    2005: ['Base 6.0'],
    2006: ['Base 6.0', 'Z06 7.0'],
    2007: ['Base 6.0', 'Z06 7.0'],
    2008: ['Base 6.2', 'Z06 7.0'],
    2009: ['Base 6.2', 'Z06 7.0', 'ZR1 6.2 SC'],
    2010: ['Base 6.2', 'Grand Sport 6.2', 'Z06 7.0', 'ZR1 6.2 SC'],
    2011: ['Base 6.2', 'Grand Sport 6.2', 'Z06 7.0', 'ZR1 6.2 SC'],
    2012: ['Base 6.2', 'Grand Sport 6.2', 'Z06 7.0', 'ZR1 6.2 SC'],
    2013: ['Base 6.2', 'Grand Sport 6.2', 'Z06 7.0', 'ZR1 6.2 SC'],
    2014: ['Stingray 6.2'],
    2015: ['Stingray 6.2', 'Z06 6.2'],
    2016: ['Stingray 6.2', 'Z06 6.2'],
    2017: ['Stingray 6.2', 'Grand Sport 6.2', 'Z06 6.2'],
    2018: ['Stingray 6.2', 'Grand Sport 6.2', 'Z06 6.2'],
    2019: ['Stingray 6.2', 'Grand Sport 6.2', 'Z06 6.2', 'ZR1 6.2'],
    2020: ['Stingray 6.2'],
    2021: ['Stingray 6.2'],
    2022: ['Stingray 6.2'],
    2023: ['Stingray 6.2', 'Z06 5.5'],
    2024: ['Stingray 6.2', 'Z06 5.5', 'E-Ray 6.2'],
    2025: ['Stingray 6.2', 'Z06 5.5', 'E-Ray 6.2', 'ZR1 5.5TT'],
    2026: ['Stingray 6.2', 'Z06 5.5', 'E-Ray 6.2', 'ZR1 5.5TT'],
  },
  '1500': {
    2009: ['1500 5.7'], 2015: ['1500 5.7', '1500 Rebel 5.7'], 2016: ['1500 5.7', '1500 Rebel 5.7'],
    2017: ['1500 5.7', '1500 Rebel 5.7'], 2018: ['1500 5.7', '1500 Rebel 5.7'],
  },
  F150: {
    2017: ['SuperSnake 5.0L SC'],
    2018: ['SuperSnake 5.0L SC', '5.0L V8'],
    2019: ['SuperSnake 5.0L SC', '5.0L V8'],
    2020: ['SuperSnake 5.0L SC', '5.0L V8'],
    2021: ['SuperSnake 5.0L SC', '5.0L V8'],
    2022: ['SuperSnake 5.0L SC', '5.0L V8'],
    2023: ['SuperSnake 5.0L SC', '5.0L V8', '5.2L SC V8 Raptor R'],
    2024: ['SuperSnake 5.0L SC', '5.0L V8', '5.2L SC V8 Raptor R'],
    2025: ['SuperSnake 5.0L SC', '5.0L V8', '5.2L SC V8 Raptor R'],
    2026: ['SuperSnake 5.0L SC', '5.0L V8', '5.2L SC V8 Raptor R'],
  },
  MUSTANG: {
    2015: ['GT 5.0'],
    2016: ['GT 5.0', 'Shelby GT350 5.2', 'Shelby GT350R 5.2'],
    2017: ['GT 5.0', 'Shelby GT350 5.2', 'Shelby GT350R 5.2'],
    2018: ['GT 5.0', 'Shelby GT350 5.2'],
    2019: ['GT 5.0', 'Bullitt 5.0', 'Shelby GT350 5.2', 'Shelby GT350R 5.2'],
    2020: ['GT 5.0', 'Bullitt 5.0', 'Shelby GT350 5.2', 'Shelby GT350R 5.2', 'Shelby GT500 5.2 SC'],
    2021: ['GT 5.0', 'Mach 1 5.0', 'Shelby GT500 5.2 SC'],
    2022: ['GT 5.0', 'Mach 1 5.0', 'Shelby GT500 5.2 SC'],
    2023: ['GT 5.0', 'Mach 1 5.0'],
    2024: ['GT 5.0', 'Dark Horse 5.0'],
    2025: ['GT 5.0', 'Dark Horse 5.0', 'GTD 5.2 SC'],
    2026: ['GT 5.0', 'Dark Horse 5.0', 'Dark Horse SC 5.2 SC', 'GTD 5.2 SC'],
  },
}

export const specialEditions: Record<string, string[]> = {
  '2010-CAMARO-SS 6.2': ['None', 'Synergy Green Edition', 'Transformers Edition', 'Indy Pace Car Edition'],
  '2010-CAMARO-SS 1LE 6.2': ['None', 'Synergy Green Edition', 'Transformers Edition', 'Indy Pace Car Edition'],
  '2011-CAMARO-SS 6.2': ['None', 'Neiman Marcus Edition', 'Synergy Series'],
  '2011-CAMARO-SS 1LE 6.2': ['None', 'Synergy Series'],
  '2012-CAMARO-SS 6.2': ['None', '45th Anniversary', 'Transformers Edition', 'Honor and Valor Edition'],
  '2012-CAMARO-SS 1LE 6.2': ['None', '45th Anniversary'],
  '2012-CAMARO-ZL1 6.2 SC': ['None', '45th Anniversary'],
  '2013-CAMARO-SS 6.2': ['None', 'Dusk Edition', 'Hot Wheels Edition'],
  '2013-CAMARO-SS 1LE 6.2': ['None', 'Hot Wheels Edition'],
  '2014-CAMARO-SS 6.2': ['None', 'Spring Edition'],
  '2015-CAMARO-SS 6.2': ['None', 'Green Flash Edition', 'Commemorative Edition'],
  '2015-CAMARO-SS 1LE 6.2': ['None', 'Green Flash Edition'],
  '2024-CAMARO-LT1 6.2': ['None', 'Panther Collector Edition'],
  '2024-CAMARO-SS 6.2': ['None', 'Panther Collector Edition'],
  '2024-CAMARO-ZL1 6.2': ['None', 'Panther Collector Edition'],
  '2023-CORVETTE-Stingray 6.2': ['None', '70th Anniversary'],
  '2023-CORVETTE-Z06 5.5': ['None', '70th Anniversary'],
  // Corvette C6 (2005-2013) special editions.
  '2007-CORVETTE-Z06 7.0': ['None', 'Ron Fellows ALMS GT1 Edition'],
  '2008-CORVETTE-Z06 7.0': ['None', '427 Limited Edition'],
  '2009-CORVETTE-Z06 7.0': ['None', 'GT1 Championship Edition'],
  '2011-CORVETTE-Z06 7.0': ['None', 'Carbon Limited Edition'],
  '2012-CORVETTE-Base 6.2': ['None', 'Centennial Edition'],
  '2012-CORVETTE-Grand Sport 6.2': ['None', 'Centennial Edition'],
  '2012-CORVETTE-Z06 7.0': ['None', 'Centennial Edition'],
  '2012-CORVETTE-ZR1 6.2 SC': ['None', 'Centennial Edition'],
  '2013-CORVETTE-Base 6.2': ['None', '60th Anniversary'],
  '2013-CORVETTE-Grand Sport 6.2': ['None', '60th Anniversary'],
  '2013-CORVETTE-Z06 7.0': ['None', '60th Anniversary', '427 Collector Edition'],
  '2013-CORVETTE-ZR1 6.2 SC': ['None', '60th Anniversary'],
  // Charger LX/LD V8 special editions (appearance/limited packages on base trims).
  '2006-CHARGER-R/T 5.7': ['None', 'Daytona R/T'],
  '2007-CHARGER-R/T 5.7': ['None', 'Daytona R/T'],
  '2007-CHARGER-SRT8 6.1': ['None', 'Super Bee'],
  '2008-CHARGER-SRT8 6.1': ['None', 'Super Bee'],
  '2009-CHARGER-R/T 5.7': ['None', 'Daytona R/T'],
  '2012-CHARGER-SRT8 6.4': ['None', 'Super Bee'],
  '2013-CHARGER-R/T 5.7': ['None', 'Daytona'],
  '2013-CHARGER-SRT8 6.4': ['None', 'Super Bee'],
  '2014-CHARGER-R/T 5.7': ['None', 'Daytona'],
  '2014-CHARGER-SRT8 6.4': ['None', 'Super Bee'],
  '2017-CHARGER-R/T 5.7': ['None', 'Daytona'],
  '2017-CHARGER-ScatPack 6.4': ['None', 'Daytona 392'],
  '2018-CHARGER-R/T 5.7': ['None', 'Daytona'],
  '2018-CHARGER-ScatPack 6.4': ['None', 'Daytona 392'],
  // Challenger V8 special editions (appearance/limited packages on base trims).
  '2012-CHALLENGER-SRT8 6.4': ['None', 'Yellow Jacket'],
  '2014-CHALLENGER-R/T 5.7': ['None', 'Shaker', '100th Anniversary'],
  '2014-CHALLENGER-SRT8 6.4': ['None', 'Shaker'],
  '2015-CHALLENGER-R/T ScatPack 6.4': ['None', 'Shaker'],
  '2016-CHALLENGER-R/T ScatPack 6.4': ['None', 'Shaker'],
  '2017-CHALLENGER-R/T 5.7': ['None', 'T/A'],
  '2017-CHALLENGER-R/T ScatPack 6.4': ['None', 'T/A 392', 'Shaker'],
  '2018-CHALLENGER-R/T 5.7': ['None', 'T/A'],
  '2018-CHALLENGER-R/T ScatPack 6.4': ['None', 'T/A 392', 'Shaker'],
  '2019-CHALLENGER-R/T 5.7': ['None', 'T/A'],
  '2019-CHALLENGER-R/T ScatPack 6.4': ['None', '1320', 'T/A 392', 'Shaker'],
  '2020-CHALLENGER-R/T 5.7': ['None', 'T/A', '50th Anniversary'],
  '2020-CHALLENGER-R/T ScatPack 6.4': ['None', 'T/A 392', 'Shaker', '50th Anniversary'],
  '2021-CHALLENGER-R/T 5.7': ['None', 'T/A'],
  '2021-CHALLENGER-R/T ScatPack 6.4': ['None', 'T/A 392', 'Shaker'],
  '2022-CHALLENGER-R/T 5.7': ['None', 'T/A'],
  '2022-CHALLENGER-R/T ScatPack 6.4': ['None', 'T/A 392', 'Shaker'],
  '2023-CHALLENGER-R/T ScatPack 6.4': ['None', 'Swinger', 'Shakedown', 'Mopar Edition', 'T/A', 'Shaker'],
  '2023-CHALLENGER-R/T ScatPack WideBody 6.4': ['None', 'Swinger', 'Shakedown', 'Mopar Edition', 'T/A', 'Shaker'],
  '2023-CHALLENGER-SRT HellCat 6.2': ['None', 'Black Ghost', 'JailBreak'],
  '2023-CHALLENGER-SRT HellCat WideBody 6.2': ['None', 'Black Ghost', 'JailBreak'],
  '2023-CHALLENGER-SRT HellCat RedEye 6.2': ['None', 'JailBreak'],
  '2023-CHALLENGER-SRT HellCat RedEye WideBody 6.2': ['None', 'JailBreak'],
  '2023-CHARGER-ScatPack 6.4': ['None', 'Super Bee'],
  '2023-CHARGER-ScatPack WideBody 6.4': ['None', 'Super Bee'],
  '2023-CHARGER-SRT HellCat RedEye 6.2': ['None', 'King Daytona', 'Daytona', 'JailBreak'],
  '2023-CHARGER-SRT HellCat RedEye WideBody 6.2': ['None', 'King Daytona', 'Daytona', 'JailBreak'],
  '2025-DURANGO-SRT HellCat 6.2': ['None', 'Silver Bullet', 'Hammerhead', 'Brass Monkey'],
  '2026-DURANGO-SRT HellCat 6.2': ['None', 'JailBreak'],
  // Ford Mustang (S550 2015-2023, S650 2024-2026) — appearance / limited packages.
  '2015-MUSTANG-GT 5.0': ['None', '50 Years Limited Edition'],
  '2017-MUSTANG-GT 5.0': ['None', 'California Special'],
  '2019-MUSTANG-GT 5.0': ['None', 'California Special'],
  '2020-MUSTANG-GT 5.0': ['None', 'California Special'],
  '2020-MUSTANG-Shelby GT350 5.2': ['None', 'Heritage Edition'],
  '2020-MUSTANG-Shelby GT350R 5.2': ['None', 'Heritage Edition'],
  '2020-MUSTANG-Shelby GT500 5.2 SC': ['None', 'Carbon Fiber Track Pack'],
  '2021-MUSTANG-Mach 1 5.0': ['None', 'Handling Package'],
  '2021-MUSTANG-Shelby GT500 5.2 SC': ['None', 'Carbon Fiber Track Pack'],
  '2022-MUSTANG-GT 5.0': ['None', 'California Special', 'Ice White Edition'],
  '2022-MUSTANG-Mach 1 5.0': ['None', 'Handling Package'],
  '2022-MUSTANG-Shelby GT500 5.2 SC': ['None', 'Heritage Edition', 'Carbon Fiber Track Pack'],
  '2023-MUSTANG-GT 5.0': ['None', 'California Special'],
  '2023-MUSTANG-Mach 1 5.0': ['None', 'Handling Package'],
  '2024-MUSTANG-GT 5.0': ['None', 'California Special'],
  '2024-MUSTANG-Dark Horse 5.0': ['None', 'Appearance Package', 'Handling Package'],
  '2025-MUSTANG-GT 5.0': ['None', '60th Anniversary', 'California Special'],
  '2025-MUSTANG-Dark Horse 5.0': ['None', 'Appearance Package', 'Handling Package'],
  '2026-MUSTANG-Dark Horse 5.0': ['None', 'Appearance Package'],
}

const moparColors = ['B5 Blue', 'Destroyer Gray', 'F8 Green', 'Frostbite', 'Go Mango', 'Granite', 'Octane Red', 'Pitch Black', 'Plum Crazy', 'Sinamon Stick', 'Sublime', 'TorRed', 'Triple Nickel', 'White Knuckle']
const ramColors = ['Black', 'Bright White', 'Brilliant Black Crystal', 'Bright Silver Metallic', 'Deep Cherry Red Crystal', 'Maximum Steel Metallic', 'Granite Crystal Metallic', 'True Blue Pearl', 'Western Brown', 'Flame Red']
const fordColors = ['Agate Black', 'Oxford White', 'Star White', 'Rapid Red', 'Antimatter Blue', 'Atlas Blue', 'Carbonized Gray', 'Iconic Silver', 'Velocity Blue', 'Lead Foot', 'Magma Red', 'Shadow Black']
const durangoColors = ['Billet Silver', 'DB Black', 'Destroyer Gray', 'F8 Green', 'Granite Crystal', 'In-Violet', 'Octane Red', 'Reactor Blue', 'Redline', 'Vice White', 'White Knuckle']
const durangoColors2026 = ['Destroyer Gray', 'Diamond Black', 'Octane Red', 'Vapor Gray', 'White Knuckle']
const durangoColors2026JailBreak = ['Destroyer Gray', 'Diamond Black', 'Green Machine', 'Octane Red', 'Vapor Gray', 'White Knuckle']
const raptorRColors = ['Agate Black', 'Oxford White', 'Rapid Red', 'Atlas Blue', 'Carbonized Gray', 'Iconic Silver']
// Land Rover Defender colours (classic era — a representative selection).
const landRoverDefenderColors = ['Fuji White', 'Alaska White', 'Santorini Black', 'Corris Grey', 'Bonatti Grey', 'Stornoway Grey', 'Indus Silver', 'Keswick Green', 'Coniston Green', 'Epsom Green', 'Galway Green', 'Tamar Blue', 'Firenze Red', 'Yulong White']

// ── Land Rover Defender (classic / "original" Defender, 1990–2016, + 2018 Works V8) ──
// Wheelbase (90 / 110 / 130) × the engine of each era, plus the well-known limited
// editions. Injected into the year-keyed catalog maps (cars are shared across apps).
const defenderEngines = (y: number): string[] =>
  y <= 1994 ? ['200Tdi', 'V8 3.5']
    : y <= 1998 ? ['300Tdi', 'V8 3.9']
    : y <= 2006 ? ['Td5']
    : y <= 2011 ? ['2.4 TDCi']
    : ['2.2 TDCi']
for (let y = 1990; y <= 2016; y++) {
  if (!years.includes(y)) years.push(y)
  manufacturersByYear[y] = manufacturersByYear[y] || []
  if (!manufacturersByYear[y].includes('LAND ROVER')) manufacturersByYear[y].push('LAND ROVER')
  brandsByManufacturerAndYear['LAND ROVER'] = brandsByManufacturerAndYear['LAND ROVER'] || {}
  brandsByManufacturerAndYear['LAND ROVER'][y] = ['LAND ROVER']
  modelsByBrandAndYear['LAND ROVER'] = modelsByBrandAndYear['LAND ROVER'] || {}
  modelsByBrandAndYear['LAND ROVER'][y] = ['DEFENDER']
  versionsByModelAndYear['DEFENDER'] = versionsByModelAndYear['DEFENDER'] || {}
  versionsByModelAndYear['DEFENDER'][y] = ['90', '110', '130'].flatMap((wb) => defenderEngines(y).map((e) => `${wb} ${e}`))
}
// 2018 Works V8 70th — limited Land Rover Classic build on the classic Defender body.
manufacturersByYear[2018] = manufacturersByYear[2018] || []
if (!manufacturersByYear[2018].includes('LAND ROVER')) manufacturersByYear[2018].push('LAND ROVER')
brandsByManufacturerAndYear['LAND ROVER'][2018] = ['LAND ROVER']
modelsByBrandAndYear['LAND ROVER'][2018] = ['DEFENDER']
versionsByModelAndYear['DEFENDER'][2018] = ['90 V8 5.0', '110 V8 5.0']
years.sort((a, b) => a - b)
// Limited / special editions — each built ON a base wheelbase+engine version.
Object.assign(specialEditions, {
  '1998-DEFENDER-90 V8 3.9': ['None', '50th Anniversary'],
  '2001-DEFENDER-90 Td5': ['None', 'Tomb Raider'],
  '2001-DEFENDER-110 Td5': ['None', 'Tomb Raider'],
  '2003-DEFENDER-110 Td5': ['None', 'G4 Challenge'],
  '2008-DEFENDER-90 2.4 TDCi': ['None', 'SVX 60th Anniversary'],
  '2008-DEFENDER-110 2.4 TDCi': ['None', 'SVX 60th Anniversary'],
  '2015-DEFENDER-90 2.2 TDCi': ['None', 'Heritage', 'Adventure', 'Autobiography'],
  '2015-DEFENDER-110 2.2 TDCi': ['None', 'Heritage', 'Adventure', 'Autobiography'],
  '2016-DEFENDER-90 2.2 TDCi': ['None', 'Heritage', 'Adventure', 'Autobiography'],
  '2016-DEFENDER-110 2.2 TDCi': ['None', 'Heritage', 'Adventure', 'Autobiography'],
  '2018-DEFENDER-90 V8 5.0': ['None', 'Works V8 70th'],
  '2018-DEFENDER-110 V8 5.0': ['None', 'Works V8 70th'],
})

const viperColorsByYear: Record<number, string[]> = {
  1992: ['Red'],
  1993: ['Red', 'Black', 'White'],
  1994: ['Red', 'Black', 'White', 'Emerald Green', 'Dandelion Yellow'],
  1995: ['Red', 'Black', 'White', 'Emerald Green', 'Dandelion Yellow'],
}

const classicChargerColorsByYear: Record<number, string[]> = {
  1968: ['Silver', 'Black', 'Medium Blue', 'Pale Blue', 'Dark Blue', 'Light Green', 'Racing Green', 'Light Gold', 'Medium Gold', 'Light Turquoise', 'Dark Turquoise', 'Bronze', 'Matador Red', 'Bright Blue', 'Burgundy', 'Sunfire Yellow', 'Avocado Green', 'White', 'Beige', 'Sierra Tan', 'Charger Red', 'Hawaiian Blue', 'Dark Green'],
  1969: ['B5 Blue', 'Black', 'Charger Red', 'F8 Green', 'White', 'Silver', 'Dark Green', 'Medium Blue', 'Bahama Yellow', 'Hemi Orange', 'Turquoise', 'Burgundy', 'Light Gold', 'Bronze'],
  1970: ['Black', 'White', 'Silver', 'B5 Blue', 'Dark Blue', 'F8 Green', 'Go Mango', 'Sublime', 'Plum Crazy', 'Hemi Orange', 'Banana', 'Green Go', 'Panther Pink', 'Butterscotch', 'Bronze', 'Rallye Red', 'Dark Tan'],
}

// LX Charger (2006-2010) factory paint by year.
const lxChargerColorsByYear: Record<number, string[]> = {
  2006: ['Brilliant Black', 'Bright Silver', 'Silver Steel', 'Cool Vanilla', 'Stone White', 'Inferno Red', 'Midnight Blue', 'Magnesium'],
  2007: ['Brilliant Black', 'Bright Silver', 'Cool Vanilla', 'Stone White', 'Inferno Red', 'TorRed', 'Steel Blue', 'Detonator Yellow'],
  2008: ['Brilliant Black', 'Bright Silver', 'Stone White', 'Inferno Red', 'TorRed', 'Steel Blue', 'HEMI Orange', 'B5 Blue', 'Detonator Yellow', 'Sub Lime'],
  2009: ['Brilliant Black', 'Bright Silver', 'Stone White', 'Inferno Red', 'TorRed', 'Steel Blue', 'HEMI Orange', 'Sub Lime', 'Deep Water Blue'],
  2010: ['Brilliant Black', 'Bright Silver', 'Stone White', 'Inferno Red', 'TorRed', 'Steel Blue', 'HEMI Orange', 'Deep Water Blue'],
}

// LD Charger (2011-2017) factory paint by year.
const ldChargerColorsByYear: Record<number, string[]> = {
  2011: ['Pitch Black', 'Bright Silver', 'Bright White', 'Tungsten Metallic', 'Redline Red', 'Blackberry', 'Toxic Orange', 'Deep Water Blue', 'Sapphire Blue'],
  2012: ['Pitch Black', 'Bright Silver', 'Bright White', 'Tungsten Metallic', 'Redline Red', 'Blackberry', 'Header Orange', 'Stinger Yellow', 'Blue Streak', 'Maximum Steel'],
  2013: ['Pitch Black', 'Billet Silver', 'Bright White', 'Granite Crystal', 'Redline Red', 'Maximum Steel', 'Header Orange', 'Jazz Blue', 'Phantom Black', 'Plum Crazy'],
  2014: ['Pitch Black', 'Billet Silver', 'Bright White', 'Granite Crystal', 'Redline Red', 'Maximum Steel', 'Header Orange', 'Jazz Blue', 'Phantom Black', 'High Octane Red', 'Plum Crazy'],
  2015: ['Pitch Black', 'Granite Crystal', 'Billet Silver', 'Bright White', 'Maximum Steel', 'TorRed', 'Redline Red', 'B5 Blue', 'Jazz Blue', 'Phantom Black', 'Go Mango'],
  2016: ['Pitch Black', 'Granite', 'Billet Silver', 'Bright White', 'Maximum Steel', 'TorRed', 'Redline Red', 'B5 Blue', 'Contusion Blue', 'Plum Crazy', 'Go Mango', 'Green Go'],
  2017: ['Pitch Black', 'Granite', 'Billet Silver', 'White Knuckle', 'Maximum Steel', 'TorRed', 'Octane Red', 'B5 Blue', 'Contusion Blue', 'Plum Crazy', 'Go Mango', 'Green Go', 'Yellow Jacket'],
}

// LC Challenger (2008-2014) factory paint by year.
const lcChallengerColorsByYear: Record<number, string[]> = {
  2008: ['Brilliant Black', 'Bright Silver', 'HEMI Orange', 'TorRed', 'Silver Steel', 'Steel Blue'],
  2009: ['Brilliant Black', 'Bright Silver', 'Stone White', 'Inferno Red', 'HEMI Orange', 'TorRed', 'Steel Blue', 'Detonator Yellow', 'B5 Blue', 'Sub Lime'],
  2010: ['Brilliant Black', 'Bright Silver', 'Stone White', 'Inferno Red', 'HEMI Orange', 'TorRed', 'Steel Blue', 'Detonator Yellow', 'B5 Blue', 'Plum Crazy', 'Furious Fuchsia'],
  2011: ['Pitch Black', 'Bright Silver', 'Bright White', 'Redline Red', 'Tungsten Metallic', 'Blackberry', 'Deep Water Blue', 'Toxic Orange'],
  2012: ['Pitch Black', 'Bright Silver', 'Bright White', 'Redline Red', 'Tungsten Metallic', 'Header Orange', 'Blue Streak', 'Stinger Yellow', 'Plum Crazy'],
  2013: ['Pitch Black', 'Billet Silver', 'Bright White', 'Granite Crystal', 'Redline Red', 'Header Orange', 'Jazz Blue', 'High Octane Red', 'Plum Crazy'],
  2014: ['Pitch Black', 'Billet Silver', 'Bright White', 'Granite Crystal', 'Redline Red', 'Header Orange', 'Jazz Blue', 'High Octane Red', 'Phantom Black', 'Sublime', 'Plum Crazy'],
}

// LA Challenger refresh (2015-2023) factory paint by year — Dodge's high-impact palette.
const challengerColorsByYear: Record<number, string[]> = {
  2015: ['Pitch Black', 'Granite Crystal', 'Billet Silver', 'Bright White', 'Maximum Steel', 'TorRed', 'Redline Red', 'B5 Blue', 'Jazz Blue', 'Sublime', 'Phantom Black', 'Go Mango', 'Plum Crazy'],
  2016: ['Pitch Black', 'Granite', 'Billet Silver', 'Bright White', 'Maximum Steel', 'TorRed', 'Redline Red', 'B5 Blue', 'Contusion Blue', 'Plum Crazy', 'Go Mango', 'Green Go', 'Yellow Jacket'],
  2017: ['Pitch Black', 'Granite', 'Billet Silver', 'White Knuckle', 'Maximum Steel', 'TorRed', 'Octane Red', 'B5 Blue', 'Contusion Blue', 'Plum Crazy', 'Go Mango', 'Green Go', 'Yellow Jacket'],
  2018: ['Pitch Black', 'Granite', 'Billet Silver', 'White Knuckle', 'Maximum Steel', 'TorRed', 'Octane Red', 'B5 Blue', 'IndiGo Blue', 'Plum Crazy', 'Go Mango', 'Green Go', 'F8 Green', 'Destroyer Gray'],
  2019: ['Pitch Black', 'Triple Nickel', 'White Knuckle', 'Granite', 'Maximum Steel', 'TorRed', 'Octane Red', 'B5 Blue', 'IndiGo Blue', 'Plum Crazy', 'Go Mango', 'F8 Green', 'Destroyer Gray', 'Frostbite'],
  2020: ['Pitch Black', 'Triple Nickel', 'White Knuckle', 'Granite', 'Hellraisin', 'TorRed', 'Octane Red', 'Frostbite', 'IndiGo Blue', 'Sinamon Stick', 'Go Mango', 'F8 Green', 'Destroyer Gray', 'Smoke Show'],
  2021: ['Pitch Black', 'Triple Nickel', 'White Knuckle', 'Granite', 'Hellraisin', 'TorRed', 'Octane Red', 'Frostbite', 'Gold Rush', 'Sinamon Stick', 'Go Mango', 'F8 Green', 'Destroyer Gray', 'Smoke Show'],
  2022: ['Pitch Black', 'Triple Nickel', 'White Knuckle', 'Granite', 'Sublime', 'TorRed', 'Octane Red', 'Frostbite', 'Plum Crazy', 'Sinamon Stick', 'Go Mango', 'F8 Green', 'Destroyer Gray', 'B5 Blue'],
  2023: ['Pitch Black', 'Triple Nickel', 'White Knuckle', 'Granite', 'Sublime', 'TorRed', 'Octane Red', 'Frostbite', 'Plum Crazy', 'Sinamon Stick', 'Go Mango', 'F8 Green', 'Destroyer Gray', 'B5 Blue'],
}

const gen5CamaroColorsByYear: Record<number, string[]> = {
  2010: ['Black', 'Silver Ice', 'Inferno Orange', 'Victory Red', 'Rally Yellow', 'Cyber Gray', 'Red Jewel', 'Imperial Blue', 'Aqua Blue', 'Synergy Green'],
  2011: ['Black', 'Silver Ice', 'Victory Red', 'Rally Yellow', 'Inferno Orange', 'Imperial Blue', 'Cyber Gray', 'Red Jewel', 'Aqua Blue', 'Synergy Green', 'Summit White'],
  2012: ['Black', 'Victory Red', 'Summit White', 'Silver Ice', 'Rally Yellow', 'Carbon Flash', 'Inferno Orange', 'Imperial Blue', 'Ashen Gray', 'Crystal Red'],
  2013: ['Black', 'Victory Red', 'Summit White', 'Silver Ice', 'Rally Yellow', 'Inferno Orange', 'Imperial Blue', 'Ashen Gray', 'Crystal Red', 'Blue Ray'],
  2014: ['Black', 'Victory Red', 'Summit White', 'Silver Ice', 'Rally Yellow', 'Inferno Orange', 'Blue Ray', 'Ashen Gray', 'Crystal Red', 'Reddish Orange'],
  2015: ['Black', 'Victory Red', 'Summit White', 'Silver Ice', 'Rally Yellow', 'Inferno Orange', 'Blue Ray', 'Ashen Gray', 'Crystal Red', 'Blue Velvet', 'Emerald Green'],
}

const gen6CamaroColorsByYear: Record<number, string[]> = {
  2016: ['Black', 'Summit White', 'Red Hot', 'Hyper Blue', 'Nightfall Gray', 'Mosaic Black', 'Bright Yellow', 'Garnet Red'],
  2017: ['Black', 'Summit White', 'Red Hot', 'Hyper Blue', 'Nightfall Gray', 'Mosaic Black', 'Bright Yellow', 'Garnet Red', 'Shock'],
  2018: ['Black', 'Summit White', 'Red Hot', 'Hyper Blue', 'Nightfall Gray', 'Mosaic Black', 'Bright Yellow', 'Garnet Red', 'Shock', 'Crush'],
  2019: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Mosaic Black', 'Shock', 'Crush', 'Garnet Red'],
  2020: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Mosaic Black', 'Shock', 'Crush', 'Wild Cherry'],
  2021: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Rapid Blue', 'Shock', 'Wild Cherry'],
  2022: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Rapid Blue', 'Shock', 'Wild Cherry', 'Radiant Red'],
  2023: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Rapid Blue', 'Shock', 'Wild Cherry', 'Radiant Red'],
  2024: ['Black', 'Summit White', 'Red Hot', 'Riverside Blue', 'Nightfall Gray', 'Rapid Blue', 'Vivid Orange', 'Wild Cherry', 'Radiant Red', 'Panther Black', 'Panther Matte Black'],
}

const corvetteColorsByYear: Record<number, string[]> = {
  2005: ['Arctic White', 'Black', 'Daytona Sunset Orange', 'LeMans Blue', 'Machine Silver', 'Magnetic Red', 'Millennium Yellow', 'Precision Red'],
  2006: ['Arctic White', 'Black', 'Daytona Sunset Orange', 'LeMans Blue', 'Machine Silver', 'Monterey Red', 'Velocity Yellow', 'Victory Red'],
  2007: ['Arctic White', 'Atomic Orange', 'Black', 'LeMans Blue', 'Machine Silver', 'Monterey Red', 'Velocity Yellow', 'Victory Red'],
  2008: ['Arctic White', 'Atomic Orange', 'Black', 'Crystal Red', 'Jetstream Blue', 'Machine Silver', 'Velocity Yellow', 'Victory Red'],
  2009: ['Arctic White', 'Atomic Orange', 'Black', 'Blade Silver', 'Crystal Red', 'Cyber Gray', 'Jetstream Blue', 'Velocity Yellow', 'Victory Red'],
  2010: ['Arctic White', 'Black', 'Blade Silver', 'Crystal Red', 'Cyber Gray', 'Inferno Orange', 'Jetstream Blue', 'Supersonic Blue', 'Torch Red', 'Velocity Yellow'],
  2011: ['Arctic White', 'Black', 'Blade Silver', 'Crystal Red', 'Cyber Gray', 'Inferno Orange', 'Jetstream Blue', 'Supersonic Blue', 'Torch Red', 'Velocity Yellow'],
  2012: ['Arctic White', 'Black', 'Blade Silver', 'Carlisle Blue', 'Crystal Red', 'Cyber Gray', 'Inferno Orange', 'Supersonic Blue', 'Torch Red', 'Velocity Yellow'],
  2013: ['Arctic White', 'Black', 'Blade Silver', 'Crystal Red', 'Cyber Gray', 'Laguna Blue', 'Night Race Blue', 'Torch Red', 'Velocity Yellow'],
  2014: ['Arctic White', 'Black', 'Blade Silver', 'Crystal Red', 'Cyber Gray', 'Laguna Blue', 'Lime Rock Green', 'Night Race Blue', 'Torch Red', 'Velocity Yellow'],
  2015: ['Arctic White', 'Black', 'Blade Silver', 'Crystal Red', 'Daytona Sunrise Orange', 'Laguna Blue', 'Night Race Blue', 'Shark Gray', 'Torch Red', 'Velocity Yellow'],
  2016: ['Admiral Blue', 'Arctic White', 'Black', 'Blade Silver', 'Corvette Racing Yellow', 'Daytona Sunrise Orange', 'Laguna Blue', 'Long Beach Red', 'Night Race Blue', 'Shark Gray', 'Torch Red'],
  2017: ['Admiral Blue', 'Arctic White', 'Black', 'Black Rose', 'Blade Silver', 'Corvette Racing Yellow', 'Long Beach Red', 'Sterling Blue', 'Torch Red', 'Watkins Glen Gray'],
  2018: ['Admiral Blue', 'Arctic White', 'Black', 'Black Rose', 'Blade Silver', 'Ceramic Matrix Gray', 'Corvette Racing Yellow', 'Long Beach Red', 'Sebring Orange', 'Torch Red', 'Watkins Glen Gray'],
  2019: ['Admiral Blue', 'Arctic White', 'Black', 'Blade Silver', 'Ceramic Gray', 'Corvette Yellow', 'Elkhart Blue', 'Long Beach Red', 'Sebring Orange', 'Shadow Gray', 'Torch Red', 'Watkins Glen Gray'],
  2020: ['Arctic White', 'Black', 'Accelerate Yellow', 'Blade Silver', 'Ceramic Matrix Gray', 'Elkhart Lake Blue', 'Long Beach Red', 'Rapid Blue', 'Sebring Orange', 'Shadow Gray', 'Torch Red', 'Zeus Bronze'],
  2021: ['Arctic White', 'Black', 'Accelerate Yellow', 'Ceramic Matrix Gray', 'Elkhart Lake Blue', 'Rapid Blue', 'Red Mist', 'Sebring Orange', 'Shadow Gray', 'Silver Flare', 'Torch Red', 'Zeus Bronze'],
  2022: ['Arctic White', 'Black', 'Accelerate Yellow', 'Amplify Orange', 'Caffeine', 'Ceramic Matrix Gray', 'Elkhart Lake Blue', 'Hypersonic Gray', 'Rapid Blue', 'Red Mist', 'Silver Flare', 'Torch Red'],
  2023: ['Arctic White', 'Black', 'Accelerate Yellow', 'Amplify Orange', 'Carbon Flash', 'Caffeine', 'Ceramic Matrix Gray', 'Elkhart Lake Blue', 'Hypersonic Gray', 'Rapid Blue', 'Red Mist', 'Silver Flare', 'Torch Red', 'White Pearl'],
  2024: ['Arctic White', 'Black', 'Accelerate Yellow', 'Amplify Orange', 'Cacti Green', 'Carbon Flash', 'Ceramic Matrix Gray', 'Elkhart Lake Blue', 'Hypersonic Gray', 'Rapid Blue', 'Red Mist', 'Silver Flare', 'Torch Red'],
  2025: ['Arctic White', 'Black', 'Competition Yellow', 'Hysteria Purple', 'Rapid Blue', 'Red Mist', 'Riptide Blue', 'Sebring Orange', 'Silver Flare', 'Torch Red'],
  2026: ['Admiral Blue', 'Arctic White', 'Black', 'Blade Silver', 'Competition Yellow', 'Hysteria Purple', 'Rapid Blue', 'Red Mist', 'Riptide Blue', 'Roswell Green', 'Sebring Orange', 'Torch Red'],
}

const mustangColorsByYear: Record<number, string[]> = {
  2015: ['Oxford White', 'Shadow Black', 'Ingot Silver', 'Magnetic', 'Guard', 'Race Red', 'Ruby Red', 'Competition Orange', 'Deep Impact Blue', 'Triple Yellow'],
  2016: ['Oxford White', 'Shadow Black', 'Ingot Silver', 'Magnetic', 'Avalanche Gray', 'Guard', 'Race Red', 'Ruby Red', 'Competition Orange', 'Deep Impact Blue', 'Triple Yellow'],
  2017: ['Oxford White', 'White Platinum', 'Shadow Black', 'Ingot Silver', 'Magnetic', 'Avalanche Gray', 'Race Red', 'Ruby Red', 'Lightning Blue', 'Grabber Blue', 'Triple Yellow'],
  2018: ['Oxford White', 'Shadow Black', 'Ingot Silver', 'Magnetic', 'Lead Foot Gray', 'Race Red', 'Ruby Red', 'Lightning Blue', 'Kona Blue', 'Royal Crimson', 'Orange Fury', 'Triple Yellow'],
  2019: ['Oxford White', 'Shadow Black', 'Ingot Silver', 'Magnetic', 'Race Red', 'Ruby Red', 'Velocity Blue', 'Kona Blue', 'Need for Green', 'Orange Fury', 'Dark Highland Green', 'Triple Yellow'],
  2020: ['Oxford White', 'Shadow Black', 'Iconic Silver', 'Magnetic', 'Race Red', 'Velocity Blue', 'Kona Blue', 'Grabber Lime', 'Twister Orange', 'Rapid Red', 'Dark Highland Green'],
  2021: ['Oxford White', 'Shadow Black', 'Iconic Silver', 'Carbonized Gray', 'Race Red', 'Velocity Blue', 'Antimatter Blue', 'Grabber Yellow', 'Rapid Red', 'Fighter Jet Gray'],
  2022: ['Oxford White', 'Shadow Black', 'Iconic Silver', 'Carbonized Gray', 'Dark Matter Gray', 'Race Red', 'Grabber Blue', 'Brittany Blue', 'Atlas Blue', 'Eruption Green', 'Cyber Orange', 'Mischievous Purple'],
  2023: ['Oxford White', 'Shadow Black', 'Iconic Silver', 'Carbonized Gray', 'Dark Matter Gray', 'Race Red', 'Grabber Blue', 'Brittany Blue', 'Atlas Blue', 'Eruption Green', 'Mischievous Purple'],
  2024: ['Oxford White', 'Shadow Black', 'Iconic Silver', 'Carbonized Gray', 'Dark Matter Gray', 'Race Red', 'Rapid Red', 'Grabber Blue', 'Atlas Blue', 'Vapor Blue', 'Yellow Splash', 'Blue Ember'],
  2025: ['Oxford White', 'Wimbledon White', 'Shadow Black', 'Iconic Silver', 'Carbonized Gray', 'Race Red', 'Grabber Blue', 'Vapor Blue', 'Molten Magenta', 'Intense Lime Yellow', 'Blue Ember', 'Indulgent Blue'],
  2026: ['Oxford White', 'Shadow Black', 'Carbonized Gray', 'Iconic Silver', 'Race Red', 'Grabber Blue', 'Vapor Blue', 'Adriatic Blue', 'Orange Fury', 'Molten Magenta', 'Blue Ember'],
}

const colorsByConfiguration: Record<string, string[]> = {
  '2010-CAMARO-SS 6.2-Synergy Green Edition': ['Synergy Green'],
  '2010-CAMARO-SS 1LE 6.2-Synergy Green Edition': ['Synergy Green'],
  '2010-CAMARO-SS 6.2-Transformers Edition': ['Rally Yellow'],
  '2010-CAMARO-SS 1LE 6.2-Transformers Edition': ['Rally Yellow'],
  '2010-CAMARO-SS 6.2-Indy Pace Car Edition': ['Silver Ice', 'Inferno Orange'],
  '2011-CAMARO-SS 6.2-Neiman Marcus Edition': ['Deep Bordeaux'],
  '2011-CAMARO-SS 6.2-Synergy Series': ['Summit White', 'Black', 'Victory Red'],
  '2011-CAMARO-SS 1LE 6.2-Synergy Series': ['Summit White', 'Black', 'Victory Red'],
  '2012-CAMARO-SS 6.2-45th Anniversary': ['Carbon Flash'],
  '2012-CAMARO-SS 1LE 6.2-45th Anniversary': ['Carbon Flash'],
  '2012-CAMARO-ZL1 6.2 SC-45th Anniversary': ['Carbon Flash'],
  '2012-CAMARO-SS 6.2-Transformers Edition': ['Rally Yellow'],
  '2012-CAMARO-SS 6.2-Honor and Valor Edition': ['Summit White', 'Black'],
  '2013-CAMARO-SS 6.2-Dusk Edition': ['Black'],
  '2013-CAMARO-SS 6.2-Hot Wheels Edition': ['Rally Yellow'],
  '2013-CAMARO-SS 1LE 6.2-Hot Wheels Edition': ['Rally Yellow'],
  '2014-CAMARO-SS 6.2-Spring Edition': ['Summit White'],
  '2015-CAMARO-SS 6.2-Green Flash Edition': ['Emerald Green'],
  '2015-CAMARO-SS 1LE 6.2-Green Flash Edition': ['Emerald Green'],
  '2015-CAMARO-SS 6.2-Commemorative Edition': ['Rally Yellow', 'Black'],
  '2024-CAMARO-LT1 6.2-Panther Collector Edition': ['Panther Matte Black'],
  '2024-CAMARO-SS 6.2-Panther Collector Edition': ['Panther Matte Black'],
  '2024-CAMARO-ZL1 6.2-Panther Collector Edition': ['Panther Matte Black'],
  '2023-CORVETTE-Stingray 6.2-70th Anniversary': ['White Pearl', 'Carbon Flash'],
  '2023-CORVETTE-Z06 5.5-70th Anniversary': ['White Pearl', 'Carbon Flash'],
  // Corvette C6 special-edition forced colors.
  '2007-CORVETTE-Z06 7.0-Ron Fellows ALMS GT1 Edition': ['Arctic White'],
  '2008-CORVETTE-Z06 7.0-427 Limited Edition': ['Crystal Red', 'Arctic White', 'Black'],
  '2009-CORVETTE-Z06 7.0-GT1 Championship Edition': ['Velocity Yellow', 'Black'],
  '2011-CORVETTE-Z06 7.0-Carbon Limited Edition': ['Supersonic Blue', 'Inferno Orange'],
  '2012-CORVETTE-Base 6.2-Centennial Edition': ['Carbon Flash'],
  '2012-CORVETTE-Grand Sport 6.2-Centennial Edition': ['Carbon Flash'],
  '2012-CORVETTE-Z06 7.0-Centennial Edition': ['Carbon Flash'],
  '2012-CORVETTE-ZR1 6.2 SC-Centennial Edition': ['Carbon Flash'],
  '2013-CORVETTE-Base 6.2-60th Anniversary': ['Arctic White'],
  '2013-CORVETTE-Grand Sport 6.2-60th Anniversary': ['Arctic White'],
  '2013-CORVETTE-Z06 7.0-60th Anniversary': ['Arctic White'],
  '2013-CORVETTE-ZR1 6.2 SC-60th Anniversary': ['Arctic White'],
  '2023-CHALLENGER-R/T ScatPack 6.4-Swinger': ['Sublime', 'F8 Green', 'White Knuckle'],
  '2023-CHALLENGER-R/T ScatPack WideBody 6.4-Swinger': ['Sublime', 'F8 Green', 'White Knuckle'],
  '2023-CHARGER-SRT HellCat RedEye 6.2-King Daytona': ['Go Mango'],
  '2023-CHARGER-SRT HellCat RedEye WideBody 6.2-King Daytona': ['Go Mango'],
  '2025-DURANGO-SRT HellCat 6.2-Silver Bullet': ['Triple Nickel'],
  '2025-DURANGO-SRT HellCat 6.2-Hammerhead': ['Hammerhead Gray'],
  '2025-DURANGO-SRT HellCat 6.2-Brass Monkey': ['Red Oxide'],
  '2026-DURANGO-SRT HellCat 6.2-None': durangoColors2026,
  '2026-DURANGO-SRT HellCat 6.2-JailBreak': durangoColors2026JailBreak,
  '2023-F150-5.2L SC V8 Raptor R-None': raptorRColors,
  '2024-F150-5.2L SC V8 Raptor R-None': raptorRColors,
  '2025-F150-5.2L SC V8 Raptor R-None': raptorRColors,
  '2026-F150-5.2L SC V8 Raptor R-None': raptorRColors,
  // Mustang editions / versions with a forced or exclusive color set.
  '2015-MUSTANG-GT 5.0-50 Years Limited Edition': ['Wimbledon White', 'Kona Blue'],
  '2019-MUSTANG-Bullitt 5.0-None': ['Dark Highland Green', 'Shadow Black'],
  '2020-MUSTANG-Bullitt 5.0-None': ['Dark Highland Green', 'Shadow Black'],
  '2020-MUSTANG-Shelby GT350 5.2-Heritage Edition': ['Wimbledon White'],
  '2020-MUSTANG-Shelby GT350R 5.2-Heritage Edition': ['Wimbledon White'],
  '2022-MUSTANG-GT 5.0-Ice White Edition': ['Oxford White'],
  '2022-MUSTANG-Shelby GT500 5.2 SC-Heritage Edition': ['Brittany Blue'],
  '2025-MUSTANG-GT 5.0-60th Anniversary': ['Race Red', 'Vapor Blue', 'Wimbledon White', 'Brittany Blue'],
}

export function getAvailableColors(year: number, brand: string, model: string, version: string, specialEdition: string): string[] {
  const key = `${year}-${model}-${version}-${specialEdition}`
  if (colorsByConfiguration[key]) return colorsByConfiguration[key]
  if (model === 'DEFENDER') return landRoverDefenderColors
  if (model === 'CAMARO' && gen5CamaroColorsByYear[year]) return gen5CamaroColorsByYear[year]
  if (model === 'CAMARO' && gen6CamaroColorsByYear[year]) return gen6CamaroColorsByYear[year]
  if (model === 'CHARGER' && classicChargerColorsByYear[year]) return classicChargerColorsByYear[year]
  if (model === 'CHARGER' && lxChargerColorsByYear[year]) return lxChargerColorsByYear[year]
  if (model === 'CHARGER' && ldChargerColorsByYear[year]) return ldChargerColorsByYear[year]
  if (model === 'CHALLENGER' && lcChallengerColorsByYear[year]) return lcChallengerColorsByYear[year]
  if (model === 'CHALLENGER' && challengerColorsByYear[year]) return challengerColorsByYear[year]
  if (model === 'VIPER' && viperColorsByYear[year]) return viperColorsByYear[year]
  if (model === 'CORVETTE' && corvetteColorsByYear[year]) return corvetteColorsByYear[year]
  if (model === 'MUSTANG' && mustangColorsByYear[year]) return mustangColorsByYear[year]
  if (model === 'DURANGO' && year === 2026) return durangoColors2026
  if (model === 'DURANGO') return durangoColors
  if (brand === 'RAM') return ramColors
  if (brand === 'FORD') return fordColors
  return moparColors
}

// carData export for compatibility with new/edit ride pages
export const carData: Record<string, Record<string, Record<string, string[]>>> = {
  MOPAR: {
    DODGE: {
      CHARGER: ['Base 5.2 V8', 'R/T 6.3 V8', 'R/T 7.0 V8 HEMI', '500 6.3 V8', 'Daytona 6.6 V8', 'Daytona 7.0 V8 HEMI', 'R/T 7.2 V8', 'R/T 5.7', 'SRT8 6.1', 'SRT8 6.4', 'ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2', 'ScatPack WideBody 6.4', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat WideBody 6.2'],
      CHALLENGER: ['SRT8 6.1', 'SRT8 6.4', 'R/T 5.7', 'R/T ScatPack 6.4', 'SRT 392 6.4', 'SRT HellCat 6.2', 'SRT HellCat WideBody 6.2', 'SRT Demon 6.2', 'R/T ScatPack WideBody 6.4', 'SRT HellCat RedEye 6.2', 'SRT HellCat RedEye WideBody 6.2', 'SRT HellCat RedEye SuperStock 6.2', 'SRT Demon 170 6.2'],
      VIPER: ['RT/10 8.0 V10'],
      DURANGO: ['SRT HellCat 6.2'],
    },
    RAM: {
      1500: ['1500 5.7', '1500 Rebel 5.7'],
    },
  },
  GM: {
    CHEVROLET: {
      CAMARO: ['SS 6.2', 'SS 1LE 6.2', 'ZL1 6.2 SC', 'Z/28 7.0', 'ZL1 6.2', 'ZL1 1LE 6.2', 'LT1 6.2'],
      CORVETTE: ['Base 6.0', 'Z06 7.0', 'Base 6.2', 'ZR1 6.2 SC', 'Grand Sport 6.2', 'Stingray 6.2', 'Z06 6.2', 'ZR1 6.2', 'Z06 5.5', 'E-Ray 6.2', 'ZR1 5.5TT'],
    },
  },
  FORD: {
    FORD: {
      F150: ['SuperSnake 5.0L SC', '5.0L V8', '5.2L SC V8 Raptor R'],
      MUSTANG: ['GT 5.0', 'Shelby GT350 5.2', 'Shelby GT350R 5.2', 'Bullitt 5.0', 'Shelby GT500 5.2 SC', 'Mach 1 5.0', 'Dark Horse 5.0', 'GTD 5.2 SC', 'Dark Horse SC 5.2 SC'],
    },
  },
  'LAND ROVER': {
    'LAND ROVER': {
      DEFENDER: [],
    },
  },
}
// The pack builder reads the flat carData version list; fill DEFENDER with the union of
// every era's wheelbase+engine version (built from the year-keyed map above).
carData['LAND ROVER']['LAND ROVER']['DEFENDER'] = [...new Set(Object.values(versionsByModelAndYear['DEFENDER']).flat())]

// Years valid for a full manufacturer/brand/model/version spec, drawn from the
// year-keyed catalog maps (used by the packs car picker's YEARS step).
export function yearsForSpec(manufacturer: string, brand: string, model: string, version: string): number[] {
  return years.filter((y) =>
    (manufacturersByYear[y] || []).includes(manufacturer) &&
    (brandsByManufacturerAndYear[manufacturer]?.[y] || []).includes(brand) &&
    (modelsByBrandAndYear[brand]?.[y] || []).includes(model) &&
    (versionsByModelAndYear[model]?.[y] || []).includes(version))
}

// Human label for a pack car entry — new shape ({manufacturer,brand,model,version,years[]})
// or legacy shape ({manufacturer,model,year}).
export function carLabel(c: any): string {
  if (!c) return '—'
  const head = [c.brand, c.model, c.version].filter(Boolean).join(' ') || c.manufacturer || '—'
  const yrs = Array.isArray(c.years) && c.years.length
    ? [...c.years].sort((a: number, b: number) => a - b).join(', ')
    : (c.year != null && c.year !== '' ? String(c.year) : '')
  return yrs ? `${head} — ${yrs}` : head
}