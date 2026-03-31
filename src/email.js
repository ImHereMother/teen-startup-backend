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

export async function sendTwoFaCode(toEmail, code) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP not configured — 2FA code:', code)
    return
  }
  const transport = createTransport()
  await transport.sendMail({
    from:    `"Teen Startup Finder" <${FROM}>`,
    to:      toEmail,
    subject: `${code} — your verification code`,
    text:    `Your Teen Startup Finder verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
    html:    `
      <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;background:#08061a;border-radius:16px;color:#fff">
        <h2 style="margin:0 0 8px;font-size:1.4rem;letter-spacing:-0.02em">🔐 Verification Code</h2>
        <p style="color:rgba(255,255,255,0.6);margin:0 0 28px;font-size:0.9rem">Teen Startup Finder</p>
        <div style="background:rgba(108,71,255,0.15);border:1px solid rgba(108,71,255,0.3);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:2.2rem;font-weight:900;letter-spacing:0.15em;color:#fff">${code}</span>
        </div>
        <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;margin:0">
          This code expires in <strong style="color:rgba(255,255,255,0.8)">10 minutes</strong>.<br>
          If you didn't request this, ignore this email — your account is safe.
        </p>
      </div>
    `,
  })
}
