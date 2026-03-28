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

    let whereClause = ''
    const listParams = [limit, offset]
    const countParams = []

    if (search) {
      listParams.push(`%${search}%`)
      countParams.push(`%${search}%`)
      whereClause = `WHERE (u.email ILIKE $${listParams.length} OR u.display_name ILIKE $${listParams.length})`
    }

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

      // Clear Stripe fields when going to free
      await query(
        `INSERT INTO user_plans (user_id, plan, stripe_subscription_id, stripe_price_id, updated_at)
         VALUES ($1, 'free', NULL, NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET plan = 'free',
               stripe_subscription_id = NULL,
               stripe_price_id = NULL,
               updated_at = NOW()`,
        [req.params.id]
      )
    } else {
      // Paid plan override (admin granting access) — don't touch Stripe fields
      await query(
        `INSERT INTO user_plans (user_id, plan, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET plan = $2, updated_at = NOW()`,
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

// GET /admin/revenue — MRR by plan
router.get('/revenue', async (req, res) => {
  try {
    const planPrices = { free: 0, starter: 3, pro: 8 }

    const result = await query(
      `SELECT COALESCE(up.plan, 'free') as plan, COUNT(*) as users
       FROM users u
       LEFT JOIN user_plans up ON up.user_id = u.id
       GROUP BY COALESCE(up.plan, 'free')`
    )

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
    })
  } catch (err) {
    console.error('GET admin/revenue error:', err)
    res.status(500).json({ error: 'Failed to fetch revenue data' })
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
  // Whitelist of valid metric → SQL
  const METRICS = {
    signups: {
      sql: (trunc, interval) =>
        `SELECT DATE_TRUNC('${trunc}', created_at) as date, COUNT(*)::int as value
         FROM users
         WHERE created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
    },
    active: {
      sql: (trunc, interval) =>
        `SELECT DATE_TRUNC('${trunc}', occurred_at) as date, COUNT(DISTINCT user_id)::int as value
         FROM user_events
         WHERE occurred_at >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
    },
    events: {
      sql: (trunc, interval) =>
        `SELECT DATE_TRUNC('${trunc}', occurred_at) as date, COUNT(*)::int as value
         FROM user_events
         WHERE occurred_at >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
    },
    ai: {
      sql: (trunc, interval) =>
        `SELECT DATE_TRUNC('${trunc}', created_at) as date, COUNT(*)::int as value
         FROM ai_messages
         WHERE role = 'user' AND created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY 1 ORDER BY 1`,
    },
    revenue: {
      // Revenue from new paid signups per period (starter=$3, pro=$8)
      sql: (trunc, interval) =>
        `SELECT DATE_TRUNC('${trunc}', u.created_at) as date,
                SUM(CASE WHEN up.plan = 'starter' THEN 3
                         WHEN up.plan = 'pro'     THEN 8
                         ELSE 0 END)::int as value
         FROM users u
         INNER JOIN user_plans up ON up.user_id = u.id
         WHERE u.created_at >= NOW() - INTERVAL '${interval}'
           AND up.plan IN ('starter', 'pro')
         GROUP BY 1 ORDER BY 1`,
    },
  }

  // Whitelist of valid ranges → trunc unit + SQL interval
  const RANGES = {
    '7d':  { trunc: 'day',   interval: '7 days'   },
    '30d': { trunc: 'day',   interval: '30 days'  },
    '90d': { trunc: 'week',  interval: '90 days'  },
    '6m':  { trunc: 'month', interval: '6 months' },
    '1y':  { trunc: 'month', interval: '1 year'   },
  }

  const metric = req.query.metric || 'signups'
  const range  = req.query.range  || '30d'

  if (!METRICS[metric]) return res.status(400).json({ error: 'Unknown metric' })
  if (!RANGES[range])   return res.status(400).json({ error: 'Unknown range' })

  const { trunc, interval } = RANGES[range]

  try {
    const result = await query(METRICS[metric].sql(trunc, interval))
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
    if (req.query.idea_id)   { vals.push(parseInt(req.query.idea_id, 10)); conditions.push(`fs.idea_id = $${vals.length}`) }
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
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' })
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
