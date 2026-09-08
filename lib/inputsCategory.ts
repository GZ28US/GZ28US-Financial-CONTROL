// A CATEGORIA DO INSUMO PELA LOJA (DC 1.45.0 · BL 1.2.1 — João, 8/set/2026: «ferragem é oficina,
// mercado é equipe, loja mista sugere; e as regras do motor aprendem o mesmo mapa»).
//
// Dois leitores independentes, como na categoria da peça:
//   1. o TEXTO da linha (a lista do card desde 26/ago, com o vocabulário de mercado completado:
//      óleo/tinta → STOCK, gato/cachorro → CATS, apto → APARTMENT, comida → TEAM, WD-40/papel/fita
//      → CONSUMPTION). Ordem importa: bicho antes de comida («Canned Cat Food» é CATS, não TEAM).
//   2. a LOJA (identidade: o que a loja vende diz o que o insumo é — Ace/Harbor Freight/Home Depot
//      vendem consumível de oficina, Aldi/Publix/lanchonete vendem comida, Petco vende gato).
// Concordam, ou só a loja fala e ela é de um tipo só → CERTA (entra sozinha). Loja mista não opina:
// supermercado/atacado (Walmart, Target, Sam's, Costco) SUGERE equipe quando o texto cala — o que a
// equipe compra lá é comida e casa; Amazon, Temu, eBay, Dollar Tree ficam na pergunta. Discordam →
// sugestão do texto com as duas opiniões na cara. STOCK nunca é certo: mover pro estoque é de gente.
// Linha criada pelo motor (texto = nome do banco com endereço) não tem texto pra ler: só a loja fala.
// Puro: sem banco, sem React — o Data Checker e o motor do Bank Link usam a mesma régua.
export const INPUT_CATS = ['CONSUMPTION', 'STOCK', 'APARTMENT', 'CATS', 'TEAM'] as const
export type InputCat = typeof INPUT_CATS[number]
export type InputTier = 'CERTAIN' | 'SUGGEST' | null
export type InputVerdict = { category: InputCat | null; tier: InputTier; store: InputCat | null; text: InputCat | null; why: string }

