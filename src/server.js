import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';

import authRoutes     from './routes/auth.js';
import userRoutes     from './routes/user.js';
import aiRoutes       from './routes/ai.js';
import adminRoutes    from './routes/admin.js';
import stripeRoutes   from './routes/stripe.js';
import feedbackRoutes  from './routes/feedback.js';
import featuredRoutes     from './routes/featured.js';
import leaderboardRoutes  from './routes/leaderboard.js';
import publicRoutes   from './routes/public.js';
import { runMigrations, query } from './db.js';
import { sendWeeklyProgressEmail } from './email.js';

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
  credentials: true,
}));

// Stripe webhook needs the raw body BEFORE the JSON parser touches it
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));

// AI chat needs a higher limit to support base64 image uploads (up to ~7 MB)
app.use('/ai/chat', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '50kb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// Auth — 20 req / 15 min
app.use('/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please wait' },
}));

// Admin login — extra strict: 5 attempts / 15 min
app.use('/auth/admin-login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many admin login attempts' },
}));

// AI chat — 60 requests / min per IP (prevents runaway cost abuse)
app.use('/ai/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many AI requests, slow down' },
}));

// Sensitive user mutations — 10 / 10 min
app.use('/user/password', rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password change attempts' },
}));
app.use('/user/plan', rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Too many plan change requests' },
}));

// Featured submissions — prevent spam: 5 / hour
app.use('/featured', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions, please wait' },
}));

// 2FA verify — 10 / 15 min (brute-force protection)
app.use('/auth/2fa/verify', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many 2FA attempts, please wait' },
}));

// 2FA resend — 5 / 15 min (prevent email flooding)
app.use('/auth/2fa/resend', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many resend requests, please wait' },
}));

// 2FA enable request (user settings) — 5 / 15 min
app.use('/user/2fa/request', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many code requests, please wait' },
}));

// Forgot password — 5 requests / 15 min (prevent email flooding)
app.use('/auth/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset requests, please wait' },
}));

// Email verification sends — 5 / 15 min
app.use('/auth/send-verification', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many verification requests, please wait' },
}));

app.use('/auth',     authRoutes);
app.use('/user',     userRoutes);
app.use('/ai',       aiRoutes);
app.use('/admin',    adminRoutes);
app.use('/stripe',   stripeRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/public',   publicRoutes);
app.use('/featured',    featuredRoutes);
app.use('/leaderboard', leaderboardRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

runMigrations().catch(err => console.error('Migration error:', err))

/* ── Weekly progress email — every Monday 9 AM UTC ─────── */
cron.schedule('0 9 * * 1', async () => {
  console.log('[cron] Running weekly progress email job...')
  try {
    // Get all users who haven't opted out, with their latest progress data
    const users = await query(`
      SELECT
        u.id,
        u.email,
        u.display_name,
        COALESCE(us.current_streak, 0)    AS streak,
        COALESCE(e.total_earnings, 0)     AS total_earnings,
        COALESCE(t.tasks_completed, 0)    AS tasks_completed
      FROM users u
      LEFT JOIN user_streaks us ON us.user_id = u.id
      LEFT JOIN (
        SELECT user_id, SUM(amount) AS total_earnings FROM user_earnings GROUP BY user_id
      ) e ON e.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS tasks_completed
        FROM user_tasks WHERE status = 'done'
          AND updated_at > NOW() - INTERVAL '7 days'
        GROUP BY user_id
      ) t ON t.user_id = u.id
      WHERE u.email IS NOT NULL
        AND u.weekly_email = TRUE
        AND u.email_verified = TRUE
    `)

    let sent = 0
    let failed = 0
    for (const row of users.rows) {
      try {
        await sendWeeklyProgressEmail(row.email, {
          displayName:    row.display_name,
          streak:         Number(row.streak),
          totalEarnings:  Number(row.total_earnings),
          tasksCompleted: Number(row.tasks_completed),
          businessName:   null, // idea names live in the frontend data file
        })
        sent++
      } catch (err) {
        console.error(`[cron] Failed to send weekly email to ${row.email}:`, err.message)
        failed++
      }
    }
    console.log(`[cron] Weekly emails: ${sent} sent, ${failed} failed`)
  } catch (err) {
    console.error('[cron] Weekly email job failed:', err)
  }
})

app.listen(PORT, () => {
  console.log(`Teen Startup API running on port ${PORT}`);
});