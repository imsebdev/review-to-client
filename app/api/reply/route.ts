import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const data = await req.formData();
  const decision = String(data.get("decision") || "");
  const notes = String(data.get("notes") || "");
  const taskId = String(data.get("taskId") || "");
  const title = String(data.get("title") || "");
  const client = String(data.get("client") || "");
  const due = String(data.get("due") || "");
  const preview = String(data.get("preview") || "");

  if (!taskId || !decision) {
    return NextResponse.json({ ok: false, error: "Missing taskId or decision" }, { status: 400 });
  }

  const hook = process.env.ZAPIER_WEBHOOK_URL; // set in Vercel
  if (!hook) {
    return NextResponse.json({ ok: false, error: "Server missing ZAPIER_WEBHOOK_URL" }, { status: 500 });
  }

  // Forward the payload to Zapier
  const payload = { decision, notes, taskId, title, client, due, preview, source: "client-review" };
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const ok = res.ok;
  return NextResponse.json({ ok });
}
