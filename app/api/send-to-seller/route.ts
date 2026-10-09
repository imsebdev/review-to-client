// app/api/send-to-seller/route.ts
//
// "Send to Seller 3.0": does what the "Send to Seller 2.0 (Phase 1)" zap does, without Zapier:
//   1) read the ClickUp task (company, requester email, framer link, attachments)
//   2) save the pitch so the review link works (same record as /api/save-pitch)
//   3) write the review link into the task's "Client Review Link" field
//   4) email the requester the review link
//
// SAFE BY DEFAULT: unless SEND_TO_SELLER_LIVE=1 is set in Vercel, every call is a TEST run:
//   - the email goes only to EMAIL_TEST_TO (never the real requester)
//   - the "Client Review Link" field is NOT written
//   - an existing pitch record is never overwritten
//
// Call it (ClickUp automation / webhook / curl):
//   POST /api/send-to-seller?taskId=<id>&secret=<STEALTH_SECRET>        (or x-stealth-secret header)
//   add &test=1 to force a test run even when SEND_TO_SELLER_LIVE=1
//
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { attachmentUrls, fetchTask, taskFields } from "../../../lib/clickup-task";
import { emailConfigured, escapeHtml, sendMail } from "../../../lib/email";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const CLICKUP = "https://api.clickup.com/api/v2";

function extractTaskId(req: NextRequest, body: any): string {
  const q = new URL(req.url).searchParams;
  const candidate =
    body?.taskId ?? body?.task_id ?? body?.payload?.id ?? body?.payload?.task_id ?? body?.id ?? q.get("taskId") ?? q.get("task_id");
  return candidate ? String(candidate).trim() : "";
}

function emailHtml(name: string, link: string): string {
  return (
    `Hej${name ? " " + escapeHtml(name) : ""},<br><br>` +
    `Hoppas du mår fint. :)<br><br>` +
    `Din beställning är nu klar för granskning. Klicka på knappen nedan för att granska och godkänna eller begära ändringar.<br><br>` +
    `<a href="${escapeHtml(link)}" style="display: inline-block; background-color: #a0a0ff; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600;">👉 Klicka här för att granska din pitch</a><br><br>` +
    `Om du har några frågor eller behöver hjälp, är du välkommen att höra av dig.<br><br>` +
    `Med vänliga hälsningar,<br><strong>SpiderAds Graphics Team</strong><br><br><hr>` +
    `<small style="color: #999;">Detta är ett automatiskt meddelande. Vänligen svara inte på detta mejl.</small>`
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const q = new URL(req.url).searchParams;

  const secret = body?.secret ?? req.headers.get("x-stealth-secret") ?? q.get("secret");
  if (!secret || secret !== process.env.STEALTH_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const taskId = extractTaskId(req, body);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) {
    return NextResponse.json({ ok: false, error: "Missing or invalid taskId" }, { status: 400 });
  }

  const live = process.env.SEND_TO_SELLER_LIVE === "1" && q.get("test") !== "1";

  // Ignore duplicate triggers (ClickUp can fire twice) for 60 seconds on live runs.
  if (live) {
    const first = await kv.set(`sts:sent:${taskId}`, Date.now(), { nx: true, ex: 60 });
    if (!first) return NextResponse.json({ ok: true, skipped: "duplicate trigger" });
  }

  let task: any;
  try {
    task = await fetchTask(taskId);
  } catch (e) {
    console.error("send-to-seller: task fetch failed", e);
    return NextResponse.json({ ok: false, error: "Could not read task" }, { status: 502 });
  }

  const f = taskFields(task);
  const preview = attachmentUrls(task).join(",");
  const created = task.date_created ? new Date(Number(task.date_created)).toISOString() : "";
  const baseUrl = process.env.PUBLIC_BASE_URL || "https://review-to-client.vercel.app";
  const link = `${baseUrl}/pitch/index.html?taskId=${taskId}`;

  const result: Record<string, unknown> = { ok: true, live, taskId, link };

  // 1) Save the pitch (same record shape as /api/save-pitch)
  try {
    const key = `pitch:${taskId}`;
    const exists = await kv.get(key);
    if (live || !exists) {
      await kv.set(key, {
        taskId,
        client: f.company,
        created,
        framerLink: f.framerLink,
        preview,
        savedAt: Date.now(),
      });
      result.pitch = "saved";
    } else {
      result.pitch = "kept existing (test)";
    }
  } catch (e) {
    console.error("send-to-seller: save pitch failed", e);
    result.pitch = "failed";
  }

  // 2) Write the review link into the task's "Client Review Link" field (live only)
  if (live && f.reviewLinkFieldId) {
    try {
      const res = await fetch(`${CLICKUP}/task/${taskId}/field/${f.reviewLinkFieldId}`, {
        method: "POST",
        headers: { Authorization: process.env.CLICKUP_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ value: link }),
      });
      result.reviewLinkField = res.ok ? "ok" : `failed ${res.status}`;
    } catch (e) {
      console.error("send-to-seller: link field failed", e);
      result.reviewLinkField = "failed";
    }
  } else {
    result.reviewLinkField = live ? "skipped (field not found)" : "skipped (test)";
  }

  // 3) Email the requester
  const to = live ? f.requesterEmail : process.env.EMAIL_TEST_TO || "";
  const label = f.company || task.name || "Din beställning";
  const subject = `${live ? "" : "[TEST] "}${label} – #${taskId} – Din SpiderAds annons är redo`;
  if (!emailConfigured()) {
    result.email = "skipped (email not configured)";
  } else if (!to) {
    result.email = live ? "skipped (task has no Requester Email)" : "skipped (EMAIL_TEST_TO not set)";
  } else {
    result.email = await sendMail({ to, subject, html: emailHtml(f.name, link) });
  }
  result.to = live ? "requester" : "test address";

  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json({ ok: true, live: process.env.SEND_TO_SELLER_LIVE === "1", emailConfigured: emailConfigured() });
}
