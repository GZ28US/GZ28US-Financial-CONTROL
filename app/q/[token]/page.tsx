import QuotePublic from '@/components/quote/QuotePublic'

// The client's quote page (06/11/2026): one stable link per document — read, approve & sign, pay the deposit. Public (AuthGate
// '/q/'), no app navigation. The token travels once, to /api/q/open, which sets the per-link httpOnly cookie.
export default async function QuotePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ a?: string; preview?: string }> }) {
  const { token } = await params
  const sp = await searchParams
  return <QuotePublic token={token} attemptId={sp.a || null} />
}
