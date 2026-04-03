import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import { cancelSubscription } from '../stripe.js'
import { sendTwoFaCode } from '../email.js'

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
    let { display_name, tagline, avatar_url } = req.body
    if (display_name !== undefined && typeof display_name !== 'string') return res.status(400).json({ error: 'Invalid display_name' })
    if (tagline     !== undefined && typeof tagline     !== 'string') return res.status(400).json({ error: 'Invalid tagline' })
    if (display_name) display_name = display_name.trim().slice(0, 50)
    if (tagline)      tagline      = tagline.trim().slice(0, 160)
    // Only allow http/https avatar URLs; reject anything else
    if (avatar_url) {
      try {
        const u = new URL(avatar_url)
        if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'Invalid avatar URL' })
        avatar_url = avatar_url.slice(0, 500)
      } catch { return res.status(400).json({ error: 'Invalid avatar URL' }) }
    }
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

// PATCH /user/password
router.patch('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' })
    }
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.userId])
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })

    // If account already has a password, verify it first
    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' })
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash)
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' })
      }
    }

    const newHash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId])
    // Invalidate all other sessions so anyone who had access is kicked out
    await query('DELETE FROM user_sessions WHERE user_id = $1', [req.userId])
    res.json({ success: true })
  } catch (err) {
    console.error('PATCH password error:', err)
    res.status(500).json({ error: 'Failed to update password' })
  }
})

