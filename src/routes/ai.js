import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const FREE_TOTAL_LIMIT = 3
const STARTER_MONTHLY_LIMIT = 20
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 600

function getMonthStart() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

// GET /ai/usage — returns current usage counts for the logged-in user
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

// POST /ai/chat
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

    const { messages, system } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' })
    }

    // Validate messages format
    for (const msg of messages) {
      if (!['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') {
        return res.status(400).json({ error: 'Invalid message format' })
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return res.status(503).json({ error: 'AI service not configured' })
    }

    // Save the user message
    const userMessage = messages[messages.length - 1]
    if (userMessage.role === 'user') {
      await query(
        `INSERT INTO ai_messages (id, user_id, role, content, created_at)
         VALUES ($1, $2, 'user', $3, NOW())`,
        [uuidv4(), req.userId, userMessage.content.slice(0, 4000)]
      )
    }

    // Call Anthropic API
    const body = {
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      messages,
    }
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

    // Save the assistant response
    await query(
      `INSERT INTO ai_messages (id, user_id, role, content, model, input_tokens, output_tokens, created_at)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, NOW())`,
      [
        uuidv4(),
        req.userId,
        assistantContent.slice(0, 4000),
        ANTHROPIC_MODEL,
        aiResponse.usage?.input_tokens || 0,
        aiResponse.usage?.output_tokens || 0,
      ]
    )

    res.json({
      content: assistantContent,
      usage: aiResponse.usage,
    })
  } catch (err) {
    console.error('AI chat error:', err)
    res.status(500).json({ error: 'Failed to process AI request' })
  }
})

export default router
