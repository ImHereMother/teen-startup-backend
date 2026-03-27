import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { optionalAuth } from '../middleware/auth.js'

const router = Router()

// POST /feedback — public with optional auth
// Accepts: { type: 'bug'|'idea', message: string, email?: string, source?: 'app'|'landing' }
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { type, message, email, source } = req.body

    if (!['bug', 'idea'].includes(type)) {
      return res.status(400).json({ error: 'type must be "bug" or "idea"' })
    }

    const msg = typeof message === 'string' ? message.trim() : ''
    if (msg.length < 5) {
      return res.status(400).json({ error: 'message must be at least 5 characters' })
    }

    const safeEmail  = email  ? String(email).trim().slice(0, 254) : null
    const safeSource = ['app', 'landing'].includes(source) ? source : 'app'
    const userId     = req.userId || null  // set by optionalAuth if valid JWT present

    await query(
      `INSERT INTO feedback (id, type, message, user_id, email, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [uuidv4(), type, msg.slice(0, 2000), userId, safeEmail, safeSource]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error('POST /feedback error:', err)
    res.status(500).json({ error: 'Failed to submit feedback' })
  }
})

export default router