// GET /user/plan
router.get('/plan', async (req, res) => {
  try {
    const result = await query(
      `SELECT plan, plan_expires_at FROM user_plans WHERE user_id = $1`,
      [req.userId]
    )
    let plan = result.rows[0]?.plan || 'free'
    const expiresAt = result.rows[0]?.plan_expires_at

    // Auto-revert expired temporary plans back to free
    if (expiresAt && new Date(expiresAt) < new Date()) {
      await query(
        `UPDATE user_plans SET plan = 'free', plan_expires_at = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [req.userId]
      )
      plan = 'free'
    }

    res.json({
      plan,
      planExpiresAt: expiresAt && new Date(expiresAt) > new Date() ? expiresAt : null,
    })
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
    // Clear plan_expires_at — this is a permanent plan change (Stripe upgrade/downgrade)
    const result = await query(
      `INSERT INTO user_plans (user_id, plan, plan_expires_at, updated_at)
       VALUES ($1, $2, NULL, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET plan = EXCLUDED.plan, plan_expires_at = NULL, updated_at = NOW()
       RETURNING plan`,
      [req.userId, plan]
    )
    res.json({ plan: result.rows[0].plan })
  } catch (err) {
    console.error('PUT plan error:', err)
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

// POST /user/plan/cancel — cancel Stripe subscription + downgrade to free
// Called when user deliberately cancels/downgrades their paid plan.
router.post('/plan/cancel', async (req, res) => {
  try {
    // Get the user's current Stripe subscription ID
    const result = await query(
      'SELECT stripe_subscription_id FROM user_plans WHERE user_id = $1',
      [req.userId]
    )
    const subscriptionId = result.rows[0]?.stripe_subscription_id

    // Cancel in Stripe (non-blocking — we always update DB regardless)
    const cancelled = await cancelSubscription(subscriptionId)

    // Set plan to free and clear Stripe IDs + expiry in DB
    await query(
      `INSERT INTO user_plans (user_id, plan, plan_expires_at, stripe_subscription_id, stripe_price_id, updated_at)
       VALUES ($1, 'free', NULL, NULL, NULL, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET plan = 'free',
             plan_expires_at = NULL,
             stripe_subscription_id = NULL,
             stripe_price_id = NULL,
             updated_at = NOW()`,
      [req.userId]
    )

    res.json({ plan: 'free', subscriptionCancelled: cancelled })
  } catch (err) {
    console.error('POST plan/cancel error:', err)
    res.status(500).json({ error: 'Failed to cancel plan' })
  }
})

// GET /user/quiz
router.get('/quiz', async (req, res) => {
  try {
    const result = await query(
      'SELECT answers, completed_at FROM quiz_answers WHERE user_id = $1',
      [req.userId]
    )
    if (!result.rows[0]) return res.json({ completed: false })
    res.json({ completed: true, answers: result.rows[0].answers })
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
      `INSERT INTO quiz_answers (user_id, answers, completed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET answers = $2, completed_at = NOW()`,
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
    // Use INSERT WHERE NOT EXISTS to avoid needing a unique constraint
    await query(
      `INSERT INTO user_favorites (user_id, idea_id, created_at)
       SELECT $1, $2, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM user_favorites WHERE user_id = $1 AND idea_id = $2
       )`,
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
    // Try to update existing row first (avoids needing a unique constraint)
    const updated = await query(
      `UPDATE user_tracked SET status = 'active', updated_at = NOW()
       WHERE user_id = $1 AND idea_id = $2 RETURNING *`,
      [req.userId, idea_id]
    )
    if (updated.rows.length > 0) {
      return res.status(201).json(updated.rows[0])
    }
    // No existing row — insert fresh
    const result = await query(
      `INSERT INTO user_tracked (id, user_id, idea_id, status, stage_key, started_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, NOW(), NOW()) RETURNING *`,
      [uuidv4(), req.userId, idea_id, stage_key || null]
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
       SELECT $1, $2, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM user_badges WHERE user_id = $1 AND badge_id = $2
       )`,
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
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount < 0 || parsedAmount > 1_000_000) {
      return res.status(400).json({ error: 'amount must be a number between 0 and 1,000,000' })
    }
    const id = uuidv4()
    const result = await query(
      `INSERT INTO user_earnings (id, user_id, amount, description, category, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [id, req.userId, parsedAmount, (description || '').slice(0, 200) || null, (category || '').slice(0, 50) || null, date || new Date()]
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
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' })
    const VALID_PRIORITIES = ['low', 'medium', 'high']
    const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium'
    const id = uuidv4()
    const result = await query(
      `INSERT INTO user_tasks (id, user_id, title, description, status, priority, due_date, idea_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, NOW(), NOW()) RETURNING *`,
      [id, req.userId, title.slice(0, 200), (description || '').slice(0, 500) || null, safePriority, due_date || null, idea_id || null]
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
      // Fully parameterized — no string interpolation of user data
      for (const g of goals.slice(0, 20)) {
        await query(
          `INSERT INTO user_goals (id, user_id, title, description, target_date, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            uuidv4(),
            req.userId,
            (g.title || '').slice(0, 200),
            (g.description || '').slice(0, 500),
            g.target_date || null,
          ]
        )
      }
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

// GET /user/preferences
router.get('/preferences', async (req, res) => {
  try {
    const result = await query('SELECT preferences FROM users WHERE id = $1', [req.userId])
    res.json(result.rows[0]?.preferences || {})
  } catch (err) {
    console.error('GET preferences error:', err)
    res.status(500).json({ error: 'Failed to fetch preferences' })
  }
})

// PUT /user/preferences — deep-merges with existing so partial saves don't wipe other keys
router.put('/preferences', async (req, res) => {
  try {
    const current  = await query('SELECT preferences FROM users WHERE id = $1', [req.userId])
    const existing = current.rows[0]?.preferences || {}
    const merged   = { ...existing, ...req.body }
    await query('UPDATE users SET preferences = $1 WHERE id = $2', [JSON.stringify(merged), req.userId])
    res.json(merged)
  } catch (err) {
    console.error('PUT preferences error:', err)
    res.status(500).json({ error: 'Failed to save preferences' })
  }
})

// GET /user/notes
router.get('/notes', async (req, res) => {
  try {
    const result = await query('SELECT notes FROM users WHERE id = $1', [req.userId])
    res.json({ notes: result.rows[0]?.notes || '' })
  } catch (err) {
    console.error('GET notes error:', err)
    res.status(500).json({ error: 'Failed to get notes' })
  }
})

// PUT /user/notes
router.put('/notes', async (req, res) => {
  try {
    const { notes } = req.body
    if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' })
    await query('UPDATE users SET notes = $1 WHERE id = $2', [notes.slice(0, 10000), req.userId])
    res.json({ ok: true })
  } catch (err) {
    console.error('PUT notes error:', err)
    res.status(500).json({ error: 'Failed to save notes' })
  }
})

// PUT /user/rating — upsert star rating (1-5)
router.put('/rating', async (req, res) => {
  try {
    const { stars } = req.body
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'stars must be an integer 1-5' })
    }
    await query(
      `INSERT INTO user_ratings (user_id, stars, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET stars = $2, updated_at = NOW()`,
      [req.userId, stars]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('PUT /user/rating error:', err)
    res.status(500).json({ error: 'Failed to save rating' })
  }
})

// GET /user/referral — get referral code + stats
router.get('/referral', async (req, res) => {
  try {
    // Auto-generate code if user was registered before this feature
    let result = await query('SELECT referral_code FROM users WHERE id = $1', [req.userId])
    if (!result.rows[0]?.referral_code) {
      const code = req.userId.replace(/-/g, '').slice(0, 8).toUpperCase()
      await query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.userId])
      result = await query('SELECT referral_code FROM users WHERE id = $1', [req.userId])
    }

    const [referred, rewards] = await Promise.all([
      query('SELECT COUNT(*) as count FROM users WHERE referred_by = $1', [req.userId]),
      query(`SELECT COUNT(*) as count FROM referral_rewards WHERE user_id = $1 AND status = 'pending'`, [req.userId]),
    ])

    res.json({
      referralCode: result.rows[0].referral_code,
      referredCount: parseInt(referred.rows[0].count, 10),
      pendingRewards: parseInt(rewards.rows[0].count, 10),
    })
  } catch (err) {
    console.error('GET /user/referral error:', err)
    res.status(500).json({ error: 'Failed to fetch referral info' })
  }
})

// GET /user/2fa/status — is 2FA currently enabled?
router.get('/2fa/status', async (req, res) => {
  try {
    const result = await query('SELECT two_fa_enabled FROM users WHERE id = $1', [req.userId])
    res.json({ enabled: result.rows[0]?.two_fa_enabled || false })
  } catch (err) {
    console.error('GET 2fa/status error:', err)
    res.status(500).json({ error: 'Failed to get 2FA status' })
  }
})

// POST /user/2fa/request — send a code to the user's email to begin enabling 2FA
router.post('/2fa/request', async (req, res) => {
  try {
    const result = await query('SELECT email, two_fa_enabled FROM users WHERE id = $1', [req.userId])
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.two_fa_enabled) return res.status(400).json({ error: '2FA is already enabled' })

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expires = new Date(Date.now() + 10 * 60 * 1000)
    await query(
      'UPDATE users SET two_fa_code = $1, two_fa_code_expires_at = $2 WHERE id = $3',
      [code, expires, req.userId]
    )
    await sendTwoFaCode(user.email, code)
    res.json({ ok: true })
  } catch (err) {
    console.error('POST 2fa/request error:', err)
    res.status(500).json({ error: 'Failed to send verification code' })
  }
})

