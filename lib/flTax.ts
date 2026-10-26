// ════════════════════════════════════════════════════════════════════════════
// lib/flTax.ts · 26/out/2026 — FL SALES TAX PELA LEI, UMA RÉGUA SÓ (Márcio: «o app tem que ser atualizado pela lei! …
// ONLY FL Cars (CLIENTS) must have FL Tx in their invoices … when it's for export, never TX»).
//
// Antes: FL tax = itens × `invoices.florida_taxes`% (alíquota digitada à mão, 13 cópias da fórmula), mão de obra nunca
// tributada, invoice sem o campo saía sem imposto. Agora a invoice NÃO tem alíquota digitada: o status fiscal nasce do
// OWNER & DESTINATION do carro (rides.title_scope) e, sem ele, do endereço do cliente; a conta é a da lei.
//
// A LEI (FAC 12A-1.006, folheto DOR GT-800010 — pesquisa aprovada 26/set/2026):
//   · peça fornecida pela oficina → a cobrança INTEIRA (peça + mão de obra/instalação) é tributável, mesmo com a mão de
//     obra separada na fatura;
//   · serviço SÓ de mão de obra (nenhuma peça na invoice) → isento;
//   · carro que sai da Flórida por transportadora (OUT OF STATE, com bill of lading) ou exportação (BOUGHT BY EXPORTER /
//     BOUGHT BY GZ28US, s.212.06 — PowerTrade/Peniel) → isento;
//   · carro NOSSO (SHOWCASE / WORK VEHICLE / PART-OUT) → não há venda, não há imposto;
//   · alíquota Orlando: 6% estado sobre tudo + 0,5% Orange County sobre os primeiros US$ 5.000 de CADA linha (teto
//     US$ 25/linha). O desconto global reduz o preço ANTES do imposto (a base é o que o cliente paga).
//   · cliente sem carro no app: EUA + Flórida (ou estado vazio) = tributável; EUA outro estado = fora da FL; outro
//     país = exportação.
//   · EXCEÇÃO com motivo (invoices.fl_tax_override TAXABLE / EXEMPT + fl_tax_override_reason): prova de exportação que
//     faltou, certificado de revenda, decisão da Drummond — sempre com o porquê escrito.
// Quem lê: invoiceTotals (lib/financials), o editor e a view/PDF da invoice, listas (invoices, clients, rides), CURRENT,
// FUTURE, DRE, Data Checker, GZ-FLOW (crossingBalance) e os packs (estimativa). O app BR NÃO entra (escopo 26/set).

export const FL_STATE_RATE = 6            // % do estado, sobre tudo
export const FL_COUNTY_RATE = 0.5         // % Orange County (discretionary surtax)
export const FL_COUNTY_CAP = 5000         // o surtax só incide até US$ 5.000 de cada linha
export const FL_TAX_RATE_LABEL = `${FL_STATE_RATE + FL_COUNTY_RATE}%`

export type FlTaxStatus = 'TAXABLE' | 'LABOR_ONLY' | 'OUT_OF_STATE' | 'EXPORT' | 'NO_SALE' | 'OVERRIDE_TAXABLE' | 'OVERRIDE_EXEMPT'
export type FlTaxOverride = 'TAXABLE' | 'EXEMPT' | null | undefined

export const FL_TAX_STATUS_LABEL: Record<FlTaxStatus, string> = {
  TAXABLE: 'Florida sales tax — client car stays in Florida (parts + labor)',
  LABOR_ONLY: 'Exempt — labor only, no parts furnished',
  OUT_OF_STATE: 'Exempt — leaves Florida by carrier (bill of lading on file)',
  EXPORT: 'Exempt — export (s. 212.06)',
  NO_SALE: 'No sale — our own car',
  OVERRIDE_TAXABLE: 'Florida sales tax — charged by exception',
  OVERRIDE_EXEMPT: 'Exempt — by exception',
}
export const FL_TAX_STATUS_SHORT: Record<FlTaxStatus, string> = {
  TAXABLE: 'FL TAX', LABOR_ONLY: 'LABOR ONLY', OUT_OF_STATE: 'OUT OF STATE', EXPORT: 'EXPORT', NO_SALE: 'OUR CAR',
  OVERRIDE_TAXABLE: 'FL TAX (exception)', OVERRIDE_EXEMPT: 'EXEMPT (exception)',
}
export const isFlTaxable = (s: FlTaxStatus) => s === 'TAXABLE' || s === 'OVERRIDE_TAXABLE'

const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const r2 = (v: number) => Math.round(v * 100) / 100

