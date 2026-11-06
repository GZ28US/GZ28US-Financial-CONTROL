// THE TENANT of the quote portal — US (GZ28 V8 SpeedShop USA LLC) or BR (GZ28 V8 SpeedShop Ltda) — QUOTE PORTAL M6 (06/11/2026;
// blueprint §16 M6 «TenantConfig incl. contact per channel, currency»). PURE and IDENTICAL in both repos (scripts/sync-core-to-br.mjs
// checks the drift). Each app picks its own with TENANT = TENANTS.US / TENANTS.BR; the core libs read money words, time zone, public
// base, company block and the table names from here instead of hard-coding the US.
export type TenantId = 'US' | 'BR'
export type Tenant = {
  id: TenantId
  company: { name: string; taxId: string; address: string; phone: string; email: string }
  currency: 'usd' | 'brl'
  locale: 'en-US' | 'pt-BR'
  defaultLanguage: 'en' | 'pt'
  timeZone: 'America/New_York' | 'America/Sao_Paulo'
  publicBase: string                                    // where /q/<token> lives
  contact: { whatsapp: string; email: string; instagram: string; facebook: string }
  rails: string[]                                       // what a client may pay with (page copy; Stripe rails also need payments.rails_enabled)
  tables: { lines: 'invoice_items' | 'invoice_parts'; incomes: 'invoice_incomes' | 'invoice_payments' }
  receivingHouse: 'GZ28US' | 'GZ28BR'
  // the bank deposit the client pays into — ONE source for the client message and the quote page (Márcio, 06/11/2026: «the one that
  // already goes in the message to the client»). null = this house shows no deposit block.
  deposit: { holder: string; taxId: string; bank: string; branch: string; account: string; pix: string } | null
}

// BR company (Márcio, 06/11/2026, decision 7): the legal entity is the SAME one the client pays (deposit below reads it from here).
// Address, phone and e-mail copied from the BR client paper (app/rides/[id]/invoices/[invoiceId]/page.tsx, «pi-company»), not retyped
// from memory (D-03). The paper prints the brand «GZ28 V8 SpeedShop BR» on top; this block is the legal name under it.
const BR_COMPANY = { name: 'GZ28 Comércio e Serviços para Automóveis Ltda.', taxId: '58.377.183/0001-49',
  address: 'Av Arq Carlos Bratke 954, 04728-002, São Paulo / SP', phone: '(11) 98121.5678', email: 'gz28br@hotmail.com' }

export const TENANTS: Record<TenantId, Tenant> = {
  US: {
    id: 'US',
    company: { name: 'GZ28 V8 SpeedShop USA LLC', taxId: '', address: '11320 Space Blvd, 32837, Orlando / FL', phone: '(321) 315.0973', email: 'gz28us@hotmail.com' },
    currency: 'usd', locale: 'en-US', defaultLanguage: 'en', timeZone: 'America/New_York',
    publicBase: 'https://www.gz28us.com/ca',
    contact: { whatsapp: '+1 (321) 315-0973', email: 'gz28us@hotmail.com', instagram: '@gz28us', facebook: 'Dema De Maria' },
    rails: ['card', 'us_bank_account', 'ZELLE', 'WIRE'],
    tables: { lines: 'invoice_items', incomes: 'invoice_incomes' },
    receivingHouse: 'GZ28US',
    deposit: null,
  },
  BR: {
    id: 'BR',
    company: BR_COMPANY,
    currency: 'brl', locale: 'pt-BR', defaultLanguage: 'pt', timeZone: 'America/Sao_Paulo',
    publicBase: 'https://www.gz28br.com/ca',
    contact: { whatsapp: '', email: 'gz28br@hotmail.com', instagram: '@gz28br', facebook: 'galpaoz28' },
    rails: ['PIX_BR'],
    tables: { lines: 'invoice_parts', incomes: 'invoice_payments' },
    receivingHouse: 'GZ28BR',
    deposit: { holder: BR_COMPANY.name, taxId: 'CNPJ ' + BR_COMPANY.taxId, bank: 'Banco C6 S.A. (336)', branch: 'AG 0001', account: 'CC 35810689-3', pix: 'PIX 58377183000149' },
  },
}

export function moneyIn(t: Tenant, n: number): string {
  return new Intl.NumberFormat(t.locale, { style: 'currency', currency: t.currency.toUpperCase(), minimumFractionDigits: 2 }).format(Number(n || 0))
}
export function dayIn(t: Tenant, d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: t.timeZone }).format(d)
}

// ── REFERENCE CURRENCY (Márcio, 06/11/2026, decision 6: «alongside») ─────────────────────────────────────────────────────────────
// BR: R$ is the price the client signs and pays (PIX); US$ is printed NEXT to every line and total, for reference only. The rate is
// FROZEN in the sent revision with its day, so a signed document never moves. House rule (lib/fx.ts BR): commercial bid + R$ 0,20.
// The daily table has bid NULL on most Saturdays/holidays (memory fx-bid-vazio-sabado) — skip null/zero bids, take the last good day.
export const REFERENCE: Record<TenantId, { currency: 'usd'; spread: number } | null> = { US: null, BR: { currency: 'usd', spread: 0.20 } }
export type FrozenFx = { rate: number; spot: number; day: string }       // rate = spot + spread (R$ per US$), day = YYYY-MM-DD of the bid

export function freezeFx(t: Tenant, rows: { day: string; bid: number | string | null }[], onDay: string): FrozenFx | null {
  const ref = REFERENCE[t.id]
  if (!ref) return null
  const good = rows
    .map(r => ({ day: String(r.day).slice(0, 10), spot: Number(r.bid) }))
    .filter(r => r.day <= onDay && Number.isFinite(r.spot) && r.spot > 0)
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0]
  if (!good) return null
  const rate = Math.round((good.spot + ref.spread) * 10000) / 10000
  if (rate < 3 || rate > 9) return null                                   // a rate outside this band is a broken feed, never a price
  return { rate, spot: good.spot, day: good.day }
}

// «R$ 1.000,00 · US$ 189,04» — the main price, then the reference; the main price alone when there is no frozen rate
export function alongside(t: Tenant, amount: number, fx: FrozenFx | null): string {
  const main = moneyIn(t, amount)
  const ref = REFERENCE[t.id]
  if (!ref || !fx) return main
  const usd = new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Number(amount || 0) / fx.rate)
  return `${main} · ${usd}`
}

// the small print under the totals: «US$ apenas referência, câmbio de 06/11» / «US$ for reference, rate of 06/11»
export function fxNote(fx: FrozenFx | null, lang: 'en' | 'pt'): string {
  if (!fx) return ''
  const dm = `${fx.day.slice(8, 10)}/${fx.day.slice(5, 7)}`
  return lang === 'pt' ? `US$ apenas referência, câmbio de ${dm}` : `US$ for reference, rate of ${dm}`
}

// the deposit block as text, line by line (the BR client message prints it under «Dados pro Depósito:»); '' when the house has none
export function depositText(t: Tenant, heading = 'Dados pro Depósito:'): string {
  const d = t.deposit
  return d ? [heading, d.holder, d.taxId, d.bank, d.branch, d.account, d.pix].join('\n') : ''
}
