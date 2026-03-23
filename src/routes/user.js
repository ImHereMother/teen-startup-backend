import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /user/profile
router.get('/profile', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.display_name, u.tagline, u.avatar_url,
              u.member_since, u.created_at, u.last_seen_at,
              COALESCE(up.plan, 'free') AS plan
       FROM users u
       LEFT JOIN user_plans up ON up.user_id = u.id
       WHERE u.id = $1`,
      [req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('GET profile error:', err)
    res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

// PATCH /user/profile
router.patch('/profile', async (req, res) => {
  try {
    const { display_name, tagline, avatar_url } = req.body
    const result = await query(
      `UPDATE users SET
         display_name = COALESCE($1, display_name),
         tagline = COALESCE($2, tagline),
         avatar_url = COALESCE($3, avatar_url)
       WHERE id = $4
       RETURNING id, email, display_name, tagline, avatar_url`,
      [display_name || null, tagline || null, avatar_url || null, req.userId]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('PATCH profile error:', err)
    res.status(500).json({ error: 'Failed to update profile' })
  }
})

// GET /user/plan
router.get('/plan', async (req, res) => {
  try {
    const result = await query(
      `SELECT COALESCE(plan, 'free') AS plan FROM user_plans WHERE user_id = $1`,
      [req.userId]
    )
    res.json({ plan: result.rows[0]?.plan || 'free' })
  } catch (err) {
    console.error('GET plan error:', err)
    res.status(500).json({ error: 'Failed to fetch plan' })
  }
})

// PUT /user/plan
router.put('/plan', async (req, res) => {
  try {
    const { plan } = req.body
    const valid = ['free', 'starter', 'pro']
    if (!valid.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be free, starter, or pro' })
    }
    const result = await query(
      `INSERT INTO user_plans (user_id, plan) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan
       RETURNING plan`,
      [req.userId, plan]
    )
    res.json({ plan: result.rows[0].plan })
  } catch (err) {
    console.error('PUT plan error:', err)
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

// GET /user/quiz
router.get('/quiz', async (req, res) => {
  try {
    const result = await query(
      'SELECT quiz_data, completed_at FROM user_quiz WHERE user_id = $1',
      [req.userId]
    )
    if (!result.rows[0]) return res.json({ completed: false, data: null })
    res.json({ completed: true, data: result.rows[0].quiz_data, completedAt: result.rows[0].completed_at })
  } catch (err) {
    console.error('GET quiz error:', err)
    res.status(500).json({ error: 'Failed to fetch quiz' })
  }
})

// POST /user/quiz
router.post('/quiz', async (req, res) => {
  try {
    const { data } = req.body
    await query(
      `INSERT INTO user_quiz (user_id, quiz_data, completed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET quiz_data = $2, completed_at = NOW()`,
      [req.userId, JSON.stringify(data)]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('POST quiz error:', err)
    res.status(500).json({ error: 'Failed to save quiz' })
  }
})

// GET /user/favorites
router.get('/favorites', async (req, res) => {
  try {
    const result = await query(
      'SELECT idea_id, created_at FROM user_favorites WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET favorites error:', err)
    res.status(500).json({ error: 'Failed to fetch favorites' })
  }
})

// POST /user/favorites
router.post('/favorites', async (req, res) => {
  try {
    const { idea_id } = req.body
    if (!idea_id) return res.status(400).json({ error: 'idea_id is required' })
    await query(
      `INSERT INTO user_favorites (user_id, idea_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, idea_id) DO NOTHING`,
      [req.userId, idea_id]
    )
    res.status(201).json({ success: true })
  } catch (err) {
    console.error('POST favorites error:', err)
    res.status(500).json({ error: 'Failed to add favorite' })
  }
})

// DELETE /user/favorites
router.delete('/favorites', async (req, res) => {
  try {
    const { idea_id } = req.body
    if (!idea_id) return res.status(400).json({ error: 'idea_id is required' })
    await query(
      'DELETE FROM user_favorites WHERE user_id = $1 AND idea_id = $2',
      [req.userId, idea_id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE favorites error:', err)
    res.status(500).json({ error: 'Failed to remove favorite' })
  }
})

// GET /user/tracked
router.get('/tracked', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, idea_id, status, stage_key, roadmap_data, started_at, closed_at, updated_at
       FROM user_tracked WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET tracked error:', err)
    res.status(500).json({ error: 'Failed to fetch tracked ideas' })
  }
})

// POST /user/tracked
router.post('/tracked', async (req, res) => {
  try {
    const { idea_id, stage_key } = req.body
    if (!idea_id) return res.status(400).json({ error: 'idea_id is required' })
    const id = uuidv4()
    const result = await query(
      `INSERT INTO user_tracked (id, user_id, idea_id, status, stage_key, started_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
       ON CONFLICT (user_id, idea_id) DO UPDATE SET status = 'active', updated_at = NOW()
       RETURNING *`,
      [id, req.userId, idea_id, stage_key || null]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('POST tracked error:', err)
    res.status(500).json({ error: 'Failed to track idea' })
  }
})

// DELETE /user/tracked
router.delete('/tracked', async (req, res) => {
  try {
    const { idea_id } = req.body
    if (!idea_id) return res.status(400).json({ error: 'idea_id is required' })
    await query(
      'DELETE FROM user_tracked WHERE user_id = $1 AND idea_id = $2',
      [req.userId, idea_id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE tracked error:', err)
    res.status(500).json({ error: 'Failed to untrack idea' })
  }
})

// PATCH /user/tracked/:id/close
router.patch('/tracked/:id/close', async (req, res) => {
  try {
    const result = await query(
      `UPDATE user_tracked SET status = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Tracked idea not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PATCH tracked/close error:', err)
    res.status(500).json({ error: 'Failed to close tracked idea' })
  }
})

