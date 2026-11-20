// lib/checker/anthropic.ts
//
// Minimal Claude Messages API client (plain fetch, no SDK) that forces a structured answer
// through a single tool, so every call returns JSON matching the given schema.

const API = "https://api.anthropic.com/v1/messages";

export const MODEL = process.env.AI_CHECK_MODEL || "claude-sonnet-5-5";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export type Usage = { input_tokens: number; output_tokens: number };

export async function askJson<T>(opts: {
  system: string;
  content: ContentBlock[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  model?: string;
  temperature?: number; // 0 = same answer every run (proofreading should be stable)
}): Promise<{ data: T; usage: Usage }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const body = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    system: `${opts.system}\n\nSvara ENDAST genom att anropa verktyget "${opts.toolName}" en gång med hela svaret.`,
    tools: [{ name: opts.toolName, description: opts.toolDescription, input_schema: opts.schema }],
    // Newer models don't accept a forced tool_choice; "auto" + the instruction above works the same.
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: opts.content }],
  };

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.ok) {
      const json: any = await res.json();
      const block = (json.content || []).find((b: any) => b.type === "tool_use");
      if (block) return { data: block.input as T, usage: json.usage };
      // fallback: JSON written as text
      const text = (json.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return { data: JSON.parse(m[0]) as T, usage: json.usage };
        } catch {}
      }
      throw new Error(`Claude returned no structured answer (stop_reason ${json.stop_reason})`);
    }
    lastErr = `${res.status} ${(await res.text()).slice(0, 300)}`;
    // retry on overload / rate limit only
    if (![429, 500, 502, 503, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`Claude API error: ${lastErr}`);
}

export function b64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
