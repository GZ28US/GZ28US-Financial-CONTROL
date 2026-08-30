// ── CARRO NUNCA VIRA FORNECEDOR CADASTRADO ──────────────────────────────────
// Lei ditada por Márcio em 30/ago/2026, palavra por palavra:
//
//   "os carros, mesmo aparecendo como SUPPLIER nas expenses quando doaram algo,
//    JAMAIS podem ser cadastrados como supplier no banco. Nao permita que isso
//    aconteca, sem poluir o banco. Isso e FEATURE, nao campo."
//
// O QUE ISTO NÃO É: não é para tirar o carro do campo `supplier` DA LINHA da
// expense. Lá é o lugar dele — quando um carro doa uma peça, o doador é o carro,
// e a origem mora em UM campo só (lei de 22/ago/2026: "o vendedor quando
// comprado, o CARRO DOADOR quando veio da invoice de um carro"). A linha não se
// toca.
//
// O QUE ISTO É: a tabela `suppliers` é o CADASTRO de quem vende para nós. Um
// carro não vende nada — ele aparece como origem porque doou. Deixar o carro
// entrar ali polui o cadastro (foi assim que "US.040 — HellMonster" virou linha
// em suppliers, com 0 referências, e teve de ser apagado à mão em 30/ago/2026).
//
// ONDE ESTA GUARDA TEM DE ESTAR: em TODO caminho que faz insert/upsert em
// `suppliers`. Um caminho sem ela é um caminho que suja o banco.

// ── AS DUAS FORMAS DE UM CARRO APARECER ─────────────────────────────────────
//
// 1) PELO CÓDIGO — "US.040", "US.040 — HellMonster", "BR.353", "US.042.3". É a
//    numeração dos carros nos dois apps, e também o prefixo dos códigos de
//    invoice, que pela mesma razão não são fornecedor. Esta forma se reconhece
//    sozinha, sem consultar nada.
//
// 2) PELO NOME COMERCIAL — e foi por aqui que um escapou. Em 21/jun/2026, às
//    00:28:07, o ensureSupplier cadastrou "Dodge Charger Presidiário" no banco
//    BR, no MESMO SEGUNDO em que nasceu a linha de inventory que trazia esse
//    nome no campo supplier. Não tem código nenhum na frente: a guarda de
//    código não barrava e nem enxergava. O carro é o ride "ScatPack Presidiário"
//    (DODGE CHARGER), que existe nos dois bancos.
//
// Para a forma 2 a guarda precisa SABER quais carros existem — e por isso este
// módulo continua PURO (sem banco, sem rede): quem tem os rides em mãos os
// entrega com rememberCars(), e a checagem segue síncrona em toda call site.

// ── O CUIDADO COM O FALSO POSITIVO (a parte difícil) ────────────────────────
// Existe fornecedor de verdade cujo nome CONTÉM o nome de um carro nosso:
//   "Genesis Exotic Transport"  × ride BR.386 "Genesis"   — transportadora real
//   "Titan MotorSports"         × ride         "Titan"    — loja real
// Barrar por SUBSTRING mataria os dois. Por isso as regras abaixo casam com o
// NOME INTEIRO (normalizado), nunca com um pedaço solto, e só usam nomes de
// carro com DUAS PALAVRAS OU MAIS — "Genesis" e "Titan" sozinhos não entram na
// lista, e "Chevrolet Performance" (fornecedor real da GM) não é confundido com
// um ride cujo model está vazio.
//
// Medido contra o banco real dos dois apps (78 nomes distintos em suppliers,
// 196 rides): a regra pega EXATAMENTE 1 nome — "Dodge Charger Presidiário", o
// carro que vazou — e nenhum fornecedor legítimo.

const RIDE_CODE = /^\s*(US|BR)\s*\.\s*\d+/i

// Normalização única de nome: sem acento, minúsculo, pontuação vira espaço.
// "Dodge Charger Presidiário" e "DODGE-CHARGER  PRESIDIARIO" viram a mesma coisa.
const norm = (s: string | null | undefined) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const wordCount = (s: string) => (s ? s.split(' ').filter(Boolean).length : 0)

export type CarRow = {
  project_name?: string | null
  brand?: string | null
  model?: string | null
}

// MARCA+MODELO dos nossos carros ("dodge charger", "ford mustang"): um nome de
// fornecedor que COMEÇA por um deles é carro. É a única regra de prefixo, e ela
// exige fronteira de palavra — "Dodge City Auto Parts" passa, "Dodge Charger
// Presidiário" não.
const carMakes = new Set<string>()
// NOME DE PROJETO com 2+ palavras ("scatpack presidiario", "charger raul"):
// casa só com o nome INTEIRO. Nome de uma palavra fica de fora de propósito.
const carNames = new Set<string>()

/**
 * Entrega os carros conhecidos à guarda. Chamar com as linhas de `rides`
 * (project_name, brand, model). Acumula: chamar de novo só acrescenta, e chamar
 * com lista vazia não apaga nada — assim uma leitura que voltou vazia (RLS,
 * offline) NUNCA enfraquece a guarda, apenas não a reforça.
 */
export function rememberCars(rows: CarRow[] | null | undefined) {
  for (const r of rows || []) {
    const make = norm(`${r?.brand || ''} ${r?.model || ''}`)
    if (wordCount(make) >= 2) carMakes.add(make)
    const name = norm(r?.project_name)
    if (wordCount(name) >= 2) carNames.add(name)
  }
}

/** Quantos carros a guarda já conhece — para diagnóstico, não para decisão. */
export function knownCarCount() {
  return carMakes.size + carNames.size
}

/**
 * true quando o nome é um CARRO (código de ride, marca+modelo nosso, ou nome de
 * projeto inteiro) e portanto NÃO pode virar linha na tabela `suppliers`. Vale
 * para "US.040", "US.040 — HellMonster", "BR.353", "US.042.3" e, depois de
 * rememberCars(), também para "Dodge Charger Presidiário" e "ScatPack Presidiário".
 */
export function isRideCodeName(name: string | null | undefined): boolean {
  const raw = String(name || '')
  if (RIDE_CODE.test(raw)) return true
  const n = norm(raw)
  if (!n) return false
  if (carNames.has(n)) return true
  for (const make of carMakes) if (n === make || n.startsWith(make + ' ')) return true
  return false
}

/**
 * O portão único do cadastro de fornecedor: devolve o nome limpo quando ele PODE
 * ser cadastrado, e '' quando não pode (vazio ou carro). Quem chama grava só se
 * vier nome — nunca se lança erro nem se avisa o usuário: o carro continua no
 * campo supplier da linha, e só o CADASTRO é que não o recebe.
 */
export function supplierNameForRegistry(name: string | null | undefined): string {
  const n = String(name || '').trim()
  if (!n) return ''
  if (isRideCodeName(n)) return ''
  return n
}
