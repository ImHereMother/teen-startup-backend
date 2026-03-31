import { Router } from 'express'
import { query } from '../db.js'
import { requireAdmin } from '../middleware/auth.js'
import { cancelSubscription } from '../stripe.js'

const router = Router()
router.use(requireAdmin)

// GET /admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      planBreakdown,
      activeToday,
      activeWeek,
      topEvents,
      aiUsage,
      ratingStats,
      ratingDist,
    ] = await Promise.all([
      query('SELECT COUNT(*) as count FROM users'),
      query(`
        SELECT COALESCE(up.plan, 'free') as plan, COUNT(*) as count
        FROM users u
        LEFT JOIN user_plans up ON up.user_id = u.id
        WHERE NOT (COALESCE(up.mrr_excluded, FALSE) AND (up.mrr_excluded_until IS NULL OR up.mrr_excluded_until > NOW()))
          AND (up.plan_expires_at IS NULL OR up.plan_expires_at <= NOW())
        GROUP BY COALESCE(up.plan, 'free')
        ORDER BY count DESC
      `),
      query(`SELECT COUNT(DISTINCT user_id) as count FROM user_events WHERE occurred_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(DISTINCT user_id) as count FROM user_events WHERE occurred_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT type, COUNT(*) as count FROM user_events GROUP BY type ORDER BY count DESC LIMIT 10`),
      query(`SELECT COUNT(*) as total_messages,
               SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
               SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens
             FROM ai_messages`),
      query(`SELECT ROUND(AVG(stars)::numeric, 1) as avg, COUNT(*) as count FROM user_ratings`),
      query(`SELECT stars, COUNT(*) as count FROM user_ratings GROUP BY stars ORDER BY stars DESC`),
    ])

    const planRevenue = {
      free: 0,
      starter: 3,
      pro: 8,
    }
    const mrr = planBreakdown.rows.reduce((sum, row) => {
      return sum + (planRevenue[row.plan] || 0) * parseInt(row.count, 10)
    }, 0)

    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count, 10),
      planBreakdown: planBreakdown.rows,
      activeToday: parseInt(activeToday.rows[0].count, 10),
      activeWeek: parseInt(activeWeek.rows[0].count, 10),
      topEvents: topEvents.rows,
      aiUsage: aiUsage.rows[0],
      mrr: mrr.toFixed(2),
      ratingAvg: ratingStats.rows[0]?.avg ? parseFloat(ratingStats.rows[0].avg) : null,
      ratingCount: parseInt(ratingStats.rows[0]?.count || 0),
      ratingDistribution: ratingDist.rows,
    })
  } catch (err) {
    console.error('GET admin/stats error:', err)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

// GET /admin/users
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(100, parseInt(req.query.limit) || 20)
    const offset = (page - 1) * limit
    const search = req.query.search || ''

    // Whitelist sortable columns to prevent SQL injection
    const SORT_COLS = { email: 'u.email', display_name: 'u.display_name', plan: 'COALESCE(up.plan,\'free\')', created_at: 'u.created_at', last_seen_at: 'u.last_seen_at' }
    const sortBy  = SORT_COLS[req.query.sortBy]  || 'u.created_at'
    const sortDir = req.query.sortDir === 'asc'  ? 'ASC' : 'DESC'

    const conditions = []
    const listParams  = [limit, offset]
    const countParams = []

    if (search) {
      listParams.push(`%${search}%`)
      countParams.push(`%${search}%`)
      conditions.push(`(u.email ILIKE $${listParams.length} OR u.display_name ILIKE $${listParams.length})`)
    }

    const VALID_PLANS = ['free', 'starter', 'pro']
    if (req.query.plan && VALID_PLANS.includes(req.query.plan)) {
      listParams.push(req.query.plan)
      countParams.push(req.query.plan)
      conditions.push(`COALESCE(up.plan, 'free') = $${listParams.length}`)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [users, total] = await Promise.all([
      query(
        `SELECT u.id, u.email, u.display_name, COALESCE(up.plan, 'free') as plan,
                u.created_at, u.last_seen_at
         FROM users u
         LEFT JOIN user_plans up ON up.user_id = u.id
         ${whereClause}
         ORDER BY ${sortBy} ${sortDir} LIMIT $1 OFFSET $2`,
        listParams
      ),
      query(
        `SELECT COUNT(*) as count FROM users u ${whereClause}`,
        countParams
      ),
    ])

    res.json({
      users: users.rows,
      total: parseInt(total.rows[0].count, 10),
      page,
      limit,
      pages: Math.ceil(parseInt(total.rows[0].count, 10) / limit),
    })
  } catch (err) {
    console.error('GET admin/users error:', err)
    res.status(500).json({ error: 'Failed to fetch users' })
  }
})