// POST /user/2fa/enable — verify the code and enable 2FA
router.post('/2fa/enable', async (req, res) => {
  try {
    const { code } = req.body
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'code is required' })

    const result = await query(
      'SELECT two_fa_code, two_fa_code_expires_at, two_fa_enabled FROM users WHERE id = $1',
      [req.userId]
    )
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.two_fa_enabled) return res.status(400).json({ error: '2FA is already enabled' })
    if (!user.two_fa_code || user.two_fa_code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid code' })
    }
    if (!user.two_fa_code_expires_at || new Date(user.two_fa_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired — request a new one' })
    }

    await query(
      'UPDATE users SET two_fa_enabled = TRUE, two_fa_code = NULL, two_fa_code_expires_at = NULL WHERE id = $1',
      [req.userId]
    )
    res.json({ ok: true, enabled: true })
  } catch (err) {
    console.error('POST 2fa/enable error:', err)
    res.status(500).json({ error: 'Failed to enable 2FA' })
  }
})

// DELETE /user/2fa — disable 2FA (requires current password for account safety)
router.delete('/2fa', async (req, res) => {
  try {
    const { password } = req.body
    const result = await query(
      'SELECT password_hash, two_fa_enabled FROM users WHERE id = $1',
      [req.userId]
    )
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!user.two_fa_enabled) return res.status(400).json({ error: '2FA is not enabled' })

    // Password required (unless Google-only account which has no password_hash)
    if (user.password_hash) {
      if (!password) return res.status(400).json({ error: 'Password is required to disable 2FA' })
      const valid = await bcrypt.compare(password, user.password_hash)
      if (!valid) return res.status(401).json({ error: 'Incorrect password' })
    }

    await query(
      'UPDATE users SET two_fa_enabled = FALSE, two_fa_code = NULL, two_fa_code_expires_at = NULL WHERE id = $1',
      [req.userId]
    )
    res.json({ ok: true, enabled: false })
  } catch (err) {
    console.error('DELETE 2fa error:', err)
    res.status(500).json({ error: 'Failed to disable 2FA' })
  }
})

