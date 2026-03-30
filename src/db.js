import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err)
})

export default pool

export async function query(text, params) {
  const start = Date.now()
  const res = await pool.query(text, params)
  const duration = Date.now() - start
  if (duration > 1000) {
    console.warn('Slow query:', { text, duration, rows: res.rowCount })
  }
  return res
}

/* ── Startup migration: ensure all tables exist ─────────── */
export async function runMigrations() {
  const migrations = [
    // Core users table
    `CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_id     TEXT UNIQUE,
      display_name  TEXT,
      tagline       TEXT,
      avatar_url    TEXT,
      is_admin      BOOLEAN DEFAULT FALSE,
      member_since  TEXT,
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    // User plans
    `CREATE TABLE IF NOT EXISTS user_plans (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan       TEXT NOT NULL DEFAULT 'free',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )`,

    // Session / refresh tokens
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Quiz answers
    `CREATE TABLE IF NOT EXISTS quiz_answers (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answers      JSONB,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )`,

    // Favorites
    `CREATE TABLE IF NOT EXISTS user_favorites (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idea_id    INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, idea_id)
    )`,

    // Tracked businesses
    `CREATE TABLE IF NOT EXISTS user_tracked (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idea_id      INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      stage_key    TEXT,
      roadmap_data JSONB,
      started_at   TIMESTAMPTZ DEFAULT NOW(),
      closed_at    TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, idea_id)
    )`,

    // Badges
    `CREATE TABLE IF NOT EXISTS user_badges (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id   TEXT NOT NULL,
      earned_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, badge_id)
    )`,

    // Streaks
    `CREATE TABLE IF NOT EXISTS user_streaks (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      current_streak INTEGER DEFAULT 0,
      longest_streak INTEGER DEFAULT 0,
      last_active    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )`,

    // Earnings
    `CREATE TABLE IF NOT EXISTS user_earnings (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount      NUMERIC(10,2) NOT NULL,
      description TEXT,
      category    TEXT,
      date        DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Tasks
    `CREATE TABLE IF NOT EXISTS user_tasks (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idea_id     INTEGER,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'pending',
      priority    TEXT DEFAULT 'medium',
      due_date    DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Goals
    `CREATE TABLE IF NOT EXISTS user_goals (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT,
      description TEXT,
      target_date TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Events / analytics
    `CREATE TABLE IF NOT EXISTS user_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      data        JSONB,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // AI chat messages
    `CREATE TABLE IF NOT EXISTS ai_messages (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content       TEXT NOT NULL,
      model         TEXT,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Add missing columns to ai_messages if they were created before these were added
    `ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS model TEXT`,
    `ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS input_tokens INTEGER`,
    `ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS output_tokens INTEGER`,

    // User preferences (theme, accessibility, etc.)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'`,

    // Stripe billing columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
    `ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
    `ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`,

    // Notes (Progress page)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`,

    // Feedback (bug reports + idea suggestions from app and landing page)
    `CREATE TABLE IF NOT EXISTS feedback (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type       TEXT NOT NULL CHECK (type IN ('bug', 'idea')),
      message    TEXT NOT NULL,
      user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      email      TEXT,
      status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed')),
      source     TEXT NOT NULL DEFAULT 'app',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Conversations — groups AI messages into named chat sessions
    `CREATE TABLE IF NOT EXISTS conversations (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT 'New Chat',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Link each AI message to a conversation
    `ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL`,

    // Featured creator submissions — shown on each business idea page
    `CREATE TABLE IF NOT EXISTS featured_submissions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      idea_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      handle      TEXT,
      tagline     TEXT NOT NULL,
      link        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      email       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Multiple links on featured submissions
    `ALTER TABLE featured_submissions ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]'`,

    // App star ratings — one per user (upsert)
    `CREATE TABLE IF NOT EXISTS user_ratings (
      user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Landing page waitlist signups (shared Neon DB)
    `CREATE TABLE IF NOT EXISTS waitlist (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT UNIQUE NOT NULL,
      type       TEXT NOT NULL DEFAULT 'waitlist',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Backfill type column on tables created before it was added
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'waitlist'`,

    // Flag specific users as excluded from MRR/ARR display (plan unchanged)
    `ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS mrr_excluded BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS mrr_excluded_until TIMESTAMPTZ`,

    // MRR zero snapshots — each row is one "zero MRR" operation with undo history
    `CREATE TABLE IF NOT EXISTS mrr_snapshots (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      restored_at TIMESTAMPTZ,
      user_count  INTEGER NOT NULL DEFAULT 0,
      mrr_before  NUMERIC(10,2) NOT NULL DEFAULT 0,
      changes     JSONB NOT NULL DEFAULT '[]'
    )`,
  ]

  for (const sql of migrations) {
    try {
      await pool.query(sql)
    } catch (err) {
      console.error('Migration failed:', err.message, '\nSQL:', sql.slice(0, 120))
    }
  }

  console.log('✅ DB migrations complete')
}
