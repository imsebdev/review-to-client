// app/api/ai-check/route.ts
//
// AI copy & content checker for Coop orders.
//
// POST /api/ai-check?taskId=<id>&secret=<AI_CHECK_SECRET|STEALTH_SECRET>
//      Called by a ClickUp automation when a card enters "internal review" (or on demand).
//      Answers 202 at once and runs the check in the background (ClickUp wants a fast reply).
//      Posts the result to Slack #content-checker (SLACK_WEBHOOK_COOP_QA).
//      LIVE (AI_CHECK_LIVE=1): also tags the card's designers in Slack and comments on the card.
//      Otherwise TEST: Slack only, marked [TEST], no tags, nothing written to ClickUp.
//
// GET  /api/ai-check                    → setup status (env present, Anthropic key works)
// GET  /api/ai-check?taskId=<id>&run=1  → PREVIEW DEPLOYMENTS ONLY: runs a test check right
//      away and returns the full report as JSON (preview URLs are behind Vercel login).
//
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { Redis } from "@upstash/redis";
import { runCheck } from "../../../lib/checker/run";
import { clickupText, postClickUpComment, postSlack, slackText } from "../../../lib/checker/report";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL_PING = "claude-haiku-5-5";

// ClickUp API webhook (taskStatusUpdated) — unlike the automation's "Call webhook" it says WHO moved
// the card, so only that person gets tagged in Slack.
const TEAM_ID = process.env.CLICKUP_TEAM_ID || "90151368698";
const LIST_ID = process.env.AI_CHECK_LIST_ID || "901513388834";
const TRIGGER_STATUS = (process.env.AI_CHECK_STATUS || "internal review").toLowerCase();
const PROD_ENDPOINT = "https://review-to-client.vercel.app/api/ai-check";
const SECRET_KEY = "aicheck:clickup-webhook-secret";

function redis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

async function clickup(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    ...init,
    headers: { Authorization: process.env.CLICKUP_API_KEY || "", "Content-Type": "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

function extractTaskId(req: NextRequest, body: any): string {
  const q = new URL(req.url).searchParams;
  const c = body?.taskId ?? body?.task_id ?? body?.payload?.id ?? body?.payload?.task_id ?? body?.id ?? q.get("taskId") ?? q.get("task_id");
  return c ? String(c).trim() : "";
}

async function checkAndReport(taskId: string, live: boolean, movedBy?: string) {
  try {
    const report = await runCheck(taskId);
    if (movedBy) report.movedBy = movedBy.toLowerCase();
    if (report.status === "skipped") {
      console.log(`ai-check ${taskId}: skipped (not a Coop order: "${report.title}")`);
      return { report, slack: "skipped", comment: "skipped" };
    }
    const slack = await postSlack(slackText(report, { live }));
    const comment = live ? await postClickUpComment(taskId, clickupText(report)) : "skipped (test mode)";
    console.log(`ai-check ${taskId}: ${report.status} slack=${slack} comment=${comment} ${report.ms}ms`, report.tokens);
    return { report, slack, comment };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.error(`ai-check ${taskId} failed:`, e);
    await postSlack(
      `${live ? "" : "[TEST] "}🚨 *AI check could not run* for <https://app.clickup.com/t/${taskId}|#${taskId}>\n${msg}\nNothing was approved — check this card by hand.`,
    ).catch(() => null);
    return { error: msg };
  }
}

async function firstRun(taskId: string): Promise<boolean> {
  // ClickUp can fire twice for one status change — ignore repeats for 2 minutes
  const kv = redis();
  if (!kv) return true;
  const first = await kv.set(`aicheck:run:${taskId}`, Date.now(), { nx: true, ex: 120 }).catch(() => "OK");
  return !!first;
}

/** ClickUp API webhook event: verify the signature, run only when the card entered the trigger status. */
async function handleClickUpEvent(req: NextRequest, raw: string, body: any) {
  const secret = await redis()?.get<string>(SECRET_KEY).catch(() => null);
  const sig = req.headers.get("x-signature") || "";
  const want = secret ? createHmac("sha256", secret).update(raw).digest("hex") : "";
  if (!secret || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want)))
    return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 401 });

  if (body.event !== "taskStatusUpdated") return NextResponse.json({ ok: true, ignored: body.event });
  const item = (body.history_items || []).find((h: any) => h.field === "status") || body.history_items?.[0];
  const status = String(item?.after?.status || "").toLowerCase();
  if (status !== TRIGGER_STATUS) return NextResponse.json({ ok: true, ignored: `status ${status}` });

  const taskId = String(body.task_id || "");
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) return NextResponse.json({ ok: false, error: "Missing task_id" }, { status: 400 });
  if (!(await firstRun(taskId))) return NextResponse.json({ ok: true, skipped: "duplicate trigger" });

  const movedBy = String(item?.user?.email || "");
  const live = process.env.AI_CHECK_LIVE === "1";
  waitUntil(checkAndReport(taskId, live, movedBy || undefined));
  return NextResponse.json({ ok: true, accepted: true, taskId, live, movedBy }, { status: 202 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}
  if (body?.event && body?.webhook_id) return handleClickUpEvent(req, raw, body);

  const q = new URL(req.url).searchParams;
  const secret = body?.secret ?? req.headers.get("x-ai-check-secret") ?? req.headers.get("x-stealth-secret") ?? q.get("secret");
  const ok = [process.env.AI_CHECK_SECRET, process.env.STEALTH_SECRET].filter(Boolean);
  if (!secret || !ok.includes(String(secret))) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const taskId = extractTaskId(req, body);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) return NextResponse.json({ ok: false, error: "Missing or invalid taskId" }, { status: 400 });
  if (!(await firstRun(taskId))) return NextResponse.json({ ok: true, skipped: "duplicate trigger" });

  const live = process.env.AI_CHECK_LIVE === "1" && q.get("test") !== "1";
  waitUntil(checkAndReport(taskId, live));
  return NextResponse.json({ ok: true, accepted: true, taskId, live }, { status: 202 });
}

