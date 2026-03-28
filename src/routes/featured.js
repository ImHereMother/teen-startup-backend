import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { optionalAuth } from '../middleware/auth.js'

const router = Router()

/* ── POST /featured — submit a "Get Featured" request ───── */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { idea_id, name, handle, tagline, link, email } = req.body

    if (!idea_id || !name?.trim() || !tagline?.trim()) {
      return res.status(400).json({ error: 'idea_id, name, and tagline are required' })
    }
    if (name.trim().length > 80)    return res.status(400).json({ error: 'Name too long (max 80 chars)' })
    if (tagline.trim().length > 160) return res.status(400).json({ error: 'Tagline too long (max 160 chars)' })

    const result = await query(
      `INSERT INTO featured_submissions (id, idea_id, name, handle, tagline, link, user_id, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        uuidv4(),
        parseInt(idea_id, 10),
        name.trim(),
        handle?.trim() || null,
        tagline.trim(),
        link?.trim() || null,
        req.userId || null,
        email?.trim() || null,
      ]
    )

    res.status(201).json({ ok: true, id: result.rows[0].id })
  } catch (err) {
    console.error('POST /featured error:', err)
    res.status(500).json({ error: 'Failed to submit' })
  }
})

/* ── GET /featured/:ideaId — approved entries for one idea ─ */
router.get('/:ideaId', async (req, res) => {
  try {
    const ideaId = parseInt(req.params.ideaId, 10)
    if (isNaN(ideaId)) return res.status(400).json({ error: 'Invalid idea ID' })

    const result = await query(
      `SELECT id, name, handle, tagline, link, created_at
       FROM featured_submissions
       WHERE idea_id = $1 AND status = 'approved'
       ORDER BY created_at DESC
       LIMIT 20`,
      [ideaId]
    )

    res.json(result.rows)
  } catch (err) {
    console.error('GET /featured/:ideaId error:', err)
    res.status(500).json({ error: 'Failed to fetch' })
  }
})

export default router
