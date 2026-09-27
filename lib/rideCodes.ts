// SÉRIES DE CÓDIGO DO CARRO (project_code) — a regra mora AQUI, e só aqui.
// Pedido da AutoBook GZ28US, aprovado pelo Márcio em 27/set/2026 («everything»):
//
//   US.###     carro de CLIENTE (destinos USA · OUT_OF_STATE · CLIENT · EXPORT)
//   SC.###     SHOWCASE — carro nosso de vitrine/marketing (title_scope OWN)
//   WV.###     WORK VEHICLE — caminhão, trailer, rig da casa (title_scope TOOL)
//   PO.###     PART-OUT — carcaça sem título, desmontada pra vender peça (PART_OUT)
//   US.QT.###  carro de QUOTE (escala própria, já existia)
//   SHP.###    vitrine do e-commerce (escala própria, não mexer)
//
// US, SC e WV dividem UMA escala de números: o número nunca se repete entre os
// três (existe SC.170, então nunca haverá US.170 nem WV.170). Trocar o destino
// entre esses três mantém o número e só troca o prefixo. PO tem escala própria:
// ir pra PART-OUT pega o próximo PO livre e libera o número da escala principal.
// Carro novo = MENOR número livre da escala (sem buracos). Carro PINNED nunca é
// sugerido, realocado nem liberado — o número é dele (rides.pinned).

export type RidePrefix = 'US' | 'SC' | 'WV' | 'PO' | 'US.QT' | 'SHP'
export type RideScale = 'MAIN' | 'PO' | 'QT' | 'SHP'

const CODE_RE = /^(US\.QT|SHP|US|SC|WV|PO)\.(\d+)$/

export function parseRideCode(code: string | null | undefined): { prefix: RidePrefix; num: number; width: number } | null {
  const m = String(code || '').trim().match(CODE_RE)
  if (!m) return null
  return { prefix: m[1] as RidePrefix, num: parseInt(m[2], 10), width: m[2].length }
}

export function scaleOf(prefix: RidePrefix): RideScale {
  if (prefix === 'PO') return 'PO'
  if (prefix === 'US.QT') return 'QT'
  if (prefix === 'SHP') return 'SHP'
  return 'MAIN'
}

// O prefixo que o DESTINO pede. Quote e vitrine SHP não mudam por destino.
export function prefixForScope(scope: string | null | undefined): 'US' | 'SC' | 'WV' | 'PO' {
  if (scope === 'OWN') return 'SC'
  if (scope === 'TOOL') return 'WV'
  if (scope === 'PART_OUT') return 'PO'
  return 'US'
}

export const formatRideCode = (prefix: RidePrefix, num: number, width = 3) => `${prefix}.${String(num).padStart(width, '0')}`

// Números ocupados numa escala. `except` = o próprio carro (ao renumerar, o número
// dele não conta como ocupado por outro).
export function usedNumbers(codes: Iterable<string | null | undefined>, scale: RideScale, except?: string | null): Set<number> {
  const used = new Set<number>()
  for (const c of codes) {
    if (!c || c === except) continue
    const p = parseRideCode(c)
    if (p && scaleOf(p.prefix) === scale) used.add(p.num)
  }
  return used
}

// Menor número livre da escala do prefixo, como código pronto.
export function nextFreeCode(codes: Iterable<string | null | undefined>, prefix: RidePrefix, except?: string | null): string {
  const used = usedNumbers(codes, scaleOf(prefix), except)
  let n = 1
  while (used.has(n)) n++
  return formatRideCode(prefix, n)
}

// O código que um carro deve ter depois de trocar de destino.
//   { code }             — o código novo (pode ser igual ao atual)
//   { code: null, why }  — não dá pra trocar sozinho (e o porquê)
export function codeForScope(
  currentCode: string, newScope: string | null | undefined, allCodes: Iterable<string | null | undefined>, pinned = false,
): { code: string | null; why?: string } {
  const cur = parseRideCode(currentCode)
  if (!cur) return { code: currentCode }                              // código fora das séries: não mexe
  if (cur.prefix === 'US.QT' || cur.prefix === 'SHP') return { code: currentCode } // quote e vitrine: destino não renumera
  const want = prefixForScope(newScope)
  if (want === cur.prefix) return { code: currentCode }
  const fromScale = scaleOf(cur.prefix), toScale = scaleOf(want)
  if (fromScale === toScale) return { code: formatRideCode(want, cur.num, cur.width) } // US/SC/WV: mesmo número, prefixo novo
  if (pinned) return { code: null, why: `${currentCode} está PINNED — o número dele nunca é realocado. Tire o pin antes de mudar para ${want === 'PO' ? 'PART-OUT' : 'fora de PART-OUT'}.` }
  return { code: nextFreeCode(allCodes, want, currentCode) }
}

// Confere um código contra a regra das séries: formato, e número livre na escala
// (US.042 e SC.042 são o MESMO número — só um carro pode ter).
export function checkRideCode(code: string, allCodes: Iterable<string | null | undefined>, selfCode?: string | null): string | null {
  const p = parseRideCode(code)
  if (!p) return `«${code}» não é um código válido (US.### · SC.### · WV.### · PO.### · US.QT.### · SHP.###).`
  for (const c of allCodes) {
    if (!c || c === selfCode) continue
    const o = parseRideCode(c)
    if (o && scaleOf(o.prefix) === scaleOf(p.prefix) && o.num === p.num) {
      return `O número ${String(p.num).padStart(3, '0')} já é do ${c} — ${scaleOf(p.prefix) === 'MAIN' ? 'US, SC e WV dividem a mesma escala.' : 'a escala é a mesma.'}`
    }
  }
  return null
}
