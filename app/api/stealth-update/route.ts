// app/api/stealth-update/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { taskId, preview, comment, secret } = body;

  // Auth check — Zapier will send this secret
  if (!secret || secret !== process.env.STEALTH_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!taskId || !preview) {
    return NextResponse.json({ ok: false, error: "Missing taskId or preview" }, { status: 400 });
  }

  // Get existing task data
  const existing = await kv.get<Record<string, unknown>>(`task:${taskId}`);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }

  // Silently swap the preview files, keep everything else
  await kv.set(`task:${taskId}`, {
    ...existing,
    preview,
    lastStealthUpdate: Date.now(),
    stealthComment: comment || "",
  });

  // Post an internal comment to ClickUp via Zapier webhook
  const webhookUrl = process.env.ZAPIER_STEALTH_WEBHOOK_URL;
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        comment: `🕵️ Stealth update: ${comment || "Files updated silently."}`,
      }),
    });
  }

  return NextResponse.json({ ok: true, message: "Files updated silently." });
}
