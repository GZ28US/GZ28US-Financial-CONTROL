import { supabase } from '@/lib/supabase'
import { normSup, matchSupplier, supplierDirectoryFrom, type SupplierEntry } from './supplierMatch'
import { normNature } from './itemNature'
import { isLockedPart } from './utils'


// Items whose name matches these are "extras" (shipping/handling/etc). For the
// parts data bank we keep the CHEAPEST extra ever seen; regular parts keep the
// LAST purchase (most recent by date). Same list the parts importer skips.
//
// ── DESDE 04/set/2026 ESTES DOIS REGEX SÃO SÓ O FALLBACK ────────────────────
// Quem manda é `nature` (lib/itemNature.ts), lida na origem — no scan, no
// e-mail, no banco. O regex só decide a linha que NINGUÉM classificou.
// Por que isso importa: adivinhar por palavra deixou o catálogo contaminado —
// "Dodge PCM Services" e "ECU UnLocks" estão cadastrados como PEÇA porque
// nenhuma das palavras abaixo aparece no nome deles. Serviço e digital não são
// peça, e nenhuma lista de palavras vai cobrir todas as grafias do mundo.
export const EXTRA_WORDS = /tax|shipping|handling|freight|delivery|s&h|surcharge|insurance/i

// Money movements are NOT parts: a scanned line matching these never enrolls in
// the bank (word-bounded so "Balancer" or "wire harness" can't false-positive).
export const PAYMENT_WORDS = /\b(payment|pagamento|deposit|down\s?payment|installment|parcela|entrada|balance\s?due|wire\s?transfer|refund|estorno|chargeback)\b/i

export type EnrollItem = {
  item: string
  part_number?: string | null
  supplier?: string | null
  unit_price?: number | string
  tax?: number | string
  extra?: number | string
  quantity?: number | string
  item_discount?: number | string
  purchase_date?: string | null
  receipt_url?: string | null
  // Official-supplier invoices can print a List/Retail column (→ MAP) and
  // per-line weights — both enroll when the scan finds them.
  list_price?: number | string
  weight_lbs?: number | string
  // Optional nickname typed on the review screen — a typed alias always wins.
  alias?: string | null
  // MARKET the amounts above are printed in ('USD' | 'BRL'). One row per PN per market.
  currency?: string | null
  // O QUE É ESTA LINHA (lib/itemNature.ts): PART | SERVICE | DIGITAL | CHARGE |
  // MONEY, ou null/ausente quando ninguém disse. Só PEÇA entra no catálogo como
  // peça; ENCARGO entra como is_extra; serviço, digital e dinheiro NÃO entram.
  nature?: string | null
  // O CUSTO DESTA LINHA FOI LIDO OU CALCULADO? (09/set/2026)
  // true quando o leitor de recibo teve de RATEAR um desconto em bloco para
  // fechar no total — o unit_price é uma média, não o que a loja cobrou por
  // esta peça. Custo derivado NUNCA entra no catálogo; ver enrollOne.
  cost_derived?: boolean
}

// Part-number normalization for dedupe: uppercase, strip every non-alphanumeric
// char (so dots/commas/spaces/dashes can't split the same number), then drop a
// leading brand/supplier token. This makes "DOD 53021585AD" == "MOPAR 53021585AD"
// and "gatK100579HD" == "K100579HD" so the same part can't enroll twice.
export function normPN(pn?: string | null): string {
  // ── SKU DA LOJA x NÚMERO DO FABRICANTE (09/set/2026) ────────────────────
  // A HHP imprime o código DELA na coluna Code/SKU: um prefixo de marca em
  // minúsculas grudado no número do fabricante — appATI918485, cca5761CPG,
  // gatK100610HD, jltCAI-DH05, eibE10-27-004-01-22, cgsC15642-090. São 12
  // linhas do catálogo carregando o SKU da loja no lugar do PN, e com isso a
  // mesma peça comprada em outra loja nasce como peça nova.
  //
  // A régua é do FORMATO, não da loja: número de fabricante não começa com
  // letras minúsculas coladas numa maiúscula ou dígito. O que sobra tem de
  // continuar sendo um PN (6+ alfanuméricos), senão o corte foi estrago e o
  // número original fica.
  //
  // Medido contra as 738 peças do catálogo: 12 chaves mudam, todas casam com
  // a PRÓPRIA linha, nenhuma passa a casar com peça diferente.
  const cru = String(pn || '').trim()
  const semLoja = cru.replace(/^[a-z]{2,4}(?=[A-Z0-9])/, '')
  const base = semLoja.replace(/[^A-Za-z0-9]/g, '').length >= 6 ? semLoja : cru
  // A trailing quantity marker (" x 2", " X 4") is packaging, not part of the PN.
  let x = base.toUpperCase().replace(/\s+X\s*\d+\s*$/, '').replace(/[^A-Z0-9]/g, '')
  x = x.replace(/^(GATES|GAT|DODGE|DOD|MOPAR|NGK|ADO|IND)(?=[A-Z0-9])/, '')
  return x
}