export const isUsaCountry = (c: string | null | undefined) => /^(usa|us|united states|eua|estados unidos)/i.test(String(c || '').trim())
export const isFloridaState = (s: string | null | undefined) => { const x = String(s || '').trim().toUpperCase(); return x === '' || x === 'FL' || x === 'FLORIDA' }

export type FlTaxClient = { country?: string | null; state?: string | null } | null | undefined

// O STATUS FISCAL da invoice: OWNER & DESTINATION do carro manda; sem carro (ou sem destino), o endereço do cliente.
export function flTaxStatus(opts: { scope?: string | null; client?: FlTaxClient; override?: FlTaxOverride; hasParts: boolean }): FlTaxStatus {
  if (opts.override === 'EXEMPT') return 'OVERRIDE_EXEMPT'
  if (opts.override === 'TAXABLE') return 'OVERRIDE_TAXABLE'
  const scope = String(opts.scope || '').toUpperCase()
  if (scope === 'OWN' || scope === 'TOOL' || scope === 'PART_OUT' || scope === 'DONOR') return 'NO_SALE'
  if (scope === 'CLIENT' || scope === 'EXPORT') return 'EXPORT'
  if (scope === 'OUT_OF_STATE') return 'OUT_OF_STATE'
  if (scope !== 'USA') {
    const c = opts.client
    if (c && c.country && !isUsaCountry(c.country)) return 'EXPORT'
    if (c && isUsaCountry(c.country) && !isFloridaState(c.state)) return 'OUT_OF_STATE'
  }
  return opts.hasParts ? 'TAXABLE' : 'LABOR_ONLY'
}

// O IMPOSTO sobre um conjunto de linhas (valor de cada linha já líquido do desconto), pela lei: 6% sobre tudo + 0,5% sobre
// os primeiros US$ 5.000 de cada linha.
export function flTaxOnLines(lines: number[]): { state: number; county: number; total: number } {
  let state = 0, county = 0
  for (const raw of lines) {
    const v = num(raw); if (v <= 0) continue
    state += v * FL_STATE_RATE / 100
    county += Math.min(v, FL_COUNTY_CAP) * FL_COUNTY_RATE / 100
  }
  return { state: r2(state), county: r2(county), total: r2(state + county) }
}

export type InvoiceMoney = {
  status: FlTaxStatus; taxable: boolean
  parts: number; services: number; subtotal: number; discountPct: number; discount: number
  taxBase: number; taxState: number; taxCounty: number; tax: number; grand: number
}

// OS TOTAIS DA INVOICE — a mesma conta em toda tela: subtotal = itens + serviços; desconto global sobre o subtotal; o
// imposto (quando tributável) sobre cada linha JÁ descontada; total = subtotal − desconto + imposto.
export function invoiceMoney(opts: { partLines: number[]; serviceLines: number[]; discountPct?: number | null; status: FlTaxStatus }): InvoiceMoney {
  const partLines = opts.partLines.map(num).filter(v => v !== 0), serviceLines = opts.serviceLines.map(num).filter(v => v !== 0)
  const parts = r2(partLines.reduce((s, v) => s + v, 0)), services = r2(serviceLines.reduce((s, v) => s + v, 0))
  const subtotal = r2(parts + services)
  const discountPct = Math.min(100, Math.max(0, num(opts.discountPct)))
  const discount = r2(subtotal * discountPct / 100)
  const taxable = isFlTaxable(opts.status)
  const k = 1 - discountPct / 100
  const t = taxable ? flTaxOnLines([...partLines, ...serviceLines].map(v => v * k)) : { state: 0, county: 0, total: 0 }
  return {
    status: opts.status, taxable, parts, services, subtotal, discountPct, discount,
    taxBase: taxable ? r2(subtotal - discount) : 0, taxState: t.state, taxCounty: t.county, tax: t.total,
    grand: r2(subtotal - discount + t.total),
  }
}

// Atalho para quem tem a invoice, o carro e o cliente na mão.
export function invoiceMoneyFor(inv: { global_discount?: number | string | null; fl_tax_override?: string | null } | null | undefined,
  scope: string | null | undefined, client: FlTaxClient, partLines: number[], serviceLines: number[]): InvoiceMoney {
  const hasParts = partLines.some(v => num(v) > 0)
  const status = flTaxStatus({ scope, client, override: (inv?.fl_tax_override as FlTaxOverride) || null, hasParts })
  return invoiceMoney({ partLines, serviceLines, discountPct: num(inv?.global_discount), status })
}
