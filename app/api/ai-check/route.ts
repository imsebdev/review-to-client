// app/api/ai-check/route.ts
//
// AI copy & content checker for Coop orders (work in progress on branch feat/ai-checker).
//
// GET  /api/ai-check            → setup status: which env vars are present and whether the
//                                  Anthropic key actually works (one tiny test call). Never
//                                  returns secret values.
// POST /api/ai-check?taskId=…   → runs the check (coming next).
//
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MODEL_PING = "claude-haiku-5-5";

async function pingAnthropic(): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, detail: "ANTHROPIC_API_KEY is not set in this environment" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_PING,
        max_tokens: 5,
        messages: [{ role: "user", content: "Svara bara: ok" }],
      }),
      cache: "no-store",
    });
    if (res.ok) return { ok: true, detail: "key works" };
    const body = await res.text();
    return { ok: false, detail: `Anthropic answered ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { ok: false, detail: `request failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

export async function GET() {
  const anthropic = await pingAnthropic();
  return NextResponse.json({
    ok: anthropic.ok,
    anthropic,
    env: {
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      CLICKUP_API_KEY: !!process.env.CLICKUP_API_KEY,
      SLACK_WEBHOOK_COOP_QA: !!process.env.SLACK_WEBHOOK_COOP_QA,
      SLACK_WEBHOOK_TEST: !!process.env.SLACK_WEBHOOK_TEST,
      secret: !!(process.env.AI_CHECK_SECRET || process.env.STEALTH_SECRET),
      AI_CHECK_LIVE: process.env.AI_CHECK_LIVE === "1",
    },
    vercelEnv: process.env.VERCEL_ENV ?? "local",
  });
}

export async function POST() {
  return NextResponse.json({ ok: false, error: "Not built yet — use GET for setup status" }, { status: 501 });
}
