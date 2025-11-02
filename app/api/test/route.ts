export async function GET() {
  return new Response(
    JSON.stringify({ ok: true, via: "GET", ts: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  console.log("ZAPIER TEST 🔥", body);
  return new Response(
    JSON.stringify({ ok: true, via: "POST", echo: body, ts: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } }
  );
}