// PATCH /user/tracked/:id/reset
router.patch('/tracked/:id/reset', async (req, res) => {
  try {
    const result = await query(
      `UPDATE user_tracked SET status = 'active', closed_at = NULL, stage_key = NULL,
         roadmap_data = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Tracked idea not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PATCH tracked/reset error:', err)
    res.status(500).json({ error: 'Failed to reset tracked idea' })
  }
})

// PUT /user/roadmap/:ideaId/:stageKey
router.put('/roadmap/:ideaId/:stageKey', async (req, res) => {
  try {
    const { ideaId, stageKey } = req.params
    const { data } = req.body
    const result = await query(
      `UPDATE user_tracked SET stage_key = $1, roadmap_data = $2, updated_at = NOW()
       WHERE idea_id = $3 AND user_id = $4 RETURNING *`,
      [stageKey, JSON.stringify(data || {}), ideaId, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Tracked idea not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PUT roadmap error:', err)
    res.status(500).json({ error: 'Failed to update roadmap' })
  }
})

// GET /user/badges
router.get('/badges', async (req, res) => {
  try {
    const result = await query(
      'SELECT badge_id, earned_at FROM user_badges WHERE user_id = $1 ORDER BY earned_at DESC',
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET badges error:', err)
    res.status(500).json({ error: 'Failed to fetch badges' })
  }
})

// POST /user/badges
router.post('/badges', async (req, res) => {
  try {
    const { badge_id } = req.body
    if (!badge_id) return res.status(400).json({ error: 'badge_id is required' })
    await query(
      `INSERT INTO user_badges (user_id, badge_id, earned_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, badge_id) DO NOTHING`,
      [req.userId, badge_id]
    )
    res.status(201).json({ success: true })
  } catch (err) {
    console.error('POST badges error:', err)
    res.status(500).json({ error: 'Failed to award badge' })
  }
})

// GET /user/streak
router.get('/streak', async (req, res) => {
  try {
    const result = await query(
      'SELECT current_streak, longest_streak, last_active FROM user_streaks WHERE user_id = $1',
      [req.userId]
    )
    if (!result.rows[0]) return res.json({ currentStreak: 0, longestStreak: 0, lastActive: null })
    const { current_streak, longest_streak, last_active } = result.rows[0]
    res.json({ currentStreak: current_streak, longestStreak: longest_streak, lastActive: last_active })
  } catch (err) {
    console.error('GET streak error:', err)
    res.status(500).json({ error: 'Failed to fetch streak' })
  }
})

// PUT /user/streak
router.put('/streak', async (req, res) => {
  try {
    const { current_streak, longest_streak } = req.body
    await query(
      `INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         current_streak = $2,
         longest_streak = GREATEST(user_streaks.longest_streak, $3),
         last_active = NOW()`,
      [req.userId, current_streak || 0, longest_streak || 0]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('PUT streak error:', err)
    res.status(500).json({ error: 'Failed to update streak' })
  }
})

// GET /user/earnings
router.get('/earnings', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, amount, description, category, date, created_at
       FROM user_earnings WHERE user_id = $1 ORDER BY date DESC`,
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET earnings error:', err)
    res.status(500).json({ error: 'Failed to fetch earnings' })
  }
})

// POST /user/earnings
router.post('/earnings', async (req, res) => {
  try {
    const { amount, description, category, date } = req.body
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' })
    const id = uuidv4()
    const result = await query(
      `INSERT INTO user_earnings (id, user_id, amount, description, category, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [id, req.userId, amount, description || null, category || null, date || new Date()]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('POST earnings error:', err)
    res.status(500).json({ error: 'Failed to add earning' })
  }
})

// DELETE /user/earnings
router.delete('/earnings', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return res.status(400).json({ error: 'id is required' })
    const result = await query(
      'DELETE FROM user_earnings WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Earning not found' })
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE earnings error:', err)
    res.status(500).json({ error: 'Failed to delete earning' })
  }
})

// GET /user/tasks
router.get('/tasks', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, title, description, status, priority, due_date, idea_id, created_at, updated_at
       FROM user_tasks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET tasks error:', err)
    res.status(500).json({ error: 'Failed to fetch tasks' })
  }
})

// POST /user/tasks
router.post('/tasks', async (req, res) => {
  try {
    const { title, description, priority, due_date, idea_id } = req.body
    if (!title) return res.status(400).json({ error: 'title is required' })
    const id = uuidv4()
    const result = await query(
      `INSERT INTO user_tasks (id, user_id, title, description, status, priority, due_date, idea_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, NOW(), NOW()) RETURNING *`,
      [id, req.userId, title, description || null, priority || 'medium', due_date || null, idea_id || null]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('POST tasks error:', err)
    res.status(500).json({ error: 'Failed to create task' })
  }
})

// PATCH /user/tasks
router.patch('/tasks', async (req, res) => {
  try {
    const { id, title, description, status, priority, due_date } = req.body
    if (!id) return res.status(400).json({ error: 'id is required' })
    const result = await query(
      `UPDATE user_tasks SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         priority = COALESCE($4, priority),
         due_date = COALESCE($5, due_date),
         updated_at = NOW()
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [title || null, description || null, status || null, priority || null, due_date || null, id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PATCH tasks error:', err)
    res.status(500).json({ error: 'Failed to update task' })
  }
})

// DELETE /user/tasks
router.delete('/tasks', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return res.status(400).json({ error: 'id is required' })
    const result = await query(
      'DELETE FROM user_tasks WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' })
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE tasks error:', err)
    res.status(500).json({ error: 'Failed to delete task' })
  }
})

