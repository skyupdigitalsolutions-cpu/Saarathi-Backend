import nodemailer from "nodemailer";

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE) === "true" || Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

export function mailerConfigured() {
  return !!getTransporter();
}

/** Send the password-reset email. Returns true if actually sent. */
export async function sendResetEmail(to, resetUrl) {
  const t = getTransporter();
  const from = process.env.MAIL_FROM || "Sarathi Associates <no-reply@sarathi.com>";
  if (!t) {
    // SMTP not configured yet — log the link so it isn't lost.
    console.log(`[mailer] SMTP not configured. Password reset link for ${to}:\n  ${resetUrl}`);
    return false;
  }
  await t.sendMail({
    from,
    to,
    subject: "Reset your Sarathi CRM password",
    text: `You requested a password reset.\n\nReset your password using this link (valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#024CA3">Reset your password</h2>
        <p>You requested a password reset for your Sarathi CRM account.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#024CA3;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none">Reset password</a></p>
        <p style="color:#666;font-size:13px">This link is valid for 1 hour. If you didn't request this, you can safely ignore this email.</p>
      </div>`,
  });
  return true;
}
