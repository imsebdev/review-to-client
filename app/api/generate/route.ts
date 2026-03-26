import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function sign(taskId: string, ttlSeconds = 60 * 60 * 24 * 30) {
  const key = process.env.HMAC_SECRET || "dev-secret";
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const base = `${taskId}.${exp}`;
  const sig = crypto.createHmac("sha256", key).update(base).digest("hex");
  return { sig, exp };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.taskId || "");
  const title   = String(body.title   || "");
  const client  = String(body.client  || "");
  const due     = String(body.due     || "");
  const preview = String(body.preview || "");

  if (!taskId) {
    return NextResponse.json({ ok: false, error: "Missing taskId" }, { status: 400 });
  }

  // Save task data to KV — this is what the review page will read
  await kv.set(`task:${taskId}`, {
    title,
    client,
    due,
    preview,
    createdAt: Date.now(),
  });

  // Generate signed URL — now clean, no data in params
  const { sig, exp } = sign(taskId);
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const url = `${baseUrl}/t/${taskId}?sig=${sig}&exp=${exp}`;

  return NextResponse.json({ ok: true, url });
}
