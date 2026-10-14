// app/api/order-confirmation/route.ts
//
// Order confirmation email ("Din SpiderAds beställning är bekräftad för – <company>").
// Replaces the Outlook "Send Email" step in the Zapier zap
// "SpiderAds - Create Task to Clickup 2.0 (Phase 0)", so the mail goes out from the
// Microsoft Graph mailbox (grafik@spiderads.io) like the other review-system emails.
//
// Two ways to call it:
//   1) The zap posts the Tally submission fields here (Webhooks by Zapier -> POST, JSON).
//   2) The ClickUp "Skicka bekräftelsemail" button (manual orders that came in by email / phone):
//      a ClickUp automation "When button clicked -> Call webhook" POSTs the task id only, and the
//      route reads the card's fields itself and sends the SAME email to the card's Requester Email.
//        POST /api/order-confirmation?taskId=<id>&secret=<STEALTH_SECRET>
//      (used whenever the body has no "email", so the zap keeps working exactly as before)
//
// SAFE BY DEFAULT: unless ORDER_CONFIRMATION_LIVE=1 is set in Vercel, every call is a TEST run:
// the email goes only to EMAIL_TEST_TO with a "[TEST] " prefix, never to the real client.
//
//   POST /api/order-confirmation        header x-stealth-secret: <secret>   (or ?secret= / body.secret)
//   add ?test=1 to force a test run even when ORDER_CONFIRMATION_LIVE=1
//
// JSON body (all optional except email):
//   name, email, company, orderDate, deadline, instructions, adFormat, adType,
//   someTextAbove, someTextUnder, displayCopy, pmaxCopy,
//   website, facebookUrl, spiderSource, attachments (comma / newline separated URLs),
//   taskId (ClickUp card id from the Create Task step; shown as "– #<id>" in the subject)
//
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { confirmationFields, fetchTask } from "../../../lib/clickup-task";
import { emailConfigured, escapeHtml, parseRecipients, sendMail } from "../../../lib/email";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ClickUp automations / webhooks shape the payload a little differently: accept the task id
// from the common places (same as /api/stealth-update and /api/send-to-seller).
function extractTaskId(req: NextRequest, body: any): string {
  const q = new URL(req.url).searchParams;
  const candidate =
    body?.taskId ?? body?.task_id ?? body?.payload?.id ?? body?.payload?.task_id ?? body?.id ?? q.get("taskId") ?? q.get("task_id");
  return candidate ? String(candidate).trim() : "";
}

// A button click gives the team no feedback, so a missed send must be visible in Slack (live runs only).
async function slackAlert(text: string): Promise<string> {
  const hook = process.env.SLACK_WEBHOOK_ALERTS || process.env.SLACK_WEBHOOK_ORDERS;
  if (!hook) return "skipped (no Slack webhook configured)";
  try {
    const res = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return res.ok ? "slack posted" : `slack failed ${res.status}`;
  } catch (e) {
    console.error("order-confirmation: slack alert failed", e);
    return "slack failed";
  }
}

export const dynamic = "force-dynamic";

const PURPLE = "#8F00E6";
const NAVY = "#00051E";
const FONT = "Helvetica,Arial,sans-serif";

function clip(v: unknown, max = 5000): string {
  return String(v ?? "").trim().slice(0, max);
}

function formatDate(raw: string): string {
  const d = new Date(raw);
  if (!raw || isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" }).format(d);
}

type Row = [label: string, value: string, opts?: { bold?: boolean; html?: boolean }];

function section(title: string, rows: Row[]): string {
  const shown = rows.filter(([, v]) => v);
  if (shown.length === 0) return "";
  const cells = shown
    .map(([label, value, opts], i) => {
      const bg = i % 2 === 1 ? ` bgcolor="#ede5ff"` : "";
      const content = opts?.html ? value : escapeHtml(value).replace(/\n/g, "<br>");
      return (
        `<tr><td width="36%"${bg} style="font-family:${FONT};font-size:12px;color:#888888;padding:10px 16px;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td${bg} style="font-family:${FONT};font-size:13px;color:${NAVY};${opts?.bold ? "font-weight:bold;" : ""}padding:10px 16px;vertical-align:top;">${content}</td></tr>`
      );
    })
    .join("");
  return (
    `<tr><td bgcolor="#ffffff" style="padding:0 36px 8px 36px;"><p style="margin:0;font-family:${FONT};font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${PURPLE};">${escapeHtml(title)}</p></td></tr>` +
    `<tr><td bgcolor="#ffffff" style="padding:0 36px 24px 36px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0ff" style="border-left:3px solid ${PURPLE};">${cells}</table></td></tr>`
  );
}

function linkList(raw: string): string {
  const urls = raw.split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));
  return urls
    .map((u, i) => `<a href="${escapeHtml(u)}" style="color:${PURPLE};">Bifogad fil ${i + 1}</a>`)
    .join("<br>");
}

