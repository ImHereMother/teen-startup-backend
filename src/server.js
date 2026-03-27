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
import feedbackRoutes from './routes/feedback.js';
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

app.use(express.json({ limit: '50kb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

app.use('/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts' },
}));

app.use('/auth',     authRoutes);
app.use('/user',     userRoutes);
app.use('/ai',       aiRoutes);
app.use('/admin',    adminRoutes);
app.use('/stripe',   stripeRoutes);
app.use('/feedback', feedbackRoutes);

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