// Per-unit OUR COST — ONE FIELD (user law 18/aug/2026): unit_price, whatever the
// source. A hunted part still waiting for its dealer cost falls back to MAP so
// dedupe comparisons stay meaningful. Same-market rows only, so no currency mix.
function ourCostOf(r: any): number {
  const v = r?.unit_price ?? r?.map_price
  const n = Number(v)
  return Number.isFinite(n) ? n : Infinity
}

// THE discount — ONE FIELD (user law 18/aug/2026): part_discount = MAP→OUR COST,
// recomputed against a (constant) MAP + a cost. Delivered projections derive on
// screen now, never stored.
function withDerived(row: any, map: number | null, cost: number): any {
  const r1 = (n: number) => Math.round(n * 10) / 10
  if (map != null && Number(map) > 0 && Number.isFinite(cost) && cost > 0) {
    const m = Number(map)
    return { ...row, map_price: m, part_discount: r1((1 - cost / m) * 100) }
  }
  return { ...row, map_price: map != null ? Number(map) : null, part_discount: null }
}

// THE dedupe rule (hunt / scan / manual all funnel through here): a part number
// lives in the DB only ONCE PER MARKET (currency). Match on the normalized part number (or item name
// when there's no PN). Insert when new. When it already exists:
//   REAL LIFE PREVAILS — a SCANNED invoice is the ground truth. The flow is
//   hunt → quote → deal → purchase → real invoice, so a scan ALWAYS replaces
//   whatever an earlier date put on file (hunt, manual, older scan); between
//   two scans the NEWER purchase date wins; hunt/manual never beats a scan.
//   Extras (shipping/tax rows) keep the CHEAPEST ever seen; hunt-vs-hunt keeps
//   the lowest cost. The kept alias is preserved; a known weight is never erased.
export async function enrollOne(entrada: any): Promise<{ status: 'inserted' | 'updated' | 'kept'; error: any }> {
  // ── CUSTO DERIVADO NÃO ENTRA (09/set/2026) ────────────────────────────────
  // A nota da HHP #384734 imprimiu o desconto como UMA linha ("Desconto
  // -$161,77") em vez de abater peça por peça. Sem saber de quem é o desconto,
  // o leitor rateia proporcional para fechar o total — e a loja tinha dado
  // 8% / 16% / 6% / 10%. Medido no PDF: o rateio uniforme (11,197%) põe +33,33
  // a mais no Litens e 30,92 a menos no ATI, 66,66 de erro somado e ZERO de
  // erro no total. Nenhuma conferência de soma acha isso, e daqui iria direto
  // para o catálogo — que desde ontem atualiza preço até de peça TRAVADA
  // quando a compra é real.
  //
  // (Esta compra foi lançada CERTA, e vale entender por quê: a tela de revisão
  // pré-preenche o Disc% de cada peça com o desconto que o catálogo já
  // conhecia daquele fornecedor, e os quatro fecharam exatamente nos 161,77
  // impressos. Quem NÃO tem essa muleta é o robô, que lê o PDF e lança
  // sozinho — é para ele que este guarda existe.)
  //
  // Então o custo rateado não vale como custo. A expense continua certa (o
  // total é verdade); o que não acontece é o número derivado virar "o que esta
  // peça custa". A peça entra — com PN, nome, fornecedor, data, recibo e o MAP
  // impresso, que são fatos do papel — só que com o campo de custo VAZIO, que
  // é a resposta honesta. Vazio se vê na tela; errado não.
  const custoDerivado = !!entrada?.cost_derived
  // O cost_derived é BILHETE DE VIAGEM, não coluna: sai antes de qualquer
  // escrita, senão o insert quebra com "column does not exist".
  const row: any = { ...entrada }
  delete row.cost_derived
  if (custoDerivado) { row.unit_price = null; row.part_discount = null }

  const { data } = await supabase.from('parts_database')
    // `locked_at` e `supplier` VÊM JUNTO, e não é enfeite: sem `locked_at` a
    // função que decide o cadeado (`isLockedPart`) recebe sempre undefined e
    // devolve "destravado" para tudo — o conserto das 173 peças nasceria morto.
    // Sem `supplier` a exceção do cadeado não sabe se a nota é do MESMO
    // fornecedor e nunca dispara. É a doença do select coluna a coluna: a marca
    // existe no banco e quem lê não a pede.
    .select('id, item, alias, part_number, source_type, unit_price, map_price, shipping, handling, weight_lbs, purchase_date, is_extra, currency, locked_at, supplier')
  const rows = data || []
  const keyOf = (r: any) => r.part_number ? normPN(r.part_number) : ('NAME:' + String(r.item || '').trim().toLowerCase())
  // Two part numbers are the SAME part when the normalized forms match exactly OR
  // one ends with the other (shorter side ≥ 6 chars) — catches brand-prefix
  // variants the strip list doesn't know (e.g. "JLTCAI755184" vs "CAI755184").
  const samePN = (a: string, b: string) => {
    if (!a || !b) return false
    if (a === b) return true
    if (a.startsWith('NAME:') || b.startsWith('NAME:')) return false
    const min = Math.min(a.length, b.length)
    return min >= 6 && (a.endsWith(b) || b.endsWith(a))
  }
  // ONE ROW PER PART NUMBER **PER MARKET** (user law 14/aug/2026). The same part is
  // genuinely a different purchase in each country — a Mopar oil filter is US$ 8.66 at
  // Titan and R$ 147 in Brazil — so the rows coexist and never overwrite each other:
  // the dollar row is the American reality, the reais row the Brazilian one. Every other
  // law (real life prevails, LOCKED, cheapest extra) then applies WITHIN the market.
  const market = (r: any) => String(r?.currency || 'USD').toUpperCase()
  const myMarket = market(row)
  const sameMarket = rows.filter((r: any) => market(r) === myMarket)
  const key = keyOf(row)
  let existing = key ? sameMarket.find((r: any) => samePN(keyOf(r), key)) : null

  // Fallback: listing titles (eBay etc.) often carry the real part number only in
  // the item TEXT, while the PN field holds a marketplace item number (or nothing).
  // Sweep the text for PN-looking tokens (≥6 alphanumerics with a digit) and match
  // them against the known part numbers — same part must never enroll twice.
  if (!existing) {
    const tokensOf = (s: any) => (String(s || '').toUpperCase().match(/[A-Z0-9][A-Z0-9.\-\/]{4,}[A-Z0-9]/g) || [])
      .map(t => normPN(t)).filter(t => t.length >= 6 && /\d/.test(t))
    const mine = new Set([...tokensOf(row.item), ...tokensOf(row.part_number)])
    if (mine.size) {
      existing = sameMarket.find((r: any) => {
        const rpn = r.part_number ? normPN(r.part_number) : ''
        if (rpn && rpn.length >= 6 && [...mine].some(t => samePN(t, rpn))) return true
        // Mirror case: our PN appears inside the existing row's item text.
        const k = keyOf(row)
        return !k.startsWith('NAME:') && k.length >= 6 && tokensOf(r.item).some(t => samePN(t, k))
      }) || null
    }
  }

  // A SCAN from an OFFICIAL SUPPLIER (dealer contract → dealer_supplier set) is
  // REAL LIFE at its most trusted: it re-validates any row and LOCKS the result.
  //
  // ── O CADEADO NÃO MORA NA ORIGEM (achado da sessão PESCA/AutoBook, 09/set) ─
  // O "untangle" do catálogo (24/ago/2026, lib/appVersion.ts) separou duas coisas
  // que viviam no mesmo campo: `source_type` voltou a ser só ORIGEM — SCAN, HUNT,
  // MANUAL, INVOICE — e o cadeado passou a morar em `locked_at`/`locked_by`. A
  // migration levou as linhas LOCKED para lá; hoje são 173 com `locked_at` e ZERO
  // com `source_type = 'LOCKED'`.
  //
  // Só que este enroller continuava ESCREVENDO `source_type: 'LOCKED'` no scan de
  // fornecedor oficial. Não é só duplicar campo (o que a lei da casa já proíbe):
  // é APAGAR a origem real da peça e pôr o cadeado no lugar dela. Cada scan de
  // dealership comeria um dado que o untangle tinha acabado de separar — e calado,
  // porque na tela o 🔒 aparece igual. Não detonou ainda (zero linhas), mas 396
  // peças têm `dealer_supplier`: era questão de qual scan viesse primeiro.
  //
  // Agora ele tranca onde a TELA tranca (app/parts/page.tsx:179), e a origem fica.
  const cadeadoDoOficial = () => ({
    locked_at: new Date().toISOString(),
    locked_by: `AUTO · scan de fornecedor oficial${row.dealer_supplier ? ' (' + row.dealer_supplier + ')' : ''}`,
  })
  // ...menos quando o custo é rateado: travar linha sem custo congelaria para
  // sempre uma peça que nunca teve preço.
  const officialScan = row.source_type === 'SCAN' && !!row.dealer_supplier && !custoDerivado

  if (!existing) {
    // A scanned MAP gets THE discount (MAP→OUR COST) computed on insert.
    // An official-supplier purchase enters already validated: status LOCKED.
    const base = officialScan ? { ...row, ...cadeadoDoOficial() } : row
    const toInsert = base.map_price != null && Number(base.map_price) > 0
      // cost 0 quando derivado: sem custo não há desconto a calcular — e
      // ourCostOf cairia no próprio MAP, gravando um falso "0% de desconto".
      ? withDerived(base, Number(base.map_price), custoDerivado ? 0 : ourCostOf(base))
      : base
    const { error } = await supabase.from('parts_database').insert([toInsert])
    return { status: 'inserted', error }
  }

  // LOCKED is ABSOLUTE (user law 2026-08-05: "when locked, nothing with the same
  // part-number gets enrolled in the system, no matter what, not even in a kit").
  // A LOCKED row is frozen: no scan, hunt, manual entry or kit member ever touches
  // it; everything that matches its PN resolves TO the locked row instead.
  //
  // DUAS RÉGUAS PARA A MESMA PERGUNTA (achado da sessão PESCA/AutoBook, 09/set/2026).
  // A TELA marca 🔒 por `locked_at` — é o que o botão TRAVAR grava; este enroller
  // olhava só `source_type === 'LOCKED'`. Medido no catálogo inteiro: 173 peças
  // com `locked_at` preenchido e ZERO com aquele source_type — ou seja, 173
  // cadeados desenhados na tela e nenhum segurando nada. Ele clicou 173 vezes
  // achando que estava congelando o custo, e o robô entrava por baixo.
  //
  // Não é escolher uma régua: a lei é dele e o cadeado é o da tela. Passa a valer
  // `isLockedPart`, a MESMA função que desenha o cadeado — uma verdade só, que é
  // o único jeito de as duas nunca mais divergirem.
  // A ÚNICA EXCEÇÃO DO CADEADO (Márcio, 09/set/2026):
  //   "sempre que uma compra real é feita, da mesma peça, no mesmo fornecedor,
  //    tem que atualizar o valor da peça no parts db, MESMO QUE BLOQUEADA."
  //
  // O cadeado existe para ele se proteger de scan de terceiro e de caçada na
  // web — não da nota do próprio fornecedor. Preço que a loja acabou de cobrar
  // É a realidade, e a lei da casa é que a vida real manda.
  //
  // TRÊS CONDIÇÕES CUMULATIVAS, e faltando uma o cadeado volta inteiro:
  //   1. compra REAL — veio de SCAN de nota, com data e custo de verdade.
  //      Hunt não passa, cotação não passa, linha sem data não passa.
  //   2. mesma PEÇA — já garantido: só se chega aqui com o PN casado.
  //   3. mesmo FORNECEDOR — pelo nome do CADASTRO, não pelo texto cru da nota.
  //      (`row.supplier` já entra curado; ver a cura na escrita mais abaixo.)
  //
  // E ela mexe no CUSTO, nunca no ESTADO: `locked_at` fica onde está. Travar e
  // destravar continua sendo a mão dele.
  //   4. custo IMPRESSO — rateio não é compra provada. Esta é a mais nova das
  //      quatro e a que mais pesa: sem ela, a exceção que acabamos de abrir no
  //      cadeado seria justamente por onde o número derivado entraria — e peça
  //      travada é a que ele mais confere.
  const compraReal = row.source_type === 'SCAN'
    && /^\d{4}-\d{2}-\d{2}$/.test(String(row.purchase_date || ''))
    && Number(row.unit_price) > 0
    && !custoDerivado
  const mesmoFornecedor = !!row.supplier && !!existing.supplier
    && normSup(String(row.supplier)) === normSup(String(existing.supplier))

  if (isLockedPart(existing)) {
    if (!(compraReal && mesmoFornecedor)) return { status: 'kept', error: null }
    // Atualização CIRÚRGICA: só o que a nota prova. Nada de deixar a linha
    // passar pela disputa de "quem ganha" lá embaixo — peça travada não entra
    // em concurso, ela recebe o preço da nota e pronto.
    const patch: Record<string, unknown> = {
      unit_price: row.unit_price,
      purchase_date: row.purchase_date,
      updated_at: new Date().toISOString(),
    }
    if (row.part_discount != null) patch.part_discount = row.part_discount
    if (row.receipt_url) patch.receipt_url = row.receipt_url
    if (row.dealer_supplier) patch.dealer_supplier = row.dealer_supplier
    // MAP só quando a nota IMPRIME o List — MAP não se deduz de custo.
    if (row.map_price != null && Number(row.map_price) > 0) patch.map_price = row.map_price
    const { error } = await supabase.from('parts_database').update(patch).eq('id', existing.id)
    return { status: error ? 'kept' : 'updated', error }
  }

  // Who wins the row? Both sides are in the SAME currency by construction (the match
  // above never crosses markets), so these are plain number comparisons again — no rate,
  // no conversion, nothing to get wrong.
  const dateOf = (r: any) => { const t = Date.parse(String(r?.purchase_date || '')); return Number.isFinite(t) ? t : 0 }
  const isExtra = !!(row.is_extra || existing.is_extra)
  let replace: boolean
  // Quem não tem custo não entra em concurso de preço: a linha derivada nunca
  // toma a linha existente. Ela ainda passa pelo remendo lá embaixo, que
  // preenche o que FALTA e o papel prova — MAP impresso, peso, apelido.
  if (custoDerivado) replace = false
  else if (isExtra) replace = ourCostOf(row) < ourCostOf(existing)                 // extras: cheapest ever
  else if (row.source_type === 'SCAN') replace = existing.source_type !== 'SCAN' || dateOf(row) >= dateOf(existing) // real life prevails; newest scan wins
  else if (existing.source_type === 'SCAN') replace = false                   // hunt/manual never beats a real invoice
  else replace = ourCostOf(row) < ourCostOf(existing)                         // hunt vs hunt: lowest cost

  // MAP: a winning SCAN that carries a retail (printed List or supplier-discount
  // derived) overrides the stored MAP — real life re-validates it. Otherwise the
  // known MAP stays constant, converted into the winning row's currency (a MAP carried
  // from a dollar row onto a reais row has to become reais, or the discount is nonsense).
  const map = replace && row.source_type === 'SCAN' && Number(row.map_price) > 0
    ? Number(row.map_price)
    : (existing.map_price != null ? existing.map_price : (row.map_price ?? null))
  if (replace) {
    // Write a COMPLETE, consistent payload so no stale fields linger when the
    // winning source differs from the one on file (e.g. scan beats a prior hunt).
    const full: any = {
      item: row.item ?? existing.item,
      part_number: row.part_number ?? null,
      supplier: row.supplier ?? null,
      dealer_supplier: row.dealer_supplier ?? null,
      unit_price: row.unit_price ?? null,
      tax: row.tax ?? null,
      extra: row.extra ?? null,
      quantity: row.quantity ?? null,
      purchase_date: row.purchase_date ?? null,
      is_extra: row.is_extra ?? false,
      receipt_url: row.receipt_url ?? null,
      shipping: row.shipping ?? null,
      handling: row.handling ?? null,
      // An official-supplier purchase VALIDATES the row: the guard above freezes
      // it forever — the bank compiles itself into a purchase-proven catalog. O
      // cadeado vai em `locked_at`/`locked_by` (logo abaixo); `source_type` fica
      // sendo o que sempre devia ter sido, a ORIGEM.
      source_type: row.source_type ?? existing.source_type ?? null,
      ...(officialScan ? cadeadoDoOficial() : {}),
      // The market this row belongs to. Same as the existing row by construction (a
      // match never crosses markets), written explicitly so the pair can never drift.
      currency: myMarket,
      // A typed alias wins; otherwise the known alias is preserved.
      alias: row.alias ?? existing.alias ?? null,
      // Weight only when the incoming scan carries one — never erase a known weight.
      ...(row.weight_lbs != null && Number(row.weight_lbs) > 0 ? { weight_lbs: row.weight_lbs } : {}),
      updated_at: new Date().toISOString(),
    }
    const merged = withDerived(full, map, ourCostOf(row))
    const { error } = await supabase.from('parts_database').update(merged).eq('id', existing.id)
    return { status: 'updated', error }
  }
  // Even when the existing row wins (newer scan on file / cheaper extra), fill in
  // MAP and weight it lacks — an official-supplier scan is authoritative for both.
  const patch: any = {}
  if ((existing.map_price == null || Number(existing.map_price) <= 0) && row.map_price != null && Number(row.map_price) > 0) {
    Object.assign(patch, withDerived({}, Number(row.map_price), ourCostOf(existing)))
  }
  if ((existing.weight_lbs == null || Number(existing.weight_lbs) <= 0) && row.weight_lbs != null && Number(row.weight_lbs) > 0) {
    patch.weight_lbs = row.weight_lbs
  }
  // An alias typed on the review screen saves even when the existing row wins.
  if (row.alias && row.alias !== existing.alias) patch.alias = row.alias
  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString()
    const { error } = await supabase.from('parts_database').update(patch).eq('id', existing.id)
    return { status: 'updated', error }
  }
  return { status: 'kept', error: null }
}