// POST /user/idea-rating — submit or update a 1-5 star rating for a specific business idea
router.post('/idea-rating', async (req, res) => {
  try {
    const { idea_id, rating } = req.body
    const r = parseInt(rating)
    if (!idea_id || !r || r < 1 || r > 5) {
      return res.status(400).json({ error: 'idea_id and rating (1-5) required' })
    }
    await query(
      `INSERT INTO idea_ratings (id, user_id, idea_id, rating)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, idea_id)
       DO UPDATE SET rating = $4, updated_at = NOW()`,
      [uuidv4(), req.userId, idea_id, r]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('POST idea-rating error:', err)
    res.status(500).json({ error: 'Failed to save rating' })
  }
})

// GET /user/broadcasts — active broadcasts for this user's plan or targeted directly
router.get('/broadcasts', async (req, res) => {
  try {
    const planResult = await query(
      `SELECT COALESCE(up.plan, 'free') AS plan FROM users u LEFT JOIN user_plans up ON up.user_id = u.id WHERE u.id = $1`,
      [req.userId]
    )
    const userPlan = planResult.rows[0]?.plan || 'free'
    const result = await query(
      `SELECT id, title, message, created_at FROM broadcasts
       WHERE active = TRUE AND (
         (target_plan IS NULL AND target_user_id IS NULL)
         OR target_plan = $1
         OR target_user_id = $2
       )
       ORDER BY created_at DESC`,
      [userPlan, req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET user/broadcasts error:', err)
    res.status(500).json({ error: 'Failed to fetch broadcasts' })
  }
})

// POST /user/push-subscription — save a browser push subscription
router.post('/push-subscription', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys) return res.status(400).json({ error: 'endpoint and keys are required' })

    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET keys = EXCLUDED.keys`,
      [req.userId, endpoint, JSON.stringify(keys)]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('POST push-subscription error:', err)
    res.status(500).json({ error: 'Failed to save subscription' })
  }
})

// DELETE /user/push-subscription — remove a push subscription
router.delete('/push-subscription', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' })
    await query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [req.userId, endpoint]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE push-subscription error:', err)
    res.status(500).json({ error: 'Failed to remove subscription' })
  }
})

// PUT /user/weekly-email — opt in or out of weekly emails
router.put('/weekly-email', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body
    await query(
      `UPDATE users SET weekly_email = $1 WHERE id = $2`,
      [!!enabled, req.userId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('PUT weekly-email error:', err)
    res.status(500).json({ error: 'Failed to update preference' })
  }
})

export default router
