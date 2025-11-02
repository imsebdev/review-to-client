export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  if (!body?.taskId) {
    return new Response(JSON.stringify({ ok: false, error: "taskId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("REVIEW_PAYLOAD 🔎", body);

  return new Response(
    JSON.stringify({
      ok: true,
      received: {
        taskId: body.taskId,
        title: body.title,
        status: body.status,
        client: body.client ?? null,
        due: body.due ?? null,
      },
      ts: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export async function GET() {
  return new Response(JSON.stringify({ ok: true, via: "GET /api/review" }), {
    headers: { "Content-Type": "application/json" },
  });
}
