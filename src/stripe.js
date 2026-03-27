import Stripe from 'stripe'

/* ── Lazy singleton ─────────────────────────────────────────────
   Returns null when STRIPE_SECRET_KEY is not configured — all
   callers must guard with:  if (!stripe) { ... }
──────────────────────────────────────────────────────────────── */
let _stripe = null

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  return _stripe
}

/* ── Price ID → plan name map ──────────────────────────────────
   Built from env vars so the mapping is configured in one place.
──────────────────────────────────────────────────────────────── */
export function getPriceToPlan() {
  const map = {}
  if (process.env.STRIPE_STARTER_PRICE_ID) map[process.env.STRIPE_STARTER_PRICE_ID] = 'starter'
  if (process.env.STRIPE_PRO_PRICE_ID) map[process.env.STRIPE_PRO_PRICE_ID] = 'pro'
  return map
}

/* ── Cancel a Stripe subscription ──────────────────────────────
   Returns true on success, false if stripe is unconfigured or
   the subscription doesn't exist. Never throws — callers should
   still update the DB plan regardless of Stripe result.
──────────────────────────────────────────────────────────────── */
export async function cancelSubscription(subscriptionId) {
  if (!subscriptionId) return false
  const stripe = getStripe()
  if (!stripe) return false
  try {
    await stripe.subscriptions.cancel(subscriptionId)
    console.log(`Stripe subscription cancelled: ${subscriptionId}`)
    return true
  } catch (err) {
    // already_cancelled is fine
    if (err.code === 'resource_missing' || err.statusCode === 404) return true
    console.warn(`Stripe cancel failed (${subscriptionId}):`, err.message)
    return false
  }
}
