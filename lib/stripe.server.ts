// SERVER-ONLY — Stripe in the Control App (06/11/2026, quote → invoice: the client pays the 1st installment online).
//
// One client, fail-closed: no STRIPE_SECRET_KEY → the caller gets a clear error, never a half-configured call. The mode
// (test / live) is read from the key prefix, so switching to live is env-only (the shop does the same). The webhook secret
// belongs to the Control App's OWN endpoint — https://www.gz28us.com/ca/api/stripe/webhook (www: the apex 308-redirects and
// Stripe treats 3xx as failure) — created 06/11/2026 in TEST mode; the shop keeps its own endpoint and secret.
//
// Rules carried from the shop (app/api/stripe-webhook) and the house laws:
//   • "paid" comes ONLY from a signature-verified webhook event, never from a browser redirect (C-88);
//   • the amount charged is the law-computed amount (lib/flTax invoiceMoney); Stripe Tax stays OFF (C-90);
//   • card fees are absorbed by GZ28 (Márcio 06/11/2026) — no gross-up on the client's deposit.

import Stripe from 'stripe'

export type StripeMode = 'test' | 'live'

export function stripeMode(): StripeMode | null {
  const k = process.env.STRIPE_SECRET_KEY || ''
  if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test'
  if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live'
  return null
}

export function stripeConfigured(): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!process.env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY')
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET')
  return { ok: missing.length === 0, missing }
}

let client: Stripe | null = null
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured on this project')
  if (!client) client = new Stripe(key)
  return client
}

// Raw body + `stripe-signature` header → the event, or a thrown error (caller answers 400).
export function verifyStripeEvent(rawBody: string, signature: string): Stripe.Event {
  const whsec = process.env.STRIPE_WEBHOOK_SECRET
  if (!whsec) throw new Error('STRIPE_WEBHOOK_SECRET is not configured on this project')
  return stripeClient().webhooks.constructEvent(rawBody, signature, whsec)
}

export const usdFromCents = (cents: number | null | undefined) => Math.round(Number(cents || 0)) / 100
export const centsFromUsd = (usd: number) => Math.round(Number(usd || 0) * 100)
