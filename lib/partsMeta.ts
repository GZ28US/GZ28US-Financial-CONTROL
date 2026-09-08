// PARTS META — vocabulário do catálogo (24/ago/2026, decisão João+Márcio:
// "fill and untangle, let's make it perfect").
//
// CATEGORY: vocabulário FECHADO — o formulário escolhe, nunca digita. Serve o
// Crew Chief (agrupar BOM, ler o Board) e a cabeça humana (achar peça).
export const PART_CATEGORIES = [
  'ENGINE', 'DRIVETRAIN', 'SUSPENSION & BRAKES', 'FUEL SYSTEM', 'EXHAUST',
  'COOLING', 'ELECTRONICS', 'WHEELS & TIRES', 'EXTERIOR', 'INTERIOR',
  'CONSUMABLES', 'LABOR', 'OTHER',
] as const
export type PartCategory = typeof PART_CATEGORIES[number]

// Palpite por palavra-chave pro backfill (650 peças sem categoria). É SUGESTÃO —
// quem bate o martelo é o humano no card do Data Checker.
// Ordem IMPORTA (medido em 8/set/2026 nas 611 sem categoria): «valve spring» é motor, não
// suspensão; «F-Body» não é carroceria; pneu tem tamanho (275/35ZR18) e marca, não a palavra
// «tire»; «pressure regulator» é combustível; ferramenta é OTHER, não consumível.
const RULES: [RegExp, PartCategory][] = [
  [/\bsedex\b|\bfrete\b|shipping|postage|custom plate|placa personalizada/i, 'OTHER'],
  [/wrench|socket set|ratchet|screwdriver|plier|drill\b|torque|tool\b|ferramenta|jack stand|lift\b/i, 'OTHER'],
  [/injector|fuel pump|fuel rail|fuel system|flex fuel|e85|fuel filter|fuel line|fuel (pressure )?regulator|pressure regulator|regulator de? ?combust|fuelmax|voltage booster/i, 'FUEL SYSTEM'],
  [/header|exhaust|muffler|cat-?back|catback|downpipe|mid ?pipe|resonator|\btip\b|x-?pipe|h-?pipe/i, 'EXHAUST'],
  [/\d{3}\/\d{2}\s?[zr]?r\d{2}|\btires?\b|\bpneus?\b|\bwheels?\b|\brodas?\b|lug ?nut|tpms|wheel spacer|hoosier|michelin|toyo\b|nitto|pirelli|bfgoodrich|mickey thompson|drag radial/i, 'WHEELS & TIRES'],
  [/radiator|intercooler|heat ?exchanger|coolant|water pump|thermostat|\bfan\b|cooling|overflow tank|expansion tank/i, 'COOLING'],
  [/axle|driveshaft|differential|clutch|converter|transmission|trans ?mount|shifter|cardan|\bdiff\b|half ?shaft|flywheel|torque conv/i, 'DRIVETRAIN'],
  [/valve ?spring|spring kit|valve ?train|retainer|supercharger|turbo|cam(shaft)?\b|piston|\brod\b|crank|valve\b|head ?stud|head ?bolt|main ?stud|main ?bolt|side bolt|arp\b|gasket|rear main seal|oil seal|\bseal\b|pulley|idler|tensioner|intake|throttle|manifold|lifter|pushrod|rocker|bearing|oil pump|thrust plate|cylinder head|\bblock\b|\bmotor\b|engine/i, 'ENGINE'],
  [/coil ?over|coilover|\bshock|strut|damper|sway ?bar|control arm|bushing|end ?link|suspens|lowering spring|\bspring/i, 'SUSPENSION & BRAKES'],
  [/brake|rotor|caliper|\bpads?\b|brembo|brake line/i, 'SUSPENSION & BRAKES'],
  [/\becu\b|\becm\b|\bpcm\b|tuner|mpvi|hp ?tuners|sensor|harness|\bwire|chicote|module|gauge|camera|smartcable|\bobd|stereo|radio|carplay|speaker|headlight|tail ?light|\blamp\b|\bled\b|plug wire|coil pack|ignition coil|solenoid|battery/i, 'ELECTRONICS'],
  [/spoiler|splitter|\bhood\b|fender|grille|emblem|badge|decal|\bwrap\b|paint|body ?kit|body panel|bumper|diffuser|hitch|ball mount|parachute|mirror|cover\b|carbon fiber|wing\b|wiper/i, 'EXTERIOR'],
  [/\bseat|steering|volante|carpet|\btrim\b|interior|pedal|shift ?knob|dash\b|console/i, 'INTERIOR'],
  [/\boil\b|fluid|filter|spark ?plug|grease|cleaner|\btape\b|zip ?tie|fastener|abraçadeira|shop ?towel|luva|sealant|loctite|brake clean/i, 'CONSUMABLES'],
  [/labor|instal|service|tuning|calibra|dyno|mão de obra/i, 'LABOR'],
]
export function suggestCategory(text: string): PartCategory | null {
  for (const [re, cat] of RULES) if (re.test(text)) return cat
  return null
}
