// app/api/stealth-update/route.ts
//
// Silently swaps the preview files on an already-delivered pitch/review link.
//
// Two ways to call it:
//   1) Legacy (what the Zapier "Stealth Update" zap sends today):
//        { taskId, preview, comment, secret }
//   2) Direct from ClickUp (no Zapier): send only the task id. The route fetches
//      the task's attachments from ClickUp itself and builds `preview`
//      (comma-joined attachment URLs — same thing Zap steps 2+3 produce).
//        POST /api/stealth-update?taskId=<id>&secret=<STEALTH_SECRET>
//      or send the secret in an `x-stealth-secret` header.
//
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const CLICKUP = "https://api.clickup.com/api/v2";

// ClickUp automations / webhooks / Zapier all shape the payload a little differently,
// so accept the task id from the common places.
function extractTaskId(req: NextRequest, body: any): string {
  const q = new URL(req.url).searchParams;
  const candidate =
    body?.taskId ??
    body?.task_id ??
    body?.payload?.id ??
    body?.payload?.task_id ??
    body?.id ??
    q.get("taskId") ??
    q.get("task_id");
  return candidate ? String(candidate).trim() : "";
}

async function fetchAttachmentUrls(taskId: string): Promise<string[]> {
  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) throw new Error("CLICKUP_API_KEY not configured");

  const res = await fetch(`${CLICKUP}/task/${taskId}?include_subtasks=false`, {
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status} ${res.statusText}`);

  const task = await res.json();
  const attachments: Array<{ url?: string }> = task.attachments || [];
  return attachments.map((a) => a.url).filter((u): u is string => !!u);
}

async function postClickUpComment(taskId: string, text: string) {
  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) return;
  const res = await fetch(`${CLICKUP}/task/${taskId}/comment`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ comment_text: text, notify_all: false }),
  });
  if (!res.ok) console.error("Stealth comment failed:", res.status, await res.text());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const q = new URL(req.url).searchParams;

  // Auth — body (legacy Zap), header, or query string (ClickUp direct call)
  const secret = body?.secret ?? req.headers.get("x-stealth-secret") ?? q.get("secret");
  if (!secret || secret !== process.env.STEALTH_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const taskId = extractTaskId(req, body);
  if (!taskId) {
    console.error("Stealth update: no task id in payload", JSON.stringify(body).slice(0, 500));
    return NextResponse.json({ ok: false, error: "Missing taskId" }, { status: 400 });
  }

  // preview: use what was sent (legacy), otherwise build it from ClickUp attachments
  let preview: string = typeof body?.preview === "string" ? body.preview : "";
  if (!preview) {
    try {
      preview = (await fetchAttachmentUrls(taskId)).join(",");
    } catch (e) {
      console.error("Stealth update: attachment fetch failed", e);
      return NextResponse.json({ ok: false, error: "Could not read task attachments" }, { status: 502 });
    }
  }
  if (!preview) {
    return NextResponse.json({ ok: false, error: "Task has no attachments" }, { status: 400 });
  }

  const comment: string = body?.comment || "";

  // Try pitch key first, fall back to review key
  let existing = await kv.get<Record<string, unknown>>(`pitch:${taskId}`);
  const isPitch = !!existing;

  if (!existing) {
    existing = await kv.get<Record<string, unknown>>(`task:${taskId}`);
  }

  if (!existing) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }

  const kvKey = isPitch ? `pitch:${taskId}` : `task:${taskId}`;

  // Silently swap the preview files, keep everything else
  await kv.set(kvKey, {
    ...existing,
    preview,
    lastStealthUpdate: Date.now(),
    stealthComment: comment,
  });

  // Optional internal ClickUp comment, posted directly (no Zapier task).
  // Off by default; set STEALTH_CLICKUP_COMMENT=1 in Vercel to enable.
  if (process.env.STEALTH_CLICKUP_COMMENT === "1") {
    await postClickUpComment(taskId, `🕵️ Stealth update: ${comment || "Files updated silently."}`);
  }

  return NextResponse.json({ ok: true, message: "Files updated silently." });
}
