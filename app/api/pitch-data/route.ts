// app/api/pitch-data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { rewritePreview } from "../../../lib/attachments";

export const dynamic = "force-dynamic";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");

  if (!taskId) {
    return NextResponse.json({ ok: false, error: "Missing taskId" }, { status: 400 });
  }

  const data = await kv.get(`pitch:${taskId}`);

  if (!data) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  // Stored ClickUp URLs carry short-lived single-use tokens; point the page at our
  // /api/file route instead, which fetches a fresh signed URL on every request.
  const d: any = data;
  if (d && typeof d.preview === "string") {
    d.preview = rewritePreview(new URL(req.url).origin, taskId, d.preview);
  }

  return NextResponse.json({ ok: true, data: d }, { headers: { "Cache-Control": "no-store" } });
}
