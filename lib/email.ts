// lib/email.ts
//
// Tiny SMTP sender. Works with any mailbox (Microsoft 365, Google Workspace, ...).
// Switching sender later = change these Vercel env vars, no code change:
//   SMTP_HOST   e.g. smtp.office365.com  /  smtp.gmail.com
//   SMTP_PORT   587 (STARTTLS, default)  or 465 (SSL)
//   SMTP_USER   mailbox login
//   SMTP_PASS   app password (mark Sensitive)
//   EMAIL_FROM  optional, defaults to SMTP_USER
//   EMAIL_FROM_NAME optional, defaults to "SpiderAds Graphics Team"
//
import nodemailer from "nodemailer";

export function emailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Returns "ok", "skipped (...)" or "failed". Never throws. */
export async function sendMail(opts: { to: string; subject: string; html: string }): Promise<string> {
  if (!emailConfigured()) return "skipped (email not configured)";
  if (!opts.to || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(opts.to.trim())) return "skipped (no valid recipient)";

  try {
    const port = Number(process.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const fromAddr = process.env.EMAIL_FROM || process.env.SMTP_USER!;
    const fromName = process.env.EMAIL_FROM_NAME || "SpiderAds Graphics Team";
    await transport.sendMail({
      from: `"${fromName.replace(/"/g, "")}" <${fromAddr}>`,
      to: opts.to.trim(),
      subject: opts.subject,
      html: opts.html,
    });
    return "ok";
  } catch (e) {
    console.error("email: send failed", e);
    return "failed";
  }
}
