import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db.js'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET
const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY_DAYS = 30

function generateAccessToken(userId, plan, admin = false) {
  return jwt.sign(
    { sub: userId, plan, admin },
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

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const userId = uuidv4()

    await query(
      `INSERT INTO users (id, email, password_hash, display_name, plan, created_at)
       VALUES ($1, $2, $3, $4, 'free', NOW())`,
      [userId, email.toLowerCase(), passwordHash, display_name || null]
    )

    const accessToken = generateAccessToken(userId, 'free')
    const refreshToken = await generateRefreshToken(userId)

    res.status(201).json({ accessToken, refreshToken, userId, plan: 'free' })
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
      'SELECT id, password_hash, plan, display_name FROM users WHERE email = $1',
      [email.toLowerCase()]
    )
    const user = result.rows[0]
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])

    const accessToken = generateAccessToken(user.id, user.plan)
    const refreshToken = await generateRefreshToken(user.id)

    res.json({ accessToken, refreshToken, userId: user.id, plan: user.plan, displayName: user.display_name })
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

    // Upsert user
    let result = await query(
      `INSERT INTO users (id, email, google_id, display_name, avatar_url, plan, created_at)
       VALUES ($1, $2, $3, $4, $5, 'free', NOW())
       ON CONFLICT (email) DO UPDATE SET
         google_id = EXCLUDED.google_id,
         avatar_url = EXCLUDED.avatar_url,
         last_login = NOW()
       RETURNING id, plan, display_name`,
      [uuidv4(), email.toLowerCase(), googleId, name || null, picture || null]
    )

    const user = result.rows[0]
    const accessToken = generateAccessToken(user.id, user.plan)
    const refreshToken = await generateRefreshToken(user.id)

    res.json({ accessToken, refreshToken, userId: user.id, plan: user.plan, displayName: user.display_name })
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
      `SELECT us.id, us.user_id, us.token_hash, u.plan
       FROM user_sessions us
       JOIN users u ON u.id = us.user_id
       WHERE us.expires_at > NOW() AND us.revoked = false`,
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

    // Revoke old session (rotation)
    await query('UPDATE user_sessions SET revoked = true WHERE id = $1', [matchedSession.id])

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
        `SELECT id, token_hash FROM user_sessions WHERE revoked = false AND expires_at > NOW()`
      )
      for (const session of sessions.rows) {
        const match = await bcrypt.compare(refreshToken, session.token_hash)
        if (match) {
          await query('UPDATE user_sessions SET revoked = true WHERE id = $1', [session.id])
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
        `INSERT INTO users (id, email, plan, created_at) VALUES ($1, $2, 'admin', NOW())`,
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
