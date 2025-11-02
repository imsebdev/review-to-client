// app/api/review/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, via: "GET /api/review" });
}

export async function POST(req: NextRequest) {
  try {
    // tolerate empty/invalid JSON
    const body = (await req.json().catch(() => ({}))) as {
      taskId?: string;
      title?: string;
      client?: string;
      due?: string;
      preview?: string;
    };

    const { taskId, title, client, due, preview } = body ?? {};
    if (!taskId) {
      return NextResponse.json(
        { ok: false, error: "missing taskId" },
        { status: 400 }
      );
    }

    // Webhook to Zapier (set in Vercel Settings → Environment Variables)
    const hook = process.env.ZAPIER_REVIEW_HOOK_URL;
    if (!hook) {
      return NextResponse.json(
        { ok: false, error: "missing ZAPIER_REVIEW_HOOK_URL" },
        { status: 500 }
      );
    }

    // Notify Zapier (non-blocking)
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        title,
        client,
        due,
        preview,
        ts: new Date().toISOString(),
      }),
    }).catch(() => { /* ignore webhook errors */ });

    // Build the public review URL (page you already saw working)
    const base =
      process.env.NEXT_PUBLIC_BASE_URL ??
      "https://review-to-client.vercel.app";
    const url = new URL(`${base}/t/${encodeURIComponent(taskId)}`);
    if (title) url.searchParams.set("title", title);
    if (client) url.searchParams.set("client", client);
    if (due) url.searchParams.set("due", due);
    if (preview) url.searchParams.set("preview", preview);

    return NextResponse.json({ ok: true, reviewUrl: url.toString() });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "unexpected" },
      { status: 500 }
    );
  }
}
