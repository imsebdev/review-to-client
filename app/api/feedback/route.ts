// app/api/feedback/route.ts
//
// Receives client feedback (approve / revise / decline) from the pitch page.
//
// FEEDBACK_MODE (Vercel env var) decides what happens:
//   "zapier" (default) -> forward the payload, unchanged, to the existing Zapier
//                         catch hook. Behaves exactly like the old page did.
//   "direct"           -> do the same work the "PITCH - Comment from Seller/Client"
//                         zap does, without Zapier:
//                         1) post the ClickUp comment (assigned to Octavian)
//                         2) set the ClickUp task status
//                         3) post to Slack (incoming webhooks)
//
// Optional env vars (direct mode):
//   CLICKUP_API_KEY            (already set)
//   COMMENT_ASSIGNEE_ID        ClickUp user id to assign the comment to (default: look up "Octavian")
//   STATUS_APPROVE / STATUS_REVISE / STATUS_DECLINE   ClickUp status names (default "Backlog" = live zap v23)
//   SLACK_WEBHOOK_ORDERS       Slack incoming webhook for the approve channel (#spiderads-orders)
//   SLACK_WEBHOOK_REVISIONS    Slack incoming webhook for the revise/decline channel
//   ZAPIER_FEEDBACK_HOOK_URL   override the Zapier hook used in "zapier" mode
//
import { NextRequest, NextResponse } from "next/server";

const CLICKUP = "https://api.clickup.com/api/v2";
const DEFAULT_ZAPIER_HOOK = "https://hooks.zapier.com/hooks/catch/24121388/uivwvnj/";

type Decision = "approve" | "revise" | "decline";

const DECISIONS: Decision[] = ["approve", "revise", "decline"];

const DECISION_ICON: Record<Decision, string> = { approve: "✅", revise: "✅", decline: "❌" };
// The live zap uses the same ✅ icon for approve and revise and ❌ for decline.

function clip(v: unknown, max = 5000): string {
  return String(v ?? "").slice(0, max);
}

function statusFor(decision: Decision): string {
  const env = {
    approve: process.env.STATUS_APPROVE,
    revise: process.env.STATUS_REVISE,
    decline: process.env.STATUS_DECLINE,
  }[decision];
  return env || "Backlog";
}

async function clickup(path: string, init: RequestInit = {}) {
  const key = process.env.CLICKUP_API_KEY;
  if (!key) throw new Error("CLICKUP_API_KEY not configured");
  return fetch(`${CLICKUP}${path}`, {
    ...init,
    headers: { Authorization: key, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  });
}

let cachedAssignee: { id: number | null; at: number } | null = null;

async function resolveAssigneeId(): Promise<number | null> {
  const fromEnv = process.env.COMMENT_ASSIGNEE_ID;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  if (cachedAssignee && Date.now() - cachedAssignee.at < 6 * 60 * 60 * 1000) return cachedAssignee.id;
  try {
    const teams = await (await clickup("/team")).json();
    for (const team of teams?.teams || []) {
      for (const m of team?.members || []) {
        const u = m?.user || {};
        const hay = `${u.username || ""} ${u.email || ""}`.toLowerCase();
        if (hay.includes("octavian")) {
          cachedAssignee = { id: Number(u.id), at: Date.now() };
          return cachedAssignee.id;
        }
      }
    }
  } catch (e) {
    console.error("feedback: assignee lookup failed", e);
  }
  cachedAssignee = { id: null, at: Date.now() };
  return null;
}

async function postSlack(url: string | undefined, text: string): Promise<string> {
  if (!url) return "skipped (no webhook configured)";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok ? "ok" : `failed ${res.status}`;
  } catch (e) {
    console.error("feedback: slack failed", e);
    return "failed";
  }
}

async function readPayload(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({}));
    return Object.fromEntries(Object.entries(j || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
  }
  const fd = await req.formData().catch(() => null);
  const out: Record<string, string> = {};
  if (fd) fd.forEach((v, k) => { out[k] = String(v); });
  return out;
}

export async function POST(req: NextRequest) {
  const payload = await readPayload(req);
  const mode = (process.env.FEEDBACK_MODE || "zapier").toLowerCase();

  // ---- Mode: zapier (default) — pass through exactly as before -------------
  if (mode !== "direct") {
    try {
      const res = await fetch(process.env.ZAPIER_FEEDBACK_HOOK_URL || DEFAULT_ZAPIER_HOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return NextResponse.json({ ok: res.ok, mode: "zapier" }, { status: res.ok ? 200 : 502 });
    } catch (e) {
      console.error("feedback: zapier forward failed", e);
      return NextResponse.json({ ok: false, mode: "zapier" }, { status: 502 });
    }
  }

  // ---- Mode: direct ---------------------------------------------------------
  const taskId = clip(payload.taskId, 40).trim();
  const decision = clip(payload.decision, 20).trim().toLowerCase() as Decision;
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) {
    return NextResponse.json({ ok: false, error: "Invalid taskId" }, { status: 400 });
  }
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ ok: false, error: "Invalid decision" }, { status: 400 });
  }

  const client = clip(payload.client, 300);
  const comments = clip(payload.comments);
  const selected = clip(payload.selectedDesigns, 2000);
  const designsLabel = decision === "approve" ? "Approved Design(s)" : "Picked Design(s)";

  const body =
    `📋 Client Review Submitted\n\n` +
    `🧑‍💼 From: ${client}\n` +
    `${DECISION_ICON[decision]} Decision: ${decision}\n` +
    `🖼️ ${designsLabel}: ${selected}\n` +
    `📝 Comment: ${comments}`;

  const result: Record<string, unknown> = { ok: true, mode: "direct", comment: "pending", status: "pending", slack: "pending" };

  // 1) ClickUp comment (assigned to Octavian, like the zap)
  try {
    const assignee = await resolveAssigneeId();
    const res = await clickup(`/task/${taskId}/comment`, {
      method: "POST",
      body: JSON.stringify({
        comment_text: body,
        notify_all: false,
        ...(assignee ? { assignee } : {}),
      }),
    });
    result.comment = res.ok ? "ok" : `failed ${res.status}`;
    if (!res.ok) console.error("feedback: comment failed", res.status, await res.text());
  } catch (e) {
    console.error("feedback: comment error", e);
    result.comment = "failed";
  }

  // 2) ClickUp status
  try {
    const res = await clickup(`/task/${taskId}`, { method: "PUT", body: JSON.stringify({ status: statusFor(decision) }) });
    result.status = res.ok ? "ok" : `failed ${res.status}`;
    if (!res.ok) console.error("feedback: status failed", res.status, await res.text());
  } catch (e) {
    console.error("feedback: status error", e);
    result.status = "failed";
  }

  // 3) Slack (approve -> orders channel; revise/decline -> revisions channel)
  const slackUrl = decision === "approve" ? process.env.SLACK_WEBHOOK_ORDERS : process.env.SLACK_WEBHOOK_REVISIONS;
  result.slack = await postSlack(slackUrl, `${body}\n<https://app.clickup.com/t/${taskId}|Open task in ClickUp>`);

  // Only report failure to the page if nothing worked; the page falls back to Zapier then.
  const anyOk = result.comment === "ok" || result.status === "ok";
  return NextResponse.json({ ...result, ok: anyOk }, { status: anyOk ? 200 : 502 });
}

export async function GET() {
  return NextResponse.json({ ok: true, mode: (process.env.FEEDBACK_MODE || "zapier").toLowerCase() });
}
