import nodemailer from 'nodemailer'

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@teenstartupfinder.com'

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

const APP_URL = process.env.APP_URL || 'https://teenstartupfinder.com'

/* ── Shared email wrapper ────────────────────────────────── */
function emailCard(innerHtml) {
  return `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;background:#08061a;border-radius:16px;color:#fff">
      <div style="margin-bottom:20px">
        <span style="font-size:1.1rem;font-weight:800;letter-spacing:-0.01em">🚀 Teen Startup Finder</span>
      </div>
      ${innerHtml}
      <p style="color:rgba(255,255,255,0.3);font-size:0.75rem;margin:24px 0 0;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px">
        Teen Startup Finder · contact@teenstartupfinder.com
      </p>
    </div>
  `
}

export async function sendTwoFaCode(toEmail, code) {
  if (!isSmtpConfigured()) {
    console.warn('[email] SMTP not configured — 2FA code:', code)
    return
  }
  const transport = createTransport()
  await transport.sendMail({
    from:    `"Teen Startup Finder" <${FROM}>`,
    to:      toEmail,
    subject: `${code} — your verification code`,
    text:    `Your Teen Startup Finder verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
    html:    emailCard(`
      <h2 style="margin:0 0 8px;font-size:1.4rem;letter-spacing:-0.02em">🔐 Verification Code</h2>
      <p style="color:rgba(255,255,255,0.6);margin:0 0 28px;font-size:0.9rem">Enter this code to sign in.</p>
      <div style="background:rgba(108,71,255,0.15);border:1px solid rgba(108,71,255,0.3);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:2.2rem;font-weight:900;letter-spacing:0.15em;color:#fff">${code}</span>
      </div>
      <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin:0">
        Expires in <strong style="color:rgba(255,255,255,0.8)">10 minutes</strong>. Didn't request this? Ignore it safely.
      </p>
    `),
  })
}

export async function sendPasswordResetEmail(toEmail, resetToken) {
  const resetLink = `${APP_URL}?reset=${resetToken}`
  if (!isSmtpConfigured()) {
    console.warn('[email] SMTP not configured — reset link:', resetLink)
    return
  }
  const transport = createTransport()
  await transport.sendMail({
    from:    `"Teen Startup Finder" <${FROM}>`,
    to:      toEmail,
    subject: 'Reset your Teen Startup Finder password',
    text:    `Click the link below to reset your password. This link expires in 1 hour.\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email.`,
    html:    emailCard(`
      <h2 style="margin:0 0 8px;font-size:1.4rem;letter-spacing:-0.02em">🔑 Reset Your Password</h2>
      <p style="color:rgba(255,255,255,0.6);margin:0 0 24px;font-size:0.9rem">Click the button below to set a new password. This link expires in 1 hour.</p>
      <a href="${resetLink}" style="display:inline-block;background:linear-gradient(135deg,#6C47FF,#00D2A0);color:#fff;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:10px;margin-bottom:24px">
        Reset Password →
      </a>
      <p style="color:rgba(255,255,255,0.4);font-size:0.8rem;margin:0;word-break:break-all">
        Or copy this link: ${resetLink}
      </p>
      <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin:16px 0 0">
        Didn't request this? Ignore it — your account is safe.
      </p>
    `),
  })
}

export async function sendVerificationEmail(toEmail, verifyToken) {
  const verifyLink = `${APP_URL}?verify=${verifyToken}`
  if (!isSmtpConfigured()) {
    console.warn('[email] SMTP not configured — verify link:', verifyLink)
    return
  }
  const transport = createTransport()
  await transport.sendMail({
    from:    `"Teen Startup Finder" <${FROM}>`,
    to:      toEmail,
    subject: 'Verify your Teen Startup Finder email',
    text:    `Click the link below to verify your email address.\n\n${verifyLink}\n\nThis link expires in 24 hours.`,
    html:    emailCard(`
      <h2 style="margin:0 0 8px;font-size:1.4rem;letter-spacing:-0.02em">✅ Verify Your Email</h2>
      <p style="color:rgba(255,255,255,0.6);margin:0 0 24px;font-size:0.9rem">One click to confirm your email address and you're all set.</p>
      <a href="${verifyLink}" style="display:inline-block;background:linear-gradient(135deg,#6C47FF,#00D2A0);color:#fff;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:10px;margin-bottom:24px">
        Verify Email →
      </a>
      <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin:0">This link expires in 24 hours.</p>
    `),
  })
}

export async function sendWeeklyProgressEmail(toEmail, { displayName, streak, totalEarnings, tasksCompleted, businessName }) {
  if (!isSmtpConfigured()) {
    console.warn('[email] SMTP not configured — skipping weekly email for', toEmail)
    return
  }
  const name = displayName || 'Entrepreneur'
  const transport = createTransport()
  await transport.sendMail({
    from:    `"Teen Startup Finder" <${FROM}>`,
    to:      toEmail,
    subject: `Your weekly progress — ${streak > 0 ? `🔥 ${streak}-day streak!` : 'keep going!'}`,
    text:    `Hey ${name},\n\nHere's your weekly Teen Startup Finder update:\n\n🔥 Current streak: ${streak} days\n💰 Total earnings: $${Number(totalEarnings || 0).toFixed(2)}\n✅ Tasks completed: ${tasksCompleted || 0}\n${businessName ? `🚀 Active business: ${businessName}` : ''}\n\nKeep it up — open the app to keep your streak alive!\n\nhttps://teenstartupfinder.com`,
    html:    emailCard(`
      <h2 style="margin:0 0 4px;font-size:1.3rem;letter-spacing:-0.02em">Hey ${name}! 👋</h2>
      <p style="color:rgba(255,255,255,0.6);margin:0 0 24px;font-size:0.9rem">Here's your weekly progress summary.</p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
        <div style="background:rgba(108,71,255,0.15);border:1px solid rgba(108,71,255,0.25);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:1.6rem;font-weight:900;color:#fff">${streak}</div>
          <div style="color:rgba(255,255,255,0.5);font-size:0.75rem;margin-top:2px">Day Streak 🔥</div>
        </div>
        <div style="background:rgba(0,210,160,0.1);border:1px solid rgba(0,210,160,0.2);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:1.6rem;font-weight:900;color:#00D2A0">$${Number(totalEarnings || 0).toFixed(2)}</div>
          <div style="color:rgba(255,255,255,0.5);font-size:0.75rem;margin-top:2px">Total Earned 💰</div>
        </div>
      </div>

      ${tasksCompleted > 0 ? `<p style="color:rgba(255,255,255,0.7);font-size:0.9rem;margin:0 0 8px">✅ <strong>${tasksCompleted} task${tasksCompleted !== 1 ? 's' : ''}</strong> completed this week</p>` : ''}
      ${businessName ? `<p style="color:rgba(255,255,255,0.7);font-size:0.9rem;margin:0 0 20px">🚀 Working on: <strong>${businessName}</strong></p>` : '<p style="margin:0 0 20px"></p>'}

      <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#6C47FF,#00D2A0);color:#fff;text-decoration:none;font-weight:700;font-size:0.95rem;padding:12px 24px;border-radius:10px">
        Open App →
      </a>

      <p style="color:rgba(255,255,255,0.3);font-size:0.75rem;margin:20px 0 0">
        Don't want weekly emails?
        <a href="${APP_URL}" style="color:rgba(255,255,255,0.4)">Manage in Settings</a>
      </p>
    `),
  })
}
