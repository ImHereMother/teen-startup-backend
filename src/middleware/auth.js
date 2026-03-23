import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET

export function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.userId = payload.sub
    req.userPlan = payload.plan || 'free'
    req.isAdmin = payload.admin === true
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload.admin) {
      return res.status(403).json({ error: 'Admin access required' })
    }
    req.userId = payload.sub
    req.userPlan = payload.plan || 'free'
    req.isAdmin = true
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    req.userId = null
    req.userPlan = 'free'
    return next()
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.userId = payload.sub
    req.userPlan = payload.plan || 'free'
    req.isAdmin = payload.admin === true
  } catch {
    req.userId = null
    req.userPlan = 'free'
  }
  next()
}