// Leitor 1 — o TEXTO. A primeira que bate vale.
export const TEXT_HINT: [RegExp, InputCat][] = [
  // Exceções primeiro: palavras que enganariam o leitor de baixo (Gatorade não é gato; painters tape não é tinta).
  [/gatorade|hot ?dogs?\b|corn ?dogs?\b|coffee filters?|olive oil|cooking oil|vegetable oil|canola oil|\bcoconut oil/i, 'TEAM'],
  [/painter'?s tape|brake cleaner|distilled water|kraft paper|bed ?liner|fish tape/i, 'CONSUMPTION'],
  [/\boil\b|óleo|oleo|\b[05]w[- ]?[234]0\b|\bquarts?\b|\bqt\b|paint|tinta|touch.?up|brake|fluid|coolant|antifreeze|filtro|filter/i, 'STOCK'],
  [/\b(cats?|dogs?|kitten|puppy|litter)\b|\bgatos?\b|cachorro|\bpet\b|purina|whiskas|friskies|meow|areia (de|do) gato/i, 'CATS'],
  [/apartment|\bapto\b|mattress|\bbed\b(?! ?liner)|cookw|kitchen|pillow|sofa|couch|bedding|comforter|towel set|shower curtain/i, 'APARTMENT'],
  [/\bfood\b|comida|coffee|café|cafe|creamer|snack|\bkraft\b|\bkft\b|velveeta|água|agua|\bwater\b|soda|refrigerante|guaran[aá]|\bcoke\b|pepsi|sprite|gatorade|red bull|monster energy|\bjuice\b|suco|\bdrinks?\b|lunch|dinner|breakfast|pizza|leite|\bmilk\b|bread|pão|pao|banana|grape|\buva\b|\bapples?\b|maçã|lemon|limão|avocado|abacate|tomato|tomate|onion|cebola|potato|batata|\brice\b|arroz|\bbeans?\b|feijão|feijao|\beggs?\b|\bovos?\b|cheese|queijo|yogurt|\byog\b|butter|manteiga|\bcream\b|chicken|frango|\bbeef\b|carne|\bpork\b|steak|turkey|\bham\b|bacon|sausage|lingui[çc]a|\bfish\b|\btuna\b|salmon|shrimp|pasta|macarr[ãa]o|sauce|molho|cereal|granola|\boats?\b|chips|cookie|biscoito|candy|chocolate|sugar|açúcar|acucar|\bsalt\b|flour|farinha|fruit|fruta|salad|salada|\bveg|legume|\bmeal\b|sandwich|burger|hot ?dog|tortilla|nugget|frozen|ice cream|sorvete|\btea\b|\bch[aá](?![a-z])|\bbeer\b|cerveja|\bwine\b|vinho/i, 'TEAM'],
  [/wd-?40|alcohol|álcool|alcool|clean|limp|paper|papel|towel|toalha|glove|luva|tape|fita|trash|lixo|shipping|parcel|\bbox\b|caixa|\bzip\b|shelf|prateleira|organizer|chair|cadeira|desk|mesa|tie-?down|drill|\bbit\b|socket|wrench|screw|parafuso|bolt|\bnut\b|washer|microfiber|sponge|esponja|broom|vassoura|bucket|balde|rag\b|pano|degreaser|lubric|grease|graxa|solvent|thinner|sandpaper|lixa|blade|lâmina|lamina|light ?bulb|lâmpada|lampada|battery|pilha|extension cord|cabo|hose|mangueira|funnel|funil|zip ?tie|abraçadeira|marker|caneta|label|etiqueta/i, 'CONSUMPTION'],
]
// Leitor 2 — a LOJA de um tipo só.
export const STORE_KIND: [RegExp, InputCat][] = [
  // Autopeças (AutoZone, O«Reilly, Advance, NAPA, TouchUpDirect) NÃO entram: vendem óleo, vela e tinta — o que este card existe pra mover pro estoque.
  [/ace hardw|harbor freight|home depot|lowe'?s\b|grainger|northern tool|tractor supply|fastenal|\buline\b|sherwin|true value/i, 'CONSUMPTION'],
  [/\baldi\b|publix|seabra|winn.?dixie|whole foods|trader joe|kroger|sprouts|bravo supermarket|sedano|fresco y mas|food lion|steak n shake|chick.?fil|mcdonald|wendy'?s|burger king|taco bell|chipotle|\bsubway\b|starbucks|dunkin|\bpizza\b|domino'?s|papa john|restaurant|\bcafe\b|café|panera|popeyes|\bkfc\b|\bculver'?s\b|jersey mike|firehouse subs/i, 'TEAM'],
  [/petco|petsmart|\bchewy\b|pet supplies/i, 'CATS'],
]
// Loja MISTA. Supermercado/atacado sugere EQUIPE quando o texto cala; o resto só pergunta.
export const SUPERSTORE = /walmart|wal-mart|\btarget\b|sam'?s club|costco|\bbj'?s\b|neighborhood market/i
export const MIXED_STORE = /amazon|amzn|\btemu\b|dollar tree|family dollar|dollar general|five below|\bebay\b|big lots|ollie'?s|shein|aliexpress/i
// A classe do Plaid (regra do motor) também é identidade de loja.
const KLASS_STORE: Record<string, InputCat> = { GROCERY: 'TEAM', HARDWARE: 'CONSUMPTION', HOME_SUPPLY: 'CONSUMPTION' }
const KLASS_SUPERSTORE = new Set(['SUPERSTORE', 'WHOLESALE_CLUB'])
// Linha que o motor CRIOU: «<loja> — <nome do banco com endereço> (regra · Bank Link)» — não há texto de item.
// (MARKER_CREATED do motor; a linha ATRIBUÍDA no balde traz «(atribuída · Bank Link)» e o texto é de gente.)
const ENGINE_LINE = /\(regra · Bank Link\)/

export function classifyInput(supplier: unknown, description: unknown, klass?: string | null): InputVerdict {
  const sup = String(supplier || ''), desc = String(description || '')
  const text: InputCat | null = ENGINE_LINE.test(desc) ? null : ((TEXT_HINT.find(([re]) => re.test(desc)) || [])[1] || null)
  // A LOJA se lê no fornecedor (o motor manda o nome do banco junto), nunca no texto do item: «pizza cutter» não é pizzaria.
  const store: InputCat | null = (STORE_KIND.find(([re]) => re.test(sup)) || [])[1] || (klass ? KLASS_STORE[klass] : undefined) || null
  const superstore = !store && (SUPERSTORE.test(sup) || (!!klass && KLASS_SUPERSTORE.has(klass)))
  const mixed = !store && !superstore && MIXED_STORE.test(sup)
  if (store && text && store === text) return { category: store, tier: 'CERTAIN', store, text, why: 'loja e texto concordam: ' + store }
  if (store && text) return { category: text, tier: 'SUGGEST', store, text, why: 'a loja diz ' + store + ', o texto diz ' + text + ' — decida' }
  if (store) return { category: store, tier: 'CERTAIN', store, text: null, why: 'identidade da loja: ' + store }
  if (text) return { category: text, tier: 'SUGGEST', store: null, text, why: (superstore || mixed ? 'loja mista; ' : '') + 'o texto sugere ' + text }
  if (superstore) return { category: 'TEAM', tier: 'SUGGEST', store: null, text: null, why: 'supermercado/atacado sem pista no texto — palpite: equipe (comida e casa)' }
  return { category: null, tier: null, store: null, text: null, why: mixed ? 'loja mista, texto sem pista — decida' : 'sem pista — decida' }
}