// GET /admin/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const [user, events, aiMessages, favorites, tracked] = await Promise.all([
      query(
        `SELECT u.*, COALESCE(up.plan, 'free') as plan
         FROM users u
         LEFT JOIN user_plans up ON up.user_id = u.id
         WHERE u.id = $1`,
        [req.params.id]
      ),
      query(
        `SELECT type, COUNT(*) as count FROM user_events WHERE user_id = $1 GROUP BY type ORDER BY count DESC`,
        [req.params.id]
      ),
      query(
        `SELECT COUNT(*) as count FROM ai_messages WHERE user_id = $1 AND role = 'user'`,
        [req.params.id]
      ),
      query('SELECT COUNT(*) as count FROM user_favorites WHERE user_id = $1', [req.params.id]),
      query('SELECT COUNT(*) as count FROM user_tracked WHERE user_id = $1', [req.params.id]),
    ])

    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' })

    res.json({
      ...user.rows[0],
      eventSummary: events.rows,
      aiMessageCount: parseInt(aiMessages.rows[0].count, 10),
      favoriteCount: parseInt(favorites.rows[0].count, 10),
      trackedCount: parseInt(tracked.rows[0].count, 10),
    })
  } catch (err) {
    console.error('GET admin/users/:id error:', err)
    res.status(500).json({ error: 'Failed to fetch user' })
  }
})

// PATCH /admin/users/:id/plan
router.patch('/users/:id/plan', async (req, res) => {
  try {
    const { plan } = req.body
    const valid = ['free', 'starter', 'pro']
    if (!valid.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' })
    }

    // Check user exists
    const userCheck = await query('SELECT id, email FROM users WHERE id = $1', [req.params.id])
    if (!userCheck.rows[0]) return res.status(404).json({ error: 'User not found' })

    let subscriptionCancelled = false

    // When force-downgrading to free, cancel their Stripe subscription
    if (plan === 'free') {
      const subResult = await query(
        'SELECT stripe_subscription_id FROM user_plans WHERE user_id = $1',
        [req.params.id]
      )
      const subscriptionId = subResult.rows[0]?.stripe_subscription_id
      subscriptionCancelled = await cancelSubscription(subscriptionId)

      // Clear Stripe fields + expiry when going to free
      await query(
        `INSERT INTO user_plans (user_id, plan, plan_expires_at, stripe_subscription_id, stripe_price_id, updated_at)
         VALUES ($1, 'free', NULL, NULL, NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET plan = 'free',
               plan_expires_at = NULL,
               stripe_subscription_id = NULL,
               stripe_price_id = NULL,
               updated_at = NOW()`,
        [req.params.id]
      )
    } else {
      // Paid plan override (admin granting access) — clear expiry, don't touch Stripe fields
      await query(
        `INSERT INTO user_plans (user_id, plan, plan_expires_at, updated_at)
         VALUES ($1, $2, NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE SET plan = $2, plan_expires_at = NULL, updated_at = NOW()`,
        [req.params.id, plan]
      )
    }

    res.json({ id: req.params.id, email: userCheck.rows[0].email, plan, subscriptionCancelled })
  } catch (err) {
    console.error('PATCH admin/users/:id/plan error:', err)
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

// DELETE /admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    // Fetch Stripe subscription before deleting (cascade will wipe user_plans)
    const subResult = await query(
      'SELECT stripe_subscription_id FROM user_plans WHERE user_id = $1',
      [req.params.id]
    )
    const subscriptionId = subResult.rows[0]?.stripe_subscription_id

    // Cancel Stripe subscription so the user stops being charged
    const subscriptionCancelled = await cancelSubscription(subscriptionId)

    // Delete user (cascades to all child tables via ON DELETE CASCADE)
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })

    res.json({ success: true, deleted: result.rows[0].id, subscriptionCancelled })
  } catch (err) {
    console.error('DELETE admin/users/:id error:', err)
    res.status(500).json({ error: 'Failed to delete user' })
  }
})