// GET /user/goals
router.get('/goals', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM user_goals WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET goals error:', err)
    res.status(500).json({ error: 'Failed to fetch goals' })
  }
})

// PUT /user/goals
router.put('/goals', async (req, res) => {
  try {
    const { goals } = req.body
    if (!Array.isArray(goals)) return res.status(400).json({ error: 'goals must be an array' })

    await query('DELETE FROM user_goals WHERE user_id = $1', [req.userId])

    if (goals.length > 0) {
      const values = goals.map((g, i) => {
        const id = uuidv4()
        return `('${id}', $1, '${(g.title || '').replace(/'/g, "''")}', '${(g.description || '').replace(/'/g, "''")}', '${g.target_date || ''}', NOW())`
      })
      await query(
        `INSERT INTO user_goals (id, user_id, title, description, target_date, created_at) VALUES ${values.join(',')}`,
        [req.userId]
      )
    }

    const result = await query('SELECT * FROM user_goals WHERE user_id = $1 ORDER BY created_at DESC', [req.userId])
    res.json(result.rows)
  } catch (err) {
    console.error('PUT goals error:', err)
    res.status(500).json({ error: 'Failed to update goals' })
  }
})

// POST /user/events — batch event logging
router.post('/events', async (req, res) => {
  try {
    const { events } = req.body
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array' })
    }
    if (events.length > 100) {
      return res.status(400).json({ error: 'Max 100 events per batch' })
    }

    const rows = events.map(e => ({
      id: uuidv4(),
      userId: req.userId,
      type: e.type || 'unknown',
      data: JSON.stringify(e.data || {}),
      occurredAt: e.occurred_at || new Date(),
    }))

    const placeholders = rows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    const values = rows.flatMap(r => [r.id, r.userId, r.type, r.data])

    await query(
      `INSERT INTO user_events (id, user_id, type, data) VALUES ${placeholders.join(',')}`,
      values
    )

    res.status(201).json({ inserted: rows.length })
  } catch (err) {
    console.error('POST events error:', err)
    res.status(500).json({ error: 'Failed to log events' })
  }
})

export default router
