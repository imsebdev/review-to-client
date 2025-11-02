import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, via: "GET", ts: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  console.log("ZAPIER TEST 🔥", body);
  return NextResponse.json({ ok: true, via: "POST", echo: body, ts: new Date().toISOString() });
}
