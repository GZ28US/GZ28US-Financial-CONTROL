import type { Metadata } from 'next'

// The client's quote page metadata (06/11/2026; blueprint §2.1, RO-06): a neutral title — no amount, no name — and never indexed.
// The language comes from the document's terms, looked up with the service key; any failure falls back to English.
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  let pt = false
  try {
    if (/^[A-Za-z0-9_-]{30,64}$/.test(token) && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { serviceDb } = await import('@/lib/quoteDoc.server')
      const db = serviceDb()
      const { data: link } = await db.from('quote_links').select('invoice_id').eq('token', token).maybeSingle()
      if (link) {
        const { data: terms } = await db.from('invoice_terms').select('language').eq('invoice_id', link.invoice_id).maybeSingle()
        pt = terms?.language === 'pt'
      }
    }
  } catch { /* neutral English */ }
  const title = pt ? 'GZ28 V8 SpeedShop — Seu orçamento' : 'GZ28 V8 SpeedShop — Your quote'
  return {
    title, description: 'GZ28 V8 SpeedShop', robots: { index: false, follow: false }, referrer: 'no-referrer',
    openGraph: { title, description: 'GZ28 V8 SpeedShop', images: [{ url: 'https://www.gz28us.com/ca/logo_gz28.jpg', width: 1200, height: 630, alt: 'GZ28 V8 SpeedShop' }] },
  }
}

export default function QuoteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
