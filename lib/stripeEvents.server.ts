// SERVER-ONLY — what the Control App DOES with each Stripe event (06/11/2026).
//
// The webhook route (app/api/stripe/webhook) verifies the signature, records the event in `stripe_events` (idempotency by
// event id) and calls `handleStripeEvent`. This module owns the business reaction. Contract:
//   • return { handled: true, ref }  → recorded as DONE (ref = the business key: invoice id / session id);
//   • return { handled: false }      → recorded as IGNORED (an event type we do not act on — still 200 to Stripe);
//   • throw                          → recorded as ERROR and the route answers 500 so Stripe RETRIES (up to ~3 days).
// Nothing here sends a message to anyone: notifications are a separate step, each behind its own app_settings key (OFF by
// default — Márcio's law of 06/11/2026). The handlers land with the quote → invoice blueprint; until then every event is
// IGNORED on purpose, and the record in stripe_events is the proof it arrived.

import type Stripe from 'stripe'

export type StripeHandled = { handled: boolean; ref?: string | null; note?: string }

export async function handleStripeEvent(event: Stripe.Event): Promise<StripeHandled> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const s = event.data.object as Stripe.Checkout.Session
      // Sessions without our marker belong to the shop (same Stripe account, its own endpoint) — not ours to touch.
      if (s.metadata?.app !== 'control-app') return { handled: false, note: 'session not from the Control App' }
      return { handled: false, ref: s.id, note: 'handler lands with the quote → invoice blueprint' }
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
      return { handled: false, note: 'handler lands with the quote → invoice blueprint' }
    default:
      return { handled: false }
  }
}
