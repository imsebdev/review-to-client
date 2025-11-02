export async function POST(req: Request) {
  const data = await req.formData(); // reads form submission
  const payload = Object.fromEntries(data.entries());

  const ZAPIER_HOOK = "https://hooks.zapier.com/hooks/catch/24121388/uivwvnj/";

  const res = await fetch(ZAPIER_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return new Response(JSON.stringify({ ok: res.ok, forwardedToZapier: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  return new Response(JSON.stringify({ ok: true, via: "GET /api/reply" }), {
    headers: { "Content-Type": "application/json" },
  });
}
