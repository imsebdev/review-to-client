import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

function sign(taskId: string, ttlSeconds = 60 * 60 * 24 * 30) { // 30 days
  const key = process.env.HMAC_SECRET || "dev-secret";
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const base = `${taskId}.${exp}`;
  const sig = crypto.createHmac("sha256", key).update(base).digest("hex");
  return { sig, exp };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(()=> ({}));
  const taskId = String(body.taskId || "");
  const title = encodeURIComponent(String(body.title || ""));
  const client = encodeURIComponent(String(body.client || ""));
  const due = encodeURIComponent(String(body.due || ""));
  const preview = encodeURIComponent(String(body.preview || ""));

  if (!taskId) {
    return NextResponse.json({ ok: false, error: "Missing taskId" }, { status: 400 });
  }

  const { sig, exp } = sign(taskId);
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const url = `${baseUrl}/t/${taskId}?sig=${sig}&exp=${exp}&title=${title}&client=${client}&due=${due}&preview=${preview}`;

  return NextResponse.json({ ok: true, url });
}
