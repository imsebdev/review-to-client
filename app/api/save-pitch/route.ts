// app/api/save-pitch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { taskId, client, created, framerLink, preview, secret } = body;

  if (!secret || secret !== process.env.STEALTH_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!taskId) {
    return NextResponse.json({ ok: false, error: "Missing taskId" }, { status: 400 });
  }

  await kv.set(`pitch:${taskId}`, {
    taskId,
    client:     client     || "",
    created:    created    || "",
    framerLink: framerLink || "",
    preview:    preview    || "",
    savedAt:    Date.now(),
  });

  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const url = `${baseUrl}/pitch/index.html?taskId=${taskId}`;

  return NextResponse.json({ ok: true, url });
}
