import QuotePublic from '@/components/quote/QuotePublic'

// Retainable copy (Fla. §668.50(8)): the same document, light print stylesheet, buttons hidden, certificate block when signed.
export default async function QuotePrintPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <QuotePublic token={token} attemptId={null} print />
}
