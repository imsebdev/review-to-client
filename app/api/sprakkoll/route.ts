// app/api/sprakkoll/route.ts
//
// Språkkoll: spelling & grammar suggestions for "Message to client" and "Company name".
// New route for review page v2 (build step 4). No other route is changed; separate from the
// AI content checker (/api/ai-check), which checks the designs.
//
// POST /api/sprakkoll?taskId=<id>&secret=<SPRAKKOLL_SECRET|AI_CHECK_SECRET|STEALTH_SECRET>
//      Called by a ClickUp automation when "Message to client" or "Company name" changes
//      (task id also accepted in the body, like the other ClickUp-called routes).
//      Answers 202 at once and runs in the background.
// GET  /api/sprakkoll?taskId=<id>&run=1[&dry=1]
//      PREVIEW DEPLOYMENTS ONLY: runs now and returns the result as JSON.
//      dry=1: nothing is posted (no ClickUp comment, no Slack).
// GET  /api/sprakkoll   → setup status
//
// What it does: reads the two fields, asks Claude for real mistakes only, and if there are any,
// posts ONE ClickUp comment with the suggestions and the corrected text. Never changes a field,
// never blocks sending. No mistakes → no comment (a short line in Slack only).
// Each distinct text is checked once (Redis), so the automation firing for both fields, or
// twice, doesn't give double comments.
//
// Safety switch: SPRAKKOLL_LIVE=1 → comments on any card. Otherwise TEST: comments only on cards
// in SPRAKKOLL_TEST_LISTS (default: the "[TEST] Review v2" list), Slack messages marked [TEST].

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { Redis } from "@upstash/redis";
import { fetchTask } from "../../../lib/clickup-task";
import { postClickUpComment, postSlack } from "../../../lib/checker/report";
import { proofread, commentText, slackLine, type SprakField } from "../../../lib/sprakkoll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const TEST_LISTS = (process.env.SPRAKKOLL_TEST_LISTS || "1200250000015695").split(",").map((s) => s.trim()).filter(Boolean);
const DONE_TTL = 60 * 60 * 24 * 60; // remember checked texts for 60 days

function redis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

/** Same field names as /api/task (what the review page shows). */
function fieldText(task: any, names: string[]): string {
  const f = (task?.custom_fields || []).find((x: any) => names.some((n) => String(x.name || "").toLowerCase().includes(n)) && typeof x.value === "string" && x.value.trim());
  return f ? String(f.value) : "";
}

function extractTaskId(req: NextRequest, body: any): string {
  const q = new URL(req.url).searchParams;
  const c = body?.taskId ?? body?.task_id ?? body?.payload?.id ?? body?.payload?.task_id ?? body?.id ?? q.get("taskId") ?? q.get("task_id");
  return c ? String(c).trim() : "";
}

const validId = (id: string) => /^[A-Za-z0-9_-]{4,40}$/.test(id);

async function run(taskId: string, opts: { live: boolean; dry: boolean; force: boolean }) {
  const task = await fetchTask(taskId);
  const fields: SprakField[] = [
    { key: "message", label: "Message to client", text: fieldText(task, ["message to client", "message to seller", "meddelande"]) },
    { key: "company", label: "Company name", text: fieldText(task, ["company name", "företagsnamn"]) },
  ];
  if (!fields.some((f) => f.text.trim())) return { taskId, skipped: "both fields are empty" };

  // check each distinct text once
  const hash = createHash("sha256").update(JSON.stringify(fields.map((f) => f.text))).digest("hex").slice(0, 24);
  const kv = redis();
  if (kv && !opts.dry && !opts.force) {
    const first = await kv.set(`sprakkoll:done:${taskId}:${hash}`, Date.now(), { nx: true, ex: DONE_TTL }).catch(() => "OK");
    if (!first) return { taskId, skipped: "these texts were already checked" };
  }

  const r = await proofread(fields);
  const listId = String(task?.list?.id || "");
  const mayComment = opts.live || TEST_LISTS.includes(listId);

  let comment = "none (no mistakes)";
  let slack = "skipped (dry run)";
  if (!opts.dry) {
    if (r.fixCount) comment = mayComment ? await postClickUpComment(taskId, commentText(r)) : `skipped (test mode, list ${listId} is not a test list)`;
    slack = await postSlack(slackLine(taskId, String(task?.name || ""), r, { live: opts.live, comment })).catch((e) => `failed: ${e}`);
  } else if (r.fixCount) comment = "skipped (dry run)";

  console.log(`sprakkoll ${taskId}: ${r.fixCount} fixes, comment=${comment}, slack=${slack}, ${r.ms} ms`, r.usage);
  return { taskId, live: opts.live, fixCount: r.fixCount, fields: r.fields, comment, slack, ms: r.ms, usage: r.usage, commentPreview: r.fixCount ? commentText(r) : null };
}

async function runSafe(taskId: string, opts: { live: boolean; dry: boolean; force: boolean }) {
  try {
    return await run(taskId, opts);
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 400);
    console.error(`sprakkoll ${taskId} failed:`, e);
    if (!opts.dry) await postSlack(`${opts.live ? "" : "[TEST] "}⚠️ Språkkoll could not run for <https://app.clickup.com/t/${taskId}|#${taskId}>: ${msg}`).catch(() => null);
    return { taskId, error: msg };
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  const q = new URL(req.url).searchParams;
  const secret = body?.secret ?? req.headers.get("x-sprakkoll-secret") ?? req.headers.get("x-stealth-secret") ?? q.get("secret");
  const ok = [process.env.SPRAKKOLL_SECRET, process.env.AI_CHECK_SECRET, process.env.STEALTH_SECRET].filter(Boolean);
  if (!secret || !ok.includes(String(secret))) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const taskId = extractTaskId(req, body);
  if (!validId(taskId)) return NextResponse.json({ ok: false, error: "Missing or invalid taskId" }, { status: 400 });

  const live = process.env.SPRAKKOLL_LIVE === "1" && q.get("test") !== "1";
  waitUntil(runSafe(taskId, { live, dry: false, force: false }));
  return NextResponse.json({ ok: true, accepted: true, taskId, live }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const taskId = q.get("taskId") || "";

  if (taskId && q.get("run") === "1") {
    if (process.env.VERCEL_ENV !== "preview")
      return NextResponse.json({ ok: false, error: "Test runs via GET are only allowed on preview deployments" }, { status: 403 });
    if (!validId(taskId)) return NextResponse.json({ ok: false, error: "Invalid taskId" }, { status: 400 });
    // GET test runs are always test mode, and always check again (force)
    return NextResponse.json(await runSafe(taskId, { live: false, dry: q.get("dry") === "1", force: true }));
  }

  return NextResponse.json({
    ok: !!process.env.ANTHROPIC_API_KEY && !!process.env.CLICKUP_API_KEY,
    live: process.env.SPRAKKOLL_LIVE === "1",
    testLists: TEST_LISTS,
    env: {
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      CLICKUP_API_KEY: !!process.env.CLICKUP_API_KEY,
      SLACK_WEBHOOK_COOP_QA: !!process.env.SLACK_WEBHOOK_COOP_QA,
      UPSTASH: !!process.env.UPSTASH_REDIS_REST_URL,
      secret: !!(process.env.SPRAKKOLL_SECRET || process.env.AI_CHECK_SECRET || process.env.STEALTH_SECRET),
    },
  });
}
