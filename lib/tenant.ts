// THE TENANT of the quote portal — US (GZ28 V8 SpeedShop USA LLC) or BR (GZ28 V8 SpeedShop Ltda) — QUOTE PORTAL M6 (06/11/2026;
// blueprint §16 M6 «TenantConfig incl. contact per channel, currency»). PURE and IDENTICAL in both repos (scripts/sync-core-to-br.mjs
// checks the drift). Each app picks its own with TENANT = TENANTS.US / TENANTS.BR; the core libs read money words, time zone, public
// base, company block and the table names from here instead of hard-coding the US.
export type TenantId = 'US' | 'BR'
export type Tenant = {
  id: TenantId
  company: { name: string; address: string; phone: string; email: string }
  currency: 'usd' | 'brl'
  locale: 'en-US' | 'pt-BR'
  defaultLanguage: 'en' | 'pt'
  timeZone: 'America/New_York' | 'America/Sao_Paulo'
  publicBase: string                                    // where /q/<token> lives
  contact: { whatsapp: string; email: string; instagram: string; facebook: string }
  rails: string[]                                       // what a client may pay with (page copy; Stripe rails also need payments.rails_enabled)
  tables: { lines: 'invoice_items' | 'invoice_parts'; incomes: 'invoice_incomes' | 'invoice_payments' }
  receivingHouse: 'GZ28US' | 'GZ28BR'
}

export const TENANTS: Record<TenantId, Tenant> = {
  US: {
    id: 'US',
    company: { name: 'GZ28 V8 SpeedShop USA LLC', address: '11320 Space Blvd, 32837, Orlando / FL', phone: '(321) 315.0973', email: 'gz28us@hotmail.com' },
    currency: 'usd', locale: 'en-US', defaultLanguage: 'en', timeZone: 'America/New_York',
    publicBase: 'https://www.gz28us.com/ca',
    contact: { whatsapp: '+1 (321) 315-0973', email: 'gz28us@hotmail.com', instagram: '@gz28us', facebook: 'Dema De Maria' },
    rails: ['card', 'us_bank_account', 'ZELLE', 'WIRE'],
    tables: { lines: 'invoice_items', incomes: 'invoice_incomes' },
    receivingHouse: 'GZ28US',
  },
  BR: {
    id: 'BR',
    company: { name: 'GZ28 V8 SpeedShop', address: '', phone: '', email: 'gz28br@hotmail.com' },   // BR address/phone: the owner's block (decision pending)
    currency: 'brl', locale: 'pt-BR', defaultLanguage: 'pt', timeZone: 'America/Sao_Paulo',
    publicBase: 'https://www.gz28br.com/ca',
    contact: { whatsapp: '', email: 'gz28br@hotmail.com', instagram: '@gz28br', facebook: '' },
    rails: ['PIX_BR'],
    tables: { lines: 'invoice_parts', incomes: 'invoice_payments' },
    receivingHouse: 'GZ28BR',
  },
}

export function moneyIn(t: Tenant, n: number): string {
  return new Intl.NumberFormat(t.locale, { style: 'currency', currency: t.currency.toUpperCase(), minimumFractionDigits: 2 }).format(Number(n || 0))
}
export function dayIn(t: Tenant, d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: t.timeZone }).format(d)
}