// GET /admin/events
router.get('/events', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(200, parseInt(req.query.limit) || 50)
    const offset = (page - 1) * limit
    const type = req.query.type || null

    const params = [limit, offset]
    let typeFilter = ''
    if (type) {
      params.push(type)
      typeFilter = `WHERE type = $${params.length}`
    }

    const [events, total] = await Promise.all([
      query(
        `SELECT e.id, e.user_id, e.type, e.data, e.occurred_at, u.email
         FROM user_events e LEFT JOIN users u ON u.id = e.user_id
         ${typeFilter} ORDER BY e.occurred_at DESC LIMIT $1 OFFSET $2`,
        params
      ),
      query(
        `SELECT COUNT(*) as count FROM user_events ${typeFilter}`,
        type ? [type] : []
      ),
    ])

    res.json({
      events: events.rows,
      total: parseInt(total.rows[0].count, 10),
      page,
      limit,
    })
  } catch (err) {
    console.error('GET admin/events error:', err)
    res.status(500).json({ error: 'Failed to fetch events' })
  }
})

// GET /admin/events/chart — daily counts for last 30 days
router.get('/events/chart', async (req, res) => {
  try {
    const result = await query(
      `SELECT DATE(occurred_at) as date, COUNT(*) as count
       FROM user_events
       WHERE occurred_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(occurred_at)
       ORDER BY date ASC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET admin/events/chart error:', err)
    res.status(500).json({ error: 'Failed to fetch event chart data' })
  }
})

// GET /admin/events/types
router.get('/events/types', async (req, res) => {
  try {
    const result = await query(
      `SELECT type, COUNT(*) as count FROM user_events GROUP BY type ORDER BY count DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET admin/events/types error:', err)
    res.status(500).json({ error: 'Failed to fetch event types' })
  }
})

// GET /admin/retention — D1/D7/D30
router.get('/retention', async (req, res) => {
  try {
    const [d1, d7, d30, newUsers] = await Promise.all([
      query(`SELECT COUNT(DISTINCT e.user_id) as count
             FROM user_events e
             JOIN users u ON u.id = e.user_id
             WHERE u.created_at >= NOW() - INTERVAL '2 days'
               AND u.created_at < NOW() - INTERVAL '1 day'
               AND e.occurred_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(DISTINCT e.user_id) as count
             FROM user_events e
             JOIN users u ON u.id = e.user_id
             WHERE u.created_at >= NOW() - INTERVAL '8 days'
               AND u.created_at < NOW() - INTERVAL '7 days'
               AND e.occurred_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT COUNT(DISTINCT e.user_id) as count
             FROM user_events e
             JOIN users u ON u.id = e.user_id
             WHERE u.created_at >= NOW() - INTERVAL '31 days'
               AND u.created_at < NOW() - INTERVAL '30 days'
               AND e.occurred_at >= NOW() - INTERVAL '30 days'`),
      query(`SELECT
               (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '2 days' AND created_at < NOW() - INTERVAL '1 day') as d1_cohort,
               (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '8 days' AND created_at < NOW() - INTERVAL '7 days') as d7_cohort,
               (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '31 days' AND created_at < NOW() - INTERVAL '30 days') as d30_cohort`),
    ])

    const d1Cohort = parseInt(newUsers.rows[0].d1_cohort, 10) || 1
    const d7Cohort = parseInt(newUsers.rows[0].d7_cohort, 10) || 1
    const d30Cohort = parseInt(newUsers.rows[0].d30_cohort, 10) || 1

    res.json({
      d1: {
        retained: parseInt(d1.rows[0].count, 10),
        cohort: d1Cohort,
        rate: ((parseInt(d1.rows[0].count, 10) / d1Cohort) * 100).toFixed(1) + '%',
      },
      d7: {
        retained: parseInt(d7.rows[0].count, 10),
        cohort: d7Cohort,
        rate: ((parseInt(d7.rows[0].count, 10) / d7Cohort) * 100).toFixed(1) + '%',
      },
      d30: {
        retained: parseInt(d30.rows[0].count, 10),
        cohort: d30Cohort,
        rate: ((parseInt(d30.rows[0].count, 10) / d30Cohort) * 100).toFixed(1) + '%',
      },
    })
  } catch (err) {
    console.error('GET admin/retention error:', err)
    res.status(500).json({ error: 'Failed to fetch retention data' })
  }
})

// GET /admin/revenue — MRR by plan (excludes mrr_excluded users)
router.get('/revenue', async (req, res) => {
  try {
    const planPrices = { free: 0, starter: 3, pro: 8 }

    // Exclude: mrr_excluded users AND users on temporary referral plans (plan_expires_at set)
    const [result, excludedCount] = await Promise.all([
      query(
        `SELECT COALESCE(up.plan, 'free') as plan, COUNT(*) as users
         FROM users u
         LEFT JOIN user_plans up ON up.user_id = u.id
         WHERE NOT (COALESCE(up.mrr_excluded, FALSE) AND (up.mrr_excluded_until IS NULL OR up.mrr_excluded_until > NOW()))
           AND (up.plan_expires_at IS NULL OR up.plan_expires_at <= NOW())
         GROUP BY COALESCE(up.plan, 'free')`
      ),
      query(`SELECT COUNT(*) as count FROM user_plans WHERE mrr_excluded = TRUE AND (mrr_excluded_until IS NULL OR mrr_excluded_until > NOW())`),
    ])

    const breakdown = result.rows.map(row => ({
      plan: row.plan,
      users: parseInt(row.users, 10),
      pricePerUser: planPrices[row.plan] || 0,
      mrr: ((planPrices[row.plan] || 0) * parseInt(row.users, 10)).toFixed(2),
    }))

    const totalMrr = breakdown.reduce((sum, r) => sum + parseFloat(r.mrr), 0)

    res.json({
      breakdown,
      totalMrr: totalMrr.toFixed(2),
      arr: (totalMrr * 12).toFixed(2),
      excludedCount: parseInt(excludedCount.rows[0].count, 10),
    })
  } catch (err) {
    console.error('GET admin/revenue error:', err)
    res.status(500).json({ error: 'Failed to fetch revenue data' })
  }
})

// GET /admin/revenue/snapshots — list all MRR zero operations
router.get('/revenue/snapshots', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, created_at, restored_at, user_count, mrr_before, changes
       FROM mrr_snapshots ORDER BY created_at DESC LIMIT 365`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET admin/revenue/snapshots error:', err)
    res.status(500).json({ error: 'Failed to fetch snapshots' })
  }
})

// GET /admin/revenue/excluded — list all users currently excluded from MRR (active exclusions only)
router.get('/revenue/excluded', async (req, res) => {
  try {
    const result = await query(
      `SELECT up.user_id, u.email, u.display_name, up.plan, up.updated_at, up.mrr_excluded_until
       FROM user_plans up
       JOIN users u ON u.id = up.user_id
       WHERE up.mrr_excluded = TRUE AND (up.mrr_excluded_until IS NULL OR up.mrr_excluded_until > NOW())
       ORDER BY up.updated_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET admin/revenue/excluded error:', err)
    res.status(500).json({ error: 'Failed to fetch excluded users' })
  }
})

