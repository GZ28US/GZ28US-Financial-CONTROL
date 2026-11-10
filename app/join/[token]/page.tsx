import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { liveInvite } from '@/lib/viewerInvite.server'
import JoinForm from './JoinForm'

// /ca/join/<token> — the invited person creates their own READ-ONLY account (10/11/2026, Márcio: «só pra quem mandamos o
// link»). Public (AuthGate '/join/'); no token, a bad one, a used / expired / revoked one = 404 (never «invalid invite»).
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'GZ28US — Create your account', robots: { index: false, follow: false, nocache: true } }

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const inv = await liveInvite(token)
  if (!inv) notFound()
  return <JoinForm token={token} email={inv.email} />
}
