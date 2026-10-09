// lib/email.ts
//
// Tiny email sender. Three ways to send (the first one configured wins):
//   0) GRAPH_* settings       -> Microsoft Graph API, sends AS the mailbox (recommended). Needs:
//        GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER (e.g. grafik@spiderads.io)
//      Always calls /users/<GRAPH_SENDER>/sendMail (never /me) and saves a copy in the Sent folder.
//   A) EMAIL_ZAPIER_HOOK_URL  -> post {to, subject, html} to a Zapier Catch Hook; a zap with an
//      Outlook "Send Email" step sends it (1 Zapier task per email). Simple, no mailbox login needed.
//   B) SMTP_* settings below  -> send straight from the mailbox, no Zapier.
//
// SMTP sender. Works with any mailbox (Microsoft 365, Google Workspace, ...).
// Switching sender later = change these Vercel env vars, no code change:
//   SMTP_HOST   e.g. smtp.office365.com  /  smtp.gmail.com
//   SMTP_PORT   587 (STARTTLS, default)  or 465 (SSL)
//   SMTP_USER   mailbox login
//   SMTP_PASS   app password (mark Sensitive)
//   EMAIL_FROM  optional, defaults to SMTP_USER
//   EMAIL_FROM_NAME optional, defaults to "SpiderAds Graphics Team"
//
import nodemailer from "nodemailer";

function graphConfigured(): boolean {
  return !!(
    process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_CLIENT_SECRET &&
    process.env.GRAPH_SENDER
  );
}

let graphToken: { value: string; expires: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (graphToken && graphToken.expires > Date.now() + 60_000) return graphToken.value;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID!,
      client_secret: process.env.GRAPH_CLIENT_SECRET!,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = await res.json();
  graphToken = { value: j.access_token as string, expires: Date.now() + Number(j.expires_in || 3000) * 1000 };
  return graphToken.value;
}

export function emailConfigured(): boolean {
  return graphConfigured() || !!process.env.EMAIL_ZAPIER_HOOK_URL || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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

  if (graphConfigured()) {
    try {
      const token = await getGraphToken();
      const sender = encodeURIComponent(process.env.GRAPH_SENDER!);
      const send = () =>
        fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: opts.subject,
              body: { contentType: "HTML", content: opts.html },
              toRecipients: [{ emailAddress: { address: opts.to.trim() } }],
            },
            saveToSentItems: true,
          }),
        });
      let res = await send();
      // New permissions can take a while to propagate: retry once on 403.
      if (res.status === 403) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await send();
      }
      if (!res.ok) console.error("email: graph send failed", res.status, (await res.text()).slice(0, 300));
      return res.ok ? "ok" : `failed ${res.status}`;
    } catch (e) {
      console.error("email: graph error", e);
      return "failed";
    }
  }

  if (process.env.EMAIL_ZAPIER_HOOK_URL) {
    try {
      const res = await fetch(process.env.EMAIL_ZAPIER_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: opts.to.trim(), subject: opts.subject, html: opts.html }),
      });
      return res.ok ? "ok" : `failed ${res.status}`;
    } catch (e) {
      console.error("email: zapier hook failed", e);
      return "failed";
    }
  }

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
