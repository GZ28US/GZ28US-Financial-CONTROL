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
const RULES: [RegExp, PartCategory][] = [
  [/injector|fuel pump|fuel rail|fuel system|flex fuel|e85|fuel filter|regulator de? ?combust/i, 'FUEL SYSTEM'],
  [/header|exhaust|muffler|cat-?back|downpipe|mid ?pipe|resonator|tip\b/i, 'EXHAUST'],
  [/wheel|tire|pneu|roda|lug ?nut|tpms|spacer/i, 'WHEELS & TIRES'],
  [/spring|shock|coilover|sway|control arm|bushing|end ?link|strut|damper|suspens/i, 'SUSPENSION & BRAKES'],
  [/brake|rotor|caliper|pad\b|brembo/i, 'SUSPENSION & BRAKES'],
  [/radiator|intercooler|heat ?exchanger|coolant|water pump|thermostat|fan\b|cooling/i, 'COOLING'],
  [/ecu|ecm|pcm|tuner|mpvi|sensor|harness|wire|chicote|module|gauge|camera|smartcable|obd/i, 'ELECTRONICS'],
  [/axle|driveshaft|differential|clutch|converter|transmission|trans ?mount|shifter|cardan|diff\b/i, 'DRIVETRAIN'],
  [/supercharger|turbo|cam(shaft)?|piston|rod\b|crank|valve|spring kit|head stud|gasket|pulley|idler|tensioner|intake|throttle|manifold|lifter|pushrod|rocker|bearing|oil pump|motor|engine/i, 'ENGINE'],
  [/oil\b|fluid|filter|spark ?plug|grease|cleaner|tape|zip|fastener|abraçadeira|shop ?towel|luva|sealant/i, 'CONSUMABLES'],
  [/spoiler|splitter|hood|fender|grille|emblem|badge|decal|wrap|paint|body|bumper|diffuser/i, 'EXTERIOR'],
  [/seat|steering|volante|carpet|trim\b|interior|pedal|shift ?knob/i, 'INTERIOR'],
  [/labor|instal|service|tuning|calibra|dyno|mão de obra/i, 'LABOR'],
]
export function suggestCategory(text: string): PartCategory | null {
  for (const [re, cat] of RULES) if (re.test(text)) return cat
  return null
}
