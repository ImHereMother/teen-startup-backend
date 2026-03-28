import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { optionalAuth, requireAuth } from '../middleware/auth.js'

const router = Router()

/* ── URL validator ──────────────────────────────────────── */
function isValidLink(url) {
  if (!url) return true
  try {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol)) return false
    if (!u.hostname.includes('.')) return false
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return false
    return true
  } catch { return false }
}

/* ── GET /featured — all approved entries (for Discover page) ── */
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, idea_id, name, handle, tagline, link, created_at
       FROM featured_submissions
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT 30`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET /featured error:', err)
    res.status(500).json({ error: 'Failed to fetch' })
  }
})

/* ── POST /featured — submit a "Get Featured" request ───── */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { idea_id, name, handle, tagline, link, email } = req.body

    if (!idea_id || !name?.trim() || !tagline?.trim()) {
      return res.status(400).json({ error: 'idea_id, name, and tagline are required' })
    }
    if (name.trim().length > 80)    return res.status(400).json({ error: 'Name too long (max 80 chars)' })
    if (tagline.trim().length > 160) return res.status(400).json({ error: 'Tagline too long (max 160 chars)' })
    if (link?.trim() && !isValidLink(link.trim())) {
      return res.status(400).json({ error: 'Link must be a valid https:// URL' })
    }

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

/* ── GET /featured/my — the logged-in user's own submissions ─ */
router.get('/my', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, idea_id, name, tagline, status, created_at
       FROM featured_submissions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET /featured/my error:', err)
    res.status(500).json({ error: 'Failed to fetch' })
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