/** Preview only: create (or find) the ClickUp API webhook and store its signing secret. */
async function setupWebhook() {
  const kv = redis();
  if (!kv) throw new Error("Upstash isn't configured here");
  const list = await clickup(`/team/${TEAM_ID}/webhook`);
  let hook = (list.webhooks || []).find((w: any) => w.endpoint === PROD_ENDPOINT);
  let created = false;
  if (!hook) {
    const r = await clickup(`/team/${TEAM_ID}/webhook`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PROD_ENDPOINT, events: ["taskStatusUpdated"], list_id: Number(LIST_ID) }),
    });
    hook = r.webhook ?? r;
    created = true;
  }
  if (!hook?.secret) throw new Error("ClickUp returned no webhook secret");
  await kv.set(SECRET_KEY, hook.secret);
  return { created, id: hook.id, endpoint: hook.endpoint, events: hook.events, list_id: hook.list_id, health: hook.health };
}

async function pingAnthropic(): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, detail: "ANTHROPIC_API_KEY is not set in this environment" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_PING, max_tokens: 5, messages: [{ role: "user", content: "Svara bara: ok" }] }),
      cache: "no-store",
    });
    if (res.ok) return { ok: true, detail: "key works" };
    return { ok: false, detail: `Anthropic answered ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (e: any) {
    return { ok: false, detail: `request failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const taskId = q.get("taskId");

  if (q.get("setup") === "webhook") {
    if (process.env.VERCEL_ENV !== "preview")
      return NextResponse.json({ ok: false, error: "Webhook setup is only allowed on preview deployments" }, { status: 403 });
    try {
      return NextResponse.json({ ok: true, webhook: await setupWebhook() });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
    }
  }

  if (taskId && q.get("run") === "1") {
    if (process.env.VERCEL_ENV !== "preview")
      return NextResponse.json({ ok: false, error: "Test runs via GET are only allowed on preview deployments" }, { status: 403 });
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(taskId)) return NextResponse.json({ ok: false, error: "Invalid taskId" }, { status: 400 });
    const result = await checkAndReport(taskId, false);
    return NextResponse.json(result);
  }

  const anthropic = await pingAnthropic();
  return NextResponse.json({
    ok: anthropic.ok,
    anthropic,
    env: {
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      CLICKUP_API_KEY: !!process.env.CLICKUP_API_KEY,
      SLACK_WEBHOOK_COOP_QA: !!process.env.SLACK_WEBHOOK_COOP_QA,
      UPSTASH: !!process.env.UPSTASH_REDIS_REST_URL,
      secret: !!(process.env.AI_CHECK_SECRET || process.env.STEALTH_SECRET),
      AI_CHECK_LIVE: process.env.AI_CHECK_LIVE === "1",
      clickupWebhook: !!(await redis()?.get(SECRET_KEY).catch(() => null)),
      model: process.env.AI_CHECK_MODEL || "claude-sonnet-5-5 (default)",
    },
    vercelEnv: process.env.VERCEL_ENV ?? "local",
  });
}
