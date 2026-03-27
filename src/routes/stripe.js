import { Router } from 'express'
import { query } from '../db.js'
import { getStripe, getPriceToPlan, cancelSubscription } from '../stripe.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

/* ══════════════════════════════════════════════════════════════
   POST /stripe/webhook
   Called by Stripe for all subscription events.
   Body is raw (not JSON-parsed) — verified by Stripe signature.
══════════════════════════════════════════════════════════════ */
router.post('/webhook', async (req, res) => {
  const stripe = getStripe()
  if (!stripe) {
    console.warn('Stripe webhook received but STRIPE_SECRET_KEY is not set')
    return res.json({ received: true })
  }

  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message)
    return res.status(400).json({ error: `Webhook error: ${err.message}` })
  }

  try {
    const priceToPlan = getPriceToPlan()

    switch (event.type) {

      /* ── New payment / subscription created ────────────────── */
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode !== 'subscription') break

        const email = session.customer_details?.email?.toLowerCase()
        const customerId = session.customer
        const subscriptionId = session.subscription
        if (!email || !subscriptionId) {
          console.warn('checkout.session.completed: missing email or subscription', session.id)
          break
        }

        // Get the price ID from the new subscription
        const sub = await stripe.subscriptions.retrieve(subscriptionId)
        const priceId = sub.items.data[0]?.price?.id
        const newPlan = priceToPlan[priceId]
        if (!newPlan) {
          console.warn('checkout.session.completed: unknown price ID', priceId)
          break
        }

        // Find user by email
        const userResult = await query(
          'SELECT id FROM users WHERE LOWER(email) = $1',
          [email]
        )
        if (!userResult.rows[0]) {
          console.warn('checkout.session.completed: no user found for email', email)
          break
        }
        const userId = userResult.rows[0].id

        // Store stripe_customer_id on users table
        await query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, userId]
        )

        // Cancel old subscription if user is upgrading (has a different sub)
        const existingPlan = await query(
          'SELECT stripe_subscription_id FROM user_plans WHERE user_id = $1',
          [userId]
        )
        const oldSubId = existingPlan.rows[0]?.stripe_subscription_id
        if (oldSubId && oldSubId !== subscriptionId) {
          await cancelSubscription(oldSubId)
        }

        // Activate new plan
        await query(
          `INSERT INTO user_plans (user_id, plan, stripe_subscription_id, stripe_price_id, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET plan = $2,
                 stripe_subscription_id = $3,
                 stripe_price_id = $4,
                 updated_at = NOW()`,
          [userId, newPlan, subscriptionId, priceId]
        )
        console.log(`✅ Plan activated via webhook: ${email} → ${newPlan}`)
        break
      }

      /* ── Subscription cancelled (user or admin via Stripe) ─── */
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const result = await query(
          `UPDATE user_plans
             SET plan = 'free',
                 stripe_subscription_id = NULL,
                 stripe_price_id = NULL,
                 updated_at = NOW()
           WHERE stripe_subscription_id = $1
           RETURNING user_id`,
          [sub.id]
        )
        if (result.rows[0]) {
          console.log(`⬇️  Plan → free (subscription deleted): user ${result.rows[0].user_id}`)
        }
        break
      }

      /* ── Subscription updated (plan switch, status change) ──── */
      case 'customer.subscription.updated': {
        const sub = event.data.object

        // Downgrade if subscription is now past_due or unpaid (payment retry exhausted)
        if (sub.status === 'past_due' || sub.status === 'unpaid') {
          const result = await query(
            `UPDATE user_plans
               SET plan = 'free',
                   stripe_subscription_id = NULL,
                   stripe_price_id = NULL,
                   updated_at = NOW()
             WHERE stripe_subscription_id = $1
             RETURNING user_id`,
            [sub.id]
          )
          if (result.rows[0]) {
            console.log(`⬇️  Plan → free (subscription ${sub.status}): user ${result.rows[0].user_id}`)
          }
          break
        }

        // Sync plan if active and price changed
        if (sub.status === 'active') {
          const priceId = sub.items.data[0]?.price?.id
          const updatedPlan = priceToPlan[priceId]
          if (updatedPlan) {
            await query(
              `UPDATE user_plans
                 SET plan = $1, stripe_price_id = $2, updated_at = NOW()
               WHERE stripe_subscription_id = $3`,
              [updatedPlan, priceId, sub.id]
            )
          }
        }
        break
      }

      /* ── Payment failed — log only, Stripe will retry ──────── */
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        console.warn(`⚠️  Payment failed for subscription ${invoice.subscription} (Stripe will retry)`)
        // We do NOT downgrade here — Stripe retries automatically (Smart Retries).
        // Downgrade only happens when subscription.updated → past_due or subscription.deleted.
        break
      }

      default:
        // Ignore other events
        break
    }

    res.json({ received: true })
  } catch (err) {
    console.error('Webhook handler error:', err)
    res.status(500).json({ error: 'Webhook handler failed' })
  }
})

/* ══════════════════════════════════════════════════════════════
   POST /stripe/portal
   Creates a Stripe Billing Portal session for the logged-in user
   so they can manage their subscription, view invoices, update
   their payment method, or cancel.
══════════════════════════════════════════════════════════════ */
router.post('/portal', requireAuth, async (req, res) => {
  const stripe = getStripe()
  if (!stripe) {
    return res.status(503).json({ error: 'Billing portal not configured' })
  }

  try {
    const userResult = await query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    )
    const customerId = userResult.rows[0]?.stripe_customer_id

    if (!customerId) {
      return res.status(404).json({
        error: 'No billing account found. If you have a paid subscription, please contact contact@teenstartupfinder.com',
      })
    }

    const returnUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/#settings`
      : 'https://app.teenstartupfinder.com/#settings'

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe portal error:', err)
    res.status(500).json({ error: 'Failed to create billing portal session' })
  }
})

export default router