// POST /admin/revenue/exclude-user — exclude a specific user by email with optional duration
router.post('/revenue/exclude-user', async (req, res) => {
  try {
    const { email, duration } = req.body
    if (!email) return res.status(400).json({ error: 'Email required' })

    const user = await query(`SELECT id FROM users WHERE email = $1`, [email.trim().toLowerCase()])
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const userId = user.rows[0].id

    // Compute expiry based on duration
    let excludedUntil = null
    if (duration === 'month') {
      // End of current calendar month
      const now = new Date()
      excludedUntil = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    } else if (duration === '30d') {
      excludedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    } else if (duration === '90d') {
      excludedUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    }
    // 'permanent' or undefined → excludedUntil stays null

    await query(
      `INSERT INTO user_plans (user_id, plan, mrr_excluded, mrr_excluded_until, updated_at)
       VALUES ($1, 'free', TRUE, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET mrr_excluded = TRUE, mrr_excluded_until = $2, updated_at = NOW()`,
      [userId, excludedUntil]
    )

    const updated = await query(
      `SELECT up.user_id, u.email, u.display_name, up.plan, up.mrr_excluded_until
       FROM user_plans up JOIN users u ON u.id = up.user_id WHERE up.user_id = $1`,
      [userId]
    )
    res.json(updated.rows[0])
  } catch (err) {
    console.error('POST admin/revenue/exclude-user error:', err)
    res.status(500).json({ error: 'Failed to exclude user' })
  }
})

