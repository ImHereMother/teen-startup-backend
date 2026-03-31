import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET
const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY_DAYS = 30

function generateAccessToken(userId, plan, admin = false, userInfo = {}) {
  return jwt.sign(
    { sub: userId, plan, admin, ...userInfo },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  )
}

async function generateRefreshToken(userId) {
  const raw = uuidv4() + uuidv4()
  const hashed = await bcrypt.hash(raw, 10)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 86400 * 1000)

  await query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hashed, expiresAt]
  )
  return raw
}

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, display_name } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const existing = await query(
      'SELECT id, password_hash, display_name FROM users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0]
      if (existingUser.password_hash) {
        return res.status(409).json({ error: 'Email already registered' })
      }
      // Google-only account — add a password so both login methods work
      const passwordHash = await bcrypt.hash(password, 12)
      await query(
        `UPDATE users SET password_hash = $1,
           display_name = COALESCE(NULLIF(display_name, ''), $2),
           last_seen_at = NOW()
         WHERE id = $3`,
        [passwordHash, display_name || null, existingUser.id]
      )
      const planResult = await query('SELECT plan FROM user_plans WHERE user_id = $1', [existingUser.id])
      const plan = planResult.rows[0]?.plan || 'free'
      const accessToken = generateAccessToken(existingUser.id, plan, false, { email: email.toLowerCase(), display_name: existingUser.display_name })
      const refreshToken = await generateRefreshToken(existingUser.id)
      return res.status(201).json({ accessToken, refreshToken, userId: existingUser.id, email: email.toLowerCase(), plan, displayName: existingUser.display_name, avatarUrl: null, memberSince: null })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const userId = uuidv4()

    // Generate a unique 8-char referral code
    const referralCode = userId.replace(/-/g, '').slice(0, 8).toUpperCase()

    await query(
      `INSERT INTO users (id, email, password_hash, display_name, referral_code, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, email.toLowerCase(), passwordHash, display_name || null, referralCode]
    )

    // Track referral and apply rewards if a ref code was provided
    const { ref } = req.body
    let startingPlan = 'free'

    if (ref) {
      try {
        const refUser = await query('SELECT id FROM users WHERE referral_code = $1', [ref.toUpperCase()])
        if (refUser.rows[0] && refUser.rows[0].id !== userId) {
          const referrerId = refUser.rows[0].id
          await query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, userId])

          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

          // Give referred user Starter for 1 week
          await query(
            `INSERT INTO user_plans (user_id, plan, plan_expires_at, updated_at)
             VALUES ($1, 'starter', $2, NOW())
             ON CONFLICT (user_id) DO UPDATE
               SET plan = 'starter', plan_expires_at = EXCLUDED.plan_expires_at, updated_at = NOW()`,
            [userId, expiresAt]
          )
          startingPlan = 'starter'

          // Check reward cap (max 5 applied rewards per referrer)
          const rewardCount = await query(
            `SELECT COUNT(*) AS count FROM referral_rewards WHERE user_id = $1 AND status = 'applied'`,
            [referrerId]
          )
          const atCap = parseInt(rewardCount.rows[0].count, 10) >= 5

          if (!atCap) {
            // Give referrer Pro for 1 week — only if they don't already have a permanent paid plan
            await query(
              `INSERT INTO user_plans (user_id, plan, plan_expires_at, updated_at)
               VALUES ($1, 'pro', $2, NOW())
               ON CONFLICT (user_id) DO UPDATE
                 SET plan = 'pro', plan_expires_at = EXCLUDED.plan_expires_at, updated_at = NOW()
               WHERE user_plans.plan = 'free' OR user_plans.plan_expires_at IS NOT NULL`,
              [referrerId, expiresAt]
            )
            await query(
              `INSERT INTO referral_rewards (user_id, referred_id, status)
               VALUES ($1, $2, 'applied') ON CONFLICT (referred_id) DO NOTHING`,
              [referrerId, userId]
            )
          } else {
            // Cap reached — log it but don't apply reward
            await query(
              `INSERT INTO referral_rewards (user_id, referred_id, status)
               VALUES ($1, $2, 'pending') ON CONFLICT (referred_id) DO NOTHING`,
              [referrerId, userId]
            )
          }
        }
      } catch (refErr) {
        console.error('Referral processing error:', refErr)
        // Non-fatal — proceed with registration
      }
    }

    const accessToken = generateAccessToken(userId, startingPlan)
    const refreshToken = await generateRefreshToken(userId)

    res.status(201).json({ accessToken, refreshToken, userId, plan: startingPlan, referralCode })
  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ error: 'Registration failed' })
  }
})

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const result = await query(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.member_since, u.password_hash,
              COALESCE(up.plan, 'free') AS plan
       FROM users u LEFT JOIN user_plans up ON up.user_id = u.id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    )
    const user = result.rows[0]
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Google Sign In. Please use the "Continue with Google" button.' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id])

    const accessToken = generateAccessToken(user.id, user.plan, false, {
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    })
    const refreshToken = await generateRefreshToken(user.id)

    res.json({ accessToken, refreshToken, userId: user.id, email: user.email, plan: user.plan, displayName: user.display_name, avatarUrl: user.avatar_url, memberSince: user.member_since })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Login failed' })
  }
})

// POST /auth/google
router.post('/google', async (req, res) => {
  try {
    const { id_token } = req.body
    if (!id_token) {
      return res.status(400).json({ error: 'id_token is required' })
    }

    // Verify with Google tokeninfo endpoint
    const googleRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`
    )
    if (!googleRes.ok) {
      return res.status(401).json({ error: 'Invalid Google token' })
    }
    const googlePayload = await googleRes.json()

    const expectedClientId = process.env.GOOGLE_CLIENT_ID
    if (expectedClientId && googlePayload.aud !== expectedClientId) {
      return res.status(401).json({ error: 'Token audience mismatch' })
    }

    const { sub: googleId, email, name, picture } = googlePayload
    if (!email) {
      return res.status(401).json({ error: 'Could not retrieve email from Google token' })
    }

    // Check if a user already exists with this email (e.g. registered via email/password)
    const existing = await query(
      'SELECT id, display_name FROM users WHERE email = $1',
      [email.toLowerCase()]
    )

    let user
    if (existing.rows.length > 0) {
      // Link Google to existing account — only fill display_name / avatar_url if currently null
      const updated = await query(
        `UPDATE users
         SET google_id = $1,
             display_name = COALESCE(NULLIF(display_name, ''), $2),
             avatar_url   = COALESCE(NULLIF(avatar_url,   ''), $3),
             last_seen_at = NOW()
         WHERE email = $4
         RETURNING id, email, display_name, avatar_url, member_since`,
        [googleId, name || null, picture || null, email.toLowerCase()]
      )
      user = updated.rows[0]

      // Migrate data from any old separate Google-only account with this google_id
      const oldAccount = await query(
        'SELECT id FROM users WHERE google_id = $1 AND id != $2',
        [googleId, user.id]
      )
      if (oldAccount.rows.length > 0) {
        const oldId = oldAccount.rows[0].id
        // Transfer favorites
        await query(
          `INSERT INTO user_favorites (user_id, idea_id, created_at)
           SELECT $1, idea_id, created_at FROM user_favorites WHERE user_id = $2
           ON CONFLICT (user_id, idea_id) DO NOTHING`,
          [user.id, oldId]
        )
        // Transfer quiz answers if email account has none
        await query(
          `INSERT INTO quiz_answers (user_id, answers, completed_at)
           SELECT $1, answers, completed_at FROM quiz_answers WHERE user_id = $2
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, oldId]
        )
        // Clear the old orphaned account's google_id so it's no longer linked
        await query('UPDATE users SET google_id = NULL WHERE id = $1', [oldId])
      }
    } else {
      // Create new account
      const inserted = await query(
        `INSERT INTO users (id, email, google_id, display_name, avatar_url, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, email, display_name, avatar_url, member_since`,
        [uuidv4(), email.toLowerCase(), googleId, name || null, picture || null]
      )
      user = inserted.rows[0]
    }
    const planResult = await query('SELECT plan FROM user_plans WHERE user_id = $1', [user.id])
    const plan = planResult.rows[0]?.plan || 'free'
    const accessToken = generateAccessToken(user.id, plan, false, {
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    })
    const refreshToken = await generateRefreshToken(user.id)

    res.json({ accessToken, refreshToken, userId: user.id, email: user.email, plan, displayName: user.display_name, avatarUrl: user.avatar_url, memberSince: user.member_since })
  } catch (err) {
    console.error('Google auth error:', err)
    res.status(500).json({ error: 'Google authentication failed' })
  }
})

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' })
    }

    // Find unexpired sessions and check the token
    const sessions = await query(
      `SELECT us.id, us.user_id, us.token_hash, COALESCE(up.plan, 'free') AS plan
       FROM user_sessions us
       LEFT JOIN user_plans up ON up.user_id = us.user_id
       WHERE us.expires_at > NOW()`,
      []
    )

    let matchedSession = null
    for (const session of sessions.rows) {
      const match = await bcrypt.compare(refreshToken, session.token_hash)
      if (match) {
        matchedSession = session
        break
      }
    }

    if (!matchedSession) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }

    // Delete old session (rotation)
    await query('DELETE FROM user_sessions WHERE id = $1', [matchedSession.id])

    const accessToken = generateAccessToken(matchedSession.user_id, matchedSession.plan)
    const newRefreshToken = await generateRefreshToken(matchedSession.user_id)

    res.json({ accessToken, refreshToken: newRefreshToken })
  } catch (err) {
    console.error('Refresh error:', err)
    res.status(500).json({ error: 'Token refresh failed' })
  }
})

// POST /auth/logout
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body
    if (refreshToken) {
      const sessions = await query(
        `SELECT id, token_hash FROM user_sessions WHERE expires_at > NOW()`
      )
      for (const session of sessions.rows) {
        const match = await bcrypt.compare(refreshToken, session.token_hash)
        if (match) {
          await query('DELETE FROM user_sessions WHERE id = $1', [session.id])
          break
        }
      }
    }
    res.json({ message: 'Logged out' })
  } catch (err) {
    console.error('Logout error:', err)
    res.status(500).json({ error: 'Logout failed' })
  }
})

// POST /auth/admin-login
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body
    const adminEmail = process.env.ADMIN_EMAIL
    const adminHash = process.env.ADMIN_PASSWORD_HASH

    if (!adminEmail || !adminHash) {
      return res.status(503).json({ error: 'Admin not configured' })
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    if (email.toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, adminHash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    // Find or create admin user record
    let result = await query('SELECT id FROM users WHERE email = $1', [adminEmail.toLowerCase()])
    let adminUserId
    if (result.rows.length === 0) {
      adminUserId = uuidv4()
      await query(
        `INSERT INTO users (id, email, created_at) VALUES ($1, $2, NOW())`,
        [adminUserId, adminEmail.toLowerCase()]
      )
    } else {
      adminUserId = result.rows[0].id
    }

    const accessToken = jwt.sign(
      { sub: adminUserId, plan: 'admin', admin: true },
      JWT_SECRET,
      { expiresIn: '2h' }
    )

    res.json({ accessToken, userId: adminUserId })
  } catch (err) {
    console.error('Admin login error:', err)
    res.status(500).json({ error: 'Admin login failed' })
  }
})

export default router
