import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const FREE_TOTAL_LIMIT     = 3
const STARTER_MONTHLY_LIMIT = 20
const ANTHROPIC_MODEL      = 'claude-haiku-4-5-20251001'
const MAX_TOKENS           = 600

function getMonthStart() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

/* ── GET /ai/usage ──────────────────────────────────────── */
router.get('/usage', async (req, res) => {
  try {
    const plan = req.userPlan
    if (plan === 'pro') return res.json({ plan, used: 0, limit: null })

    if (plan === 'starter') {
      const monthStart = getMonthStart()
      const result = await query(
        `SELECT COUNT(*) as count FROM ai_messages WHERE user_id = $1 AND role = 'user' AND created_at >= $2`,
        [req.userId, monthStart]
      )
      return res.json({ plan, used: parseInt(result.rows[0].count, 10), limit: STARTER_MONTHLY_LIMIT })
    }

    // free — lifetime total
    const result = await query(
      `SELECT COUNT(*) as count FROM ai_messages WHERE user_id = $1 AND role = 'user'`,
      [req.userId]
    )
    return res.json({ plan, used: parseInt(result.rows[0].count, 10), limit: FREE_TOTAL_LIMIT })
  } catch (err) {
    console.error('AI usage error:', err)
    res.status(500).json({ error: 'Failed to get usage' })
  }
})

/* ── GET /ai/conversations ──────────────────────────────── */
// Starter: last 7 days  |  Pro: all  |  Free: []
router.get('/conversations', async (req, res) => {
  const plan = req.userPlan
  if (plan === 'free') return res.json([])

  try {
    const dateClause = plan === 'starter'
      ? `AND c.updated_at >= NOW() - INTERVAL '7 days'`
      : ''

    const result = await query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT m.content FROM ai_messages m
               WHERE m.conversation_id = c.id AND m.role = 'user'
               ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM conversations c
       WHERE c.user_id = $1 ${dateClause}
       ORDER BY c.updated_at DESC
       LIMIT 100`,
      [req.userId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List conversations error:', err)
    res.status(500).json({ error: 'Failed to list conversations' })
  }
})

/* ── POST /ai/conversations ─────────────────────────────── */
router.post('/conversations', async (req, res) => {
  const plan = req.userPlan
  if (plan === 'free') return res.status(403).json({ error: 'Conversations not available on free plan' })

  try {
    const result = await query(
      `INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'New Chat')
       RETURNING id, title, created_at, updated_at`,
      [uuidv4(), req.userId]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Create conversation error:', err)
    res.status(500).json({ error: 'Failed to create conversation' })
  }
})

/* ── GET /ai/conversations/:id/messages ─────────────────── */
router.get('/conversations/:id/messages', async (req, res) => {
  const plan = req.userPlan
  if (plan === 'free') return res.status(403).json({ error: 'History not available on free plan' })

  try {
    // Verify ownership
    const convResult = await query(
      `SELECT id, user_id, created_at FROM conversations WHERE id = $1`,
      [req.params.id]
    )
    const conv = convResult.rows[0]
    if (!conv) return res.status(404).json({ error: 'Conversation not found' })
    if (conv.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' })

    // Starter: only conversations from last 7 days
    if (plan === 'starter') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      if (new Date(conv.created_at) < cutoff) {
        return res.status(403).json({ error: 'Conversation outside your 7-day history window' })
      }
    }

    const messages = await query(
      `SELECT id, role, content, created_at FROM ai_messages
       WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    )
    res.json(messages.rows)
  } catch (err) {
    console.error('Get conversation messages error:', err)
    res.status(500).json({ error: 'Failed to get messages' })
  }
})

/* ── DELETE /ai/conversations/:id ───────────────────────── */
router.delete('/conversations/:id', async (req, res) => {
  const plan = req.userPlan
  if (plan === 'free') return res.status(403).json({ error: 'Not available on free plan' })

  try {
    const result = await query(
      `DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.userId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete conversation error:', err)
    res.status(500).json({ error: 'Failed to delete conversation' })
  }
})

/* ── POST /ai/chat ──────────────────────────────────────── */
router.post('/chat', async (req, res) => {
  try {
    const plan = req.userPlan

    // Free tier: 3 lifetime messages (taste test)
    if (plan === 'free') {
      const result = await query(
        `SELECT COUNT(*) as count FROM ai_messages WHERE user_id = $1 AND role = 'user'`,
        [req.userId]
      )
      const used = parseInt(result.rows[0].count, 10)
      if (used >= FREE_TOTAL_LIMIT) {
        return res.status(403).json({
          error: 'Free message limit reached',
          code: 'FREE_LIMIT_REACHED',
          used,
          limit: FREE_TOTAL_LIMIT,
        })
      }
    }

    // Starter tier: 20 messages/month
    if (plan === 'starter') {
      const monthStart = getMonthStart()
      const usageResult = await query(
        `SELECT COUNT(*) as count FROM ai_messages
         WHERE user_id = $1 AND role = 'user' AND created_at >= $2`,
        [req.userId, monthStart]
      )
      const used = parseInt(usageResult.rows[0].count, 10)
      if (used >= STARTER_MONTHLY_LIMIT) {
        return res.status(403).json({
          error: 'Monthly message limit reached',
          code: 'LIMIT_REACHED',
          used,
          limit: STARTER_MONTHLY_LIMIT,
        })
      }
    }

    // Pro: no limit check

    const { messages, system, conversation_id } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    for (const msg of messages) {
      if (!['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') {
        return res.status(400).json({ error: 'Invalid message format' })
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return res.status(503).json({ error: 'AI service not configured' })
    }

    // Save the user message (with conversation_id if provided)
    const userMessage = messages[messages.length - 1]
    if (userMessage.role === 'user') {
      await query(
        `INSERT INTO ai_messages (id, user_id, role, content, conversation_id, created_at)
         VALUES ($1, $2, 'user', $3, $4, NOW())`,
        [uuidv4(), req.userId, userMessage.content.slice(0, 4000), conversation_id || null]
      )

      // Auto-set conversation title from the first user message
      if (conversation_id) {
        await query(
          `UPDATE conversations
           SET title      = CASE WHEN title = 'New Chat' THEN $1 ELSE title END,
               updated_at = NOW()
           WHERE id = $2 AND user_id = $3`,
          [userMessage.content.slice(0, 50), conversation_id, req.userId]
        )
      }
    }

    // Call Anthropic API
    const body = { model: ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, messages }
    if (system) body.system = system

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text()
      console.error('Anthropic API error:', anthropicRes.status, errBody)
      return res.status(502).json({ error: 'AI service error', code: 'AI_ERROR' })
    }

    const aiResponse = await anthropicRes.json()
    const rawContent = aiResponse.content?.[0]?.text || ''
    // Keep markdown intact — frontend renders headings and bold
    // Only collapse excessive blank lines (3+ → 2) to keep responses tight
    const assistantContent = rawContent
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()

    // Save the assistant response (with conversation_id)
    await query(
      `INSERT INTO ai_messages (id, user_id, role, content, model, input_tokens, output_tokens, conversation_id, created_at)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, NOW())`,
      [
        uuidv4(),
        req.userId,
        assistantContent.slice(0, 4000),
        ANTHROPIC_MODEL,
        aiResponse.usage?.input_tokens  || 0,
        aiResponse.usage?.output_tokens || 0,
        conversation_id || null,
      ]
    )

    res.json({ content: assistantContent, usage: aiResponse.usage })
  } catch (err) {
    console.error('AI chat error:', err)
    res.status(500).json({ error: 'Failed to process AI request' })
  }
})

export default router