function link(url: string): string {
  return /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" style="color:${PURPLE};">${escapeHtml(url)}</a>` : escapeHtml(url);
}

function emailHtml(p: Record<string, string>): string {
  const sections =
    section("Kontakt", [
      ["Namn", p.name, { bold: true }],
      ["E-post", p.email],
      ["Företag", p.company, { bold: true }],
      ["Orderdatum", formatDate(p.orderDate)],
      ["Deadline", p.deadline, { bold: true }],
      ["Ärendenummer", p.taskId ? `#${p.taskId}` : "", { bold: true }],
    ]) +
    section("Instruktioner", [["Instruktioner från kund", p.instructions]]) +
    section("Annonsdetaljer", [
      ["Annonsformat", p.adFormat, { bold: true }],
      ["Annonstyp", p.adType, { bold: true }],
    ]) +
    section("Copy & Innehåll", [
      ["SoMe – Text ovanför annons", p.someTextAbove],
      ["SoMe – Text under annons", p.someTextUnder],
      ["Display – Text under logotyp", p.displayCopy],
      ["Google Max Performance", p.pmaxCopy],
    ]) +
    section("Referenslänkar", [
      ["Företagets webbplats", p.website ? link(p.website) : "", { html: true }],
      ["Facebook", p.facebookUrl ? link(p.facebookUrl) : "", { html: true }],
      ["Källa", p.spiderSource],
      ["Bifogade filer", linkList(p.attachments), { html: true }],
    ]);

  const greeting = p.name ? `Hej ${escapeHtml(p.name)}, tack för din beställning!` : "Hej, tack för din beställning!";
  return (
    `<!DOCTYPE html><html lang="sv"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Din orderbekräftelse – SpiderAds</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f4f4f4;">` +
    `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f4f4f4;">Här är en fullständig sammanfattning av vad du beställt — spara detta mejl för framtida referens.</div>` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4"><tr><td align="center" style="padding:32px 16px;">` +
    `<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;">` +
    `<tr><td bgcolor="${NAVY}" style="padding:28px 36px;"><p style="margin:0;font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:3px;text-transform:uppercase;">SPIDERADS</p></td></tr>` +
    `<tr><td bgcolor="#ffffff" style="padding:32px 36px 24px 36px;border-top:3px solid ${PURPLE};">` +
    `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">${greeting}</p>` +
    `<p style="margin:0;font-family:${FONT};font-size:14px;color:#555555;line-height:1.6;">Nedan hittar du en sammanfattning av vad vi tagit emot. Hör gärna av dig om du har några frågor.</p></td></tr>` +
    sections +
    `<tr><td bgcolor="#ffffff" style="padding:0 36px 32px 36px;"><p style="margin:0;font-family:${FONT};font-size:13px;color:#555555;line-height:1.6;">Med vänliga hälsningar,<br><strong>SpiderAds Graphics Team</strong></p></td></tr>` +
    `<tr><td style="padding:16px 36px;"><p style="margin:0;font-family:${FONT};font-size:11px;color:#999999;">Detta är ett automatiskt meddelande. Vänligen svara inte på detta mejl.</p></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const q = new URL(req.url).searchParams;

  const secret = body?.secret ?? req.headers.get("x-stealth-secret") ?? q.get("secret");
  const okSecrets = [process.env.SEND_TO_SELLER_SECRET, process.env.STEALTH_SECRET].filter(Boolean);
  if (!secret || !okSecrets.includes(String(secret))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let p: Record<string, string>;
  let taskId = "";
  const fromButton = !body?.email;

  if (fromButton) {
    // ClickUp button: only the task id arrives, read the rest from the card.
    taskId = extractTaskId(req, body);
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) {
      return NextResponse.json({ ok: false, error: "Missing or invalid taskId" }, { status: 400 });
    }
    // Ignore duplicate triggers (ClickUp can fire twice) for 60 seconds on live runs.
    const liveRun = process.env.ORDER_CONFIRMATION_LIVE === "1" && q.get("test") !== "1";
    if (liveRun) {
      const first = await kv.set(`oc:sent:${taskId}`, Date.now(), { nx: true, ex: 60 });
      if (!first) return NextResponse.json({ ok: true, skipped: "duplicate trigger" });
    }
    let task: any;
    try {
      task = await fetchTask(taskId);
    } catch (e) {
      console.error("order-confirmation: task fetch failed", e);
      return NextResponse.json({ ok: false, error: "Could not read task" }, { status: 502 });
    }
    const f = confirmationFields(task);
    p = {
      name: clip(f.name, 200),
      email: clip(f.email, 500),
      company: clip(f.company || task.name, 300),
      orderDate: f.orderDate,
      deadline: f.deadline ? formatDate(f.deadline) : "",
      instructions: clip(f.instructions),
      adFormat: clip(f.adFormat, 300),
      adType: clip(f.adType, 300),
      someTextAbove: clip(f.someTextAbove),
      someTextUnder: clip(f.someTextUnder),
      displayCopy: clip(f.displayCopy),
      pmaxCopy: clip(f.pmaxCopy),
      website: clip(f.website, 500),
      facebookUrl: clip(f.facebookUrl, 500),
      spiderSource: clip(f.spiderSource, 300),
      attachments: (task.attachments || []).map((a: { url?: string }) => a.url).filter(Boolean).join("\n").slice(0, 10000),
    };
  } else {
    p = {
      name: clip(body.name, 200),
      email: clip(body.email, 500),
      company: clip(body.company, 300),
      orderDate: clip(body.orderDate, 100),
      deadline: clip(body.deadline, 100),
      instructions: clip(body.instructions),
      adFormat: clip(body.adFormat, 300),
      adType: clip(body.adType, 300),
      someTextAbove: clip(body.someTextAbove),
      someTextUnder: clip(body.someTextUnder),
      displayCopy: clip(body.displayCopy),
      pmaxCopy: clip(body.pmaxCopy),
      website: clip(body.website, 500),
      facebookUrl: clip(body.facebookUrl, 500),
      spiderSource: clip(body.spiderSource, 300),
      attachments: clip(body.attachments, 10000),
    };

    // ClickUp card id (sent by the zap from the Create Task step). Optional: if it is missing or
    // malformed the email goes out exactly as before, without the id.
    const rawTaskId = clip(body.taskId ?? body.task_id, 60);
    taskId = /^[A-Za-z0-9_-]{4,40}$/.test(rawTaskId) ? rawTaskId : "";
  }
  p.taskId = taskId;

  const live = process.env.ORDER_CONFIRMATION_LIVE === "1" && q.get("test") !== "1";
  const to = live ? p.email : process.env.EMAIL_TEST_TO || "";
  const subject = `${live ? "" : "[TEST] "}Din SpiderAds beställning är bekräftad för – ${p.company || "din beställning"}${taskId ? ` – #${taskId}` : ""}`;

  // Tell the team (Slack) when a button-triggered send did not go out. Zap calls already have Zapier's own error handling.
  const notify = async (why: string, fix: string) => {
    if (!(fromButton && live)) return undefined;
    const label = (p.company || "Beställning").replace(/[<>|]/g, "");
    return slackAlert(
      `🚨 *Orderbekräftelse: email NOT sent*\n*Task:* <https://app.clickup.com/t/${taskId}|${label} – #${taskId}>\n*Why:* ${why}\n*Fix:* ${fix}\nThe requester has not received the confirmation.`
    );
  };

  if (!emailConfigured()) return NextResponse.json({ ok: false, live, email: "skipped (email not configured)" }, { status: 503 });
  if (parseRecipients(to).length === 0) {
    const email = live ? "skipped (no valid client email)" : "skipped (EMAIL_TEST_TO not set)";
    const alert = await notify("The *Requester Email* field on the task is empty or invalid.", "Fill in Requester Email, then press Skicka again.");
    return NextResponse.json({ ok: false, live, email, alert }, { status: 400 });
  }

  const result = await sendMail({ to, subject, html: emailHtml(p) });
  const ok = result === "ok";
  console.log(`order-confirmation: task ${taskId || "-"} source=${fromButton ? "button" : "zap"} live=${live} email=${result}`);
  const alert = ok ? undefined : await notify(`Reason: ${result}`, "Check the Vercel logs for order-confirmation, then press Skicka again.");
  return NextResponse.json({ ok, live, email: result, to: live ? "client" : "test address", ...(alert ? { alert } : {}) }, { status: ok ? 200 : 502 });
}

export async function GET() {
  return NextResponse.json({ ok: true, live: process.env.ORDER_CONFIRMATION_LIVE === "1", emailConfigured: emailConfigured() });
}