// Registered-supplier directory (name + aliases). An official supplier's purchase
// enrolls WITH the dealer identity. NO typed discount exists anymore: the discount
// is always computed per item as OUR PRICE vs open-market MAP (MAP rule: eBay
// first, else the official supplier's open-market price — recorded at HUNT time
// or re-validated by a printed List price on a real invoice).
// UM fornecedor, UM nome — a chave de comparação (Márcio, 04/set/2026).
// "&" vira "and", sufixo societário cai, pontuação some. Sem isso
// "Texas Speed & Performance" e "Texas Speed and Performance" viravam dois
// fornecedores, e 28 peças ficaram sem o vínculo de official supplier.
// normSup / SupplierEntry / matchSupplier moram em lib/supplierMatch.ts desde o
// AUTO-BOOK fase B (BL 0.9.0): módulo puro que o motor do Bank Link também usa.
// Re-exportados aqui — quem importava de partsDb continua funcionando.
export { normSup, matchSupplier, supplierDirectoryFrom }
export type { SupplierEntry }

async function supplierDirectory(): Promise<SupplierEntry[]> {
  try {
    const { data } = await supabase.from('suppliers').select('name, aliases, is_dealership')
    return supplierDirectoryFrom(data || [])
  } catch { return [] }
}

// Enroll scanned items into parts_database (product code = PART NUMBER when
// present, else item name). Each goes through enrollOne, so one row per part —
// a SCAN (real-life invoice) overrides older data; see enrollOne. Returns rows changed.
export async function enrollParts(items: EnrollItem[], sourceType: string = 'SCAN'): Promise<number> {
  const directory = await supplierDirectory()
  let changed = 0
  for (const raw of items) {
    const name = (raw.item || '').trim()
    const pn = (raw.part_number || '').trim()
    if (!name && !pn) continue
    // ── A NATUREZA MANDA; O REGEX É FALLBACK (04/set/2026) ──────────────────
    // SERVIÇO, DIGITAL e DINHEIRO não são peça e não entram no catálogo. O que
    // motivou: "Dodge PCM Services" e "ECU UnLocks" (tune por e-mail, US$ 1.000)
    // estão cadastrados como PEÇA — passaram porque PAYMENT_WORDS não casa com
    // "service" nem com "unlock". Linha sem nature segue exatamente como antes.
    const nature = normNature(raw.nature)
    if (nature === 'SERVICE' || nature === 'DIGITAL' || nature === 'MONEY') continue
    if (!nature && PAYMENT_WORDS.test(name)) continue
    const price = Number(raw.unit_price) || 0
    const row: any = {
      item: name || pn,
      part_number: pn || null,
      supplier: raw.supplier || null,
      unit_price: price,
      tax: Number(raw.tax) || 0,
      extra: Number(raw.extra) || 0,
      quantity: Number(raw.quantity) || 1,
      purchase_date: raw.purchase_date || null,
      // ENCARGO é is_extra por definição (imposto/frete/handling: preço da
      // compra, não uma segunda compra); PEÇA declarada nunca é extra, nem
      // quando o nome carrega uma das palavras do regex ("Freight Kit").
      is_extra: nature ? nature === 'CHARGE' : EXTRA_WORDS.test(name),
      receipt_url: raw.receipt_url || null,
      source_type: sourceType,
      // The document's own currency, stored with its numbers untouched.
      currency: String(raw.currency || 'USD').toUpperCase().trim() || 'USD',
      alias: (typeof raw.alias === 'string' ? raw.alias.trim() : '') || null,
      // A etiqueta do rateio viaja com a linha; quem decide o que fazer com
      // ela é o enrollOne, num lugar só.
      cost_derived: !!raw.cost_derived,
      updated_at: new Date().toISOString(),
    }
    // Official-supplier extras: printed List/Retail price = the MAP; printed weight.
    const listP = Number(raw.list_price) || 0
    if (listP > 0) row.map_price = listP
    const weight = Number(raw.weight_lbs) || 0
    if (weight > 0) row.weight_lbs = weight
    // O NOME DO FORNECEDOR É O DO CADASTRO, nunca o texto cru da nota
    // (Márcio, 04/set/2026: "ensine o app a escrever estes fornecedores sempre
    // assim, pra nunca mais entrar com outro nome"). A HHP tinha entrado com
    // SETE grafias — "High Horse Performance", "HHP Racing", "High Horse
    // Performance, Inc. (HHP Racing)" — e o cadastro dela aparecia com ZERO
    // peças, zerando o desconto médio na tela de Suppliers.
    const sup = raw.supplier ? matchSupplier(raw.supplier, directory) : null
    if (sup) row.supplier = sup.name
    // dealer_supplier é o OFFICIAL supplier — só quem tem contrato de
    // dealership entra aqui. Antes qualquer cadastrado entrava, e o eBay virava
    // "fornecedor oficial" em 9 peças, diluindo o desconto real dos oficiais.
    // Ver a lei SUPPLIER x OFFICIAL SUPPLIER.
    if (sup && sup.official && !row.is_extra) row.dealer_supplier = sup.name
    const { status, error } = await enrollOne(row)
    if (!error && status !== 'kept') changed++
  }
  return changed
}
