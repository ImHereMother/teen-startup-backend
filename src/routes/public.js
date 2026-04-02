import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

// GET /public/idea-ratings
// Returns { [idea_id]: { avg: 4.2, count: 17 } } for all rated ideas
// No auth required — used by the Discover page to show community ratings
router.get('/idea-ratings', async (req, res) => {
  try {
    const result = await query(
      `SELECT idea_id,
              ROUND(AVG(rating)::numeric, 1) AS avg,
              COUNT(*)::int AS count
       FROM idea_ratings
       GROUP BY idea_id
       HAVING COUNT(*) >= 1`
    )
    const map = {}
    result.rows.forEach(r => {
      map[r.idea_id] = { avg: parseFloat(r.avg), count: r.count }
    })
    res.json(map)
  } catch (err) {
    console.error('GET public/idea-ratings error:', err)
    res.status(500).json({ error: 'Failed to fetch ratings' })
  }
})

// GET /public/profile/:userId
// Returns a user's public profile — no auth required
router.get('/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    if (!userId || userId.length < 10) return res.status(400).json({ error: 'Invalid user ID' })

    const userResult = await query(
      `SELECT u.id, u.display_name, u.avatar_url, u.member_since, u.tagline,
              COALESCE(up.plan, 'free') AS plan
       FROM users u
       LEFT JOIN user_plans up ON up.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    )
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' })
    const user = userResult.rows[0]

    // Streak
    const streakResult = await query(
      'SELECT current_streak, longest_streak FROM user_streaks WHERE user_id = $1',
      [userId]
    )
    const streak = streakResult.rows[0] || { current_streak: 0, longest_streak: 0 }

    // Badges
    const badgesResult = await query(
      'SELECT badge_id FROM user_badges WHERE user_id = $1',
      [userId]
    )
    const badges = badgesResult.rows.map(b => b.badge_id)

    // Active tracked businesses
    const trackedResult = await query(
      `SELECT idea_id FROM user_tracked WHERE user_id = $1 AND status = 'active'`,
      [userId]
    )
    const trackedIds = trackedResult.rows.map(r => r.idea_id)

    // Total earnings
    const earningsResult = await query(
      `SELECT COALESCE(SUM(amount), 0)::float AS total FROM user_earnings WHERE user_id = $1`,
      [userId]
    )
    const totalEarnings = parseFloat(earningsResult.rows[0]?.total || 0)

    res.json({
      id:             user.id,
      display_name:   user.display_name || 'Teen Entrepreneur',
      avatar_url:     user.avatar_url || null,
      member_since:   user.member_since || null,
      tagline:        user.tagline || null,
      plan:           user.plan,
      current_streak: parseInt(streak.current_streak) || 0,
      longest_streak: parseInt(streak.longest_streak) || 0,
      badges,
      tracked_ids:    trackedIds,
      total_earnings: totalEarnings,
    })
  } catch (err) {
    console.error('GET public/profile error:', err)
    res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

export default router
