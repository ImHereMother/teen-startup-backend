import { Router } from 'express'
import { query }  from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

/* ─────────────────────────────────────────────────────────────
   GET /leaderboard
   Returns top 50 users ranked by:
     score = (current_streak × 3) + (longest_streak × 2) + active_days
   Also returns the requesting user's own rank and score.
   ───────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    /* Build full ranked board */
    const boardResult = await query(`
      WITH scores AS (
        SELECT
          u.id,
          u.display_name,
          u.avatar_url,
          COALESCE(s.current_streak, 0)  AS current_streak,
          COALESCE(s.longest_streak, 0)  AS longest_streak,
          COUNT(DISTINCT DATE(e.occurred_at)) AS active_days,
          (
            COALESCE(s.current_streak, 0) * 3 +
            COALESCE(s.longest_streak, 0) * 2 +
            COUNT(DISTINCT DATE(e.occurred_at))
          ) AS score
        FROM users u
        LEFT JOIN user_streaks s ON s.user_id = u.id
        LEFT JOIN user_events  e ON e.user_id = u.id
        GROUP BY u.id, u.display_name, u.avatar_url,
                 s.current_streak, s.longest_streak
      )
      SELECT
        id,
        display_name,
        avatar_url,
        current_streak,
        longest_streak,
        active_days,
        score,
        RANK() OVER (ORDER BY score DESC) AS rank
      FROM scores
      ORDER BY score DESC
      LIMIT 50
    `)

    /* Find the requesting user's row (may be outside top 50) */
    const meResult = await query(`
      WITH scores AS (
        SELECT
          u.id,
          COALESCE(s.current_streak, 0) AS current_streak,
          COALESCE(s.longest_streak, 0) AS longest_streak,
          COUNT(DISTINCT DATE(e.occurred_at)) AS active_days,
          (
            COALESCE(s.current_streak, 0) * 3 +
            COALESCE(s.longest_streak, 0) * 2 +
            COUNT(DISTINCT DATE(e.occurred_at))
          ) AS score
        FROM users u
        LEFT JOIN user_streaks s ON s.user_id = u.id
        LEFT JOIN user_events  e ON e.user_id = u.id
        GROUP BY u.id, s.current_streak, s.longest_streak
      ),
      ranked AS (
        SELECT *, RANK() OVER (ORDER BY score DESC) AS rank FROM scores
      )
      SELECT * FROM ranked WHERE id = $1
    `, [req.userId])

    const me = meResult.rows[0] || null

    res.json({
      board: boardResult.rows,
      me: me ? {
        rank:           Number(me.rank),
        score:          Number(me.score),
        current_streak: Number(me.current_streak),
        longest_streak: Number(me.longest_streak),
        active_days:    Number(me.active_days),
      } : null,
    })
  } catch (err) {
    console.error('GET /leaderboard error:', err)
    res.status(500).json({ error: 'Failed to fetch leaderboard' })
  }
})

export default router
