import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import authRoutes     from './routes/auth.js';
import userRoutes     from './routes/user.js';
import aiRoutes       from './routes/ai.js';
import adminRoutes    from './routes/admin.js';
import stripeRoutes   from './routes/stripe.js';
import feedbackRoutes  from './routes/feedback.js';
import featuredRoutes     from './routes/featured.js';
import leaderboardRoutes  from './routes/leaderboard.js';
import { runMigrations } from './db.js';

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

app.use('/auth',     authRoutes);
app.use('/user',     userRoutes);
app.use('/ai',       aiRoutes);
app.use('/admin',    adminRoutes);
app.use('/stripe',   stripeRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/featured',    featuredRoutes);
app.use('/leaderboard', leaderboardRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

runMigrations().catch(err => console.error('Migration error:', err))

app.listen(PORT, () => {
  console.log(`Teen Startup API running on port ${PORT}`);
});