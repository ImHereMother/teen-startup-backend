import { Router } from 'express'
import { query } from '../db.js'
import { requireAdmin } from '../middleware/auth.js'

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
    ] = await Promise.all([
      query('SELECT COUNT(*) as count FROM users'),
      query(`SELECT plan, COUNT(*) as count FROM users GROUP BY plan ORDER BY count DESC`),
      query(`SELECT COUNT(DISTINCT user_id) as count FROM user_events WHERE created_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(DISTINCT user_id) as count FROM user_events WHERE created_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT type, COUNT(*) as count FROM user_events GROUP BY type ORDER BY count DESC LIMIT 10`),
      query(`SELECT COUNT(*) as total_messages,
               SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
               SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens
             FROM ai_messages`),
    ])

    const planRevenue = {
      free: 0,
      starter: 4.99,
      pro: 12.99,
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

    let whereClause = ''
    const params = [limit, offset]

    if (search) {
      params.push(`%${search}%`)
      whereClause = `WHERE email ILIKE $${params.length} OR display_name ILIKE $${params.length}`
    }

    const [users, total] = await Promise.all([
      query(
        `SELECT id, email, display_name, plan, created_at, last_login
         FROM users ${whereClause} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        params
      ),
      query(
        `SELECT COUNT(*) as count FROM users ${whereClause}`,
        search ? [params[params.length - 1]] : []
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
      query('SELECT * FROM users WHERE id = $1', [req.params.id]),
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
    const result = await query(
      'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, plan',
      [plan, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PATCH admin/users/:id/plan error:', err)
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

// DELETE /admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ success: true, deleted: result.rows[0].id })
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
        `SELECT e.id, e.user_id, e.type, e.data, e.created_at, u.email
         FROM user_events e LEFT JOIN users u ON u.id = e.user_id
         ${typeFilter} ORDER BY e.created_at DESC LIMIT $1 OFFSET $2`,
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
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM user_events
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
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
               AND e.created_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(DISTINCT e.user_id) as count
             FROM user_events e
             JOIN users u ON u.id = e.user_id
             WHERE u.created_at >= NOW() - INTERVAL '8 days'
               AND u.created_at < NOW() - INTERVAL '7 days'
               AND e.created_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT COUNT(DISTINCT e.user_id) as count
             FROM user_events e
             JOIN users u ON u.id = e.user_id
             WHERE u.created_at >= NOW() - INTERVAL '31 days'
               AND u.created_at < NOW() - INTERVAL '30 days'
               AND e.created_at >= NOW() - INTERVAL '30 days'`),
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
    const planPrices = { free: 0, starter: 4.99, pro: 12.99 }

    const result = await query(
      `SELECT plan, COUNT(*) as users FROM users GROUP BY plan`
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
      query(`SELECT u.plan, COUNT(m.id) as messages, COUNT(DISTINCT m.user_id) as users
             FROM ai_messages m JOIN users u ON u.id = m.user_id
             WHERE m.role = 'user'
             GROUP BY u.plan ORDER BY messages DESC`),
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

export default router