// DELETE /admin/revenue/exclude-user/:userId — include user back in MRR
router.delete('/revenue/exclude-user/:userId', async (req, res) => {
  try {
    await query(
      `UPDATE user_plans SET mrr_excluded = FALSE, updated_at = NOW() WHERE user_id = $1`,
      [req.params.userId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE admin/revenue/exclude-user error:', err)
    res.status(500).json({ error: 'Failed to include user' })
  }
})

// POST /admin/revenue/zero — exclude all currently paid users from MRR (plan unchanged)
router.post('/revenue/zero', async (req, res) => {
  try {
    const planPrices = { starter: 3, pro: 8 }

    // Find all paid users not already excluded
    const paid = await query(
      `SELECT up.user_id, u.email, up.plan
       FROM user_plans up
       JOIN users u ON u.id = up.user_id
       WHERE up.plan IN ('starter', 'pro') AND NOT COALESCE(up.mrr_excluded, FALSE)`
    )

    if (paid.rows.length === 0) {
      return res.status(400).json({ error: 'No paid users to zero' })
    }

    const changes = paid.rows.map(r => ({ user_id: r.user_id, email: r.email, plan: r.plan }))
    const mrrBefore = paid.rows.reduce((sum, r) => sum + (planPrices[r.plan] || 0), 0)
    const userIds = paid.rows.map(r => r.user_id)

    // Default expiry: first day of next month (end of current calendar month)
    const now = new Date()
    const excludedUntil = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

    // Mark them as excluded until end of month (plan is NOT changed)
    await query(
      `UPDATE user_plans SET mrr_excluded = TRUE, mrr_excluded_until = $2, updated_at = NOW()
       WHERE user_id = ANY($1::uuid[])`,
      [userIds, excludedUntil]
    )

    const snap = await query(
      `INSERT INTO mrr_snapshots (user_count, mrr_before, changes)
       VALUES ($1, $2, $3) RETURNING *`,
      [paid.rows.length, mrrBefore.toFixed(2), JSON.stringify(changes)]
    )

    res.json({ snapshot: snap.rows[0], zeroed: paid.rows.length })
  } catch (err) {
    console.error('POST admin/revenue/zero error:', err)
    res.status(500).json({ error: 'Failed to zero MRR' })
  }
})

// POST /admin/revenue/snapshots/:id/restore — re-include only the users zeroed in this snapshot
router.post('/revenue/snapshots/:id/restore', async (req, res) => {
  try {
    const snap = await query(`SELECT * FROM mrr_snapshots WHERE id = $1`, [req.params.id])
    if (snap.rows.length === 0) return res.status(404).json({ error: 'Snapshot not found' })

    const { changes } = snap.rows[0]
    if (!changes || changes.length === 0) return res.status(400).json({ error: 'Nothing to restore' })

    const userIds = changes.map(c => c.user_id)

    // Remove exclusion flag for only these users
    await query(
      `UPDATE user_plans SET mrr_excluded = FALSE, updated_at = NOW()
       WHERE user_id = ANY($1::uuid[])`,
      [userIds]
    )

    await query(`UPDATE mrr_snapshots SET restored_at = NOW() WHERE id = $1`, [req.params.id])
    res.json({ restored: changes.length })
  } catch (err) {
    console.error('POST admin/revenue/snapshots restore error:', err)
    res.status(500).json({ error: 'Failed to restore snapshot' })
  }
})

// GET /admin/ai-usage
router.get('/ai-usage', async (req, res) => {
  try {
    const [overall, byPlan, topUsers, daily] = await Promise.all([
      query(`SELECT
               COUNT(*) as total_messages,
               SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
               SUM(COALESCE(input_tokens, 0)) as total_input_tokens,
               SUM(COALESCE(output_tokens, 0)) as total_output_tokens
             FROM ai_messages`),
      query(`SELECT COALESCE(up.plan, 'free') as plan, COUNT(m.id) as messages, COUNT(DISTINCT m.user_id) as users
             FROM ai_messages m
             JOIN users u ON u.id = m.user_id
             LEFT JOIN user_plans up ON up.user_id = u.id
             WHERE m.role = 'user'
             GROUP BY COALESCE(up.plan, 'free') ORDER BY messages DESC`),
      query(`SELECT m.user_id, u.email, COUNT(*) as messages
             FROM ai_messages m JOIN users u ON u.id = m.user_id
             WHERE m.role = 'user'
             GROUP BY m.user_id, u.email
             ORDER BY messages DESC LIMIT 10`),
      query(`SELECT DATE(created_at) as date, COUNT(*) as messages
             FROM ai_messages
             WHERE role = 'user' AND created_at >= NOW() - INTERVAL '30 days'
             GROUP BY DATE(created_at) ORDER BY date ASC`),
    ])

    res.json({
      overall: overall.rows[0],
      byPlan: byPlan.rows,
      topUsers: topUsers.rows,
      dailyLast30: daily.rows,
    })
  } catch (err) {
    console.error('GET admin/ai-usage error:', err)
    res.status(500).json({ error: 'Failed to fetch AI usage' })
  }
})

// GET /admin/charts?metric=signups|active|events|ai&range=7d|30d|90d|6m|1y
router.get('/charts', async (req, res) => {
  const metric = req.query.metric || 'signups'
  const range  = req.query.range  || '30d'

  // Inner data query per metric — returns (date::date, value::int)
  function innerSql(m, trunc, extraWhere = '') {
    const w = extraWhere ? `AND ${extraWhere}` : ''
    switch (m) {
      case 'signups': return `
        SELECT DATE_TRUNC('${trunc}', created_at)::date AS date, COUNT(*)::int AS value
        FROM users WHERE TRUE ${w} GROUP BY 1`
      case 'active': return `
        SELECT DATE_TRUNC('${trunc}', occurred_at)::date AS date, COUNT(DISTINCT user_id)::int AS value
        FROM user_events WHERE TRUE ${w} GROUP BY 1`
      case 'events': return `
        SELECT DATE_TRUNC('${trunc}', occurred_at)::date AS date, COUNT(*)::int AS value
        FROM user_events WHERE TRUE ${w} GROUP BY 1`
      case 'ai': return `
        SELECT DATE_TRUNC('${trunc}', created_at)::date AS date, COUNT(*)::int AS value
        FROM ai_messages WHERE role = 'user' ${w} GROUP BY 1`
      case 'revenue': return `
        SELECT DATE_TRUNC('${trunc}', u.created_at)::date AS date,
               SUM(CASE WHEN up.plan='starter' THEN 3 WHEN up.plan='pro' THEN 8 ELSE 0 END)::int AS value
        FROM users u
        INNER JOIN user_plans up ON up.user_id = u.id
        WHERE up.plan IN ('starter','pro') ${extraWhere ? `AND u.${extraWhere}` : ''} GROUP BY 1`
      default: return null
    }
  }

  // Build zero-filled query using generate_series
  function zeroFillSql(innerQ, trunc, seriesStart, step) {
    return `
      WITH series AS (
        SELECT generate_series(
          DATE_TRUNC('${trunc}', (${seriesStart})),
          DATE_TRUNC('${trunc}', NOW()),
          INTERVAL '${step}'
        )::date AS date
      ),
      raw AS (${innerQ})
      SELECT s.date, COALESCE(r.value, 0) AS value
      FROM series s LEFT JOIN raw r ON r.date = s.date
      ORDER BY s.date`
  }

  const VALID_METRICS = ['signups','active','events','ai','revenue']
  const VALID_RANGES  = ['7d','30d','90d','6m','1y','ytd','all']
  if (!VALID_METRICS.includes(metric)) return res.status(400).json({ error: 'Unknown metric' })
  if (!VALID_RANGES.includes(range))   return res.status(400).json({ error: 'Unknown range' })

  const dateCol = (metric === 'active' || metric === 'events') ? 'occurred_at' : 'created_at'

  try {
    let sql
    // All ranges use daily granularity — one data point per day, zero-filled
    if (range === 'all') {
      // All-time: every day that exists in DB, no zero fill (only days with actual data)
      sql = `${innerSql(metric, 'day')} ORDER BY date`
    } else if (range === 'ytd') {
      const where = `${dateCol} >= DATE_TRUNC('year', NOW())`
      sql = zeroFillSql(innerSql(metric, 'day', where), 'day', `DATE_TRUNC('year', NOW())`, '1 day')
    } else {
      const INTERVALS = {
        '7d':  '7 days',
        '30d': '30 days',
        '90d': '90 days',
        '6m':  '6 months',
        '1y':  '1 year',
      }
      const interval = INTERVALS[range]
      const where = `${dateCol} >= NOW() - INTERVAL '${interval}'`
      sql = zeroFillSql(innerSql(metric, 'day', where), 'day', `NOW() - INTERVAL '${interval}'`, '1 day')
    }

    const result = await query(sql)
    res.json(result.rows)
  } catch (err) {
    console.error('GET admin/charts error:', err)
    res.status(500).json({ error: 'Failed to fetch chart data' })
  }
})

// GET /admin/feedback — bug reports & idea suggestions
router.get('/feedback', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1)
    const limit  = Math.min(100, parseInt(req.query.limit) || 50)
    const offset = (page - 1) * limit

    const conditions  = []
    const filterVals  = []

    if (req.query.type)   { filterVals.push(req.query.type);   conditions.push(`f.type = $${filterVals.length}`) }
    if (req.query.status) { filterVals.push(req.query.status); conditions.push(`f.status = $${filterVals.length}`) }

    const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const n = filterVals.length

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT f.id, f.type, f.message, f.email, f.status, f.source, f.created_at,
                u.email AS user_email, u.display_name
         FROM feedback f
         LEFT JOIN users u ON u.id = f.user_id
         ${whereSQL}
         ORDER BY f.created_at DESC
         LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...filterVals, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM feedback f ${whereSQL}`,
        filterVals
      ),
    ])

    res.json({ feedback: rows.rows, total: countRow.rows[0]?.total || 0, page, limit })
  } catch (err) {
    console.error('GET admin/feedback error:', err)
    res.status(500).json({ error: 'Failed to fetch feedback' })
  }
})

// PATCH /admin/feedback/:id/status — mark as new or reviewed
router.patch('/feedback/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    if (!['new', 'reviewed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "new" or "reviewed"' })
    }
    const result = await query(
      `UPDATE feedback SET status = $1 WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Feedback not found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('PATCH admin/feedback/:id/status error:', err)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

// GET /admin/featured — all featured submissions with filters
router.get('/featured', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1)
    const limit  = Math.min(100, parseInt(req.query.limit) || 50)
    const offset = (page - 1) * limit

    const conditions = []
    const vals       = []

    if (req.query.status)    { vals.push(req.query.status); conditions.push(`fs.status = $${vals.length}`) }
    if (req.query.idea_id) {
      const ideaId = parseInt(req.query.idea_id, 10)
      if (!isNaN(ideaId)) { vals.push(ideaId); conditions.push(`fs.idea_id = $${vals.length}`) }
    }
    if (req.query.live_only) { conditions.push(`fs.created_at >= NOW() - INTERVAL '30 days'`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const n = vals.length

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT fs.id, fs.idea_id, fs.name, fs.handle, fs.tagline, fs.link, fs.links,
                fs.status, fs.email, fs.created_at,
                u.email AS user_email, u.display_name,
                CASE
                  WHEN fs.status = 'approved'
                  THEN GREATEST(0, EXTRACT(EPOCH FROM (fs.created_at + INTERVAL '30 days' - NOW()))::int)
                  ELSE NULL
                END AS expires_in_seconds
         FROM featured_submissions fs
         LEFT JOIN users u ON u.id = fs.user_id
         ${where}
         ORDER BY
           CASE fs.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
           fs.created_at DESC
         LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...vals, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM featured_submissions fs ${where}`,
        vals
      ),
    ])

    res.json({ featured: rows.rows, total: countRow.rows[0]?.total || 0, page, limit })
  } catch (err) {
    console.error('GET admin/featured error:', err)
    res.status(500).json({ error: 'Failed to fetch featured submissions' })
  }
})

// PATCH /admin/featured/:id/status — approve or reject
router.patch('/featured/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    if (!['pending', 'approved', 'rejected', 'removed'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, rejected, or removed' })
    }
    const result = await query(
      `UPDATE featured_submissions SET status = $1 WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Submission not found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('PATCH admin/featured error:', err)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

// GET /admin/waitlist — landing page signups
router.get('/waitlist', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1)
    const limit  = Math.min(100, parseInt(req.query.limit) || 50)
    const offset = (page - 1) * limit
    const typeFilter = req.query.type // 'waitlist' | 'early_access' | undefined

    const conditions = typeFilter ? `WHERE type = $3` : ''
    const params = typeFilter ? [limit, offset, typeFilter] : [limit, offset]
    const countParams = typeFilter ? [typeFilter] : []
    const countCond   = typeFilter ? `WHERE type = $1` : ''

    const [rows, countRow] = await Promise.all([
      query(
        `SELECT id, email, type, created_at FROM waitlist ${conditions} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        params
      ),
      query(`SELECT COUNT(*)::int as total FROM waitlist ${countCond}`, countParams),
    ])

    res.json({ signups: rows.rows, total: countRow.rows[0]?.total || 0 })
  } catch (err) {
    // Table might not exist yet, or type column doesn't exist yet — fall back gracefully
    if (err.code === '42P01' || err.code === '42703') return res.json({ signups: [], total: 0 })
    console.error('GET admin/waitlist error:', err)
    res.status(500).json({ error: 'Failed to fetch waitlist' })
  }
})

export default router
