// app/api/reply/route.ts
export async function POST(req: Request) {
  const data = await req.formData(); // form submits as FormData
  const payload = Object.fromEntries(data.entries());

  // your Zapier Catch Hook (from you)
  const ZAPIER_HOOK = "https://hooks.zapier.com/hooks/catch/24121388/uivwvnj/";

  try {
    const res = await fetch(ZAPIER_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return new Response(
      JSON.stringify({ ok: res.ok, forwardedToZapier: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function GET() {
  return new Response(JSON.stringify({ ok: true, via: "GET /api/reply" }), {
    headers: { "Content-Type": "application/json" },
  });
}
